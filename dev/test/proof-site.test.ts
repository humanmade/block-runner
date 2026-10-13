import { cp, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { prepareSiteSource } from '../../src/site/input.js';
import { compileSite } from '../../src/site/compile.js';
import { realize } from '../../src/intent/index.js';
import { getWp } from '../../src/headless/wp.js';
import { writeCompiledSite } from '../../src/site/write.js';
import { prepareSiteProof, runSiteProof, SITE_PROOF_GATES, siteOwnedRecord, siteFixturePhp, topologicalSitePages, siteTrashOverridesPhp, runAfterSiteBinding, seedAccordionHeadingMismatch } from '../../src/proof/site.js';
import { EvidenceStore } from '../../src/proof/receipt.js';
import { evaluateProofProfile, PROOF_PROFILES } from '../../src/proof/profiles.js';
import type { ProofCommandResult } from '../../src/proof/runner.js';

const fixture = fileURLToPath(new URL('./fixtures/site-intent', import.meta.url));
async function bundle(published = true, pageCount = 5) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'block-runner-proof-site-'));
  await cp(fixture, path.join(root, 'source'), { recursive: true });
  const intent = JSON.parse(await readFile(path.join(root, 'source/site.intent.json'), 'utf8'));
  if (pageCount !== 5) intent.pages = intent.pages.slice(0, pageCount);
  if (published) for (const page of intent.pages) page.status = 'publish';
  const result = await prepareSiteSource(intent, path.join(root, 'source'));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const compiled = await compileSite(result.source, { attachmentBindings: { 'home-hero': { id: 321, url: 'http://localhost:8888/hero.png' } } });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const directory = path.join(root, 'bundle');
  await writeCompiledSite(directory, result.source, compiled.site);
  const evidence = new EvidenceStore(path.join(root, 'receipts'));
  return { root, directory, evidence };
}
const commandResult = (stdout = '', exitCode = 0): ProofCommandResult => ({ command: 'fixture-adapter', args: [], stdout, stderr: '', exitCode });

