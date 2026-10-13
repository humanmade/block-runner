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
import { managedStateHash, planSite, readSitePlanInput } from '../../src/site/plan.js';
import { writeCompiledSite } from '../../src/site/write.js';
import type { SiteEntity, SiteSnapshot } from '../../src/site/plan-types.js';
import type { PreparedSiteSource } from '../../src/site/types.js';
import type { SiteTemplateSnapshot } from '../../src/site/wpcli.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent/', import.meta.url));
const intentFile = path.join(fixtureRoot, 'site.intent.json');
const run = promisify(execFile);
const editedMarkup = '<!-- wp:paragraph --><p>Saved editor change.</p><!-- /wp:paragraph -->';

function addOwnedAttachment(f: PullFixture, wpId: number, options: { status?: string; duplicate?: boolean; duplicateNumericId?: boolean; duplicateDirty?: boolean; duplicateForeignOwner?: boolean; legacy?: boolean; foreignOwner?: boolean } = {}): void {
  const asset = f.source.assets.find(item => item.role === 'attachment')!;
  const state = { sha256: asset.sha256 };
  const ownership: SiteEntity['ownership'] = [{ version: 1, siteId: f.source.sourceIntent.siteId, entityId: asset.id, kind: 'attachment',
    ...(options.legacy ? {} : { assetSha256: asset.sha256 }), lastAppliedHash: managedStateHash(state) }];
  if (options.foreignOwner) ownership.push({ version: 1, siteId: 'another-site', entityId: 'shared', kind: 'attachment', assetSha256: asset.sha256, lastAppliedHash: managedStateHash(state) });
  const entity: SiteEntity = { id: wpId, kind: 'attachment', route: null, state, postStatus: options.status ?? 'inherit',
    attachment: { url: `https://example.test/uploads/${wpId}.png`, currentFileSha256: 'c'.repeat(64), width: 640, height: 480 }, ownership };
  f.snapshot.entities.push(entity);
  if (options.duplicate || options.duplicateNumericId) f.snapshot.entities.push({ ...entity, id: options.duplicateNumericId ? wpId : wpId + 1, state: { ...state }, ownership: ownership.map(row => ({ ...row })) });
  if (options.duplicateDirty) f.snapshot.entities.push({ ...entity, id: wpId + 1, state: { sha256: 'd'.repeat(64) }, ownership: ownership.map(row => ({ ...row })) });
  if (options.duplicateForeignOwner) f.snapshot.entities.push({ ...entity, id: wpId + 1, state: { ...state }, ownership: [...ownership.map(row => ({ ...row })),
    { version: 1, siteId: 'another-site', entityId: 'shared', kind: 'attachment', assetSha256: asset.sha256, lastAppliedHash: managedStateHash(state) }] });
  f.snapshot.siteRecord = { version: 1, siteId: f.source.sourceIntent.siteId,
    entities: { [options.legacy ? `attachment:${asset.id}` : `attachment:${asset.id}@${asset.sha256}`]: wpId }, options: {}, operation: null };
}

