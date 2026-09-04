import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeCandidate } from '../scripts/authoring-runner.js';
import { hashFile } from '../scripts/authoring/score.js';
import type { AuthoringFixture } from '../scripts/authoring/score.js';

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
  it('runs the real compiler and does not substitute the expected scoring plan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'block-runner-real-candidate-'));
    const fixture = { id: 'one', source: { path: 'source.html' }, plan: 'expected.json' } as AuthoringFixture;
    await writeFile(path.join(root, 'source.html'), '<h2>Source design</h2>');
    await writeFile(path.join(root, 'expected.json'), '{"not":"a candidate"}');
    const plan = JSON.parse(await readFile('test/fixtures/authoring/pattern-overrides.plan.json', 'utf8'));
    plan.structure[0].children[0].attributes.content = 'The actual candidate';
    const candidatePlan = path.join(root, 'candidate.json');
    await writeFile(candidatePlan, JSON.stringify(plan));
    const candidate = path.join(root, 'generated');
    const receipts = path.join(root, 'receipts');
    const manifest = materializeCandidate(fixture, root, candidate, receipts, candidatePlan);
    expect(await readFile(path.join(candidate, 'edit.js'), 'utf8')).toContain('The actual candidate');
    expect(await readFile(path.join(candidate, 'save.js'), 'utf8')).toContain('InnerBlocks.Content');
    expect(existsSync(path.join(candidate, 'src', 'edit.tsx'))).toBe(false);
    expect(existsSync(path.join(candidate, 'style-decisions.json'))).toBe(true);
    expect(existsSync(path.join(candidate, 'style-ledger.json'))).toBe(false);
    expect(await readFile(path.join(candidate, 'authoring-plan.json'), 'utf8')).toBe(JSON.stringify(plan));
    expect(existsSync(path.join(receipts, manifest.path))).toBe(true);
    expect(() => materializeCandidate(fixture, root, path.join(root, 'bad'), receipts, path.join(root, 'expected.json'))).toThrow('invalid authoring plan');
    expect(existsSync(path.join(root, 'bad'))).toBe(false);
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
    await writeFile(path.join(root, 'sources/design.html'), '<section>Design</section>');
    await writeFile(path.join(root, 'sources/design.css'), '.design { color: red; }');
    const plan = JSON.parse(await readFile('test/fixtures/authoring/pattern-overrides.plan.json', 'utf8'));
    await writeFile(path.join(root, 'expected.json'), '{}');
    const candidatePlan = path.join(root, 'candidate.json');
    await writeFile(candidatePlan, JSON.stringify(plan));
    const candidate = path.join(root, 'generated');
    const receipts = path.join(root, 'receipts');

    const manifest = materializeCandidate(fixture, root, candidate, receipts, candidatePlan);

    expect(await readFile(path.join(candidate, 'source', 'sources/design.html'), 'utf8')).toContain('Design');
    expect(await readFile(path.join(candidate, 'source', 'sources/design.css'), 'utf8')).toContain('color: red');
    const entries = JSON.parse(await readFile(path.join(receipts, manifest.path), 'utf8')) as Array<{ path: string }>;
    expect(entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      'source/sources/design.html',
      'source/sources/design.css',
    ]));
  });
});
