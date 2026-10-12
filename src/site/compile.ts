import { createHash } from 'node:crypto';
import { parseMarkup } from '../headless/wp.js';
import { realize } from '../intent/index.js';
import { validateThemeJson } from '../theme/theme-json.js';
import { findThemeReferenceIssues } from '../theme/references.js';
import type { ThemeMarkupFile } from '../theme/folders.js';
import { parseThemeJsonSettings } from '../tokens/resolver.js';
import { canonicalJson } from '../proof/receipt.js';
import type { BlockRunnerConfig, IntentNode, IntentTree, ReportItem, WpBlock } from '../types.js';
import { buildSiteThemeAssets } from './assets.js';
import { bindNativeImage, declaredEmbedAspectRatio } from './media.js';
import { patternOverrideContent } from '../authoring/pattern-overrides.js';
import { compileSyncedPatterns, type CompiledSyncedPattern } from './patterns.js';
import { validateSiteIntent } from './input.js';
import type {
  CompiledSite,
  CompiledSitePage,
  PreparedSiteSource,
  SiteAssetUse,
  SiteAttachmentBinding,
  SiteFile,
  SiteIntent,
  SiteSyncedPatternUse,
  ThemeArtifact,
} from './types.js';

export interface CompileSiteOptions {
  /** WordPress attachment bindings keyed by caller-declared asset ID. */
  attachmentBindings?: Readonly<Record<string, SiteAttachmentBinding>>;
  /** Existing destination wp_block IDs keyed only by caller-declared logical ID. */
  patternBindings?: Readonly<Record<string, number>>;
  /** Absolute public URL of the installed theme directory for explicit theme-file uses. */
  themeAssetBaseUrl?: string;
  strict?: boolean;
}

export type CompileSiteResult =
  | { ok: true; site: CompiledSite; diagnostics: ReportItem[] }
  | { ok: false; diagnostics: ReportItem[] };

export type CompileThemeDocumentsResult =
  | { ok: true; artifact: ThemeArtifact; diagnostics: ReportItem[] }
  | { ok: false; diagnostics: ReportItem[] };

const HARD_REFERENCE_CODES = new Set(['unresolved-template-part', 'unresolved-pattern', 'undeclared-preset']);

interface CompiledDocument {
  id: string;
  kind: 'template' | 'part' | 'pattern' | 'page';
  name: string;
  page?: SiteIntent['pages'][number];
  markup: string;
  report: ReportItem[];
  ok: boolean;
  pendingPatternUses?: SiteSyncedPatternUse[];
}

/** Compile the theme-owned documents while reporting page-owned media bindings as pending. */
export async function compileThemeDocuments(
  source: PreparedSiteSource,
  options: CompileSiteOptions = {},
): Promise<CompileThemeDocumentsResult> {
  const prepared = validatePreparedSource(source);
  if (!prepared.ok) return { ok: false, diagnostics: prepared.diagnostics };

  const intent = prepared.intent;
  const unavailable = unresolvedThemeBindings(intent, options, false);
  if (unavailable.length > 0) return { ok: false, diagnostics: unavailable };

  const compiled = await compileDocuments(source, intent, options, { allowPendingPageBindings: true, includePages: false });
  const diagnostics = [...compiled.diagnostics, ...await themeChecks(intent, compiled.documents)];
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };

  const generatedThemeFiles = emitThemeFiles(intent, compiled.documents, diagnostics);
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };
  const preparedAssets = buildSiteThemeAssets(source);
  diagnostics.push(...assetDiagnostics(preparedAssets.diagnostics, intent.siteId));
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };
  const assets = preparedAssets.files;
  const themeFiles = completeThemeFiles(generatedThemeFiles, assets, diagnostics);
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };
  const inventory = inventoryFiles(themeFiles);
  const targetBindings = usedBindings(intent, options.attachmentBindings, new Set(compiled.documents.filter((document) => document.kind !== 'page').map((document) => document.id)));
  const targetBindingFingerprint = hashTargetContext(targetBindings, options.themeAssetBaseUrl);
  const artifact: ThemeArtifact = {
    sourceIntent: intent,
    sourceAssets: source.assets,
    targetBindings,
    targetBindingFingerprint,
    ...(options.themeAssetBaseUrl !== undefined ? { themeAssetBaseUrl: options.themeAssetBaseUrl } : {}),
    themeFiles,
    pendingPageBindings: intent.assetUses.filter((use) => use.documentId.startsWith('page:')
      && assetRole(intent, use.assetId) === 'attachment'
      && !options.attachmentBindings?.[use.assetId]),
    diagnostics,
    inventory,
    artifactIdentity: hashJson({ sourceIdentity: source.sourceIdentity, sourceAssets: sourceAssetIdentity(source), targetBindingFingerprint, themeFiles: inventory }),
  };
  return { ok: true, artifact, diagnostics };
}