function imageRefs(wpId: number): string {
  const url = `https://example.test/uploads/${wpId}.png`;
  return `<!-- wp:image {"id":${wpId}} -->\n<figure class="wp-block-image"><img src="${url}" alt="" class="wp-image-${wpId}"/></figure>\n<!-- /wp:image -->\n\n<!-- wp:cover {"url":"${url}","id":${wpId},"dimRatio":50} -->\n<div class="wp-block-cover"><img class="wp-block-cover__image-background wp-image-${wpId}" alt="" src="${url}" data-object-fit="cover"/><span aria-hidden="true" class="wp-block-cover__background has-background-dim"></span><div class="wp-block-cover__inner-container"></div></div>\n<!-- /wp:cover -->`;
}

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

  it('blocks unowned attachment IDs in image and cover blocks without staging or changing source bytes', async () => {
    for (const wpId of [811, 812]) {
      const f = await fixture();
      f.setTemplates({ ...f.templates, entities: f.templates.entities.map(entity => entity.id === f.selection.entityId ? { ...entity, raw: imageRefs(wpId) } : entity) });
      const out = path.join(f.root, `unowned-${wpId}`);
      const beforeHtml = await readFile(path.join(f.bundle, f.sourcePath));
      const beforeManifest = await readFile(path.join(f.bundle, 'site.manifest.json'));
      const result = await previewSitePull(f.bundle, out, [f.selection], f.options);
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ status: 'invalid', code: 'unsupported-attachment-dependency' }));
      await expect(readFile(out)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(f.bundle, f.sourcePath))).toEqual(beforeHtml);
      expect(await readFile(path.join(f.bundle, 'site.manifest.json'))).toEqual(beforeManifest);
    }
  });

  it.each([
    ['missing', {}],
    ['trashed', { status: 'trash' }],
    ['ambiguous duplicate version', { duplicate: true }],
    ['ambiguous duplicate numeric ID', { duplicateNumericId: true }],
    ['dirty duplicate version claim', { duplicateDirty: true }],
    ['duplicate version claimant with foreign owner', { duplicateForeignOwner: true }],
    ['foreign ownership rows', { foreignOwner: true }],
  ] as const)('blocks %s attachment versions before source publication', async (_label, attachmentOptions) => {
    const f = await fixture();
    const ownedId = 811;
    if (_label !== 'missing') addOwnedAttachment(f, ownedId, attachmentOptions);
    f.setTemplates({ ...f.templates, entities: f.templates.entities.map(entity => entity.id === f.selection.entityId ? { ...entity, raw: imageRefs(ownedId) } : entity) });
    const beforeHtml = await readFile(path.join(f.bundle, f.sourcePath));
    const beforeManifest = await readFile(path.join(f.bundle, 'site.manifest.json'));
    const result = await previewSitePull(f.bundle, path.join(f.root, 'blocked-preview'), [f.selection], f.options);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ status: 'invalid', code: 'unsupported-attachment-dependency' }));
    expect(await readFile(path.join(f.bundle, f.sourcePath))).toEqual(beforeHtml);
    expect(await readFile(path.join(f.bundle, 'site.manifest.json'))).toEqual(beforeManifest);
  });

  it('permits exact available owned image and cover versions, then rechecks ownership at confirmation', async () => {
    const f = await fixture();
    const wpId = 811;
    addOwnedAttachment(f, wpId);
    f.setTemplates({ ...f.templates, entities: f.templates.entities.map(entity => entity.id === f.selection.entityId ? { ...entity, raw: imageRefs(wpId) } : entity) });
    const beforeHtml = await readFile(path.join(f.bundle, f.sourcePath));
    const beforeManifest = await readFile(path.join(f.bundle, 'site.manifest.json'));
    const preview = await previewSitePull(f.bundle, path.join(f.root, 'owned-image-preview'), [f.selection], f.options);
    expect(preview.ok, JSON.stringify(preview.diagnostics)).toBe(true);
    expect(preview.diagnostics.some(item => item.code === 'unsupported-attachment-dependency')).toBe(false);

    f.snapshot.entities[0]!.postStatus = 'trash';
    await expect(confirmSitePull(f.bundle, preview.directory, preview.confirmationHash!, f.options)).rejects.toThrow('changed after preview');
    expect(await readFile(path.join(f.bundle, f.sourcePath))).toEqual(beforeHtml);
    expect(await readFile(path.join(f.bundle, 'site.manifest.json'))).toEqual(beforeManifest);
  });

  it('refuses attachment ownership without the required version hash and qualified index', async () => {
    const f = await fixture();
    addOwnedAttachment(f, 811, { legacy: true });
    f.setTemplates({ ...f.templates, entities: f.templates.entities.map(entity => entity.id === f.selection.entityId ? { ...entity, raw: imageRefs(811) } : entity) });
    const beforeHtml = await readFile(path.join(f.bundle, f.sourcePath));
    const beforeManifest = await readFile(path.join(f.bundle, 'site.manifest.json'));
    const preview = await previewSitePull(f.bundle, path.join(f.root, 'legacy-owned-preview'), [f.selection], f.options);
    expect(preview.ok).toBe(false);
    expect(preview.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsupported-attachment-dependency' }));
    expect(await readFile(path.join(f.bundle, f.sourcePath))).toEqual(beforeHtml);
    expect(await readFile(path.join(f.bundle, 'site.manifest.json'))).toEqual(beforeManifest);
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
