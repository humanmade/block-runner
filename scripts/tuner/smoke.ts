/**
 * Auto-selected smoke set — the T1 sample that always probes where the action is.
 *
 * Not a frozen hand-list that goes stale (md/13). It is a committed seed of archetype
 * probes (smoke.seed.json) that span the known failure modes, plus auto-augmentation
 * from results.jsonl history: the fixtures with the highest score variance across recent
 * runs, and any that most recently regressed, with a guarantee of ≥1 fixture per producer.
 *
 * Selection is explainable, never magic: every fixture carries the reason it was picked.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EVAL_DIR, RESULTS_PATH } from './score.js';

const SEED_PATH = path.join(EVAL_DIR, 'smoke.seed.json');

// How many recent recorded runs feed the variance / regression signals.
const HISTORY_WINDOW = 5;

export interface SmokePick {
  label: string;
  reason: string;
}

interface SeedFile {
  fixtures: { label: string; reason: string }[];
}

interface RunRecord {
  fixtures: Record<string, number>;
  producers?: Record<string, number>;
}

function producerOf(label: string): string {
  return label.split('/')[0];
}

function loadSeed(): SmokePick[] {
  if (!existsSync(SEED_PATH)) return [];
  try {
    const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SeedFile;
    return (seed.fixtures ?? []).map((f) => ({ label: f.label, reason: `seed: ${f.reason}` }));
  } catch {
    return [];
  }
}

function loadHistory(): RunRecord[] {
  if (!existsSync(RESULTS_PATH)) return [];
  return readFileSync(RESULTS_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunRecord);
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
}

/**
 * Pick the smoke set: seed archetypes first, then augment from history (variance +
 * regression), then guarantee ≥1 fixture per producer present in the suite. `available`
 * is the set of fixtures the current suite actually has (producer/layout labels), so we
 * never select a fixture that no longer exists.
 */
export function selectSmoke(available: Set<string>): SmokePick[] {
  const picks: SmokePick[] = [];
  const chosen = new Set<string>();
  const add = (label: string, reason: string): void => {
    if (chosen.has(label) || !available.has(label)) return;
    chosen.add(label);
    picks.push({ label, reason });
  };

  for (const seed of loadSeed()) add(seed.label, seed.reason);

  const history = loadHistory();
  const recent = history.slice(-HISTORY_WINDOW);

  // Variance: fixtures that swing the most across recent runs are where a change is
  // most likely to show — and most likely to be noise, so worth a fresh live read.
  const series = new Map<string, number[]>();
  for (const run of recent) {
    for (const [label, score] of Object.entries(run.fixtures ?? {})) {
      series.set(label, [...(series.get(label) ?? []), score]);
    }
  }
  const byVariance = [...series.entries()]
    .map(([label, scores]) => ({ label, v: variance(scores), n: scores.length }))
    .filter((e) => e.v > 0 && e.n >= 2)
    .sort((a, b) => b.v - a.v);
  for (const e of byVariance.slice(0, 4)) {
    add(e.label, `auto: variance ${Math.round(e.v)} over last ${e.n} runs`);
  }

  // Regression: fixtures that dropped in the most recent recorded run vs the one before.
  if (recent.length >= 2) {
    const last = recent[recent.length - 1].fixtures ?? {};
    const prev = recent[recent.length - 2].fixtures ?? {};
    const regressed = Object.entries(last)
      .map(([label, score]) => ({ label, delta: score - (prev[label] ?? score) }))
      .filter((e) => e.delta < 0)
      .sort((a, b) => a.delta - b.delta);
    for (const e of regressed.slice(0, 3)) {
      add(e.label, `auto: regressed ${e.delta} last run`);
    }
  }

  // Guarantee ≥1 fixture per producer in the current suite — so no producer can drift
  // unwatched. Pick that producer's most-variant fixture if we have history, else its
  // first available fixture.
  const producers = [...new Set([...available].map(producerOf))].sort();
  for (const producer of producers) {
    if (picks.some((p) => producerOf(p.label) === producer)) continue;
    const candidate =
      byVariance.find((e) => producerOf(e.label) === producer && available.has(e.label))?.label ??
      [...available].filter((l) => producerOf(l) === producer).sort()[0];
    if (candidate) add(candidate, `auto: per-producer guarantee (${producer})`);
  }

  return picks;
}

export function printSmokeReasons(picks: SmokePick[]): void {
  console.log(`\nsmoke set — ${picks.length} fixture${picks.length === 1 ? '' : 's'} (why each was selected):`);
  for (const p of picks) console.log(`  • ${p.label.padEnd(28)} ${p.reason}`);
}
