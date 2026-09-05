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
const phases = [];
const phase = async (name, action) => {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  process.stderr.write(`[block-runner proof] browser ${name} started\n`);
  try {
    const result = await action();
    const durationMs = Date.now() - started;
    if (name === 'pattern-overrides') {
      await page.screenshot({ path: path.join(artifactDir, 'pattern-editor.png'), fullPage: true });
      await writeFile(path.join(artifactDir, 'pattern-editor.html'), await page.content(), 'utf8');
    }
    phases.push({ name, status: 'pass', startedAt, durationMs });
    process.stderr.write(`[block-runner proof] browser ${name} finished after ${durationMs}ms\n`);
    return result;
  } catch (error) {
    const durationMs = Date.now() - started;
    phases.push({
      name,
      status: 'fail',
      startedAt,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(`[block-runner proof] browser ${name} failed after ${durationMs}ms\n`);
    throw error;
  }
};

const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const page = await browser.newPage({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
let editorCanvas = page;
await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
// A failed native interaction should fail its phase rather than silently burn
// the whole proof's timeout one default Playwright wait at a time.
page.setDefaultTimeout(20_000);
page.setDefaultNavigationTimeout(20_000);
const consoleErrors = [];
const pageErrors = [];
const responses = [];
let publication;
let patternLifecycle;
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
  await phase('login', () => login(page, baseUrl));

  if (input.mode === 'deactivated') {
    await phase('deactivation-browser', () => proveDeactivation(page, fixture, baseUrl, input.publication));
  } else {

    // Exercise the official utilities as part of the WordPress browser runtime.
    const PageUtils = WordPressPlaywright.PageUtils;
    const Admin = WordPressPlaywright.Admin;
    const Editor = WordPressPlaywright.Editor;
    const pageUtils = PageUtils ? new PageUtils({ page }) : undefined;
    const admin = Admin ? new Admin({ page, pageUtils }) : undefined;
    const editor = Editor ? new Editor({ page }) : undefined;
    await phase('open-editor', async () => {
      if (admin?.visitAdminPage) {
        await admin.visitAdminPage('post-new.php');
      } else {
        await page.goto(`${baseUrl}/wp-admin/post-new.php`, { waitUntil: 'domcontentloaded' });
      }
      await waitForEditorReady(page);
    });

  const clientBlock = await page.evaluate((name) => Boolean(globalThis.wp?.blocks?.getBlockType(name)), fixture.blockName);
  set('client_registry', clientBlock ? 'pass' : 'fail', clientBlock ? undefined : 'Client block registry did not contain the generated block.', {
    block: fixture.blockName,
  });

  if (input.profile !== 'runtime') {
  const inserted = await phase('editor-inserter', () => insertThroughVisibleInserter(page, fixture));
  set('editor_inserter', inserted ? 'pass' : 'fail', inserted ? undefined : 'Could not insert the block through the visible inserter.');

  const preEdit = await editorState(page);
  if (fixture.patternOverrides?.requiredBindings) {
    const coverage = inspectGeneratedBlockCoverage(preEdit.content, fixture.blockName, fixture.patternOverrides.requiredBindings);
    if (!coverage.ok) {
      set('pattern_overrides', 'fail', 'The block inserted from the installed ZIP is missing confirmed native bindings.', { coverage, preEdit });
    }
  }
  const insertedRoots = preEdit.tree.filter((block) => block.name === fixture.blockName).map((block) => block.clientId);
  const fieldResult = inserted && insertedRoots.length === 1
    ? await phase('editor-field-editing', () => editAllFields(page, editor, fixture.editableFields ?? [], { rootClientIds: insertedRoots }))
    : { status: 'blocked', reason: 'No unique generated block was inserted; unrelated editor fields must not be touched.' };
  set('editor_field_editing', fieldResult.status, fieldResult.reason, fieldResult.details);

  const saved = await phase('editor-save', () => savePost(page, editor));
  const savedState = await editorState(page);
  const editPersistence = editedValuesPersisted(preEdit, savedState, fixture.editableFields ?? [], fixture.blockName);
  const savePassed = fieldResult.status === 'pass' && saved && editPersistence.ok && savedState.invalidBlocks.length === 0;
  set('editor_save', savePassed ? 'pass' : 'fail', savePassed ? undefined : 'Editor save did not persist the edited block values.', {
    preEdit,
    saved: savedState,
    editPersistence,
  });

  const reopened = await phase('editor-reopen', () => reopenPost(page));
  const reopenedState = await editorState(page);
  const reopenPersistence = editedValuesPersisted(preEdit, reopenedState, fixture.editableFields ?? [], fixture.blockName);
  const persisted = savePassed && reopened && reopenedState.invalidBlocks.length === 0 && savedState.contentHash === reopenedState.contentHash && savedState.treeHash === reopenedState.treeHash && reopenPersistence.ok;
  set('editor_reopen', persisted ? 'pass' : 'fail', persisted ? undefined : 'Saved editor tree/content changed after reopening.', {
    preEdit,
    saved: savedState,
    reopened: reopenedState,
    reopenPersistence,
  });

  // This is intentionally an iframe-only assertion. The direct root is the
  // regression surface: a page-level mock can prove hook calls but cannot
  // prove WordPress attached its grid/flex layout and native children to the
  // same editor-canvas element at both responsive widths.
  if (fixture.browserMatrix) {
    const matrix = await phase('editor-root-layout-matrix', () => proveEditorRootLayoutMatrix(page, fixture, artifactDir));
    const prior = gates.editor_reopen;
    const passed = prior?.status === 'pass' && matrix.ok;
    set('editor_reopen', passed ? 'pass' : 'fail', passed ? undefined
      : matrix.reason ?? prior?.reason ?? 'The generated root layout matrix did not complete.', {
      ...(prior?.details ?? {}),
      browserMatrix: matrix.details,
    }, [...(prior?.artifacts ?? []), ...matrix.artifacts]);
  }

  if (!input.profile || input.profile === 'full') {
  patternLifecycle = await phase('pattern-overrides', () => provePatternOverride(page, fixture));
  const published = await phase('publish', () => publishPost(page, editor));
  const publishedState = await editorState(page);
  publication = published ? await readPublication(page, publishedState.content) : undefined;
  await phase('accessibility-editor', () => proveAxeEditor(page, fixture, artifactDir));
  await phase('frontend', () => proveFrontend(page, fixture, baseUrl, publication, artifactDir));
  await phase('pattern-frontend', () => completePatternOverride(page, fixture, publication, patternLifecycle));
  await phase('visual-regression', () => proveVisual(page, fixture, artifactDir));
  await phase('accessibility-frontend', () => proveAxeFrontend(page, fixture, artifactDir));
    blocked('accessibility_manual_review', 'Manual review is verified separately against a saved input/ZIP-bound review record, not inferred from browser automation.');
  }
  }
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
  await page.screenshot({ path: path.join(artifactDir, 'final.png'), fullPage: true }).catch(() => undefined);
  await writeFile(path.join(artifactDir, 'final.html'), await page.content().catch(() => ''), 'utf8');
  let traceRetained = true;
  try {
    await page.context().tracing.stop({ path: path.join(artifactDir, 'trace.zip') });
  } catch (error) {
    traceRetained = false;
    process.exitCode = 1;
    for (const gate of Object.values(gates)) {
      if (gate.status === 'pass') {
        gate.status = 'blocked';
        gate.reason = `Browser trace could not be retained: ${error.message}`;
      }
    }
  }
  for (const gate of Object.values(gates)) {
    gate.artifacts = [...(gate.artifacts ?? []),
      { path: 'artifacts/final.html', mediaType: 'text/html' },
      ...(traceRetained ? [{ path: 'artifacts/trace.zip', mediaType: 'application/zip' }] : []),
    ];
  }
  await browser.close();
}

const executablePath = chromium.executablePath();
const revision = /(?:chromium|chrome|headless_shell)[-_](\d+)/i.exec(executablePath)?.[1] ?? 'unobserved';
await writeFile(outputPath, JSON.stringify({ gates, publication, phases, environment: { browser: { version: browserVersion, revision, executablePath } } }, null, 2), 'utf8');

async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  if (!/wp-login\.php/.test(page.url())) return;
  // Core's load handler focuses the username input. Let it finish before
  // typing the password, or that late focus can redirect Playwright's typing.
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.activeElement?.id === 'user_login');
  await page.locator('#user_login').fill(process.env.WP_USERNAME ?? 'admin');
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD ?? 'password');
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/wp-login.php'), { waitUntil: 'domcontentloaded' }),
    page.locator('#wp-submit').click(),
  ]);
}

async function waitForEditorReady(page, { requireCurrentBlocks = false } = {}) {
  await page.waitForFunction(
    () => Boolean(globalThis.wp?.data?.select('core/block-editor')?.getBlocks),
    undefined,
    { timeout: 20_000 },
  );
  // The block-editor data store comes up before either canvas arrangement is
  // guaranteed. Wait for the first observable canvas surface so we do not
  // decide on top-level rendering just because the API-v3 iframe is a moment
  // behind the store.
  await page.locator('iframe[name="editor-canvas"], .block-editor-writing-flow, .editor-styles-wrapper').first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  // WordPress creates the editor-canvas element before its document has
  // mounted the writing flow. In particular, a reopened post can expose a
  // fresh block-store tree while that iframe is still rendering the previous
  // document. Wait inside the frame before retaining the canvas locator, so
  // native block client IDs and their editable DOM controls belong to the
  // same editor instance.
  const iframe = page.locator('iframe[name="editor-canvas"]');
  let canvas;
  if (await iframe.count()) {
    canvas = page.frameLocator('iframe[name="editor-canvas"]');
    await canvas.locator('.block-editor-writing-flow, .editor-styles-wrapper').first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  } else {
    // Older WordPress editor configurations render the writing flow directly
    // in the top-level page.
    canvas = page;
    await page.locator('.block-editor-writing-flow, .editor-styles-wrapper').first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  }
  // A visible writing-flow wrapper alone is not proof that this is the
  // document currently represented by the block store: during a post reopen,
  // the previous iframe can remain visible while the new store is ready.
  // Capture the current store's client IDs and require one in this canvas
  // before it is retained for native-control interactions.
  const clientIds = await page.waitForFunction((requireBlocks) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(block.innerBlocks ?? [])]);
    const ids = visit(selector?.getBlocks?.() ?? [])
      .map((block) => block.clientId)
      .filter((clientId) => typeof clientId === 'string' && clientId.length > 0);
    return !requireBlocks || ids.length > 0 ? ids : false;
  }, requireCurrentBlocks, { timeout: 20_000 }).then((handle) => handle.jsonValue());
  if (clientIds.length > 0) {
    const currentBlockSelector = clientIds
      .map((clientId) => `[data-block=${JSON.stringify(clientId)}]`)
      .join(', ');
    await canvas.locator(currentBlockSelector).first().waitFor({ state: 'visible', timeout: 20_000 });
  }
  editorCanvas = canvas;
  const welcome = page.getByRole('dialog', { name: /welcome to the editor/i });
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole('button', { name: /close/i }).click();
  }
}
async function insertThroughVisibleInserter(page, fixture) {
  const search = await openVisibleInserter(page);
  await search.fill(fixture.blockTitle ?? fixture.blockName);
  const candidate = page.getByRole('tabpanel', { name: 'Blocks', exact: true })
    .getByRole('option', { name: fixture.blockTitle ?? fixture.blockName, exact: true }).and(page.locator('button'));
  await candidate.waitFor({ state: 'visible' });
  await candidate.click();
  await page.waitForFunction((name) => globalThis.wp.data.select('core/block-editor').getBlocks().some((block) => block.name === name), fixture.blockName);
  return true;
}

