import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureVisualGoldenPath } from '../scripts/build-pattern-overrides-fixture.js';

describe('reviewed platform visual baselines', () => {
  const review = JSON.parse(readFileSync(new URL('../proof/reviews/0.9-testing/visual-baselines.json', import.meta.url), 'utf8')) as {
    threshold: number;
    masks: string[];
    baselines: Array<{ platform: string; path: string; sha256: string }>;
  };

  it.each(review.baselines)('binds the $platform baseline to its reviewed bytes', (baseline) => {
    const file = fixtureVisualGoldenPath(baseline.platform);
    expect(file.endsWith(baseline.path.split('/').join(path.sep))).toBe(true);
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(baseline.sha256);
    expect(review.threshold).toBe(0);
    expect(review.masks).toEqual([]);
  });

  it('does not silently reuse a reviewed image for an unreviewed platform', () => {
    const file = fixtureVisualGoldenPath('unreviewed');
    expect(existsSync(file)).toBe(false);
    expect(file).toContain('.unreviewed.expected.png');
  });
});
