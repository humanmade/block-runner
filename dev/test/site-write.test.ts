import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareSiteSource } from '../../src/site/input.js';
import { SiteWriteError, writeCompiledSite } from '../../src/site/write.js';
import type { CompiledSite, PreparedSiteSource, SiteFile } from '../../src/site/types.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
const intentPath = fileURLToPath(new URL('./fixtures/site-intent/site.intent.json', import.meta.url));

async function setup() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-write-'));
  await (await import('node:fs/promises')).cp(fixtureRoot, root, { recursive: true });
  const intent = JSON.parse(await readFile(intentPath, 'utf8')) as Record<string, any>;
  const prepared = await prepareSiteSource(intent, root);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
  return { root, source: prepared.source, intent };
}

function file(filePath: string, text: string): SiteFile {
  const bytes = Buffer.from(text);
  return { path: filePath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function artifact(source: PreparedSiteSource): CompiledSite {
  return {
    sourceIntent: source.sourceIntent,
    sourceAssets: source.assets,
    targetBindings: {},
    targetBindingFingerprint: 'empty-bindings',
    themeFiles: [file('style.css', 'body { color: #20201e; }')],
    pages: [],
    assets: [],
    diagnostics: [],
    inventory: [],
    artifactIdentity: 'compiled-site-test',
  };
}

describe('site bundle publication', () => {
  it('writes retained source, compiled records, and the installable theme into a new directory', async () => {
    const { root, source } = await setup();
    try {
      const output = path.join(root, 'bundle');
      const result = await writeCompiledSite(output, source, artifact(source));
      expect(result.artifactType).toBe('site');
      expect(result.files.map(({ path: filePath }) => filePath)).toContain('source/assets/media/hero.png');
      expect(await readFile(path.join(output, 'site.intent.json'), 'utf8')).toContain('"siteId": "sample-studio"');
      expect(await readFile(path.join(output, 'source/assets/media/hero.png'))).toEqual(Buffer.from(source.assets[0]!.bytes));
      expect(await readFile(path.join(output, 'theme/style.css'), 'utf8')).toBe('body { color: #20201e; }');
      expect((await stat(output)).mode & 0o777).toBe(0o755);
      expect((await stat(path.join(output, 'theme'))).mode & 0o777).toBe(0o755);
      expect((await stat(path.join(output, 'theme/style.css'))).mode & 0o777).toBe(0o644);
      expect((await stat(path.join(output, 'source'))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(output, 'source/assets/media/hero.png'))).mode & 0o777).toBe(0o600);
      const manifest = JSON.parse(await readFile(path.join(output, 'site.manifest.json'), 'utf8'));
      expect(manifest.type).toBe('site');
      expect(manifest.artifactType).toBe('site');
      expect(manifest.bundleFiles).toHaveLength(result.files.length - 1);
      await expect(readFile(path.join(output, 'source/source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(output, 'compiled/site.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(path.join(output, 'bundle.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const secondOutput = path.join(root, 'bundle-second');
      await writeCompiledSite(secondOutput, source, artifact(source));
      for (const entry of result.files) {
        expect(await readFile(path.join(secondOutput, entry.path))).toEqual(await readFile(path.join(output, entry.path)));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a separately typed theme artifact with unresolved page bindings retained', async () => {
    const { root, source } = await setup();
    try {
      const pendingPageBindings = source.unresolvedAssetUses.filter(({ documentId }) => documentId.startsWith('page:'));
      const themeArtifact = {
        sourceIntent: source.sourceIntent,
        sourceAssets: source.assets,
        targetBindings: {},
        targetBindingFingerprint: 'theme-bindings-test',
        themeAssetBaseUrl: 'https://example.test/wp-content/themes/sample-studio',
        themeFiles: [file('style.css', 'body { color: #20201e; }')],
        pendingPageBindings,
        diagnostics: [],
        inventory: [],
        artifactIdentity: 'compiled-theme-test',
      };
      const output = path.join(root, 'theme-bundle');
      const result = await writeCompiledSite(output, source, themeArtifact);
      expect(result.artifactType).toBe('theme');
      const record = JSON.parse(await readFile(path.join(output, 'site.manifest.json'), 'utf8'));
      expect(record.type).toBe('theme');
      expect(record.pendingPageBindings).toEqual(pendingPageBindings);
      expect(record).toMatchObject({
        targetBindings: {},
        targetBindingFingerprint: 'theme-bindings-test',
        themeAssetBaseUrl: 'https://example.test/wp-content/themes/sample-studio',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing target without changing its contents', async () => {
    const { root, source } = await setup();
    try {
      const output = path.join(root, 'bundle');
      await mkdir(output);
      await writeFile(path.join(output, 'keep.txt'), 'original');
      await expect(writeCompiledSite(output, source, artifact(source))).rejects.toThrow('bundle output target already exists');
      expect(await readFile(path.join(output, 'keep.txt'), 'utf8')).toBe('original');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not replace an empty target created while staging', async () => {
    const { root, source } = await setup();
    try {
      const output = path.join(root, 'bundle');
      await expect(writeCompiledSite(output, source, artifact(source), {
        onStaged: async () => mkdir(output),
      })).rejects.toThrow('bundle output target already exists');
      expect(await (await import('node:fs/promises')).readdir(output)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects symlink parents and keeps the destination absent', async () => {
    const { root, source } = await setup();
    try {
      const real = path.join(root, 'real-parent');
      await mkdir(real);
      const linked = path.join(root, 'linked-parent');
      await symlink(real, linked);
      await expect(writeCompiledSite(path.join(linked, 'bundle'), source, artifact(source))).rejects.toThrow(/symlink/);
      await expect(lstat(path.join(real, 'bundle'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains staging and refuses publication when source bytes change after staging', async () => {
    const { root, source } = await setup();
    try {
      const output = path.join(root, 'bundle');
      let failure: SiteWriteError | undefined;
      try {
        await writeCompiledSite(output, source, artifact(source), {
          onStaged: async () => writeFile(path.join(root, 'media/hero.png'), 'changed after preparation'),
        });
      } catch (error) {
        if (error instanceof SiteWriteError) failure = error;
        else throw error;
      }
      expect(failure).toBeInstanceOf(SiteWriteError);
      expect(failure?.message).toContain('source assets changed');
      expect(await readFile(path.join(failure!.stagingPath, 'source/assets/media/hero.png'))).toEqual(Buffer.from(source.assets[0]!.bytes));
      await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