async function openVisibleInserter(page) {
  const toggle = page.getByRole('button', { name: /^(?:toggle )?block inserter$|^add block$/i }).first();
  await toggle.waitFor({ state: 'visible' });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const search = page.getByRole('tabpanel', { name: 'Blocks', exact: true }).getByPlaceholder('Search', { exact: true });
  await search.waitFor({ state: 'visible' });
  return search;
}

async function insertPatternThroughVisibleInserter(page, title) {
  const search = await openVisibleInserter(page);
  await search.fill(title);
  const candidate = page.getByRole('tabpanel', { name: 'Blocks', exact: true })
    .getByRole('option', { name: title, exact: true })
    .and(page.locator('.block-editor-block-patterns-list__item'));
  await candidate.waitFor({ state: 'visible' });
  await candidate.click();
  return true;
}

async function hasVisibleInserterCandidate(page, title) {
  const search = await openVisibleInserter(page);
  await search.fill(title);
  const candidate = page.getByRole('tabpanel', { name: 'Blocks', exact: true })
    .getByRole('option', { name: title, exact: true }).and(page.locator('button'));
  // Allow the debounced search to settle before claiming the deactivated
  // generated block is absent. A similarly named pattern is not that block.
  return candidate.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false);
}

async function editAllFields(page, editor, fields, scope) {
  if (fields.length === 0) return { status: 'blocked', reason: 'Fixture declares no editable field classes.' };
  const edited = [];
  for (const field of fields) {
    try {
      if (!scope?.rootClientIds?.length) throw new Error('No inserted block scope; unrelated editor fields must not be touched.');
      const value = field.value ?? `Proof edit ${field.path}`;
      if (field.selector) {
        const control = scopedLocator(page, scope, field.selector);
        if (await control.count() !== 1) throw new Error('The explicit field selector must match exactly one control inside the inserted block.');
        await control.fill(value);
        edited.push({ path: field.path, surface: field.surface, value, selector: field.selector });
        continue;
      }
      const target = await resolveNativeField(page, scope, field);
      if (field.surface === 'richText') {
        await editRichTextThroughNativeControl(page, target.clientId, value);
      } else if (field.surface === 'altText') {
        await selectNativeBlock(page, target.clientId);
        await page.getByRole('region', { name: 'Editor settings', exact: true })
          .getByLabel(/^(?:alt text|alternative text)$/i).fill(value);
      } else if (field.surface === 'link') {
        await editPatternButtonThroughNativeControls(page, target, { text: target.attributes.text, url: value });
      } else if (field.surface === 'media') {
        if (!field.media) throw new Error('Native media proof requires an explicit prepared attachment id, URL, and alt text.');
        await editPatternImageThroughNativeControls(page, target, field.media);
      } else {
        throw new Error('Unsupported editable surface.');
      }
      edited.push({ path: field.path, surface: field.surface, value, clientId: target.clientId, metadataName: field.metadataName });
    } catch (error) {
      return { status: 'fail', reason: `Could not edit ${field.path}: ${error instanceof Error ? error.message : String(error)}`, details: { edited } };
    }
  }
  return { status: 'pass', details: { edited } };
}

async function resolveNativeField(page, scope, field) {
  const candidates = await page.evaluate(({ roots, surface, metadataName }) => {
    const selector = globalThis.wp.data.select('core/block-editor');
    const visit = (block) => [block, ...selector.getBlocks(block.clientId).flatMap(visit)];
    const names = surface === 'richText' ? ['core/heading', 'core/paragraph', 'core/list-item', 'core/button']
      : surface === 'link' ? ['core/button'] : ['core/image'];
    return roots.flatMap((id) => {
      const root = selector.getBlock(id);
      return root ? visit(root) : [];
    }).filter((block) => names.includes(block.name) && (!metadataName || block.attributes?.metadata?.name === metadataName))
      .map((block) => ({ clientId: block.clientId, blockName: block.name, attributes: JSON.parse(JSON.stringify(block.attributes)) }));
  }, { roots: scope.rootClientIds, surface: field.surface, metadataName: field.metadataName });
  if (candidates.length !== 1) throw new Error(`Expected one native field target for ${field.path}, found ${candidates.length}; supply its exact metadataName or a scoped selector.`);
  return candidates[0];
}

function scopedLocator(page, scope, selector) {
  return combineLocators(scope.rootClientIds.map((clientId) =>
    editorCanvas.locator(`[data-block=${JSON.stringify(clientId)}]`).locator(selector)));
}


function combineLocators(locators) {
  const [first, ...rest] = locators;
  if (!first) throw new Error('Pattern scope did not contain any inserted roots.');
  return rest.reduce((combined, locator) => combined.or(locator), first);
}

async function savePost(page, editor) {
  try {
    const id = await page.evaluate(() => globalThis.wp.data.select('core/editor').getCurrentPostId());
    const save = page.getByRole('region', { name: 'Editor top bar', exact: true })
      .getByRole('button', { name: /^(?:save draft|save|update)$/i });
    const [response] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/wp/v2/posts/${id}`)
        && response.request().method() === 'POST'),
      save.click(),
    ]);
    if (!response.ok()) throw new Error(`WordPress save returned HTTP ${response.status()}.`);
    await page.waitForFunction(() => {
      const editor = globalThis.wp.data.select('core/editor');
      return !editor.isSavingPost() && !editor.isEditedPostDirty();
    });
    return true;
  } catch (error) {
    process.stderr.write(`[block-runner proof] save failed: ${error.message}\n`);
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
    // Editor heartbeat requests can keep networkidle open after the editor is
    // ready. The writing flow is the lifecycle condition that matters here.
    const id = await page.evaluate(() => globalThis.wp.data.select('core/editor').getCurrentPostId());
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) return false;
    await page.goto(`${baseUrl}/wp-admin/post.php?post=${Number(id)}&action=edit`, { waitUntil: 'domcontentloaded' });
    await waitForEditorReady(page, { requireCurrentBlocks: true });
    return true;
  } catch {
    return false;
  }
}

async function editorState(page) {
  return page.evaluate(async () => {
    const blocks = globalThis.wp?.data?.select('core/block-editor')?.getBlocks?.() ?? [];
    const content = globalThis.wp?.data?.select('core/editor')?.getEditedPostContent?.() ?? '';
    // Parser bookkeeping (originalContent, validationIssues) appears only
    // after reload. Compare the actual block contract, not transient internals.
    const stable = (value) => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
    const semantic = (nodes) => nodes.map((block) => ({
      name: block.name, attributes: stable(block.attributes ?? {}), innerBlocks: semantic(block.innerBlocks ?? []),
    }));
    const canonical = JSON.stringify(semantic(blocks));
    const digest = async (value) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
      return `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    };
    const invalidBlocks = [];
    const visit = (nodes) => nodes.forEach((block) => {
      if (block.isValid === false) invalidBlocks.push({ name: block.name, clientId: block.clientId });
      visit(block.innerBlocks ?? []);
    });
    visit(blocks);
    return { treeHash: await digest(canonical), contentHash: await digest(content), tree: blocks, content, invalidBlocks };
  });
}

/**
 * Retain a minimal grid/flex reproduction in the actual WordPress 7.1
 * editor iframe. The snapshots deliberately keep raw outerHTML as well as
 * concise observations: a reviewer can inspect both the DOM nesting and the
 * computed layout rather than having to infer them from a screenshot.
 */