describe('controlled site proof', () => {
  it('seeds a valid native accordion heading with matching HTML for editor sync', async () => {
    const report = await realize(JSON.stringify({ blocks: [{ block: 'core/accordion', attrs: { iconPosition: 'left' }, children: [{ block: 'core/accordion-item', children: [{ block: 'core/accordion-heading', attrs: { title: 'Controlled heading', iconPosition: 'left' } }, { block: 'core/accordion-panel', children: [{ block: 'core/paragraph', text: 'Body' }] }] }] }] }), { isolateConfig: true });
    expect(report.ok).toBe(true);
    const seeded = await seedAccordionHeadingMismatch(report.output!);
    const wp = await getWp();
    const parsed = wp.parse(seeded);
    const flatten = (items: typeof parsed): typeof parsed => items.flatMap(block => [block, ...flatten(block.innerBlocks)]);
    expect(parsed[0]!.attributes.iconPosition).toBe('left');
    expect(flatten(parsed).find(block => block.name === 'core/accordion-heading')!.attributes.iconPosition).toBe('right');
    expect(seeded).toContain('has-icon-right');
    expect(flatten(parsed).every(block => wp.validateBlock(block)[0])).toBe(true);
    expect(wp.serialize(parsed)).toBe(seeded);
    const ordinary = '<!-- wp:paragraph -->\n<p>Ordinary</p>\n<!-- /wp:paragraph -->';
    expect(await seedAccordionHeadingMismatch(ordinary)).toBe(ordinary);
  });
  it('pins the explicit published variant without promoting the ordinary draft fixture', async () => {
    const draft = await bundle(false);
    await expect(prepareSiteProof(draft.directory, draft.evidence)).rejects.toThrow('draft statuses are never promoted');
    const control = await bundle(true, 2);
    const prepared = await prepareSiteProof(control.directory, control.evidence);
    expect(prepared.source.sourceIntent.pages).toHaveLength(2);
    expect(prepared.theme.slug).toBe('sample-studio');
    expect(prepared.bundleHash).toMatch(/^sha256:/);
    expect(prepared.source.sourceIntent.pages.every((page) => page.status === 'publish')).toBe(true);
  });
  it('rejects changed bundle bytes before runtime setup', async () => {
    const input = await bundle();
    await writeFile(path.join(input.directory, 'theme/style.css'), 'changed');
    await expect(prepareSiteProof(input.directory, input.evidence)).rejects.toThrow('inventory mismatch');
  });
  it('rejects an asset mutation between inventory verification and source preparation', async () => {
    const input = await bundle();
    const assetPath = path.join(input.directory, 'source/assets/media/hero.png');
    const originalBytes = await readFile(assetPath);
    const originalPut = input.evidence.put.bind(input.evidence);
    let mutated = false;
    vi.spyOn(input.evidence, 'put').mockImplementation(async (value, options) => {
      const reference = await originalPut(value, options);
      if (!mutated && value instanceof Uint8Array && Buffer.from(value).equals(originalBytes)) {
        mutated = true;
        await writeFile(assetPath, Buffer.concat([originalBytes, Buffer.from('mutation')]));
      }
      return reference;
    });
    await expect(prepareSiteProof(input.directory, input.evidence)).rejects.toThrow('Prepared source asset differs from verified bundle inventory');
    expect(mutated).toBe(true);
  });
  it('requires every independent gate and refuses failed, skipped, blocked or missing outcomes', () => {
    const profile = PROOF_PROFILES.site;
    const records = profile.requiredGates.map((gate) => ({ gate, status: 'pass' as const }));
    expect(evaluateProofProfile('site', records).ok).toBe(true);
    for (const gate of profile.requiredGates) for (const status of ['fail', 'skip', 'blocked'] as const) {
      expect(evaluateProofProfile('site', records.map((record) => record.gate === gate ? { ...record, status } : record)).ok).toBe(false);
    }
    expect(evaluateProofProfile('site', records.slice(1)).ok).toBe(false);
  });
  it('keeps cleanup ownership and option restoration guards explicit', () => {
    expect(siteOwnedRecord({ id: 21, marker: 'owned' }, 'owned', 21)).toBe(true);
    expect(siteOwnedRecord({ id: 21, marker: 'other' }, 'owned', 21)).toBe(false);
    const cleanup = siteFixturePhp('owned', 'cleanup', {});
    expect(cleanup.indexOf('Unowned runtime or principal')).toBeLessThan(cleanup.indexOf('wp_trash_post'));
    expect(cleanup).toContain("get_post_meta($id,'_block_runner_proof',true)!==$marker");
    expect(cleanup).toContain('$preserved[]=$id');
    expect(cleanup.indexOf('$frontBefore=')).toBeLessThan(cleanup.indexOf('wp_trash_post'));
    expect(cleanup).toContain("$frontTrashReset=$frontAfter['show_on_front']==='posts' && $frontAfter['page_on_front']===0");
    expect(cleanup).toContain('$restoreFront=$frontOwned && ($frontAfter===$frontBefore || $frontTrashReset)');
    expect(cleanup).toContain("$frontBefore['page_on_front']===(int)$expected['page_on_front']");
  });
  it('sorts nested pages and rejects unresolved parents', () => {
    expect(topologicalSitePages([{ id: 'child', parentId: 'parent' }, { id: 'parent' }]).map((page) => page.id)).toEqual(['parent', 'child']);
    expect(() => topologicalSitePages([{ id: 'child', parentId: 'absent' }])).toThrow('unresolved');
    const cleanup = siteTrashOverridesPhp('owned', [{ id: 1, content: 'exact', postType: 'wp_template_part' }]);
    expect(cleanup).toContain('wp_trash_post');
    expect(cleanup).not.toContain('wp_delete');
  });
  it('accepts optional editor readiness only for the exact current entity', async () => {
    // @ts-expect-error The bundled helper is a standalone ESM script.
    const { mountedEditorTargetReady } = await import('../../scripts/proof-site-playwright.mjs');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'wp');
    let editor: Record<string, unknown> = { getCurrentPostId: () => 81 };
    Object.defineProperty(globalThis, 'wp', { configurable: true, value: { blocks: { serialize: () => '' }, data: { select: () => editor } } });
    try {
      expect(mountedEditorTargetReady(81)).toBe(true);
      expect(mountedEditorTargetReady(82)).toBe(false);
      editor = { getCurrentPostId: () => 81, isEditorReady: () => false };
      expect(mountedEditorTargetReady(81)).toBe(false);
      editor = { getCurrentPostId: () => 'sample-studio//footer', isEditorReady: () => true };
      expect(mountedEditorTargetReady('sample-studio//footer')).toBe(true);
      expect(mountedEditorTargetReady('sample-studio//header')).toBe(false);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'wp', previous);
      else Reflect.deleteProperty(globalThis, 'wp');
    }
  });
  it.each(['Close', 'Get started'])('dismisses the observed native guide with %s through its UI', async (buttonName) => {
    // @ts-expect-error The bundled helper is a standalone ESM script.
    const { dismissSiteEditorGuides } = await import('../../scripts/proof-site-playwright.mjs');
    let visible = true;
    const click = vi.fn(async () => { visible = false; });
    const guide = {
      isVisible: async () => visible,
      getByRole: (_role: string, options: { name: RegExp }) => ({ isVisible: async () => options.name.test(buttonName), click }),
      waitFor: vi.fn(async () => { expect(visible).toBe(false); }),
    };
    const filter = vi.fn((_options: { hasText: RegExp }) => ({ first: () => guide }));
    expect(await dismissSiteEditorGuides({ getByRole: () => ({ filter }) })).toBe(true);
    expect(filter.mock.calls[0]![0]?.hasText.test('Welcome to the editor')).toBe(true);
    expect(filter.mock.calls[0]![0]?.hasText.test('Delete this page')).toBe(false);
    expect(click).toHaveBeenCalledOnce();
    expect(guide.waitFor).toHaveBeenCalledWith({ state: 'hidden' });
  });
  it('retains a helper timeout and actual URL with a failure capture request', async () => {
    // @ts-expect-error The bundled helper is a standalone ESM script.
    const { recordSiteHelperFailure } = await import('../../scripts/proof-site-playwright.mjs');
    const report = { screenshots: [] as string[] };
    const screenshot = vi.fn(async () => {});
    const failure = await recordSiteHelperFailure(report, { url: () => 'http://localhost:8899/wp-login.php', screenshot }, new Error('login wait timed out'), '/tmp', { postType: 'wp_template_part' });
    expect(failure).toMatchObject({ message: 'login wait timed out', url: 'http://localhost:8899/wp-login.php', postType: 'wp_template_part', screenshot: 'failure-0.png' });
    expect(screenshot).toHaveBeenCalledWith({ path: '/tmp/failure-0.png', fullPage: true });
    expect(JSON.stringify(report)).not.toContain('Wrong runtime marker');
  });
  it('blocks parity until fixture setup passes and the bound theme is assigned', async () => {
    const parity = vi.fn(async () => ({ status: 'pass' as const }));
    expect((await runAfterSiteBinding({ status: 'blocked' }, true, parity)).status).toBe('blocked');
    expect((await runAfterSiteBinding({ status: 'pass' }, false, parity)).status).toBe('blocked');
    expect(parity).not.toHaveBeenCalled();
    expect((await runAfterSiteBinding({ status: 'pass' }, true, parity)).status).toBe('pass');
    expect(parity).toHaveBeenCalledOnce();
  });
  it('wrong target preflight performs zero page or media fixture writes', async () => {
    const input = await bundle();
    const site = await prepareSiteProof(input.directory, input.evidence);
    const writes: string[] = [];
    const result = await runSiteProof({ site, stagedTheme: path.join(input.root, 'staged'), baseUrl: 'http://localhost:8888', helper: 'fixture-helper', evidence: input.evidence, negativeControl: 'wrong-target',
      wp: async (php) => { writes.push(php); if (php.includes('get_user_by')) return commandResult('1'); return commandResult(php.includes('echo base64_encode') ? Buffer.from('original').toString('base64') : ''); },
      command: async (_command, args) => { await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify({ runtimeBinding: { verified: false } })); return commandResult('', 1); },
    });
    expect(writes.some((php) => php.includes('wp_insert_post') || php.includes('wp_insert_attachment'))).toBe(false);
    expect(result.gates.site_fixture?.status).toBe('blocked');
  });
  it.each([undefined, 'missing-content', 'broken-asset', 'broken-mobile'] as const)('seeds %s only after browser target verification', async (negativeControl) => {
    const input = await bundle();
    const site = await prepareSiteProof(input.directory, input.evidence);
    const writes: string[] = [];
    const identities: any[] = [];
    const originalPutJson = input.evidence.putJson.bind(input.evidence);
    vi.spyOn(input.evidence, 'putJson').mockImplementation(async (value: any) => { if (value.targetBuildHash) identities.push(value); return originalPutJson(value); });
    let browserCalls = 0;
    const result = await runSiteProof({ site, stagedTheme: path.join(input.root, 'staged/sample-studio'), baseUrl: 'http://localhost:8888', helper: 'fixture-helper', evidence: input.evidence, negativeControl,
      wp: async (php) => {
        writes.push(php);
        if (php.includes('get_user_by')) return commandResult('1');
        if (php.includes('get_stylesheet_directory_uri')) return commandResult('http://localhost:8888/custom-themes/sample-studio');
        if (php.includes('echo base64_encode')) return commandResult(Buffer.from('original').toString('base64'));
        if (php.includes('wp_insert_attachment')) return commandResult(JSON.stringify({ 'home-hero': { id: 71, url: 'http://localhost:8888/owned-image.png' } }));
        if (php.includes('wp_insert_post')) return commandResult(JSON.stringify({ home: 81, about: 82, services: 83, consulting: 84, contact: 85 }));
        if (php.includes('wp_trash_post')) return commandResult('{"preserved":[]}');
        return commandResult();
      },
      command: async (_command, args) => {
        browserCalls++;
        if (browserCalls === 2) {
          const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1]!, 'utf8'));
          expect(config.themeAssets).toContain('assets/styles/site.css');
          expect(config.themeAssets).not.toContain('functions.php');
        }
        const report = browserCalls === 1 ? { runtimeBinding: { verified: true }, principal: { id: 1 } } : { gates: Object.fromEntries(SITE_PROOF_GATES.map((gate) => [gate, { status: gate === (negativeControl ? { 'missing-content': 'site_content', 'broken-asset': 'site_assets', 'broken-mobile': 'site_navigation' }[negativeControl] : undefined) ? 'fail' : 'pass' }])) };
        await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify(report));
        return commandResult();
      },
    });
    expect(browserCalls).toBe(2);
    expect(identities).toHaveLength(1);
    expect(result.theme?.manifest.files.some((file) => file.file === 'functions.php')).toBe(true);
    if (!negativeControl) expect(Object.hasOwn(identities[0], 'negativeControl')).toBe(false);
    expect(result.gates.site_cleanup?.status).toBe('pass');
    if (negativeControl) expect(result.gates[({ 'missing-content': 'site_content', 'broken-asset': 'site_assets', 'broken-mobile': 'site_navigation' } as const)[negativeControl]]?.status).toBe('fail');
    else expect(result.gates.site_fixture?.status).toBe('pass');
    const pageWrite = writes.find((php) => php.includes('wp_insert_post'))!;
    const encoded = /\$data=json_decode\(base64_decode\('([^']+)'\)/.exec(pageWrite)![1]!;
    const seeded = JSON.parse(Buffer.from(encoded, 'base64').toString());
    if (negativeControl === 'missing-content') expect(seeded.pages[0].content).toBe('');
    if (negativeControl === 'broken-asset') expect(seeded.pages[0].content).toContain('missing-proof-image');
    if (negativeControl === 'broken-mobile') expect(await readFile(path.join(input.root, 'staged/sample-studio/assets/styles/site.css'), 'utf8')).toContain('pointer-events:none');
  });
});
