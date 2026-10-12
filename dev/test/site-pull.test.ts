import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hashBytes } from '../../src/publication.js';
import { compileThemeDocuments } from '../../src/site/compile.js';
import { inspectSiteDrift } from '../../src/site/drift.js';
import { confirmSitePull, previewSitePull, type SitePullSelection } from '../../src/site/pull.js';
import { planSite, readSitePlanInput } from '../../src/site/plan.js';
import { writeCompiledSite } from '../../src/site/write.js';
import type { SiteSnapshot } from '../../src/site/plan-types.js';
import type { PreparedSiteSource } from '../../src/site/types.js';
import type { SiteTemplateSnapshot } from '../../src/site/wpcli.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent/', import.meta.url));
const intentFile = path.join(fixtureRoot, 'site.intent.json');
const run = promisify(execFile);
const editedMarkup = '<!-- wp:paragraph --><p>Saved editor change.</p><!-- /wp:paragraph -->';

interface PullFixture {
  root: string;
  bundle: string;
  source: PreparedSiteSource;
  snapshot: SiteSnapshot;
  templates: SiteTemplateSnapshot;
  selection: SitePullSelection;
  sourcePath: string;
  originalBytes: Buffer;
  options: Parameters<typeof previewSitePull>[3];
  setTemplates(value: SiteTemplateSnapshot): void;
}

async function fixture(selections = 1): Promise<PullFixture> {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'site-pull-'));
  const bundle = path.join(root, 'bundle');
  const input = await readSitePlanInput(intentFile, fixtureRoot);
  const themeRoot = `https://example.test/wp-content/themes/${input.source.sourceIntent.theme.slug}`;
  const compiled = await compileThemeDocuments(input.source, { themeAssetBaseUrl: themeRoot });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  await writeCompiledSite(bundle, input.source, compiled.artifact);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'site.manifest.json'), 'utf8')) as { bundleFiles: Array<{ path: string }> };
  const entities: SiteTemplateSnapshot['entities'] = [];
  let selected: SitePullSelection | undefined;
  let sourcePath = '';
  let customCount = 0;
  for (const entry of manifest.bundleFiles.filter(item => /^theme\/(?:templates|parts)\/.*\.html$/.test(item.path))) {
    const kind: SitePullSelection['kind'] = entry.path.startsWith('theme/parts/') ? 'part' : 'template';
    const type = kind === 'part' ? 'wp_template_part' : 'wp_template';
    const relative = entry.path.replace(/^theme\/(?:templates|parts)\//, '').replace(/\.html$/, '');
    const id = `${input.source.sourceIntent.theme.slug}//${relative}`;
    const raw = await readFile(path.join(bundle, entry.path), 'utf8');
    const isSelected = customCount < selections;
    const wpId = isSelected ? 71 + customCount : 0;
    entities.push({ id, theme: input.source.sourceIntent.theme.slug, type, source: isSelected ? 'custom' : 'theme', wpId, raw: isSelected ? editedMarkup : raw });
    if (isSelected) {
      selected ??= { kind, entityId: id, wpId };
      if (!sourcePath) sourcePath = entry.path;
      customCount++;
    }
  }
  if (!selected || customCount < selections) throw new Error('fixture did not contain enough source-mapped templates or parts');
  const snapshot: SiteSnapshot = {
    target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 3 },
    runtime: { wordpress: '7.1.2', php: '8.4.26' },
    principal: { userId: 7, capabilities: { edit_pages: true, edit_posts: true, edit_others_pages: true, edit_others_posts: true, manage_options: true, edit_theme_options: true } },
    theme: { slug: input.source.sourceIntent.theme.slug, assetBaseUrl: themeRoot, inventory: compiled.artifact.inventory },
    routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'rules-hash', routes: [] },
    entities: [], overrides: [], navigation: [], options: {}, siteRecord: null,
  };
  let currentTemplates: SiteTemplateSnapshot = {
    target: { ...snapshot.target }, theme: snapshot.theme.slug,
    principal: { userId: 7, userLogin: 'editor', canReadEditContext: true },
    runtime: { wordpress: '7.1.2' }, entities,
  };
  const options: Parameters<typeof previewSitePull>[3] = {
    wpPath: '/wp',
    snapshotTransport: async () => JSON.stringify(snapshot),
    templateTransport: async () => JSON.stringify(currentTemplates),
  };
  return {
    root, bundle, source: input.source, snapshot, templates: currentTemplates, selection: selected, sourcePath,
    originalBytes: await readFile(path.join(bundle, sourcePath)), options,
    setTemplates(value) { currentTemplates = value; },
  };
}