async function proveEditorRootLayoutMatrix(page, fixture, artifactDir) {
  const matrix = fixture.browserMatrix;
  const artifacts = [];
  const details = {
    iframe: { requiredName: 'editor-canvas', observed: false },
    rootLayout: matrix.rootLayout,
    fontFamily: matrix.fontFamily,
    viewports: { desktop: matrix.desktopViewport, narrow: matrix.narrowViewport },
  };
  let handles;
  try {
    const frame = page.frames().find((candidate) => candidate.name() === 'editor-canvas');
    if (!frame) throw new Error('WordPress 7.1 editor-canvas iframe was not present; direct-page rendering is not accepted as layout evidence.');
    details.iframe.observed = true;
    await page.setViewportSize(matrix.desktopViewport);
    handles = await generatedRootHandles(page, fixture.blockName);
    if (handles.roots.length !== 1 || !handles.heading || !handles.image) {
      throw new Error(`Expected one generated root with a native heading and image before the matrix, found ${handles.roots.length}.`);
    }

    const keyboard = await exerciseEditorKeyboard(page, handles.heading.clientId);
    const keyboardPath = path.join(artifactDir, `editor-root-${matrix.rootLayout}-keyboard.png`);
    const keyboardReportPath = path.join(artifactDir, `editor-root-${matrix.rootLayout}-keyboard.json`);
    await editorCanvas.locator(`[data-block=${JSON.stringify(handles.root.clientId)}]`).screenshot({ path: keyboardPath, animations: 'disabled' });
    await writeFile(keyboardReportPath, JSON.stringify(keyboard, null, 2), 'utf8');
    artifacts.push(
      { path: `artifacts/${path.basename(keyboardPath)}`, mediaType: 'image/png' },
      { path: `artifacts/${path.basename(keyboardReportPath)}`, mediaType: 'application/json' },
    );

    const before = await editorRootSnapshot(page, fixture, handles.root.clientId, matrix);
    const beforeImage = path.join(artifactDir, `editor-root-${matrix.rootLayout}-before-desktop.png`);
    await editorCanvas.locator(`[data-block=${JSON.stringify(handles.root.clientId)}]`).screenshot({ path: beforeImage, animations: 'disabled' });
    artifacts.push({ path: `artifacts/${path.basename(beforeImage)}`, mediaType: 'image/png' });

    await updateNativeBlockAttributes(page, handles.heading.clientId, { content: matrix.longContent });
    await waitForNativeAttribute(page, handles.heading.clientId, 'content', matrix.longContent);
    const long = await editorRootSnapshot(page, fixture, handles.root.clientId, matrix);
    const longImage = path.join(artifactDir, `editor-root-${matrix.rootLayout}-after-long-desktop.png`);
    await editorCanvas.locator(`[data-block=${JSON.stringify(handles.root.clientId)}]`).screenshot({ path: longImage, animations: 'disabled' });
    artifacts.push({ path: `artifacts/${path.basename(longImage)}`, mediaType: 'image/png' });

    await page.setViewportSize(matrix.narrowViewport);
    await updateNativeBlockAttributes(page, handles.heading.clientId, { content: '' });
    await updateNativeBlockAttributes(page, handles.image.clientId, matrix.image);
    await waitForNativeAttribute(page, handles.heading.clientId, 'content', '');
    await waitForNativeAttributes(page, handles.image.clientId, matrix.image);
    const empty = await editorRootSnapshot(page, fixture, handles.root.clientId, matrix);
    const emptyImage = path.join(artifactDir, `editor-root-${matrix.rootLayout}-after-empty-narrow.png`);
    await editorCanvas.locator(`[data-block=${JSON.stringify(handles.root.clientId)}]`).screenshot({ path: emptyImage, animations: 'disabled' });
    artifacts.push({ path: `artifacts/${path.basename(emptyImage)}`, mediaType: 'image/png' });

    // Insert the second generated root through the visible inserter. Its
    // local native heading is then changed via the same store used by the
    // editor, while both iframe roots remain visible for the isolation DOM
    // capture. This avoids treating two selector matches as one instance.
    await insertThroughVisibleInserter(page, fixture);
    const pair = await generatedRootHandles(page, fixture.blockName);
    if (pair.roots.length !== 2 || !pair.roots[0]?.heading || !pair.roots[1]?.heading) {
      throw new Error(`Expected two visible generated roots for the isolation reproduction, found ${pair.roots.length}.`);
    }
    const first = pair.roots.find((root) => root.clientId === handles.root.clientId) ?? pair.roots[0];
    const second = pair.roots.find((root) => root.clientId !== first.clientId);
    if (!first?.heading || !second?.heading) throw new Error('Could not identify each generated root\'s native heading.');
    const isolatedContent = 'First generated root only';
    await updateNativeBlockAttributes(page, first.heading.clientId, { content: isolatedContent });
    await waitForNativeAttribute(page, first.heading.clientId, 'content', isolatedContent);
    const isolation = await editorInstanceIsolationSnapshot(page, fixture, [first.clientId, second.clientId], matrix);
    const isolationImage = path.join(artifactDir, `editor-root-${matrix.rootLayout}-two-instances-narrow.png`);
    await editorCanvas.locator(`[data-block=${JSON.stringify(first.clientId)}]`).screenshot({ path: isolationImage, animations: 'disabled' });
    artifacts.push({ path: `artifacts/${path.basename(isolationImage)}`, mediaType: 'image/png' });

    const matrixEvidence = { before, long, empty, isolation, keyboard };
    const matrixPath = path.join(artifactDir, `editor-root-${matrix.rootLayout}-matrix.json`);
    await writeFile(matrixPath, JSON.stringify(matrixEvidence, null, 2), 'utf8');
    artifacts.push({ path: `artifacts/${path.basename(matrixPath)}`, mediaType: 'application/json' });

    const beforeAfterRoots = [before, long, empty].every((snapshot) => snapshot.ok);
    const imageChanged = empty.image?.declaredWidth === matrix.image.width && empty.image?.declaredHeight === matrix.image.height;
    const isolated = isolation.ok && isolation.instances[0]?.text.includes(isolatedContent)
      && !isolation.instances[1]?.text.includes(isolatedContent);
    const ok = beforeAfterRoots && long.text.includes(matrix.longContent) && empty.headingContent === ''
      && imageChanged && isolated && keyboard.ok;
    details.beforeAfter = {
      ok: beforeAfterRoots,
      beforeDomHash: sha256(before.outerHTML),
      longDomHash: sha256(long.outerHTML),
      emptyDomHash: sha256(empty.outerHTML),
      longContentObserved: long.text.includes(matrix.longContent),
      emptyContentObserved: empty.headingContent === '',
      alteredImageObserved: imageChanged,
      directNativeChildren: before.directNativeChildren,
    };
    details.isolation = { ok: isolated, rootCount: isolation.instances.length, domHash: sha256(JSON.stringify(isolation)) };
    details.keyboard = keyboard.summary;
    return { ok, reason: ok ? undefined : 'Iframe root layout, content variants, image proportions, instance isolation, or keyboard evidence did not match the fixture.', details, artifacts };
  } catch (error) {
    details.error = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: details.error, details, artifacts };
  } finally {
    // Restore the exact root used by the normal edit/save/reopen proof and
    // remove the temporary second instance. The matrix is evidence, not a
    // hidden change to the post later used for pattern/frontend assertions.
    if (handles?.heading && handles?.image) {
      await updateNativeBlockAttributes(page, handles.heading.clientId, handles.heading.attributes).catch(() => undefined);
      await updateNativeBlockAttributes(page, handles.image.clientId, handles.image.attributes).catch(() => undefined);
      const roots = await generatedRootHandles(page, fixture.blockName).catch(() => undefined);
      const temporary = roots?.roots.find((root) => root.clientId !== handles.root.clientId);
      if (temporary) await removeNativeBlock(page, temporary.clientId).catch(() => undefined);
    }
    await page.setViewportSize(matrix.desktopViewport).catch(() => undefined);
  }
}

async function generatedRootHandles(page, blockName) {
  return page.evaluate((name) => {
    const select = globalThis.wp?.data?.select('core/block-editor');
    const blocks = select?.getBlocks?.() ?? [];
    const visit = (block) => [block, ...(block.innerBlocks ?? []).flatMap(visit)];
    const roots = blocks.filter((block) => block.name === name).map((root) => {
      const descendants = visit(root);
      const heading = descendants.find((block) => block.name === 'core/heading');
      const image = descendants.find((block) => block.name === 'core/image');
      return {
        clientId: root.clientId,
        heading: heading ? { clientId: heading.clientId, attributes: JSON.parse(JSON.stringify(heading.attributes ?? {})) } : undefined,
        image: image ? { clientId: image.clientId, attributes: JSON.parse(JSON.stringify(image.attributes ?? {})) } : undefined,
      };
    });
    const root = roots[0];
    return { roots, root, heading: root?.heading, image: root?.image };
  }, blockName);
}

async function updateNativeBlockAttributes(page, clientId, attributes) {
  await page.evaluate(({ id, next }) => {
    const dispatch = globalThis.wp?.data?.dispatch('core/block-editor');
    if (!dispatch?.updateBlockAttributes) throw new Error('WordPress block-editor dispatch was unavailable.');
    dispatch.updateBlockAttributes(id, next);
  }, { id: clientId, next: attributes });
}

async function removeNativeBlock(page, clientId) {
  await page.evaluate((id) => {
    const dispatch = globalThis.wp?.data?.dispatch('core/block-editor');
    if (!dispatch?.removeBlock) throw new Error('WordPress block-editor removeBlock was unavailable.');
    dispatch.removeBlock(id, false);
  }, clientId);
}

async function waitForNativeAttribute(page, clientId, attribute, expected) {
  await page.waitForFunction(({ id, key, value }) => {
    const actual = globalThis.wp?.data?.select('core/block-editor')?.getBlock?.(id)?.attributes?.[key];
    return actual === value;
  }, { id: clientId, key: attribute, value: expected });
}

async function waitForNativeAttributes(page, clientId, expected) {
  await page.waitForFunction(({ id, values }) => {
    const actual = globalThis.wp?.data?.select('core/block-editor')?.getBlock?.(id)?.attributes ?? {};
    return Object.entries(values).every(([key, value]) => actual[key] === value);
  }, { id: clientId, values: expected });
}

async function exerciseEditorKeyboard(page, headingId) {
  // WordPress can defer mounting a native RichText surface until its block is
  // selected after reopening a post. Select the exact heading from the active
  // editor canvas before treating its contenteditable element as ready.
  await selectNativeBlock(page, headingId);
  const heading = editorCanvas.locator(`[data-block=${JSON.stringify(headingId)}][contenteditable="true"], [data-block=${JSON.stringify(headingId)}] [contenteditable="true"]`).first();
  await heading.waitFor({ state: 'visible' });
  const original = (await heading.textContent()) ?? '';
  await heading.click();
  await heading.press('End');
  await heading.pressSequentially(' keyboard matrix');
  await heading.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await heading.waitFor({ state: 'visible' });
  const restored = (await heading.textContent()) ?? '';
  return {
    ok: restored === original,
    summary: { original, restored, undoRestored: restored === original, scope: 'editor-canvas' },
  };
}