/** Compile one complete, target-bound site using only explicit local input and supplied bindings. */
export async function compileSite(
  source: PreparedSiteSource,
  options: CompileSiteOptions = {},
): Promise<CompileSiteResult> {
  const prepared = validatePreparedSource(source);
  if (!prepared.ok) return { ok: false, diagnostics: prepared.diagnostics };

  const intent = prepared.intent;
  const unavailable = unresolvedThemeBindings(intent, options, true);
  if (unavailable.length > 0) return { ok: false, diagnostics: unavailable };

  const compiled = await compileDocuments(source, intent, options, { allowPendingPageBindings: false, includePages: true });
  const diagnostics = [...compiled.diagnostics, ...await themeChecks(intent, compiled.documents)];
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };

  const generatedThemeFiles = emitThemeFiles(intent, compiled.documents, diagnostics);
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };
  const pages: CompiledSitePage[] = compiled.documents.flatMap((document) => {
    if (!document.page) return [];
    return [{
      id: document.page.id,
      route: document.page.route,
      title: document.page.title,
      ...(document.page.parentId ? { parentId: document.page.parentId } : {}),
      template: document.page.template,
      content: document.markup,
      status: document.page.status ?? 'draft',
      diagnostics: document.report,
    }];
  });
  const preparedAssets = buildSiteThemeAssets(source);
  diagnostics.push(...assetDiagnostics(preparedAssets.diagnostics, intent.siteId));
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };
  const assets = preparedAssets.files;
  const themeFiles = completeThemeFiles(generatedThemeFiles, assets, diagnostics);
  if (hasFailures(diagnostics)) return { ok: false, diagnostics };
  const targetBindings = usedBindings(intent, options.attachmentBindings);
  const targetBindingFingerprint = hashTargetContext(targetBindings, options.themeAssetBaseUrl);
  const inventory = inventoryFiles(themeFiles);
  const site: CompiledSite = {
    sourceIntent: intent,
    sourceAssets: source.assets,
    targetBindings,
    targetBindingFingerprint,
    ...(options.themeAssetBaseUrl !== undefined ? { themeAssetBaseUrl: options.themeAssetBaseUrl } : {}),
    themeFiles,
    pages,
    assets,
    diagnostics,
    inventory,
    artifactIdentity: hashJson({
      sourceIdentity: source.sourceIdentity,
      sourceAssets: sourceAssetIdentity(source),
      targetBindingFingerprint,
      themeFiles: inventory,
      pages: pages.map(({ id, route, title, parentId, template, content, status }) => ({ id, route, title, parentId, template, content, status })),
    }),
  };
  return { ok: true, site, diagnostics };
}

