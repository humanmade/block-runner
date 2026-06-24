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
 * Generated pages (gitignored) under benchmarks/presentation/:
 *   review.html      — per layout: the ideal end state + each producer's render.
 *   scoreboard.html  — scores over time from benchmarks/results.jsonl.
 *
 * With `--record` it appends one provenance-tagged record to results.jsonl.
 *
 * Run: `npm run bench` (or `npm run bench:record`).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import type { ConvertOptions, BlockRunnerReport } from '../src/types.js';
import {
  ROOT,
  PRODUCERS_DIR,
  RESULTS_PATH,
  loadSpecs,
  producerFile,
  producerMeta,
  scoreFixture,
  suiteHash,
  type Spec,
  type DisplayNode,
  type Result,
  type ProducerMeta,
} from './tuner/score.js';

// The engine under test, loaded dynamically so it can be swapped for backtesting:
// `--engine <path>` or BLOCK_RUNNER_ENGINE points at another version's built entry
// (e.g. an old commit's dist/index.js in a git worktree). Default = this repo's source.
// The scoring core (scripts/tuner/score.ts) stays current — it's a stable scoring
// utility, not the thing under test. The suite is the constant; the engine is the variable.
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
  coverage: number;
  confidence: number | null;
  producers: Record<string, number>;
  fixtures: Record<string, number>;
  producerMeta: Record<string, ProducerMeta>;
}

const REPORT_PATH = path.join(ROOT, 'benchmarks', 'presentation', 'review.html');
const SCOREBOARD_PATH = path.join(ROOT, 'benchmarks', 'presentation', 'scoreboard.html');

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

  const onlyProducer = engineArg('--producer');
  const onlyLayouts = engineArg('--layouts')?.split(',').map((s) => s.trim());
  const results: Result[] = [];
  for (const producer of producers) {
    if (onlyProducer && producer !== onlyProducer) continue;
    for (const [layout, spec] of specs) {
      if (onlyLayouts && !onlyLayouts.includes(layout)) continue;
      if (existsSync(producerFile(producer, layout))) {
        results.push(await scoreFixture(convert, producer, layout, spec));
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
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true }); // benchmarks/presentation/ generated files are gitignored
  writeFileSync(REPORT_PATH, renderHtml(specs, results), 'utf8');
  writeFileSync(SCOREBOARD_PATH, renderScoreboard(history, record), 'utf8');
  console.log(`\nreview page:  file://${REPORT_PATH}`);
  console.log(`scoreboard:   file://${SCOREBOARD_PATH}\n`);
}

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ── Console scoreboard ───────────────────────────────────────────────────────

