import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../proof/receipt.js';
import { validateSyncedPatternOverrideContent } from './patterns.js';
import { readStableRegularFile } from '../publication.js';
import type { IntentNode, IntentTree } from '../types.js';
import type {
  PreparedSiteAsset,
  PreparedSiteSourceResult,
  SiteAssetIntent,
  SiteAssetUse,
  SiteDocumentIntent,
  SiteInputDiagnostic,
  SiteIntent,
  SitePatternIntent,
  SiteSyncedPatternUse,
} from './types.js';

const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ROUTE_SEGMENT = /^[^/?#\\\u0000]+$/;
const ASSET_ATTRIBUTES = new Set(['url', 'attrs.url', 'attrs.src', 'attrs.id']);
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** Validate a site envelope and read each declared asset from the caller's explicit asset root. */
export async function prepareSiteSource(input: unknown, assetRoot: string): Promise<PreparedSiteSourceResult> {
  const diagnostics: SiteInputDiagnostic[] = [];
  const validated = validateSiteIntent(input, diagnostics);
  if (!validated) return { ok: false, diagnostics };

  const canonicalRoot = path.resolve(assetRoot);
  try {
    await inspectPathChain(canonicalRoot, undefined);
  } catch (error) {
    diagnostics.push({ path: '/assetRoot', code: 'asset-root', message: errorMessage(error) });
    return { ok: false, diagnostics };
  }

  const assets: PreparedSiteAsset[] = [];
  for (let index = 0; index < validated.assets.length; index += 1) {
    const declaration = validated.assets[index]!;
    const declarationPath = `/assets/${index}/path`;
    try {
      const absolutePath = path.resolve(canonicalRoot, ...declaration.path.split('/'));
      if (!isWithin(canonicalRoot, absolutePath)) throw new Error('path escapes the asset root');
      const beforeChain = await inspectPathChain(canonicalRoot, declaration.path);
      const stable = await readStableRegularFile(absolutePath, 'asset changed or is not a regular file', MAX_ASSET_BYTES);
      const afterChain = await inspectPathChain(canonicalRoot, declaration.path);
      if (!samePathChain(beforeChain, afterChain) || stable.content.byteLength !== afterChain.at(-1)?.size) {
        throw new Error('asset changed while it was being prepared');
      }
      const bytes = stable.content;
      assets.push({
        id: declaration.id,
        path: declaration.path,
        kind: declaration.kind,
        role: declaration.role,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: new Uint8Array(bytes),
      });
    } catch (error) {
      diagnostics.push({ path: declarationPath, code: 'asset-read', message: errorMessage(error) });
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  return {
    ok: true,
    diagnostics: [],
    source: {
      sourceIntent: validated,
      assetRoot: canonicalRoot,
      assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
      sourceIdentity: hashSiteSourceIdentity(validated),
      unresolvedAssetUses: validated.assetUses.filter((use) => {
        const asset = validated.assets.find((candidate) => candidate.id === use.assetId);
        return asset?.role === 'attachment';
      }),
    },
  };
}

/** Hash an already validated intent without repeating envelope or graph validation. */
export function hashSiteSourceIdentity(sourceIntent: SiteIntent): string {
  return createHash('sha256').update(canonicalJson(sourceIntent)).digest('hex');
}

/** Graph and envelope checks are intentionally local to this contract, not a general schema engine. */
export function validateSiteIntent(input: unknown, diagnostics: SiteInputDiagnostic[] = []): SiteIntent | undefined {
  if (!isRecord(input)) {
    diagnostics.push(issue('/', 'object-required', 'site intent must be an object'));
    return undefined;
  }

  checkKeys(input, ['version', 'siteId', 'homePageId', 'theme', 'templates', 'parts', 'patterns', 'syncedPatterns', 'pages', 'assets', 'assetUses'], '', diagnostics);
  if (input.version !== 1) diagnostics.push(issue('/version', 'unsupported-version', 'only site intent version 1 is supported'));
  if (!isSafeSlug(input.siteId)) diagnostics.push(issue('/siteId', 'unsafe-id', 'siteId must be a lowercase URL-safe identifier'));
  if (!isSafeSlug(input.homePageId)) diagnostics.push(issue('/homePageId', 'unsafe-id', 'homePageId must name a declared page'));

  const theme = input.theme;
  if (!isRecord(theme)) {
    diagnostics.push(issue('/theme', 'object-required', 'theme must be an object'));
  } else {
    checkKeys(theme, ['slug', 'title', 'themeJson'], '/theme', diagnostics);
    if (!isSafeSlug(theme.slug)) diagnostics.push(issue('/theme/slug', 'unsafe-slug', 'theme slug must be lowercase and path-safe'));
    if (!nonEmptyString(theme.title)) diagnostics.push(issue('/theme/title', 'string-required', 'theme title must be a non-empty string'));
    if (!isRecord(theme.themeJson)) diagnostics.push(issue('/theme/themeJson', 'object-required', 'themeJson must be an object'));
  }

  const templates = validateDocuments(input.templates, '/templates', 'template', diagnostics);
  const parts = validateDocuments(input.parts, '/parts', 'part', diagnostics);
  const patterns = validatePatterns(input.patterns, diagnostics);
  const syncedPatterns = input.syncedPatterns === undefined ? undefined : validateSyncedPatterns(input.syncedPatterns, diagnostics);
  if (templates && !Object.hasOwn(templates, 'index')) {
    diagnostics.push(issue('/templates', 'index-template-required', 'templates must declare the required index template'));
  }

  const pages = validatePages(input.pages, diagnostics);
  const assets = validateAssets(input.assets, diagnostics);
  const uses = validateUses(input.assetUses, diagnostics);
  if (assets) validateCssUrlBindings(assets, diagnostics);

  if (pages && templates) {
    const templateNames = new Set(Object.keys(templates));
    for (let index = 0; index < pages.length; index += 1) {
      if (!templateNames.has(pages[index]!.template)) {
        diagnostics.push(issue(`/pages/${index}/template`, 'unknown-template', `unknown template "${pages[index]!.template}"`));
      }
    }
  }
  if (pages && isSafeSlug(input.homePageId)) {
    const homeIndex = pages.findIndex((page) => page.id === input.homePageId);
    if (homeIndex === -1) diagnostics.push(issue('/homePageId', 'unknown-home-page', `unknown home page "${input.homePageId}"`));
    else if (pages[homeIndex]?.route !== '/') diagnostics.push(issue('/homePageId', 'home-route-required', 'homePageId must identify the page whose route is "/"'));
  }

  if (templates && parts && patterns && pages && uses && assets) {
    const trees = collectTrees(templates, parts, patterns, pages, syncedPatterns?.definitions);
    checkDocumentReferences(trees, parts, patterns, pages, diagnostics);
    const assetIds = new Map(assets.map((asset) => [asset.id, asset]));
    const seenUses = new Set<string>();
    for (let index = 0; index < uses.length; index += 1) {
      const use = uses[index]!;
      const usePath = `/assetUses/${index}`;
      const tree = trees.get(use.documentId);
      if (!tree) {
        diagnostics.push(issue(`${usePath}/documentId`, 'unknown-document', `unknown document "${use.documentId}"`));
        continue;
      }
      const node = nodeAtPath(tree, use.nodePath);
      if (!node) {
        diagnostics.push(issue(`${usePath}/nodePath`, 'unknown-node', 'nodePath does not identify a node in the declared document'));
      } else if (!ASSET_ATTRIBUTES.has(use.attribute)) {
        diagnostics.push(issue(`${usePath}/attribute`, 'unsupported-attribute', `unsupported asset attribute "${String(use.attribute)}"`));
      } else if (use.attribute === 'attrs.id' && node.block !== 'core/image' && node.block !== 'core/cover') {
        diagnostics.push(issue(`${usePath}/attribute`, 'unsupported-attribute', 'attrs.id asset uses are supported only on core/image and core/cover'));
      }
      const asset = assetIds.get(use.assetId);
      if (!asset) {
        diagnostics.push(issue(`${usePath}/assetId`, 'unknown-asset', `unknown asset id "${use.assetId}"`));
      } else if ((node?.block === 'core/image' || node?.block === 'core/cover') && asset.role !== 'attachment') {
        diagnostics.push(issue(`${usePath}/assetId`, 'attachment-required', 'core/image and core/cover asset uses require an attachment asset'));
      }
      const target = `${use.documentId}\0${use.nodePath.join('.') }\0${use.attribute}`;
      if (seenUses.has(target)) diagnostics.push(issue(usePath, 'duplicate-asset-use', 'an asset use already targets this document attribute'));
      seenUses.add(target);
    }
    if (syncedPatterns) validateSyncedPatternUses(syncedPatterns, trees, diagnostics);
    for (const [documentId, tree] of trees) {
      const visit = (nodes: IntentNode[], pathParts: number[]): void => nodes.forEach((node, index) => {
        const at = [...pathParts, index];
        if (node.block === 'core/block' && !syncedPatterns?.uses.some((use) => use.documentId === documentId && use.nodePath.join('.') === at.join('.'))) {
          diagnostics.push(issue(`${documentIdPath(documentId)}${nodePath(at)}`, 'undeclared-pattern-reference', 'core/block requires an explicit syncedPatterns use'));
        }
        if (node.children) visit(node.children, at);
      });
      visit(tree.blocks, []);
    }
  }

  if (diagnostics.length > 0 || !theme || !templates || !parts || !patterns || !pages || !assets || !uses || (input.syncedPatterns !== undefined && !syncedPatterns)) return undefined;
  return {
    version: 1,
    siteId: input.siteId as string,
    homePageId: input.homePageId as string,
    theme: theme as SiteIntent['theme'],
    templates,
    parts,
    patterns,
    ...(syncedPatterns ? { syncedPatterns } : {}),
    pages,
    assets,
    assetUses: uses,
  };
}

function validateSyncedPatterns(value: unknown, diagnostics: SiteInputDiagnostic[]): SiteIntent['syncedPatterns'] | undefined {
  const root = '/syncedPatterns';
  if (!isRecord(value)) { diagnostics.push(issue(root, 'object-required', 'syncedPatterns must be an object')); return undefined; }
  checkKeys(value, ['version', 'definitions', 'uses'], root, diagnostics);
  if (value.version !== 1) diagnostics.push(issue(`${root}/version`, 'unsupported-version', 'only syncedPatterns version 1 is supported'));
  if (!isRecord(value.definitions)) { diagnostics.push(issue(`${root}/definitions`, 'object-required', 'definitions must be a logical-ID-to-definition object')); return undefined; }
  const definitions: NonNullable<SiteIntent['syncedPatterns']>['definitions'] = {};
  for (const [id, item] of Object.entries(value.definitions)) {
    const current = `${root}/definitions/${escapePointer(id)}`;
    if (!isSafeSlug(id)) diagnostics.push(issue(current, 'unsafe-id', 'logical pattern ID must be lowercase and path-safe'));
    if (!isRecord(item)) { diagnostics.push(issue(current, 'object-required', 'definition must be an object')); continue; }
    checkKeys(item, ['title', 'body'], current, diagnostics);
    if (!nonEmptyString(item.title)) diagnostics.push(issue(`${current}/title`, 'string-required', 'pattern title must be a non-empty string'));
    const body = validateTree(item.body, `${current}/body`, diagnostics);
    if (isSafeSlug(id) && nonEmptyString(item.title) && body) definitions[id] = { title: item.title, body };
  }
  const uses = validateSyncedUses(value.uses, diagnostics);
  if (value.version !== 1 || !uses) return undefined;
  return { version: 1, definitions, uses };
}

function validateSyncedUses(value: unknown, diagnostics: SiteInputDiagnostic[]): SiteSyncedPatternUse[] | undefined {
  const root = '/syncedPatterns/uses';
  if (!Array.isArray(value)) { diagnostics.push(issue(root, 'array-required', 'uses must be an array')); return undefined; }
  const uses: SiteSyncedPatternUse[] = [];
  for (const [index, entry] of value.entries()) {
    const current = `${root}/${index}`;
    if (!isRecord(entry)) { diagnostics.push(issue(current, 'object-required', 'use must be an object')); continue; }
    checkKeys(entry, ['documentId', 'nodePath', 'patternId', 'content'], current, diagnostics);
    if (typeof entry.documentId !== 'string' || !/^(page|synced-pattern|template|part|pattern):[a-z0-9][a-z0-9-]*$/.test(entry.documentId)) diagnostics.push(issue(`${current}/documentId`, 'invalid-document-id', 'documentId must name a declared page or document'));
    if (!Array.isArray(entry.nodePath) || !entry.nodePath.every((part) => Number.isInteger(part) && part >= 0)) diagnostics.push(issue(`${current}/nodePath`, 'invalid-node-path', 'nodePath must be an array of non-negative child indices'));
    if (!isSafeSlug(entry.patternId)) diagnostics.push(issue(`${current}/patternId`, 'unsafe-id', 'patternId must be a declared logical pattern ID'));
    let content: SiteSyncedPatternUse['content'];
    if (entry.content !== undefined) {
      if (!isRecord(entry.content)) diagnostics.push(issue(`${current}/content`, 'object-required', 'content must map metadata.name values to attribute objects'));
      else {
        content = {};
        for (const [name, attrs] of Object.entries(entry.content)) {
          if (!nonEmptyString(name)) diagnostics.push(issue(`${current}/content/${escapePointer(name)}`, 'invalid-name', 'content keys must be non-empty metadata.name values'));
          if (!isRecord(attrs)) diagnostics.push(issue(`${current}/content/${escapePointer(name)}`, 'object-required', 'override content must be an attribute object'));
          else content[name] = attrs;
        }
      }
    }
    if (typeof entry.documentId === 'string' && /^(page|synced-pattern|template|part|pattern):[a-z0-9][a-z0-9-]*$/.test(entry.documentId) && Array.isArray(entry.nodePath) && entry.nodePath.every((part) => Number.isInteger(part) && part >= 0) && isSafeSlug(entry.patternId) && (entry.content === undefined || isRecord(entry.content))) {
      uses.push({ documentId: entry.documentId, nodePath: entry.nodePath as number[], patternId: entry.patternId, ...(content ? { content } : {}) });
    }
  }
  return uses;
}

function validateSyncedPatternUses(
  extension: NonNullable<SiteIntent['syncedPatterns']>,
  trees: Map<string, IntentTree>,
  diagnostics: SiteInputDiagnostic[],
): void {
  const defs = extension.definitions;
  const seen = new Set<string>();
  const graph = new Map<string, Set<string>>();
  for (const id of Object.keys(defs)) graph.set(id, new Set());
  for (const [index, use] of extension.uses.entries()) {
    const base = `/syncedPatterns/uses/${index}`;
    const target = defs[use.patternId];
    if (!target) diagnostics.push(issue(`${base}/patternId`, 'unknown-pattern-id', `unknown synced pattern "${use.patternId}"`));
    const tree = trees.get(use.documentId);
    if (!tree) { diagnostics.push(issue(`${base}/documentId`, 'unknown-document', `unknown document "${use.documentId}"`)); continue; }
    const node = nodeAtPath(tree, use.nodePath);
    if (!node) diagnostics.push(issue(`${base}/nodePath`, 'unknown-node', 'nodePath does not identify a node in the declared document'));
    else if (node.block !== 'core/block' || node.children?.length || node.attrs && Object.keys(node.attrs).some((key) => ['ref', 'content'].includes(key))) diagnostics.push(issue(`${base}/nodePath`, 'invalid-pattern-placeholder', 'synced pattern use must identify a childless core/block placeholder without ref or content attributes'));
    const key = `${use.documentId}\0${use.nodePath.join('.')}`;
    if (seen.has(key)) diagnostics.push(issue(base, 'duplicate-pattern-use', 'a synced pattern use already targets this document node'));
    seen.add(key);
    if (use.documentId.startsWith('synced-pattern:')) graph.get(use.documentId.slice('synced-pattern:'.length))?.add(use.patternId);
    if (use.content && target) for (const message of validateSyncedPatternOverrideContent(target.body, use.content)) diagnostics.push(issue(`${base}/content`, 'invalid-override-content', message));
  }
  for (const [id, definition] of Object.entries(defs)) {
    const visit = (nodes: IntentNode[], pathParts: number[]): void => nodes.forEach((node, index) => {
      const at = [...pathParts, index];
      if (node.block === 'core/block' && !extension.uses.some((use) => use.documentId === `synced-pattern:${id}` && use.nodePath.join('.') === at.join('.'))) diagnostics.push(issue(`/syncedPatterns/definitions/${escapePointer(id)}/body${nodePath(at)}`, 'undeclared-pattern-reference', 'core/block requires an explicit syncedPatterns use'));
      if (node.children) visit(node.children, at);
    });
    visit(definition.body.blocks, []);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string): void => {
    if (state.get(id) === 'visiting') { diagnostics.push(issue(`/syncedPatterns/definitions/${escapePointer(id)}`, 'pattern-cycle', 'synced pattern dependencies must be acyclic')); return; }
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    for (const next of graph.get(id) ?? []) if (defs[next]) walk(next);
    state.set(id, 'done');
  };
  for (const id of Object.keys(defs)) walk(id);
}

function documentIdPath(id: string): string {
  const [kind, name] = id.split(':', 2);
  if (kind === 'page') return `/pages/${name}/body`;
  if (kind === 'synced-pattern') return `/syncedPatterns/definitions/${escapePointer(name ?? '')}/body`;
  const collection = kind === 'template' ? 'templates' : kind === 'part' ? 'parts' : 'patterns';
  return `/${collection}/${escapePointer(name ?? '')}/body`;
}

function validateDocuments(value: unknown, pathName: string, kind: string, diagnostics: SiteInputDiagnostic[]): Record<string, SiteDocumentIntent> | undefined {
  if (!isRecord(value)) {
    diagnostics.push(issue(pathName, 'object-required', `${kind}s must be a name-to-document object`));
    return undefined;
  }
  const result: Record<string, SiteDocumentIntent> = {};
  for (const [name, document] of Object.entries(value)) {
    if (!isSafeSlug(name)) diagnostics.push(issue(`${pathName}/${escapePointer(name)}`, 'unsafe-name', `${kind} name must be lowercase and path-safe`));
    const current = `${pathName}/${escapePointer(name)}`;
    if (!isRecord(document)) {
      diagnostics.push(issue(current, 'object-required', `${kind} must be an object`));
      continue;
    }
    checkKeys(document, ['body'], current, diagnostics);
    const body = validateTree(document.body, `${current}/body`, diagnostics);
    if (body) result[name] = { body };
  }
  return result;
}

function validatePatterns(value: unknown, diagnostics: SiteInputDiagnostic[]): Record<string, SitePatternIntent> | undefined {
  if (!isRecord(value)) {
    diagnostics.push(issue('/patterns', 'object-required', 'patterns must be a file-key-to-pattern object'));
    return undefined;
  }
  const result: Record<string, SitePatternIntent> = {};
  for (const [fileKey, pattern] of Object.entries(value)) {
    const current = `/patterns/${escapePointer(fileKey)}`;
    if (!isSafeSlug(fileKey)) diagnostics.push(issue(current, 'unsafe-file-key', 'pattern file key must be lowercase and path-safe'));
    if (!isRecord(pattern)) {
      diagnostics.push(issue(current, 'object-required', 'pattern must be an object'));
      continue;
    }
    checkKeys(pattern, ['title', 'slug', 'body'], current, diagnostics);
    if (!nonEmptyString(pattern.title)) diagnostics.push(issue(`${current}/title`, 'string-required', 'pattern title must be a non-empty string'));
    if (!isSafeSlug(pattern.slug)) diagnostics.push(issue(`${current}/slug`, 'unsafe-slug', 'pattern slug must be lowercase and path-safe'));
    const body = validateTree(pattern.body, `${current}/body`, diagnostics);
    if (body && nonEmptyString(pattern.title) && isSafeSlug(pattern.slug)) result[fileKey] = { title: pattern.title, slug: pattern.slug, body };
  }
  const slugs = new Map<string, string>();
  for (const [fileKey, pattern] of Object.entries(result)) {
    const prior = slugs.get(pattern.slug.toLowerCase());
    if (prior) diagnostics.push(issue(`/patterns/${escapePointer(fileKey)}/slug`, 'duplicate-pattern-slug', `pattern slug collides with file key "${prior}"`));
    else slugs.set(pattern.slug.toLowerCase(), fileKey);
  }
  return result;
}

function validatePages(value: unknown, diagnostics: SiteInputDiagnostic[]): SiteIntent['pages'] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(issue('/pages', 'array-required', 'pages must be an array'));
    return undefined;
  }
  const pages: SiteIntent['pages'] = [];
  const ids = new Map<string, number>();
  const routes = new Map<string, number>();
  for (let index = 0; index < value.length; index += 1) {
    const page = value[index];
    const current = `/pages/${index}`;
    if (!isRecord(page)) {
      diagnostics.push(issue(current, 'object-required', 'page must be an object'));
      continue;
    }
    checkKeys(page, ['id', 'route', 'title', 'parentId', 'template', 'body', 'status'], current, diagnostics);
    if (!isSafeSlug(page.id)) diagnostics.push(issue(`${current}/id`, 'unsafe-id', 'page id must be lowercase and path-safe'));
    else {
      const prior = ids.get(page.id);
      if (prior !== undefined) diagnostics.push(issue(`${current}/id`, 'duplicate-page-id', `page id duplicates pages/${prior}/id`));
      else ids.set(page.id, index);
    }
    if (typeof page.route !== 'string' || !isSafeRoute(page.route)) {
      diagnostics.push(issue(`${current}/route`, 'unsafe-route', 'route must be a safe root-relative path without query, fragment, traversal, or slash normalization'));
    } else {
      const normalized = normalizeRoute(page.route);
      const prior = routes.get(normalized);
      if (prior !== undefined) diagnostics.push(issue(`${current}/route`, 'duplicate-route', `route collides with pages/${prior}/route after case and slash normalization`));
      else routes.set(normalized, index);
    }
    if (!nonEmptyString(page.title)) diagnostics.push(issue(`${current}/title`, 'string-required', 'page title must be a non-empty string'));
    if (page.parentId !== undefined && !isSafeSlug(page.parentId)) diagnostics.push(issue(`${current}/parentId`, 'unsafe-id', 'parentId must be a lowercase page id'));
    if (!isSafeSlug(page.template)) diagnostics.push(issue(`${current}/template`, 'unsafe-name', 'template must be a lowercase template name'));
    if (page.status !== undefined && page.status !== 'draft' && page.status !== 'publish' && page.status !== 'private' && page.status !== 'pending') {
      diagnostics.push(issue(`${current}/status`, 'invalid-status', 'page status must be draft, publish, private, or pending'));
    }
    const body = validateTree(page.body, `${current}/body`, diagnostics);
    if (isSafeSlug(page.id) && typeof page.route === 'string' && isSafeRoute(page.route) && nonEmptyString(page.title) && isSafeSlug(page.template) && body && (page.status === undefined || ['draft', 'publish', 'private', 'pending'].includes(String(page.status)))) {
      pages.push({
        id: page.id,
        route: page.route,
        title: page.title,
        ...(typeof page.parentId === 'string' ? { parentId: page.parentId } : {}),
        template: page.template,
        body,
        status: (page.status ?? 'draft') as SiteIntent['pages'][number]['status'],
      });
    }
  }

  const indexById = new Map(pages.map((page, index) => [page.id, index]));
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    if (page.parentId && !indexById.has(page.parentId)) diagnostics.push(issue(`/pages/${index}/parentId`, 'unknown-parent', `unknown parent page "${page.parentId}"`));
  }
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === 'visited') return;
    if (state.get(id) === 'visiting') {
      const pageIndex = indexById.get(id)!;
      diagnostics.push(issue(`/pages/${pageIndex}/parentId`, 'parent-cycle', `page parent cycle: ${[...stack, id].join(' -> ')}`));
      return;
    }
    state.set(id, 'visiting');
    const page = pages[indexById.get(id)!]!;
    if (page.parentId && indexById.has(page.parentId)) visit(page.parentId, [...stack, id]);
    state.set(id, 'visited');
  };
  for (const page of pages) visit(page.id, []);
  return pages;
}

