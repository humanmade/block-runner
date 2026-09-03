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
const page = await browser.newPage();
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

  const inserted = await phase('editor-inserter', () => insertThroughVisibleInserter(page, fixture));
  set('editor_inserter', inserted ? 'pass' : 'fail', inserted ? undefined : 'Could not insert the block through the visible inserter.');

  const preEdit = await editorState(page);
  const fieldResult = await phase('editor-field-editing', () => editAllFields(page, editor, fixture.editableFields ?? []));
  set('editor_field_editing', fieldResult.status, fieldResult.reason, fieldResult.details);

  const saved = await phase('editor-save', () => savePost(page, editor));
  const savedState = await editorState(page);
  const editPersistence = editedValuesPersisted(preEdit, savedState, fixture.editableFields ?? []);
  const savePassed = saved && editPersistence.ok;
  set('editor_save', savePassed ? 'pass' : 'fail', savePassed ? undefined : 'Editor save did not persist the edited block values.', {
    preEdit,
    saved: savedState,
    editPersistence,
  });

  const reopened = await phase('editor-reopen', () => reopenPost(page));
  const reopenedState = await editorState(page);
  const reopenPersistence = editedValuesPersisted(preEdit, reopenedState, fixture.editableFields ?? []);
  const persisted = savePassed && reopened && savedState.contentHash === reopenedState.contentHash && savedState.treeHash === reopenedState.treeHash && reopenPersistence.ok;
  set('editor_reopen', persisted ? 'pass' : 'fail', persisted ? undefined : 'Saved editor tree/content changed after reopening.', {
    preEdit,
    saved: savedState,
    reopened: reopenedState,
    reopenPersistence,
  });

  patternLifecycle = await phase('pattern-overrides', () => provePatternOverride(page, fixture));
  const published = await phase('publish', () => publishPost(page, editor));
  const publishedState = await editorState(page);
  publication = published ? await readPublication(page, publishedState.content) : undefined;
  await phase('accessibility-editor', () => proveAxeEditor(page, fixture));
  await phase('frontend', () => proveFrontend(page, fixture, baseUrl, publication));
  await phase('pattern-frontend', () => completePatternOverride(page, fixture, publication, patternLifecycle));
  await phase('visual-regression', () => proveVisual(page, fixture, artifactDir));
  await phase('accessibility-frontend', () => proveAxeFrontend(page, fixture));
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
await writeFile(outputPath, JSON.stringify({ gates, publication, phases, environment: { browser: { version: browserVersion, revision, executablePath } } }, null, 2), 'utf8');

async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  if (!/wp-login\.php/.test(page.url())) return;
  await page.locator('#user_login').fill(process.env.WP_USERNAME ?? 'admin');
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD ?? 'password');
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.locator('#wp-submit').click(),
  ]);
}

async function waitForEditorReady(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.wp?.data?.select('core/block-editor')?.getBlocks),
    undefined,
    { timeout: 20_000 },
  );
  // Depending on the registered block set, WordPress hosts the writing flow
  // in the API-v3 iframe or directly in the page.
  await page.locator('iframe[name="editor-canvas"], .block-editor-writing-flow, .editor-styles-wrapper').first()
    .waitFor({ state: 'visible', timeout: 20_000 });
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
    // Editor heartbeat requests can keep networkidle open after the editor is
    // ready. The writing flow is the lifecycle condition that matters here.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForEditorReady(page);
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
  const afterCanonicalUpdate = await editorState(page);
  const afterCanonicalInstances = await patternInstanceStates(page, pattern.ref);
  const updatedGeneratedBlockCheck = canonicalUpdate.ok
    ? inspectGeneratedBlockCoverage(canonicalUpdate.content, fixture.blockName, pattern.requiredBindings)
    : { ok: false, reason: 'canonical_update_unavailable' };
  const canonicalReachedBoth = canonicalUpdate.ok
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
    && block.attributes?.metadata?.bindings?.[requirement.attribute]?.source === 'core/pattern-overrides'));
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
  const edited = await editPatternInstanceThroughNativeControls(page, instances[0].clientId, desired, {});
  const beforeSave = await patternInstanceStates(page, negative.ref);
  const saved = await savePost(page);
  const reopened = await reopenPost(page);
  const afterReopen = await patternInstanceStates(page, negative.ref);
  const content = afterReopen[0]?.content ?? {};
  const absentAfterLifecycle = !hasOverrideValue(content, negative.name, negative.attribute);
  return {
    ok: edited.ok && saved && reopened && absentAfterLifecycle,
    binding,
    savedNegativeWpBlockContent: negative.canonicalContent,
    inserted,
    edited,
    beforeSaveCoreBlockContent: beforeSave,
    afterReopenCoreBlockContent: afterReopen,
    absentAfterLifecycle,
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
        content: structuredClone(block.attributes?.content ?? {}),
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
        controls.push(await editPatternImageThroughNativeControls(page, target, values));
      } else if (target.blockName === 'core/heading' || target.blockName === 'core/paragraph' || target.blockName === 'core/list-item') {
        if (typeof values.content !== 'string') throw new Error(`${target.blockName} is missing a string content value.`);
        await editRichTextThroughNativeControl(page, target.clientId, values.content);
        controls.push({ block: target.blockName, control: 'richText', value: values.content });
      } else if (target.blockName === 'core/button') {
        controls.push(await editPatternButtonThroughNativeControls(page, target, values));
      } else {
        throw new Error(`No native override editor is defined for ${target.blockName}.`);
      }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), targets, controls };
  }

  const observed = (await patternInstanceStates(page, undefined)).find((instance) => instance.clientId === clientId);
  return {
    ok: samePatternContent(observed?.content, expectedStoredContent),
    expectedNativeValue: content,
    expectedStoredContent,
    observed: observed?.content ?? {},
    targets,
    controls,
  };
}

