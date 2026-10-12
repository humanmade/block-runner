import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { prepareSiteSource } from '../../src/site/input.js';
import { importPlannedSiteAttachment, SiteMediaImportOutcomeUnknown } from '../../src/site/media-import.js';
import { hashCanonicalJson } from '../../src/proof/receipt.js';
import { managedStateHash, reconcileSitePlan } from '../../src/site/plan.js';
import type { SitePlan, SiteSnapshot } from '../../src/site/plan-types.js';
import type { PreparedSiteSource, ThemeArtifact } from '../../src/site/types.js';

const target = { homeUrl: 'https://example.test', siteUrl: 'https://example.test/wp', blogId: 1 };
const themeSlug = 'sample';
const run = promisify(execFile);

function snapshot(): SiteSnapshot {
  return {
    target,
    runtime: { wordpress: '7.1', php: '8.4' },
    principal: { userId: 7, capabilities: { edit_pages: true, edit_others_pages: true, manage_options: true, edit_theme_options: true, upload_files: true } },
    theme: { slug: themeSlug, assetBaseUrl: 'https://example.test/theme', inventory: [] },
    routing: { permalinkStructure: '/%postname%/', rewriteRulesHash: 'rules', routes: [] },
    entities: [], overrides: [], navigation: [], options: { show_on_front: 'posts', page_on_front: 0 },
    siteRecord: { version: 1, siteId: 'sample', entities: {}, options: {}, operation: null },
  };
}

function previousVersion() {
  const sha256 = 'a'.repeat(64);
  const state = { sha256 };
  return { id: 8, kind: 'attachment' as const, route: null, postStatus: 'inherit', state,
    attachment: { url: 'https://example.test/uploads/hero.png', currentFileSha256: sha256, width: 900, height: 600,
      sizes: { full: { url: 'https://example.test/uploads/hero.png', width: 900, height: 600 } } },
    ownership: [{ version: 1 as const, siteId: 'sample', entityId: 'hero', kind: 'attachment' as const, assetSha256: sha256,
      lastAppliedHash: managedStateHash(state) }] };
}

function resign(plan: SitePlan): SitePlan {
  const { confirmationHash: _previous, ...body } = plan;
  return { ...body, confirmationHash: hashCanonicalJson(body) };
}

async function fixture(retainOld = false) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'site-media-import-'));
  await mkdir(path.join(root, 'media'));
  const fixtureImage = fileURLToPath(new URL('./fixtures/site-intent/media/hero.png', import.meta.url));
  await copyFile(fixtureImage, path.join(root, 'media/hero.png'));
  const intent = {
    version: 1,
    siteId: 'sample',
    homePageId: 'home',
    theme: { slug: themeSlug, title: 'Sample', themeJson: { version: 3 } },
    templates: { index: { body: { blocks: [{ block: 'core/post-content' }] } } }, parts: {}, patterns: {},
    pages: [{ id: 'home', route: '/', title: 'Home', template: 'index', status: 'draft', body: { blocks: [{ block: 'core/paragraph', text: 'Home' }] } }],
    assets: [{ id: 'hero', path: 'media/hero.png', kind: 'image', role: 'attachment' }],
    assetUses: [],
  };
  const prepared = await prepareSiteSource(intent, root);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics));
  const source: PreparedSiteSource = prepared.source;
  const theme: ThemeArtifact = {
    sourceIntent: source.sourceIntent, sourceAssets: source.assets, targetBindings: {}, targetBindingFingerprint: 'test',
    themeFiles: [], pendingPageBindings: [], diagnostics: [], inventory: [], artifactIdentity: 'test-theme',
  };
  const compiledPage = { id: 'home', route: '/', title: 'Home', template: 'index', status: 'draft' as const,
    content: '<!-- wp:paragraph --><p>Home</p><!-- /wp:paragraph -->', diagnostics: [] };
  const observed = snapshot();
  if (retainOld) observed.entities.push(previousVersion());
  const plan = reconcileSitePlan(source, theme, [compiledPage], observed);
  if (!plan.executable) throw new Error(JSON.stringify(plan.conflicts));
  const token = 'started-token';
  const key = `attachment:hero@${source.assets[0]!.sha256}`;
  const step = { key, kind: 'attachment' as const, entityId: 'hero', assetSha256: source.assets[0]!.sha256, status: 'started' as const };
  const journalPath = path.join(root, 'journal.json');
  await writeFile(journalPath, JSON.stringify({ version: 1, siteId: plan.siteId, planHash: plan.confirmationHash, token,
    target: plan.snapshot.target, principalId: plan.snapshot.principal.userId, status: 'started', currentStep: step }));
  const marked = structuredClone(observed);
  marked.siteRecord!.operation = { token, planHash: plan.confirmationHash, status: 'started', currentStep: step };
  return { root, source, plan, journalPath, token, marked };
}