function validateAssets(value: unknown, diagnostics: SiteInputDiagnostic[]): SiteAssetIntent[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(issue('/assets', 'array-required', 'assets must be an array'));
    return undefined;
  }
  const assets: SiteAssetIntent[] = [];
  const ids = new Set<string>();
  const paths = new Map<string, number>();
  for (let index = 0; index < value.length; index += 1) {
    const asset = value[index];
    const current = `/assets/${index}`;
    if (!isRecord(asset)) {
      diagnostics.push(issue(current, 'object-required', 'asset must be an object'));
      continue;
    }
    checkKeys(asset, ['id', 'path', 'kind', 'role', 'fontLicense', 'cssUrls'], current, diagnostics);
    if (!isSafeSlug(asset.id)) diagnostics.push(issue(`${current}/id`, 'unsafe-id', 'asset id must be lowercase and path-safe'));
    else if (ids.has(asset.id)) diagnostics.push(issue(`${current}/id`, 'duplicate-asset-id', `asset id "${asset.id}" is already declared`));
    else ids.add(asset.id);
    if (typeof asset.path !== 'string' || !isSafeRelativePath(asset.path)) diagnostics.push(issue(`${current}/path`, 'unsafe-path', 'asset path must be a safe relative path'));
    else {
      const normalized = asset.path.toLowerCase();
      const prior = paths.get(normalized);
      if (prior !== undefined) diagnostics.push(issue(`${current}/path`, 'duplicate-asset-path', `asset path collides with assets/${prior}/path`));
      else paths.set(normalized, index);
    }
    if (!['image', 'font', 'stylesheet', 'other'].includes(String(asset.kind))) diagnostics.push(issue(`${current}/kind`, 'unsupported-kind', 'asset kind must be image, font, stylesheet, or other'));
    if (asset.role !== 'theme-file' && asset.role !== 'attachment') diagnostics.push(issue(`${current}/role`, 'unsupported-role', 'asset role must be theme-file or attachment'));
    const fontLicense = validateFontLicense(asset.fontLicense, asset.kind, asset.role, `${current}/fontLicense`, diagnostics);
    const cssUrls = validateCssUrls(asset.cssUrls, asset.kind, asset.role, `${current}/cssUrls`, diagnostics);
    if (isSafeSlug(asset.id) && typeof asset.path === 'string' && isSafeRelativePath(asset.path) && ['image', 'font', 'stylesheet', 'other'].includes(String(asset.kind)) && (asset.role === 'theme-file' || asset.role === 'attachment')) {
      assets.push({ id: asset.id, path: asset.path, kind: asset.kind as SiteAssetIntent['kind'], role: asset.role,
        ...(fontLicense ? { fontLicense } : {}), ...(cssUrls ? { cssUrls } : {}) });
    }
  }
  return assets;
}

