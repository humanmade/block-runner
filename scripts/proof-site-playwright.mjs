#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { runAfterRuntimeVerification, proveFile } from './proof-theme-playwright.mjs';

export function evaluateSiteNavigation(results) {
  return results.length === 2 && results.every((result) => result.opened && result.followed && result.closed);
}
export async function waitForDeclaredMount(page, expectedNames) {
  await page.waitForFunction((names) => {
    const wp = globalThis.wp;
    const blocks = wp?.data?.select('core/block-editor')?.getBlocks?.();
    if (!Array.isArray(blocks)) return false;
    const flatten = (items) => items.flatMap((block) => [block, ...flatten(block.innerBlocks ?? [])]);
    const all = flatten(blocks);
    const expected = new Map();
    for (const name of names) expected.set(name, (expected.get(name) ?? 0) + 1);
    return [...expected].every(([name, count]) => all.filter((block) => block.name === name).length === count)
      && all.every((block) => block.name !== 'core/accordion' || flatten(block.innerBlocks ?? []).every((child) => child.name !== 'core/accordion-heading' || child.attributes?.iconPosition === block.attributes?.iconPosition))
      && wp.data.select('core/editor')?.getEditedPostContent?.() === wp.blocks.serialize(blocks);
  }, expectedNames);
  const canvas = page.frame({ name: 'editor-canvas' }) ?? page;
  for (const name of new Set(expectedNames)) {
    const count = expectedNames.filter((expected) => expected === name).length;
    await canvas.waitForFunction(({ name, count }) => document.querySelectorAll(`.block-editor-block-list__block[data-type="${name}"]`).length === count, { name, count });
  }
  return canvas;
}
const names = (blocks) => blocks.flatMap((block) => [block.block, ...names(block.children ?? [])]);
const texts = (blocks) => blocks.flatMap((block) => [block.text, ...texts(block.children ?? [])]).filter((text) => typeof text === 'string' && text.length);
async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  if (!page.url().includes('wp-login.php')) return;
  await page.waitForFunction(() => document.activeElement?.id === 'user_login');
  await page.locator('#user_login').fill(process.env.WP_USERNAME ?? 'admin');
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD ?? 'password');
  await Promise.all([page.waitForURL((url) => !url.pathname.endsWith('/wp-login.php'), { waitUntil: 'domcontentloaded' }), page.locator('#wp-submit').click()]);
}
export function mountedEditorTargetReady(expectedId) {
  const wp = globalThis.wp;
  const editor = wp?.data?.select('core/editor');
  return Boolean(wp?.blocks?.serialize && editor?.getCurrentPostId?.() === expectedId
    && (typeof editor.isEditorReady !== 'function' || editor.isEditorReady()));
}
export async function dismissSiteEditorGuides(page) {
  const guide = page.getByRole('dialog').filter({ hasText: /Welcome to the editor|Edit your site/ }).first();
  if (!await guide.isVisible()) return false;
  const close = guide.getByRole('button', { name: /^Close$/ });
  if (await close.isVisible()) await close.click();
  else await guide.getByRole('button', { name: /^Get started$/ }).click();
  await guide.waitFor({ state: 'hidden' });
  return true;
}

