/**
 * Conversion benchmark harness (cross-producer).
 *
 * A SPEC defines one section once:
 *   benchmarks/specs/<layout>/prompt.md      — the brief given to every producer
 *   benchmarks/specs/<layout>/expected.json  — { intent, tree }: the ideal block tree
 *
 * Each PRODUCER answers the same prompts with its own HTML:
 *   benchmarks/producers/<producer>/<layout>.html
 *   benchmarks/base/<producer>.css  — optional; inlined into that producer's
 *       layouts at run time (so a producer can ship semantic markup + a shared
 *       design system). Producers without a base ship fully self-contained HTML.
 *
 * The scorer runs convert() on every (producer × layout) input and measures the
 * produced block tree against the SHARED spec on four axes — structure, content,
 * validity, fallbacks — printing a per-producer scorecard to the console.
 *
 * Generated pages (gitignored) under report/:
 *   review.html      — per layout: the ideal end state + each producer's render.
 *   scoreboard.html  — scores over time from benchmarks/results.jsonl.
 *
 * With `--record` it appends one provenance-tagged record to results.jsonl.
 *
 * Run: `npm run bench` (or `npm run bench:record`).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { parseMarkup } from '../src/headless/wp.js';
import type { WpBlock, ConvertOptions, BlockRunnerReport } from '../src/types.js';

// The engine under test, loaded dynamically so it can be swapped for backtesting:
// `--engine <path>` or BLOCK_RUNNER_ENGINE points at another version's built entry
// (e.g. an old commit's dist/index.js in a git worktree). Default = this repo's source.
// parseMarkup (above) stays current — it's a stable scoring utility, not the thing
// under test. The suite is the constant; the engine is the variable.
let convert: (input: string, options?: ConvertOptions) => Promise<BlockRunnerReport>;

function engineArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function enginePath(): string | undefined {
  return engineArg('--engine') ?? process.env.BLOCK_RUNNER_ENGINE ?? undefined;
}
function engineLabel(): string {
  const p = enginePath();
  if (!p) return 'local';
  return engineArg('--engine-label') ?? process.env.BLOCK_RUNNER_ENGINE_LABEL ?? path.basename(path.dirname(path.resolve(p)));
}
async function loadEngine(): Promise<void> {
  const p = enginePath();
  const mod = p ? await import(pathToFileURL(path.resolve(p)).href) : await import('../src/index.js');
  convert = mod.convert;
}

// Model + reasoning effort behind the conversion. The current engine is
// deterministic (rule-based), so these default to `deterministic` / `none`; once an
// LLM translator is wired (Engine B/C), pass --model / --effort (or BLOCK_RUNNER_MODEL
// / BLOCK_RUNNER_EFFORT) so each recorded run is attributable to the model that produced it.
function modelLabel(): string {
  return engineArg('--model') ?? process.env.BLOCK_RUNNER_MODEL ?? 'deterministic';
}
function effortLabel(): string {
  return engineArg('--effort') ?? process.env.BLOCK_RUNNER_EFFORT ?? 'none';
}

interface ExpectedNode {
  block: string;
  contains?: string;
  children?: ExpectedNode[];
}

interface DisplayNode {
  name: string;
  note?: string;
  children: DisplayNode[];
}

interface Spec {
  layout: string;
  intent: string;
  tree: ExpectedNode;
  display: DisplayNode;
}

interface Tally {
  structureTotal: number;
  structureMatched: number;
  contentTotal: number;
  contentMatched: number;
  misses: string[];
}

interface Result {
  producer: string;
  layout: string;
  label: string;
  inputHtml: string;
  structurePct: number;
  contentPct: number;
  valid: boolean;
  fallbacks: number;
  score: number;
  misses: string[];
}

interface RunRecord {
  runAt: string;
  commit: string;
  branch: string;
  author: string;
  version: string;
  engine: string;
  model: string;
  effort: string;
  suiteHash: string;
  corpusAvg: number;
  producers: Record<string, number>;
  fixtures: Record<string, number>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVAL_DIR = path.join(ROOT, 'benchmarks');
const SPEC_DIR = path.join(EVAL_DIR, 'specs');
const PRODUCERS_DIR = path.join(EVAL_DIR, 'producers');
const REPORT_PATH = path.join(ROOT, 'report', 'review.html');
const SCOREBOARD_PATH = path.join(ROOT, 'report', 'scoreboard.html');
const RESULTS_PATH = path.join(EVAL_DIR, 'results.jsonl');

async function main(): Promise<void> {
  await loadEngine();
  if (engineLabel() !== 'local') console.log(`engine under test: ${engineLabel()} (${enginePath()})`);
  const specs = loadSpecs();
  if (specs.size === 0) {
    console.log('No specs found under benchmarks/specs/.');
    return;
  }
  const producers = existsSync(PRODUCERS_DIR)
    ? readdirSync(PRODUCERS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];

  const results: Result[] = [];
  for (const producer of producers) {
    for (const [layout, spec] of specs) {
      if (existsSync(producerFile(producer, layout))) {
        results.push(await scoreFixture(producer, layout, spec));
      }
    }
  }
  results.sort((a, b) => a.label.localeCompare(b.label));

  if (results.length === 0) {
    console.log('No producer inputs found under benchmarks/producers/.');
    return;
  }

  printConsole(results);

  const record = buildRecord(results, specs);
  if (process.argv.includes('--record')) {
    appendFileSync(RESULTS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    console.log(`recorded run → ${RESULTS_PATH}`);
  }

  const history = readHistory();
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true }); // report/ is gitignored — absent on a clean checkout
  writeFileSync(REPORT_PATH, renderHtml(specs, results), 'utf8');
  writeFileSync(SCOREBOARD_PATH, renderScoreboard(history, record), 'utf8');
  console.log(`\nreview page:  file://${REPORT_PATH}`);
  console.log(`scoreboard:   file://${SCOREBOARD_PATH}\n`);
}

function loadSpecs(): Map<string, Spec> {
  const specs = new Map<string, Spec>();
  if (!existsSync(SPEC_DIR)) return specs;
  for (const entry of readdirSync(SPEC_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SPEC_DIR, entry.name, 'expected.json');
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { intent?: string; tree: ExpectedNode };
    specs.set(entry.name, {
      layout: entry.name,
      intent: parsed.intent ?? '',
      tree: parsed.tree,
      display: expectedToDisplay(parsed.tree),
    });
  }
  return specs;
}

function producerFile(producer: string, layout: string): string {
  return path.join(PRODUCERS_DIR, producer, `${layout}.html`);
}

// Per-producer base stylesheet, inlined into a producer's layout at run time so
// the converter still sees styling inline and the input stays self-contained.
const baseCache = new Map<string, string>();
function baseFor(producer: string): string {
  if (!baseCache.has(producer)) {
    const p = path.join(EVAL_DIR, 'base', `${producer}.css`);
    baseCache.set(producer, existsSync(p) ? readFileSync(p, 'utf8') : '');
  }
  return baseCache.get(producer)!;
}

function composeInput(producer: string, layout: string): string {
  const markup = readFileSync(producerFile(producer, layout), 'utf8');
  const base = baseFor(producer);
  return base ? `<style>\n${base}\n</style>\n${markup}` : markup;
}

async function scoreFixture(producer: string, layout: string, spec: Spec): Promise<Result> {
  const label = `${producer}/${layout}`;
  const inputHtml = composeInput(producer, layout);

  const report = await convert(inputHtml, { sourcePath: `${label}.html`, config: { media: { resolver: 'noop' } } });
  const produced = await parseMarkup(report.output ?? '');

  const tally: Tally = { structureTotal: 0, structureMatched: 0, contentTotal: 0, contentMatched: 0, misses: [] };
  matchNode(spec.tree, produced, tally, label);

  const structurePct = pct(tally.structureMatched, tally.structureTotal);
  const contentPct = tally.contentTotal === 0 ? 1 : tally.contentMatched / tally.contentTotal;
  const valid = report.summary.invalid === 0;
  const fallbacks = countByName(produced, 'core/html');

  let score = 0.75 * structurePct + 0.25 * contentPct;
  if (!valid) score *= 0.5;

  return {
    producer,
    layout,
    label,
    inputHtml,
    structurePct,
    contentPct,
    valid,
    fallbacks,
    score: Math.round(score * 100),
    misses: tally.misses,
  };
}

/** Find the produced block matching `exp` among `candidates`, then recurse. */
function matchNode(exp: ExpectedNode, candidates: WpBlock[], tally: Tally, pathLabel: string): WpBlock | undefined {
  tally.structureTotal += 1;
  const match = candidates.find((block) => block.name === exp.block);
  const here = `${pathLabel} > ${exp.block}`;

  if (!match) {
    tally.misses.push(`expected ${exp.block} (${pathLabel}) — not found`);
    countMissedSubtree(exp, tally);
    return undefined;
  }

  tally.structureMatched += 1;

  if (exp.contains !== undefined) {
    tally.contentTotal += 1;
    if (blockText(match).includes(exp.contains)) {
      tally.contentMatched += 1;
    } else {
      tally.misses.push(`${here} — expected to contain "${exp.contains}"`);
    }
  }

  if (exp.children?.length) {
    let cursor = 0;
    const kids = match.innerBlocks ?? [];
    for (const child of exp.children) {
      const window = kids.slice(cursor);
      const found = matchNode(child, window, tally, here);
      if (found) cursor += window.indexOf(found) + 1;
    }
  }

  return match;
}

