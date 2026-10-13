import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareSiteSource, siteSourceIdentityMatches, validateSiteIntent } from '../../src/site/input.js';
import { verifyPreparedSiteAssets } from '../../src/site/assets.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
const intentPath = fileURLToPath(new URL('./fixtures/site-intent/site.intent.json', import.meta.url));

async function loadIntent(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(intentPath, 'utf8')) as Record<string, any>;
}

describe('site intent contract', () => {
  it('prepares the shared five-page source and retains unresolved attachment uses', async () => {
    const input = await loadIntent();
    const result = await prepareSiteSource(input, fixtureRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.sourceIntent.pages.map((page) => page.id)).toEqual(['home', 'about', 'services', 'consulting', 'contact']);
    expect(result.source.sourceIntent.pages[0]?.route).toBe('/');
    expect(result.source.sourceIntent.pages[3]?.parentId).toBe('services');
    expect(result.source.assets.map(({ id, path, role }) => ({ id, path, role }))).toEqual([
      { id: 'home-hero', path: 'media/hero.png', role: 'attachment' },
      { id: 'site-styles', path: 'styles/site.css', role: 'theme-file' },
    ]);
    expect(result.source.unresolvedAssetUses).toEqual(input.assetUses);
    expect(result.source.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true);
  });

  it('keeps logical identity when title, route, or body changes while source identity changes', async () => {
    const original = await loadIntent();
    const baseline = await prepareSiteSource(original, fixtureRoot);
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;

    for (const mutate of [
      (input: Record<string, any>) => { input.pages[0].title = 'A different title'; },
      (input: Record<string, any>) => { input.pages[1].route = '/welcome'; },
      (input: Record<string, any>) => { input.pages[0].body.blocks[0].text = 'A different body'; },
    ]) {
      const changed = structuredClone(original) as Record<string, any>;
      mutate(changed);
      const prepared = await prepareSiteSource(changed, fixtureRoot);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.source.sourceIntent.pages[0]?.id).toBe('home');
      expect(prepared.source.sourceIdentity).not.toBe(baseline.source.sourceIdentity);
    }
  });

  it('uses canonical source identity independent of object key insertion order', async () => {
    const input = await loadIntent();
    const baseline = await prepareSiteSource(input, fixtureRoot);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    const nested = reordered.theme as Record<string, unknown>;
    reordered.theme = Object.fromEntries(Object.entries(nested).reverse());
    const reversed = await prepareSiteSource(reordered, fixtureRoot);
    expect(baseline.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (baseline.ok && reversed.ok) expect(reversed.source.sourceIdentity).toBe(baseline.source.sourceIdentity);
  });

  it('accepts a legacy insertion-order source identity and verifies its source bytes unchanged', async () => {
    const prepared = await prepareSiteSource(await loadIntent(), fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const legacyIdentity = createHash('sha256').update(JSON.stringify(prepared.source.sourceIntent)).digest('hex');
    const legacySource = { ...prepared.source, sourceIdentity: legacyIdentity };
    expect(siteSourceIdentityMatches(legacySource.sourceIntent, legacyIdentity)).toBe(true);
    await expect(verifyPreparedSiteAssets(legacySource)).resolves.toBeUndefined();
    expect(siteSourceIdentityMatches(legacySource.sourceIntent, 'sha256-not-current')).toBe(false);
  });

  it('reports malformed native tree nodes and children without throwing during graph preparation', async () => {
    const input = await loadIntent();
    input.pages[0].body.blocks = [null, { block: 'core/group', children: { block: 'core/paragraph' } }];
    const diagnostics: Array<{ path: string; code: string }> = [];
    expect(() => validateSiteIntent(input, diagnostics as any)).not.toThrow();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/pages/0/body/blocks/0', code: 'intent-node-required' }),
      expect.objectContaining({ path: '/pages/0/body/blocks/1/children', code: 'array-required' }),
    ]));
  });

  it('reports self and mutual block-tree cycles but permits shared nodes across branches', async () => {
    for (const makeCycle of [
      () => { const node: Record<string, unknown> = { block: 'core/group' }; node.children = [node]; return [node]; },
      () => {
        const first: Record<string, unknown> = { block: 'core/group' };
        const second: Record<string, unknown> = { block: 'core/group' };
        first.children = [second]; second.children = [first];
        return [first];
      },
    ]) {
      const input = await loadIntent();
      input.pages[0].body.blocks = makeCycle();
      input.assetUses = [];
      const diagnostics: Array<{ path: string; code: string }> = [];
      expect(() => validateSiteIntent(input, diagnostics as any)).not.toThrow();
      expect(diagnostics).toContainEqual(expect.objectContaining({ path: expect.stringMatching(/^\/pages\/0\/body\/blocks\//), code: 'intent-tree-cycle' }));
    }

    const input = await loadIntent();
    const shared = { block: 'core/paragraph', text: 'shared node' };
    input.pages[0].body.blocks = [
      { block: 'core/group', children: [shared] },
      { block: 'core/group', children: [shared] },
    ];
    input.assetUses = [];
    const diagnostics: Array<{ path: string; code: string }> = [];
    expect(validateSiteIntent(input, diagnostics as any)).toBeDefined();
    expect(diagnostics).toEqual([]);
  });

  it('preserves deliberately empty content and permissive native attrs', async () => {
    const input = await loadIntent();
    input.pages[0].body = { blocks: [] };
    input.assetUses = [];
    input.pages[1].body.blocks[0].attrs = { futureNativeAttribute: { value: 7 } };
    input.pages[1].body.blocks[0].futureNodeField = { retained: true };
    const result = await prepareSiteSource(input, fixtureRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.sourceIntent.pages[0]?.body).toEqual({ blocks: [] });
    expect(result.source.sourceIntent.pages[1]?.body.blocks[0]?.attrs).toEqual({ futureNativeAttribute: { value: 7 } });
    expect((result.source.sourceIntent.pages[1]?.body.blocks[0] as unknown as Record<string, unknown>).futureNodeField).toEqual({ retained: true });
  });

  it('defaults omitted publication status to draft', async () => {
    const input = await loadIntent();
    delete input.pages[3].status;
    const result = await prepareSiteSource(input, fixtureRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.sourceIntent.pages[3]?.status).toBe('draft');
  });

  it('points graph and envelope failures at their input fields', async () => {
    const input = await loadIntent();
    input.version = 2;
    input.pages[1].id = input.pages[0].id;
    input.pages[1].route = '/ABOUT';
    input.pages[2].route = '/about';
    input.pages[2].parentId = 'consulting';
    input.pages[3].parentId = 'services';
    input.pages[4].route = '/../contact';
    input.assetUses[0].assetId = 'missing';
    input.extra = true;
    const diagnostics: Array<{ path: string; code: string }> = [];
    validateSiteIntent(input, diagnostics as any);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/version', code: 'unsupported-version' }),
      expect.objectContaining({ path: '/pages/1/id', code: 'duplicate-page-id' }),
      expect.objectContaining({ path: '/pages/2/route', code: 'duplicate-route' }),
      expect.objectContaining({ path: '/pages/2/parentId', code: 'parent-cycle' }),
      expect.objectContaining({ path: '/pages/4/route', code: 'unsafe-route' }),
      expect.objectContaining({ path: '/assetUses/0/assetId', code: 'unknown-asset' }),
      expect.objectContaining({ path: '/extra', code: 'unsupported-field' }),
    ]));
  });

  it('rejects unknown tree targets, unknown template parts, and unsafe local asset paths', async () => {
    const input = await loadIntent();
    input.templates.index.body.blocks[0].attrs.slug = 'missing-part';
    input.assetUses[0].nodePath = [90];
    input.assets[0].path = '../outside.svg';
    const diagnostics: Array<{ path: string; code: string }> = [];
    validateSiteIntent(input, diagnostics as any);

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/templates/index/body/blocks/0', code: 'unknown-template-part' }),
      expect.objectContaining({ path: '/assetUses/0/nodePath', code: 'unknown-node' }),
      expect.objectContaining({ path: '/assets/0/path', code: 'unsafe-path' }),
    ]));
  });

  it('rejects symlinked roots and asset paths plus missing and non-file assets', async () => {
    const temporaryRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-contract-'));
    try {
      const linkedRoot = path.join(temporaryRoot, 'linked-root');
      await symlink(fixtureRoot, linkedRoot);
      const input = await loadIntent();
      const rootResult = await prepareSiteSource(input, linkedRoot);
      expect(rootResult.ok).toBe(false);
      if (!rootResult.ok) expect(rootResult.diagnostics).toContainEqual(expect.objectContaining({ path: '/assetRoot', code: 'asset-root' }));

      const root = path.join(temporaryRoot, 'root');
      const media = path.join(root, 'media');
      const styles = path.join(root, 'styles');
      const { mkdir, symlink: makeSymlink } = await import('node:fs/promises');
      await mkdir(media, { recursive: true });
      await mkdir(styles, { recursive: true });
      await makeSymlink(path.join(fixtureRoot, 'media/hero.png'), path.join(media, 'hero.png'));
      await makeSymlink(path.join(fixtureRoot, 'styles/site.css'), path.join(styles, 'site.css'));
      const symlinkResult = await prepareSiteSource(input, root);
      expect(symlinkResult.ok).toBe(false);
      if (!symlinkResult.ok) expect(symlinkResult.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/assets/0/path', code: 'asset-read' }),
        expect.objectContaining({ path: '/assets/1/path', code: 'asset-read' }),
      ]));
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }

    const input = await loadIntent();
    input.assets[0].path = 'media/missing.png';
    input.assets[1].path = 'styles';
    const missingResult = await prepareSiteSource(input, fixtureRoot);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/assets/0/path', code: 'asset-read' }),
      expect.objectContaining({ path: '/assets/1/path', code: 'asset-read' }),
    ]));
  });

  it('rejects unsupported asset attributes at their declaration path', async () => {
    const input = await loadIntent();
    input.assetUses[0].attribute = 'attrs.className';
    const diagnostics: Array<{ path: string; code: string }> = [];
    validateSiteIntent(input, diagnostics as any);
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: '/assetUses/0/attribute', code: 'unsupported-attribute' }));
  });

  it('rejects oversized assets before reading their contents', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-site-large-asset-'));
    try {
      const input = await loadIntent();
      const oversized = path.join(root, 'oversized.png');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(oversized), { recursive: true });
      await writeFile(oversized, 'x');
      await truncate(oversized, 20 * 1024 * 1024 + 1);
      input.assets = [input.assets[0]];
      input.assets[0].path = 'oversized.png';
      input.assetUses = [];
      const result = await prepareSiteSource(input, root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: '/assets/0/path', code: 'asset-read' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores unrelated changes to ancestor directory metadata while preparing stable assets', async () => {
    const temporaryBase = await realpath(tmpdir());
    const root = await mkdtemp(path.join(temporaryBase, 'block-runner-site-parent-mutation-'));
    try {
      await cp(path.join(fixtureRoot, 'media'), path.join(root, 'media'), { recursive: true });
      await cp(path.join(fixtureRoot, 'styles'), path.join(root, 'styles'), { recursive: true });
      const input = await loadIntent();
      const mutateAncestor = async (): Promise<void> => {
        for (let index = 0; index < 60; index += 1) {
          const sibling = path.join(temporaryBase, `site-asset-noise-${randomUUID()}`);
          await mkdir(sibling);
          await rm(sibling, { recursive: true });
        }
      };
      const [prepared] = await Promise.all([prepareSiteSource(input, root), mutateAncestor()]);
      expect(prepared.ok).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
