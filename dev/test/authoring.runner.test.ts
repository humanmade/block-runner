import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { author } from '../../src/author/index.js';
import { materializeCandidate } from '../../scripts/authoring-runner.js';
import { hashFile } from '../../scripts/authoring/score.js';
import type { AuthoringFixture } from '../../scripts/authoring/score.js';

describe('registered authoring candidate materialization', () => {
  it('refuses a content hash for a missing file instead of hashing its path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-missing-evidence-'));
    expect(() => hashFile(path.join(root, 'missing.bin'))).toThrow(/ENOENT/);
  });

  it('hashes binary evidence without lossy UTF-8 decoding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-binary-hash-'));
    const first = path.join(root, 'first.bin');
    const second = path.join(root, 'second.bin');
    await writeFile(first, Buffer.from([0xff]));
    await writeFile(second, Buffer.from([0xfe]));
    expect(Buffer.from([0xff]).toString('utf8')).toBe(Buffer.from([0xfe]).toString('utf8'));
    expect(hashFile(first)).not.toBe(hashFile(second));
  });
  it('runs source-bound authoring before the real compiler and does not substitute the expected scoring plan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-real-candidate-'));
    const fixture = {
      id: 'one', family: 'unit', source: { path: 'source.html' }, sourceDependencies: [{ path: 'source.css' }], plan: 'expected.json',
    } as AuthoringFixture;
    const source = '<custom-card class="notice">The actual candidate</custom-card>';
    const css = '.notice { color: red; }';
    await writeFile(path.join(root, 'source.html'), source);
    await writeFile(path.join(root, 'source.css'), css);
    await writeFile(path.join(root, 'expected.json'), '{"not":"a candidate"}');
    const analysis = await author(source, {
      sourcePath: path.join(root, 'source.html'),
      author: { name: 'acme/notice', styles: { mode: 'css', css } },
    });
    expect(analysis.evidence?.coverage).toBeDefined();
    const plan = {
      version: 1,
      generatorVersion: '0.9.0',
      target: { name: 'acme/notice', title: 'Notice', wordpress: '7.1' },
      source: analysis.source,
      coverage: analysis.evidence!.coverage,
      structure: [{ id: 'root', block: 'core/group', attributes: { className: 'notice' }, children: [
        { id: 'copy', block: 'core/paragraph', attributes: { content: 'The actual candidate' } },
      ] }],
      fields: [], locking: { mode: 'none' },
      styles: { strategy: 'scoped-css', outcomes: [], rules: [{ kind: 'style', selector: '.notice', declarations: [{ property: 'color', value: 'red' }] }] },
      pattern: { ready: false, overrides: [] }, assets: [], files: [], warnings: [],
    };
    const candidatePlan = path.join(root, 'candidate.json');
    await writeFile(candidatePlan, JSON.stringify(plan));
    const candidate = path.join(root, 'generated');
    const receipts = path.join(root, 'receipts');
    const manifest = await materializeCandidate(fixture, root, candidate, receipts, candidatePlan);
    expect(await readFile(path.join(candidate, 'edit.js'), 'utf8')).toContain('The actual candidate');
    expect(await readFile(path.join(candidate, 'save.js'), 'utf8')).toContain('useInnerBlocksProps.save( blockProps )');
    expect(existsSync(path.join(candidate, 'src', 'edit.tsx'))).toBe(false);
    expect(existsSync(path.join(candidate, 'style-decisions.json'))).toBe(true);
    expect(JSON.parse(await readFile(path.join(candidate, 'source-coverage.json'), 'utf8'))).toMatchObject({
      valid: true,
      source: { sha256: analysis.source!.sha256 },
      coverage: { styles: [expect.objectContaining({ property: 'color', value: 'red', outcome: 'scoped-css' })] },
    });
    expect(await readFile(path.join(candidate, 'authoring-plan.json'), 'utf8')).toBe(JSON.stringify(plan));
    expect(existsSync(path.join(receipts, manifest.path))).toBe(true);
    await expect(materializeCandidate(fixture, root, path.join(root, 'bad'), receipts, path.join(root, 'expected.json'))).rejects.toThrow('invalid authoring plan');
    expect(existsSync(path.join(root, 'bad'))).toBe(false);
  });

  it('refuses a candidate that omits source styling coverage before compiler output exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-unbound-candidate-'));
    const fixture = {
      id: 'unbound', family: 'unit', source: { path: 'source.html' }, sourceDependencies: [{ path: 'source.css' }],
    } as AuthoringFixture;
    const source = '<p class="notice">Source design</p>';
    const css = '.notice { color: red; }';
    await writeFile(path.join(root, 'source.html'), source);
    await writeFile(path.join(root, 'source.css'), css);
    const analysis = await author(source, {
      sourcePath: path.join(root, 'source.html'),
      author: { name: 'acme/notice', styles: { mode: 'css', css } },
    });
    expect(analysis.ok, JSON.stringify(analysis.items)).toBe(true);
    const plan = structuredClone(analysis.package!.canonicalPlan!);
    plan.coverage!.styles = [];
    const candidatePlan = path.join(root, 'candidate.json');
    await writeFile(candidatePlan, JSON.stringify(plan));

    await expect(materializeCandidate(fixture, root, path.join(root, 'generated'), path.join(root, 'receipts'), candidatePlan))
      .rejects.toThrow(/complete source declaration and asset coverage/i);
    expect(existsSync(path.join(root, 'generated'))).toBe(false);
  });

  it('snapshots declared source dependencies inside the candidate for the worker', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-source-snapshot-'));
    const fixture = {
      id: 'dependency-fixture',
      family: 'dependency-fixture',
      source: { path: 'sources/design.html' },
      sourceDependencies: [{ path: 'sources/design.css' }],
      plan: 'expected.json',
    } as AuthoringFixture;
    await mkdir(path.join(root, 'sources'), { recursive: true });
    await writeFile(path.join(root, 'sources/design.html'), '<section class="design">Design</section>');
    await writeFile(path.join(root, 'sources/design.css'), '.design { color: red; }');
    const analysis = await author('<section class="design">Design</section>', {
      sourcePath: path.join(root, 'sources/design.html'),
      author: { name: 'acme/dependency', styles: { mode: 'css', css: '.design { color: red; }' } },
    });
    expect(analysis.ok, JSON.stringify(analysis.items)).toBe(true);
    const plan = analysis.package!.canonicalPlan!;
    await writeFile(path.join(root, 'expected.json'), '{}');
    const candidatePlan = path.join(root, 'candidate.json');
    await writeFile(candidatePlan, JSON.stringify(plan));
    const candidate = path.join(root, 'generated');
    const receipts = path.join(root, 'receipts');

    const manifest = await materializeCandidate(fixture, root, candidate, receipts, candidatePlan);

    expect(await readFile(path.join(candidate, 'source', 'sources/design.html'), 'utf8')).toContain('Design');
    expect(await readFile(path.join(candidate, 'source', 'sources/design.css'), 'utf8')).toContain('color: red');
    const entries = JSON.parse(await readFile(path.join(receipts, manifest.path), 'utf8')) as Array<{ path: string }>;
    expect(entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'source/sources/design.html',
      'source/sources/design.css',
    ]));
  });
});