function countMissedSubtree(exp: ExpectedNode, tally: Tally): void {
  if (exp.contains !== undefined) tally.contentTotal += 1;
  for (const child of exp.children ?? []) {
    tally.structureTotal += 1;
    countMissedSubtree(child, tally);
  }
}

function expectedToDisplay(node: ExpectedNode): DisplayNode {
  return {
    name: node.block,
    note: node.contains ? `"${node.contains}"` : undefined,
    children: (node.children ?? []).map(expectedToDisplay),
  };
}

function blockText(block: WpBlock): string {
  // Core blocks store text in attributes (paragraph/heading `content`, button
  // `text`, image `url`/`alt`). For leaf blocks also consider raw inner markup,
  // in case text lives in innerHTML; skip for containers so a `contains` on a
  // parent doesn't match a descendant's text.
  const attrs = JSON.stringify(block.attributes ?? {});
  const inner = (block.innerBlocks?.length ?? 0) === 0 ? block.originalContent ?? '' : '';
  return `${attrs} ${inner}`;
}

function countByName(blocks: WpBlock[], name: string): number {
  let total = 0;
  for (const block of blocks) {
    if (block.name === name) total += 1;
    total += countByName(block.innerBlocks ?? [], name);
  }
  return total;
}

function pct(matched: number, total: number): number {
  return total === 0 ? 1 : matched / total;
}

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ── Console scoreboard ───────────────────────────────────────────────────────