async function editorRootSnapshot(page, fixture, clientId, matrix) {
  const root = editorCanvas.locator(`[data-block=${JSON.stringify(clientId)}]`);
  await root.waitFor({ state: 'visible' });
  const rootClass = `wp-block-${fixture.blockName.replace('/', '-')}`;
  return root.evaluate(async (element, { expectedLayout, expectedDirectNativeChildren, fontFamily, pluginSlug, rootClass: expectedClass }) => {
    await document.fonts?.ready;
    await document.fonts?.load(`16px "${fontFamily}"`);
    const stylesheets = [...document.styleSheets].map((sheet) => {
      let hasRootRule = false;
      try { hasRootRule = [...sheet.cssRules].some((rule) => rule.cssText.includes(expectedClass)); } catch { /* opaque styles are recorded by href below */ }
      return { href: sheet.href || null, hasRootRule };
    });
    const style = getComputedStyle(element);
    const image = element.querySelector('img');
    const heading = [...element.querySelectorAll('[data-type="core/heading"]')][0];
    const direct = [...element.children].map((child) => ({
      tag: child.tagName.toLowerCase(),
      block: child.getAttribute('data-type'),
      clientId: child.getAttribute('data-block'),
      className: child.className,
    }));
    const sharedStyles = stylesheets.some((sheet) => sheet.hasRootRule
      || Boolean(sheet.href && sheet.href.includes(`/wp-content/plugins/${pluginSlug}/`)));
    const declaredWidth = image?.style.width || image?.getAttribute('width') || '';
    const declaredHeight = image?.style.height || image?.getAttribute('height') || '';
    const snapshot = {
      scope: window.frameElement?.getAttribute('name') ?? null,
      outerHTML: element.outerHTML,
      text: element.textContent ?? '',
      headingContent: heading?.textContent?.replace(/\uFEFF/g, '') ?? null,
      display: style.display,
      gridTemplateColumns: style.gridTemplateColumns,
      flexDirection: style.flexDirection,
      directNativeChildren: direct.filter((child) => Boolean(child.clientId)).map((child) => child.block),
      hasInnerBlocksWrapper: Boolean(element.querySelector(':scope > .block-editor-inner-blocks')),
      sharedStyles,
      stylesheets,
      fontLoaded: document.fonts?.check(`16px "${fontFamily}"`) ?? false,
      image: image ? {
        declaredWidth,
        declaredHeight,
        renderedWidth: Math.round(image.getBoundingClientRect().width),
        renderedHeight: Math.round(image.getBoundingClientRect().height),
      } : undefined,
    };
    snapshot.ok = snapshot.scope === 'editor-canvas'
      && snapshot.display === expectedLayout
      && JSON.stringify(snapshot.directNativeChildren) === JSON.stringify(expectedDirectNativeChildren)
      && !snapshot.hasInnerBlocksWrapper
      && snapshot.sharedStyles
      && snapshot.fontLoaded;
    return snapshot;
  }, { expectedLayout: matrix.rootLayout, expectedDirectNativeChildren: matrix.directNativeChildren, fontFamily: matrix.fontFamily, pluginSlug: fixture.pluginSlug ?? fixture.blockName.split('/').slice(1).join('-'), rootClass });
}

async function editorInstanceIsolationSnapshot(page, fixture, clientIds, matrix) {
  const snapshots = [];
  for (const clientId of clientIds) snapshots.push(await editorRootSnapshot(page, fixture, clientId, matrix));
  return {
    ok: snapshots.every((snapshot) => snapshot.ok),
    instances: snapshots.map(({ outerHTML, ...snapshot }) => ({ ...snapshot, outerHTML })),
  };
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

function editedValuesPersisted(before, after, fields, blockName) {
  const changed = before.contentHash !== after.contentHash || before.treeHash !== after.treeHash;
  const roots = after.tree.filter((block) => block.name === blockName);
  const visit = (nodes) => nodes.flatMap((node) => [node, ...visit(node.innerBlocks ?? [])]);
  const nodes = roots.length === 1 ? visit(roots) : [];
  const checks = fields.map((field) => {
    const names = field.surface === 'richText' ? ['core/heading', 'core/paragraph', 'core/list-item', 'core/button']
      : field.surface === 'link' ? ['core/button'] : ['core/image'];
    const candidates = nodes.filter((node) => names.includes(node.name)
      && (!field.metadataName || node.attributes?.metadata?.name === field.metadataName));
    const target = candidates.length === 1 ? candidates[0] : undefined;
    const attribute = field.surface === 'richText' ? (target?.name === 'core/button' ? 'text' : 'content')
      : field.surface === 'altText' ? 'alt' : 'url';
    const value = field.value ?? `Proof edit ${field.path}`;
    const expected = field.surface === 'media' ? field.media : { [attribute]: value };
    const actual = target?.attributes ?? {};
    const ok = Boolean(target && expected && Object.entries(expected).every(([key, expectedValue]) => actual[key] === expectedValue));
    return { path: field.path, metadataName: field.metadataName, matches: candidates.length, expected, actual, ok };
  });
  // Values elsewhere in the post (including its title or another block) cannot
  // satisfy this claim. Reopen also compares the exact saved serialization.
  return { ok: changed && roots.length === 1 && checks.length > 0 && checks.every((check) => check.ok), changed, checks };
}

function frontendAssetResponses(entries) {
  return entries.filter((entry) => ['stylesheet', 'script'].includes(entry.resourceType));
}

async function inlineFrontendStyles(page) {
  const styles = await page.locator('style').evaluateAll((nodes) => nodes.flatMap((node) => {
    const content = node.textContent ?? '';
    // WordPress retains the registered source URL when it inlines small CSS.
    const url = /\/\*# sourceURL=(https?:\/\/[^\s*]+) \*\//.exec(content)?.[1];
    return url && node.sheet?.cssRules.length ? [{ url, content, id: node.id }] : [];
  }));
  return styles.map(({ content, ...style }) => ({ ...style, resourceType: 'stylesheet', delivery: 'inline', contentHash: sha256(content) }));
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
  if (gates.pattern_overrides?.status === 'fail') return;
  const pattern = fixture.patternOverrides;
  if (!isCompletePatternFixture(pattern)) {
    blocked('pattern_overrides', 'Pattern proof needs canonical wp_block content, two instances, reset/update assertions, binding inventory, structural policy, and a negative binding.');
    return undefined;
  }

  const canonical = pattern.storedCanonicalContent ?? pattern.canonicalContent;
  const bindingCheck = inspectRequiredPatternBindings(canonical, pattern.requiredBindings);
  const generatedBlockCheck = inspectGeneratedBlockCoverage(canonical, fixture.blockName, pattern.requiredBindings);
  if (!bindingCheck.ok || !generatedBlockCheck.ok) {
    set('pattern_overrides', 'fail', 'The saved canonical wp_block did not keep every required binding inside the generated block.', {
      canonicalWpBlockContent: canonical,
      bindingCheck,
      generatedBlockCheck,
    });
    return undefined;
  }

  const negative = await proveSavedMissingBinding(page, pattern);
  if (!negative.ok) {
    set('pattern_overrides', 'fail', 'A deficient synced pattern did not produce the required persisted negative result in WordPress.', {
      canonicalWpBlockContent: canonical,
      negative,
    });
    return undefined;
  }

  const initial = await editorState(page);
  const firstInserted = await insertPatternThroughVisibleInserter(page, pattern.title);
  const secondInserted = firstInserted && await insertPatternThroughVisibleInserter(page, pattern.title);
  if (!secondInserted) {
    set('pattern_overrides', 'fail', 'Could not insert two references to the synced pattern through the visible inserter.', {
      canonicalWpBlockContent: canonical,
      firstInserted,
      secondInserted,
    });
    return undefined;
  }

  const inserted = await patternInstanceStates(page, pattern.ref);
  if (inserted.length !== 2) {
    set('pattern_overrides', 'fail', 'Visible insertion did not create exactly two core/block references to the synced wp_block.', {
      canonicalWpBlockContent: canonical,
      inserted,
      expectedRef: pattern.ref,
    });
    return undefined;
  }

  const edited = [];
  for (let index = 0; index < pattern.instances.length; index += 1) {
    const instance = inserted[index];
    const desired = pattern.instances[index].content;
    const result = await editPatternInstanceThroughNativeControls(page, instance.clientId, desired);
    edited.push({ label: pattern.instances[index].label, clientId: instance.clientId, ...result });
  }
  if (!edited.every((result) => result.ok)) {
    set('pattern_overrides', 'fail', 'Native heading, image, or button controls did not produce the expected per-instance core/block.content map.', {
      canonicalWpBlockContent: canonical,
      inserted,
      edited,
    });
    return undefined;
  }

  const beforeSave = await patternInstanceStates(page, pattern.ref);
  const saved = await savePost(page);
  const afterSave = await editorState(page);
  const reopened = await reopenPost(page);
  const afterReload = await editorState(page);
  const persistedInstances = await patternInstanceStates(page, pattern.ref);
  const persisted = saved && reopened
    && afterSave.contentHash === afterReload.contentHash
    && samePatternInstances(persistedInstances, pattern.instances);
  if (!persisted) {
    set('pattern_overrides', 'fail', 'Distinct core/block.content values did not survive save and editor reopen.', {
      canonicalWpBlockContent: canonical,
      preSaveCoreBlockContent: beforeSave,
      afterSave,
      afterReload,
      reopenedCoreBlockContent: persistedInstances,
    });
    return undefined;
  }

  const canonicalUpdate = await updateCanonicalPattern(page, pattern.ref, pattern.canonicalUpdate.content);
  const canonicalReopened = canonicalUpdate.ok && await reopenPost(page);
  const afterCanonicalUpdate = await editorState(page);
  const afterCanonicalInstances = await patternInstanceStates(page, pattern.ref);
  const updatedGeneratedBlockCheck = canonicalUpdate.ok
    ? inspectGeneratedBlockCoverage(canonicalUpdate.content, fixture.blockName, pattern.requiredBindings)
    : { ok: false, reason: 'canonical_update_unavailable' };
  const canonicalReachedBoth = canonicalUpdate.ok && canonicalReopened
    && canonicalUpdate.content.includes(pattern.canonicalUpdate.marker)
    && updatedGeneratedBlockCheck.ok
    && samePatternInstances(afterCanonicalInstances, pattern.instances);
  if (!canonicalReachedBoth) {
    set('pattern_overrides', 'fail', 'A canonical layout/style update did not reach both synced instances without erasing local content.', {
      canonicalWpBlockContent: canonical,
      canonicalUpdate,
      updatedGeneratedBlockCheck,
      afterCanonicalUpdate,
      coreBlockContent: afterCanonicalInstances,
    });
    return undefined;
  }

  const resetTarget = afterCanonicalInstances[pattern.reset.instance];
  const reset = await resetPatternOverride(page, resetTarget?.clientId, pattern.reset.name, pattern.reset.attribute);
  const resetSaved = await savePost(page);
  const resetReopened = await reopenPost(page);
  const afterReset = await editorState(page);
  const resetInstances = await patternInstanceStates(page, pattern.ref);
  const resetContent = resetInstances[pattern.reset.instance]?.content ?? {};
  const resetApplied = reset.ok && resetSaved && resetReopened
    && !hasOverrideValue(resetContent, pattern.reset.name, pattern.reset.attribute)
    && canonicalUpdate.content.includes(pattern.reset.fallback)
    && samePatternContent(resetInstances[1 - pattern.reset.instance]?.content, pattern.instances[1 - pattern.reset.instance].content);
  if (!resetApplied) {
    set('pattern_overrides', 'fail', 'Resetting one local override did not return that instance to canonical fallback without changing the other instance.', {
      canonicalWpBlockContent: canonical,
      canonicalAfterUpdate: canonicalUpdate.content,
      reset,
      resetCoreBlockContent: resetInstances,
      resetEditorState: afterReset,
    });
    return undefined;
  }

  const structural = await observePatternStructure(page, pattern.ref, fixture.blockName, pattern.structuralPolicy);
  if (!structural.unavailable) {
    set('pattern_overrides', 'fail', 'Structural operations remained available under the fixture structural-lock policy.', {
      canonicalWpBlockContent: canonical,
      structural,
    });
    return undefined;
  }

  return {
    canonicalWpBlockContent: canonical,
    initial,
    insertedCoreBlockContent: inserted,
    preSaveCoreBlockContent: beforeSave,
    afterSave,
    afterReload,
    reopenedCoreBlockContent: persistedInstances,
    canonicalUpdate,
    afterCanonicalUpdate,
    afterCanonicalCoreBlockContent: afterCanonicalInstances,
    reset,
    afterReset,
    resetCoreBlockContent: resetInstances,
    structural,
    negative,
    // Retain per-instance native control and scope evidence in the receipt;
    // otherwise a passing guard would be enforced but impossible to audit.
    edited,
  };
}

function isCompletePatternFixture(pattern) {
  return Boolean(
    pattern
      && typeof pattern.title === 'string'
      && typeof pattern.ref === 'number'
      && typeof pattern.canonicalContent === 'string'
      && Array.isArray(pattern.instances)
      && pattern.instances.length === 2
      && typeof pattern.canonicalUpdate?.content === 'string'
      && typeof pattern.canonicalUpdate?.marker === 'string'
      && Array.isArray(pattern.requiredBindings)
      && pattern.requiredBindings.length > 0
      && pattern.reset
      && pattern.negative
      && typeof pattern.negative.value === 'string'
      && typeof pattern.negative.fallback === 'string'
      && typeof pattern.negative.ref === 'number'
      && typeof pattern.negative.title === 'string'
      && typeof pattern.negative.canonicalContent === 'string'
      && ['all', 'contentOnly'].includes(pattern.structuralPolicy),
  );
}

function inspectRequiredPatternBindings(content, required) {
  const blocks = parseBlockCommentAttributes(content);
  const missing = required.filter((requirement) => !blocks.some((block) => block.attributes?.metadata?.name === requirement.name
    && (block.attributes?.metadata?.bindings?.__default?.source === 'core/pattern-overrides'
      || block.attributes?.metadata?.bindings?.[requirement.attribute]?.source === 'core/pattern-overrides')));
  const structuralBinding = blocks.find((block) => block.attributes?.metadata?.bindings?.innerBlocks);
  return {
    ok: missing.length === 0 && !structuralBinding,
    missing,
    structuralBinding: structuralBinding ? structuralBinding.name : undefined,
    blocks,
  };
}

function inspectGeneratedBlockCoverage(content, blockName, required) {
  const opening = `<!-- wp:${blockName}`;
  const closing = `<!-- /wp:${blockName} -->`;
  const start = content.indexOf(opening);
  const openingEnd = start === -1 ? -1 : content.indexOf('-->', start);
  const end = openingEnd === -1 ? -1 : content.indexOf(closing, openingEnd + 3);
  if (start === -1 || openingEnd === -1 || end === -1) {
    return { ok: false, blockName, reason: 'generated_block_absent', missing: required };
  }
  const bindingCheck = inspectRequiredPatternBindings(content.slice(openingEnd + 3, end), required);
  return {
    ok: bindingCheck.ok,
    blockName,
    missing: bindingCheck.missing,
    structuralBinding: bindingCheck.structuralBinding,
  };
}

function parseBlockCommentAttributes(content) {
  const blocks = [];
  for (const match of content.matchAll(/<!-- wp:([^\s]+)(?:\s+({[\s\S]*?}))?\s*-->/g)) {
    try {
      blocks.push({ name: match[1], attributes: match[2] ? JSON.parse(match[2]) : {} });
    } catch {
      blocks.push({ name: match[1], attributes: undefined });
    }
  }
  return blocks;
}

/**
 * The negative is a separate wp_block saved by the runner with one binding
 * removed. Insert it through the UI, edit the otherwise-native control, save,
 * and reopen. A missing `core/block.content` value is meaningful only after
 * that real WordPress lifecycle, not after parsing a local string copy.
 */
async function proveSavedMissingBinding(page, pattern) {
  const negative = pattern.negative;
  const binding = { name: negative.name, attribute: negative.attribute };
  const bindingCheck = inspectRequiredPatternBindings(negative.canonicalContent, [binding]);
  if (bindingCheck.ok) {
    return { ok: false, reason: 'The saved negative wp_block still has the binding that should be absent.', bindingCheck };
  }
  const inserted = await insertPatternThroughVisibleInserter(page, negative.title);
  if (!inserted) return { ok: false, reason: 'Could not insert the saved deficient pattern through the visible inserter.' };
  const instances = await patternInstanceStates(page, negative.ref);
  if (instances.length !== 1) {
    return { ok: false, reason: 'Visible insertion did not create exactly one reference to the deficient wp_block.', instances, expectedRef: negative.ref };
  }
  const desired = { [negative.name]: { [negative.attribute]: negative.value } };
  const targets = await patternOverrideTargets(page, instances[0].clientId, desired);
  const target = targets.find((candidate) => candidate.name === negative.name);
  const readonly = target ? await editorCanvas.locator(`[data-block="${target.clientId}"]`).evaluate((node) => ({
    inert: node.hasAttribute('inert'),
    readonly: node.getAttribute('aria-readonly') === 'true',
    editable: node.getAttribute('contenteditable') === 'true',
    text: node.textContent,
  })) : undefined;
  // WordPress correctly makes a missing-binding field inert. Do not force a
  // click through that protection merely to satisfy a synthetic negative test.
  const refused = readonly?.inert && readonly.readonly && !readonly.editable && readonly.text === negative.fallback;
  const edited = refused
    ? { ok: true, control: 'native readonly field', observed: readonly }
    : await editPatternInstanceThroughNativeControls(page, instances[0].clientId, desired, {});
  const beforeSave = await patternInstanceStates(page, negative.ref);
  const saved = await savePost(page);
  const reopened = await reopenPost(page);
  const afterReopen = await patternInstanceStates(page, negative.ref);
  const content = afterReopen[0]?.content ?? {};
  const absentAfterLifecycle = !hasOverrideValue(content, negative.name, negative.attribute);
  const persistedTargets = afterReopen[0] ? await patternOverrideTargets(page, afterReopen[0].clientId, desired) : [];
  const persistedTarget = persistedTargets.find((candidate) => candidate.name === negative.name);
  const fallbackText = persistedTarget
    ? await editorCanvas.locator(`[data-block="${persistedTarget.clientId}"]`).textContent() : undefined;
  return {
    ok: edited.ok && saved && reopened && absentAfterLifecycle && fallbackText === negative.fallback,
    binding,
    savedNegativeWpBlockContent: negative.canonicalContent,
    inserted,
    edited,
    beforeSaveCoreBlockContent: beforeSave,
    afterReopenCoreBlockContent: afterReopen,
    absentAfterLifecycle,
    saved,
    reopened,
    fallbackText,
    expectedFallback: negative.fallback,
    expectedRejectedValue: negative.value,
  };
}

async function patternInstanceStates(page, ref) {
  return page.evaluate((patternRef) => {
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(block.innerBlocks ?? [])]);
    const blocks = visit(globalThis.wp?.data?.select('core/block-editor')?.getBlocks?.() ?? []);
    return blocks
      .filter((block) => block.name === 'core/block' && (patternRef === undefined || Number(block.attributes?.ref) === patternRef))
      .map((block) => ({
        clientId: block.clientId,
        ref: block.attributes?.ref,
        // RichTextData has a toJSON contract. structuredClone erases its
        // prototype and turns real edited content into an empty object.
        content: JSON.parse(JSON.stringify(block.attributes?.content ?? {})),
      }));
  }, ref);
}

