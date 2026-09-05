import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectAuthoringDestination, writeGeneratedRegisteredBlock } from '../src/authoring/destination.js';
import { compileRegisteredBlock, type GeneratedRegisteredBlock } from '../src/authoring/generate.js';
import { classifyRegisteredBlockRegeneration } from '../src/authoring/regeneration.js';
import { validateAuthoringPlan } from '../src/authoring/schema.js';

function generated(): GeneratedRegisteredBlock {
  return compileRegisteredBlock(validateAuthoringPlan({
    version: 1,
    generatorVersion: '0.9.0-regeneration-test',
    target: { name: 'example/notice', title: 'Notice', wordpress: '7.1' },
    structure: [], fields: [], locking: { mode: 'none' },
    styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
  }));
}

function compiledDefault(heading: string, operation: 'create' | 'replace'): GeneratedRegisteredBlock {
  return compileRegisteredBlock(validateAuthoringPlan({
    version: 1,
    generatorVersion: '0.9.0-regeneration-defaults',
    target: { name: 'example/default-notice', title: 'Default notice', wordpress: '7.1' },
    structure: [{ id: 'notice.heading', block: 'core/heading', attributes: { content: heading } }],
    fields: [{ id: 'notice.heading.content', label: 'Heading', mode: 'editable', node: 'notice.heading', attribute: 'content' }],
    locking: { mode: 'contentOnly' }, styles: { strategy: 'native', outcomes: [] },
    pattern: { ready: false, overrides: [] }, assets: [],
    files: ['block.json', 'index.js', 'edit.js', 'save.js', 'style.scss', 'editor.scss', 'block.php'].map((path) => ({ path, operation })),
    warnings: [],
  }));
}

function changed(source: GeneratedRegisteredBlock, file: string, content: string): GeneratedRegisteredBlock {
  const hash = createHash('sha256').update(content).digest('hex');
  return {
    ...source,
    files: source.files.map((entry) => entry.path === file ? { ...entry, content, hash } : entry),
    manifest: { ...source.manifest, files: source.manifest.files.map((entry) => entry.path === file ? { ...entry, contentHash: hash } : entry) },
  };
}

describe('registered block regeneration', () => {
  it('classifies an exact package as a no-op and a style replacement without claiming a site migration', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'block-runner-regeneration-'));
    const first = generated();
    await writeGeneratedRegisteredBlock(output, first);
    const inspection = await inspectAuthoringDestination(output, { files: first.files });

    expect((await classifyRegisteredBlockRegeneration(inspection, first)).kind).toBe('unchanged');
    const style = await classifyRegisteredBlockRegeneration(inspection, changed(first, 'style.scss', '.wp-block-example-notice{color:rebeccapurple}\n'));
    expect(style.kind).toBe('style-only');
    expect(style.existingInstanceEffect).toMatch(/saved block markup is unchanged/i);
    expect(style.existingInstanceEffect).toMatch(/appearance/i);
  });

  it('permits a real compiled content-default change while manifest identity and generated assets remain sealed', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'block-runner-regeneration-'));
    const v1 = compiledDefault('Version one default', 'create');
    const v2 = compiledDefault('Version two default', 'replace');
    await writeGeneratedRegisteredBlock(output, v1);
    const inspection = await inspectAuthoringDestination(output, { files: v1.files });
    const impact = await classifyRegisteredBlockRegeneration(inspection, v2);

    expect(v2.sourcePlanHash).not.toBe(v1.sourcePlanHash);
    expect(v2.manifest.files.every((entry) => entry.sourcePlanHash === v2.sourcePlanHash)).toBe(true);
    expect(v2.files.filter((file) => file.hash !== v1.files.find((before) => before.path === file.path)?.hash).map((file) => file.path)).toEqual(['edit.js']);
    expect(impact).toMatchObject({ kind: 'content-defaults', writeAllowed: true, changedFiles: ['edit.js'] });
  });

  it('publishes the synchronous sealed snapshot when a caller mutates the generated object after inspection begins', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'block-runner-regeneration-'));
    const v1 = compiledDefault('Version one default', 'create');
    const v2 = compiledDefault('Version two default', 'replace');
    await writeGeneratedRegisteredBlock(output, v1);
    const pending = writeGeneratedRegisteredBlock(output, v2);
    queueMicrotask(() => {
      const mutated = changed(v2, 'save.js', 'export default function save(){ return <p>mutated</p>; }\n');
      Object.assign(v2.files.find((file) => file.path === 'save.js')!, mutated.files.find((file) => file.path === 'save.js')!);
      Object.assign(v2.manifest.files.find((entry) => entry.path === 'save.js')!, mutated.manifest.files.find((entry) => entry.path === 'save.js')!);
    });
    expect((await pending).written).toContain('edit.js');
  });

  it('keeps an editor-template change distinct from saved markup and refuses a save change without a migration or new identity', async () => {
    const output = await mkdtemp(path.join(tmpdir(), 'block-runner-regeneration-'));
    const first = generated();
    await writeGeneratedRegisteredBlock(output, first);
    const inspection = await inspectAuthoringDestination(output, { files: first.files });

    const defaults = await classifyRegisteredBlockRegeneration(inspection, changed(first, 'edit.js', 'export default function Edit(){ return null; }\n'));
    expect(defaults.kind).toBe('content-defaults');
    expect(defaults.existingInstanceEffect).toMatch(/New insertions/i);

    const saved = await classifyRegisteredBlockRegeneration(inspection, changed(first, 'save.js', 'export default function save(){ return <p>changed</p>; }\n'));
    expect(saved.kind).toBe('saved-markup-or-structure');
    expect(saved.writeAllowed).toBe(false);
    expect(saved.nextStep).toMatch(/new block identity|deprecation\/migration/i);

    const metadata = JSON.parse(first.files.find((file) => file.path === 'block.json')!.content);
    metadata.attributes = { retainedField: { type: 'string', source: 'html', selector: 'p' } };
    const schema = await classifyRegisteredBlockRegeneration(inspection, changed(first, 'block.json', JSON.stringify(metadata, null, 2) + '\n'));
    expect(schema.kind).toBe('saved-markup-or-structure');
    expect(schema.writeAllowed).toBe(false);
    await expect(writeGeneratedRegisteredBlock(output, changed(first, 'save.js', 'export default function save(){ return <p>changed</p>; }\n')))
      .rejects.toThrow(/no files written/i);
    expect((await writeGeneratedRegisteredBlock(output, first)).written).toEqual([]);
  });
});