async function patternOverrideTargets(page, clientId, content) {
  return page.evaluate(({ patternClientId, desired }) => {
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(block.innerBlocks ?? [])]);
    const root = globalThis.wp?.data?.select('core/block-editor')?.getBlock?.(patternClientId);
    if (!root || root.name !== 'core/block') return [];
    return visit(root.innerBlocks ?? [])
      .flatMap((block) => {
        const name = block.attributes?.metadata?.name;
        return typeof name === 'string' && desired[name]
          ? [{ clientId: block.clientId, blockName: block.name, name, attributes: structuredClone(block.attributes ?? {}) }]
          : [];
      });
  }, { patternClientId: clientId, desired: content });
}

async function selectNativeBlock(page, clientId) {
  const block = page.locator(`[data-block="${clientId}"]`).first();
  if (!(await block.isVisible().catch(() => false))) throw new Error(`Native block ${clientId} is not visible in the editor canvas.`);
  await block.click();
  return block;
}

async function editRichTextThroughNativeControl(page, clientId, value) {
  const block = await selectNativeBlock(page, clientId);
  const field = block.locator('[contenteditable="true"]').first();
  if (!(await field.isVisible().catch(() => false))) throw new Error('Selected native rich-text block has no visible content editor.');
  await field.fill(value);
}

async function editPatternImageThroughNativeControls(page, target, values) {
  if (!Number.isInteger(values.id) || typeof values.url !== 'string' || typeof values.alt !== 'string') {
    throw new Error('Image override requires id, url, and alt values from the prepared media library.');
  }
  const block = await selectNativeBlock(page, target.clientId);
  const replace = block.getByRole('button', { name: /replace|select media/i }).first();
  if (!(await replace.isVisible().catch(() => false))) throw new Error('Selected native image block has no visible Replace control.');
  await replace.click();
  const attachment = page.locator(`.media-modal .attachment[data-id="${values.id}"]`).first();
  if (!(await attachment.isVisible().catch(() => false))) throw new Error(`Media library did not expose prepared attachment ${values.id}.`);
  await attachment.click();
  const select = page.getByRole('button', { name: /^select$/i }).last();
  if (!(await select.isVisible().catch(() => false))) throw new Error('Media library did not expose a native Select action.');
  await select.click();

  await selectNativeBlock(page, target.clientId);
  const alt = page.getByLabel(/alt text|alternative text/i).last();
  if (!(await alt.isVisible().catch(() => false))) throw new Error('Selected native image block has no visible Alt text control.');
  await alt.fill(values.alt);
  return { block: target.blockName, control: 'media+altText', id: values.id, url: values.url, alt: values.alt };
}

async function editPatternButtonThroughNativeControls(page, target, values) {
  if (typeof values.text !== 'string' || typeof values.url !== 'string') {
    throw new Error('Button override requires text and url values.');
  }
  await editRichTextThroughNativeControl(page, target.clientId, values.text);
  await selectNativeBlock(page, target.clientId);
  const link = page.getByRole('button', { name: /link/i }).last();
  if (!(await link.isVisible().catch(() => false))) throw new Error('Selected native button block has no visible Link control.');
  await link.click();
  const url = page.locator('.block-editor-url-popover input[type="url"], input[type="url"]').last();
  if (!(await url.isVisible().catch(() => false))) throw new Error('Native button link popover has no URL control.');
  await url.fill(values.url);
  await url.press('Enter');
  return { block: target.blockName, control: 'richText+link', text: values.text, url: values.url };
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
    const reset = page.getByRole('button', { name: /reset.*override|reset/i }).last();
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
  return canonicalValue(actual ?? {}) === canonicalValue(expected ?? {});
}

function canonicalValue(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalValue).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalValue(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function observePatternStructure(page, ref, generatedBlockName, policy) {
  return page.evaluate(({ patternRef, wrapperName, structuralPolicy }) => {
    const selector = globalThis.wp?.data?.select('core/block-editor');
    const visit = (blocks) => blocks.flatMap((block) => [block, ...visit(block.innerBlocks ?? [])]);
    const block = visit(selector?.getBlocks?.() ?? [])
      .find((candidate) => candidate.name === 'core/block' && Number(candidate.attributes?.ref) === patternRef);
    if (!block) return { unavailable: false, reason: 'No synced core/block reference remained in the editor.' };
    const wrapper = visit(block.innerBlocks ?? []).find((candidate) => candidate.name === wrapperName);
    if (!wrapper) {
      return {
        unavailable: false,
        reason: 'The generated block wrapper was absent from the synced-pattern editor tree.',
        policy: structuralPolicy,
        expectedWrapper: wrapperName,
      };
    }
    const layoutChild = wrapper.innerBlocks?.[0];
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
    const response = await page.goto(new URL(activePublication.permalink, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
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

  await page.goto(`${baseUrl}/wp-admin/post-new.php`, { waitUntil: 'domcontentloaded' });
  await waitForEditorReady(page);
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
  const response = await page.goto(new URL(activePublication.permalink, baseUrl).toString(), { waitUntil: 'domcontentloaded' });
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