/**
 * Edit every override through the control Gutenberg presents for that child
 * block. Reading `core/block.content` afterward is deliberate: it verifies
 * the native binding integration instead of bypassing it with a data-store
 * attribute update.
 */
async function editPatternInstanceThroughNativeControls(page, clientId, content, expectedStoredContent = content) {
  if (!clientId) return { ok: false, reason: 'Missing core/block clientId.' };
  const outsideBefore = await editorTreeOutsideRoot(page, clientId);
  const targets = await patternOverrideTargets(page, clientId, content);
  const expectedNames = Object.keys(content);
  if (targets.length !== expectedNames.length) {
    return { ok: false, reason: 'Could not resolve every bound child block inside the synced pattern.', targets, expectedNames };
  }

  const controls = [];
  try {
    for (const target of targets) {
      const values = content[target.name];
      if (target.blockName === 'core/image') {
        controls.push(await editPatternImageThroughNativeControls(page, target, values, clientId));
      } else if (target.blockName === 'core/heading' || target.blockName === 'core/paragraph' || target.blockName === 'core/list-item') {
        if (typeof values.content !== 'string') throw new Error(`${target.blockName} is missing a string content value.`);
        await editRichTextThroughNativeControl(page, target.clientId, values.content);
        await waitForPatternOverrideValue(page, clientId, target.name, 'content', values.content);
        controls.push({ block: target.blockName, control: 'richText', value: values.content });
      } else if (target.blockName === 'core/button') {
        controls.push(await editPatternButtonThroughNativeControls(page, target, values, clientId));
      } else {
        throw new Error(`No native override editor is defined for ${target.blockName}.`);
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), targets, controls };
  }

  const observed = (await patternInstanceStates(page, undefined)).find((instance) => instance.clientId === clientId);
  const outsideAfter = await editorTreeOutsideRoot(page, clientId);
  const outsideUnchanged = canonicalValue(outsideBefore) === canonicalValue(outsideAfter);
  const storedExpected = normalizeNativePatternContent(expectedStoredContent);
  return {
    ok: outsideUnchanged && samePatternContent(observed?.content, storedExpected),
    expectedNativeValue: content,
    expectedStoredContent: storedExpected,
    observed: observed?.content ?? {},
    scope: { rootClientId: clientId, outsideUnchanged, outsideBefore, outsideAfter },
    targets,
    controls,
  };
}

/**
 * Capture the editor's block contract outside one synced-pattern instance.
 * Native image/button controls are global toolbar/inspector surfaces, so this
 * guard is what proves a competing same-named field or another pattern
 * instance was not edited accidentally.
 */
async function editorTreeOutsideRoot(page, rootClientId) {
  return page.evaluate((excludedClientId) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const stable = (value) => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
    const visit = (blocks) => blocks.flatMap((block) => {
      if (block.clientId === excludedClientId) return [];
      return [{
        name: block.name,
        attributes: stable(JSON.parse(JSON.stringify(block.attributes ?? {}))),
        innerBlocks: visit(selector?.getBlocks?.(block.clientId) ?? []),
      }];
    });
    return visit(selector?.getBlocks?.() ?? []);
  }, rootClientId);
}