function validateFontLicense(
  value: unknown,
  kind: unknown,
  role: unknown,
  pathName: string,
  diagnostics: SiteInputDiagnostic[],
): SiteAssetIntent['fontLicense'] | undefined {
  if (value === undefined) {
    if (kind === 'font' && role === 'theme-file') diagnostics.push(issue(pathName, 'font-license-required', 'theme font files require explicit ownership and license details'));
    return undefined;
  }
  if (kind !== 'font' || role !== 'theme-file') {
    diagnostics.push(issue(pathName, 'font-license-scope', 'fontLicense is supported only for theme-file font assets'));
    return undefined;
  }
  if (!isRecord(value)) {
    diagnostics.push(issue(pathName, 'font-license-required', 'fontLicense must include ownership and license strings'));
    return undefined;
  }
  checkKeys(value, ['ownership', 'license', 'notice'], pathName, diagnostics);
  if (typeof value.ownership !== 'string' || !value.ownership.trim()) diagnostics.push(issue(`${pathName}/ownership`, 'string-required', 'font ownership decision must be a non-empty string'));
  if (typeof value.license !== 'string' || !value.license.trim()) diagnostics.push(issue(`${pathName}/license`, 'string-required', 'font license must be a non-empty string'));
  if (value.notice !== undefined && typeof value.notice !== 'string') diagnostics.push(issue(`${pathName}/notice`, 'string-required', 'font notice must be text'));
  if (typeof value.ownership !== 'string' || !value.ownership.trim() || typeof value.license !== 'string' || !value.license.trim() || (value.notice !== undefined && typeof value.notice !== 'string')) return undefined;
  return { ownership: value.ownership.trim(), license: value.license.trim(), ...(typeof value.notice === 'string' ? { notice: value.notice } : {}) };
}

