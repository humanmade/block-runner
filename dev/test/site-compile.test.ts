import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileSite, compileThemeDocuments } from '../../src/site/compile.js';
import { prepareSiteSource } from '../../src/site/input.js';
import type { SiteIntent } from '../../src/site/types.js';

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
    expect(first.site.pages.map((page) => page.id)).toEqual(['home', 'about', 'services', 'consulting', 'contact']);
    expect(first.site.themeFiles).toEqual(second.site.themeFiles);
    expect(first.site.pages).toEqual(second.site.pages);
    expect(first.site.inventory).toEqual(second.site.inventory);

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

  it('rejects static pattern header injection and reports pending page media in theme-only output', async () => {
    const injected = await prepareAssetFreeIntent((intent) => {
      intent.patterns['featured-services']!.title = 'Featured */ ?><?php echo 1; ?>';
    });
    const rejected = await compileSite(injected);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsafe-pattern-header', status: 'invalid' }));

    const full = JSON.parse(await readFile(intentPath, 'utf8')) as SiteIntent;
    const prepared = await prepareSiteSource(full, fixtureRoot);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const theme = await compileThemeDocuments(prepared.source);
    expect(theme.ok).toBe(true);
    if (theme.ok) expect(theme.artifact.pendingPageBindings).toEqual(full.assetUses);
  });
});