async function waitForPatternOverrideValue(page, clientId, name, attribute, expected) {
  await page.waitForFunction(({ patternClientId, metadataName, attributeName, value }) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const pattern = selector?.getBlock?.(patternClientId);
    // Rich-text overrides are Gutenberg's _RichTextData instances rather than
    // primitive strings. Their toJSON() is the persisted string, so comparing
    // JSON representations avoids treating a real native edit as missing.
    const actual = pattern?.attributes?.content?.[metadataName]?.[attributeName];
    return pattern?.name === 'core/block'
      && JSON.stringify(actual) === JSON.stringify(value);
  }, { patternClientId: clientId, metadataName: name, attributeName: attribute, value: expected });
}

async function patternOverrideTargets(page, clientId, content) {
  await page.waitForFunction(({ id, names }) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    if (!selector?.getBlock(id)) return false;
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(selector.getBlocks(block.clientId))]);
    const blocks = visit(selector.getBlocks(id));
    return names.every((name) => blocks.some((block) => block.attributes?.metadata?.name === name));
  }, { id: clientId, names: Object.keys(content) });
  return page.evaluate(({ patternClientId, desired }) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(selector.getBlocks(block.clientId))]);
    const root = selector?.getBlock?.(patternClientId);
    if (!root || root.name !== 'core/block') return [];
    return visit(selector.getBlocks(patternClientId))
      .flatMap((block) => {
        const name = block.attributes?.metadata?.name;
        return typeof name === 'string' && desired[name]
          ? [{ clientId: block.clientId, blockName: block.name, name, attributes: JSON.parse(JSON.stringify(block.attributes ?? {})) }]
          : [];
      });
  }, { patternClientId: clientId, desired: content });
}

async function selectNativeBlock(page, clientId) {
  const controller = await page.evaluate((id) => {
    const selector = globalThis.wp.data.select('core/block-editor');
    return selector.getBlockParents(id).find((parent) => selector.getBlockName(parent) === 'core/block');
  }, clientId);
  if (controller) {
    const selected = await page.evaluate((id) => {
      const selector = globalThis.wp.data.select('core/block-editor');
      return selector.isBlockSelected(id) || selector.hasSelectedInnerBlock(id, true);
    }, controller);
    if (!selected) await editorCanvas.locator(`[data-block="${controller}"]`).click({ position: { x: 2, y: 2 } });
  }
  const block = editorCanvas.locator(`[data-block="${clientId}"]`).first();
  if (!(await block.isVisible().catch(() => false))) throw new Error(`Native block ${clientId} is not visible in the editor canvas.`);
  await block.click();
  await page.waitForFunction((id) => globalThis.wp.data.select('core/block-editor').getSelectedBlockClientId() === id, clientId);
  return block;
}

async function selectedBlockToolbar(page, clientId) {
  await page.waitForFunction((id) => globalThis.wp.data.select('core/block-editor').getSelectedBlockClientId() === id, clientId);
  const toolbar = page.getByRole('toolbar', { name: 'Block tools', exact: true });
  await toolbar.waitFor({ state: 'visible' });
  return toolbar;
}

async function editRichTextThroughNativeControl(page, clientId, value) {
  const block = await selectNativeBlock(page, clientId);
  const field = editorCanvas.locator(`[data-block="${clientId}"][contenteditable="true"], [data-block="${clientId}"] [contenteditable="true"]`).first();
  await field.waitFor({ state: 'visible' });
  await field.fill(value);
}

async function editPatternImageThroughNativeControls(page, target, values, patternClientId) {
  if (!Number.isInteger(values.id) || typeof values.url !== 'string' || typeof values.alt !== 'string') {
    throw new Error('Image override requires id, url, and alt values from the prepared media library.');
  }
  if (Object.prototype.hasOwnProperty.call(values, 'title') && typeof values.title !== 'string') {
    throw new Error('Image title override requires a string value.');
  }
  if (Object.prototype.hasOwnProperty.call(values, 'caption') && typeof values.caption !== 'string') {
    throw new Error('Image caption override requires a string value.');
  }
  await selectNativeBlock(page, target.clientId);
  const toolbar = await selectedBlockToolbar(page, target.clientId);
  const replace = toolbar.getByRole('button', { name: 'Replace', exact: true });
  await replace.click();
  await page.getByRole('menuitem', { name: 'Open Media Library', exact: true }).click();
  const media = page.locator('.media-modal:visible');
  await media.getByRole('tab', { name: 'Media Library', exact: true }).click();
  const attachment = media.locator(`.attachment[data-id="${values.id}"]`);
  await attachment.waitFor({ state: 'visible' });
  await attachment.click();
  const select = media.getByRole('button', { name: /^select$/i });
  await select.click();
  await media.waitFor({ state: 'hidden' });

  await selectNativeBlock(page, target.clientId);
  const alt = page.getByRole('region', { name: 'Editor settings', exact: true }).getByLabel(/^(?:alt text|alternative text)$/i);
  await alt.fill(values.alt);
  await waitForPatternOverrideValueIfScoped(page, target, 'alt', values.alt, patternClientId);

  if (typeof values.title === 'string') {
    const titleToolbar = await selectedBlockToolbar(page, target.clientId);
    await titleToolbar.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Title text', exact: true }).click();
    const title = page.getByLabel('Title attribute', { exact: true });
    await title.fill(values.title);
    await waitForPatternOverrideValueIfScoped(page, target, 'title', values.title, patternClientId);
  }

  if (typeof values.caption === 'string') {
    const captionToolbar = await selectedBlockToolbar(page, target.clientId);
    const caption = editorCanvas.locator(`[data-block="${target.clientId}"] [contenteditable="true"][aria-label="Image caption text"]`).first();
    if (!(await caption.isVisible().catch(() => false))) {
      const addCaption = captionToolbar.getByRole('button', { name: 'Add caption', exact: true });
      await addCaption.waitFor({ state: 'visible' });
      await addCaption.click();
    }
    await caption.waitFor({ state: 'visible' });
    await caption.fill(values.caption);
    await waitForPatternOverrideValueIfScoped(page, target, 'caption', values.caption, patternClientId);
  }

  return {
    block: target.blockName,
    control: 'media+altText+title+caption',
    id: values.id,
    url: values.url,
    alt: values.alt,
    ...(typeof values.title === 'string' ? { title: values.title } : {}),
    ...(typeof values.caption === 'string' ? { caption: values.caption } : {}),
  };
}

async function editPatternButtonThroughNativeControls(page, target, values, patternClientId) {
  if (typeof values.text !== 'string' || typeof values.url !== 'string') {
    throw new Error('Button override requires text and url values.');
  }
  if (Object.prototype.hasOwnProperty.call(values, 'linkTarget') && typeof values.linkTarget !== 'string') {
    throw new Error('Button link target override requires a string value.');
  }
  if (Object.prototype.hasOwnProperty.call(values, 'rel') && typeof values.rel !== 'string') {
    throw new Error('Button relationship override requires a string value.');
  }
  const requestedRel = typeof values.rel === 'string' ? values.rel.trim() : undefined;
  const unsupportedRel = requestedRel?.split(/\s+/).filter(Boolean).filter((token) => !['noopener', 'nofollow'].includes(token)) ?? [];
  if (unsupportedRel.length > 0) {
    throw new Error(`Button relationship override contains tokens unavailable in WordPress's native link settings: ${unsupportedRel.join(', ')}`);
  }
  await editRichTextThroughNativeControl(page, target.clientId, values.text);
  await waitForPatternOverrideValueIfScoped(page, target, 'text', values.text, patternClientId);
  await selectNativeBlock(page, target.clientId);
  const toolbar = await selectedBlockToolbar(page, target.clientId);
  // Selecting an already-linked native Button opens its link preview. Its
  // toolbar says Unlink, not Link; do not remove the URL just to edit it.
  const control = page.locator('.block-editor-link-control:visible');
  if (target.attributes.url) {
    await control.getByRole('button', { name: 'Edit link', exact: true }).click();
  } else {
    await toolbar.getByRole('button', { name: 'Link', exact: true }).click();
  }
  const url = control.getByPlaceholder('Search or type URL', { exact: true });
  await url.fill(values.url);
  await page.waitForTimeout(100);
  const wantsTarget = values.linkTarget === '_blank';
  const wantsNoFollow = typeof requestedRel === 'string' && /(?:^|\s)nofollow(?:\s|$)/.test(requestedRel);
  if (Object.prototype.hasOwnProperty.call(values, 'linkTarget') || Object.prototype.hasOwnProperty.call(values, 'rel')) {
    await openNativeLinkSettings(control);
    await setNativeLinkSetting(page, 'Open in new tab', wantsTarget);
    await setNativeLinkSetting(page, 'Mark as nofollow', wantsNoFollow);
  }
  await control.getByRole('button', { name: 'Apply', exact: true }).click();
  if (patternClientId) {
    await waitForPatternOverrideValue(page, patternClientId, target.name, 'url', values.url);
    if (Object.prototype.hasOwnProperty.call(values, 'linkTarget')) {
      await waitForPatternOverrideValue(page, patternClientId, target.name, 'linkTarget', wantsTarget ? '_blank' : '');
    }
    if (Object.prototype.hasOwnProperty.call(values, 'rel')) {
      await waitForPatternOverrideValue(page, patternClientId, target.name, 'rel', nativeButtonRel(values));
    }
  }
  // Button's link preview remains visible while the block is selected, even
  // after Escape. Use WordPress's own breadcrumb to leave the selected block.
  await page.locator('.block-editor-block-breadcrumb').getByRole('button', { name: 'Post', exact: true }).click();
  await control.waitFor({ state: 'hidden' });
  return {
    block: target.blockName,
    control: 'richText+link+settings',
    text: values.text,
    url: values.url,
    ...(Object.prototype.hasOwnProperty.call(values, 'linkTarget') ? { linkTarget: wantsTarget ? '_blank' : '' } : {}),
    ...(Object.prototype.hasOwnProperty.call(values, 'rel') ? { rel: nativeButtonRel(values) } : {}),
  };
}

async function openNativeLinkSettings(control) {
  const toggle = control.getByRole('button', { name: 'Advanced', exact: true });
  // WordPress remembers this preference between blocks and browser sessions.
  // Clicking an already-open drawer closes it while its inputs animate away.
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await control.locator('.block-editor-link-control__drawer').waitFor({ state: 'visible' });
}

