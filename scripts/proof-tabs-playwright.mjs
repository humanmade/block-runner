#!/usr/bin/env node
// Native page-content proof, deliberately separate from generated-plugin acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const args = process.argv.slice(2);
const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1], 'utf8'));
const output = args[args.indexOf('--out') + 1];
const artifactDir = path.join(path.dirname(output), 'artifacts');
await mkdir(artifactDir, { recursive: true });
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const result = { fixtureHash: hash(config.fixture), outputHash: hash(config.markup), runtime: config.runtime, editor: {}, frontend: {}, errors: [] };
let browser, page;
try {
  browser = await chromium.launch({ headless: true });
  result.runtime.browser = browser.version();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => result.errors.push(error.message));
  await login(page, config.baseUrl);
  // Load the native editor scripts before using its authenticated REST client.
  await page.goto(`${config.baseUrl}/wp-admin/post-new.php`, { waitUntil: 'load' });
  await waitForEditorReady(page);
  const created = await page.evaluate(async ({ markup, title }) => wp.apiFetch({
    path: '/wp/v2/posts', method: 'POST', data: { title, content: markup, status: 'publish' },
  }), { markup: config.markup, title: config.postTitle });
  const postId = created.id;
  assert.ok(Number.isInteger(postId) && postId > 0);
  // No editor has opened this post: buttons must already exist in assembled markup.
  result.frontend.beforeEditor = await frontend(created.link, ['Overview', 'Details']);
  await openEditor(postId);
  result.editor.beforeSave = await editorState();
  checkState(result.editor.beforeSave, ['Overview', 'Details']);
  await editPostTitle(page, `${config.postTitle} saved`);
  await savePost(page, postId);
  result.editor.saved = await editorState();
  await openEditor(postId);
  result.editor.reopened = await editorState();
  checkReopened(result.editor.saved, result.editor.reopened, ['Overview', 'Details']);
  const canvas = await page.locator('iframe[name="editor-canvas"]').count()
    ? page.frameLocator('iframe[name="editor-canvas"]') : page;
  const first = canvas.locator('[data-type="core/tabs"]').first();
  await first.locator('[role="tab"] [contenteditable="true"]').first().fill('Updated overview');
  await first.locator('[data-type="core/paragraph"][contenteditable="true"]').first().fill('Edited first panel content.');
  await page.waitForFunction(() => {
    const tabs = wp.data.select('core/block-editor').getBlocks()[0];
    return String(tabs.innerBlocks[0].attributes.tabs[0].label) === 'Updated overview';
  });
  await savePost(page, postId);
  result.editor.editedSaved = await editorState();
  await openEditor(postId);
  result.editor.editedReopened = await editorState();
  checkReopened(result.editor.editedSaved, result.editor.editedReopened, ['Updated overview', 'Details']);
  assert.ok(result.editor.editedReopened.content.includes('Edited first panel content.'));
  result.frontend.afterEditing = await frontend(created.link, ['Updated overview', 'Details']);
  await expect(page.locator('.wp-block-tabs').first()).toContainText('Edited first panel content.');

  // Native WordPress createBlock/serialize control bypasses Block Runner entirely.
  await page.goto(`${config.baseUrl}/wp-admin/post-new.php`, { waitUntil: 'load' });
  await waitForEditorReady(page);
  const control = await page.evaluate(async (title) => {
    const { createBlock: block, serialize } = wp.blocks;
    const tabs = (activeTabIndex) => block('core/tabs', { activeTabIndex }, [
      block('core/tab-list', { tabs: [{ label: 'Overview' }, { label: 'Details' }] }),
      block('core/tab-panels', {}, ['Overview', 'Details'].map((label) => block('core/tab-panel', { label }, [block('core/paragraph', { content: `${label} native content.` })]))),
    ]);
    return wp.apiFetch({ path: '/wp/v2/posts', method: 'POST', data: { title: `${title} native control`, content: serialize([tabs(0), tabs(1)]), status: 'publish' } });
  }, config.postTitle);
  result.frontend.nativeControl = await frontend(control.link, ['Overview', 'Details']);
  assert.deepEqual(result.frontend.beforeEditor.keyboard, result.frontend.nativeControl.keyboard);
} catch (error) {
  result.errors.push(error.stack ?? String(error));
  if (page) await page.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (page) await writeFile(path.join(artifactDir, 'final.html'), await page.content().catch(() => ''));
  if (browser) await browser.close();
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}
if (result.errors.length) process.exitCode = 1;