/** Internal adapter seam: finalized pages and source-only previews are separate outcomes. */
export async function compileSitePageDocuments(source: PreparedSiteSource, options: CompileSiteOptions = {}): Promise<{
  ok: boolean;
  pages: CompiledSitePage[];
  pendingPages: Array<{ id: string; body: IntentTree; uses: SiteAssetUse[]; patternUses: SiteSyncedPatternUse[]; diagnostics: ReportItem[] }>;
  diagnostics: ReportItem[];
}> {
  const prepared = validatePreparedSource(source);
  if (!prepared.ok) return { ok: false, pages: [], pendingPages: [], diagnostics: prepared.diagnostics };
  const compiled = await compileDocuments(source, prepared.intent, options, { allowPendingPageBindings: true, includePages: true, previewPendingPages: true });
  const diagnostics = [...compiled.diagnostics, ...await themeChecks(prepared.intent, compiled.documents)];
  const pages: CompiledSitePage[] = [];
  const pendingPages: Array<{ id: string; body: IntentTree; uses: SiteAssetUse[]; patternUses: SiteSyncedPatternUse[]; diagnostics: ReportItem[] }> = [];
  for (const document of compiled.documents) {
    if (!document.page) continue;
    const uses = prepared.intent.assetUses.filter(use=>use.documentId===document.id && assetRole(prepared.intent,use.assetId)==='attachment' && !options.attachmentBindings?.[use.assetId]);
    const patternUses = document.pendingPatternUses ?? [];
    if (uses.length || patternUses.length) pendingPages.push({ id: document.page.id, body: document.page.body, uses, patternUses, diagnostics: document.report });
    else if (document.ok) pages.push({ id:document.page.id, route:document.page.route, title:document.page.title, ...(document.page.parentId ? {parentId:document.page.parentId}:{}), template:document.page.template, status:document.page.status ?? 'draft', content:document.markup, diagnostics:document.report });
  }
  return { ok: !hasFailures(diagnostics), pages, pendingPages, diagnostics };
}

/** Compile owned pattern definitions with the same explicit media binding rules as site documents. */
export async function compileSiteSyncedPatterns(source: PreparedSiteSource, options: CompileSiteOptions = {}): Promise<CompiledSyncedPattern[]> {
  const prepared = validatePreparedSource(source);
  if (!prepared.ok) return [];
  const intent = prepared.intent;
  return compileSyncedPatterns(intent, options.patternBindings, (body, documentId) => {
    const result = bindDocument(body, documentId, intent, source, options, true);
    return result.diagnostics.filter((item): item is ReportItem & { status: 'invalid'; code: string; source: { path: string } } => item.status === 'invalid' && Boolean(item.code && item.source?.path));
  }, (documentId) => intent.assetUses.filter((use) => use.documentId === documentId
    && assetRole(intent, use.assetId) === 'attachment' && !options.attachmentBindings?.[use.assetId]));
}

