#!/usr/bin/env node
// Focused native Query Loop browser proof. It intentionally does not use the
// generated-plugin proof runner: this covers the exact assembled core markup.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const args = new Map(process.argv.slice(2).filter((_, index) => index % 2 === 0)
  .map((key, index) => [key, process.argv.slice(2)[index * 2 + 1]]));
const configPath = args.get('--config');
const outputPath = args.get('--out');
if (!configPath || !outputPath) throw new Error('Usage: node scripts/proof-query-playwright.mjs --config <query-proof.json> --out <result.json>');

const config = JSON.parse(await readFile(configPath, 'utf8'));
const baseUrl = (config.baseUrl ?? 'http://localhost:8888').replace(/\/$/, '');
const artifactDir = path.join(path.dirname(outputPath), 'artifacts');
await mkdir(artifactDir, { recursive: true });

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const result = {
  schemaVersion: 1,
  fixtureHash: sha256(config.fixture),
  outputHash: sha256(config.markup),
  runtime: config.runtime,
  seeded: config.seeded,
  browser: {},
  editor: {},
  pagination: {},
  emptyResults: {},
  errors: [],
};
let browser;
let page;

try {
  browser = await chromium.launch({ headless: true });
  result.browser = { version: browser.version(), executablePath: chromium.executablePath() };
  page = await browser.newPage({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000);
  await login(page, baseUrl);

  // The first write is deliberate setup, not a block-editor store mutation.
  // WordPress parses this exact assembled string when the browser opens it.
  const created = await page.evaluate(async ({ markup, title }) => globalThis.wp.apiFetch({
    path: '/wp/v2/posts', method: 'POST', data: { title: `${title} initial`, content: markup, status: 'draft' },
  }), { markup: config.markup, title: config.postTitle });
  const postId = Number(created?.id);
  if (!Number.isInteger(postId) || postId <= 0) throw new Error('WordPress did not create the Query Loop proof post.');
  await page.goto(`${baseUrl}/wp-admin/post.php?post=${postId}&action=edit`, { waitUntil: 'domcontentloaded' });
  await waitForEditorReady(page);
  const beforeSave = await queryEditorState(page);
  requireQueryShape(beforeSave, config.boundQuery, 'before save');

  await editPostTitle(page, config.postTitle);
  await savePost(page, postId);
  const saved = await queryEditorState(page);
  requireQueryShape(saved, config.boundQuery, 'after save');

  await page.goto(`${baseUrl}/wp-admin/post.php?post=${postId}&action=edit`, { waitUntil: 'domcontentloaded' });
  await waitForEditorReady(page);
  const reopened = await queryEditorState(page);
  requireQueryShape(reopened, config.boundQuery, 'after reopen');
  if (reopened.isDirty !== false) throw new Error(`Reopened Query Loop post is dirty: ${JSON.stringify(reopened.isDirty)}.`);
  if (saved.contentHash !== reopened.contentHash) throw new Error('Saved Query Loop content changed after reopening.');

  const published = await page.evaluate(async (id) => globalThis.wp.apiFetch({
    path: `/wp/v2/posts/${id}`, method: 'POST', data: { status: 'publish' },
  }), postId);
  if (typeof published?.link !== 'string' || !published.link) throw new Error('WordPress did not return a published Query Loop permalink.');
  result.editor = { postId, beforeSave, saved, reopened, permalink: published.link };

  const firstResponse = await page.goto(published.link, { waitUntil: 'load' });
  const query = page.locator('.wp-block-query').first();
  await query.waitFor({ state: 'visible' });
  const first = await queryResults(query);
  expectOnly(first, config.seeded[0]);
  const next = query.getByRole('link', { name: /next/i }).first();
  if (!(await next.isVisible().catch(() => false))) throw new Error('The native Query Loop did not expose a usable Next link.');
  const firstUrl = page.url();
  const [nextResponse] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), next.click()]);
  const secondUrl = page.url();
  if (secondUrl === firstUrl) throw new Error('The Query Loop Next link did not change the destination.');
  const second = await queryResults(page.locator('.wp-block-query').first());
  expectOnly(second, config.seeded[1]);
  const previous = page.locator('.wp-block-query').first().getByRole('link', { name: /previous/i }).first();
  if (!(await previous.isVisible().catch(() => false))) throw new Error('The native Query Loop did not expose a usable Previous link.');
  const [previousResponse] = await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), previous.click()]);
  const returned = await queryResults(page.locator('.wp-block-query').first());
  expectOnly(returned, config.seeded[0]);
  result.pagination = {
    firstUrl,
    firstStatus: firstResponse?.status(),
    secondUrl,
    secondStatus: nextResponse?.status(),
    returnedUrl: page.url(),
    returnedStatus: previousResponse?.status(),
    first,
    second,
    returned,
  };

  if (typeof config.emptyPermalink !== 'string' || !config.emptyPermalink) throw new Error('The test did not provide an empty-query proof permalink.');
  const emptyResponse = await page.goto(config.emptyPermalink, { waitUntil: 'load' });
  const emptyQuery = page.locator('.wp-block-query').first();
  await emptyQuery.waitFor({ state: 'visible' });
  const emptyText = (await emptyQuery.textContent() ?? '').replace(/\s+/g, ' ').trim();
  const emptyLinks = await emptyQuery.locator('.wp-block-post-title a').evaluateAll((links) => links.map((link) => ({ text: link.textContent?.trim() ?? '', href: link.href })));
  const emptyNext = emptyQuery.getByRole('link', { name: /next/i }).first();
  if (!emptyText.includes('No matching posts.')) throw new Error(`The empty Query Loop did not render its No Results message: ${JSON.stringify(emptyText)}.`);
  if (emptyLinks.some((link) => config.seeded.some((post) => link.text === post.title || link.href === post.link))) {
    throw new Error('The empty Query Loop still rendered a seeded post link.');
  }
  if (await emptyNext.isVisible().catch(() => false)) throw new Error('The empty Query Loop exposed a usable Next link.');
  result.emptyResults = { permalink: config.emptyPermalink, status: emptyResponse?.status(), text: emptyText, links: emptyLinks, nextVisible: false };
} catch (error) {
  result.errors.push(error instanceof Error ? error.message : String(error));
  if (page) await page.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => undefined);
} finally {
  if (page) await writeFile(path.join(artifactDir, 'final.html'), await page.content().catch(() => ''), 'utf8');
  if (browser) await browser.close();
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

if (result.errors.length > 0) process.exitCode = 1;

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

async function queryEditorState(page) {
  return page.evaluate(async () => {
    const blockEditor = globalThis.wp?.data?.select('core/block-editor');
    const editor = globalThis.wp?.data?.select('core/editor');
    const blocks = blockEditor?.getBlocks?.() ?? [];
    const visit = (nodes) => nodes.flatMap((block) => [{ name: block.name, attributes: JSON.parse(JSON.stringify(block.attributes ?? {})) }, ...visit(block.innerBlocks ?? [])]);
    const flattened = visit(blocks);
    const query = flattened.find((block) => block.name === 'core/query');
    const names = flattened.map((block) => block.name);
    const invalidBlocks = [];
    const inspect = (nodes) => nodes.forEach((block) => {
      if (block.isValid === false) invalidBlocks.push({ name: block.name, clientId: block.clientId });
      inspect(block.innerBlocks ?? []);
    });
    inspect(blocks);
    const content = editor?.getEditedPostContent?.() ?? '';
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
    return {
      contentHash: `sha256:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      isDirty: typeof editor?.isEditedPostDirty === 'function' ? editor.isEditedPostDirty() : undefined,
      invalidBlocks,
      names,
      query: query?.attributes?.query,
    };
  });
}

function requireQueryShape(state, expectedQuery, phase) {
  const required = ['core/query', 'core/post-template', 'core/post-title', 'core/query-pagination', 'core/query-pagination-next', 'core/query-pagination-previous', 'core/query-no-results'];
  const missing = required.filter((name) => !state.names.includes(name));
  const changed = Object.entries(expectedQuery).filter(([key, value]) => JSON.stringify(state.query?.[key]) !== JSON.stringify(value));
  if (missing.length || state.invalidBlocks.length || changed.length) {
    throw new Error(`Native Query Loop ${phase} did not retain its required tree/settings: ${JSON.stringify({ missing, invalidBlocks: state.invalidBlocks, expectedQuery, actualQuery: state.query })}.`);
  }
}

async function queryResults(query) {
  return query.locator('.wp-block-post-title a').evaluateAll((links) => links.map((link) => ({ text: link.textContent?.trim() ?? '', href: link.href })));
}

function expectOnly(observed, expected) {
  if (observed.length !== 1 || observed[0].text !== expected.title || observed[0].href !== expected.link) {
    throw new Error(`Query Loop results did not match the isolated expected post: ${JSON.stringify({ observed, expected })}.`);
  }
}