function printConsole(results: Result[]): void {
  console.log('\nFIXTURE                                STRUCT  CONTENT  VALID  FALLBKS  SCORE');
  console.log('─'.repeat(78));
  for (const r of results) {
    console.log(
      `${r.label.padEnd(38)} ${fmtPct(r.structurePct).padStart(6)} ${fmtPct(r.contentPct).padStart(8)} ` +
        `${(r.valid ? '✓' : '✗').padStart(6)} ${String(r.fallbacks).padStart(8)} ${String(r.score).padStart(6)}`,
    );
    for (const miss of r.misses) console.log(`  ↳ ${miss}`);
  }
  console.log('─'.repeat(78));
  const avg = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
  const invalid = results.filter((r) => !r.valid).length;
  const fallbacks = results.reduce((sum, r) => sum + r.fallbacks, 0);
  console.log(`corpus avg: ${avg}  ·  fixtures: ${results.length}  ·  invalid: ${invalid}  ·  fallbacks: ${fallbacks}`);
  for (const [source, avgScore, count] of bySource(results)) {
    console.log(`  ${source.padEnd(20)} avg ${String(avgScore).padStart(3)}  (${count} layouts)`);
  }
}

function bySource(results: Result[]): [string, number, number][] {
  const groups = new Map<string, number[]>();
  for (const r of results) {
    groups.set(r.producer, [...(groups.get(r.producer) ?? []), r.score]);
  }
  return [...groups.entries()]
    .map(([source, scores]): [string, number, number] => [
      source,
      Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
      scores.length,
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

// ── Provenance / history ─────────────────────────────────────────────────────

function buildRecord(results: Result[], specs: Map<string, Spec>): RunRecord {
  return {
    runAt: new Date().toISOString(),
    ...gitInfo(),
    version: readPackageVersion(),
    engine: engineLabel(),
    model: modelLabel(),
    effort: effortLabel(),
    suiteHash: suiteHash(specs),
    corpusAvg: Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length),
    producers: Object.fromEntries(bySource(results).map(([source, avg]) => [source, avg])),
    fixtures: Object.fromEntries(results.map((r) => [r.label, r.score])),
  };
}

function readHistory(): RunRecord[] {
  if (!existsSync(RESULTS_PATH)) return [];
  return readFileSync(RESULTS_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunRecord);
}

function gitInfo(): { commit: string; branch: string; author: string } {
  const run = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return '';
    }
  };
  return {
    commit: process.env.GITHUB_SHA?.slice(0, 7) || run('git rev-parse --short HEAD') || 'unknown',
    branch: process.env.GITHUB_REF_NAME || run('git rev-parse --abbrev-ref HEAD') || 'unknown',
    author: process.env.GITHUB_ACTOR || run('git log -1 --format=%an') || 'unknown',
  };
}

function readPackageVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Hash the spec set + producer inputs + base, so a score change is attributable
// to the converter only when the suite is unchanged.
function suiteHash(specs: Map<string, Spec>): string {
  const h = createHash('sha256');
  for (const layout of [...specs.keys()].sort()) {
    h.update(`spec:${layout}`);
    h.update(readFileSync(path.join(SPEC_DIR, layout, 'expected.json')));
  }
  if (existsSync(PRODUCERS_DIR)) {
    for (const entry of readdirSync(PRODUCERS_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(PRODUCERS_DIR, entry.name);
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
        h.update(`prod:${entry.name}/${file}`);
        h.update(readFileSync(path.join(dir, file)));
      }
    }
  }
  const baseDir = path.join(EVAL_DIR, 'base');
  if (existsSync(baseDir)) {
    for (const file of readdirSync(baseDir).sort()) h.update(readFileSync(path.join(baseDir, file)));
  }
  return `sha256:${h.digest('hex').slice(0, 12)}`;
}

// ── Review page (report/review.html) — per layout, ideal vs each producer ─────

const IMG_PLACEHOLDER = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" role="img">` +
    `<rect width="400" height="300" fill="#e7e9ee"/>` +
    `<g fill="none" stroke="#b7bdc9" stroke-width="2.5">` +
    `<circle cx="148" cy="116" r="24"/><path d="M64 232 L168 156 L236 210 L304 158 L356 232 Z"/></g></svg>`,
);
const BG_PLACEHOLDER = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#1f2937"/><stop offset="1" stop-color="#3b3f5c"/></linearGradient></defs>` +
    `<rect width="1200" height="800" fill="url(#g)"/></svg>`,
);

function svgDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function preparePreview(html: string): string {
  // Unquoted url() on purpose: the data URIs are percent-encoded (no spaces,
  // parens, or quotes), so quotes here would collide with inline style="" and
  // the srcdoc="" attribute and break the declaration.
  const swapped = html
    .replace(/(<img\b[^>]*\bsrc=)(["'])[^"']*\2/gi, `$1$2${IMG_PLACEHOLDER}$2`)
    .replace(/url\((['"]?)[^)]*\1\)/gi, `url(${BG_PLACEHOLDER})`);
  const base =
    `<style>html,body{margin:0}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;` +
    `color:#111;background:#fff;-webkit-font-smoothing:antialiased}*{box-sizing:border-box}` +
    `img{max-width:100%}</style>`;
  return base + swapped;
}

function renderHtml(specs: Map<string, Spec>, results: Result[]): string {
  const byLayout = new Map<string, Result[]>();
  for (const r of results) byLayout.set(r.layout, [...(byLayout.get(r.layout) ?? []), r]);

  const sections = [...specs.values()]
    .map((spec) => {
      const producers = (byLayout.get(spec.layout) ?? []).sort((a, b) => a.producer.localeCompare(b.producer));
      const previews = producers.length
        ? producers
            .map(
              (r) => `<figure class="prod">
                <figcaption>${esc(r.producer)}</figcaption>
                <div class="frame"><iframe sandbox loading="lazy" srcdoc="${escAttr(preparePreview(r.inputHtml))}"></iframe></div>
              </figure>`,
            )
            .join('\n')
        : `<p class="missing">No producer inputs for this layout yet.</p>`;
      return `<section class="layout">
        <header class="layout__head">
          <h2>${esc(humanize(spec.layout))}</h2>
          ${spec.intent ? `<p class="intent">${esc(spec.intent)}</p>` : ''}
        </header>
        <div class="split">
          <div class="ideal">
            <p class="panel-label">Ideal end state</p>
            <div class="tree"><ul>${renderTree(spec.display)}</ul></div>
          </div>
          <div class="renders">
            <p class="panel-label">Producer renders</p>
            <div class="prod-grid">${previews}</div>
          </div>
        </div>
      </section>`;
    })
    .join('\n');

  const producerNames = [...new Set(results.map((r) => r.producer))].sort();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Block Runner — conversion benchmark</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: oklch(0.992 0.003 255); --surface: oklch(1 0 0); --panel: oklch(0.975 0.004 255);
    --ink: oklch(0.24 0.02 262); --muted: oklch(0.52 0.018 262); --faint: oklch(0.66 0.012 262);
    --line: oklch(0.91 0.006 262); --line-soft: oklch(0.94 0.005 262);
    --accent: oklch(0.55 0.15 264); --accent-ink: oklch(0.42 0.13 264);
    --radius: 12px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: oklch(0.19 0.012 262); --surface: oklch(0.225 0.014 262); --panel: oklch(0.25 0.015 262);
      --ink: oklch(0.95 0.008 262); --muted: oklch(0.72 0.016 262); --faint: oklch(0.56 0.014 262);
      --line: oklch(0.33 0.014 262); --line-soft: oklch(0.29 0.012 262);
      --accent: oklch(0.74 0.13 264); --accent-ink: oklch(0.8 0.12 264);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1500px; margin-inline: auto; padding: 72px 32px; }
  .masthead { margin-bottom: 64px; max-width: 70ch; }
  .masthead h1 { font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.2rem); font-weight: 620; letter-spacing: -0.025em; margin: 0 0 0.25rem; text-wrap: balance; }
  .masthead p { margin: 0; color: var(--muted); }
  .producers-line { margin-top: 1rem; font-size: 0.85rem; color: var(--faint); }
  .producers-line b { color: var(--muted); }

  .layout { margin-bottom: 72px; padding-top: 28px; border-top: 1px solid var(--line); }
  .layout__head { margin-bottom: 24px; }
  .layout__head h2 { font-size: 1.3rem; font-weight: 640; letter-spacing: -0.015em; margin: 0; }
  .intent { margin: 0.4rem 0 0; color: var(--muted); font-style: italic; max-width: 80ch; text-wrap: pretty; }

  .split { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 40px; align-items: start; }
  @media (max-width: 1024px) { .split { grid-template-columns: 1fr; gap: 28px; } }
  .panel-label { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin: 0 0 14px; }

  .tree { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.85; position: sticky; top: 24px; }
  .tree ul { list-style: none; margin: 0; padding: 0; }
  .tree ul ul { margin-left: 6px; padding-left: 14px; border-left: 1px solid var(--line); }
  .ns { color: var(--faint); }
  .blk { color: var(--ink); font-weight: 600; }
  .blk--3p { color: var(--accent-ink); }
  .blk--html { color: oklch(0.55 0.17 25); }
  .note { color: var(--muted); font-weight: 400; }
  .note::before { content: "· "; color: var(--faint); }

  .prod-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 24px; }
  .prod { margin: 0; }
  .prod figcaption { font-size: 0.8rem; font-weight: 600; color: var(--muted); margin-bottom: 8px; text-transform: capitalize; }
  .frame { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--surface); box-shadow: 0 1px 2px oklch(0 0 0 / 0.04), 0 8px 24px -16px oklch(0 0 0 / 0.18); }
  iframe { display: block; width: 100%; height: clamp(320px, 38vh, 460px); border: 0; background: #fff; }
  .missing { color: var(--faint); font-style: italic; }
</style>
</head>
<body>
  <div class="wrap">
    <header class="masthead">
      <h1>Conversion benchmark</h1>
      <p>One brief per layout, the ideal native block tree, and each producer's HTML answer. Compare how convertible different generators' output is — review the nesting against each render.</p>
      <p class="producers-line"><b>Producers:</b> ${producerNames.length ? producerNames.map((p) => esc(p)).join(' · ') : '—'} · scores live in the scoreboard, not here.</p>
    </header>
    ${sections}
  </div>
</body>
</html>
`;
}

function renderTree(node: DisplayNode): string {
  const [ns, rest] = splitBlockName(node.name);
  const cls = node.name === 'core/html' ? 'blk blk--html' : ns === 'core/' ? 'blk' : 'blk blk--3p';
  const label = `<span class="ns">${esc(ns)}</span><span class="${cls}">${esc(rest)}</span>`;
  const note = node.note ? ` <span class="note">${esc(node.note)}</span>` : '';
  const kids = node.children.length ? `<ul>${node.children.map(renderTree).join('')}</ul>` : '';
  return `<li>${label}${note}${kids}</li>`;
}

function splitBlockName(name: string): [string, string] {
  const i = name.indexOf('/');
  return i === -1 ? ['', name] : [name.slice(0, i + 1), name.slice(i + 1)];
}

function humanize(slug: string): string {
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escAttr(value: string): string {
  return esc(value).replaceAll('"', '&quot;');
}

function scoreColor(score: number): string {
  if (score >= 85) return '#16a34a';
  if (score >= 50) return '#d97706';
  return '#dc2626';
}

// ── Scoreboard (report/scoreboard.html) ──────────────────────────────────────

function renderScoreboard(history: RunRecord[], current: RunRecord): string {
  const recorded = history.length > 0;
  const latest = recorded ? history[history.length - 1] : current;
  const producers = [...new Set(history.flatMap((r) => Object.keys(r.producers)).concat(Object.keys(current.producers)))].sort();

  const producerChips = Object.entries(latest.producers)
    .sort()
    .map(([p, v]) => `<span class="chip" style="--c:${scoreColor(v)}">${esc(p)} · ${v}</span>`)
    .join(' ');

  const trend = recorded ? trendChart(history, producers) : `<p class="empty">No recorded runs yet. Run <code>npm run bench:record</code> to start the history. The snapshot below is the current (unrecorded) run.</p>`;

  const runRows = [...history]
    .reverse()
    .map(
      (r) => `<tr>
        <td>${esc(r.runAt.slice(0, 10))}</td>
        <td class="mono">${esc(r.commit)}${r.engine && r.engine !== 'local' ? ` <span class="faint">eng:${esc(r.engine)}</span>` : ''}</td>
        <td>${esc(r.author)}</td>
        <td class="num"><b style="color:${scoreColor(r.corpusAvg)}">${r.corpusAvg}</b></td>
        <td>${Object.entries(r.producers).sort().map(([p, v]) => `${esc(p)} ${v}`).join(' · ')}</td>
        <td class="mono faint">${esc(r.suiteHash.replace('sha256:', ''))}</td>
      </tr>`,
    )
    .join('\n');

  const lastIsCurrent = history.length > 0 && history[history.length - 1].runAt === current.runAt;
  const prev = lastIsCurrent ? history[history.length - 2] : history[history.length - 1];
  const fixtureRows = Object.entries(current.fixtures)
    .sort()
    .map(([label, score]) => {
      const before = prev?.fixtures[label];
      const delta = before === undefined ? '' : score - before;
      const deltaCell =
        delta === '' ? '<span class="faint">—</span>' : delta === 0 ? '<span class="faint">·</span>' : `<span style="color:${delta > 0 ? '#16a34a' : '#dc2626'}">${delta > 0 ? '+' : ''}${delta}</span>`;
      return `<tr><td class="mono">${esc(label)}</td><td class="num"><b style="color:${scoreColor(score)}">${score}</b></td><td class="num">${deltaCell}</td></tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Block Runner — benchmark scoreboard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: oklch(0.992 0.003 255); --surface: oklch(1 0 0); --panel: oklch(0.975 0.004 255);
    --ink: oklch(0.24 0.02 262); --muted: oklch(0.52 0.018 262); --faint: oklch(0.66 0.012 262);
    --line: oklch(0.91 0.006 262); --accent: oklch(0.55 0.15 264);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: oklch(0.19 0.012 262); --surface: oklch(0.225 0.014 262); --panel: oklch(0.25 0.015 262);
      --ink: oklch(0.95 0.008 262); --muted: oklch(0.72 0.016 262); --faint: oklch(0.56 0.014 262);
      --line: oklch(0.33 0.014 262); --accent: oklch(0.74 0.13 264);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1100px; margin-inline: auto; padding: 72px 32px; }
  h1 { font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.2rem); font-weight: 620; letter-spacing: -0.025em; margin: 0 0 0.25rem; }
  .sub { color: var(--muted); margin: 0 0 2.5rem; }
  h2 { font-size: 0.95rem; font-weight: 600; margin: 2.5rem 0 1rem; }
  .snapshot { display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; padding: 1.25rem 1.5rem; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
  .big { font-size: 2.6rem; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
  .big small { display: block; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); margin-bottom: 6px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { font-size: 0.8rem; font-weight: 600; color: #fff; background: var(--c); padding: 3px 10px; border-radius: 999px; }
  .prov { color: var(--faint); font-size: 0.82rem; margin-left: auto; text-align: right; }
  .prov .mono { font-family: ui-monospace, monospace; }
  .chart { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); padding: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th { text-align: left; font-weight: 600; color: var(--faint); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 12px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 12px; border-bottom: 1px solid var(--line); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, monospace; font-size: 0.82rem; }
  .faint { color: var(--faint); }
  .empty { color: var(--muted); background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; }
  .empty code { font-family: ui-monospace, monospace; background: var(--surface); padding: 1px 6px; border-radius: 6px; }
  .grids { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; align-items: start; }
  @media (max-width: 820px) { .grids { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Benchmark scoreboard</h1>
    <p class="sub">Conversion-fidelity scores over time. ${recorded ? `${history.length} recorded run${history.length === 1 ? '' : 's'}.` : 'No history recorded yet.'}</p>

    <div class="snapshot">
      <div class="big"><small>Corpus avg${recorded ? '' : ' (current)'}</small>${latest.corpusAvg}</div>
      <div class="chips">${producerChips}</div>
      <div class="prov">${esc(latest.runAt.slice(0, 10))} · <span class="mono">${esc(latest.commit)}</span> · ${esc(latest.author)} · v${esc(latest.version)}<br><span class="mono faint">${esc(latest.engine ?? 'local')} · ${esc(latest.model ?? '—')}/${esc(latest.effort ?? '—')} · ${esc(latest.suiteHash)}</span></div>
    </div>

    <h2>Trend</h2>
    ${trend}

    <div class="grids">
      <div>
        <h2>Fixtures (latest${prev ? ', Δ vs previous run' : ''})</h2>
        <table><thead><tr><th>Producer / layout</th><th class="num">Score</th><th class="num">Δ</th></tr></thead><tbody>${fixtureRows}</tbody></table>
      </div>
      <div>
        <h2>Runs</h2>
        ${recorded ? `<table><thead><tr><th>Date</th><th>Commit</th><th>Author</th><th class="num">Corpus</th><th>Producers</th><th>Suite</th></tr></thead><tbody>${runRows}</tbody></table>` : '<p class="empty">Recorded runs will appear here.</p>'}
      </div>
    </div>
  </div>
</body>
</html>
`;
}

function trendChart(history: RunRecord[], producers: string[]): string {
  const W = 1000;
  const H = 240;
  const pad = 28;
  const n = history.length;
  const x = (i: number) => (n === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number) => H - pad - (v / 100) * (H - 2 * pad);

  const gridY = [0, 25, 50, 75, 100]
    .map((v) => `<line x1="${pad}" y1="${y(v)}" x2="${W - pad}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pad - 6}" y="${y(v) + 3}" text-anchor="end" font-size="11" fill="var(--faint)">${v}</text>`)
    .join('');

  const series = (key: (r: RunRecord) => number | undefined, color: string, width: number) => {
    const pts = history.map((r, i) => ({ i, v: key(r) })).filter((p) => p.v !== undefined) as { i: number; v: number }[];
    if (pts.length === 0) return '';
    const poly = pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ');
    const dots = pts.map((p) => `<circle cx="${x(p.i)}" cy="${y(p.v)}" r="3" fill="${color}"/>`).join('');
    return `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>${dots}`;
  };

  const palette = ['#7c7cf0', '#16a34a', '#d97706', '#dc2626', '#0ea5e9'];
  const producerLines = producers.map((p, idx) => series((r) => r.producers[p], palette[(idx + 1) % palette.length], 1.5)).join('');
  const corpusLine = series((r) => r.corpusAvg, 'var(--accent)', 2.5);

  const legend = [`<span class="chip" style="--c:var(--accent)">corpus</span>`]
    .concat(producers.map((p, idx) => `<span class="chip" style="--c:${palette[(idx + 1) % palette.length]}">${esc(p)}</span>`))
    .join(' ');

  return `<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Scores over time">
      ${gridY}${producerLines}${corpusLine}
    </svg>
    <div class="chips" style="margin-top:12px">${legend}</div>
  </div>`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