async function compileDocuments(
  source: PreparedSiteSource,
  intent: SiteIntent,
  options: CompileSiteOptions,
  settings: { allowPendingPageBindings: boolean; includePages: boolean; previewPendingPages?: boolean },
): Promise<{ documents: CompiledDocument[]; diagnostics: ReportItem[] }> {
  const documents = documentInputs(intent).filter((document) => settings.includePages || document.kind !== 'page');
  const diagnostics: ReportItem[] = [];
  const output: CompiledDocument[] = [];
  for (const document of documents) {
    const pending = settings.previewPendingPages && document.kind === 'page'
      ? intent.assetUses.filter(use=>use.documentId===document.id && assetRole(intent,use.assetId)==='attachment' && !options.attachmentBindings?.[use.assetId]) : [];
    const body = structuredClone(document.body);
    const patternUses = intent.syncedPatterns?.uses.filter((use) => use.documentId === document.id) ?? [];
    const pendingPatternUses: SiteSyncedPatternUse[] = [];
    for (const use of patternUses) {
      const node = nodeAtPath(body, use.nodePath);
      if (!node) {
        diagnostics.push(invalid(document.id, 'pattern-use-invalid', 'synced pattern use does not resolve to an intent node', use.nodePath));
        continue;
      }
      const patternId = options.patternBindings?.[use.patternId];
      if (!patternId) {
        if (settings.allowPendingPageBindings && document.kind === 'page') pendingPatternUses.push(use);
        else diagnostics.push(invalid(document.id, 'pattern-binding-required', `synced pattern ${use.patternId} requires an observed destination wp_block ID`, use.nodePath));
        continue;
      }
      node.attrs = { ...(node.attrs ?? {}), ref: patternId, ...(use.content ? { content: patternOverrideContent(use.content) } : {}) };
    }
    const bound = bindDocument(body, document.id, intent, source, options, settings.allowPendingPageBindings);
    diagnostics.push(...bound.diagnostics);
    if (bound.diagnostics.some((item) => item.status === 'invalid')) continue;
    if (pendingPatternUses.length) {
      output.push({ ...document, markup: '', report: [], ok: true, pendingPatternUses });
      continue;
    }
    const embedWarnings = prepareEmbedRatios(body, document.id);

    if (body.blocks.length === 0) {
      output.push({ ...document, markup: '', report: [], ok: true });
      continue;
    }

    const undeclaredMedia: number[][] = [];
    if (settings.previewPendingPages) {
      const visit = (nodes: IntentNode[], parent: number[]): void => nodes.forEach((node,index)=>{
        const at = [...parent,index];
        if ((node.block==='core/image' || node.block==='core/cover') && typeof (node.url ?? node.attrs?.url)==='string' && typeof node.attrs?.id !== 'number' && !pending.some(use=>use.nodePath.join('.')===at.join('.'))) undeclaredMedia.push(at);
        if (node.children) visit(node.children,at);
      });
      visit(body.blocks,[]);
      for (const at of undeclaredMedia) diagnostics.push(invalid(document.id,'undeclared-media-reference','unresolved media must have an explicit pending asset use',at));
    }
    const previewStrict = pending.length ? false : options.strict;
    const report = await realize(JSON.stringify(body), {
      sourcePath: sourceLabel(intent.siteId, document.id),
      resolver: 'noop',
      tokenResolver: 'noop',
      // Intent trees have no source HTML styling pass; use the normal default to avoid a spurious warning.
      styling: 'relaxed',
      strict: previewStrict,
      config: isolatedConfig(intent, previewStrict),
      isolateConfig: true,
    });
    const mapped = [...mapReport(report.items, document.id, sourceLabel(intent.siteId, document.id), body), ...embedWarnings];
    diagnostics.push(...mapped);
    if (pending.length && options.strict && mapped.some(item=>item.status==='warning' && item.code!=='intent-attribute-dropped' && item.reason!=='noop resolver does not resolve media IDs')) diagnostics.push(invalid(document.id,'pending-preview-warning','strict pending preview contains a warning unrelated to declared media'));
    if (!report.ok && !mapped.some((item) => item.status === 'invalid')) {
      diagnostics.push(invalid(document.id, 'document-finalization-failed', 'required document failed finalization; see its warnings for details'));
    }
    const markup = report.output ?? '';
    if (document.kind === 'pattern' && /<\?(?:php\b|=)?/i.test(markup)) {
      diagnostics.push(invalid(document.id, 'pattern-php-body', 'pattern body contains PHP and cannot be emitted as a static pattern'));
    }
    output.push({ ...document, markup, report: mapped, ok: report.ok && !mapped.some((item) => item.status === 'invalid'), ...(pendingPatternUses.length ? { pendingPatternUses } : {}) });
  }

  return { documents: output, diagnostics };
}

