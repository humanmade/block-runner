import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileThemeDocuments } from '../../src/site/compile.js';
import { inspectSiteDrift } from '../../src/site/drift.js';
import { readSitePlanInput, managedStateHash } from '../../src/site/plan.js';
import { writeCompiledSite } from '../../src/site/write.js';
import { readSiteTemplateSnapshot, type SiteTemplateSnapshot } from '../../src/site/wpcli.js';
import type { SiteEntity, SiteSnapshot } from '../../src/site/plan-types.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/site-intent/', import.meta.url));
const intentFile = path.join(fixtureRoot, 'site.intent.json');

async function bundleFixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'site-drift-'));
  const bundle = path.join(root, 'bundle');
  const input = await readSitePlanInput(intentFile, fixtureRoot);
  const compiled = await compileThemeDocuments(input.source, { themeAssetBaseUrl: `https://example.test/themes/${input.source.sourceIntent.theme.slug}` });
  if (!compiled.ok) throw new Error('drift test fixture theme did not compile');
  await writeCompiledSite(bundle, input.source, compiled.artifact);
  const manifest = JSON.parse(await readFile(path.join(bundle, 'site.manifest.json'), 'utf8')) as { artifactIdentity: string; sourceIdentity: string; bundleFiles: Array<{ path: string }> };
  const entities: SiteTemplateSnapshot['entities'] = [];
  for (const file of manifest.bundleFiles.filter(file => /^theme\/(templates|parts)\/.*\.html$/.test(file.path))) {
    const kind = file.path.startsWith('theme/parts/') ? 'wp_template_part' : 'wp_template';
    const relative = file.path.replace(/^theme\/(?:templates|parts)\//, '').replace(/\.html$/, '');
    const raw = await readFile(path.join(bundle, file.path), 'utf8');
    entities.push({ id: `${input.source.sourceIntent.theme.slug}//${relative}`, theme: input.source.sourceIntent.theme.slug, type: kind, source: 'theme', wpId: 0, raw });
  }
  return { root, bundle, input, manifest, entities };
}

function snapshot(theme: string, overrides: Partial<SiteSnapshot> = {}): SiteSnapshot {
  return {
    target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 3 },
    runtime: { wordpress: '7.1.2', php: '8.4.26' },
    principal: { userId: 7, capabilities: { edit_theme_options: true, edit_pages: true, edit_posts: true, edit_others_pages: true, edit_others_posts: true, manage_options: true } },
    theme: { slug: theme, assetBaseUrl: `https://example.test/wp/wp-content/themes/${theme}`, inventory: [] },
    routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'hash', routes: [] },
    entities: [], overrides: [], navigation: [], options: {}, siteRecord: null,
    ...overrides,
  };
}

function templateSnapshot(theme: string, entities: SiteTemplateSnapshot['entities']): SiteTemplateSnapshot {
  return { target: { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 3 }, theme,
    principal: { userId: 7, userLogin: 'editor', canReadEditContext: true }, runtime: { wordpress: '7.1.2' }, entities };
}

function attachmentEntity(siteId: string, id: number, logicalId: string, originalSha: string, options: { stateSha?: string; postStatus?: string; currentFileSha256?: string | null } = {}): SiteEntity {
  const baseline = { sha256: originalSha };
  const state = { sha256: options.stateSha ?? originalSha };
  return { id, kind: 'attachment', route: null, postStatus: options.postStatus ?? 'inherit', state,
    attachment: { url: `https://example.test/uploads/${id}.png`, currentFileSha256: options.currentFileSha256 === undefined ? originalSha : options.currentFileSha256, width: 640, height: 480 },
    ownership: [{ version: 1, siteId, entityId: logicalId, kind: 'attachment', assetSha256: originalSha, lastAppliedHash: managedStateHash(baseline) }] };
}

function transportFor(observed: SiteSnapshot, templates: SiteTemplateSnapshot) {
  return {
    snapshotTransport: async () => JSON.stringify(observed),
    templateTransport: async () => JSON.stringify(templates),
  };
}