function validateCssUrls(
  value: unknown,
  kind: unknown,
  role: unknown,
  pathName: string,
  diagnostics: SiteInputDiagnostic[],
): SiteAssetIntent['cssUrls'] | undefined {
  if (value === undefined) return undefined;
  if (kind !== 'stylesheet' || role !== 'theme-file') {
    diagnostics.push(issue(pathName, 'css-url-scope', 'cssUrls is supported only for theme-file stylesheets'));
    return undefined;
  }
  if (!Array.isArray(value)) {
    diagnostics.push(issue(pathName, 'array-required', 'cssUrls must be an array of exact CSS URL declarations'));
    return undefined;
  }
  const seen = new Set<string>();
  const result: NonNullable<SiteAssetIntent['cssUrls']> = [];
  value.forEach((candidate, index) => {
    const current = `${pathName}/${index}`;
    if (!isRecord(candidate)) {
      diagnostics.push(issue(current, 'object-required', 'CSS URL declaration must be an object'));
      return;
    }
    checkKeys(candidate, ['url', 'assetId'], current, diagnostics);
    if (typeof candidate.url !== 'string' || !candidate.url.trim() || candidate.url !== candidate.url.trim() || /[\u0000-\u001f\u007f]/.test(candidate.url)) {
      diagnostics.push(issue(`${current}/url`, 'invalid-css-url', 'url must be the exact non-empty CSS token value without surrounding whitespace or controls'));
    }
    if (!isSafeSlug(candidate.assetId)) diagnostics.push(issue(`${current}/assetId`, 'unsafe-id', 'assetId must be a declared theme-file asset id'));
    if (typeof candidate.url === 'string') {
      if (seen.has(candidate.url)) diagnostics.push(issue(`${current}/url`, 'duplicate-css-url', 'a stylesheet cannot declare the same CSS URL token more than once'));
      else seen.add(candidate.url);
    }
    if (typeof candidate.url === 'string' && candidate.url.trim() && candidate.url === candidate.url.trim() && !/[\u0000-\u001f\u007f]/.test(candidate.url) && isSafeSlug(candidate.assetId)) {
      result.push({ url: candidate.url, assetId: candidate.assetId });
    }
  });
  return result;
}