function bindDocument(
  body: IntentTree,
  documentId: string,
  intent: SiteIntent,
  source: PreparedSiteSource,
  options: CompileSiteOptions,
  allowPendingPageBindings: boolean,
): { diagnostics: ReportItem[] } {
  const diagnostics: ReportItem[] = [];
  for (const use of intent.assetUses.filter((candidate) => candidate.documentId === documentId)) {
    const asset = source.assets.find((candidate) => candidate.id === use.assetId);
    const node = nodeAtPath(body, use.nodePath);
    if (!asset || !node) {
      diagnostics.push(invalid(documentId, 'asset-use-invalid', `asset use ${use.assetId} does not resolve to a prepared asset and intent node`, use.nodePath));
      continue;
    }
    let url: string;
    let attachment: SiteAttachmentBinding | undefined;
    if (asset.role === 'attachment') {
      attachment = options.attachmentBindings?.[asset.id];
      if (!attachment && allowPendingPageBindings && (documentId.startsWith('page:') || documentId.startsWith('synced-pattern:'))) continue;
      if (!validBinding(attachment)) {
        diagnostics.push(invalid(documentId, 'attachment-binding-required', `asset ${asset.id} requires a supplied attachment ID and URL binding`, use.nodePath));
        continue;
      }
      url = attachment.url;
    } else {
      const base = options.themeAssetBaseUrl;
      if (!base) {
        diagnostics.push(invalid(documentId, 'theme-asset-base-url-required', `theme-file asset ${asset.id} requires themeAssetBaseUrl before it can be used in native markup`, use.nodePath));
        continue;
      }
      try {
        url = publicThemeAssetUrl(base, asset.path);
      } catch (error) {
        diagnostics.push(invalid(documentId, 'theme-asset-base-url-invalid', error instanceof Error ? error.message : String(error), use.nodePath));
        continue;
      }
    }

    const imageBinding = attachment ? bindNativeImage(node, attachment) : undefined;
    if (imageBinding?.error) {
      diagnostics.push(invalid(documentId, 'attachment-image-metadata', imageBinding.error, use.nodePath));
      continue;
    }
    setIntentAttribute(node, use, imageBinding?.url ?? url, attachment);
  }
  return { diagnostics };
}

function setIntentAttribute(node: IntentNode, use: SiteAssetUse, url: string, binding?: SiteAttachmentBinding): void {
  if (use.attribute === 'url') node.url = url;
  else {
    node.attrs ??= {};
    if (use.attribute === 'attrs.url' || use.attribute === 'attrs.src') node.attrs[use.attribute.slice(6)] = url;
  }
  if (binding) {
    node.attrs ??= {};
    node.attrs.id = binding.id;
    if (node.block === 'core/image' || node.block === 'core/cover') {
      node.url = url;
      node.attrs.url = url;
    }
  }
}

function unresolvedThemeBindings(
  intent: SiteIntent,
  options: CompileSiteOptions,
  requirePages: boolean,
): ReportItem[] {
  const diagnostics: ReportItem[] = [];
  for (const use of intent.assetUses) {
    const asset = intent.assets.find((candidate) => candidate.id === use.assetId);
    if (!asset) continue;
    if (asset.role === 'attachment') {
      if (options.attachmentBindings?.[asset.id] || (!requirePages && use.documentId.startsWith('page:'))) continue;
      diagnostics.push(invalid(use.documentId, 'attachment-binding-required', `asset ${asset.id} requires a supplied attachment ID and URL binding`, use.nodePath));
    } else if (!options.themeAssetBaseUrl) {
      diagnostics.push(invalid(use.documentId, 'theme-asset-base-url-required', `theme-file asset ${asset.id} requires themeAssetBaseUrl before it can be used in native markup`, use.nodePath));
    }
  }
  return diagnostics;
}

function isolatedConfig(intent: SiteIntent, strict?: boolean): BlockRunnerConfig {
  const tokens = parseThemeJsonSettings((intent.theme.themeJson.settings ?? {}) as Parameters<typeof parseThemeJsonSettings>[0]);
  return {
    strict: strict ?? false,
    styling: 'strict',
    media: { resolver: 'noop' },
    tokens: { ...tokens, resolver: 'noop', match: 'exact' },
  };
}

