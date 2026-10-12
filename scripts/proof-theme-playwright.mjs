#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

export async function runAfterRuntimeVerification(settings, marker, action) {
  if (typeof marker !== 'string' || !marker || settings?.description !== marker) return false;
  await action();
  return true;
}

async function main() {
  const args = new Map(process.argv.slice(2).filter((value, index) => index % 2 === 0).map((key, index) => [key, process.argv.slice(2)[index * 2 + 1]]));
  const configPath = args.get('--config');
  const outputPath = args.get('--out');
  if (!configPath || !outputPath) throw new Error('Usage: node scripts/proof-theme-playwright.mjs --config <proof.json> --out <result.json>');

  const input = JSON.parse(await readFile(configPath, 'utf8'));
  if (typeof input.theme !== 'string' || !Array.isArray(input.files) || typeof input.baseUrl !== 'string' || typeof input.runtimeMarker !== 'string') {
    throw new Error('Theme proof requires theme, files, baseUrl, and runtimeMarker.');
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL: input.baseUrl });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);
  const revision = /(?:chromium|chrome|headless_shell)[-_](\d+)/i.exec(chromium.executablePath())?.[1] ?? 'unobserved';
  const report = { theme: input.theme, browser: { engine: 'chromium', version: browser.version(), revision }, files: [] };

  try {
    await login(page, input.baseUrl);
    await page.goto(`${input.baseUrl}/wp-admin/site-editor.php?canvas=edit`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof globalThis.wp?.apiFetch === 'function');
    const settings = await page.evaluate(async () => globalThis.wp.apiFetch({ path: '/wp/v2/settings?context=edit' }));
    const runtimeVerified = await runAfterRuntimeVerification(settings, input.runtimeMarker, async () => {
      for (const file of input.files) report.files.push(await proveFile(page, input.theme, file, input.baseUrl));
    });
    report.runtimeBinding = { verified: runtimeVerified };
    if (!runtimeVerified) {
      report.files = input.files.map((file) => ({
        file: file.file,
        kind: file.kind,
        status: 'fail',
        reason: 'Authenticated WordPress settings did not contain this run’s runtime marker; no template save was attempted.',
      }));
    }
  } finally {
    await browser.close();
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  if (report.files.some((file) => file.status !== 'pass')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();

export async function proveFile(page, theme, file, baseUrl, hooks = {}) {
  const part = file.kind === 'part';
  const entityType = part ? 'wp_template_part' : 'wp_template';
  const route = part ? 'template-parts' : 'templates';
  const relative = file.file.replace(part ? /^parts\// : /^templates\//, '').replace(/\.html$/i, '');
  const entityId = `${theme}//${relative}`;
  // WordPress expects each ID component encoded independently while retaining
  // the two REST hierarchy separators literally.
  const encodedRelative = relative.split('/').map((part) => encodeURIComponent(part)).join('/');
  const restPath = `/wp/v2/${route}/${encodeURIComponent(theme)}//${encodedRelative}?context=edit`;
  const postId = new URLSearchParams({ postType: entityType, postId: entityId });
  const result = {
    file: file.file,
    kind: file.kind,
    entityType,
    entityId,
    restPath,
    status: 'fail',
  };
  let createdOverride = false;
  let createdOverrideId;
  try {
    postId.set('canvas', 'edit');
    await page.goto(`${baseUrl}/wp-admin/site-editor.php?${postId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.wp?.data?.resolveSelect && globalThis.wp?.blocks?.parse && globalThis.wp?.blocks?.serialize));
    await page.waitForFunction((entityId) => globalThis.wp?.data?.select('core/editor')?.getCurrentPostId?.() === entityId, entityId);
    await page.locator('iframe[name="editor-canvas"], .editor-styles-wrapper, .block-editor-writing-flow').first().waitFor({ state: 'visible' });
    await page.waitForFunction((entityId) => {
      const wp = globalThis.wp;
      const editor = wp?.data?.select('core/editor');
      const blocks = wp?.data?.select('core/block-editor')?.getBlocks?.();
      return editor?.getCurrentPostId?.() === entityId
        && (typeof editor?.isEditorReady !== 'function' || editor.isEditorReady())
        && Array.isArray(blocks);
    }, entityId);
    // Store initialization precedes React mount effects such as accordion context sync.
    const canvas = page.frame({ name: 'editor-canvas' }) ?? page;
    await canvas.locator('.block-editor-block-list__layout').first().waitFor({ state: 'attached' });
    if (hooks.awaitMounted) await hooks.awaitMounted(page, file);
    else await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const before = await page.evaluate(async ({ entityType, entityId }) => {
      const core = globalThis.wp.data;
      const entity = await core.resolveSelect('core').getEntityRecord('postType', entityType, entityId);
      if (!entity) return { error: 'The Site Editor did not load the requested entity.' };
      const storeEntity = core.select('core').getEntityRecord('postType', entityType, entityId);
      return {
        id: entity.id,
        source: entity.source,
        wp_id: entity.wp_id,
        raw: entity.content?.raw,
        storeId: storeEntity?.id,
        storeSource: storeEntity?.source,
      };
    }, { entityType, entityId });
    result.loadedEntity = before;
    if (before.error || before.source !== 'theme' || before.storeSource !== 'theme') {
      result.reason = before.error ?? 'The original entity source was not the theme.';
      return result;
    }
    if (before.id !== entityId || before.storeId !== entityId) {
      result.reason = 'The Site Editor loaded a different entity/current id than the requested theme item.';
      return result;
    }
    if (typeof before.raw !== 'string') {
      result.reason = 'The loaded theme entity did not contain content.raw.';
      return result;
    }
    result.loadedRaw = before.raw;
    const save = await page.evaluate(async ({ entityType, entityId }) => {
      const wp = globalThis.wp;
      const core = wp.data;
      const entity = core.select('core').getEntityRecord('postType', entityType, entityId);
      if (!entity || entity.id !== entityId || entity.source !== 'theme' || typeof entity.content?.raw !== 'string') {
        throw new Error('The loaded source entity changed before save.');
      }
      const blocks = core.select('core/block-editor')?.getBlocks?.();
      if (!Array.isArray(blocks)) throw new Error('The mounted Site Editor block state was unavailable.');
      const serialized = wp.blocks.serialize(blocks);
      const editedContent = core.select('core/editor')?.getEditedPostContent?.();
      if (typeof editedContent !== 'string') throw new Error('The Site Editor did not expose its mounted edited content.');
      if (editedContent !== serialized) throw new Error('The mounted block state and edited content disagree; no save was attempted.');
      const saved = await core.dispatch('core').saveEntityRecord('postType', entityType, {
        id: entity.id,
        content: serialized,
      }, { throwOnError: true });
      return {
        serialized,
        editedContent,
        mountedBlockCount: blocks.length,
        savedId: saved?.id,
        savedSource: saved?.source,
        savedWpId: saved?.wp_id,
      };
    }, { entityType, entityId });
    result.editorSave = save;
    const savedWpId = Number(save.savedWpId);
    createdOverrideId = Number.isInteger(savedWpId) && savedWpId > 0 ? savedWpId : undefined;
    createdOverride = createdOverrideId !== undefined;
    const fresh = await page.evaluate(async (restPath) => globalThis.wp.apiFetch({ path: restPath }), restPath);
    const savedRaw = fresh.content?.raw;
    result.restRead = { id: fresh.id, source: fresh.source, wp_id: fresh.wp_id, raw: savedRaw };
    const freshOverrideIsOurs = fresh.source === 'custom' && Number.isInteger(Number(fresh.wp_id)) && Number(fresh.wp_id) > 0
      && createdOverrideId === Number(fresh.wp_id);
    if (!freshOverrideIsOurs) {
      result.reason = 'Fresh REST read did not report this saved entity as source custom with a positive wp_id.';
      return result;
    }
    if (fresh.id !== entityId) {
      result.reason = 'Fresh REST read returned a different entity ID.';
      return result;
    }
    result.savedRaw = savedRaw;
    result.status = 'pass';
    return result;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    if (createdOverride && createdOverrideId) {
      try {
        if (hooks.cleanupOverride) {
          result.cleanup = await hooks.cleanupOverride({ page, restPath, id: createdOverrideId, entityType, result });
          return result;
        }
        const current = await page.evaluate(async (restPath) => globalThis.wp.apiFetch({ path: restPath }), restPath);
        if (current.source !== 'custom' || Number(current.wp_id) !== createdOverrideId) {
          result.status = 'fail';
          result.cleanup = { skipped: true, currentSource: current.source, currentWpId: current.wp_id };
          result.reason = 'The saved override changed before cleanup; it was preserved.';
        } else {
          const deleted = await page.evaluate(async ({ restPath }) => globalThis.wp.apiFetch({ path: restPath, method: 'DELETE', data: { force: true } }), { restPath });
          const restored = await page.evaluate(async ({ restPath }) => globalThis.wp.apiFetch({ path: restPath }), { restPath });
          const deletedWpId = deleted?.previous?.wp_id;
          result.cleanup = { deletedId: deleted?.previous?.id, sourceAfterDelete: restored.source, wp_idAfterDelete: restored.wp_id };
          if (Number(deletedWpId) !== createdOverrideId || restored.source !== 'theme' || restored.content?.raw !== result.loadedRaw) {
            result.status = 'fail';
            result.reason = 'The exact override created by this run could not be removed back to its original theme source.';
          }
        }
      } catch (error) {
        result.status = 'fail';
        result.cleanup = { error: error instanceof Error ? error.message : String(error) };
        result.reason ??= 'The exact override created by this run could not be removed.';
      }
    }
  }
}

async function login(page, baseUrl) {
  await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: 'domcontentloaded' });
  if (!/wp-login\.php/.test(page.url())) return;
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.activeElement?.id === 'user_login');
  await page.locator('#user_login').fill(process.env.WP_USERNAME ?? 'admin');
  await page.locator('#user_pass').fill(process.env.WP_PASSWORD ?? 'password');
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith('/wp-login.php'), { waitUntil: 'domcontentloaded' }),
    page.locator('#wp-submit').click(),
  ]);
}

