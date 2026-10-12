import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateSiteIntent } from '../../src/site/input.js';
import { compileSitePageDocuments, compileSiteSyncedPatterns } from '../../src/site/compile.js';
import type { PreparedSiteSource, SiteIntent, ThemeArtifact } from '../../src/site/types.js';
import { managedStateHash, reconcileSitePlan } from '../../src/site/plan.js';
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

  it('reconciles by logical ID and retains only complete managed pattern state', async () => {
    const intent = await base();
    intent.syncedPatterns = declaration(); intent.pages = [intent.pages[0]!]; intent.pages[0]!.status = 'draft';
    const { prepareSiteSource } = await import('../../src/site/input.js');
    const prepared = await prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const source: PreparedSiteSource = prepared.source;
    const theme: ThemeArtifact = { sourceIntent: intent, sourceAssets: [], targetBindings: {}, targetBindingFingerprint: 'bindings', themeFiles: [], pendingPageBindings: [], diagnostics: [], inventory: [], artifactIdentity: 'theme' };
    const compiled = await compileSiteSyncedPatterns(source, { patternBindings: { card: 642 } });
    const state = { title: 'Card', content: compiled[0]!.content!, status: 'publish' };
    const entity: SiteEntity = { id: 642, kind: 'pattern', route: null, state, ownership: [{ version: 1, siteId: intent.siteId, entityId: 'card', kind: 'pattern', lastAppliedHash: managedStateHash(state) }] };
    const snapshot: SiteSnapshot = { target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 1 }, runtime: { wordpress: '7.1.0', php: '8.4.0' }, principal: { userId: 1, capabilities: { edit_pages: true, edit_others_pages: true, edit_posts: true, edit_others_posts: true, manage_options: true, edit_theme_options: true, upload_files: true } }, theme: { slug: intent.theme.slug, assetBaseUrl: 'https://example.test/theme', inventory: [] }, routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'rules', routes: [] }, entities: [entity], overrides: [], navigation: [], options: { show_on_front: 'page', page_on_front: 0 }, siteRecord: null };
    const plan = reconcileSitePlan(source, theme, [], snapshot, {}, [], compiled, { card: 642 });
    expect(plan.executable).toBe(true);
    expect(plan.operations.find((operation) => operation.kind === 'pattern')).toMatchObject({ action: 'retain', id: 642, entityId: 'card' });

    intent.syncedPatterns!.definitions.card!.title = 'Renamed card';
    const renamed: PreparedSiteSource = { ...source, sourceIntent: intent };
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

  it('allows declared media uses in owned pattern bodies and keeps missing bindings pending', async () => {
    const intent = await base();
    intent.syncedPatterns = declaration();
    intent.syncedPatterns.definitions.card!.body = { blocks: [{ block: 'core/image', url: '', attrs: { id: 0 } }] };
    intent.assetUses = [{ documentId: 'synced-pattern:card', nodePath: [0], attribute: 'attrs.id', assetId: 'home-hero' }];
    const { prepareSiteSource } = await import('../../src/site/input.js');
    const prepared = await prepareSiteSource(intent, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const pending = await compileSiteSyncedPatterns(prepared.source);
    expect(pending[0]).toMatchObject({ pendingBindings: intent.assetUses });
    expect(pending[0]).not.toHaveProperty('content');
    const bound = await compileSiteSyncedPatterns(prepared.source, { attachmentBindings: { 'home-hero': { id: 73, url: 'https://example.test/hero.png' } } });
    expect(bound[0]!.content).toContain('"id":73');
  });
});