function validateCssUrlBindings(assets: SiteAssetIntent[], diagnostics: SiteInputDiagnostic[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  assets.forEach((asset, assetIndex) => {
    for (const [declarationIndex, declaration] of (asset.cssUrls ?? []).entries()) {
      const target = byId.get(declaration.assetId);
      if (!target) diagnostics.push(issue(`/assets/${assetIndex}/cssUrls/${declarationIndex}/assetId`, 'unknown-css-asset', `unknown theme-file asset id "${declaration.assetId}"`));
      else if (target.role !== 'theme-file') diagnostics.push(issue(`/assets/${assetIndex}/cssUrls/${declarationIndex}/assetId`, 'theme-file-required', 'CSS URL declarations must target theme-file assets'));
    }
  });
}

function validateUses(value: unknown, diagnostics: SiteInputDiagnostic[]): SiteAssetUse[] | undefined {
  if (!Array.isArray(value)) {
    diagnostics.push(issue('/assetUses', 'array-required', 'assetUses must be an array'));
    return undefined;
  }
  const uses: SiteAssetUse[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const use = value[index];
    const current = `/assetUses/${index}`;
    if (!isRecord(use)) {
      diagnostics.push(issue(current, 'object-required', 'asset use must be an object'));
      continue;
    }
    checkKeys(use, ['documentId', 'nodePath', 'attribute', 'assetId'], current, diagnostics);
    if (typeof use.documentId !== 'string' || !/^(page|template|part|pattern|synced-pattern):[a-z0-9][a-z0-9-]*$/.test(use.documentId)) {
      diagnostics.push(issue(`${current}/documentId`, 'unsafe-document-id', 'documentId must use a typed stable document key'));
    }
    if (!Array.isArray(use.nodePath) || use.nodePath.some((part) => !Number.isInteger(part) || part < 0)) {
      diagnostics.push(issue(`${current}/nodePath`, 'invalid-node-path', 'nodePath must be an array of non-negative child indices'));
    }
    if (typeof use.attribute !== 'string' || !ASSET_ATTRIBUTES.has(use.attribute)) diagnostics.push(issue(`${current}/attribute`, 'unsupported-attribute', `attribute must be one of ${[...ASSET_ATTRIBUTES].join(', ')}`));
    if (!isSafeSlug(use.assetId)) diagnostics.push(issue(`${current}/assetId`, 'unsafe-id', 'assetId must be a declared stable asset id'));
    if (typeof use.documentId === 'string' && /^(page|template|part|pattern|synced-pattern):[a-z0-9][a-z0-9-]*$/.test(use.documentId) && Array.isArray(use.nodePath) && use.nodePath.every((part) => Number.isInteger(part) && part >= 0) && typeof use.attribute === 'string' && ASSET_ATTRIBUTES.has(use.attribute) && isSafeSlug(use.assetId)) {
      uses.push({ documentId: use.documentId, nodePath: use.nodePath as number[], attribute: use.attribute as SiteAssetUse['attribute'], assetId: use.assetId });
    }
  }
  return uses;
}

function validateTree(value: unknown, pathName: string, diagnostics: SiteInputDiagnostic[]): IntentTree | undefined {
  if (!isRecord(value) || !Array.isArray(value.blocks)) {
    diagnostics.push(issue(pathName, 'intent-tree-required', 'document body must be an IntentTree with a blocks array'));
    return undefined;
  }
  checkKeys(value, ['blocks'], pathName, diagnostics);
  // Preserve native intent trees verbatim. The document compiler/finalizer owns their detailed
  // validity; this boundary consumes only the tree root for references and asset-use paths.
  let valid = true;
  const active = new Set<object>();
  const pending: Array<{ kind: 'enter' | 'exit'; value: object; path: string }> = [
    { kind: 'enter', value: value.blocks, path: `${pathName}/blocks` },
  ];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === 'exit') {
      active.delete(frame.value);
      continue;
    }
    if (active.has(frame.value)) {
      diagnostics.push(issue(frame.path, 'intent-tree-cycle', 'block trees must not contain object or array cycles'));
      valid = false;
      continue;
    }
    active.add(frame.value);
    pending.push({ kind: 'exit', value: frame.value, path: frame.path });
    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        const nodePath = `${frame.path}/${index}`;
        const candidate = frame.value[index];
        if (candidate !== null && typeof candidate === 'object' && active.has(candidate)) {
          diagnostics.push(issue(nodePath, 'intent-tree-cycle', 'block trees must not contain object or array cycles'));
          valid = false;
          continue;
        }
        if (!isRecord(candidate) || typeof candidate.block !== 'string' || candidate.block.length === 0) {
          diagnostics.push(issue(nodePath, 'intent-node-required', 'each block must be an object with a non-empty block name'));
          valid = false;
          continue;
        }
        pending.push({ kind: 'enter', value: candidate, path: nodePath });
      }
      continue;
    }
    const candidate = frame.value as Record<string, unknown>;
    if (Object.hasOwn(candidate, 'children')) {
      if (!Array.isArray(candidate.children)) {
        diagnostics.push(issue(`${frame.path}/children`, 'array-required', 'block children must be an array when present'));
        valid = false;
      } else {
        pending.push({ kind: 'enter', value: candidate.children, path: `${frame.path}/children` });
      }
    }
  }
  return valid ? value as unknown as IntentTree : undefined;
}

