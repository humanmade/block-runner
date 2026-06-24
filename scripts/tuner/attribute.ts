/**
 * Honest attribution — the mechanic that kills single-cell overfits.
 *
 * Every run diffs against the previous *comparable* run (same suiteHash + engine + model)
 * and reports per-fixture deltas grouped by class — producer and layout — not just a corpus
 * number (md/13). It then classifies the change:
 *
 *   - class-move (the win we want): moved ≥k fixtures across ≥2 producers in the same
 *     direction → a generalization.
 *   - single-cell (the trap): moved exactly one fixture → flagged `⚠ overfit suspect`,
 *     because tuning to one producer/model is the cardinal sin (md/11).
 *
 * It also aggregates the per-fixture misses by expected block, so the next fix is chosen by
 * which *class* it unlocks, not which single row annoys you. No engine/producer special-casing:
 * the classes are derived from the labels, never named.
 */
import { readFileSync, existsSync } from 'node:fs';
import { RESULTS_PATH, type Result } from './score.js';

// A move counts as a "class-move" when it shifts at least this many fixtures, the same
// direction, across at least 2 producers. One fixture is always a single-cell.
const CLASS_MOVE_MIN_FIXTURES = 2;
const CLASS_MOVE_MIN_PRODUCERS = 2;
const THRESHOLD = 1; // ignore ±0 jitter

interface RunRecord {
  engine: string;
  model: string;
  suiteHash: string;
  fixtures: Record<string, number>;
}

interface FixtureDelta {
  label: string;
  producer: string;
  layout: string;
  before: number;
  after: number;
  delta: number;
}

export interface Attribution {
  comparable: boolean;
  deltas: FixtureDelta[];
  classification: 'class-move' | 'single-cell' | 'flat' | 'no-baseline';
  overfitSuspect: boolean;
  missesByBlock: { block: string; count: number; producers: string[] }[];
  byProducer: { producer: string; delta: number }[];
  byLayout: { layout: string; delta: number }[];
}

function producerOf(label: string): string {
  return label.split('/')[0];
}
function layoutOf(label: string): string {
  return label.split('/').slice(1).join('/');
}

function loadHistory(): RunRecord[] {
  if (!existsSync(RESULTS_PATH)) return [];
  return readFileSync(RESULTS_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunRecord);
}

// The previous comparable run: same suiteHash + engine + model. Holding the suite + axis
// constant is what makes a score delta attributable to the converter (the suiteHash
// discipline from bench.ts, applied to attribution).
function previousComparable(suiteHash: string, engine: string, model: string): RunRecord | undefined {
  const matches = loadHistory().filter(
    (r) => r.suiteHash === suiteHash && r.engine === engine && r.model === model,
  );
  return matches[matches.length - 1];
}

// Aggregate raw miss strings ("expected core/media-text (…) — not found") by the
// expected block, across producers — so a fix is chosen by the class it unlocks.
function aggregateMisses(results: Result[]): { block: string; count: number; producers: string[] }[] {
  const byBlock = new Map<string, Set<string>>();
  const counts = new Map<string, number>();
  for (const r of results) {
    for (const miss of r.misses) {
      const m = miss.match(/expected (core\/[a-z-]+|[a-z0-9-]+\/[a-z0-9-]+)/i);
      if (!m) continue;
      const block = m[1];
      counts.set(block, (counts.get(block) ?? 0) + 1);
      byBlock.set(block, (byBlock.get(block) ?? new Set()).add(r.producer));
    }
  }
  return [...counts.entries()]
    .map(([block, count]) => ({ block, count, producers: [...(byBlock.get(block) ?? [])].sort() }))
    .sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));
}

