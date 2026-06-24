/**
 * The engine tuner — the tiered runner that moves a converter's score up cheaply and
 * honestly. Build doc: md/13-engine-tuner.md. It is the dyno, not the engine: it never
 * knows which engine it tunes, and never makes a change look good that only moved one cell.
 *
 *   npm run tune -- --tier t0                                  # replay cache, deterministic, sub-second
 *   npm run tune -- --tier t1 --engine scripts/engines/claude.ts --model opus   # smoke, live
 *   npm run tune -- --tier t2 --engine scripts/engines/codex.ts  --model gpt-5.5 # full, live
 *   npm run tune -- --tier t0 --refresh                        # ignore cache (only meaningful with a live engine)
 *   npm run tune -- --tier t2 --baseline-update                # accept current as the new ratchet baseline
 *
 * The deterministic rules engine (no --engine) has no costly step, so all three tiers run
 * it live; the tiers differ in fixture scope (T0/T1 subset, T2 full) and the attribution /
 * ratchet they apply. The cost insight (md/13): cache the one slow, non-deterministic step
 * (the LLM call → propose) and replay the deterministic tail (realize / gate) for free.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, appendFileSync } from 'node:fs';
import type { ConvertOptions, BlockRunnerReport } from '../src/types.js';
import {
  EVAL_DIR,
  PRODUCERS_DIR,
  loadSpecs,
  producerFile,
  scoreFixture,
  scoreReport,
  composeInput,
  suiteHash,
  type Spec,
  type Result,
} from './tuner/score.js';
import { readCache, writeCache, type CacheKeyParts } from './tuner/cache.js';
import { selectSmoke, printSmokeReasons } from './tuner/smoke.js';
import { attribute, printAttribution } from './tuner/attribute.js';
import { readBaseline, detectRegressions, updateBaseline, captureRegressions, printRatchet } from './tuner/ratchet.js';

type Tier = 't0' | 't1' | 't2';

// An engine MAY expose the split contract (propose/realize/promptHash) for full T0 replay;
// otherwise it's monolithic (convert only) and T0 replays the gate over the cached output.
interface LoadedEngine {
  label: string;
  split: boolean;
  promptHash: string;
  convert?: (html: string, options?: ConvertOptions) => Promise<BlockRunnerReport>;
  propose?: (html: string, options?: ConvertOptions) => Promise<{ raw: string }>;
  realize?: (raw: string, options?: ConvertOptions) => Promise<BlockRunnerReport>;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function tier(): Tier {
  const t = arg('--tier') ?? 't0';
  if (t !== 't0' && t !== 't1' && t !== 't2') {
    console.error(`unknown --tier ${t} (expected t0|t1|t2)`);
    process.exit(1);
  }
  return t;
}

function enginePath(): string | undefined {
  return arg('--engine') ?? process.env.BLOCK_RUNNER_ENGINE ?? undefined;
}
function engineLabel(): string {
  const p = enginePath();
  if (!p) return 'local';
  return arg('--engine-label') ?? process.env.BLOCK_RUNNER_ENGINE_LABEL ?? path.basename(path.dirname(path.resolve(p)));
}
function modelLabel(): string {
  return arg('--model') ?? process.env.BLOCK_RUNNER_MODEL ?? 'deterministic';
}
function effortLabel(): string {
  return arg('--effort') ?? process.env.BLOCK_RUNNER_EFFORT ?? 'none';
}

async function loadEngine(): Promise<LoadedEngine> {
  const p = enginePath();
  const label = engineLabel();
  if (!p) {
    const mod = await import('../src/index.js');
    return { label, split: false, promptHash: 'rules', convert: mod.convert };
  }
  const mod = await import(pathToFileURL(path.resolve(p)).href);
  const split = typeof mod.propose === 'function' && typeof mod.realize === 'function';
  if (!split) {
    console.error(
      `engine "${label}" is not a split engine — it must export propose() + realize(). ` +
        `The LLM-writes-markup engine (old "Engine B") is retired; see md/13.`,
    );
    process.exit(1);
  }
  return {
    label,
    split: true,
    promptHash: typeof mod.promptHash === 'string' ? mod.promptHash : '',
    propose: mod.propose,
    realize: mod.realize,
  };
}

function allFixtures(specs: Map<string, Spec>): { producer: string; layout: string; spec: Spec }[] {
  const producers = existsSync(PRODUCERS_DIR)
    ? readdirSync(PRODUCERS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const out: { producer: string; layout: string; spec: Spec }[] = [];
  for (const producer of producers) {
    for (const [layout, spec] of specs) {
      if (existsSync(producerFile(producer, layout))) out.push({ producer, layout, spec });
    }
  }
  return out;
}

// Scope the fixtures for a tier: T2 = all; T1 = the auto-selected smoke set; T0 = whatever
// the cache already holds for this engine/model (its inner-loop sample), falling back to the
// smoke set for the live rules engine (no cache).
function scopeFixtures(
  tierName: Tier,
  engine: LoadedEngine,
  all: { producer: string; layout: string; spec: Spec }[],
): { fixtures: typeof all; smokeReasons: ReturnType<typeof selectSmoke> } {
  // T2 = every fixture (live). T0 --full = every fixture too, but replayed from cache — free,
  // for re-scoring the whole suite after a deterministic change (a scorer or assembler edit).
  if (tierName === 't2' || (tierName === 't0' && has('--full'))) return { fixtures: all, smokeReasons: [] };

  const available = new Set(all.map((f) => `${f.producer}/${f.layout}`));
  const smoke = selectSmoke(available);
  const smokeLabels = new Set(smoke.map((p) => p.label));
  const fixtures = all.filter((f) => smokeLabels.has(`${f.producer}/${f.layout}`));
  return { fixtures, smokeReasons: smoke };
}

const CONVERT_OPTS: ConvertOptions = { config: { media: { resolver: 'noop' } } };

interface FixtureRun {
  result?: Result;
  state: 'scored' | 'stale' | 'uncached';
  // propose = the model call (≈ all the wall-clock); realize = assemble + gate (ms).
  timing?: { proposeMs: number; realizeMs: number };
}

async function runFixture(
  engine: LoadedEngine,
  f: { producer: string; layout: string; spec: Spec },
  tierName: Tier,
  refresh: boolean,
): Promise<FixtureRun> {
  const label = `${f.producer}/${f.layout}`;
  const inputHtml = composeInput(f.producer, f.layout);
  const sourcePath = `${label}.html`;
  const opts: ConvertOptions = { ...CONVERT_OPTS, sourcePath };

  // The rules engine has no costly step — run it live every tier (its "cache" is itself).
  // It makes no model call, so all its time is deterministic-local (realize), proposeMs 0.
  if (engine.label === 'local') {
    const t = Date.now();
    const result = await scoreFixture(engine.convert!, f.producer, f.layout, f.spec);
    return { result, state: 'scored', timing: { proposeMs: 0, realizeMs: Date.now() - t } };
  }

  const keyParts: CacheKeyParts = {
    engineLabel: engine.label,
    model: modelLabel(),
    effort: effortLabel(),
    inputHtml,
    promptHash: engine.promptHash,
  };

  // T0 replays the cache, never calling the engine. Missing/stale cache is reported loudly,
  // never scored as 0 and never hidden (md/13).
  if (tierName === 't0' && !refresh) {
    const cached = readCache(keyParts);
    if (!cached) return { state: engine.promptHash ? 'stale' : 'uncached' };
    const t = Date.now();
    const report = await engine.realize!(cached.raw, opts);
    const result = await scoreReport(f.producer, f.layout, f.spec, inputHtml, report);
    return { result, state: 'scored', timing: { proposeMs: 0, realizeMs: Date.now() - t } };
  }

  // T1/T2 (or T0 --refresh): live propose (cache the costly artifact), then realize.
  const t0 = Date.now();
  const proposed = await engine.propose!(inputHtml, opts);
  const proposeMs = Date.now() - t0;
  const raw = proposed.raw;
  const t1 = Date.now();
  const report = await engine.realize!(raw, opts);
  const realizeMs = Date.now() - t1;
  writeCache(keyParts, label, raw, proposeMs);
  const result = await scoreReport(f.producer, f.layout, f.spec, inputHtml, report);
  return { result, state: 'scored', timing: { proposeMs, realizeMs } };
}

function printScorecard(results: Result[], stale: string[], uncached: string[]): void {
  console.log('\nFIXTURE                                STRUCT  CONTENT   COVER  VALID  FALLBKS  SCORE');
  console.log('─'.repeat(86));
  for (const r of [...results].sort((a, b) => a.label.localeCompare(b.label))) {
    console.log(
      `${r.label.padEnd(38)} ${fmtPct(r.structurePct).padStart(6)} ${fmtPct(r.contentPct).padStart(8)} ` +
        `${fmtPct(r.coverage).padStart(7)} ${(r.valid ? '✓' : '✗').padStart(6)} ${String(r.fallbacks).padStart(8)} ${String(r.score).padStart(6)}`,
    );
  }
  for (const label of stale) console.log(`${label.padEnd(38)} ${'stale'.padStart(48)}  (prompt changed — refresh via T1/T2)`);
  for (const label of uncached) console.log(`${label.padEnd(38)} ${'uncached'.padStart(48)}  (no cache — run T1/T2 first)`);
  console.log('─'.repeat(86));
  if (results.length > 0) {
    const avg = Math.round(results.reduce((sum, r) => sum + r.score, 0) / results.length);
    const cov = Math.round((results.reduce((sum, r) => sum + r.coverage, 0) / results.length) * 100);
    const invalid = results.filter((r) => !r.valid).length;
    const fallbacks = results.reduce((sum, r) => sum + r.fallbacks, 0);
    console.log(`corpus avg: ${avg}  ·  coverage: ${cov}%  ·  fixtures: ${results.length}  ·  invalid: ${invalid}  ·  fallbacks: ${fallbacks}`);
    // Per-producer rollup — the bar is every producer clearing the target, not just the
    // aggregate. A producer below while the corpus passes means an uneven, overfit win.
    const byProducer = new Map<string, number[]>();
    for (const r of results) {
      const p = r.label.split('/')[0];
      byProducer.set(p, [...(byProducer.get(p) ?? []), r.score]);
    }
    for (const [p, scores] of [...byProducer.entries()].sort()) {
      const pAvg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      console.log(`  ${p.padEnd(22)} avg ${String(pAvg).padStart(3)}  (${scores.length} layouts)`);
    }
  }
  if (stale.length || uncached.length) {
    console.log(`skipped: ${stale.length} stale, ${uncached.length} uncached (loud, never scored 0).`);
  }
}

function fmtPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

interface FixtureTiming {
  label: string;
  proposeMs: number;
  realizeMs: number;
}

const TIMINGS_PATH = path.join(EVAL_DIR, 'timings.jsonl');

// Speed readout. The model call (propose) is ~all the wall-clock; realize (assemble + gate)
// is milliseconds. Surfacing the serial total alongside the slowest single call shows the
// floor a parallelized run could reach — the target for a future speed goal (md/13: T2 is
// batchable). On a pure T0 replay there is no propose, so only realize is reported.
function printTiming(timings: FixtureTiming[]): void {
  if (timings.length === 0) return;
  const live = timings.filter((t) => t.proposeMs > 0);
  const realizeTotal = timings.reduce((sum, t) => sum + t.realizeMs, 0);
  if (live.length === 0) {
    console.log(`\ntiming: replay only (no model calls) · assemble+gate ${(realizeTotal / 1000).toFixed(2)}s total · ${Math.round(realizeTotal / timings.length)}ms/fixture`);
    return;
  }
  const sorted = live.map((t) => t.proposeMs).sort((a, b) => a - b);
  const proposeTotal = sorted.reduce((sum, ms) => sum + ms, 0);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = sorted[sorted.length - 1];
  console.log(
    `\ntiming: model calls ${(proposeTotal / 1000).toFixed(1)}s total serial · median ${(median / 1000).toFixed(1)}s · ` +
      `slowest ${(slowest / 1000).toFixed(1)}s ≈ parallel floor · assemble+gate ${(realizeTotal / 1000).toFixed(2)}s total`,
  );
}

// Append a timing record on full (T2) runs so speed trends over time, the way results.jsonl
// trends scores. Committed history — the baseline a speed goal measures against.
function recordTimings(engineLabel: string, model: string, effort: string, hash: string, timings: FixtureTiming[]): void {
  const live = timings.filter((t) => t.proposeMs > 0);
  if (live.length === 0) return; // a replayed T2 has no model timing worth trending
  const propose = live.map((t) => t.proposeMs).sort((a, b) => a - b);
  const record = {
    runAt: new Date().toISOString(),
    engine: engineLabel,
    model,
    effort,
    suiteHash: hash,
    fixtures: live.length,
    proposeMsTotal: propose.reduce((sum, ms) => sum + ms, 0),
    proposeMsMedian: propose[Math.floor(propose.length / 2)],
    proposeMsSlowest: propose[propose.length - 1],
    realizeMsTotal: timings.reduce((sum, t) => sum + t.realizeMs, 0),
    perFixture: Object.fromEntries(timings.map((t) => [t.label, { proposeMs: t.proposeMs, realizeMs: t.realizeMs }])),
  };
  appendFileSync(TIMINGS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  console.log(`recorded timings → ${TIMINGS_PATH}`);
}

async function main(): Promise<void> {
  const tierName = tier();
  const refresh = has('--refresh');
  const engine = await loadEngine();
  const specs = loadSpecs();
  if (specs.size === 0) {
    console.log('No specs found under benchmarks/specs/.');
    return;
  }
  const hash = suiteHash(specs);
  const all = allFixtures(specs);
  if (all.length === 0) {
    console.log('No producer inputs found under benchmarks/producers/.');
    return;
  }

  console.log(`tuner — tier ${tierName} · engine ${engine.label}${engine.split ? ' (split)' : ''} · model ${modelLabel()}/${effortLabel()} · suite ${hash}`);

  const { fixtures, smokeReasons } = scopeFixtures(tierName, engine, all);
  if (smokeReasons.length > 0) printSmokeReasons(smokeReasons);

  const results: Result[] = [];
  const stale: string[] = [];
  const uncached: string[] = [];
  const timings: FixtureTiming[] = [];
  for (const f of fixtures) {
    const run = await runFixture(engine, f, tierName, refresh);
    if (run.state === 'scored' && run.result) {
      results.push(run.result);
      if (run.timing) timings.push({ label: `${f.producer}/${f.layout}`, ...run.timing });
    } else if (run.state === 'stale') stale.push(`${f.producer}/${f.layout}`);
    else uncached.push(`${f.producer}/${f.layout}`);
  }

  printScorecard(results, stale, uncached);
  printTiming(timings);
  if (tierName === 't2') recordTimings(engine.label, modelLabel(), effortLabel(), hash, timings);

  // Honest attribution — per-class deltas, overfit detection, miss aggregation.
  const attr = attribute(results, hash, engine.label, modelLabel());
  printAttribution(attr);

  // Regression ratchet — nothing degrades in silence.
  const baseline = readBaseline(engine.label, modelLabel());
  const regressions = detectRegressions(results, baseline);
  printRatchet(regressions, baseline);

  if (has('--capture') && regressions.length > 0) {
    const written = captureRegressions(regressions, results, engine.label, modelLabel());
    console.log(`\ncaptured ${written.length} regression${written.length === 1 ? '' : 's'} → benchmarks/regressions/`);
  }

  if (has('--baseline-update')) {
    const updated = updateBaseline(results, engine.label, modelLabel(), hash);
    console.log(`\nbaseline updated → benchmarks/baselines/ (${Object.keys(updated.fixtures).length} fixtures, best-ever)`);
  }

  // The ratchet gate: a run that regressed a fixture below baseline exits non-zero, unless
  // this run is the deliberate baseline-update that accepts the new numbers.
  if (regressions.length > 0 && !has('--baseline-update')) {
    console.log(`\n✗ ${regressions.length} fixture(s) below baseline — failing (use --baseline-update to accept, --capture to inspect).`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
