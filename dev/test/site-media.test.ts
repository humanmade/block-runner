import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { compileSitePageDocuments } from '../../src/site/compile.js';
import { attachmentVersionKey, bindNativeImage, declaredEmbedAspectRatio } from '../../src/site/media.js';
import { managedStateHash, reconcileSitePlan } from '../../src/site/plan.js';
import { prepareSiteSource } from '../../src/site/input.js';
import type { SiteEntity, SiteSnapshot } from '../../src/site/plan-types.js';
import type { PreparedSiteSource, SiteAttachmentBinding, ThemeArtifact } from '../../src/site/types.js';
import type { IntentNode } from '../../src/types.js';

const oldHash = 'a'.repeat(64);
const nextHash = 'b'.repeat(64);

function state(sha256: string) { return { sha256 }; }
function attachment(id: number, sha256: string, logicalId = 'hero'): SiteEntity {
  const managed = state(sha256);
  return { id, kind: 'attachment', route: null, state: managed, postStatus: 'inherit',
    attachment: { url: `https://example.test/uploads/${id}.jpg`, currentFileSha256: sha256, width: 1200, height: 800 },
    ownership: [{ version: 1, siteId: 'sample', entityId: logicalId, kind: 'attachment', assetSha256: sha256, lastAppliedHash: managedStateHash(managed) }] };
}
function snapshot(entities: SiteEntity[] = []): SiteSnapshot {
  return { target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 1 },
    runtime: { wordpress: '7.1', php: '8.4' }, principal: { userId: 1, capabilities: { edit_pages: true, edit_others_pages: true, manage_options: true, edit_theme_options: true, upload_files: true } },
    theme: { slug: 'sample', assetBaseUrl: 'https://example.test/theme', inventory: [] },
    routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'rules', routes: [] }, entities, overrides: [], navigation: [],
    options: { show_on_front: 'page', page_on_front: 1 }, siteRecord: { version: 1, siteId: 'sample', entities: {}, options: {}, operation: null } };
}
function source(sha256: string): PreparedSiteSource {
  const sourceIntent = { version: 1 as const, siteId: 'sample', homePageId: 'home', theme: { slug: 'sample', title: 'Sample', themeJson: { version: 3 } },
    templates: {}, parts: {}, patterns: {}, pages: [{ id: 'home', route: '/', title: 'Home', template: 'index', body: { blocks: [] } }],
    assets: [{ id: 'hero', path: 'hero.jpg', kind: 'image' as const, role: 'attachment' as const }], assetUses: [] };
  return { sourceIntent, assetRoot: '/assets', assets: [{ ...sourceIntent.assets[0]!, sha256, bytes: new Uint8Array([1]) }], sourceIdentity: 'source', unresolvedAssetUses: [] };
}
function theme(input: PreparedSiteSource): ThemeArtifact {
  return { sourceIntent: input.sourceIntent, sourceAssets: input.assets, targetBindings: {}, targetBindingFingerprint: 'bindings', themeFiles: [], syncedPatterns: [], pendingPageBindings: [], diagnostics: [], inventory: [], artifactIdentity: 'theme' };
}
const compiledPages = [{ id: 'home', route: '/', title: 'Home', template: 'index', content: '', status: 'draft' as const, diagnostics: [] }];

describe('owned attachment versions', () => {
  it('reuses only the exact owned version and keeps a same-name unmanaged file out of resolution', () => {
    const exact = attachment(21, oldHash);
    const unrelated = attachment(22, nextHash, 'other');
    unrelated.ownership = [];
    const input = source(oldHash);
    const result = reconcileSitePlan(input, theme(input), compiledPages, snapshot([exact, unrelated]));
    expect(result.executable).toBe(true);
    expect(result.operations.find(operation => operation.kind === 'attachment')).toMatchObject({ action: 'retain', id: 21, entityId: 'hero' });
  });

  it('plans a new version while retaining the old attachment and legacy indexed ID', () => {
    const previous = attachment(21, oldHash);
    delete previous.ownership[0]!.assetSha256;
    const observed = snapshot([previous]);
    observed.siteRecord!.entities = { 'attachment:hero': 21 };
    const input = source(nextHash);
    const result = reconcileSitePlan(input, theme(input), compiledPages, observed);
    expect(result.executable).toBe(true);
    expect(result.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'create', kind: 'attachment', entityId: 'hero', desired: { sha256: nextHash, assetSha256: nextHash } }),
      expect.objectContaining({ action: 'retain', kind: 'attachment', id: 21, desired: { orphaned: true } }),
    ]));
  });

  it('blocks duplicate versions and human changes to any owned version', () => {
    const duplicate = attachment(22, oldHash);
    expect(reconcileSitePlan(source(oldHash), theme(source(oldHash)), compiledPages, snapshot([attachment(21, oldHash), duplicate])).conflicts.map(item => item.code)).toContain('duplicate-ownership');
    const changed = attachment(23, oldHash);
    changed.state.sha256 = nextHash;
    expect(reconcileSitePlan(source(nextHash), theme(source(nextHash)), compiledPages, snapshot([changed])).conflicts.map(item => item.code)).toContain('managed-state-changed');
  });

  it('does not reuse owned attachments that are trashed or otherwise unavailable', () => {
    const trashed = attachment(31, oldHash);
    trashed.postStatus = 'trash';
    const result = reconcileSitePlan(source(oldHash), theme(source(oldHash)), compiledPages, snapshot([trashed]));
    expect(result.executable).toBe(false);
    expect(result.conflicts.map(item => item.code)).toContain('unavailable-owned-attachment');
  });

  it('uses hash-qualified ownership keys', () => {
    expect(attachmentVersionKey('hero', oldHash)).toBe(`attachment:hero@${oldHash}`);
  });
});

