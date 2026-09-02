/**
 * Regression ratchet — the mechanical form of "nothing degrades in silence" (md/00).
 *
 * Per engine/model/effort, the tuner keeps a best-ever score per fixture
 * (benchmarks/baselines/<engine>__<model>__<effort>.json, committed). Any run where a fixture drops
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
  /**
   * Reasoning effort is part of a baseline's identity, not a label. The same model at low and
   * high effort is two different measurements; keying only on engine+model let one silently
   * overwrite and be compared against the other — the same trap as a bare model alias.
   */
  effort: string;
  suiteHash: string;
  scorerHash?: string;
  gutenbergVersion?: string;
  updatedAt: string;
  fixtures: Record<string, number>;
}

export type BaselineStatus =
  | { kind: 'none' }
  | { kind: 'suite-mismatch'; baselineSuiteHash: string; currentSuiteHash: string }
  | { kind: 'scorer-mismatch'; baselineScorerHash?: string; currentScorerHash: string }
  | { kind: 'gutenberg-mismatch'; baselineVersion?: string; currentVersion: string }
  | { kind: 'comparable' };

export interface Regression {
  label: string;
  baseline: number;
  current: number;
  drop: number;
}

function baselineKey(engine: string, model: string, effort: string): string {
  // Filesystem-safe: slashes in a model id (rare) would break the path.
  const safe = (s: string) => s.replace(/[^a-z0-9._-]+/gi, '-');
  return `${safe(engine)}__${safe(model)}__${safe(effort)}`;
}

function baselinePath(engine: string, model: string, effort: string): string {
  return path.join(BASELINES_DIR, `${baselineKey(engine, model, effort)}.json`);
}

export function readBaseline(engine: string, model: string, effort: string): Baseline | undefined {
  const file = baselinePath(engine, model, effort);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

export function baselineStatus(
  baseline: Baseline | undefined,
  currentSuiteHash: string,
  currentScorerHash: string,
  currentGutenbergVersion: string,
): BaselineStatus {
  if (!baseline) return { kind: 'none' };
  if (baseline.suiteHash !== currentSuiteHash) {
    return { kind: 'suite-mismatch', baselineSuiteHash: baseline.suiteHash, currentSuiteHash };
  }
  if (baseline.scorerHash !== currentScorerHash) {
    return { kind: 'scorer-mismatch', baselineScorerHash: baseline.scorerHash, currentScorerHash };
  }
  if (baseline.gutenbergVersion !== currentGutenbergVersion) {
    return {
      kind: 'gutenberg-mismatch',
      baselineVersion: baseline.gutenbergVersion,
      currentVersion: currentGutenbergVersion,
    };
  }
  return { kind: 'comparable' };
}

// Detect fixtures that dropped below baseline beyond the threshold.
export function detectRegressions(results: Result[], baseline: Baseline | undefined, status: BaselineStatus): Regression[] {
  if (!baseline || status.kind !== 'comparable') return [];
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
//
// That ceiling is only meaningful WITHIN one suite. When the suite changes, the prior
// scores answered different questions — carrying them forward writes a phantom ceiling
// into a baseline that claims to describe the new suite, which is the very confusion
// the suiteHash guard exists to end. So a suite change starts the baseline from scratch.
export function updateBaseline(
  results: Result[],
  engine: string,
  model: string,
  effort: string,
  suiteHash: string,
  scorerHash: string,
  gutenbergVersion: string,
): Baseline {
  const prior = readBaseline(engine, model, effort);
  const comparablePrior =
    prior?.suiteHash === suiteHash &&
    prior.scorerHash === scorerHash &&
    prior.gutenbergVersion === gutenbergVersion
      ? prior
      : undefined;
  const fixtures: Record<string, number> = { ...(comparablePrior?.fixtures ?? {}) };
  for (const r of results) {
    fixtures[r.label] = Math.max(fixtures[r.label] ?? -Infinity, r.score);
  }
  const baseline: Baseline = {
    engine,
    model,
    effort,
    suiteHash,
    scorerHash,
    gutenbergVersion,
    updatedAt: new Date().toISOString(),
    fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b))),
  };
  mkdirSync(BASELINES_DIR, { recursive: true });
  writeFileSync(baselinePath(engine, model, effort), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return baseline;
}

// Capture the regressed fixtures' current output beside their prior golden, for inspection.
// The "golden" is the spec's expected tree (the ideal end state, committed); we write both
// the current output and the regression metadata so a captured failure is reproducible.
export function captureRegressions(regressions: Regression[], results: Result[], engine: string, model: string, effort: string): string[] {
  if (regressions.length === 0) return [];
  mkdirSync(REGRESSIONS_DIR, { recursive: true });
  const byLabel = new Map(results.map((r) => [r.label, r]));
  const written: string[] = [];
  for (const reg of regressions) {
    const r = byLabel.get(reg.label);
    if (!r) continue;
    const safe = reg.label.replace(/\//g, '__');
    const file = path.join(REGRESSIONS_DIR, `${baselineKey(engine, model, effort)}__${safe}.json`);
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

function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 12);
}

export function printRatchet(regressions: Regression[], baseline: Baseline | undefined, status: BaselineStatus): void {
  console.log('\nratchet (vs committed baseline):');
  if (status.kind === 'none' || !baseline) {
    console.log('  no baseline yet for this engine/model/effort — run with --baseline-update to set one.');
    return;
  }
  if (status.kind === 'suite-mismatch') {
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.log('  BASELINE SUITE MISMATCH — RATCHET SKIPPED');
    console.log('  The baseline was recorded against a DIFFERENT test suite.');
    console.log(`  baseline suite: sha256:${shortHash(status.baselineSuiteHash)}`);
    console.log(`  current suite:  sha256:${shortHash(status.currentSuiteHash)}`);
    console.log('  The comparison is therefore meaningless and the ratchet is SKIPPED.');
    console.log('  Re-record with --baseline-update to establish a baseline for this suite.');
    console.log('  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    return;
  }
  if (status.kind === 'scorer-mismatch') {
    console.log('  scorer changed — ratchet skipped because the scores use different formulas/contracts.');
    console.log(`  baseline scorer: ${status.baselineScorerHash ?? 'unrecorded'}`);
    console.log(`  current scorer:  ${status.currentScorerHash}`);
    return;
  }
  if (status.kind === 'gutenberg-mismatch') {
    console.log('  Gutenberg runtime changed — ratchet skipped because validity was judged by a different block library.');
    console.log(`  baseline runtime: ${status.baselineVersion ?? 'unrecorded'}`);
    console.log(`  current runtime:  ${status.currentVersion}`);
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