describe('bounded site template and part pull', () => {
  it('stages, hash-confirms and adopts exact mapped editor markup without changing SiteIntent', async () => {
    const f = await fixture();
    const intentBefore = await readFile(path.join(f.bundle, 'site.intent.json'));
    const preview = path.join(f.root, 'preview');
    const staged = await previewSitePull(f.bundle, preview, [f.selection], f.options);
    expect(staged.ok).toBe(true);
    expect(staged.confirmationHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(staged.files).toContainEqual(expect.objectContaining({ path: f.sourcePath, changed: true }));
    expect(await readFile(path.join(f.bundle, f.sourcePath))).toEqual(f.originalBytes);

    const adopted = await confirmSitePull(f.bundle, preview, staged.confirmationHash!, f.options);
    expect(adopted.completed).toEqual([f.sourcePath, 'site.manifest.json']);
    expect(await readFile(path.join(f.bundle, f.sourcePath), 'utf8')).toBe(editedMarkup);
    expect(await readFile(path.join(f.bundle, 'site.intent.json'))).toEqual(intentBefore);
    const manifest = JSON.parse(await readFile(path.join(f.bundle, 'site.manifest.json'), 'utf8')) as {
      sourceIntentState: string; sourceIdentity: string; bundleFiles: Array<{ path: string; sha256: string; size: number }>; inventory: Array<{ path: string; sha256: string; size: number }>;
    };
    expect(manifest.sourceIntentState).toBe('unreconciled');
    expect(manifest.sourceIdentity).toBe(f.source.sourceIdentity);
    expect(manifest.bundleFiles.find(item => item.path === f.sourcePath)).toMatchObject({ sha256: hashBytes(Buffer.from(editedMarkup)), size: Buffer.byteLength(editedMarkup) });
    const inventoryPath = f.sourcePath.replace(/^theme\//, '');
    expect(manifest.inventory.find(item => item.path === inventoryPath)).toMatchObject({ sha256: hashBytes(Buffer.from(editedMarkup)), size: Buffer.byteLength(editedMarkup) });

    const loaded = await readSitePlanInput(f.bundle);
    expect(loaded.sourceIntentState).toBe('unreconciled');
    const blockedPlan = await planSite(f.bundle, { wpPath: '/wp' }, f.options.snapshotTransport);
    expect(blockedPlan).toMatchObject({ executable: false, conflicts: [expect.objectContaining({ code: 'source-intent-out-of-date' })] });
    const drift = await inspectSiteDrift(f.bundle, { wpPath: '/wp', snapshotTransport: f.options.snapshotTransport, templateTransport: f.options.templateTransport });
    expect(drift.status).toBe('clean');
    expect(drift.findings).toContainEqual(expect.objectContaining({ code: 'source-intent-out-of-date', status: 'equivalent-override' }));

    const repeated = await previewSitePull(f.bundle, path.join(f.root, 'repeat-preview'), [f.selection], f.options);
    expect(repeated.noOp).toBe(true);
    const noOp = await confirmSitePull(f.bundle, repeated.directory, repeated.confirmationHash!, f.options);
    expect(noOp.noOp).toBe(true);
    expect(await readFile(path.join(f.bundle, f.sourcePath), 'utf8')).toBe(editedMarkup);
  });

  it('refuses stale local bytes and changed remote content before publication', async () => {
    const local = await fixture();
    const localPreview = await previewSitePull(local.bundle, path.join(local.root, 'local-preview'), [local.selection], local.options);
    await writeFile(path.join(local.bundle, local.sourcePath), 'human local change');
    await expect(confirmSitePull(local.bundle, localPreview.directory, localPreview.confirmationHash!, local.options)).rejects.toThrow(/retained bundle bytes differ|changed after preview/);
    expect(await readFile(path.join(local.bundle, local.sourcePath), 'utf8')).toBe('human local change');

    const remote = await fixture();
    const remotePreview = await previewSitePull(remote.bundle, path.join(remote.root, 'remote-preview'), [remote.selection], remote.options);
    const changed = { ...remote.templates, entities: remote.templates.entities.map(entity => entity.id === remote.selection.entityId ? { ...entity, raw: '<!-- wp:paragraph --><p>Changed again</p><!-- /wp:paragraph -->' } : entity) };
    remote.setTemplates(changed);
    await expect(confirmSitePull(remote.bundle, remotePreview.directory, remotePreview.confirmationHash!, remote.options)).rejects.toThrow(/changed after preview/);
    expect(await readFile(path.join(remote.bundle, remote.sourcePath))).toEqual(remote.originalBytes);
  });

  it('requires the exact custom WordPress ID and a self-consistent sealed theme inventory', async () => {
    const f = await fixture();
    await expect(previewSitePull(f.bundle, path.join(f.root, 'wrong-id'), [{ ...f.selection, wpId: f.selection.wpId + 1 }], f.options)).rejects.toThrow('not the exact active-theme custom entity');

    const manifestPath = path.join(f.bundle, 'site.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { inventory: Array<{ sha256: string }> };
    manifest.inventory[0]!.sha256 = '0'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(previewSitePull(f.bundle, path.join(f.root, 'wrong-inventory'), [f.selection], f.options)).rejects.toThrow('retained theme inventory differs');
  });

  it('blocks invalid blocks and external navigation refs without creating a preview', async () => {
    const invalid = await fixture();
    invalid.setTemplates({ ...invalid.templates, entities: invalid.templates.entities.map(entity => entity.id === invalid.selection.entityId ? { ...entity, raw: '<!-- wp:paragraph --><div>Not a paragraph</div><!-- /wp:paragraph -->' } : entity) });
    const invalidOut = path.join(invalid.root, 'invalid-preview');
    const invalidResult = await previewSitePull(invalid.bundle, invalidOut, [invalid.selection], invalid.options);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.diagnostics.some(item => item.status === 'invalid')).toBe(true);
    await expect(readFile(invalidOut)).rejects.toMatchObject({ code: 'ENOENT' });

    const nav = await fixture();
    nav.setTemplates({ ...nav.templates, entities: nav.templates.entities.map(entity => entity.id === nav.selection.entityId ? { ...entity, raw: '<!-- wp:navigation {"ref":44} /-->' } : entity) });
    const navResult = await previewSitePull(nav.bundle, path.join(nav.root, 'nav-preview'), [nav.selection], nav.options);
    expect(navResult.ok).toBe(false);
    expect(navResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsupported-navigation-dependency', status: 'invalid' }));

    const part = await fixture();
    part.setTemplates({ ...part.templates, entities: part.templates.entities.map(entity => entity.id === part.selection.entityId
      ? { ...entity, raw: `<!-- wp:template-part {"slug":"missing","theme":"${part.source.sourceIntent.theme.slug}"} /-->` } : entity) });
    const partResult = await previewSitePull(part.bundle, path.join(part.root, 'part-preview'), [part.selection], part.options);
    expect(partResult.ok).toBe(false);
    expect(partResult.diagnostics).toContainEqual(expect.objectContaining({ code: 'unresolved-template-part', status: 'invalid' }));
  });

  it('retains a durable honest partial journal after a bounded multi-file failure', async () => {
    const f = await fixture(2);
    const selections = f.templates.entities.filter(entity => entity.source === 'custom').map(entity => ({
      kind: entity.type === 'wp_template_part' ? 'part' as const : 'template' as const,
      entityId: entity.id,
      wpId: entity.wpId,
    }));
    const preview = await previewSitePull(f.bundle, path.join(f.root, 'partial-preview'), selections, f.options);
    const sortedChanged = preview.files.filter(file => file.changed).map(file => file.path).sort();
    const failingPath = sortedChanged[1]!;
    await expect(confirmSitePull(f.bundle, preview.directory, preview.confirmationHash!, {
      ...f.options,
      onBeforePublish: (relative, index) => { if (index === 1) throw new Error(`injected failure at ${relative}`); },
    })).rejects.toMatchObject({ completed: [sortedChanged[0]], pending: [failingPath, 'site.manifest.json'] });
    const journal = JSON.parse(await readFile(path.join(preview.directory, 'site-pull.journal.json'), 'utf8')) as { status: string; completed: string[]; pending: string[] };
    expect(journal).toMatchObject({ status: 'partial', completed: [sortedChanged[0]], pending: [failingPath, 'site.manifest.json'] });
  });

  it('offers the pull command and exact selection syntax', async () => {
    const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
    const { stdout } = await run(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'site', 'pull', '--help']);
    expect(stdout).toContain('--select <kind:theme//id:wp-id>');
    expect(stdout).toContain('--confirm <sha256>');
  });
});