describe('read-only site drift inspection', () => {
  it('maps fresh theme and part entities by exact source ID and preserves full markup bytes', async () => {
    const fixture = await bundleFixture();
    const observed = snapshot(fixture.input.source.sourceIntent.theme.slug);
    const result = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, fixture.entities)) });
    expect(result.status).toBe('clean');
    expect(result.bundle).toMatchObject({ siteId: fixture.input.source.sourceIntent.siteId, sourceIdentity: fixture.manifest.sourceIdentity, artifactIdentity: fixture.manifest.artifactIdentity });
    expect(result.findings.filter(finding => finding.kind === 'template' || finding.kind === 'part')).toHaveLength(fixture.entities.length);
    expect(result.findings.every(finding => finding.status === 'clean')).toBe(true);

    const changed = fixture.entities.map((entity, index) => index === 0 ? { ...entity, raw: `${entity.raw} ` } : entity);
    const changedReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, changed)) });
    expect(changedReport.status).toBe('actionable');
    expect(changedReport.findings).toContainEqual(expect.objectContaining({ status: 'changed', code: 'theme-source-differs', firstDifferenceByte: fixture.entities[0]!.raw.length }));
  });

  it('distinguishes a persisted byte-equivalent override from changed database markup', async () => {
    const fixture = await bundleFixture();
    const observed = snapshot(fixture.input.source.sourceIntent.theme.slug);
    const override = fixture.entities.map((entity, index) => index === 0 ? { ...entity, source: 'custom' as const, wpId: 44 } : entity);
    const equivalent = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, override)) });
    expect(equivalent.status).toBe('clean');
    expect(equivalent.findings).toContainEqual(expect.objectContaining({ status: 'equivalent-override', wpId: 44, code: 'equivalent-database-override' }));

    override[0]!.raw += '\n';
    const changed = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, override)) });
    expect(changed.findings).toContainEqual(expect.objectContaining({ status: 'changed', wpId: 44, code: 'changed-database-override' }));
  });

  it('detects status-only managed edits, missing and orphaned IDs, option changes, and unknown operations', async () => {
    const fixture = await bundleFixture();
    const id = fixture.input.source.sourceIntent.pages[0]!.id;
    const state = { content: '<!-- wp:paragraph --><p>Same body</p><!-- /wp:paragraph -->', title: 'Home', status: 'draft', slug: 'home', parentId: 0, template: 'index' };
    const owned: SiteEntity = { id: 20, kind: 'page', route: '/', state: { ...state, status: 'publish' }, ownership: [{ version: 1, siteId: fixture.input.source.sourceIntent.siteId,
      entityId: id, kind: 'page', lastAppliedHash: managedStateHash(state) }] };
    const versionTwoState = { content: '<!-- wp:paragraph --><p>Matching metadata hash</p><!-- /wp:paragraph -->', title: 'Second', status: 'draft', slug: 'second', parentId: 0, template: 'index' };
    const unsupportedOwner: SiteEntity = { id: 22, kind: 'page', route: '/second', state: versionTwoState, ownership: [{ version: 2 as 1, siteId: fixture.input.source.sourceIntent.siteId,
      entityId: 'second', kind: 'page', lastAppliedHash: managedStateHash(versionTwoState) }] };
    const observed = snapshot(fixture.input.source.sourceIntent.theme.slug, {
      entities: [owned, unsupportedOwner], options: { show_on_front: 'posts' },
      siteRecord: { version: 1, siteId: fixture.input.source.sourceIntent.siteId, entities: { [`page:${id}`]: 20, 'page:second': 22, 'page:removed': 21 },
        options: { show_on_front: { lastAppliedValue: 'page' } }, operation: { token: 'opaque', planHash: 'hash', status: 'outcome_unknown' } },
    });
    const report = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, fixture.entities)) });
    expect(report.status).toBe('blocked');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'changed', code: 'managed-state-changed', wpId: 20 }),
      expect.objectContaining({ status: 'blocked', code: 'invalid-ownership-baseline', entityId: 'page:second', wpId: 22 }),
      expect.objectContaining({ status: 'missing', code: 'missing-owned-entity', entityId: 'page:removed' }),
      expect.objectContaining({ status: 'orphaned', code: 'orphaned-owned-entity', entityId: 'page:removed' }),
      expect.objectContaining({ status: 'changed', code: 'managed-option-changed', entityId: 'show_on_front' }),
      expect.objectContaining({ status: 'blocked', code: 'outstanding-operation' }),
    ]));
  });

  it('reports missing, trashed, and byte-changed owned attachments despite unchanged page markup', async () => {
    const fixture = await bundleFixture();
    const siteId = fixture.input.source.sourceIntent.siteId;
    const asset = fixture.input.source.assets.find(candidate => candidate.role === 'attachment')!;
    const pageId = fixture.input.source.sourceIntent.pages[0]!.id;
    const content = '<!-- wp:image {"id":41} /-->';
    const pageState = { content, title: 'Home', status: 'publish', slug: 'home', parentId: 0, template: 'index' };
    const page: SiteEntity = { id: 20, kind: 'page', route: '/', state: pageState, ownership: [{ version: 1, siteId, entityId: pageId, kind: 'page', lastAppliedHash: managedStateHash(pageState) }] };
    const siteRecord = { version: 1 as const, siteId, entities: { [`page:${pageId}`]: 20, [`attachment:${asset.id}@${asset.sha256}`]: 41 }, options: {}, operation: null };
    const run = async (entities: SiteEntity[]) => {
      const observed = snapshot(fixture.input.source.sourceIntent.theme.slug, { entities, siteRecord });
      return inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, fixture.entities)) });
    };

    const trashed = await run([page, attachmentEntity(siteId, 41, asset.id, asset.sha256, { postStatus: 'trash' })]);
    expect(trashed.status).toBe('actionable');
    expect(trashed.findings).toContainEqual(expect.objectContaining({ kind: 'attachment', status: 'missing', code: 'owned-attachment-unavailable', wpId: 41 }));
    expect(trashed.findings).not.toContainEqual(expect.objectContaining({ code: 'verified-owned-attachment-dependency', wpId: 41 }));

    const missing = await run([page]);
    expect(missing.status).toBe('actionable');
    expect(missing.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', status: 'missing', code: 'missing-owned-attachment', entityId: `attachment:${asset.id}@${asset.sha256}`, wpId: 41 }),
      expect.objectContaining({ kind: 'dependency', status: 'dependency', code: 'unresolved-dependency', entityId: 'core/image:41' }),
    ]));

    const changed = await run([page, attachmentEntity(siteId, 41, asset.id, asset.sha256, { stateSha: 'f'.repeat(64) })]);
    expect(changed.status).toBe('actionable');
    expect(changed.findings).toContainEqual(expect.objectContaining({ kind: 'attachment', status: 'changed', code: 'managed-attachment-changed', wpId: 41 }));
  });

  it('resolves image and cover IDs only to version-verified owned attachments', async () => {
    const fixture = await bundleFixture();
    const siteId = fixture.input.source.sourceIntent.siteId;
    const asset = fixture.input.source.assets.find(candidate => candidate.role === 'attachment')!;
    const pageId = fixture.input.source.sourceIntent.pages[0]!.id;
    const content = '<!-- wp:image {"id":41} /--><!-- wp:cover {"id":41} /-->';
    const pageState = { content, title: 'Home', status: 'publish', slug: 'home', parentId: 0, template: 'index' };
    const page: SiteEntity = { id: 20, kind: 'page', route: '/', state: pageState, ownership: [{ version: 1, siteId, entityId: pageId, kind: 'page', lastAppliedHash: managedStateHash(pageState) }] };
    const attachment = attachmentEntity(siteId, 41, asset.id, asset.sha256);
    const record = { version: 1 as const, siteId, entities: { [`page:${pageId}`]: 20, [`attachment:${asset.id}@${asset.sha256}`]: 41 }, options: {}, operation: null };
    const observed = snapshot(fixture.input.source.sourceIntent.theme.slug, { entities: [page, attachment], siteRecord: record });
    const report = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, fixture.entities)) });
    expect(report.status).toBe('clean');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment', status: 'clean', code: 'managed-attachment-match', entityId: `attachment:${asset.id}@${asset.sha256}` }),
      expect.objectContaining({ status: 'clean', code: 'verified-owned-attachment-dependency', entityId: 'core/image:41' }),
      expect.objectContaining({ status: 'clean', code: 'verified-owned-attachment-dependency', entityId: 'core/cover:41' }),
    ]));

    const unownedContent = '<!-- wp:image {"id":55} /--><!-- wp:cover {"id":56} /-->';
    const unownedState = { ...pageState, content: unownedContent };
    const unownedPage: SiteEntity = { ...page, state: unownedState, ownership: [{ ...page.ownership[0]!, lastAppliedHash: managedStateHash(unownedState) }] };
    const unowned = snapshot(fixture.input.source.sourceIntent.theme.slug, { entities: [unownedPage, attachmentEntity(siteId, 55, 'elsewhere', 'a'.repeat(64))], navigation: [],
      siteRecord: { version: 1, siteId, entities: { [`page:${pageId}`]: 20 }, options: {}, operation: null } });
    const unownedReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(unowned, templateSnapshot(unowned.theme.slug, fixture.entities)) });
    expect(unownedReport.status).toBe('actionable');
    expect(unownedReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'dependency', code: 'unowned-attachment-dependency', entityId: 'core/image:55' }),
      expect.objectContaining({ status: 'dependency', code: 'unresolved-dependency', entityId: 'core/cover:56' }),
    ]));
  });

  it('reports an unreferenced attachment with extra ownership claims as a conflict, never clean', async () => {
    const fixture = await bundleFixture();
    const siteId = fixture.input.source.sourceIntent.siteId;
    const asset = fixture.input.source.assets.find(candidate => candidate.role === 'attachment')!;
    const attachment = attachmentEntity(siteId, 41, asset.id, asset.sha256);
    attachment.ownership.push({ version: 1, siteId: 'another-site', entityId: 'shared', kind: 'attachment', assetSha256: asset.sha256,
      lastAppliedHash: managedStateHash(attachment.state) });
    const observed = snapshot(fixture.input.source.sourceIntent.theme.slug, { entities: [attachment], siteRecord: {
      version: 1, siteId, entities: { [`attachment:${asset.id}@${asset.sha256}`]: 41 }, options: {}, operation: null,
    } });
    const report = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, fixture.entities)) });
    expect(report.status).toBe('actionable');
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: 'attachment', status: 'conflict', code: 'ambiguous-attachment-ownership', wpId: 41 }));
    expect(report.findings).not.toContainEqual(expect.objectContaining({ kind: 'attachment', status: 'clean', code: 'managed-attachment-match', wpId: 41 }));
  });

  it('reports unresolved navigation and unowned synced-pattern references as actionable dependencies', async () => {
    const fixture = await bundleFixture();
    const sourceId = fixture.input.source.sourceIntent.pages[0]!.id;
    const state = { content: '<!-- wp:navigation {"ref":55} /--><!-- wp:block {"ref":66} /-->', title: 'Home', status: 'draft', slug: 'home', parentId: 0, template: 'index' };
    const entity: SiteEntity = { id: 20, kind: 'page', route: '/', state, ownership: [{ version: 1, siteId: fixture.input.source.sourceIntent.siteId,
      entityId: sourceId, kind: 'page', lastAppliedHash: managedStateHash(state) }] };
    const observed = snapshot(fixture.input.source.sourceIntent.theme.slug, { entities: [entity], navigation: [{ id: 55, content: '', status: 'publish' }],
      siteRecord: { version: 1, siteId: fixture.input.source.sourceIntent.siteId, entities: { [`page:${sourceId}`]: 20 }, options: {}, operation: null } });
    const report = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, templateSnapshot(observed.theme.slug, fixture.entities)) });
    expect(report.status).toBe('actionable');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'dependency', code: 'unowned-navigation-dependency', wpId: 55 }),
      expect.objectContaining({ status: 'dependency', code: 'unresolved-dependency', wpId: 66 }),
    ]));

    const patternState = { content: '<!-- wp:paragraph --><p>Owned pattern</p><!-- /wp:paragraph -->', title: 'Owned pattern', status: 'publish' };
    const ownedPattern: SiteEntity = { id: 66, kind: 'pattern', route: null, state: patternState, ownership: [{ version: 1,
      siteId: fixture.input.source.sourceIntent.siteId, entityId: 'owned-pattern', kind: 'pattern', lastAppliedHash: managedStateHash(patternState) }] };
    const ownedPatternSnapshot = snapshot(fixture.input.source.sourceIntent.theme.slug, { entities: [entity, ownedPattern], navigation: [{ id: 55, content: '', status: 'publish' }],
      siteRecord: { version: 1, siteId: fixture.input.source.sourceIntent.siteId, entities: { [`page:${sourceId}`]: 20, 'pattern:owned-pattern': 66 }, options: {}, operation: null } });
    const ownedPatternReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(ownedPatternSnapshot, templateSnapshot(ownedPatternSnapshot.theme.slug, fixture.entities)) });
    expect(ownedPatternReport.findings).toContainEqual(expect.objectContaining({ status: 'clean', code: 'verified-owned-pattern-dependency', wpId: 66 }));
  });

  it('returns blocked for unavailable edit-context permissions and wrong active theme', async () => {
    const fixture = await bundleFixture();
    const theme = fixture.input.source.sourceIntent.theme.slug;
    const observed = snapshot(theme);
    const denied = templateSnapshot(theme, fixture.entities); denied.principal.canReadEditContext = false;
    const deniedReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, denied) });
    expect(deniedReport.status).toBe('blocked');
    expect(deniedReport.target).toBeNull();
    const wrong = templateSnapshot('different-theme', fixture.entities);
    const wrongReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, wrong) });
    expect(wrongReport.status).toBe('blocked');
    const wrongPrincipal = templateSnapshot(theme, fixture.entities); wrongPrincipal.principal.userId = 8;
    const principalReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', ...transportFor(observed, wrongPrincipal) });
    expect(principalReport).toMatchObject({ status: 'blocked', findings: [expect.objectContaining({ code: 'target-observation-mismatch' })] });
    const selectedLoginMismatch = templateSnapshot(theme, fixture.entities); selectedLoginMismatch.principal.userLogin = 'other-user';
    const selectedReport = await inspectSiteDrift(fixture.bundle, { wpPath: '/wp', wpUser: 'editor', ...transportFor(observed, selectedLoginMismatch) });
    expect(selectedReport.status).toBe('blocked');
  });

  it('refuses a bundle whose source bytes change during the target inspection', async () => {
    const fixture = await bundleFixture();
    const theme = fixture.input.source.sourceIntent.theme.slug;
    const observed = snapshot(theme);
    const file = path.join(fixture.bundle, 'theme/templates/index.html');
    await expect(inspectSiteDrift(fixture.bundle, {
      wpPath: '/wp',
      snapshotTransport: async () => { const original = await readFile(file, 'utf8'); await import('node:fs/promises').then(({ writeFile }) => writeFile(file, `${original} `)); return JSON.stringify(observed); },
      templateTransport: async () => JSON.stringify(templateSnapshot(theme, fixture.entities)),
    })).rejects.toThrow('retained bundle identity changed during drift inspection');
  });

  it('uses only fixed authenticated edit-context REST reads and rejects absent capabilities', async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const expected: SiteTemplateSnapshot = templateSnapshot('fixture', []);
    const returned = await readSiteTemplateSnapshot({ wpPath: '/wp', wpUrl: 'https://example.test/sub', wpUser: 'editor', wpBinary: '/usr/bin/wp' }, 'fixture', async (executable, args) => {
      calls.push({ executable, args }); return JSON.stringify(expected);
    });
    expect(returned.entities).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.executable).toBe('/usr/bin/wp');
    expect(calls[0]!.args.slice(0, 4)).toEqual(['--path=/wp', '--url=https://example.test/sub', '--user=editor', 'eval']);
    expect(calls[0]!.args.at(-1)).toContain("set_param('context','edit')");
    expect(calls[0]!.args.at(-1)).toContain('rest_do_request');
    expect(calls[0]!.args.at(-1)).toContain("get_post($wpId)");
    expect(calls[0]!.args.at(-1)).toContain("get_the_terms($wpId,'wp_theme')");
    expect(calls[0]!.args.at(-1)).toContain('$post->post_content');
    expect(calls[0]!.args.at(-1)).not.toMatch(/\b(?:wp_insert_post|wp_update_post|update_option|add_post_meta|update_post_meta)\s*\(/);
    expected.principal.canReadEditContext = false;
    await expect(readSiteTemplateSnapshot({ wpPath: '/wp' }, 'fixture', async () => JSON.stringify(expected))).rejects.toThrow('edit_posts');
    expected.principal.canReadEditContext = true;
    expected.entities = [
      { id: 'fixture//header', theme: 'fixture', type: 'wp_template', source: 'theme', wpId: 0, raw: 'template' },
      { id: 'fixture//header', theme: 'fixture', type: 'wp_template_part', source: 'theme', wpId: 0, raw: 'part' },
    ];
    expect((await readSiteTemplateSnapshot({ wpPath: '/wp' }, 'fixture', async () => JSON.stringify(expected))).entities).toHaveLength(2);
    expected.entities.push({ ...expected.entities[0]! });
    await expect(readSiteTemplateSnapshot({ wpPath: '/wp' }, 'fixture', async () => JSON.stringify(expected))).rejects.toThrow('invalid or conflicting');
  });

  it('emits JSON with distinct clean, actionable, and blocked CLI exit codes', async () => {
    const fixture = await bundleFixture();
    const theme = fixture.input.source.sourceIntent.theme.slug;
    const observed = snapshot(theme);
    const wpBinary = path.join(fixture.root, 'wp fake');
    const script = (templates: SiteTemplateSnapshot) => `#!/usr/bin/env node\nconst input = process.argv.at(-1);\nconst value = input.includes('read-only site inspection') ? ${JSON.stringify(JSON.stringify(templates))} : ${JSON.stringify(JSON.stringify(observed))};\nprocess.stdout.write(value);\n`;
    const clean = templateSnapshot(theme, fixture.entities);
    const run = async (templates: SiteTemplateSnapshot, json = true, bundlePath = fixture.bundle) => {
      const { writeFile, chmod } = await import('node:fs/promises');
      await writeFile(wpBinary, script(templates), { mode: 0o755 }); await chmod(wpBinary, 0o755);
      const cliPath = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
      const tsx = import.meta.resolve('tsx');
      return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', tsx, cliPath, 'site', 'drift', bundlePath, '--wp-path', '/wp', '--wp-binary', wpBinary, ...(json ? ['--json'] : [])]);
        let stdout = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('error', reject); child.on('close', code => resolve({ code, stdout }));
      });
    };
    const cleanResult = await run(clean);
    expect(cleanResult.code).toBe(0);
    expect(JSON.parse(cleanResult.stdout)).toMatchObject({ status: 'clean', bundle: { sourceIdentity: fixture.manifest.sourceIdentity } });
    const textResult = await run(clean, false);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain('Site drift: clean');
    const equivalent = templateSnapshot(theme, fixture.entities.map((entity, index) => index === 0 ? { ...entity, source: 'custom' as const, wpId: 44 } : entity));
    const equivalentResult = await run(equivalent);
    expect(equivalentResult.code).toBe(0);
    expect(JSON.parse(equivalentResult.stdout)).toMatchObject({ status: 'clean', findings: expect.arrayContaining([expect.objectContaining({ status: 'equivalent-override' })]) });
    const changed = templateSnapshot(theme, fixture.entities.map((entity, index) => index === 0 ? { ...entity, raw: `${entity.raw} ` } : entity));
    const actionableResult = await run(changed);
    expect(actionableResult.code).toBe(1);
    expect(JSON.parse(actionableResult.stdout).status).toBe('actionable');
    const denied = templateSnapshot(theme, fixture.entities); denied.principal.canReadEditContext = false;
    const blockedResult = await run(denied);
    expect(blockedResult.code).toBe(2);
    expect(JSON.parse(blockedResult.stdout)).toMatchObject({ status: 'blocked', target: null });
    const errorResult = await run(clean, true, path.join(fixture.root, 'missing-bundle'));
    expect(errorResult.code).toBe(3);
    expect(JSON.parse(errorResult.stdout)).toMatchObject({ status: 'error', code: 'inspection-failed' });
  });
});