function documentInputs(intent: SiteIntent): Array<{
  id: string;
  kind: CompiledDocument['kind'];
  name: string;
  body: IntentTree;
  page?: SiteIntent['pages'][number];
}> {
  return [
    ...Object.entries(intent.templates).map(([name, value]) => ({ id: `template:${name}`, kind: 'template' as const, name, body: value.body })),
    ...Object.entries(intent.parts).map(([name, value]) => ({ id: `part:${name}`, kind: 'part' as const, name, body: value.body })),
    ...Object.entries(intent.patterns).map(([name, value]) => ({ id: `pattern:${name}`, kind: 'pattern' as const, name, body: value.body })),
    ...intent.pages.map((page) => ({ id: `page:${page.id}`, kind: 'page' as const, name: page.id, body: page.body, page })),
  ];
}

async function themeChecks(intent: SiteIntent, documents: CompiledDocument[]): Promise<ReportItem[]> {
  const themeJson = JSON.stringify(intent.theme.themeJson, null, 2);
  const checked = validateThemeJson(themeJson, 'theme.json', 'assemble');
  const diagnostics = [...checked.report.items];
  const files: ThemeMarkupFile[] = documents.map((document) => ({
    path: themeFilePath(document),
    file: themeRelativePath(document),
    // The existing scanner needs only a markup-file kind; pages use a virtual template entry.
    kind: document.kind === 'page' ? 'template' : document.kind,
    content: document.markup,
    markup: document.markup,
    ...(document.kind === 'pattern' ? { header: { raw: '', title: intent.patterns[document.name]?.title, slug: intent.patterns[document.name]?.slug } } : {}),
  }));
  const references = await findThemeReferenceIssues(`/themes/${intent.theme.slug}`, files, intent.theme.themeJson);
  const pageSources = new Map(documents.filter((document) => document.kind === 'page')
    .map((document) => [themeFilePath(document), sourceLabel(intent.siteId, document.id)]));
  diagnostics.push(...references.map((item) => {
    const sourcePath = item.source?.path;
    return {
      ...item,
      ...(sourcePath && pageSources.has(sourcePath) ? { source: { ...item.source, path: pageSources.get(sourcePath)! } } : {}),
      ...(HARD_REFERENCE_CODES.has(item.code ?? '') ? { status: 'invalid' as const } : {}),
    };
  }));
  if (!isSingleLineHeader(intent.theme.title)) {
    diagnostics.push(invalid('theme', 'unsafe-theme-header', 'theme title must be a single-line value safe for the style.css metadata header'));
  }
  for (const page of intent.pages) {
    const template = documents.find((document) => document.id === `template:${page.template}`);
    if (!template || template.markup.length === 0) {
      diagnostics.push(invalid(`template:${page.template}`, 'post-content-required', `template ${page.template} must retain a core/post-content block for page ${page.id}`));
      continue;
    }
    const blocks = await parseMarkup(template.markup);
    if (!containsBlock(blocks, 'core/post-content')) {
      diagnostics.push(invalid(`template:${page.template}`, 'post-content-required', `template ${page.template} must retain a core/post-content block for page ${page.id}`));
    }
  }
  return diagnostics;
}

