import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashAuthoringConfirmation,
  inspectAuthoringDestination,
  PublicationInterruptedError,
  retryAuthoringPublication,
  writeAuthoringOutput,
} from '../src/authoring/destination.js';
import { hashAuthoringPlan, validateAuthoringPlan } from '../src/authoring/schema.js';
import { REGISTERED_BLOCK_STYLE_EMITTER_VERSION, REGISTERED_BLOCK_TEMPLATE_VERSION, WORDPRESS_BLOCK_SCHEMA_VERSION } from '../src/authoring/generate.js';

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
  it('binds confirmation to the actual compiler contract as well as the plan and destination', () => {
    const input = plan([]);
    const destination = { directory: '/tmp/block-runner-confirmed-package', fingerprint: 'sha256:example' };
    // Key order is the canonical recursively sorted order used by the confirmation boundary.
    const confirmation = (template: string) => createHash('sha256').update(JSON.stringify({
      compiler: { styles: REGISTERED_BLOCK_STYLE_EMITTER_VERSION, template, wordpressSchema: WORDPRESS_BLOCK_SCHEMA_VERSION },
      destination, planHash: hashAuthoringPlan(input),
    })).digest('hex');
    expect(hashAuthoringConfirmation(input, destination)).toBe(confirmation(REGISTERED_BLOCK_TEMPLATE_VERSION));
    expect(hashAuthoringConfirmation(input, destination)).not.toBe(confirmation('old-template'));
  });

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

  it('retains an exact recovery inventory after each possible new-file publication step', async () => {
    for (const failAfterPublishStep of [1, 2]) {
      const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
      let interrupted: unknown;
      try {
        await writeAuthoringOutput(destination, plan([
          { path: 'block.json', content: 'first\n' },
          { path: 'index.js', content: 'second\n' },
        ]), undefined, { failAfterPublishStep });
      } catch (error) {
        interrupted = error;
      }

      expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
      const recovery = (interrupted as PublicationInterruptedError).recovery;
      expect(recovery.completed.map((entry) => entry.path)).toEqual(failAfterPublishStep === 1 ? ['block.json'] : ['block.json', 'index.js']);
      expect(recovery.pending.map((entry) => entry.path)).toEqual(failAfterPublishStep === 1 ? ['index.js'] : []);
      expect(recovery.completed.every((entry) => entry.afterHash.startsWith('sha256:'))).toBe(true);
      expect(recovery.recordPath).toBeTruthy();

      const receipt = await retryAuthoringPublication(JSON.parse(JSON.stringify(recovery)));
      expect(receipt.written).toEqual(['block.json', 'index.js']);
      expect(await readFile(path.join(destination, 'block.json'), 'utf8')).toBe('first\n');
      expect(await readFile(path.join(destination, 'index.js'), 'utf8')).toBe('second\n');
      expect((await readdir(destination)).filter((name) => name.startsWith('.block-runner-'))).toEqual([]);
    }
  });

  it('rejects an altered published journal staging path without unlinking the supplied file', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    let interrupted: PublicationInterruptedError | undefined;
    try {
      await writeAuthoringOutput(destination, plan([
        { path: 'block.json', content: 'first\n' },
        { path: 'index.js', content: 'second\n' },
      ]), undefined, { failAfterPublishStep: 2 });
    } catch (error) {
      interrupted = error as PublicationInterruptedError;
    }
    expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
    const outside = path.join(await mkdtemp(path.join(tmpdir(), 'block-runner-author-outside-')), 'unrelated.txt');
    await writeFile(outside, 'keep this file\n');
    const record = JSON.parse(await readFile(interrupted!.recovery.recordPath!, 'utf8'));
    record.entries[0].temporary = outside;
    await writeFile(interrupted!.recovery.recordPath!, `${JSON.stringify(record)}\n`);

    await expect(retryAuthoringPublication(JSON.parse(JSON.stringify(interrupted!.recovery))))
      .rejects.toThrow(/unsafe authoring recovery staging path/);
    expect(await readFile(outside, 'utf8')).toBe('keep this file\n');
  });

  it('reports a conflict when a callback changes a published target before success', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const first = path.join(destination, 'block.json');

    await expect(writeAuthoringOutput(destination, plan([
      { path: 'block.json', content: 'first\n' },
      { path: 'index.js', content: 'second\n' },
    ]), undefined, {
      onPublished: async (entry) => {
        if (entry.path === 'index.js') await writeFile(first, 'changed after publication\n');
      },
    })).rejects.toThrow(/authoring publication conflict/);
  });

  it('does not report a changed published target as completed after an interruption', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    let interrupted: PublicationInterruptedError | undefined;
    try {
      await writeAuthoringOutput(destination, plan([{ path: 'block.json', content: 'first\n' }]), undefined, {
        onPublished: async (entry) => {
          await writeFile(path.join(destination, entry.path), 'changed after publication\n');
          throw new Error('interrupt after external change');
        },
      });
    } catch (error) {
      interrupted = error as PublicationInterruptedError;
    }

    expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
    expect(interrupted!.recovery.completed).toEqual([]);
    expect(interrupted!.recovery.pending.map((entry) => entry.path)).toEqual(['block.json']);
  });

  it('preserves approved replacement bytes and refuses retry over a concurrent pending replacement', async () => {
    const destination = await mkdtemp(path.join(tmpdir(), 'block-runner-author-'));
    const first = path.join(destination, 'block.json');
    const second = path.join(destination, 'index.js');
    await writeFile(first, 'first before\n');
    await writeFile(second, 'second before\n');
    let interrupted: unknown;
    try {
      await writeAuthoringOutput(destination, plan([
        { path: 'block.json', content: 'first after\n', operation: 'replace' },
        { path: 'index.js', content: 'second after\n', operation: 'replace' },
      ]), undefined, { failAfterPublishStep: 1 });
    } catch (error) {
      interrupted = error;
    }

    expect(interrupted).toBeInstanceOf(PublicationInterruptedError);
    const recovery = (interrupted as PublicationInterruptedError).recovery;
    expect(recovery.completed.map((entry) => entry.path)).toEqual(['block.json']);
    expect(recovery.pending.map((entry) => entry.path)).toEqual(['index.js']);
    expect(recovery.replacements.map((entry) => entry.path)).toEqual(['block.json']);
    expect(recovery.replacements[0]?.beforeContent?.toString('utf8')).toBe('first before\n');
    expect(recovery.replacements[0]?.beforeHash).toMatch(/^sha256:/);

    await writeFile(second, 'changed elsewhere\n');
    await expect(retryAuthoringPublication(recovery)).rejects.toThrow(/changed after interrupted publication/);
    expect(await readFile(first, 'utf8')).toBe('first after\n');
    expect(await readFile(second, 'utf8')).toBe('changed elsewhere\n');
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
