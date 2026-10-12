import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
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
} from './types.js';

const SAFE_SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ROUTE_SEGMENT = /^[^/?#\\\u0000]+$/;
const ASSET_ATTRIBUTES = new Set(['url', 'attrs.url', 'attrs.src', 'attrs.id']);

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
      const stable = await readStableRegularFile(absolutePath, 'asset changed or is not a regular file');
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

  const intentJson = JSON.stringify(validated);
  return {
    ok: true,
    diagnostics: [],
    source: {
      sourceIntent: validated,
      assetRoot: canonicalRoot,
      assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
      sourceIdentity: createHash('sha256').update(intentJson).digest('hex'),
      unresolvedAssetUses: validated.assetUses.filter((use) => {
        const asset = validated.assets.find((candidate) => candidate.id === use.assetId);
        return asset?.role === 'attachment';
      }),
    },
  };
}

/** Graph and envelope checks are intentionally local to this contract, not a general schema engine. */
export function validateSiteIntent(input: unknown, diagnostics: SiteInputDiagnostic[] = []): SiteIntent | undefined {
  if (!isRecord(input)) {
    diagnostics.push(issue('/', 'object-required', 'site intent must be an object'));
    return undefined;
  }

  checkKeys(input, ['version', 'siteId', 'homePageId', 'theme', 'templates', 'parts', 'patterns', 'pages', 'assets', 'assetUses'], '', diagnostics);
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
  if (templates && !Object.hasOwn(templates, 'index')) {
    diagnostics.push(issue('/templates', 'index-template-required', 'templates must declare the required index template'));
  }

  const pages = validatePages(input.pages, diagnostics);
  const assets = validateAssets(input.assets, diagnostics);
  const uses = validateUses(input.assetUses, diagnostics);

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
    const trees = collectTrees(templates, parts, patterns, pages);
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
  }

  if (diagnostics.length > 0 || !theme || !templates || !parts || !patterns || !pages || !assets || !uses) return undefined;
  return {
    version: 1,
    siteId: input.siteId as string,
    homePageId: input.homePageId as string,
    theme: theme as SiteIntent['theme'],
    templates,
    parts,
    patterns,
    pages,
    assets,
    assetUses: uses,
  };
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
    checkKeys(asset, ['id', 'path', 'kind', 'role'], current, diagnostics);
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
    if (isSafeSlug(asset.id) && typeof asset.path === 'string' && isSafeRelativePath(asset.path) && ['image', 'font', 'stylesheet', 'other'].includes(String(asset.kind)) && (asset.role === 'theme-file' || asset.role === 'attachment')) {
      assets.push({ id: asset.id, path: asset.path, kind: asset.kind as SiteAssetIntent['kind'], role: asset.role });
    }
  }
  return assets;
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
    if (typeof use.documentId !== 'string' || !/^(page|template|part|pattern):[a-z0-9][a-z0-9-]*$/.test(use.documentId)) {
      diagnostics.push(issue(`${current}/documentId`, 'unsafe-document-id', 'documentId must use a typed stable document key'));
    }
    if (!Array.isArray(use.nodePath) || use.nodePath.some((part) => !Number.isInteger(part) || part < 0)) {
      diagnostics.push(issue(`${current}/nodePath`, 'invalid-node-path', 'nodePath must be an array of non-negative child indices'));
    }
    if (typeof use.attribute !== 'string' || !ASSET_ATTRIBUTES.has(use.attribute)) diagnostics.push(issue(`${current}/attribute`, 'unsupported-attribute', `attribute must be one of ${[...ASSET_ATTRIBUTES].join(', ')}`));
    if (!isSafeSlug(use.assetId)) diagnostics.push(issue(`${current}/assetId`, 'unsafe-id', 'assetId must be a declared stable asset id'));
    if (typeof use.documentId === 'string' && /^(page|template|part|pattern):[a-z0-9][a-z0-9-]*$/.test(use.documentId) && Array.isArray(use.nodePath) && use.nodePath.every((part) => Number.isInteger(part) && part >= 0) && typeof use.attribute === 'string' && ASSET_ATTRIBUTES.has(use.attribute) && isSafeSlug(use.assetId)) {
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
  const blocks: IntentNode[] = [];
  for (let index = 0; index < value.blocks.length; index += 1) {
    const node = validateNode(value.blocks[index], `${pathName}/blocks/${index}`, diagnostics);
    if (node) blocks.push(node);
  }
  return { blocks };
}