function emitThemeFiles(intent: SiteIntent, documents: CompiledDocument[], diagnostics: ReportItem[]): SiteFile[] {
  const files: SiteFile[] = [];
  addFile(files, 'style.css', `/*\nTheme Name: ${intent.theme.title}\nText Domain: ${intent.theme.slug}\n*/\n`);
  addFile(files, 'theme.json', `${JSON.stringify(intent.theme.themeJson, null, 2)}\n`);
  for (const document of documents.filter((entry) => entry.kind !== 'page')) {
    if (!document.ok) continue;
    const file = themeRelativePath(document);
    if (document.kind === 'pattern') {
      const pattern = intent.patterns[document.name]!;
      if (!isSingleLineHeader(pattern.title) || !isSafePatternSlug(pattern.slug)) {
        diagnostics.push(invalid(document.id, 'unsafe-pattern-header', 'pattern Title and Slug must be single-line safe values that cannot close a PHP/comment header'));
        continue;
      }
      addFile(files, file, `<?php\n/**\n * Title: ${pattern.title}\n * Slug: ${pattern.slug}\n */\n?>\n${document.markup}`);
    } else {
      addFile(files, file, document.markup);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validatePreparedSource(source: PreparedSiteSource): { ok: true; intent: SiteIntent } | { ok: false; diagnostics: ReportItem[] } {
  const inputDiagnostics: Array<{ path: string; code: string; message: string }> = [];
  const intent = validateSiteIntent(source?.sourceIntent, inputDiagnostics);
  if (!intent) {
    return { ok: false, diagnostics: inputDiagnostics.map((entry) => ({ status: 'invalid', reason: entry.message, source: { path: entry.path }, code: entry.code })) };
  }
  if (!Array.isArray(source?.assets)) {
    return { ok: false, diagnostics: [invalid('site', 'prepared-asset-mismatch', 'prepared asset inventory is missing')] };
  }
  const byId = new Map(source.assets.map((asset) => [asset.id, asset]));
  if (source.assets.length !== intent.assets.length) {
    return { ok: false, diagnostics: [invalid('site', 'prepared-asset-mismatch', 'prepared asset inventory does not match declared source assets')] };
  }
  for (const declaration of intent.assets) {
    const prepared = byId.get(declaration.id);
    if (!prepared || prepared.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(prepared.sha256)
      || createHash('sha256').update(prepared.bytes).digest('hex') !== prepared.sha256
      || prepared.path !== declaration.path || prepared.role !== declaration.role || prepared.kind !== declaration.kind) {
      return { ok: false, diagnostics: [invalid('site', 'prepared-asset-mismatch', `prepared asset ${declaration.id} does not match the declared source asset`)] };
    }
  }
  return { ok: true, intent };
}

function assetDiagnostics(
  entries: Array<{ path: string; code: string; message: string }>,
  siteId: string,
): ReportItem[] {
  return entries.map((entry) => ({
    status: 'invalid',
    code: entry.code,
    reason: entry.message,
    source: { path: `site://${siteId}${entry.path}` },
  }));
}

function inventoryFiles(files: SiteFile[]): Array<{ path: string; sha256: string; size: number }> {
  return files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.bytes.byteLength }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function completeThemeFiles(generated: SiteFile[], assets: SiteFile[], diagnostics: ReportItem[]): SiteFile[] {
  const files = [...generated, ...assets];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) diagnostics.push(invalid('theme', 'duplicate-output-path', `theme output path ${file.path} is declared more than once`));
    seen.add(file.path);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function usedBindings(
  intent: SiteIntent,
  bindings: Readonly<Record<string, SiteAttachmentBinding>> = {},
  documentIds?: Set<string>,
): Record<string, SiteAttachmentBinding> {
  const ids = [...new Set(intent.assetUses.filter((use) => !documentIds || documentIds.has(use.documentId))
    .map((use) => use.assetId).filter((id) => assetRole(intent, id) === 'attachment'))].sort();
  return Object.fromEntries(ids.map((id) => [id, structuredClone(bindings[id]!)]));
}

function sourceAssetIdentity(source: PreparedSiteSource): Array<{ id: string; path: string; sha256: string }> {
  return source.assets.map(({ id, path, sha256 }) => ({ id, path, sha256 })).sort((left, right) => left.id.localeCompare(right.id));
}

function assetRole(intent: SiteIntent, id: string): SiteIntent['assets'][number]['role'] | undefined {
  return intent.assets.find((asset) => asset.id === id)?.role;
}

function validBinding(binding: SiteAttachmentBinding | undefined): binding is SiteAttachmentBinding {
  if (!binding || !Number.isSafeInteger(binding.id) || binding.id < 1 || typeof binding.url !== 'string') return false;
  try {
    const url = new URL(binding.url);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function publicThemeAssetUrl(baseUrl: string, relativePath: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('themeAssetBaseUrl must be an HTTP(S) URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const encodedPath = relativePath.split('/').map((part) => encodeURIComponent(part)).join('/');
  return new URL(`assets/${encodedPath}`, base).toString();
}

function nodeAtPath(tree: IntentTree, path: number[]): IntentNode | undefined {
  let nodes = tree.blocks;
  let node: IntentNode | undefined;
  for (const index of path) {
    node = nodes[index];
    if (!node) return undefined;
    nodes = node.children ?? [];
  }
  return node;
}

function prepareEmbedRatios(tree: IntentTree, documentId: string): ReportItem[] {
  const warnings: ReportItem[] = [];
  const visit = (nodes: IntentNode[], parent: number[]): void => nodes.forEach((node, index) => {
    const at = [...parent, index];
    if (node.block === 'core/embed') {
      const ratio = declaredEmbedAspectRatio(node);
      if (ratio) node.attrs!.aspectRatio = ratio;
      else warnings.push({ status: 'warning', block: node.block,
        reason: 'embed has no valid caller-declared aspect ratio; remote oEmbed metadata is not queried',
        source: { path: `site://${documentId}` }, details: { documentId, nodePath: at } });
    }
    if (node.children) visit(node.children, at);
  });
  visit(tree.blocks, []);
  return warnings;
}

function mapReport(items: ReportItem[], documentId: string, sourcePath: string, _body: IntentTree): ReportItem[] {
  return items.map((item) => {
    const path = parseIntentPath(item.details);
    return {
      ...item,
      source: { ...item.source, path: sourcePath },
      ...(path ? { details: { ...(isRecord(item.details) ? item.details : {}), documentId, nodePath: path } } : { details: { ...(isRecord(item.details) ? item.details : {}), documentId } }),
    };
  });
}

function parseIntentPath(details: unknown): number[] | undefined {
  if (!isRecord(details) || typeof details.intentPath !== 'string') return undefined;
  const matches = [...details.intentPath.matchAll(/(?:blocks|children)\[(\d+)\]/g)];
  if (matches.length === 0) return undefined;
  return matches.map((match) => Number(match[1]));
}

function themeRelativePath(document: Pick<CompiledDocument, 'kind' | 'name'>): string {
  switch (document.kind) {
    case 'template': return `templates/${document.name}.html`;
    case 'part': return `parts/${document.name}.html`;
    case 'pattern': return `patterns/${document.name}.php`;
    case 'page': return `pages/${document.name}.html`;
  }
}

function themeFilePath(document: Pick<CompiledDocument, 'kind' | 'name'>): string {
  return `/themes/${themeRelativePath(document)}`;
}

function addFile(files: SiteFile[], filePath: string, content: string): void {
  const bytes = new TextEncoder().encode(content);
  files.push({ path: filePath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
}

function invalid(documentId: string, code: string, reason: string, nodePath?: number[]): ReportItem {
  return {
    status: 'invalid',
    code,
    reason,
    source: { path: `site://${documentId}` },
    ...(nodePath ? { details: { documentId, nodePath } } : { details: { documentId } }),
  };
}

function sourceLabel(siteId: string, documentId: string): string {
  return `site://${siteId}/${documentId}`;
}

function containsBlock(blocks: WpBlock[], name: string): boolean {
  return blocks.some((block) => block.name === name || containsBlock(block.innerBlocks ?? [], name));
}

function hasFailures(items: ReportItem[]): boolean {
  return items.some((item) => item.status === 'invalid');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function hashTargetContext(bindings: Record<string, SiteAttachmentBinding>, themeAssetBaseUrl?: string): string {
  return createHash('sha256').update(canonicalJson({
    attachmentBindings: bindings,
    ...(themeAssetBaseUrl !== undefined ? { themeAssetBaseUrl } : {}),
  })).digest('hex');
}

function isSingleLineHeader(value: string): boolean {
  return value.trim().length > 0 && !/[\r\n\u0000]/.test(value) && !/\*\//.test(value) && !/<\?/i.test(value);
}

function isSafePatternSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value) && !/[\r\n\u0000*?]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