async function setNativeLinkSetting(page, labelText, wanted) {
  const control = page.locator('.block-editor-link-control:visible');
  const label = control.locator('label').filter({ hasText: labelText }).first();
  const inputId = await label.getAttribute('for');
  if (!inputId) throw new Error(`WordPress did not expose the native ${labelText} checkbox.`);
  const checkbox = page.locator(`#${inputId}`);
  const current = await checkbox.isChecked();
  if (current === wanted) return;
  await checkbox.setChecked(wanted);
  await page.waitForFunction(({ id, expected }) => document.getElementById(id)?.checked === expected, { id: inputId, expected: wanted });
}

function nativeButtonRel(values) {
  const tokens = typeof values.rel === 'string' ? values.rel.trim().split(/\s+/).filter(Boolean) : [];
  const withoutManaged = tokens.filter((token) => token !== 'noopener' && token !== 'nofollow');
  if (values.linkTarget === '_blank') withoutManaged.push('noopener');
  if (tokens.includes('nofollow')) withoutManaged.push('nofollow');
  return [...new Set(withoutManaged)].join(' ');
}

async function waitForPatternOverrideValueIfScoped(page, target, attribute, expected, patternClientId) {
  if (patternClientId) await waitForPatternOverrideValue(page, patternClientId, target.name, attribute, expected);
}

async function updateCanonicalPattern(page, ref, content) {
  return page.evaluate(async ({ patternRef, value }) => {
    try {
      const updated = await globalThis.wp?.apiFetch?.({
        path: '/wp/v2/blocks/' + patternRef,
        method: 'POST',
        data: { content: value },
      });
      return { ok: typeof updated?.content?.raw === 'string', content: updated?.content?.raw ?? '' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error), content: '' };
    }
  }, { patternRef: ref, value: content });
}

async function resetPatternOverride(page, clientId, name, attribute) {
  if (!clientId) return { ok: false, reason: 'No target core/block exists to reset.' };
  const targets = await patternOverrideTargets(page, clientId, { [name]: { [attribute]: true } });
  const target = targets.find((candidate) => candidate.name === name);
  if (!target) return { ok: false, reason: 'The bound child block is absent before reset.' };
  try {
    await selectNativeBlock(page, target.clientId);
    const toolbar = await selectedBlockToolbar(page, target.clientId);
    const reset = toolbar.getByRole('button', { name: 'Reset', exact: true });
    if (!(await reset.isVisible().catch(() => false))) {
      return { ok: false, reason: 'WordPress did not expose its native override reset control.' };
    }
    await reset.click();
    const observed = (await patternInstanceStates(page, undefined)).find((instance) => instance.clientId === clientId)?.content ?? {};
    return { ok: !hasOverrideValue(observed, name, attribute), content: observed, control: 'native reset' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function hasOverrideValue(content, name, attribute) {
  return Boolean(content?.[name] && Object.prototype.hasOwnProperty.call(content[name], attribute));
}

function samePatternInstances(actual, expected) {
  return actual.length === expected.length
    && actual.every((instance, index) => samePatternContent(instance.content, expected[index].content));
}

function samePatternContent(actual, expected) {
  return canonicalValue(actual ?? {}) === canonicalValue(normalizeNativePatternContent(expected ?? {}));
}

/**
 * Gutenberg's native Button link settings derive rel from the requested
 * target/nofollow toggles. Opening a link in a new tab adds `noopener`; the
 * native nofollow setting adds `nofollow`. Compare against that actual stored
 * contract while retaining the fixture's human-level requested values.
 */
function normalizeNativePatternContent(content) {
  return Object.fromEntries(Object.entries(content ?? {}).map(([name, attributes]) => {
    if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return [name, attributes];
    const normalized = { ...attributes };
    if (Object.prototype.hasOwnProperty.call(normalized, 'rel')
      || Object.prototype.hasOwnProperty.call(normalized, 'linkTarget')) {
      const requested = typeof normalized.rel === 'string' ? normalized.rel.trim() : '';
      const tokens = requested.split(/\s+/).filter(Boolean);
      const unmanaged = tokens.filter((token) => token !== 'noopener' && token !== 'nofollow');
      const target = normalized.linkTarget === '_blank';
      if (target) unmanaged.push('noopener');
      if (tokens.includes('nofollow')) unmanaged.push('nofollow');
      if (Object.prototype.hasOwnProperty.call(normalized, 'rel')) normalized.rel = [...new Set(unmanaged)].join(' ');
      if (Object.prototype.hasOwnProperty.call(normalized, 'linkTarget')) normalized.linkTarget = target ? '_blank' : '';
    }
    return [name, normalized];
  }));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalValue(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function observePatternStructure(page, ref, generatedBlockName, policy) {
  // The post itself can be ready before the async wp_block entity has hydrated
  // its controlled child tree and the wrapper has installed list settings.
  await page.waitForFunction(({ patternRef, wrapperName }) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(selector.getBlocks(block.clientId))]);
    const instances = visit(selector?.getBlocks?.() ?? []).filter((block) => block.name === 'core/block' && Number(block.attributes?.ref) === patternRef);
    return instances.length === 2 && instances.every((instance) => {
      const wrapper = visit(selector.getBlocks(instance.clientId)).find((block) => block.name === wrapperName);
      return wrapper && selector.getBlockListSettings(wrapper.clientId)?.templateLock !== undefined;
    });
  }, { patternRef: ref, wrapperName: generatedBlockName });
  return page.evaluate(({ patternRef, wrapperName, structuralPolicy }) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(selector.getBlocks(block.clientId))]);
    const blocks = visit(selector?.getBlocks?.() ?? [])
      .filter((candidate) => candidate.name === 'core/block' && Number(candidate.attributes?.ref) === patternRef);
    if (blocks.length !== 2) return { unavailable: false, reason: 'Exactly two synced core/block references must remain in the editor.' };
    const instances = blocks.map((block) => {
    const wrapper = visit(selector.getBlocks(block.clientId)).find((candidate) => candidate.name === wrapperName);
    if (!wrapper) {
      return {
        unavailable: false,
        reason: 'The generated block wrapper was absent from the synced-pattern editor tree.',
        policy: structuralPolicy,
        expectedWrapper: wrapperName,
      };
    }
    const layoutChild = selector.getBlocks(wrapper.clientId)?.[0];
    if (!layoutChild) {
      return {
        unavailable: false,
        reason: 'The generated block wrapper has no direct layout child whose structural operations can be observed.',
        policy: structuralPolicy,
        wrapper: wrapper.name,
      };
    }
    // useInnerBlocksProps applies the template lock to the generated wrapper's
    // block-list settings. Verify that actual wrapper, then check the direct
    // layout child rather than a conveniently locked nested Core container.
    const wrapperLock = selector?.getBlockLock?.(wrapper.clientId);
    const wrapperSettings = selector?.getBlockListSettings?.(wrapper.clientId);
    const wrapperPolicy = wrapper.attributes?.templateLock ?? wrapperSettings?.templateLock;
    const canInsert = selector?.canInsertBlockType?.('core/paragraph', wrapper.clientId);
    const rootClientId = selector?.getBlockRootClientId?.(layoutChild.clientId);
    const canMove = selector?.canMoveBlock?.(layoutChild.clientId, rootClientId)
      ?? selector?.canMoveBlocks?.([layoutChild.clientId], rootClientId);
    const canRemove = selector?.canRemoveBlock?.(layoutChild.clientId)
      ?? selector?.canRemoveBlocks?.([layoutChild.clientId]);
    return {
      policy: structuralPolicy,
      wrapper: wrapper.name,
      wrapperClientId: wrapper.clientId,
      wrapperAttributesPolicy: wrapper.attributes?.templateLock,
      wrapperSettingsPolicy: wrapperSettings?.templateLock,
      wrapperPolicy,
      wrapperLock,
      directLayoutChild: layoutChild.name,
      directLayoutChildClientId: layoutChild.clientId,
      canInsert,
      canMove,
      canRemove,
      unavailable: wrapperPolicy === structuralPolicy
        && canInsert === false
        && canMove === false
        && canRemove === false,
    };
    });
    return { policy: structuralPolicy, instances, unavailable: instances.every((instance) => instance.unavailable) };
  }, { patternRef: ref, wrapperName: generatedBlockName, structuralPolicy: policy });
}

