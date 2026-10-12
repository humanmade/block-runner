import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { compileSite, compileThemeDocuments } from '../../src/site/compile.js';
import { prepareSiteSource } from '../../src/site/input.js';
import type { SiteIntent } from '../../src/site/types.js';
import * as intentModule from '../../src/intent/index.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
const intentPath = fileURLToPath(new URL('./fixtures/site-intent/site.intent.json', import.meta.url));

async function prepareAssetFreeIntent(mutate?: (intent: SiteIntent) => void) {
  const input = JSON.parse(await readFile(intentPath, 'utf8')) as SiteIntent;
  input.assets = [];
  input.assetUses = [];
  input.pages[0]!.body.blocks = input.pages[0]!.body.blocks.filter((block) => block.block !== 'core/image');
  mutate?.(input);
  const prepared = await prepareSiteSource(input, fixtureRoot);
  if (!prepared.ok) throw new Error(prepared.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('\n'));
  return prepared.source;
}

describe('site compiler', () => {
  it('compiles the five-page fixture deterministically through the shared finalizer', async () => {
    const source = await prepareAssetFreeIntent();
    const first = await compileSite(source);
    const second = await compileSite(source);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.site.themeFiles.map((file) => file.path)).toEqual([
      'parts/footer.html',
      'parts/header.html',
      'patterns/featured-services.php',
      'style.css',
      'templates/index.html',
      'theme.json',
    ]);
    expect(new TextDecoder().decode(first.site.themeFiles.find((file) => file.path === 'style.css')!.bytes)).toContain('\nVersion: 0.1.0\n');
    expect(first.site.pages.map((page) => page.id)).toEqual(['home', 'about', 'services', 'consulting', 'contact']);
    expect(first.site.themeFiles).toEqual(second.site.themeFiles);
    expect(first.site.pages).toEqual(second.site.pages);
    expect(first.site.inventory).toEqual(second.site.inventory);
    expect(first.site.inventory).toEqual(first.site.themeFiles.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.bytes.byteLength,
    })));

    const template = new TextDecoder().decode(first.site.themeFiles.find((file) => file.path === 'templates/index.html')!.bytes);
    expect(template).toContain('<!-- wp:post-content /-->');
    expect(template).not.toContain('Clear ideas, well made');
    expect(first.site.pages[0]?.content).toContain('Clear ideas, well made');
    expect(new TextDecoder().decode(first.site.themeFiles.find((file) => file.path === 'patterns/featured-services.php')!.bytes))
      .toContain('* Slug: featured-services');
  });

  it('preserves an explicitly empty page body and reports its zero-block output honestly', async () => {
    const source = await prepareAssetFreeIntent((intent) => { intent.pages[0]!.body = { blocks: [] }; });
    const result = await compileSite(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.site.pages[0]).toMatchObject({ id: 'home', content: '', status: 'publish', diagnostics: [] });
  });

  it('keeps Gutenberg native attribute order in finalized page markup', async () => {
    const source = await prepareAssetFreeIntent((intent) => {
      intent.pages[1]!.body.blocks.unshift({
        block: 'core/group',
        attrs: { tagName: 'section', layout: { type: 'constrained' }, className: 'ordered' },
      });
    });
    const result = await compileSite(source);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.site.pages.find((page) => page.id === 'about')?.content)
      .toContain('<!-- wp:group {"tagName":"section","className":"ordered","layout":{"type":"constrained"}} -->');
  });

  it('rejects undeclared presets used only by a page and accepts block-scoped page presets', async () => {
    const missingSource = await prepareAssetFreeIntent((intent) => {
      intent.theme.themeJson.settings = {
        color: { defaultPalette: false, palette: [] },
      };
      intent.pages[0]!.body.blocks.unshift({ block: 'core/group', attrs: { backgroundColor: 'page-only-missing' } });
    });
    const missing = await compileSite(missingSource);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics).toContainEqual(expect.objectContaining({
      code: 'undeclared-preset',
      status: 'invalid',
      source: { path: 'site://sample-studio/page:home' },
      details: expect.objectContaining({ kind: 'color', slug: 'page-only-missing' }),
    }));

    const scopedSource = await prepareAssetFreeIntent((intent) => {
      intent.theme.themeJson.settings = {
        color: { defaultPalette: false, palette: [] },
        blocks: {
          'core/group': {
            color: { defaultPalette: false, palette: [{ slug: 'page-only', name: 'Page Only', color: '#123456' }] },
          },
        },
      };
      intent.pages[0]!.body.blocks.unshift({ block: 'core/group', attrs: { backgroundColor: 'page-only' } });
    });
    const scoped = await compileSite(scopedSource);
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.diagnostics.some((item) => item.code === 'undeclared-preset')).toBe(false);
  });

  it('binds both attachment ID and URL for native image and cover URL-use forms', async () => {
    const binding = { 'home-hero': { id: 731, url: 'https://media.example.test/hero.png' } };
    for (const block of ['core/image', 'core/cover'] as const) {
      for (const attribute of ['url', 'attrs.url', 'attrs.src'] as const) {
        const input = JSON.parse(await readFile(intentPath, 'utf8')) as SiteIntent;
        const node = {
          block,
          attrs: { id: 0, ...(attribute === 'attrs.src' ? { src: '' } : { url: '' }) },
          ...(attribute === 'url' ? { url: '' } : {}),
        };
        input.pages[0]!.body.blocks[2] = node;
        input.assetUses = [{ documentId: 'page:home', nodePath: [2], attribute, assetId: 'home-hero' }];
        const prepared = await prepareSiteSource(input, fixtureRoot);
        expect(prepared.ok, `${block} ${attribute} source preparation`).toBe(true);
        if (!prepared.ok) continue;
        const source = prepared.source;
        const result = await compileSite(source, { attachmentBindings: binding });
        expect(result.ok, `${block} ${attribute}`).toBe(true);
        if (result.ok) {
          const content = result.site.pages[0]!.content;
          expect(content).toContain('https://media.example.test/hero.png');
          expect(content).toContain('"id":731');
        }
      }
    }
  });

  it('reports an unknown native block against its source document and emits no partial site', async () => {
    const source = await prepareAssetFreeIntent((intent) => {
      intent.parts.header!.body.blocks[0]!.block = 'core/not-a-registered-block';
    });
    const result = await compileSite(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'invalid', source: { path: 'site://sample-studio/part:header' } }),
    ]));
  });

  it('does not load a write-capable project config or invoke fetch during compilation', async () => {
    const source = await prepareAssetFreeIntent((intent) => {
      intent.pages[1]!.body.blocks.push({ block: 'core/image', attrs: { url: 'https://assets.example.test/photo.png' } });
    });
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'block-runner-site-compile-'));
    const previousDirectory = process.cwd();
    const previousFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };
    try {
      await writeFile(path.join(temporaryDirectory, 'block-runner.config.mjs'), [
        'globalThis.__siteCompilerConfigLoaded = true;',
        'export default { media: { resolver: "rest" }, tokens: { resolver: "rest" } };',
      ].join('\n'));
      delete (globalThis as typeof globalThis & { __siteCompilerConfigLoaded?: boolean }).__siteCompilerConfigLoaded;
      process.chdir(temporaryDirectory);
      const result = await compileSite(source);
      expect(result.ok).toBe(true);
      expect((globalThis as typeof globalThis & { __siteCompilerConfigLoaded?: boolean }).__siteCompilerConfigLoaded).toBeUndefined();
      expect(fetchCalls).toBe(0);
    } finally {
      process.chdir(previousDirectory);
      globalThis.fetch = previousFetch;
      delete (globalThis as typeof globalThis & { __siteCompilerConfigLoaded?: boolean }).__siteCompilerConfigLoaded;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('fails the site when strict finalization fails with a warning-only producer report', async () => {
    const source = await prepareAssetFreeIntent();
    const original = intentModule.realize;
    const spy = vi.spyOn(intentModule, 'realize').mockImplementation(async (rawIntent, options) => {
      if (options?.sourcePath?.endsWith('/page:about')) {
        return {
          ok: false,
          command: 'assemble',
          summary: { blocks: 1, valid: 1, invalid: 0, warnings: 1 },
          items: [{ status: 'warning', reason: 'strict media resolution warning', source: { path: options?.sourcePath } }],
          output: '<!-- wp:paragraph --><p>About</p><!-- /wp:paragraph -->',
        };
      }
      return original(rawIntent, options);
    });
    try {
      const result = await compileSite(source, { strict: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'warning', reason: 'strict media resolution warning' }),
        expect.objectContaining({ status: 'invalid', code: 'document-finalization-failed', details: { documentId: 'page:about' } }),
      ]));
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects static pattern header injection and reports pending page media in theme-only output', async () => {
    const injected = await prepareAssetFreeIntent((intent) => {
      intent.patterns['featured-services']!.title = 'Featured */ ?><?php echo 1; ?>';
    });
    const rejected = await compileSite(injected);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern-header', status: 'invalid' }));

    const full = JSON.parse(await readFile(intentPath, 'utf8')) as SiteIntent;
    full.pages[0]!.body.blocks[0]!.block = 'core/not-a-registered-block';
    const prepared = await prepareSiteSource(full, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const theme = await compileThemeDocuments(prepared.source);
    expect(theme.ok).toBe(true);
    if (theme.ok) {
      expect(theme.artifact.pendingPageBindings).toEqual(full.assetUses);
      expect(theme.artifact.themeFiles.map((file) => file.path)).toContain('assets/styles/site.css');
      expect(theme.artifact.themeFiles.map((file) => file.path)).toContain('functions.php');
      expect(theme.artifact.inventory).toEqual(theme.artifact.themeFiles.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.bytes.byteLength,
      })));
    }
  });

  it('retains theme target bindings and the supplied public theme URL in its identity', async () => {
    const input = JSON.parse(await readFile(intentPath, 'utf8')) as SiteIntent;
    input.parts.header!.body.blocks[0]!.children!.push({
      block: 'core/image',
      attrs: { id: 0, url: '', alt: 'Theme-owned image' },
    });
    input.assetUses.push({ documentId: 'part:header', nodePath: [0, 2], attribute: 'attrs.id', assetId: 'home-hero' });
    const prepared = await prepareSiteSource(input, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const options = {
      attachmentBindings: { 'home-hero': { id: 731, url: 'https://media.example.test/hero.png' } },
      themeAssetBaseUrl: 'https://themes.example.test/sample-studio/',
    };
    const first = await compileThemeDocuments(prepared.source, options);
    const completeSite = await compileSite(prepared.source, options);
    const changedBinding = await compileThemeDocuments(prepared.source, {
      ...options,
      attachmentBindings: { 'home-hero': { id: 731, url: 'https://media.example.test/other.png' } },
    });
    expect(first.ok).toBe(true);
    expect(changedBinding.ok).toBe(true);
    if (first.ok && changedBinding.ok) {
      expect(first.artifact.targetBindings).toEqual(options.attachmentBindings);
      expect(first.artifact.themeAssetBaseUrl).toBe(options.themeAssetBaseUrl);
      expect(first.artifact.targetBindingFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(first.artifact.targetBindingFingerprint).not.toBe(changedBinding.artifact.targetBindingFingerprint);
      expect(first.artifact.artifactIdentity).not.toBe(changedBinding.artifact.artifactIdentity);
    }
    expect(completeSite.ok).toBe(true);
    if (completeSite.ok) {
      expect(completeSite.site.themeFiles.map((file) => file.path)).toContain('assets/styles/site.css');
      expect(completeSite.site.themeFiles.map((file) => file.path)).toContain('functions.php');
      expect(completeSite.site.assets.map((file) => file.path)).toEqual(['assets/styles/site.css', 'functions.php']);
      expect(completeSite.site.inventory).toEqual(completeSite.site.themeFiles.map((file) => ({
        path: file.path,
        sha256: file.sha256,
        size: file.bytes.byteLength,
      })));
    }
  });
});