async function editAndReopen(page, input, target, onSaved = () => {}) {
  const part = target.kind === 'part';
  const url = part ? `${input.baseUrl}/wp-admin/site-editor.php?${new URLSearchParams({ postType: 'wp_template_part', postId: `${input.theme}//${target.slug}`, canvas: 'edit' })}` : `${input.baseUrl}/wp-admin/post.php?post=${target.wpId}&action=edit`;
  const restPath = part ? `/wp/v2/template-parts/${input.theme}//${target.slug}?context=edit` : `/wp/v2/pages/${target.wpId}?context=edit`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(mountedEditorTargetReady, part ? `${input.theme}//${target.slug}` : target.wpId);
  const canvas = await waitForDeclaredMount(page, names(target.body.blocks));
  await dismissSiteEditorGuides(page);
  let originalRaw;
  if (part) {
    const original = await page.evaluate(async (route) => globalThis.wp.apiFetch({ path: route }), restPath);
    originalRaw = original.content?.raw;
    if (original.source !== 'theme') throw new Error('Shared part already has an unowned override; no edit attempted');
  }
  const paragraphText = texts(target.body.blocks).find((text) => text === target.oldText);
  if (!paragraphText) throw new Error('Controlled fixture edit text is not declared');
  const editable = canvas.locator('[contenteditable="true"]').filter({ hasText: target.oldText }).first();
  await editable.click();
  await editable.fill(target.newText);
  await page.waitForFunction((text) => globalThis.wp.data.select('core/editor').getEditedPostContent().includes(text), target.newText);
  const mounted = await page.evaluate(() => ({ serialized: globalThis.wp.blocks.serialize(globalThis.wp.data.select('core/block-editor').getBlocks()), edited: globalThis.wp.data.select('core/editor').getEditedPostContent() }));
  if (mounted.serialized !== mounted.edited) throw new Error('Mounted serialization and edited record disagree; no UI save attempted');
  await page.getByRole('button', { name: part ? /^Save$/ : /^(Save|Update)$/ }).first().click();
  if (part) {
    const confirm = page.getByRole('button', { name: /^Save$/ });
    if (await confirm.count() > 1) await confirm.last().click();
  }
  await page.waitForFunction(() => !globalThis.wp.data.select('core/editor').isSavingPost());
  const raw = await page.evaluate(async (restPath) => globalThis.wp.apiFetch({ path: restPath }), restPath);
  if (part && raw.source === 'custom' && Number(raw.wp_id) > 0) onSaved(Number(raw.wp_id), raw.content?.raw, originalRaw);
  if (raw.content?.raw !== mounted.serialized || !raw.content.raw.includes(target.newText)) throw new Error('UI save did not persist the mounted bytes');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction((text) => globalThis.wp?.data?.select('core/editor')?.getEditedPostContent?.()?.includes(text), target.newText);
  return { mounted, savedRaw: raw.content.raw, restPath, overrideId: raw.wp_id, reopened: true };
}
export async function proveControlledThemeFile(page, theme, file, baseUrl, onOverride = () => {}) {
  const result = await proveFile(page, theme, file, baseUrl, {
    awaitMounted: async (mountedPage, source) => {
      const expected = await mountedPage.evaluate((content) => {
        const flatten = (items) => items.flatMap((block) => [block.name, ...flatten(block.innerBlocks ?? [])]);
        return flatten(globalThis.wp.blocks.parse(content));
      }, source.content);
      await waitForDeclaredMount(mountedPage, expected);
    },
    cleanupOverride: async ({ page: mountedPage, restPath, id, entityType, result }) => {
      const current = await mountedPage.evaluate(async (route) => globalThis.wp.apiFetch({ path: route }), restPath);
      if (current.source !== 'custom' || Number(current.wp_id) !== id || current.content?.raw !== result.savedRaw) throw new Error('Override ownership changed before recoverable cleanup');
      onOverride({ id, content: current.content.raw, postType: entityType, entityId: result.entityId, originalRaw: result.loadedRaw });
      return { deferredRecoverableTrash: true, id };
    },
  });
  if (result.status !== 'pass') result.failureUrl = page.url();
  return result;
}
export async function recordSiteHelperFailure(report, page, error, directory, context = {}) {
  const failure = { message: error instanceof Error ? error.message : String(error), url: page.url(), ...context };
  report.exception = failure;
  try {
    const screenshot = `failure-${report.screenshots.length}.png`;
    await page.screenshot({ path: path.join(directory, screenshot), fullPage: true });
    report.screenshots.push(screenshot);
    failure.screenshot = screenshot;
  } catch (captureError) { failure.screenshotError = String(captureError); }
  return failure;
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = args[args.indexOf('--config') + 1];
  const outputPath = args[args.indexOf('--out') + 1];
  const input = JSON.parse(await readFile(configPath, 'utf8'));
  await mkdir(input.screenshotDirectory ?? path.dirname(outputPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(25_000);
  const report = { runtimeBinding: { verified: false, status: 'unobserved' }, gates: {}, screenshots: [], files: [], recoverableOverrides: [], browser: { engine: 'chromium', version: browser.version(), revision: /(?:chromium|chrome|headless_shell)[-_](\d+)/i.exec(chromium.executablePath())?.[1] ?? 'unobserved' } };
  const errors = [];
  const screenshotDirectory = input.screenshotDirectory ?? path.dirname(outputPath);
  let phase = 'login';
  let activeEntity;
  page.on('pageerror', (error) => errors.push(error.message));
  const gate = async (id, action) => {
    try { report.gates[id] = { status: 'pass', details: await action() }; }
    catch (error) { const failure = await recordSiteHelperFailure(report, page, error, screenshotDirectory, { gate: id }); report.gates[id] = { status: 'fail', reason: failure.message, details: failure }; }
  };
  let partOverride;
  let partOverrideContent;
  let partOriginalRaw;
  try {
    await login(page, input.baseUrl);
    phase = 'runtime-settings';
    await page.goto(`${input.baseUrl}/wp-admin/site-editor.php?canvas=edit`);
    await page.waitForFunction(() => Boolean(globalThis.wp?.apiFetch));
    const settings = await page.evaluate(async () => globalThis.wp.apiFetch({ path: '/wp/v2/settings?context=edit' }));
    const principal = await page.evaluate(async () => globalThis.wp.apiFetch({ path: '/wp/v2/users/me?context=edit' }));
    report.principal = { id: principal.id, manageOptions: principal.capabilities?.manage_options === true };
    const verified = await runAfterRuntimeVerification(settings, input.runtimeMarker, async () => {
      if (!principal.capabilities?.manage_options || (input.principalId && principal.id !== input.principalId)) throw new Error('Authenticated browser principal cannot manage fixture options');
      if (input.verifyOnly) return;
      if (input.files) {
        for (const file of input.files) {
          phase = 'theme_roundtrip';
          activeEntity = { file: file.file, postType: file.kind === 'part' ? 'wp_template_part' : 'wp_template' };
          const result = await proveControlledThemeFile(page, input.theme, file, input.baseUrl, (override) => report.recoverableOverrides.push(override));
          report.files.push(result);
          if (result.status !== 'pass') await recordSiteHelperFailure(report, page, new Error(result.reason ?? 'Theme file proof failed'), screenshotDirectory, activeEntity);
        }
        return;
      }
      await gate('site_routes', async () => {
        const records = [];
        for (const item of input.pages) {
          const record = await page.evaluate(async (id) => globalThis.wp.apiFetch({ path: `/wp/v2/pages/${id}?context=edit` }), item.wpId);
          const parent = item.parentId ? input.pages.find((candidate) => candidate.id === item.parentId).wpId : 0;
          const wanted = item.route === '/' ? '/' : `${item.route.replace(/\/$/, '')}/`;
          if (record.parent !== parent || record.template !== item.template || record.status !== 'publish' || new URL(record.link).pathname !== wanted || record.content.raw !== item.content) throw new Error(`Route/parent/template/raw mismatch: ${item.id}`);
          records.push(record);
        }
        if (settings.show_on_front !== 'page' || settings.page_on_front !== input.pages.find((item) => item.id === input.intent.homePageId).wpId) throw new Error('Explicit front-page option mismatch');
        return records;
      });
      await gate('site_content', async () => {
        const results = [];
        for (const item of input.pages) {
          const response = await page.goto(`${input.baseUrl}${item.route}`);
          if (response?.status() !== 200) throw new Error(`Page response failed: ${item.id}`);
          for (const text of texts(input.intent.pages.find((candidate) => candidate.id === item.id).body.blocks)) if (!(await page.locator('body').innerText()).includes(text)) throw new Error(`Missing page content ${item.id}: ${text}`);
          for (const text of texts(input.intent.parts.footer.body.blocks)) if (!(await page.locator('body').innerText()).includes(text)) throw new Error('Missing shared footer');
          if (await page.locator('.wp-block-navigation').count() === 0 || await page.locator('.wp-block-post-content').count() === 0) throw new Error('Shared header or post-content missing');
          results.push({ id: item.id, status: response.status() });
        }
        return results;
      });
      await gate('site_assets', async () => {
        await page.goto(input.baseUrl);
        const images = await page.locator('.wp-block-post-content img').evaluateAll((items) => items.map((image) => ({ src: image.currentSrc, loaded: image.complete && image.naturalWidth > 0 })));
        if (!images.length || images.some((image) => !image.loaded)) throw new Error('Native media did not load');
        const themeAssets = [];
        for (const asset of input.themeAssets ?? []) {
          const url = `${input.themeAssetBaseUrl}/${asset}`;
          const response = await page.request.get(url);
          if (response.status() !== 200) throw new Error(`Declared theme asset failed: ${asset}`);
          themeAssets.push({ url, status: response.status() });
        }
        return { images, themeAssets };
      });
      const expectedStyles = input.intent.theme.themeJson.styles?.color;
      if (!expectedStyles?.background || !expectedStyles?.text) throw new Error('Controlled fixture must declare background and text styles');
      const styleCheck = async (surface) => {
        const styles = await surface.locator('body, .editor-styles-wrapper').last().evaluate((element) => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
        const expected = await page.evaluate((values) => Object.fromEntries(Object.entries(values).map(([key, value]) => { const element = document.createElement('span'); element.style.color = value; document.body.append(element); const color = getComputedStyle(element).color; element.remove(); return [key, color]; })), expectedStyles);
        if (styles.color !== expected.text || styles.background !== expected.background) throw new Error(`Declared theme styles mismatch: ${JSON.stringify({ styles, expected })}`);
        const properties = await surface.locator('body, .editor-styles-wrapper').last().evaluate((element, assertions) => assertions.map(({ name, value }) => ({ name, expected: value, observed: getComputedStyle(element).getPropertyValue(name).trim() })), input.cssProperties ?? []);
        if (properties.some((property) => property.observed !== property.expected)) throw new Error(`Declared stylesheet properties mismatch: ${JSON.stringify(properties)}`);
        return { styles, properties };
      };
      await gate('site_frontend_styles', () => styleCheck(page));
      await gate('site_navigation', async () => {
        const results = [];
        for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
          await page.setViewportSize(viewport);
          await page.goto(input.baseUrl);
          const mobile = viewport.width < 600;
          const nav = page.locator('.wp-block-navigation').first();
          if (mobile) await nav.locator('.wp-block-navigation__responsive-container-open').click();
          const submenu = nav.locator('.wp-block-navigation-submenu').first();
          const toggle = submenu.locator('button').first();
          if (await toggle.isVisible()) {
            await toggle.focus();
            await page.keyboard.press('Enter');
          } else {
            await submenu.locator('a').first().focus();
            await submenu.hover();
          }
          const opened = await submenu.locator('.wp-block-navigation__submenu-container').isVisible();
          const link = submenu.locator('a').last();
          const href = await link.getAttribute('href');
          await link.click();
          await page.waitForURL((url) => url.pathname.replace(/\/$/, '') === new URL(href, input.baseUrl).pathname.replace(/\/$/, ''));
          const followed = (await page.locator('.wp-block-post-content').innerText()).length > 0;
          await page.goto(input.baseUrl);
          let closed;
          if (!mobile) {
            await page.locator('.wp-block-post-content').first().hover();
            closed = !(await page.locator('.wp-block-navigation__submenu-container').first().isVisible());
          }
          if (mobile) {
            await page.locator('.wp-block-navigation__responsive-container-open').first().click();
            await page.locator('.wp-block-navigation__responsive-container-close').first().click();
            closed = !(await page.locator('.wp-block-navigation__responsive-container.is-menu-open').count());
          }
          const screenshot = `${mobile ? 'mobile' : 'desktop'}.png`;
          await page.screenshot({ path: path.join(input.screenshotDirectory, screenshot), fullPage: true });
          report.screenshots.push(screenshot);
          results.push({ viewport, opened, followed, closed });
        }
        if (!evaluateSiteNavigation(results)) throw new Error('Native desktop/mobile navigation interaction failed');
        return results;
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      const ordinary = input.pages.find((item) => item.id !== input.intent.homePageId && !item.parentId);
      const ordinaryIntent = input.intent.pages.find((item) => item.id === ordinary.id);
      await gate('site_editor_styles', async () => {
        await page.goto(`${input.baseUrl}/wp-admin/post.php?post=${ordinary.wpId}&action=edit`);
        await page.waitForFunction(() => Boolean(globalThis.wp?.blocks?.serialize));
        const canvas = await waitForDeclaredMount(page, names(ordinaryIntent.body.blocks));
        return styleCheck(canvas);
      });
      await gate('site_page_edit', async () => {
        const oldText = texts(ordinaryIntent.body.blocks).at(-1);
        const newText = `${oldText} Proof edit.`;
        const result = await editAndReopen(page, input, { ...ordinary, ...ordinaryIntent, oldText, newText });
        for (const item of input.pages) {
          await page.goto(`${input.baseUrl}${item.route}`);
          if ((await page.locator('body').innerText()).includes(newText) !== (item.id === ordinary.id)) throw new Error('Ordinary page edit appeared in an unintended location or was lost');
        }
        return result;
      });
      await gate('site_part_edit', async () => {
        const body = input.intent.parts.footer.body;
        const oldText = texts(body.blocks).at(-1);
        const newText = `${oldText} Shared proof edit.`;
        const result = await editAndReopen(page, input, { kind: 'part', slug: 'footer', body, oldText, newText }, (id, content, originalRaw) => { partOverride = id; partOverrideContent = content; partOriginalRaw = originalRaw; });
        partOverride = result.overrideId;
        for (const item of input.pages) {
          await page.goto(`${input.baseUrl}${item.route}`);
          if (!(await page.locator('body').innerText()).includes(newText)) throw new Error('Shared footer edit was lost');
        }
        return result;
      });
    });
    report.runtimeBinding = { verified: verified && principal.capabilities?.manage_options === true };
    if (input.verifyOnly && !report.runtimeBinding.verified) process.exitCode = 1;
    if (!verified) for (const id of ['site_content', 'site_routes', 'site_assets', 'site_frontend_styles', 'site_editor_styles', 'site_navigation', 'site_page_edit', 'site_part_edit']) report.gates[id] = { status: 'fail', reason: 'Wrong runtime marker; zero fixture editor writes' };
    if (!input.files && !input.verifyOnly) report.gates.site_runtime_errors = { status: errors.length ? 'fail' : 'pass', reason: errors.length ? 'Browser runtime errors' : undefined, details: errors };
  } catch (error) {
    await recordSiteHelperFailure(report, page, error, screenshotDirectory, { phase, ...(activeEntity ?? {}) });
    process.exitCode = 1;
  } finally {
    if (partOverride) {
      try {
        await page.goto(`${input.baseUrl}/wp-admin/site-editor.php?canvas=edit`);
        await page.waitForFunction(() => Boolean(globalThis.wp?.apiFetch));
        const settings = await page.evaluate(async () => globalThis.wp.apiFetch({ path: '/wp/v2/settings?context=edit' }));
        if (settings.description !== input.runtimeMarker) throw new Error('Marker changed before shared override cleanup');
        const current = await page.evaluate(async (theme) => globalThis.wp.apiFetch({ path: `/wp/v2/template-parts/${theme}//footer?context=edit` }), input.theme);
        if (current.source !== 'custom' || Number(current.wp_id) !== partOverride || current.content?.raw !== partOverrideContent) throw new Error('Shared override ownership changed; preserved');
        report.recoverableOverrides.push({ id: partOverride, content: partOverrideContent, postType: 'wp_template_part', entityId: `${input.theme}//footer`, originalRaw: partOriginalRaw });
      } catch (error) { report.gates.site_part_edit = { status: 'fail', reason: String(error) }; }
    }
    await browser.close();
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.files.some((file) => file.status !== 'pass') || Object.values(report.gates).some((gate) => gate.status !== 'pass')) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
