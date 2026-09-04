import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectAuthoringDestination, writeAuthoringOutput } from '../src/authoring/destination.js';
import { validateAuthoringPlan } from '../src/authoring/schema.js';

function plan(files: unknown[]) {
  return validateAuthoringPlan({
    version: 1,
    generatorVersion: '0.9.0-preview.1',
    target: { name: 'example/notice', title: 'Notice' },
    structure: [],
    fields: [],
    locking: { mode: 'none' },
    styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: false, overrides: [] },
    assets: [],
    files,
    warnings: [],
  });
}

describe('authoring destination', () => {
  it('fingerprints a destination without creating it', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const destination = path.join(parent, 'does-not-exist');
    const inspection = await inspectAuthoringDestination(destination, plan([{ path: 'block.json' }]));

    expect(inspection.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a collision without changing the existing file', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const existing = path.join(destination, 'block.json');
    await writeFile(existing, 'original\n');

    await expect(writeAuthoringOutput(destination, plan([{ path: 'block.json', content: 'new\n' }]))).rejects.toThrow(/already exists/);
    expect(await readFile(existing, 'utf8')).toBe('original\n');
  });

  it('requires an explicit hash-bound replacement operation and publishes supplied content', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const existing = path.join(destination, 'block.json');
    await writeFile(existing, 'original\n');

    const result = await writeAuthoringOutput(
      destination,
      plan([{ path: 'block.json', content: 'replacement\n', operation: 'replace' }]),
    );

    expect(result.written).toEqual(['block.json']);
    expect(await readFile(existing, 'utf8')).toBe('replacement\n');
  });

  it('rejects a changed reviewed destination before establishing a write baseline', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const existing = path.join(destination, 'block.json');
    const reviewedPlan = plan([{ path: 'block.json', content: 'replacement\n', operation: 'replace' }]);
    await writeFile(existing, 'before\n');
    const approval = await inspectAuthoringDestination(destination, reviewedPlan);
    await writeFile(existing, 'changed after preview\n');

    await expect(writeAuthoringOutput(destination, reviewedPlan, approval)).rejects.toThrow(/no longer matches the reviewed preview/);
    expect(await readFile(existing, 'utf8')).toBe('changed after preview\n');
  });

  it('rejects a symlink in a planned output path before writing', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'block-runner-author-outside-'));
    await symlink(outside, path.join(destination, 'src'));
    await mkdir(path.join(outside, 'nested'));

    await expect(writeAuthoringOutput(destination, plan([{ path: 'src/edit.ts', content: 'export {};\n' }]))).rejects.toThrow(/symbolic-link/);
    await expect(stat(path.join(outside, 'edit.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink in the destination prefix before it can be followed', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'block-runner-author-outside-'));
    const redirected = path.join(parent, 'redirected');
    const destination = path.join(redirected, 'generated');
    await symlink(outside, redirected);

    await expect(inspectAuthoringDestination(destination, plan([{ path: 'block.json' }]))).rejects.toThrow(/symbolic-link/);
    await expect(writeAuthoringOutput(destination, plan([{ path: 'block.json', content: 'new\n' }]))).rejects.toThrow(/symbolic-link/);
    await expect(stat(path.join(outside, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
