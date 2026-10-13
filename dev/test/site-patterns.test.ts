import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateSiteIntent } from '../../src/site/input.js';
import { compileSite, compileThemeDocuments, compileSitePageDocuments, compileSiteSyncedPattern, compileSiteSyncedPatterns, createSiteSyncedPatternCompiler } from '../../src/site/compile.js';
import type { PreparedSiteSource, SiteIntent, ThemeArtifact } from '../../src/site/types.js';
import { managedStateHash, planPreparedSite, reconcileSitePlan } from '../../src/site/plan.js';
import type { SiteEntity, SiteSnapshot } from '../../src/site/plan-types.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
async function base(): Promise<SiteIntent> {
  return JSON.parse(await readFile(new URL('./fixtures/site-intent/site.intent.json', import.meta.url), 'utf8')) as SiteIntent;
}

function declaration(): NonNullable<SiteIntent['syncedPatterns']> {
  return {
    version: 1,
    definitions: { card: { title: 'Card', body: { blocks: [{ block: 'core/paragraph', attrs: { content: 'Base', metadata: { name: 'card-copy', bindings: { __default: { source: 'core/pattern-overrides' }, content: { source: 'core/pattern-overrides' } } } } }] } } },
    uses: [],
  };
}

describe('site synced pattern contract and compiler', () => {
  it('binds two explicit instances to one observed ID with independent supported overrides', async () => {
    const intent = await base();
    intent.assets = [];
    intent.assetUses = [];
    intent.pages = intent.pages.slice(0, 2);
    intent.syncedPatterns = declaration();
    intent.pages[0]!.body = { blocks: [{ block: 'core/block' }] };
    intent.pages[1]!.body = { blocks: [{ block: 'core/block' }] };
    intent.syncedPatterns.uses = [
      { documentId: 'page:home', nodePath: [0], patternId: 'card', content: { 'card-copy': { content: 'Home copy' } } },
      { documentId: 'page:about', nodePath: [0], patternId: 'card', content: { 'card-copy': { content: 'About copy' } } },
    ];
    const result = await import('../../src/site/input.js').then(({ prepareSiteSource }) => prepareSiteSource(intent, fixtureRoot));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const compiled = await compileSitePageDocuments(result.source, { patternBindings: { card: 642 } });
    expect(compiled.ok).toBe(true);
    expect(compiled.pages).toHaveLength(2);
    expect(compiled.pages[0]!.content).toContain('"ref":642');
    expect(compiled.pages[0]!.content).toContain('Home copy');
    expect(compiled.pages[1]!.content).toContain('About copy');
    const definitions = await compileSiteSyncedPatterns(result.source);
    expect(definitions).toMatchObject([{ id: 'card', title: 'Card', content: expect.stringContaining('Base') }]);
  });

  it('rejects missing names, unsupported and structural fields, inline children, absent refs and cycles', async () => {
    const invalidCases: Array<(intent: SiteIntent) => void> = [
      (intent) => { intent.syncedPatterns = declaration(); intent.syncedPatterns.definitions.card.body.blocks[0]!.attrs!.metadata = { bindings: { content: { source: 'core/pattern-overrides' } } }; intent.syncedPatterns.uses = [{ documentId: 'page:home', nodePath: [0], patternId: 'card', content: { unknown: { content: 'No name' } } }]; intent.pages[0]!.body = { blocks: [{ block: 'core/block' }] }; },
      (intent) => { intent.syncedPatterns = declaration(); intent.syncedPatterns.definitions.card.body.blocks[0]!.attrs!.metadata = { name: 'x', bindings: { innerBlocks: { source: 'core/pattern-overrides' } } }; intent.syncedPatterns.uses = [{ documentId: 'page:home', nodePath: [0], patternId: 'card', content: { x: { innerBlocks: [] } } }]; intent.pages[0]!.body = { blocks: [{ block: 'core/block' }] }; },
      (intent) => { intent.syncedPatterns = declaration(); intent.syncedPatterns.uses = [{ documentId: 'page:home', nodePath: [0], patternId: 'missing' }]; intent.pages[0]!.body = { blocks: [{ block: 'core/block', children: [{ block: 'core/paragraph', text: 'lost' }] }] }; },
      (intent) => { intent.syncedPatterns = declaration(); intent.syncedPatterns.uses = [{ documentId: 'page:home', nodePath: [0], patternId: 'missing' }]; intent.pages[0]!.body = { blocks: [{ block: 'core/block' }] }; },
      (intent) => { intent.syncedPatterns = { version: 1, definitions: { a: { title: 'A', body: { blocks: [{ block: 'core/block' }] } }, b: { title: 'B', body: { blocks: [{ block: 'core/block' }] } } }, uses: [{ documentId: 'synced-pattern:a', nodePath: [0], patternId: 'b' }, { documentId: 'synced-pattern:b', nodePath: [0], patternId: 'a' }] }; },
    ];
    for (const mutate of invalidCases) {
      const intent = await base(); mutate(intent);
      const diagnostics: Array<{ code: string }> = [];
      validateSiteIntent(intent, diagnostics as never);
      expect(diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('gates unused definitions in full-site compilation and preserves definition warnings with source attribution', async () => {
    const intent = await base();
    intent.assets = [];
    intent.assetUses = [];
    intent.pages = [intent.pages[0]!];
    intent.pages[0]!.body = { blocks: [{ block: 'core/paragraph', text: 'Page' }] };
    intent.syncedPatterns = declaration();
    intent.syncedPatterns.definitions.card.body.blocks[0]!.attrs!.metadata = { bindings: { content: { source: 'core/pattern-overrides' } } };
    const preparedInvalid = await (await import('../../src/site/input.js')).prepareSiteSource(intent, fixtureRoot);
    expect(preparedInvalid.ok).toBe(true);
    if (!preparedInvalid.ok) return;
    const invalidUnused = await compileSite(preparedInvalid.source);
    expect(invalidUnused.ok).toBe(false);
    if (!invalidUnused.ok) expect(invalidUnused.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pattern-override-contract' })]));

    intent.syncedPatterns = declaration();
    intent.syncedPatterns.definitions.card.body = { blocks: [{ block: 'core/image', url: 'https://example.test/remote.jpg', attrs: { alt: 'Remote' } }] };
    const preparedWarning = await (await import('../../src/site/input.js')).prepareSiteSource(intent, fixtureRoot);
    expect(preparedWarning.ok).toBe(true);
    if (!preparedWarning.ok) return;
    const result = await compileSite(preparedWarning.source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.site.syncedPatterns).toMatchObject([{ id: 'card', ok: true, content: expect.stringContaining('remote.jpg'), pendingUses: [], pendingBindings: [] }]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'warning', source: { path: 'site://sample-studio/synced-pattern:card' }, details: expect.objectContaining({ strict: false }) })]));
    }
    const strict = await compileSite(preparedWarning.source, { strict: true });
    expect(strict.ok).toBe(true);
    if (strict.ok) expect(strict.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'warning', source: { path: 'site://sample-studio/synced-pattern:card' }, details: expect.objectContaining({ strict: true }) })]));
  });

  it('isolates synced-pattern finalization from discovered config and applies theme.json token values', async () => {
    const intent = await base();
    intent.assets = [];
    intent.assetUses = [];
    intent.pages = [intent.pages[0]!];
    intent.pages[0]!.body = { blocks: [{ block: 'core/paragraph', text: 'Page' }] };
    intent.theme.themeJson.settings = { color: { palette: [{ slug: 'brand', name: 'Brand', color: '#123456' }] } };
    intent.syncedPatterns = { version: 1, definitions: { token: { title: 'Token', body: { blocks: [{ block: 'core/paragraph', text: 'Token', attrs: { style: { color: { text: '#123456' } } } }] } } }, uses: [] };
    const prepared = await (await import('../../src/site/input.js')).prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const cwd = process.cwd();
    const configRoot = await mkdtemp(path.join(os.tmpdir(), 'site-pattern-config-'));
    try {
      await writeFile(path.join(configRoot, 'block-runner.config.json'), JSON.stringify({ strict: true, tokens: { resolver: 'rest' } }));
      process.chdir(configRoot);
      const patterns = await compileSiteSyncedPatterns(prepared.source, { strict: false });
      expect(patterns[0]?.ok).toBe(true);
      expect(patterns[0]?.content).toContain('has-brand-color');
      expect(patterns[0]?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'valid', rule: 'token-repair', source: { path: 'site://sample-studio/synced-pattern:token' } })]));
    } finally {
      process.chdir(cwd);
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it('reconciles by logical ID and retains only complete managed pattern state', async () => {
    const intent = await base();
    intent.syncedPatterns = declaration(); intent.pages = [intent.pages[0]!]; intent.pages[0]!.status = 'draft';
    const { prepareSiteSource } = await import('../../src/site/input.js');
    const prepared = await prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const source: PreparedSiteSource = prepared.source;
    const theme: ThemeArtifact = { sourceIntent: intent, sourceAssets: [], targetBindings: {}, targetBindingFingerprint: 'bindings', themeFiles: [], syncedPatterns: [], pendingPageBindings: [], diagnostics: [], inventory: [], artifactIdentity: 'theme' };
    const compiled = await compileSiteSyncedPatterns(source, { patternBindings: { card: 642 } });
    const state = { title: 'Card', content: compiled[0]!.content!, status: 'publish' };
    const entity: SiteEntity = { id: 642, kind: 'pattern', route: null, state, ownership: [{ version: 1, siteId: intent.siteId, entityId: 'card', kind: 'pattern', lastAppliedHash: managedStateHash(state) }] };
    const snapshot: SiteSnapshot = { target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 1 }, runtime: { wordpress: '7.1.0', php: '8.4.0' }, principal: { userId: 1, capabilities: { edit_pages: true, edit_others_pages: true, edit_posts: true, edit_others_posts: true, publish_posts: true, publish_blocks: true, edit_published_posts: true, manage_options: true, edit_theme_options: true, upload_files: true } }, theme: { slug: intent.theme.slug, assetBaseUrl: 'https://example.test/theme', inventory: [] }, routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'rules', routes: [] }, entities: [entity], overrides: [], navigation: [], options: { show_on_front: 'page', page_on_front: 0 }, siteRecord: null };
    snapshot.siteRecord={version:1,siteId:intent.siteId,entities:{'pattern:card':642},options:{},operation:null};
    const plan = reconcileSitePlan(source, theme, [], snapshot, {}, [], compiled, { card: 642 });
    expect(plan.executable).toBe(true);
    expect(plan.operations.find((operation) => operation.kind === 'pattern')).toMatchObject({ action: 'retain', id: 642, entityId: 'card' });

    const missingEdit = structuredClone(snapshot);
    delete missingEdit.principal.capabilities.edit_published_posts;
    const editPlan = reconcileSitePlan(source, theme, [], missingEdit, {}, [], compiled, { card: 642 });
    expect(editPlan.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-capability', message: expect.stringContaining('edit_published_posts') })]));
    const newPatternTarget = structuredClone(snapshot);
    newPatternTarget.entities = [];
    delete newPatternTarget.principal.capabilities.publish_posts;
    delete newPatternTarget.principal.capabilities.publish_blocks;
    const createPlan = reconcileSitePlan(source, theme, [], newPatternTarget, {}, [], compiled, { card: 642 });
    expect(createPlan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-capability', message: expect.stringContaining('publish_posts') }),
      expect.objectContaining({ code: 'missing-capability', message: expect.stringContaining('publish_blocks') }),
    ]));

    intent.syncedPatterns!.definitions.card!.title = 'Renamed card';
    const renamedResult = await (await import('../../src/site/input.js')).prepareSiteSource(intent, fixtureRoot);
    expect(renamedResult.ok).toBe(true);
    if (!renamedResult.ok) return;
    const renamed: PreparedSiteSource = renamedResult.source;
    const updated = await compileSiteSyncedPatterns(renamed, { patternBindings: { card: 642 } });
    const updatePlan = reconcileSitePlan(renamed, { ...theme, sourceIntent: intent }, [], snapshot, {}, [], updated, { card: 642 });
    expect(updatePlan.operations.find((operation) => operation.kind === 'pattern')).toMatchObject({ action: 'update', id: 642, entityId: 'card', desired: { title: 'Renamed card' } });
  });

  it('blocks pending theme references while allowing explicit page references to remain pending', async () => {
    const intent = await base();
    intent.assets = []; intent.assetUses = []; intent.syncedPatterns = declaration();
    intent.templates.index!.body.blocks = [{ block: 'core/block' }];
    intent.syncedPatterns.uses = [{ documentId: 'template:index', nodePath: [0], patternId: 'card' }];
    const diagnostics: Array<{ path: string; code: string }> = [];
    validateSiteIntent(intent, diagnostics as never);
    expect(diagnostics).toHaveLength(0);
    const { prepareSiteSource } = await import('../../src/site/input.js');
    const prepared = await prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const compiled = await (await import('../../src/site/compile.js')).compileThemeDocuments(prepared.source);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) expect(compiled.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pattern-binding-required' })]));
  });

  it('keeps theme artifacts explicit about pending database dependencies and refuses them in full compilation', async () => {
    const intent = await base();
    intent.assets = [];
    intent.assetUses = [];
    intent.pages = [intent.pages[0]!];
    intent.pages[0]!.body = { blocks: [{ block: 'core/paragraph', text: 'Page' }] };
    intent.syncedPatterns = {
      version: 1,
      definitions: {
        card: declaration().definitions.card!,
        dependent: { title: 'Dependent', body: { blocks: [{ block: 'core/group', children: [{ block: 'core/block' }] }] } },
      },
      uses: [{ documentId: 'synced-pattern:dependent', nodePath: [0, 0], patternId: 'card' }],
    };
    const prepared = await (await import('../../src/site/input.js')).prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const theme = await (await import('../../src/site/compile.js')).compileThemeDocuments(prepared.source);
    expect(theme.ok).toBe(true);
    if (theme.ok) expect(theme.artifact.syncedPatterns.find((pattern) => pattern.id === 'dependent')?.pendingUses).toEqual([
      expect.objectContaining({ documentId: 'synced-pattern:dependent', patternId: 'card' }),
    ]);
    const full = await compileSite(prepared.source);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'pattern-binding-required' })]));
  });

  it('runs theme reference checks over finalized database pattern bodies', async () => {
    const intent = await base();
    intent.assets = [];
    intent.assetUses = [];
    intent.pages = [intent.pages[0]!];
    intent.pages[0]!.body = { blocks: [{ block: 'core/paragraph', text: 'Page' }] };
    intent.theme.themeJson.settings = { color: { defaultPalette: false } };
    intent.syncedPatterns = declaration();
    intent.syncedPatterns.definitions.card.body = { blocks: [{ block: 'core/group', attrs: { backgroundColor: 'missing-color' } }] };
    const prepared = await (await import('../../src/site/input.js')).prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const theme = await (await import('../../src/site/compile.js')).compileThemeDocuments(prepared.source);
    expect(theme.ok).toBe(false);
    if (!theme.ok) expect(theme.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'undeclared-preset',
      status: 'invalid',
      source: { path: 'site://sample-studio/synced-pattern:card' },
    })]));
  });

  it('allows declared media uses in owned pattern bodies and keeps missing bindings pending', async () => {
    const intent = await base();
    intent.syncedPatterns = declaration();
    intent.syncedPatterns.definitions.card!.body = { blocks: [{ block: 'core/image', url: '', attrs: { id: 0 } }] };
    const patternUse = { documentId: 'synced-pattern:card', nodePath: [0], attribute: 'attrs.id', assetId: 'home-hero' } as const;
    intent.assetUses.push({ ...patternUse, nodePath: [0] });
    const { prepareSiteSource } = await import('../../src/site/input.js');
    const prepared = await prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const pending = await compileSiteSyncedPatterns(prepared.source);
    expect(pending[0]).toMatchObject({ pendingBindings: [patternUse] });
    expect(pending[0]).not.toHaveProperty('content');
    const theme = await compileThemeDocuments(prepared.source, { themeAssetBaseUrl: 'https://example.test/theme' });
    expect(theme.ok, JSON.stringify(theme.diagnostics)).toBe(true);
    if (!theme.ok) return;
    expect(theme.artifact.targetBindings).toEqual({});
    const snapshot: SiteSnapshot = { target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 1 }, runtime: { wordpress: '7.1', php: '8.4' }, principal: { userId: 1, capabilities: { edit_pages: true, edit_others_pages: true, edit_posts: true, edit_others_posts: true, publish_posts: true, publish_blocks: true, publish_pages: true, manage_options: true, edit_theme_options: true, upload_files: true } }, theme: { slug: intent.theme.slug, assetBaseUrl: 'https://example.test/theme', inventory: theme.artifact.inventory }, routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'rules', routes: intent.pages.filter(page => page.route !== '/').map(page => ({ route: page.route, kind: 'available', matchedRule: 'native', queryFingerprint: 'native' })) }, entities: [], overrides: [], navigation: [], options: { show_on_front: 'posts', page_on_front: 0 }, siteRecord: null };
    const firstInstall = await planPreparedSite({ source: prepared.source, retainedBindings: {} }, snapshot);
    expect(firstInstall.executable, JSON.stringify(firstInstall.conflicts)).toBe(true);
    expect(firstInstall.operations.find(operation => operation.kind === 'pattern')).toMatchObject({ action: 'create', requiresFinalization: true, pendingBindings: [patternUse] });
    const bound = await compileSiteSyncedPatterns(prepared.source, { attachmentBindings: { 'home-hero': { id: 73, url: 'https://example.test/hero.png' } } });
    expect(bound[0]!.content).toContain('"id":73');
    const single = await compileSiteSyncedPattern(prepared.source, 'card', { attachmentBindings: { 'home-hero': { id: 73, url: 'https://example.test/hero.png' } } });
    expect(single).toMatchObject({ ok: true, pattern: { id: 'card', content: expect.stringContaining('"id":73') } });
    const compiler = createSiteSyncedPatternCompiler(prepared.source);
    expect(compiler.ok).toBe(true);
    if (compiler.ok) {
      const current = await compiler.compile('card', { attachmentBindings: { 'home-hero': { id: 74, url: 'https://example.test/current.png' } } });
      expect(current).toMatchObject({ ok: true, pattern: { id: 'card', content: expect.stringContaining('"id":74') } });
    }
    expect(createSiteSyncedPatternCompiler({ ...prepared.source, sourceIdentity: 'stale' })).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'prepared-source-identity-mismatch' })] });
    const missing = await compileSiteSyncedPattern(prepared.source, 'missing');
    expect(missing).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'unknown-pattern-id' })] });
    const invalidSource = await compileSiteSyncedPattern({ ...prepared.source, sourceIdentity: 'stale' }, 'card');
    expect(invalidSource).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'prepared-source-identity-mismatch' })] });
    const legacyIdentity = createHash('sha256').update(JSON.stringify(prepared.source.sourceIntent)).digest('hex');
    const legacy = await compileSiteSyncedPattern({ ...prepared.source, sourceIdentity: legacyIdentity }, 'card', { attachmentBindings: { 'home-hero': { id: 73, url: 'https://example.test/hero.png' } } });
    expect(legacy).toMatchObject({ ok: true, pattern: { id: 'card', content: expect.stringContaining('"id":73') } });
  });
});
