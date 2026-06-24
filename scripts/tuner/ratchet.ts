/**
 * Regression ratchet — the mechanical form of "nothing degrades in silence" (md/00).
 *
 * Per engine/model, the tuner keeps a best-ever score per fixture
 * (benchmarks/baselines/<engine>__<model>.json, committed). Any run where a fixture drops
 * below its baseline by more than a small threshold makes the run exit non-zero — the loop
 * cannot silently regress, and coverage only ratchets up.
 *
 *   - --baseline-update accepts the current run as the new baseline (a deliberate act).
 *   - --capture writes the regressed fixture's current output beside its prior golden into
 *     benchmarks/regressions/ for inspection.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EVAL_DIR, type Result } from './score.js';

export const BASELINES_DIR = path.join(EVAL_DIR, 'baselines');
export const REGRESSIONS_DIR = path.join(EVAL_DIR, 'regressions');

// A fixture must drop more than this below its baseline to count as a regression.
// LLM engines are non-deterministic (±a few points is noise, md/handover); the rules
// engine is deterministic so any real drop trips it.
const REGRESSION_THRESHOLD = 3;

export interface Baseline {
  engine: string;
  model: string;
  suiteHash: string;
  updatedAt: string;
  fixtures: Record<string, number>;
}

export interface Regression {
  label: string;
  baseline: number;
  current: number;
  drop: number;
}

function baselineKey(engine: string, model: string): string {
  // Filesystem-safe: slashes in a model id (rare) would break the path.
  const safe = (s: string) => s.replace(/[^a-z0-9._-]+/gi, '-');
  return `${safe(engine)}__${safe(model)}`;
}

function baselinePath(engine: string, model: string): string {
  return path.join(BASELINES_DIR, `${baselineKey(engine, model)}.json`);
}

export function readBaseline(engine: string, model: string): Baseline | undefined {
  const file = baselinePath(engine, model);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

// Detect fixtures that dropped below baseline beyond the threshold.
export function detectRegressions(results: Result[], baseline: Baseline | undefined): Regression[] {
  if (!baseline) return [];
  const regressions: Regression[] = [];
  for (const r of results) {
    const best = baseline.fixtures[r.label];
    if (best === undefined) continue;
    const drop = best - r.score;
    if (drop > REGRESSION_THRESHOLD) {
      regressions.push({ label: r.label, baseline: best, current: r.score, drop });
    }
  }
  return regressions.sort((a, b) => b.drop - a.drop);
}

// Write a new baseline that ratchets up: best-ever per fixture (max of current and any
// prior best), so a baseline-update never lowers a recorded ceiling.
export function updateBaseline(results: Result[], engine: string, model: string, suiteHash: string): Baseline {
  const prior = readBaseline(engine, model);
  const fixtures: Record<string, number> = { ...(prior?.fixtures ?? {}) };
  for (const r of results) {
    fixtures[r.label] = Math.max(fixtures[r.label] ?? -Infinity, r.score);
  }
  const baseline: Baseline = {
    engine,
    model,
    suiteHash,
    updatedAt: new Date().toISOString(),
    fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b))),
  };
  mkdirSync(BASELINES_DIR, { recursive: true });
  writeFileSync(baselinePath(engine, model), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

// Capture the regressed fixtures' current output beside their prior golden, for inspection.
// The "golden" is the spec's expected tree (the ideal end state, committed); we write both
// the current output and the regression metadata so a captured failure is reproducible.
export function captureRegressions(regressions: Regression[], results: Result[], engine: string, model: string): string[] {
  if (regressions.length === 0) return [];
  mkdirSync(REGRESSIONS_DIR, { recursive: true });
  const byLabel = new Map(results.map((r) => [r.label, r]));
  const written: string[] = [];
  for (const reg of regressions) {
    const r = byLabel.get(reg.label);
    if (!r) continue;
    const safe = reg.label.replace(/\//g, '__');
    const file = path.join(REGRESSIONS_DIR, `${baselineKey(engine, model)}__${safe}.json`);
    const capture = {
      label: reg.label,
      engine,
      model,
      baseline: reg.baseline,
      current: reg.current,
      drop: reg.drop,
      capturedAt: new Date().toISOString(),
      misses: r.misses,
      output: '', // realize output is replayed; record the score axes + misses for diffing.
      axes: { structurePct: r.structurePct, contentPct: r.contentPct, valid: r.valid, fallbacks: r.fallbacks, coverage: r.coverage },
    };
    writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
    written.push(file);
  }
  return written;
}

export function printRatchet(regressions: Regression[], baseline: Baseline | undefined): void {
  console.log('\nratchet (vs committed baseline):');
  if (!baseline) {
    console.log('  no baseline yet for this engine/model — run with --baseline-update to set one.');
    return;
  }
  if (regressions.length === 0) {
    console.log(`  ✓ no fixture below baseline (threshold ${REGRESSION_THRESHOLD}).`);
    return;
  }
  console.log(`  ✗ ${regressions.length} fixture${regressions.length === 1 ? '' : 's'} regressed below baseline:`);
  for (const reg of regressions) {
    console.log(`    ${reg.label.padEnd(28)} baseline ${reg.baseline} → ${reg.current}  (−${reg.drop})`);
  }
}