function printConsole(results: Result[]): void {
  console.log('\nFIXTURE                                STRUCT  CONTENT   COVER  VALID  FALLBKS  SCORE');
  console.log('─'.repeat(86));
  for (const r of results) {
    console.log(
      `${r.label.padEnd(38)} ${fmtPct(r.structurePct).padStart(6)} ${fmtPct(r.contentPct).padStart(8)} ` +
        `${fmtPct(r.coverage).padStart(7)} ${(r.valid ? '✓' : '✗').padStart(6)} ${String(r.fallbacks).padStart(8)} ${String(r.score).padStart(6)}`,
    );
    for (const miss of r.misses) console.log(`  ↳ ${miss}`);
  }
  console.log('─'.repeat(86));
  const avg = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
  const cov = Math.round((results.reduce((sum, r) => sum + r.coverage, 0) / results.length) * 100);
  const invalid = results.filter((r) => !r.valid).length;
  const fallbacks = results.reduce((sum, r) => sum + r.fallbacks, 0);
  console.log(`corpus avg: ${avg}  ·  coverage: ${cov}%  ·  fixtures: ${results.length}  ·  invalid: ${invalid}  ·  fallbacks: ${fallbacks}`);
  for (const [source, avgScore, count] of bySource(results)) {
    const m = producerMeta(source);
    const tag = m.model ? `  [${m.model}${m.effort && m.effort !== 'n/a' ? `/${m.effort}` : ''}]` : '';
    console.log(`  ${source.padEnd(20)} avg ${String(avgScore).padStart(3)}  (${count} layouts)${tag}`);
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
    coverage: Math.round((results.reduce((sum, r) => sum + r.coverage, 0) / results.length) * 100),
    // Per-conversion confidence is engine-emitted (calibrated: HIGH only when no judgment
    // was involved). The deterministic engine doesn't emit it yet → null. Populated once an
    // engine reports it on its report.summary.
    confidence: null,
    producers: Object.fromEntries(bySource(results).map(([source, avg]) => [source, avg])),
    fixtures: Object.fromEntries(results.map((r) => [r.label, r.score])),
    producerMeta: Object.fromEntries(
      [...new Set(results.map((r) => r.producer))]
        .map((p): [string, ProducerMeta] => [p, producerMeta(p)])
        .filter(([, m]) => Object.keys(m).length > 0),
    ),
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

// ── Review page (benchmarks/presentation/review.html) — per layout, ideal vs each producer ─────

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
  @font-face {
    font-family: 'Geist';
    src: url('./fonts/Geist.woff2') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist Mono';
    src: url('./fonts/GeistMono.woff2') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  :root {
    --font-sans: Geist, system-ui, -apple-system, sans-serif;
    --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

    --bg: #f7f7f5;
    --raised: #ffffff;
    --band: #f0efec;
    --ink: #14181f;
    --body: #1f2430;
    --muted: #4a5160;
    --faint: #6b7280;
    --line: rgba(20, 24, 31, 0.1);
    --line-strong: rgba(20, 24, 31, 0.16);

    --brand: #2b303b;
    --brand-ink: #14181f;
    --brand-soft: rgba(20, 24, 31, 0.05);

    --shadow: 0 1px 2px rgba(20, 24, 31, 0.04), 0 8px 24px rgba(20, 24, 31, 0.05);
    --radius: 16px;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--body); font-family: var(--font-sans); font-size: 15px; line-height: 1.5; letter-spacing: -0.006em; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  .wrap { max-width: 1500px; margin-inline: auto; padding: 72px 32px; }
  .masthead { margin-bottom: 64px; max-width: 70ch; }
  .masthead h1 { font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.2rem); font-weight: 600; letter-spacing: -0.025em; color: var(--ink); margin: 0 0 0.25rem; text-wrap: balance; }
  .masthead p { margin: 0; color: var(--muted); }
  .producers-line { margin-top: 1rem; font-family: var(--font-mono); font-size: 12px; color: var(--faint); }
  .producers-line b { color: var(--ink); font-weight: 500; }

  .layout { margin-bottom: 72px; padding-top: 28px; border-top: 1px solid var(--line); }
  .layout__head { margin-bottom: 24px; }
  .layout__head h2 { font-size: 1.3rem; font-weight: 600; letter-spacing: -0.015em; color: var(--ink); margin: 0; }
  .intent { margin: 0.4rem 0 0; color: var(--muted); max-width: 80ch; text-wrap: pretty; }

  .split { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 40px; align-items: start; }
  @media (max-width: 1024px) { .split { grid-template-columns: 1fr; gap: 28px; } }
  .panel-label { font-family: var(--font-mono); font-size: 11.5px; font-weight: 400; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); margin: 0 0 14px; }

  .tree { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.85; position: sticky; top: 24px; }
  .tree ul { list-style: none; margin: 0; padding: 0; }
  .tree ul ul { margin-left: 6px; padding-left: 14px; border-left: 1px solid var(--line); }
  .ns { color: var(--faint); }
  .blk { color: var(--ink); font-weight: 600; }
  .blk--3p { color: var(--muted); }
  .blk--html { color: var(--faint); }
  .note { color: var(--muted); font-weight: 400; }
  .note::before { content: "· "; color: var(--faint); }

  .prod-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 24px; }
  .prod { margin: 0; }
  .prod figcaption { font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--muted); margin-bottom: 8px; text-transform: capitalize; }
  .frame { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--raised); box-shadow: var(--shadow); }
  iframe { display: block; width: 100%; height: clamp(320px, 38vh, 460px); border: 0; background: #fff; }
  .missing { color: var(--faint); }
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

// Monochrome score scale: low score = weak (light grey), high score = strong (dark slate).
function scoreColor(score: number): string {
  if (score >= 85) return '#2a2f3a'; // --c-eng-c
  if (score >= 70) return '#5f6775'; // --c-eng-cgpt
  if (score >= 50) return '#939aa6'; // --c-codex-alone
  return '#cdd2d9'; // --c-eng-a
}

// ── Scoreboard (benchmarks/presentation/scoreboard.html) ──────────────────────────────────────

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
        <td class="mono">${esc(r.commit)}${r.engine && r.engine !== 'local' ? ` <span class="faint">${esc(r.engine)}/${esc(r.model ?? '?')}/${esc(r.effort ?? '?')}</span>` : ''}</td>
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
        delta === '' ? '<span class="faint">—</span>' : delta === 0 ? '<span class="faint">·</span>' : `<span class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${delta}</span>`;
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
  @font-face {
    font-family: 'Geist';
    src: url('./fonts/Geist.woff2') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist Mono';
    src: url('./fonts/GeistMono.woff2') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  :root {
    --font-sans: Geist, system-ui, -apple-system, sans-serif;
    --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

    --bg: #f7f7f5;
    --raised: #ffffff;
    --band: #f0efec;
    --ink: #14181f;
    --body: #1f2430;
    --muted: #4a5160;
    --faint: #6b7280;
    --line: rgba(20, 24, 31, 0.1);
    --line-strong: rgba(20, 24, 31, 0.16);

    --brand: #2b303b;
    --brand-ink: #14181f;
    --brand-soft: rgba(20, 24, 31, 0.05);
    --grid: rgba(20, 24, 31, 0.07);
    --shadow: 0 1px 2px rgba(20, 24, 31, 0.04), 0 8px 24px rgba(20, 24, 31, 0.05);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--body); font-family: var(--font-sans); font-size: 15px; line-height: 1.5; letter-spacing: -0.006em; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  .wrap { max-width: 1280px; margin-inline: auto; padding: 72px 32px; }
  h1 { font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.2rem); font-weight: 600; letter-spacing: -0.025em; color: var(--ink); margin: 0 0 0.25rem; }
  .sub { color: var(--muted); margin: 0 0 2.5rem; }
  h2 { font-family: var(--font-mono); font-size: 11.5px; font-weight: 400; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); margin: 2.5rem 0 1rem; }
  .snapshot { display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; padding: 1.25rem 1.5rem; border: 1px solid var(--line); border-radius: 16px; background: var(--raised); box-shadow: var(--shadow); }
  .big { font-size: 2.6rem; font-weight: 600; letter-spacing: -0.03em; line-height: 1; color: var(--ink); }
  .big small { display: block; font-family: var(--font-mono); font-size: 11px; font-weight: 400; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); margin-bottom: 6px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { font-family: var(--font-mono); font-size: 11.5px; font-weight: 500; color: var(--raised); background: var(--c, var(--brand)); padding: 3px 10px; border-radius: 999px; }
  .prov { color: var(--faint); font-family: var(--font-mono); font-size: 11px; margin-left: auto; text-align: right; line-height: 1.6; }
  .prov .mono { font-family: var(--font-mono); }
  .chart { border: 1px solid var(--line); border-radius: 16px; background: var(--raised); box-shadow: var(--shadow); padding: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th { text-align: left; font-family: var(--font-mono); font-weight: 400; color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em; padding: 0 12px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 12px; border-bottom: 1px solid var(--line); color: var(--body); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: var(--font-mono); font-size: 0.82rem; }
  .faint { color: var(--faint); }
  .delta.up { color: var(--ink); }
  .delta.down { color: var(--faint); }
  .empty { color: var(--muted); background: var(--raised); border: 1px solid var(--line); border-radius: 16px; box-shadow: var(--shadow); padding: 16px 20px; }
  .empty code { font-family: var(--font-mono); font-size: 11.5px; background: var(--band); padding: 1px 6px; border-radius: 4px; color: var(--body); }
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

  // Monochrome producer series — a grey→slate scale, distinct from the dark brand corpus line.
  const palette = ['#cdd2d9', '#b6bcc5', '#939aa6', '#5f6775', '#2a2f3a'];
  const producerLines = producers.map((p, idx) => series((r) => r.producers[p], palette[idx % palette.length], 1.5)).join('');
  const corpusLine = series((r) => r.corpusAvg, 'var(--brand)', 2.5);

  const legend = [`<span class="chip" style="--c:var(--brand)">corpus</span>`]
    .concat(producers.map((p, idx) => `<span class="chip" style="--c:${palette[idx % palette.length]}">${esc(p)}</span>`))
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