function collectTrees(
  templates: Record<string, SiteDocumentIntent>,
  parts: Record<string, SiteDocumentIntent>,
  patterns: Record<string, SitePatternIntent>,
  pages: SiteIntent['pages'],
  syncedPatterns?: NonNullable<SiteIntent['syncedPatterns']>['definitions'],
): Map<string, IntentTree> {
  const result = new Map<string, IntentTree>();
  for (const [name, value] of Object.entries(templates)) result.set(`template:${name}`, value.body);
  for (const [name, value] of Object.entries(parts)) result.set(`part:${name}`, value.body);
  for (const [name, value] of Object.entries(patterns)) result.set(`pattern:${name}`, value.body);
  for (const page of pages) result.set(`page:${page.id}`, page.body);
  for (const [id, pattern] of Object.entries(syncedPatterns ?? {})) result.set(`synced-pattern:${id}`, pattern.body);
  return result;
}

function checkDocumentReferences(
  trees: Map<string, IntentTree>,
  parts: Record<string, SiteDocumentIntent>,
  patterns: Record<string, SitePatternIntent>,
  pages: SiteIntent['pages'],
  diagnostics: SiteInputDiagnostic[],
): void {
  for (const [documentId, tree] of trees) {
    const [kind, name] = documentId.split(':', 2) as [string, string];
    const pageIndex = kind === 'page' ? pages.findIndex((page) => page.id === name) : -1;
    const basePath = kind === 'page'
      ? `/pages/${pageIndex}/body`
      : kind === 'synced-pattern' ? `/syncedPatterns/definitions/${escapePointer(name!)}/body`
      : `/${kind === 'template' ? 'templates' : kind === 'part' ? 'parts' : 'patterns'}/${escapePointer(name!)}/body`;
    const visit = (nodes: unknown[], pathParts: number[]): void => {
      nodes.forEach((candidate, index) => {
        if (!isRecord(candidate)) return;
        const node = candidate as unknown as IntentNode;
        const current = [...pathParts, index];
        if (node.block === 'core/template-part' && typeof node.attrs?.slug === 'string' && !Object.hasOwn(parts, node.attrs.slug)) {
          diagnostics.push(issue(`${basePath}${nodePath(current)}`, 'unknown-template-part', `unknown template part "${node.attrs.slug}"`));
        }
        if (node.block === 'core/pattern' && typeof node.attrs?.slug === 'string' && !Object.values(patterns).some((pattern) => pattern.slug === node.attrs?.slug)) {
          diagnostics.push(issue(`${basePath}${nodePath(current)}`, 'unknown-pattern', `unknown pattern "${node.attrs.slug}"`));
        }
        if (Array.isArray(node.children)) visit(node.children, current);
      });
    };
    visit(tree.blocks, []);
  }
}