describe('native media metadata before Gutenberg finalization', () => {
  const sizes = { full: { url: 'https://example.test/full.jpg', width: 2400, height: 1600 }, large: { url: 'https://example.test/large.jpg', width: 1024, height: 683 } };
  const binding: SiteAttachmentBinding = { id: 42, url: sizes.full.url, imageSizes: sizes };

  it('selects observed size URL and dimensions while preserving explicit native image settings', () => {
    const image: IntentNode = { block: 'core/image', url: 'source/hero.jpg', attrs: { sizeSlug: 'large', linkDestination: 'custom', href: 'https://example.test/custom' } };
    expect(bindNativeImage(image, binding)).toMatchObject({ url: sizes.large.url, sizeSlug: 'large', width: 1024, height: 683 });
    expect(image.attrs).toMatchObject({ sizeSlug: 'large', linkDestination: 'custom', href: 'https://example.test/custom' });
    expect(bindNativeImage({ block: 'core/cover', url: 'source/hero.jpg' }, binding)).toBeUndefined();
  });

  it('rejects an unavailable requested size', () => {
    expect(bindNativeImage({ block: 'core/image', attrs: { sizeSlug: 'thumbnail' } }, binding)?.error).toContain('no observed thumbnail');
  });

  it('uses observed media and attachment-page URLs and rejects explicit contradictions', () => {
    const observed = { ...binding, attachmentPageUrl: 'https://example.test/hero/' };
    const media: IntentNode = { block: 'core/image', attrs: { linkDestination: 'media' } };
    expect(bindNativeImage(media, observed)?.error).toBeUndefined();
    expect(media.attrs?.href).toBe(binding.url);
    const page: IntentNode = { block: 'core/image', attrs: { linkDestination: 'attachment' } };
    expect(bindNativeImage(page, observed)?.error).toBeUndefined();
    expect(page.attrs?.href).toBe(observed.attachmentPageUrl);
    expect(bindNativeImage({ block: 'core/image', attrs: { href: 'https://wrong.test/' } }, observed)?.error).toContain('contradicts linkDestination none');
  });

  it('carries observed native image metadata into serialized page content', async () => {
    const root = fileURLToPath(new URL('./fixtures/site-intent/', import.meta.url));
    const intent = { version: 1, siteId: 'sample', homePageId: 'home', theme: { slug: 'sample', title: 'Sample', themeJson: { version: 3 } },
      templates: { index: { body: { blocks: [{ block: 'core/post-content' }] } } }, parts: {}, patterns: {}, pages: [{ id: 'home', route: '/', title: 'Home', template: 'index', body: { blocks: [{ block: 'core/image', url: 'media/hero.png', alt: 'Hero', attrs: { id: 0, sizeSlug: 'large' } }] } }],
      assets: [{ id: 'hero', path: 'media/hero.png', kind: 'image', role: 'attachment' }], assetUses: [{ documentId: 'page:home', nodePath: [0], attribute: 'attrs.id', assetId: 'hero' }] };
    const prepared = await prepareSiteSource(intent, root);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
    const result = await compileSitePageDocuments(prepared.source, { attachmentBindings: { hero: { id: 42, url: sizes.full.url, imageSizes: sizes } } });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.pages[0]!.content).toContain('src="https://example.test/large.jpg"');
    expect(result.pages[0]!.content).toContain('"sizeSlug":"large"');
  });

  it('accepts only a positive caller-declared embed ratio', () => {
    expect(declaredEmbedAspectRatio({ block: 'core/embed', attrs: { aspectRatio: '16/9' } })).toBe('16 / 9');
    expect(declaredEmbedAspectRatio({ block: 'core/embed', attrs: { aspectRatio: '0/9' } })).toBeUndefined();
  });
});
