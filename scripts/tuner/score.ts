/**
 * Shared scoring core — the single definition of how a converter's output is
 * measured against a spec. Extracted from bench.ts so the benchmark scorecard
 * and the tuner score identically (one definition, two consumers).
 *
 * It owns: spec loading, fixture composition, `scoreFixture` + `matchNode`, the
 * coverage metric, `suiteHash`, the path constants, and the `Result`/`Spec`/
 * `ProducerMeta` types. bench.ts keeps the rendering (review/scoreboard pages);
 * the tuner keeps the cache/smoke/attribute/ratchet bookkeeping. Nothing here
 * knows which engine it scores — the convert fn is passed in.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseMarkup } from '../../src/headless/wp.js';
import type { WpBlock, ConvertOptions, BlockRunnerReport } from '../../src/types.js';

export type ConvertFn = (input: string, options?: ConvertOptions) => Promise<BlockRunnerReport>;

export interface ExpectedNode {
  block: string;
  contains?: string;
  children?: ExpectedNode[];
}

export interface DisplayNode {
  name: string;
  note?: string;
  children: DisplayNode[];
}

export interface Spec {
  layout: string;
  intent: string;
  tree: ExpectedNode;
  display: DisplayNode;
}

export interface Tally {
  structureTotal: number;
  structureMatched: number;
  contentTotal: number;
  contentMatched: number;
  misses: string[];
}

export interface Result {
  producer: string;
  layout: string;
  label: string;
  inputHtml: string;
  structurePct: number;
  contentPct: number;
  valid: boolean;
  fallbacks: number;
  coverage: number;
  score: number;
  misses: string[];
}

export interface ProducerMeta {
  generator?: string;
  provider?: string;
  model?: string;
  effort?: string;
  note?: string;
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EVAL_DIR = path.join(ROOT, 'benchmarks');
export const SPEC_DIR = path.join(EVAL_DIR, 'specs');
export const PRODUCERS_DIR = path.join(EVAL_DIR, 'producers');
export const RESULTS_PATH = path.join(EVAL_DIR, 'results.jsonl');

export function loadSpecs(): Map<string, Spec> {
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

export function producerFile(producer: string, layout: string): string {
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

// Optional per-producer generation provenance: how that producer's HTML was made
// (which tool / model / reasoning effort). Distinct from the run's engine model/effort
// (the converter). Lives at producers/<producer>/producer.json.
export function producerMeta(producer: string): ProducerMeta {
  const p = path.join(PRODUCERS_DIR, producer, 'producer.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ProducerMeta;
  } catch {
    return {};
  }
}

export function composeInput(producer: string, layout: string): string {
  const markup = readFileSync(producerFile(producer, layout), 'utf8');
  const base = baseFor(producer);
  return base ? `<style>\n${base}\n</style>\n${markup}` : markup;
}

export async function scoreFixture(convert: ConvertFn, producer: string, layout: string, spec: Spec): Promise<Result> {
  const label = `${producer}/${layout}`;
  const inputHtml = composeInput(producer, layout);

  const report = await convert(inputHtml, { sourcePath: `${label}.html`, config: { media: { resolver: 'noop' } } });
  return scoreReport(producer, layout, spec, inputHtml, report);
}

// Score an already-produced report against a spec. Splitting this out of
// scoreFixture lets the tuner replay a cached/realized report without re-running
// convert — same measurement, no engine call.
export async function scoreReport(
  producer: string,
  layout: string,
  spec: Spec,
  inputHtml: string,
  report: BlockRunnerReport,
): Promise<Result> {
  const label = `${producer}/${layout}`;
  const produced = await parseMarkup(report.output ?? '');

  const tally: Tally = { structureTotal: 0, structureMatched: 0, contentTotal: 0, contentMatched: 0, misses: [] };
  matchNode(spec.tree, produced, tally, label);

  const structurePct = pct(tally.structureMatched, tally.structureTotal);
  const contentPct = tally.contentTotal === 0 ? 1 : tally.contentMatched / tally.contentTotal;
  const valid = report.summary.invalid === 0;
  const fallbacks = countByName(produced, 'core/html');
  const cover = coverage(inputHtml, report.output ?? '');

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
    coverage: cover,
    score: Math.round(score * 100),
    misses: tally.misses,
  };
}

/** Find the produced block matching `exp` among `candidates`, then recurse. */
export function matchNode(exp: ExpectedNode, candidates: WpBlock[], tally: Tally, pathLabel: string): WpBlock | undefined {
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
    // An image-asset `contains` (a filename) asserts that an image LANDED here, not which
    // file the producer happened to name — exact-filename matching tests producer asset
    // naming, not convertibility (a producer may answer the same brief with a data-URI or a
    // differently-named asset). So satisfy it by the presence of an image source; keep exact
    // substring matching for real text. (md/05: validity ≠ fidelity; measure the right thing.)
    const ok = isAssetAssertion(exp.contains) ? hasImageSource(match) : blockText(match).includes(exp.contains);
    if (ok) {
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

export function expectedToDisplay(node: ExpectedNode): DisplayNode {
  return {
    name: node.block,
    note: node.contains ? `"${node.contains}"` : undefined,
    children: (node.children ?? []).map(expectedToDisplay),
  };
}

// An asset assertion names an image file (logo-acme.svg, founder.jpg). Producers choose their
// own assets, so we score "an image with a source landed here", not the exact filename.
function isAssetAssertion(contains: string): boolean {
  return /\.(png|jpe?g|svg|webp|gif|avif)$/i.test(contains);
}

function hasImageSource(block: WpBlock): boolean {
  const attrs = block.attributes ?? {};
  for (const key of ['url', 'mediaUrl', 'src']) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) return true;
  }
  // Containers (gallery, media-text wrappers): satisfied if any inner image carries a source.
  return (block.innerBlocks ?? []).some(hasImageSource);
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

// Coverage = fraction of the input's visible text that survives into the output.
// Catches *silent content loss* (text dropped entirely) — distinct from structure
// (wrong blocks) and fallbacks (spaghetti that still preserves text). Nothing should
// vanish without a trace.
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .toLowerCase();
}
function coverage(inputHtml: string, output: string): number {
  const inputWords = [...new Set(visibleText(inputHtml).match(/[a-z0-9]{3,}/g) ?? [])];
  if (inputWords.length === 0) return 1;
  const outText = visibleText(output);
  return inputWords.filter((w) => outText.includes(w)).length / inputWords.length;
}

export function pct(matched: number, total: number): number {
  return total === 0 ? 1 : matched / total;
}

// Hash the spec set + producer inputs + base, so a score change is attributable
// to the converter only when the suite is unchanged.
export function suiteHash(specs: Map<string, Spec>): string {
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