function validateNode(value: unknown, pathName: string, diagnostics: SiteInputDiagnostic[]): IntentNode | undefined {
  if (!isRecord(value)) {
    diagnostics.push(issue(pathName, 'object-required', 'intent node must be an object'));
    return undefined;
  }
  checkKeys(value, ['block', 'text', 'url', 'alt', 'level', 'citation', 'items', 'rows', 'attrs', 'children'], pathName, diagnostics);
  if (typeof value.block !== 'string' || value.block.length === 0 || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(value.block)) {
    diagnostics.push(issue(`${pathName}/block`, 'block-required', 'block must be a namespaced block name'));
    return undefined;
  }
  if (value.attrs !== undefined && !isRecord(value.attrs)) diagnostics.push(issue(`${pathName}/attrs`, 'object-required', 'attrs must be an object'));
  if (value.children !== undefined && !Array.isArray(value.children)) diagnostics.push(issue(`${pathName}/children`, 'array-required', 'children must be an array'));
  const children: IntentNode[] | undefined = Array.isArray(value.children)
    ? value.children.map((child, index) => validateNode(child, `${pathName}/children/${index}`, diagnostics)).filter((child): child is IntentNode => child !== undefined)
    : undefined;
  const node: IntentNode = { block: value.block };
  for (const key of ['text', 'url', 'alt', 'citation'] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string') diagnostics.push(issue(`${pathName}/${key}`, 'string-required', `${key} must be a string`));
      else node[key] = value[key];
    }
  }
  if (value.level !== undefined) {
    if (typeof value.level !== 'number' || !Number.isInteger(value.level) || value.level < 1 || value.level > 6) diagnostics.push(issue(`${pathName}/level`, 'invalid-level', 'level must be an integer from 1 to 6'));
    else node.level = value.level;
  }
  if (value.items !== undefined) {
    if (!Array.isArray(value.items) || value.items.some((item) => typeof item !== 'string')) diagnostics.push(issue(`${pathName}/items`, 'string-array-required', 'items must be an array of strings'));
    else node.items = value.items as string[];
  }
  if (value.rows !== undefined) {
    if (!Array.isArray(value.rows) || value.rows.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== 'string'))) diagnostics.push(issue(`${pathName}/rows`, 'string-grid-required', 'rows must be an array of string arrays'));
    else node.rows = value.rows as string[][];
  }
  if (isRecord(value.attrs)) node.attrs = value.attrs;
  if (children !== undefined) node.children = children;
  return node;
}

function collectTrees(
  templates: Record<string, SiteDocumentIntent>,
  parts: Record<string, SiteDocumentIntent>,
  patterns: Record<string, SitePatternIntent>,
  pages: SiteIntent['pages'],
): Map<string, IntentTree> {
  const result = new Map<string, IntentTree>();
  for (const [name, value] of Object.entries(templates)) result.set(`template:${name}`, value.body);
  for (const [name, value] of Object.entries(parts)) result.set(`part:${name}`, value.body);
  for (const [name, value] of Object.entries(patterns)) result.set(`pattern:${name}`, value.body);
  for (const page of pages) result.set(`page:${page.id}`, page.body);
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
      : `/${kind === 'template' ? 'templates' : kind === 'part' ? 'parts' : 'patterns'}/${escapePointer(name!)}/body`;
    const visit = (nodes: IntentNode[], pathParts: number[]): void => {
      nodes.forEach((node, index) => {
        const current = [...pathParts, index];
        if (node.block === 'core/template-part' && typeof node.attrs?.slug === 'string' && !Object.hasOwn(parts, node.attrs.slug)) {
          diagnostics.push(issue(`${basePath}${nodePath(current)}`, 'unknown-template-part', `unknown template part "${node.attrs.slug}"`));
        }
        if (node.block === 'core/pattern' && typeof node.attrs?.slug === 'string' && !Object.values(patterns).some((pattern) => pattern.slug === node.attrs?.slug)) {
          diagnostics.push(issue(`${basePath}${nodePath(current)}`, 'unknown-pattern', `unknown pattern "${node.attrs.slug}"`));
        }
        if (node.children) visit(node.children, current);
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
  let node = tree.blocks[first];
  for (const index of indices.slice(1)) {
    if (!node?.children) return undefined;
    node = node.children[index];
  }
  return node;
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
    return next !== undefined && snapshot.path === next.path && snapshot.dev === next.dev && snapshot.ino === next.ino && snapshot.mode === next.mode && snapshot.size === next.size && snapshot.mtimeMs === next.mtimeMs && snapshot.ctimeMs === next.ctimeMs;
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