export function attribute(
  results: Result[],
  suiteHash: string,
  engine: string,
  model: string,
): Attribution {
  const missesByBlock = aggregateMisses(results);
  const prev = previousComparable(suiteHash, engine, model);

  if (!prev) {
    return {
      comparable: false,
      deltas: [],
      classification: 'no-baseline',
      overfitSuspect: false,
      missesByBlock,
      byProducer: [],
      byLayout: [],
    };
  }

  const deltas: FixtureDelta[] = [];
  for (const r of results) {
    const before = prev.fixtures[r.label];
    if (before === undefined) continue;
    const delta = r.score - before;
    if (Math.abs(delta) < THRESHOLD) continue;
    deltas.push({ label: r.label, producer: r.producer, layout: r.layout, before, after: r.score, delta });
  }

  const moved = deltas.filter((d) => d.delta !== 0);
  const producersMoved = new Set(moved.map((d) => d.producer));
  // A class-move is consistent direction across ≥2 producers and ≥2 fixtures.
  const allUp = moved.every((d) => d.delta > 0);
  const allDown = moved.every((d) => d.delta < 0);
  const consistent = moved.length > 0 && (allUp || allDown);

  let classification: Attribution['classification'];
  let overfitSuspect = false;
  if (moved.length === 0) {
    classification = 'flat';
  } else if (moved.length === 1) {
    classification = 'single-cell';
    overfitSuspect = true;
  } else if (
    consistent &&
    moved.length >= CLASS_MOVE_MIN_FIXTURES &&
    producersMoved.size >= CLASS_MOVE_MIN_PRODUCERS
  ) {
    classification = 'class-move';
  } else {
    // Multiple fixtures moved but they're confined to one producer (or mixed direction):
    // not a generalization, treat as overfit-suspect so a single-producer win isn't celebrated.
    classification = 'single-cell';
    overfitSuspect = producersMoved.size < CLASS_MOVE_MIN_PRODUCERS;
  }

  const sumBy = (key: (d: FixtureDelta) => string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const d of deltas) m.set(key(d), (m.get(key(d)) ?? 0) + d.delta);
    return m;
  };
  const byProducer = [...sumBy((d) => d.producer).entries()]
    .map(([producer, delta]) => ({ producer, delta }))
    .sort((a, b) => a.producer.localeCompare(b.producer));
  const byLayout = [...sumBy((d) => d.layout).entries()]
    .map(([layout, delta]) => ({ layout, delta }))
    .sort((a, b) => a.layout.localeCompare(b.layout));

  return { comparable: true, deltas, classification, overfitSuspect, missesByBlock, byProducer, byLayout };
}

function fmtDelta(d: number): string {
  return d > 0 ? `+${d}` : `${d}`;
}

export function printAttribution(attr: Attribution): void {
  console.log('\nattribution (vs previous comparable run):');
  if (!attr.comparable) {
    console.log('  no comparable prior run (same suiteHash + engine + model) — nothing to diff against yet.');
  } else if (attr.deltas.length === 0) {
    console.log('  flat — no fixture moved beyond jitter.');
  } else {
    for (const d of attr.deltas.sort((a, b) => a.label.localeCompare(b.label))) {
      console.log(`  ${d.label.padEnd(28)} ${String(d.before).padStart(3)} → ${String(d.after).padStart(3)}  (${fmtDelta(d.delta)})`);
    }
    console.log('  ── by producer:  ' + attr.byProducer.map((p) => `${p.producer} ${fmtDelta(p.delta)}`).join('  ·  '));
    console.log('  ── by layout:    ' + attr.byLayout.map((l) => `${l.layout} ${fmtDelta(l.delta)}`).join('  ·  '));
    const tag =
      attr.classification === 'class-move'
        ? 'class-move — moved a class across ≥2 producers (the win we want)'
        : attr.classification === 'single-cell'
          ? '⚠ overfit suspect — moved one cell (or one producer); a change should move a class (md/11)'
          : attr.classification;
    console.log(`  ── verdict: ${tag}`);
  }

  if (attr.missesByBlock.length > 0) {
    console.log('\n  misses by expected block (pick the fix that unlocks a class):');
    for (const m of attr.missesByBlock.slice(0, 8)) {
      console.log(`    ${m.block.padEnd(22)} ${String(m.count).padStart(3)} miss${m.count === 1 ? '' : 'es'} across ${m.producers.length} producer${m.producers.length === 1 ? '' : 's'} (${m.producers.join(', ')})`);
    }
  }
}