function createdSnapshot(plan: SitePlan, assetHash: string): SiteSnapshot {
  const observed = structuredClone(plan.snapshot);
  observed.entities.push({ id: 44, kind: 'attachment', route: null, postStatus: 'inherit', state: { sha256: assetHash },
    attachment: { url: 'https://example.test/uploads/hero-3.png', linkUrl: 'https://example.test/?attachment_id=44',
      currentFileSha256: assetHash, width: 1200, height: 800,
      sizes: { full: { url: 'https://example.test/uploads/hero-3.png', width: 1200, height: 800 } } },
    ownership: [{ version: 1, siteId: plan.siteId, entityId: 'hero', kind: 'attachment', assetSha256: assetHash,
      lastAppliedHash: managedStateHash({ sha256: assetHash }) }] });
  return observed;
}

describe('private declared attachment import primitive', () => {
  it('requires the exact durable journal and live marker before any mutation', async () => {
    const ready = await fixture();
    let calls = 0;
    const run = (marked: SiteSnapshot, journalPath = ready.journalPath) => importPlannedSiteAttachment({
      plan: ready.plan, source: ready.source, assetId: 'hero', wp: { wpPath: '/wp', wpUrl: target.homeUrl, wpUser: '7' },
      authority: { token: ready.token, journalPath },
      readTransport: async () => JSON.stringify(marked),
      mutationTransport: async () => { calls += 1; return '{"status":"complete","id":44}'; },
    });
    const wrongJournal = path.join(ready.root, 'wrong.json');
    await writeFile(wrongJournal, JSON.stringify({ version: 1, siteId: ready.plan.siteId, planHash: ready.plan.confirmationHash,
      token: ready.token, target, principalId: 7, status: 'started' }));
    await expect(run(ready.marked, wrongJournal)).rejects.toThrow('durable started journal');
    const noMarker = snapshot();
    await expect(run(noMarker)).rejects.toThrow('live site marker');
    expect(calls).toBe(0);
  });

  it.each(['changed', 'symlink'] as const)('rechecks declared bytes and refuses %s source before calling WordPress', async mode => {
    const ready = await fixture();
    const assetPath = path.join(ready.root, 'media/hero.png');
    if (mode === 'changed') await writeFile(assetPath, 'changed');
    else {
      const externalPath = path.join(ready.root, 'replacement.png');
      await writeFile(externalPath, await readFile(assetPath));
      await unlink(assetPath);
      await symlink(externalPath, assetPath);
    }
    let calls = 0;
    await expect(importPlannedSiteAttachment({ plan: ready.plan, source: ready.source, assetId: 'hero',
      wp: { wpPath: '/wp' }, authority: { token: ready.token, journalPath: ready.journalPath },
      readTransport: async () => JSON.stringify(ready.marked), mutationTransport: async () => { calls += 1; return ''; },
    })).rejects.toThrow(/site source assets changed/);
    expect(calls).toBe(0);
  });

  it('surfaces one uncertain mutation attempt without retrying', async () => {
    const ready = await fixture();
    let calls = 0;
    await expect(importPlannedSiteAttachment({ plan: ready.plan, source: ready.source, assetId: 'hero',
      wp: { wpPath: '/wp' }, authority: { token: ready.token, journalPath: ready.journalPath },
      readTransport: async () => JSON.stringify(ready.marked), mutationTransport: async () => { calls += 1; throw new Error('timeout'); },
    })).rejects.toBeInstanceOf(SiteMediaImportOutcomeUnknown);
    expect(calls).toBe(1);
  });

  it('returns only the exact new owned attachment and observed native metadata with matching PHP baseline hashes', async ({ skip }) => {
    const ready = await fixture(true);
    expect(ready.plan.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'create', kind: 'attachment', entityId: 'hero', desired: { sha256: ready.source.assets[0]!.sha256, assetSha256: ready.source.assets[0]!.sha256 } }),
      expect.objectContaining({ action: 'retain', kind: 'attachment', entityId: 'hero', id: 8, desired: { orphaned: true } }),
    ]));
    const hash = ready.source.assets[0]!.sha256;
    const after = createdSnapshot(ready.plan, hash);
    let reads = 0;
    let mutations = 0;
    let capturedArgs: string[] = [];
    const binding = await importPlannedSiteAttachment({ plan: ready.plan, source: ready.source, assetId: 'hero',
      wp: { wpPath: '/wp', wpUrl: target.homeUrl, wpUser: '7' }, authority: { token: ready.token, journalPath: ready.journalPath },
      readTransport: async () => JSON.stringify(++reads === 1 ? ready.marked : after),
      mutationTransport: async (executable, args) => {
        mutations += 1;
        capturedArgs = [executable, ...args];
        return JSON.stringify({ status: 'complete', id: 44, sha256: hash });
      },
    });
    expect({ reads, mutations }).toEqual({ reads: 2, mutations: 1 });
    expect(capturedArgs[0]).toBe('wp');
    expect(capturedArgs.slice(1, 4)).toEqual(['--path=/wp', `--url=${target.homeUrl}`, '--user=7']);
    const script = capturedArgs.at(-1)!;
    expect(script).toContain('wp_upload_bits(');
    expect(script).toContain('wp_insert_attachment(');
    const payload = script.match(/base64_decode\('([^']+)'/);
    expect(payload).not.toBeNull();
    expect(JSON.parse(Buffer.from(payload![1]!, 'base64').toString('utf8'))).toMatchObject({ assetSha256: hash, relativePath: 'media/hero.png' });
    expect(script).not.toContain(Buffer.from(await readFile(path.join(ready.root, 'media/hero.png'))).toString('base64'));
    const legacyExpression = script.match(/\$legacyHash\s*=\s*([^;]+);/)?.[1];
    const ownershipExpression = script.match(/'lastAppliedHash'=>(.+?), 'assetSha256'/)?.[1];
    expect(legacyExpression).toBeDefined();
    expect(ownershipExpression).toBeDefined();
    const php = `function wp_json_encode($value) { return json_encode($value); }
$expected = array('assetSha256'=>'${hash}');
$state = array('sha256'=>'${hash}');
$legacyHash = ${legacyExpression};
$ownershipHash = ${ownershipExpression};
echo json_encode(array($legacyHash, $ownershipHash));`;
    let hashOutput: string;
    try {
      ({ stdout: hashOutput } = await run('php', ['-r', php], { encoding: 'utf8' }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return skip();
      throw error;
    }
    expect(JSON.parse(hashOutput)).toEqual([managedStateHash({ sha256: hash }), managedStateHash({ sha256: hash })]);
    expect(binding).toMatchObject({ id: 44, url: 'https://example.test/uploads/hero-3.png', observedSize: { width: 1200, height: 800 },
      imageSizes: { full: { url: 'https://example.test/uploads/hero-3.png', width: 1200, height: 800 } } });
  });

  it('requires one exact-hash create while allowing retained prior versions', async () => {
    const duplicate = await fixture(true);
    const create = duplicate.plan.operations.find(operation => operation.kind === 'attachment' && operation.action === 'create')!;
    duplicate.plan = resign({ ...duplicate.plan, operations: [...duplicate.plan.operations, { ...create }] });
    let calls = 0;
    await expect(importPlannedSiteAttachment({ plan: duplicate.plan, source: duplicate.source, assetId: 'hero',
      wp: { wpPath: '/wp' }, authority: { token: duplicate.token, journalPath: duplicate.journalPath },
      readTransport: async () => JSON.stringify(duplicate.marked), mutationTransport: async () => { calls += 1; return ''; },
    })).rejects.toThrow('no unique create operation');
    expect(calls).toBe(0);

    const incorrect = await fixture(true);
    const wrongPlan = structuredClone(incorrect.plan);
    const wrongCreate = wrongPlan.operations.find(operation => operation.kind === 'attachment' && operation.action === 'create')!;
    wrongCreate.desired = { ...wrongCreate.desired, sha256: 'b'.repeat(64), assetSha256: 'b'.repeat(64) };
    incorrect.plan = resign(wrongPlan);
    await expect(importPlannedSiteAttachment({ plan: incorrect.plan, source: incorrect.source, assetId: 'hero',
      wp: { wpPath: '/wp' }, authority: { token: incorrect.token, journalPath: incorrect.journalPath },
      mutationTransport: async () => { calls += 1; return ''; },
    })).rejects.toThrow('no unique create operation');
    expect(calls).toBe(0);
  });

  it('treats an ambiguous or unavailable post-import attachment as unknown', async () => {
    const ready = await fixture();
    const after = createdSnapshot(ready.plan, ready.source.assets[0]!.sha256);
    after.entities[0]!.postStatus = 'trash';
    let reads = 0;
    await expect(importPlannedSiteAttachment({ plan: ready.plan, source: ready.source, assetId: 'hero',
      wp: { wpPath: '/wp' }, authority: { token: ready.token, journalPath: ready.journalPath },
      readTransport: async () => JSON.stringify(++reads === 1 ? ready.marked : after),
      mutationTransport: async () => JSON.stringify({ status: 'complete', id: 44, sha256: ready.source.assets[0]!.sha256 }),
    })).rejects.toBeInstanceOf(SiteMediaImportOutcomeUnknown);
  });

  it('treats any additional ownership row on the returned attachment as unknown', async () => {
    const ready = await fixture();
    const after = createdSnapshot(ready.plan, ready.source.assets[0]!.sha256);
    after.entities[0]!.ownership.push({ ...after.entities[0]!.ownership[0]!, siteId: 'other', entityId: 'foreign' });
    let reads = 0;
    await expect(importPlannedSiteAttachment({ plan: ready.plan, source: ready.source, assetId: 'hero',
      wp: { wpPath: '/wp' }, authority: { token: ready.token, journalPath: ready.journalPath },
      readTransport: async () => JSON.stringify(++reads === 1 ? ready.marked : after),
      mutationTransport: async () => JSON.stringify({ status: 'complete', id: 44, sha256: ready.source.assets[0]!.sha256 }),
    })).rejects.toBeInstanceOf(SiteMediaImportOutcomeUnknown);
  });
});
