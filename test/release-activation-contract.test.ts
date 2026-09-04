import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../scripts/release-check.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function validateGeneratedPluginActivation(');
const end = source.indexOf('\nfunction ', start + 1);
const validate = runInNewContext(`(${source.slice(start, end)})`) as (receipt: unknown, hash: string) => unknown;
const hash = `sha256:${'a'.repeat(64)}`;
const required = ['zip_installation', 'plugin_activation', 'php_registry', 'rest_block_type',
  'client_registry', 'editor_inserter', 'php_logs', 'environment_observation'];
const receipt = () => ({
  environment: { plugin: { zip: { sha256: hash } }, wordpress: { version: '7.1' } },
  gates: required.map((gate) => ({ gate, status: 'pass', details: { block: 'block-runner/pattern-overrides-fixture' } })),
});

describe('release ZIP activation claim', () => {
  it.each(['7.1', '7.1.1'])('accepts actual WordPress %s only with all activation evidence', (version) => {
    const input = receipt();
    input.environment.wordpress.version = version;
    expect(validate(input, hash)).toEqual(input.environment);
    expect(() => validate(input, `sha256:${'b'.repeat(64)}`)).toThrow();
  });

  it.each(['7.0', '7.10', '7.1-beta1', '7x1'])('rejects a different runtime %s', (version) => {
    const input = receipt();
    input.environment.wordpress.version = version;
    expect(() => validate(input, hash)).toThrow();
  });

  it('rejects missing, duplicate, failed, or wrong-block registration evidence', () => {
    const missing = receipt(); missing.gates.pop();
    expect(() => validate(missing, hash)).toThrow();
    const duplicate = receipt(); duplicate.gates.push(duplicate.gates[0]!);
    expect(() => validate(duplicate, hash)).toThrow();
    const failed = receipt(); failed.gates[0]!.status = 'fail';
    expect(() => validate(failed, hash)).toThrow();
    const wrongBlock = receipt(); wrongBlock.gates.find(({ gate }) => gate === 'client_registry')!.details.block = 'other/block';
    expect(() => validate(wrongBlock, hash)).toThrow();
  });

  it('does not turn full-profile limitations into activation evidence or mutate them', () => {
    const input = receipt();
    input.gates.push({ gate: 'visual_regression', status: 'blocked', details: { block: '' } });
    expect(validate(input, hash)).toEqual(input.environment);
    expect(input.gates.at(-1)?.status).toBe('blocked');
  });
});

describe('release benchmark boundary', () => {
  it('keeps the 13-fixture authoring benchmark optional and explicitly unscored', () => {
    const matrix = JSON.parse(readFileSync(new URL('../release/0.9-testing/matrix.json', import.meta.url), 'utf8')) as {
      rows: Array<{ id: string; required?: boolean; optional?: boolean }>;
      releaseRule: { optionalRowsDoNotBlockRelease?: boolean };
    };
    const authoringRows = matrix.rows.filter(({ id }) => id === 'authoring-wordpress-71-proof' || id === 'unsupported-interaction-fails-closed');
    expect(authoringRows).toHaveLength(2);
    expect(authoringRows.every((row) => row.required === false && row.optional === true)).toBe(true);
    expect(matrix.releaseRule.optionalRowsDoNotBlockRelease).toBe(true);
    expect(source).toContain('benchmarkReadiness');
    expect(source).toContain('optional benchmark must remain unscored and non-blocking');
  });
});

describe('release manual review binding', () => {
  const reviewStart = source.indexOf('function validateManualReviewBinding(');
  const reviewEnd = source.indexOf('\nfunction ', reviewStart + 1);
  const bind = runInNewContext(`(${source.slice(reviewStart, reviewEnd)})`) as
    (review: unknown, inputHash: string, zipHash: string) => void;

  it('accepts only the exact generated input and ZIP', () => {
    expect(() => bind({ inputHash: hash, pluginZipHash: hash }, hash, hash)).not.toThrow();
    expect(() => bind({ inputHash: 'stale', pluginZipHash: hash }, hash, hash)).toThrow('different');
    expect(() => bind({ inputHash: hash, pluginZipHash: 'stale' }, hash, hash)).toThrow('different');
    expect(() => bind(null, hash, hash)).toThrow('different');
    expect(source).toContain("valueFor('--manual-review')");
    expect(source).toContain('manualReviewPath: reviewPath');
  });
});

describe('release native control retention', () => {
  it('requires both native controls even when generated editor findings are clean', () => {
    const begin = source.indexOf('function recordNativeControlRequirement(');
    const finish = source.indexOf('\nfunction ', begin + 1);
    const rows: Array<{ status: string }> = [];
    const record = runInNewContext(`(${source.slice(begin, finish)})`, {
      rows, blockedRow: () => rows.push({ status: 'blocked' }), retainLogs: () => ({}),
    }) as (acceptance: unknown) => void;
    const evidence = { wordpressVersion: '7.1', evidence: { path: 'control.json', sha256: hash } };
    record({ releaseOk: true });
    record({ nativeHeadingControlEvidence: evidence });
    record({ nativeHeadingControlEvidence: evidence,
      nativeParagraphControlEvidence: { ...evidence, wordpressVersion: '7.1.1' } });
    record({ nativeHeadingControlEvidence: evidence, nativeParagraphControlEvidence: evidence });
    expect(rows.map(({ status }) => status)).toEqual(['blocked', 'blocked', 'blocked', 'passed']);
    expect(source).toContain('recordNativeControlRequirement(acceptance);');
  });
  const helperStart = source.indexOf('function retainNativeControlEvidence(');
  const helperEnd = source.indexOf('\nfunction ', helperStart + 1);
  it.each(['heading', 'paragraph'])('retains separate hash-verified %s evidence', (kind) => {
    const prefix = `BLOCK_RUNNER_NATIVE_${kind.toUpperCase()}_CONTROL_`;
    const env: Record<string, string> = { [`${prefix}EVIDENCE_PATH`]: '/control.json', [`${prefix}EVIDENCE_SHA256`]: hash, [`${prefix}WORDPRESS_VERSION`]: '7.1' };
    let copied = '';
    const retain = runInNewContext(`(${source.slice(helperStart, helperEnd)})`, {
      process: { env }, path, existsSync: () => true, hashFile: () => hash,
      evidenceDirectory: '/release', mkdirSync: () => {},
      copyFileSync: (_source: string, destination: string) => { copied = destination; },
      relativeArtifact: (file: string) => path.relative('/release', file),
    }) as (kind: string, load: (evidence: unknown) => unknown) => { evidence: { path: string } };
    expect(retain(kind, (evidence) => evidence).evidence.path).toBe(`control/native-${kind}-control.json`);
    expect(copied).toBe(`/release/control/native-${kind}-control.json`);
    env[`${prefix}EVIDENCE_SHA256`] = 'mismatch';
    expect(() => retain(kind, (evidence) => evidence)).toThrow('hash mismatch');
  });
});

describe('release installed skill verification', () => {
  it('keeps package-install logs distinct for the two installer consumers', () => {
    expect(source).toContain("installPackedCandidate(candidate, 'project-skill-package-install')");
    expect(source).toContain("installPackedCandidate(candidate, 'user-skill-package-install')");
    expect(source).toContain("const row = runRow(rowId, 'npm'");
  });
  const helperStart = source.indexOf('function validateInstalledSkill(');
  const helperEnd = source.indexOf('\nfunction ', helperStart + 1);
  const digest = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  function fixture() {
    const original = 'npx block-runner@latest assemble; npx block-runner@latest skill';
    const installed = 'npx block-runner@0.9.0 assemble; npx block-runner@latest skill';
    const files: Record<string, string> = {
      '/pkg/package.json': JSON.stringify({ version: '0.9.0' }),
      '/pkg/skills/block-runner/SKILL.md': original,
      '/installed/SKILL.md': installed,
      '/installed/.block-runner-install.json': JSON.stringify({ packageVersion: '0.9.0', files: { 'SKILL.md': { sha256: digest(installed) } } }),
    };
    const validate = runInNewContext(`(${source.slice(helperStart, helperEnd)})`, {
      path, hash: digest,
      readFileSync: (file: string, encoding?: string) => {
        if (!(file in files)) throw new Error('missing file');
        return encoding ? files[file] : Buffer.from(files[file]!);
      },
      hashFile: (file: string) => digest(files[file]!),
      filesBelow: () => ['/pkg/skills/block-runner/SKILL.md'],
    }) as (destination: string, bundle: string) => void;
    return { files, run: () => validate('/installed', '/pkg/skills/block-runner') };
  }
  it('checks the version-pinned bytes while preserving the installer update command', () => {
    expect(fixture().run).not.toThrow();
  });
  it('rejects changed installed bytes and incomplete manifests', () => {
    const modified = fixture(); modified.files['/installed/SKILL.md'] = 'changed';
    expect(modified.run).toThrow('hash mismatch');
    const missing = fixture(); missing.files['/installed/.block-runner-install.json'] = JSON.stringify({ packageVersion: '0.9.0', files: {} });
    expect(missing.run).toThrow('packed bundle');
  });
});
