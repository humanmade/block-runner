import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUTHORING_DIMENSIONS,
  AUTHORING_BENCHMARK_CONTRACT,
  authoringHashes,
  loadAuthoringSuite,
  publishedFigureLabel,
  scoreAuthoringFixture,
  summarizeAuthoringScores,
  type AuthoringFixture,
  type AuthoringSuite,
} from '../scripts/authoring/score.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTHORING_ROOT = path.join(ROOT, 'benchmarks', 'authoring');

const allAssertions = Object.fromEntries(AUTHORING_DIMENSIONS.map((dimension) => [dimension, true]));
const evidence = { path: 'receipt-evidence.log', sha256: `sha256:${'0'.repeat(64)}` };
const allPassingChecks = Object.fromEntries(AUTHORING_DIMENSIONS.map((dimension) => [dimension, { pass: true, detail: 'receipt evidence', evidence }]));

function fixture(overrides: Partial<AuthoringFixture> = {}): AuthoringFixture {
  return {
    id: 'hero-native',
    family: 'hero',
    source: { producer: 'producer-a', style: 'semantic-html' },
    assertions: allAssertions,
    candidate: { receipt: 'runs/hero-native/receipt.json' },
    ...overrides,
  };
}

describe('authoring benchmark contract', () => {
  it('loads the independent 13-fixture corpus with its source and plan contracts intact', () => {
    const suite = loadAuthoringSuite(AUTHORING_ROOT);

    expect(suite.fixtures).toHaveLength(13);
    expect(new Set(suite.fixtures.map((item) => item.family))).toEqual(
      new Set([
        'hero',
        'split-feature',
        'cards',
        'repeater',
        'tailwind-responsive-css',
        'pseudo-states',
        'local-assets',
        'pattern-overrides',
        'unsupported-interaction',
      ]),
    );

    for (const fixture of suite.fixtures) {
      expect(fixture.requiredDimensions).toEqual(AUTHORING_DIMENSIONS);
      for (const dimension of AUTHORING_DIMENSIONS) {
        expect(fixture.assertions?.[dimension]).toEqual(expect.objectContaining({ required: expect.any(Boolean) }));
      }
      if (fixture.expectedStatus === 'scored') {
        for (const dimension of AUTHORING_DIMENSIONS) {
          expect(fixture.assertions?.[dimension]).toEqual(expect.objectContaining({ required: true }));
        }
      }
      expect(fixture.source?.path).toEqual(expect.any(String));
      expect(fixture.source?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.plan).toEqual(expect.any(String));
      expect(fixture.prompt).toEqual(expect.any(String));
      expect(fixture.candidate?.requiredFiles).toEqual(expect.arrayContaining([
        'block.json',
        'src/edit.tsx',
        'src/save.tsx',
        'src/style-ledger.json',
        'authoring-plan.json',
      ]));

      const source = path.join(AUTHORING_ROOT, fixture.source!.path!);
      expect(existsSync(source), `${fixture.id} source must exist`).toBe(true);
      expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(fixture.source!.sha256);
      expect(existsSync(path.join(AUTHORING_ROOT, fixture.plan!)), `${fixture.id} plan must exist`).toBe(true);
      expect(existsSync(path.join(AUTHORING_ROOT, fixture.prompt!)), `${fixture.id} prompt must exist`).toBe(true);
    }

    for (const family of ['hero', 'split-feature', 'cards', 'repeater']) {
      const styles = suite.fixtures
        .filter((fixture) => fixture.family === family)
        .map((fixture) => fixture.sourceStyle)
        .sort();
      expect(styles).toEqual(['semantic', 'utility-tailwind']);
    }

    const negative = suite.fixtures.find((fixture) => fixture.id === 'unsupported-interaction');
    expect(negative).toMatchObject({ expectedStatus: 'unsupported' });
    expect(negative?.assertions?.warnings).toEqual(expect.objectContaining({ required: true }));
    expect(readFileSync(path.join(AUTHORING_ROOT, negative!.prompt!), 'utf8')).toContain('BR_UNSUPPORTED_INTERACTION');
  });

  it('keeps plan/source/runtime/fidelity qualities as independent dimensions without a composite score', () => {
    const result = scoreAuthoringFixture(fixture(), { status: 'scored', checks: allPassingChecks });

    expect(result.status).toBe('scored');
    expect(result.contractPass).toBe(true);
    expect(result).not.toHaveProperty('score');
    expect(Object.keys(result.dimensions)).toEqual(AUTHORING_DIMENSIONS);
    expect(result.dimensions.plan.score).toBe(100);
    expect(result.dimensions.source.score).toBe(100);
    expect(result.dimensions.editor.score).toBe(100);
    expect(result.dimensions.fidelity.score).toBe(100);
    expect(result.dimensions.accessibility.score).toBe(100);
  });

  it('does not turn a model or tool error into a zero product score', () => {
    const healthy = scoreAuthoringFixture(fixture(), { status: 'scored', checks: allPassingChecks });
    const errored = scoreAuthoringFixture(fixture({ id: 'split-feature' }), {
      status: 'engine_error',
      error: { kind: 'model', message: 'rate limited' },
    });
    const summary = summarizeAuthoringScores([healthy, errored]);

    expect(errored.validMeasurement).toBe(false);
    expect(errored.dimensions.plan.score).toBeNull();
    expect(summary.invalidMeasurements).toBe(1);
    expect(summary).not.toHaveProperty('productAverage');
  });

  it('does not accept bare booleans as browser/editor receipt evidence', () => {
    const result = scoreAuthoringFixture(fixture(), {
      status: 'scored',
      checks: Object.fromEntries(AUTHORING_DIMENSIONS.map((dimension) => [dimension, true])),
    });

    expect(result.contractPass).toBe(false);
    expect(result.failures).toContain('editor: receipt check has no retained evidence');
  });

  it('makes expected-negative interaction fixtures fail closed', () => {
    const negative = fixture({
      id: 'unsupported-interaction',
      family: 'unsupported-interaction',
      assertions: { warnings: true },
      disposition: { kind: 'expected-negative', expectedStatus: 'unsupported' },
    });

    const bare = scoreAuthoringFixture(negative, { status: 'unsupported' });
    const closed = scoreAuthoringFixture(negative, {
      status: 'unsupported',
      checks: { warnings: { pass: true, evidence } },
      failClosed: { warningCode: undefined, noInteractiveRuntime: true, evidence },
    });
    const open = scoreAuthoringFixture(negative, { status: 'scored', checks: { warnings: true } });

    expect(bare.contractPass).toBe(false);
    expect(closed.contractPass).toBe(true);
    expect(open.contractPass).toBe(false);
    expect(open.failures).toContain('expected status unsupported, received scored');
  });

  it('records independent provenance hashes and figure labels', () => {
    const suite: AuthoringSuite = {
      contract: AUTHORING_BENCHMARK_CONTRACT,
      fixtures: [fixture()],
      prompt: 'author a hero',
      guide: 'native blocks only',
      template: 'plugin template',
      dependency: { blockLibrary: '10.5.0' },
      wordpress: '7.1',
      theme: 'twentytwentysix',
      browser: 'chromium 140',
    };
    const hashes = authoringHashes(suite);

    expect(Object.values(hashes)).toHaveLength(15);
    expect(hashes.promptHash).not.toBe(hashes.guideHash);
    expect(hashes.wordpressHash).not.toBe(hashes.browserHash);
    expect(
      publishedFigureLabel({
        summary: summarizeAuthoringScores([]),
        metadata: { workload: 'release fixtures', model: 'gpt-test', effort: 'low', timingMethod: 'wall clock' },
      }),
    ).toBe('workload=release fixtures; suite_size=0; model=gpt-test; effort=low; invalid=0; timing=wall clock');
  });
});