async function completePatternOverride(page, fixture, activePublication, lifecycle) {
  if (gates.pattern_overrides || !lifecycle) return;
  const pattern = fixture.patternOverrides;
  if (!pattern || !activePublication?.permalink) {
    blocked('pattern_overrides', 'Pattern lifecycle could not reach a published frontend.');
    return;
  }
  const expected = expectedPatternFrontendValues(pattern);
  const frontend = await page.evaluate(({ marker, values }) => {
    const html = document.documentElement.outerHTML;
    const present = values.filter((value) => html.includes(value));
    return {
      url: location.href,
      markerCount: html.split(marker).length - 1,
      present,
      missing: values.filter((value) => !html.includes(value)),
      html,
      links: [...document.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')),
      media: [...document.querySelectorAll('img[src]')].map((image) => image.getAttribute('src')),
    };
  }, { marker: pattern.canonicalUpdate.marker, values: expected });
  const frontendPassed = page.url().includes(activePublication.permalink)
    && frontend.markerCount >= 2
    && frontend.missing.length === 0;
  const negative = lifecycle.negative;
  const negativeFrontend = {
    fallbackPresent: typeof negative?.expectedFallback === 'string' && htmlIncludes(frontend, negative.expectedFallback),
    rejectedValueAbsent: typeof negative?.expectedRejectedValue === 'string' && !htmlIncludes(frontend, negative.expectedRejectedValue),
    expectedFallback: negative?.expectedFallback,
    expectedRejectedValue: negative?.expectedRejectedValue,
  };
  const negativePassed = negativeFrontend.fallbackPresent && negativeFrontend.rejectedValueAbsent;
  const passed = frontendPassed && negativePassed;
  set('pattern_overrides', passed ? 'pass' : 'fail',
    passed ? undefined : 'Frontend did not show the updated canonical design, distinct instance override values, and the saved missing-binding fallback.',
    {
      ...lifecycle,
      frontend,
      negativeFrontend,
      frontendExpectedValues: expected,
      publishedPermalink: activePublication.permalink,
    });
}

function htmlIncludes(frontend, value) {
  return typeof value === 'string' && frontend.html?.includes(value);
}

function expectedPatternFrontendValues(pattern) {
  const values = [];
  pattern.instances.forEach((instance, index) => {
    Object.entries(instance.content).forEach(([name, attributes]) => {
      Object.entries(attributes).forEach(([attribute, value]) => {
        if (index === pattern.reset.instance && name === pattern.reset.name && attribute === pattern.reset.attribute) return;
        if (typeof value === 'string') values.push(value);
      });
    });
  });
  values.push(pattern.reset.fallback);
  return [...new Set(values)];
}

async function proveDeactivation(page, fixture, baseUrl, activePublication) {
  if (!activePublication?.permalink || !Array.isArray(activePublication.frontendAssets)) {
    blocked('static_deactivation_assets', 'Static deactivation proof needs the active run’s recorded published post and assets.');
  } else {
    const start = responses.length;
    await page.context().clearCookies();
    const response = await page.goto(new URL(activePublication.permalink, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');
    const assets = [...frontendAssetResponses(responses.slice(start)), ...await inlineFrontendStyles(page)];
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

  await login(page, baseUrl);
  await page.goto(`${baseUrl}/wp-admin/post-new.php`, { waitUntil: 'domcontentloaded' });
  await waitForEditorReady(page);
  const stillRegistered = await page.evaluate((name) => Boolean(globalThis.wp?.blocks?.getBlockType(name)), fixture.blockName);
  const stillVisible = await hasVisibleInserterCandidate(page, fixture.blockTitle ?? fixture.blockName);
  const removed = !stillRegistered && !stillVisible;
  set('static_deactivation_editor_controls', removed ? 'pass' : 'fail',
    removed ? undefined : 'Plugin-owned editor registration or visible inserter control remained after deactivation.', { block: fixture.blockName, stillRegistered, stillVisible });
}

async function proveFrontend(page, fixture, baseUrl, activePublication, artifactDir) {
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
  // Frontend means the published visitor experience, not the authenticated
  // editor's admin bar (which can also overlay a scoped screenshot).
  await page.context().clearCookies();
  const response = await page.goto(new URL(activePublication.permalink, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load');
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
  const mediaNodes = page.locator(`${selector} img, ${selector} video, ${selector} audio`);
  // Scroll normal lazy-loaded images into view before judging their load state.
  for (const image of await page.locator(`${selector} img`).all()) await image.scrollIntoViewIfNeeded();
  const observedMedia = await mediaNodes.evaluateAll(async (nodes) => Promise.all(nodes.map(async (node) => {
    if (node instanceof HTMLImageElement) {
      const loaded = await Promise.race([node.decode().then(() => true, () => false), new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
      return { url: node.currentSrc || node.src, tag: 'img', loaded, width: node.naturalWidth, height: node.naturalHeight };
    }
    return { url: node.currentSrc || node.src, tag: node.tagName.toLowerCase(), loaded: node.readyState >= 1 };
  })));
  const media = observedMedia.map(({ url }) => url);
  const expectedMedia = fixture.frontend.expectedMedia ?? [];
  const mediaInapplicable = expectedMedia.length === 0 && media.length === 0;
  const mediaMatch = expectedMedia.length > 0 && expectedMedia.every((source) => media.includes(source)) && observedMedia.every(({ loaded }) => loaded);
  set('frontend_media', mediaInapplicable ? 'not_applicable' : mediaMatch ? 'pass' : 'fail', mediaInapplicable || mediaMatch ? undefined : 'Frontend media did not match the fixture expectation or failed to decode/load.', { media, expectedMedia, observedMedia });
  const assets = [...frontendAssetResponses(responses.slice(responseStart)), ...await inlineFrontendStyles(page)];
  const ownedAssets = pluginOwnedAssets(assets, fixture);
  const ownedStyles = ownedAssets.filter((asset) => asset.resourceType === 'stylesheet');
  const healthyAssets = ownedAssets.every((asset) => asset.delivery === 'inline' || (asset.status >= 200 && asset.status < 400));
  const sharedMatrix = fixture.browserMatrix ? await frontendSharedStyleSnapshot(page, fixture, artifactDir) : undefined;
  const assetsPass = ownedStyles.length > 0 && healthyAssets && (sharedMatrix?.ok ?? true);
  set('frontend_assets', assetsPass ? 'pass' : 'fail', assetsPass ? undefined
    : sharedMatrix && !sharedMatrix.ok
      ? 'The generated shared stylesheet/font did not load on the published frontend root.'
      : 'No successful plugin-owned stylesheet was observed on the published post, or a plugin asset failed.', {
    postId: activePublication.id,
    permalink: activePublication.permalink,
    assets,
    ownedAssets,
    ownedStyles,
    ...(sharedMatrix ? { browserMatrix: sharedMatrix.details } : {}),
  }, sharedMatrix?.artifacts);
  activePublication.frontendAssets = ownedAssets;
  const scopedErrors = { consoleErrors: consoleErrors.slice(consoleStart), pageErrors: pageErrors.slice(pageErrorStart) };
  const runtimePass = scopedErrors.consoleErrors.length === 0 && scopedErrors.pageErrors.length === 0;
  set('frontend_runtime_errors', runtimePass ? 'pass' : 'fail', runtimePass ? undefined : 'Frontend console or page errors were observed.', { postId: activePublication.id, permalink: activePublication.permalink, ...scopedErrors });
}

async function frontendSharedStyleSnapshot(page, fixture, artifactDir) {
  const matrix = fixture.browserMatrix;
  const rootClass = `wp-block-${fixture.blockName.replace('/', '-')}`;
  const root = page.locator(`.${rootClass}`).first();
  const artifacts = [];
  try {
    await root.waitFor({ state: 'visible' });
    const details = await root.evaluate(async (element, { expectedLayout, fontFamily, pluginSlug, expectedClass }) => {
      await document.fonts?.ready;
      await document.fonts?.load(`16px "${fontFamily}"`);
      const style = getComputedStyle(element);
      const stylesheets = [...document.styleSheets].map((sheet) => {
        let hasRootRule = false;
        try { hasRootRule = [...sheet.cssRules].some((rule) => rule.cssText.includes(expectedClass)); } catch { /* href below remains evidence */ }
        return { href: sheet.href || null, hasRootRule };
      });
      const sharedStyles = stylesheets.some((sheet) => sheet.hasRootRule
        || Boolean(sheet.href && sheet.href.includes(`/wp-content/plugins/${pluginSlug}/`)));
      return {
        outerHTML: element.outerHTML,
        display: style.display,
        fontLoaded: document.fonts?.check(`16px "${fontFamily}"`) ?? false,
        sharedStyles,
        stylesheets,
      };
    }, { expectedLayout: matrix.rootLayout, fontFamily: matrix.fontFamily, pluginSlug: fixture.pluginSlug ?? fixture.blockName.split('/').slice(1).join('-'), expectedClass: rootClass });
    const imagePath = path.join(artifactDir, `frontend-root-${matrix.rootLayout}-shared-style.png`);
    const jsonPath = path.join(artifactDir, `frontend-root-${matrix.rootLayout}-shared-style.json`);
    await root.screenshot({ path: imagePath, animations: 'disabled' });
    await writeFile(jsonPath, JSON.stringify(details, null, 2), 'utf8');
    artifacts.push(
      { path: `artifacts/${path.basename(imagePath)}`, mediaType: 'image/png' },
      { path: `artifacts/${path.basename(jsonPath)}`, mediaType: 'application/json' },
    );
    const ok = details.display === matrix.rootLayout && details.fontLoaded && details.sharedStyles;
    return { ok, details: { ...details, outerHTMLHash: sha256(details.outerHTML) }, artifacts };
  } catch (error) {
    return { ok: false, details: { error: error instanceof Error ? error.message : String(error) }, artifacts };
  }
}

async function proveVisual(page, fixture, artifactDir) {
  if (!fixture.visual) return blocked('visual_regression', 'Fixture has no reviewed visual golden.');
  const actualPath = path.join(artifactDir, 'actual.png');
  const diffPath = path.join(artifactDir, 'diff.png');
  const expectedPath = path.join(artifactDir, 'expected.png');
  try {
    const scope = fixture.visual.selector ? page.locator(fixture.visual.selector) : page;
    if (fixture.visual.selector && await scope.count() !== 1) throw new Error('Visual scope must match exactly one rendered design region.');
    const masks = (fixture.visual.masks ?? []).map((selector) => page.locator(selector));
    for (const mask of masks) if (await mask.count() === 0) throw new Error('A configured visual mask did not match any element.');
    await scope.screenshot({ path: actualPath, ...(fixture.visual.selector ? {} : { fullPage: true }), mask: masks, animations: 'disabled' });
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
      selector: fixture.visual.selector ?? 'page',
      environment: { browser: 'chromium', browserVersion, platform: process.platform, viewport: page.viewportSize(), deviceScaleFactor: 1 },
    }, [{ path: 'artifacts/expected.png', mediaType: 'image/png' }, { path: 'artifacts/actual.png', mediaType: 'image/png' }, { path: 'artifacts/diff.png', mediaType: 'image/png' }]);
  } catch (error) {
    blocked('visual_regression', `Visual comparison could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function proveAxeEditor(page, fixture, artifactDir) {
  if (!fixture.accessibility) {
    blocked('accessibility_editor', 'Fixture has no accessibility scope.');
    return;
  }
  const frame = page.frames().find((candidate) => candidate.name() === 'editor-canvas') ?? page.mainFrame();
  await frame.addScriptTag({ content: axe.source });
  const editor = await frame.evaluate(async (selector) => globalThis.axe.run(selector), fixture.accessibility.editorSelector ?? '.editor-styles-wrapper');
  const artifact = path.join(artifactDir, 'axe-editor.json');
  await writeFile(artifact, JSON.stringify(editor, null, 2), 'utf8');
  set('accessibility_editor', editor.violations.length === 0 ? 'pass' : 'fail', editor.violations.length === 0 ? undefined : 'Axe found editor subtree violations.', {
    axe: editor,
    selector: fixture.accessibility.editorSelector ?? '#editor',
    scope: frame.name() || 'main-frame',
  }, [{ path: 'artifacts/axe-editor.json', mediaType: 'application/json' }]);
}

async function proveAxeFrontend(page, fixture, artifactDir) {
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
  const artifact = path.join(artifactDir, 'axe-frontend.json');
  await writeFile(artifact, JSON.stringify(frontend, null, 2), 'utf8');
  set('accessibility_frontend', frontend.violations.length === 0 ? 'pass' : 'fail', frontend.violations.length === 0 ? undefined : 'Axe found frontend subtree violations.', {
    axe: frontend, selector: fixture.accessibility.frontendSelector ?? fixture.frontend.subtreeSelector ?? 'main',
  }, [{ path: 'artifacts/axe-frontend.json', mediaType: 'application/json' }]);
}