function nodePath(indices: number[]): string {
  const [first, ...children] = indices;
  return `/blocks/${first}${children.map((index) => `/children/${index}`).join('')}`;
}

function nodeAtPath(tree: IntentTree, indices: number[]): IntentNode | undefined {
  const first = indices[0];
  if (first === undefined) return undefined;
  let candidate: unknown = tree.blocks[first];
  for (const index of indices.slice(1)) {
    if (!isRecord(candidate) || !Array.isArray(candidate.children)) return undefined;
    candidate = candidate.children[index];
  }
  return isRecord(candidate) && typeof candidate.block === 'string' ? candidate as unknown as IntentNode : undefined;
}

function checkKeys(value: Record<string, unknown>, allowed: string[], pathName: string, diagnostics: SiteInputDiagnostic[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) diagnostics.push(issue(`${pathName}/${escapePointer(key)}`, 'unsupported-field', `unsupported field "${key}"`));
  }
}

function isSafeSlug(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SLUG.test(value);
}

function isSafeRoute(value: string): boolean {
  if (!value.startsWith('/') || value === '/' || value.startsWith('//') || value.endsWith('/') || value.includes('%') || value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#')) return value === '/';
  const segments = value.slice(1).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && ROUTE_SEGMENT.test(segment));
}

function normalizeRoute(value: string): string {
  return value.split('/').filter(Boolean).join('/').toLocaleLowerCase('en-US');
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface PathSnapshot {
  path: string;
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

async function inspectPathChain(root: string, relative?: string): Promise<PathSnapshot[]> {
  const target = relative === undefined ? root : path.resolve(root, ...relative.split('/'));
  if (relative !== undefined && !isWithin(root, target)) throw new Error('path escapes the asset root');
  const parsedRoot = path.parse(target).root;
  const components = target.slice(parsedRoot.length).split(path.sep).filter(Boolean);
  const paths = [parsedRoot];
  let current = parsedRoot;
  for (const component of components) {
    current = path.join(current, component);
    paths.push(current);
  }
  const snapshots: PathSnapshot[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const currentPath = paths[index]!;
    const info = await lstat(currentPath);
    const isFinal = index === paths.length - 1;
    if (info.isSymbolicLink()) throw new Error('symlinks are not allowed in asset root or asset path');
    if (isFinal && relative === undefined && !info.isDirectory()) throw new Error('asset root is not a directory');
    if (isFinal && relative !== undefined && !info.isFile()) throw new Error('asset is not a regular file');
    if (!isFinal && !info.isDirectory()) throw new Error('asset path contains a non-directory component');
    snapshots.push({
      path: currentPath,
      dev: Number(info.dev),
      ino: Number(info.ino),
      mode: Number(info.mode),
      size: Number(info.size),
      mtimeMs: Number(info.mtimeMs),
      ctimeMs: Number(info.ctimeMs),
    });
  }
  return snapshots;
}

function samePathChain(before: PathSnapshot[], after: PathSnapshot[]): boolean {
  return before.length === after.length && before.every((snapshot, index) => {
    const next = after[index];
    if (!next || snapshot.path !== next.path || snapshot.dev !== next.dev || snapshot.ino !== next.ino || snapshot.mode !== next.mode) return false;
    // Directory contents can change because unrelated files are created beside the asset.
    // The final file still requires full metadata stability; its descriptor read is checked too.
    return index !== before.length - 1 || (snapshot.size === next.size && snapshot.mtimeMs === next.mtimeMs && snapshot.ctimeMs === next.ctimeMs);
  });
}

function issue(pathName: string, code: string, message: string): SiteInputDiagnostic {
  return { path: pathName || '/', code, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