async function openEditor(id) {
  await page.goto(`${config.baseUrl}/wp-admin/post.php?post=${id}&action=edit`, { waitUntil: 'load' });
  await waitForEditorReady(page);
}
async function editorState() {
  const state = await page.evaluate(() => {
    const blocks = wp.data.select('core/block-editor').getBlocks();
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.innerBlocks)]);
    const editor = wp.data.select('core/editor');
    return {
      content: editor.getEditedPostContent(), isDirty: editor.isEditedPostDirty(),
      invalidBlocks: flatten(blocks).filter((node) => node.isValid === false).map((node) => node.name),
      tabs: blocks.map((tabs) => ({ name: tabs.name, activeTabIndex: tabs.attributes.activeTabIndex,
        children: tabs.innerBlocks.map((node) => node.name),
        labels: tabs.innerBlocks[0].attributes.tabs.map((tab) => String(tab.label)),
        panels: tabs.innerBlocks[1].innerBlocks.map((panel) => ({ name: panel.name, label: panel.attributes.label, children: panel.innerBlocks.map((node) => node.name) })),
      })),
    };
  });
  return { ...state, contentHash: hash(state.content) };
}
function checkState(state, labels) {
  assert.deepEqual(state.invalidBlocks, []);
  assert.equal(state.tabs.length, 2);
  for (const [i, tabs] of state.tabs.entries()) {
    assert.equal(tabs.name, 'core/tabs');
    assert.equal(tabs.activeTabIndex, i);
    assert.deepEqual(tabs.children, ['core/tab-list', 'core/tab-panels']);
    assert.deepEqual(tabs.labels, i === 0 ? labels : ['Overview', 'Details']);
    assert.deepEqual(tabs.panels.map((panel) => panel.label), tabs.labels);
    assert.ok(tabs.panels.every((panel) => panel.name === 'core/tab-panel' && panel.children.includes('core/paragraph')));
  }
}
function checkReopened(saved, reopened, labels) {
  checkState(reopened, labels);
  assert.equal(reopened.isDirty, false);
  assert.equal(saved.contentHash, reopened.contentHash);
}
async function frontend(url, labels) {
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  const groups = page.locator('.wp-block-tabs');
  await expect(groups).toHaveCount(2);
  const tabs = groups.first().getByRole('tab');
  await expect(tabs).toHaveText(labels);
  const secondTabs = groups.nth(1).getByRole('tab');
  await expect(secondTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  const associations = await groups.evaluateAll((nodes) => nodes.map((group) => [...group.querySelectorAll('[role="tab"]')].map((tab) => {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    return { tab: tab.id, panel: panel?.id, label: panel?.getAttribute('aria-labelledby'), contained: group.contains(panel) };
  })));
  const ids = associations.flatMap((group) => group.flatMap((item) => [item.tab, item.panel]));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(associations.flat().every((item) => item.tab && item.panel && item.label === item.tab && item.contained));
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(groups.first().locator('[role="tabpanel"]').nth(1)).not.toHaveAttribute('hidden');
  await expect(secondTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(0).click();
  const keyboard = [];
  for (const key of ['ArrowRight', 'Enter', 'Home', ' ', 'End', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(key);
    keyboard.push({ key, ...(await groups.first().evaluate((group) => {
      const buttons = [...group.querySelectorAll('[role="tab"]')];
      return { focused: buttons.indexOf(document.activeElement), selected: buttons.findIndex((tab) => tab.getAttribute('aria-selected') === 'true') };
    })) });
  }
  // Core uses manual activation: arrows move focus, Enter/Space activate.
  assert.deepEqual(keyboard.slice(0, 4).map(({ focused, selected }) => [focused, selected]), [[1, 0], [1, 1], [0, 1], [0, 0]]);
  await expect(secondTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  return { url, associations, keyboard };
}
async function login(page, origin) {
  await page.goto(`${origin}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  if (!/wp-login\.php/.test(page.url())) return;
  await page.waitForLoadState('load');
  // WordPress focuses the username field from its load handler. Wait for that
  // handoff before filling either field, otherwise the late focus can put the
  // password into the username input on a cold browser session.
  await page.waitForFunction(() => document.activeElement?.id === 'user_login');
  await page.locator('#user_login').fill(process.env.WP_USERNAME ?? 'admin');
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD ?? 'password');
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/wp-login.php'), { waitUntil: 'domcontentloaded' }),
    page.locator('#wp-submit').click(),
  ]);
}

async function waitForEditorReady(page) {
  await page.waitForFunction(() => Boolean(globalThis.wp?.data?.select('core/block-editor')?.getBlocks), undefined, { timeout: 20_000 });
  await page.locator('iframe[name="editor-canvas"], .block-editor-writing-flow, .editor-styles-wrapper').first()
    .waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => globalThis.wp?.data?.select('core/editor')?.getCurrentPostId?.() > 0, undefined, { timeout: 20_000 });
  const welcome = page.getByRole('dialog', { name: /welcome to the editor/i });
  if (await welcome.isVisible().catch(() => false)) {
    await welcome.getByRole('button', { name: /close/i }).click();
  }
}

async function savePost(page, postId) {
  const save = page.getByRole('region', { name: 'Editor top bar', exact: true })
    .getByRole('button', { name: /^(?:save draft|save|update)$/i });
  const [response] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/wp/v2/posts/${postId}`)
      && response.request().method() === 'POST'),
    save.click(),
  ]);
  if (!response.ok()) throw new Error(`WordPress editor save returned HTTP ${response.status()}.`);
  await page.waitForFunction(() => {
    const editor = globalThis.wp?.data?.select('core/editor');
    return !editor?.isSavingPost?.() && editor?.isEditedPostDirty?.() === false;
  }, undefined, { timeout: 20_000 });
}

async function editPostTitle(page, value) {
  const iframeTitle = page.frameLocator('iframe[name="editor-canvas"]')
    .locator('.editor-post-title__input, [contenteditable="true"]').first();
  const topLevelTitle = page.locator('.editor-post-title__input, [contenteditable="true"]').first();
  const title = await iframeTitle.isVisible().catch(() => false) ? iframeTitle : topLevelTitle;
  await title.fill(value);
}

