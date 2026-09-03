#!/usr/bin/env node
/*
 * Browser half of the real-WordPress proof ladder. It is intentionally a
 * plain Node program instead of a normal project test: the proof runner gives
 * it one generated-block fixture and stores its JSON/log/image output in the
 * receipt's immutable evidence store.
 *
 * The WordPress utilities are used for page/admin/editor lifecycle setup. The
 * visible inserter interaction remains explicit below because that is a claim
 * we need to prove, not an implementation detail that should be hidden in an
 * `editor.insertBlock()` shortcut.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import * as WordPressPlaywright from '@wordpress/e2e-test-utils-playwright';
import axe from 'axe-core';

const args = new Map(process.argv.slice(2).filter((value, index, values) => index % 2 === 0).map((key, index) => [key, process.argv.slice(2)[index * 2 + 1]]));
const configPath = args.get('--config');
const outputPath = args.get('--out');

if (!configPath || !outputPath) {
  throw new Error('Usage: node scripts/proof-playwright.mjs --config <proof.json> --out <result.json>');
}

const input = JSON.parse(await readFile(configPath, 'utf8'));
const fixture = input.fixture;
const baseUrl = (input.baseUrl ?? 'http://localhost:8888').replace(/\/$/, '');
const outputDir = path.dirname(outputPath);
const artifactDir = path.join(outputDir, 'artifacts');
await mkdir(artifactDir, { recursive: true });

const gates = {};
const set = (gate, status, reason, details, artifacts) => {
  gates[gate] = {
    status,
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
    ...(artifacts?.length ? { artifacts } : {}),
  };
};
const blocked = (gate, reason) => set(gate, 'blocked', reason);
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
const responses = [];
let publication;
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => {
  const request = response.request();
  responses.push({ url: response.url(), method: request.method(), resourceType: request.resourceType(), status: response.status() });
});
page.on('requestfailed', (request) => responses.push({ url: request.url(), method: request.method(), resourceType: request.resourceType(), status: 0, failure: request.failure()?.errorText }));

try {
  await login(page, baseUrl);

  if (input.mode === 'deactivated') {
    await proveDeactivation(page, fixture, baseUrl, input.publication);
  } else {

    // Exercise the official utilities as part of the WordPress browser runtime.
    const PageUtils = WordPressPlaywright.PageUtils;
    const Admin = WordPressPlaywright.Admin;
    const Editor = WordPressPlaywright.Editor;
    const pageUtils = PageUtils ? new PageUtils({ page }) : undefined;
    const admin = Admin ? new Admin({ page, pageUtils }) : undefined;
    const editor = Editor ? new Editor({ page }) : undefined;
    if (admin?.visitAdminPage) {
      await admin.visitAdminPage('post-new.php');
    } else {
      await page.goto(`${baseUrl}/wp-admin/post-new.php`, { waitUntil: 'networkidle' });
    }

  const clientBlock = await page.evaluate((name) => Boolean(globalThis.wp?.blocks?.getBlockType(name)), fixture.blockName);
  set('client_registry', clientBlock ? 'pass' : 'fail', clientBlock ? undefined : 'Client block registry did not contain the generated block.', {
    block: fixture.blockName,
  });

  const inserted = await insertThroughVisibleInserter(page, fixture);
  set('editor_inserter', inserted ? 'pass' : 'fail', inserted ? undefined : 'Could not insert the block through the visible inserter.');

  const preEdit = await editorState(page);
  const fieldResult = await editAllFields(page, editor, fixture.editableFields ?? []);
  set('editor_field_editing', fieldResult.status, fieldResult.reason, fieldResult.details);

  const saved = await savePost(page, editor);
  const savedState = await editorState(page);
  const editPersistence = editedValuesPersisted(preEdit, savedState, fixture.editableFields ?? []);
  const savePassed = saved && editPersistence.ok;
  set('editor_save', savePassed ? 'pass' : 'fail', savePassed ? undefined : 'Editor save did not persist the edited block values.', {
    preEdit,
    saved: savedState,
    editPersistence,
  });

  const reopened = await reopenPost(page);
  const reopenedState = await editorState(page);
  const reopenPersistence = editedValuesPersisted(preEdit, reopenedState, fixture.editableFields ?? []);
  const persisted = savePassed && reopened && savedState.contentHash === reopenedState.contentHash && savedState.treeHash === reopenedState.treeHash && reopenPersistence.ok;
  set('editor_reopen', persisted ? 'pass' : 'fail', persisted ? undefined : 'Saved editor tree/content changed after reopening.', {
    preEdit,
    saved: savedState,
    reopened: reopenedState,
    reopenPersistence,
  });

  await provePatternOverride(page, fixture);
  const published = await publishPost(page, editor);
  const publishedState = await editorState(page);
  publication = published ? await readPublication(page, publishedState.content) : undefined;
  await proveAxeEditor(page, fixture);
  await proveFrontend(page, fixture, baseUrl, publication);
  await proveVisual(page, fixture, artifactDir);
  await proveAxeFrontend(page, fixture);
    set('accessibility_manual_review', fixture.accessibility?.manualReview ?? 'blocked',
      fixture.accessibility?.manualReview ? 'Manual review status supplied by fixture.' : 'No manual review scope was supplied.');
  }
} catch (error) {
  // Do not put a catch-all pass/skip around a partially running browser. Each
  // not-yet-recorded required browser claim stays blocked in the final receipt.
  for (const gate of input.mode === 'deactivated' ? [
    'static_deactivation_assets', 'static_deactivation_editor_controls',
  ] : [
    'client_registry', 'editor_inserter', 'editor_field_editing', 'editor_save', 'editor_reopen',
    'frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_media', 'frontend_assets',
    'frontend_runtime_errors', 'pattern_overrides', 'visual_regression', 'accessibility_editor',
    'accessibility_frontend', 'accessibility_manual_review',
  ]) {
    if (!gates[gate]) blocked(gate, error instanceof Error ? error.message : String(error));
  }
} finally {
  const runtime = { consoleErrors, pageErrors, responses };
  if (gates.frontend_runtime_errors?.details) {
    gates.frontend_runtime_errors.details.runtime = runtime;
  }
  await browser.close();
}

const executablePath = chromium.executablePath();
const revision = /(?:chromium|chrome|headless_shell)[-_](\d+)/i.exec(executablePath)?.[1] ?? 'unobserved';
await writeFile(outputPath, JSON.stringify({ gates, publication, environment: { browser: { version: browserVersion, revision, executablePath } } }, null, 2), 'utf8');

async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  if (!/wp-login\.php/.test(page.url())) return;
  await page.locator('#user_login').fill(process.env.WP_USERNAME ?? 'admin');
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD ?? 'password');
  await Promise.all([
    page.waitForLoadState('networkidle'),
    page.locator('#wp-submit').click(),
  ]);
}

async function insertThroughVisibleInserter(page, fixture) {
  const toggle = page.getByRole('button', { name: /toggle block inserter|add block/i }).first();
  if (!(await toggle.isVisible().catch(() => false))) return false;
  await toggle.click();
  const search = page.getByPlaceholder(/search for blocks and patterns/i).first();
  if (!(await search.isVisible().catch(() => false))) return false;
  await search.fill(fixture.blockTitle ?? fixture.blockName);
  const candidate = page.getByRole('button', { name: new RegExp(fixture.blockTitle ?? fixture.blockName, 'i') }).first();
  if (!(await candidate.isVisible().catch(() => false))) return false;
  await candidate.click();
  return true;
}

async function insertPatternThroughVisibleInserter(page, title) {
  const toggle = page.getByRole('button', { name: /toggle block inserter|add block/i }).first();
  if (!(await toggle.isVisible().catch(() => false))) return false;
  await toggle.click();
  const search = page.getByPlaceholder(/search for blocks and patterns/i).first();
  if (!(await search.isVisible().catch(() => false))) return false;
  await search.fill(title);
  const candidate = page.getByText(title, { exact: false }).first();
  if (!(await candidate.isVisible().catch(() => false))) return false;
  await candidate.click();
  return true;
}

async function hasVisibleInserterCandidate(page, title) {
  const toggle = page.getByRole('button', { name: /toggle block inserter|add block/i }).first();
  if (!(await toggle.isVisible().catch(() => false))) return false;
  await toggle.click();
  const search = page.getByPlaceholder(/search for blocks and patterns/i).first();
  if (!(await search.isVisible().catch(() => false))) return false;
  await search.fill(title);
  return page.getByText(title, { exact: false }).first().isVisible().catch(() => false);
}

async function editAllFields(page, editor, fields) {
  if (fields.length === 0) return { status: 'blocked', reason: 'Fixture declares no editable field classes.' };
  const edited = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    try {
      const value = field.value ?? `Proof edit ${field.path}`;
      if (field.selector) {
        await page.locator(field.selector).fill(value);
      } else if (field.surface === 'richText') {
        const canvas = editor?.canvas ?? page;
        const richTextIndex = fields.slice(0, index).filter((candidate) => candidate.surface === 'richText' && !candidate.selector).length;
        await canvas.locator('[contenteditable="true"]').nth(richTextIndex).fill(value);
      } else if (field.surface === 'altText') {
        const control = page.getByLabel(/alt text|alternative text/i).first();
        await control.fill(value);
      } else if (field.surface === 'link') {
        const control = page.getByLabel(/url|link/i).first();
        await control.fill(value);
      } else if (field.surface === 'media') {
        const replace = page.getByRole('button', { name: /replace|select media/i }).first();
        if (!(await replace.isVisible().catch(() => false))) throw new Error('No visible media selector.');
        await replace.click();
        const attachment = page.locator('.media-modal .attachment').first();
        if (!(await attachment.isVisible().catch(() => false))) throw new Error('Media library did not expose a selectable attachment.');
        await attachment.click();
        const select = page.getByRole('button', { name: /^select$/i }).last();
        if (!(await select.isVisible().catch(() => false))) throw new Error('Media library did not expose a Select action.');
        await select.click();
      }
      edited.push({ path: field.path, surface: field.surface, value });
    } catch (error) {
      return { status: 'fail', reason: `Could not edit ${field.path}: ${error instanceof Error ? error.message : String(error)}`, details: { edited } };
    }
  }
  return { status: 'pass', details: { edited } };
}

async function savePost(page, editor) {
  try {
    if (editor?.savePost) {
      await editor.savePost();
      return true;
    }
    const save = page.getByRole('button', { name: /save draft|update|publish/i }).first();
    await save.click();
    return true;
  } catch {
    return false;
  }
}

async function publishPost(page, editor) {
  try {
    if (editor?.publishPost) {
      await editor.publishPost();
      return true;
    }
    const publish = page.getByRole('button', { name: /^publish$/i }).first();
    if (!(await publish.isVisible().catch(() => false))) return false;
    await publish.click();
    const confirm = page.getByRole('button', { name: /^publish$/i }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    return true;
  } catch {
    return false;
  }
}

async function reopenPost(page) {
  try {
    await page.reload({ waitUntil: 'networkidle' });
    return true;
  } catch {
    return false;
  }
}

async function editorState(page) {
  return page.evaluate(async () => {
    const blocks = globalThis.wp?.data?.select('core/block-editor')?.getBlocks?.() ?? [];
    const content = globalThis.wp?.data?.select('core/editor')?.getEditedPostContent?.() ?? '';
    const canonical = JSON.stringify(blocks, (key, value) => key === 'clientId' ? undefined : value);
    const digest = async (value) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
      return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };
    return { treeHash: await digest(canonical), contentHash: await digest(content), tree: blocks, content };
  });
}

async function readPublication(page, savedContent) {
  const publication = await page.evaluate((content) => {
    const editor = globalThis.wp?.data?.select('core/editor');
    const post = editor?.getCurrentPost?.();
    const id = editor?.getCurrentPostId?.() ?? post?.id;
    const permalink = editor?.getPermalink?.() ?? post?.link;
    return { id: Number(id), permalink: typeof permalink === 'string' ? permalink : '', savedContent: content };
  }, savedContent);
  return Number.isInteger(publication.id) && publication.id > 0 && publication.permalink && publication.savedContent
    ? publication
    : undefined;
}

function editedValuesPersisted(before, after, fields) {
  const changed = before.contentHash !== after.contentHash || before.treeHash !== after.treeHash;
  const serialized = `${after.content}\n${JSON.stringify(after.tree)}`;
  const missingValues = fields
    .filter((field) => field.surface !== 'media')
    .map((field) => field.value ?? `Proof edit ${field.path}`)
    .filter((value) => !serialized.includes(value));
  return { ok: changed && missingValues.length === 0, changed, missingValues };
}

function frontendAssetResponses(entries) {
  return entries.filter((entry) => ['stylesheet', 'script'].includes(entry.resourceType));
}

function pluginOwnedAssets(entries, fixture) {
  const slug = fixture.pluginSlug ?? fixture.blockName.split('/').slice(1).join('-');
  const encodedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pluginPath = new RegExp(`/wp-content/plugins/${encodedSlug}(?:/|$)`, 'i');
  return entries.filter((entry) => pluginPath.test(new URL(entry.url).pathname));
}

async function provePublishedSemantics(page, selector, savedContent) {
  return page.evaluate(({ selector: scopedSelector, content }) => {
    const scope = document.querySelector(scopedSelector);
    if (!scope) return { ok: false, reason: 'scope_missing', expected: [], unmatched: [] };
    const template = document.createElement('template');
    template.innerHTML = content;
    const expected = [...template.content.querySelectorAll('*')]
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        role: element.getAttribute('role'),
      }))
      .filter((signature) => signature.text || signature.role || ['img', 'video', 'audio', 'svg'].includes(signature.tag));
    if (expected.length === 0) return { ok: false, reason: 'published_markup_has_no_semantic_elements', expected, unmatched: [] };
    const actual = [scope, ...scope.querySelectorAll('*')].map((element) => ({
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      role: element.getAttribute('role'),
    }));
    const unmatched = expected.filter((signature) => !actual.some((candidate) => candidate.tag === signature.tag
      && (!signature.text || candidate.text.includes(signature.text))
      && (!signature.role || candidate.role === signature.role)));
    return { ok: unmatched.length === 0, expected, unmatched };
  }, { selector, content: savedContent });
}

async function provePatternOverride(page, fixture) {
  const pattern = fixture.patternOverrides;
  if (!pattern?.title || !Array.isArray(pattern.editableFields) || pattern.editableFields.length === 0) {
    blocked('pattern_overrides', 'Pattern proof needs a titled pattern fixture and its editable fields.');
    return;
  }
  const inserted = await insertPatternThroughVisibleInserter(page, pattern.title);
  if (!inserted) {
    set('pattern_overrides', 'fail', `Could not insert the pattern fixture ${JSON.stringify(pattern.title)} through the visible inserter.`);
    return;
  }
  const before = await editorState(page);
  const edit = await editAllFields(page, undefined, pattern.editableFields);
  if (edit.status !== 'pass') {
    set('pattern_overrides', 'fail', edit.reason, { before, edit: edit.details });
    return;
  }
  const saved = await savePost(page);
  const afterSave = await editorState(page);
  const reopened = await reopenPost(page);
  const afterReopen = await editorState(page);
  const editedValues = pattern.editableFields.map((field) => field.value ?? `Proof edit ${field.path}`);
  const persisted = saved && reopened
    && afterSave.contentHash === afterReopen.contentHash
    && editedValues.every((value) => afterReopen.content.includes(value));
  set('pattern_overrides', persisted ? 'pass' : 'fail', persisted ? undefined : 'Pattern fixture edits did not persist after save and reopen.', {
    title: pattern.title,
    before,
    afterSave,
    afterReopen,
    editedValues,
  });
}

async function proveDeactivation(page, fixture, baseUrl, activePublication) {
  if (!activePublication?.permalink || !Array.isArray(activePublication.frontendAssets)) {
    blocked('static_deactivation_assets', 'Static deactivation proof needs the active run’s recorded published post and assets.');
  } else {
    const start = responses.length;
    const response = await page.goto(new URL(activePublication.permalink, baseUrl).toString(), { waitUntil: 'networkidle' });
    const assets = frontendAssetResponses(responses.slice(start));
    const activeAssets = activePublication.frontendAssets;
    const remaining = activeAssets.filter((asset) => assets.some((current) => current.url === asset.url));
    set('static_deactivation_assets', response && response.status() >= 200 && response.status() < 400 && activeAssets.length > 0 && remaining.length === 0 ? 'pass' : 'fail',
      remaining.length === 0 ? undefined : 'Assets recorded while the plugin was active were still requested after deactivation.', {
        postId: activePublication.id,
        permalink: activePublication.permalink,
        activeAssets,
        afterDeactivationAssets: assets,
        remaining,
      });
  }

  await page.goto(`${baseUrl}/wp-admin/post-new.php`, { waitUntil: 'networkidle' });
  const stillRegistered = await page.evaluate((name) => Boolean(globalThis.wp?.blocks?.getBlockType(name)), fixture.blockName);
  const stillVisible = await hasVisibleInserterCandidate(page, fixture.blockTitle ?? fixture.blockName);
  const removed = !stillRegistered && !stillVisible;
  set('static_deactivation_editor_controls', removed ? 'pass' : 'fail',
    removed ? undefined : 'Plugin-owned editor registration or visible inserter control remained after deactivation.', { block: fixture.blockName, stillRegistered, stillVisible });
}

async function proveFrontend(page, fixture, baseUrl, activePublication) {
  if (!fixture.frontend?.url) {
    for (const gate of ['frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_media', 'frontend_assets', 'frontend_runtime_errors']) {
      blocked(gate, 'Frontend proof needs fixture.frontend.url as an explicit proof scope.');
    }
    return;
  }
  if (!activePublication?.id || !activePublication.permalink || !activePublication.savedContent) {
    for (const gate of ['frontend_status', 'frontend_semantics', 'frontend_links', 'frontend_media', 'frontend_assets', 'frontend_runtime_errors']) {
      set(gate, 'fail', 'Could not record the post created and published by this proof run.');
    }
    return;
  }
  const responseStart = responses.length;
  const consoleStart = consoleErrors.length;
  const pageErrorStart = pageErrors.length;
  const response = await page.goto(new URL(activePublication.permalink, baseUrl).toString(), { waitUntil: 'networkidle' });
  const status = response?.status() ?? 0;
  const selector = fixture.frontend.subtreeSelector ?? 'main';
  const subtree = await page.locator(selector).first().innerHTML().catch(() => '');
  set('frontend_status', status >= 200 && status < 400 ? 'pass' : 'fail', status >= 200 && status < 400 ? undefined : `Frontend returned HTTP ${status}.`, { status });
  const semantic = await provePublishedSemantics(page, selector, activePublication.savedContent);
  set('frontend_semantics', semantic.ok ? 'pass' : 'fail', semantic.ok ? undefined : 'The published block structure was not present in the frontend subtree.', { selector, subtreeHash: sha256(subtree), publication: { id: activePublication.id, permalink: activePublication.permalink, contentHash: sha256(activePublication.savedContent) }, ...semantic });
  const links = await page.locator(`${selector} a`).evaluateAll((nodes) => nodes.map((node) => node.href));
  const expectedLinks = fixture.frontend.expectedLinks ?? [];
  const linksMatch = expectedLinks.length === 0 ? links.length === 0 : expectedLinks.every((link) => links.includes(link));
  set('frontend_links', linksMatch ? 'pass' : 'fail', linksMatch ? undefined : 'Frontend links did not match the fixture expectation.', { links, expectedLinks });
  const media = await page.locator(`${selector} img, ${selector} video, ${selector} audio`).evaluateAll((nodes) => nodes.map((node) => node.currentSrc || node.src));
  const expectedMedia = fixture.frontend.expectedMedia ?? [];
  const mediaInapplicable = expectedMedia.length === 0 && media.length === 0;
  const mediaMatch = expectedMedia.length > 0 && expectedMedia.every((source) => media.includes(source));
  set('frontend_media', mediaInapplicable ? 'not_applicable' : mediaMatch ? 'pass' : 'fail', mediaInapplicable || mediaMatch ? undefined : 'Frontend media did not match the fixture expectation.', { media, expectedMedia });
  const assets = frontendAssetResponses(responses.slice(responseStart));
  const ownedAssets = pluginOwnedAssets(assets, fixture);
  const ownedStyles = ownedAssets.filter((asset) => asset.resourceType === 'stylesheet');
  const healthyAssets = ownedAssets.every((asset) => asset.status >= 200 && asset.status < 400);
  const assetsPass = ownedStyles.length > 0 && healthyAssets;
  set('frontend_assets', assetsPass ? 'pass' : 'fail', assetsPass ? undefined : 'No successful plugin-owned stylesheet was observed on the published post, or a plugin asset failed.', { postId: activePublication.id, permalink: activePublication.permalink, assets, ownedAssets, ownedStyles });
  activePublication.frontendAssets = ownedAssets;
  const scopedErrors = { consoleErrors: consoleErrors.slice(consoleStart), pageErrors: pageErrors.slice(pageErrorStart) };
  const runtimePass = scopedErrors.consoleErrors.length === 0 && scopedErrors.pageErrors.length === 0;
  set('frontend_runtime_errors', runtimePass ? 'pass' : 'fail', runtimePass ? undefined : 'Frontend console or page errors were observed.', { postId: activePublication.id, permalink: activePublication.permalink, ...scopedErrors });
}

async function proveVisual(page, fixture, artifactDir) {
  if (!fixture.visual) return blocked('visual_regression', 'Fixture has no reviewed visual golden.');
  const actualPath = path.join(artifactDir, 'actual.png');
  const diffPath = path.join(artifactDir, 'diff.png');
  const expectedPath = path.join(artifactDir, 'expected.png');
  await page.screenshot({ path: actualPath, fullPage: true });
  try {
    const [{ PNG }, pixelmatchModule] = await Promise.all([import('pngjs'), import('pixelmatch')]);
    const pixelmatch = pixelmatchModule.default;
    const [expectedBytes, actualBytes] = await Promise.all([readFile(fixture.visual.expectedPath), readFile(actualPath)]);
    await writeFile(expectedPath, expectedBytes);
    const expected = PNG.sync.read(expectedBytes);
    const actual = PNG.sync.read(actualBytes);
    if (expected.width !== actual.width || expected.height !== actual.height) {
      // Retain a readable diff artifact even when pixels cannot be compared
      // one-for-one; the metadata records the dimension mismatch explicitly.
      await writeFile(diffPath, PNG.sync.write(new PNG({ width: actual.width, height: actual.height })));
      set('visual_regression', 'fail', 'Actual screenshot dimensions differ from the reviewed golden.', {
        expected: { width: expected.width, height: expected.height }, actual: { width: actual.width, height: actual.height },
        masks: fixture.visual.masks ?? [], threshold: fixture.visual.threshold,
      }, [{ path: 'artifacts/expected.png', mediaType: 'image/png' }, { path: 'artifacts/actual.png', mediaType: 'image/png' }, { path: 'artifacts/diff.png', mediaType: 'image/png' }]);
      return;
    }
    const diff = new PNG({ width: actual.width, height: actual.height });
    const differingPixels = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.1 });
    await writeFile(diffPath, PNG.sync.write(diff));
    const ratio = differingPixels / (actual.width * actual.height);
    set('visual_regression', ratio <= fixture.visual.threshold ? 'pass' : 'fail', ratio <= fixture.visual.threshold ? undefined : 'Visual diff exceeded the explicit threshold.', {
      expectedPath: fixture.visual.expectedPath, actualPath, diffPath, differingPixels, ratio,
      threshold: fixture.visual.threshold, masks: fixture.visual.masks ?? [],
      environment: { browser: 'chromium', deviceScaleFactor: 1 },
    }, [{ path: 'artifacts/expected.png', mediaType: 'image/png' }, { path: 'artifacts/actual.png', mediaType: 'image/png' }, { path: 'artifacts/diff.png', mediaType: 'image/png' }]);
  } catch (error) {
    blocked('visual_regression', `Visual comparison could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function proveAxeEditor(page, fixture) {
  if (!fixture.accessibility) {
    blocked('accessibility_editor', 'Fixture has no accessibility scope.');
    return;
  }
  await page.addScriptTag({ content: axe.source });
  const editor = await page.evaluate(async (selector) => globalThis.axe.run(selector), fixture.accessibility.editorSelector ?? '#editor');
  set('accessibility_editor', editor.violations.length === 0 ? 'pass' : 'fail', editor.violations.length === 0 ? undefined : 'Axe found editor subtree violations.', { axe: editor, selector: fixture.accessibility.editorSelector ?? '#editor' });
}

async function proveAxeFrontend(page, fixture) {
  if (!fixture.accessibility) {
    blocked('accessibility_frontend', 'Fixture has no accessibility scope.');
    return;
  }
  if (!fixture.frontend?.url) {
    blocked('accessibility_frontend', 'Fixture has no published frontend URL.');
    return;
  }
  await page.addScriptTag({ content: axe.source });
  const frontend = await page.evaluate(async (selector) => globalThis.axe.run(selector), fixture.accessibility.frontendSelector ?? fixture.frontend.subtreeSelector ?? 'main');
  set('accessibility_frontend', frontend.violations.length === 0 ? 'pass' : 'fail', frontend.violations.length === 0 ? undefined : 'Axe found frontend subtree violations.', {
    axe: frontend, selector: fixture.accessibility.frontendSelector ?? fixture.frontend.subtreeSelector ?? 'main',
  });
}
