import { createHash } from 'node:crypto';
import path from 'node:path';
import { scanCssUrlReferences } from '../author/assets.js';
import { assertStaticSvg } from '../authoring/svg.js';
import type { PreparedSiteSource, SiteAssetIntent, SiteFile, SiteInputDiagnostic } from './types.js';

const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const SAFE_ASSET_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface SiteThemeAssetsResult {
  files: SiteFile[];
  diagnostics: SiteInputDiagnostic[];
}

/** Validate and materialize only explicitly declared theme-file assets from prepared source bytes. */
export function buildSiteThemeAssets(source: PreparedSiteSource): SiteThemeAssetsResult {
  const diagnostics: SiteInputDiagnostic[] = [];
  const files: SiteFile[] = [];
  const assetsById = new Map(source.sourceIntent.assets.map((asset) => [asset.id, asset]));
  const preparedById = new Map(source.assets.map((asset) => [asset.id, asset]));
  const outputPaths = new Map<string, string>();
  const emittedStylesheets: string[] = [];

  if (assetsById.size !== source.sourceIntent.assets.length || preparedById.size !== source.assets.length) {
    diagnostics.push(issue('/assets', 'duplicate-asset-id', 'site assets must have unique stable ids'));
  }

  for (const [index, declaration] of source.sourceIntent.assets.entries()) {
    const at = `/assets/${index}`;
    if (!SAFE_ASSET_PATH.test(declaration.path)) {
      diagnostics.push(issue(`${at}/path`, 'unsafe-theme-path', 'theme asset paths may contain only letters, numbers, dots, underscores, and hyphens in safe path segments'));
      continue;
    }
    const outputPath = `assets/${declaration.path}`;
    const collisionKey = outputPath.toLowerCase();
    const previous = [...outputPaths.entries()].find(([existing]) => collisionKey === existing || collisionKey.startsWith(`${existing}/`) || existing.startsWith(`${collisionKey}/`));
    if (previous) {
      diagnostics.push(issue(`${at}/path`, 'duplicate-theme-path', `theme asset destination collides with "${previous[1]}"`));
      continue;
    }
    outputPaths.set(collisionKey, declaration.path);

    const prepared = preparedById.get(declaration.id);
    if (!prepared || prepared.path !== declaration.path || prepared.kind !== declaration.kind || prepared.role !== declaration.role) {
      diagnostics.push(issue(at, 'prepared-asset-mismatch', 'prepared bytes do not match the declared site asset'));
      continue;
    }
    const bytes = Buffer.from(prepared.bytes);
    if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
      diagnostics.push(issue(`${at}/path`, 'asset-size', 'asset is empty or exceeds 20 MiB'));
      continue;
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== prepared.sha256) {
      diagnostics.push(issue(`${at}/path`, 'asset-hash', 'prepared asset bytes no longer match their SHA-256'));
      continue;
    }
    const extension = path.posix.extname(declaration.path).toLowerCase();

    if (declaration.role === 'attachment') {
      if (declaration.kind !== 'image') diagnostics.push(issue(`${at}/role`, 'attachment-format', 'attachment assets must be supported image files'));
      if (!isImage(bytes, extension, `${at}/path`, diagnostics)) continue;
      continue;
    }

    if (declaration.kind === 'other') {
      diagnostics.push(issue(`${at}/kind`, 'unsupported-kind', 'other theme assets have no safe supported transport'));
      continue;
    }
    if (declaration.kind === 'image' && !isImage(bytes, extension, `${at}/path`, diagnostics)) continue;
    if (declaration.kind === 'font' && !isFont(bytes, extension)) {
      diagnostics.push(issue(`${at}/path`, 'unsupported-font', 'licensed theme fonts must be valid WOFF or WOFF2 files'));
      continue;
    }
    if (declaration.kind === 'stylesheet') {
      if (extension !== '.css') {
        diagnostics.push(issue(`${at}/path`, 'stylesheet-extension', 'theme stylesheets must use the .css extension'));
        continue;
      }
      const css = decodeUtf8(bytes, `${at}/path`, diagnostics);
      if (css === undefined) continue;
      const rewritten = rewriteStylesheet(css, declaration, assetsById, `${at}/cssUrls`, diagnostics);
      if (rewritten === undefined) continue;
      const cssBytes = Buffer.from(rewritten, 'utf8');
      files.push(siteFile(outputPath, cssBytes));
      emittedStylesheets.push(outputPath);
      continue;
    }
    if (declaration.kind === 'font' && !declaration.fontLicense) {
      diagnostics.push(issue(`${at}/fontLicense`, 'font-license-required', 'theme fonts require explicit ownership and license details'));
      continue;
    }
    files.push(siteFile(outputPath, bytes));
    if (declaration.kind === 'font' && declaration.fontLicense) {
      const noticePath = `${outputPath}.LICENSE.txt`;
      const noticeKey = noticePath.toLowerCase();
      const collision = [...outputPaths.entries()].find(([existing]) => noticeKey === existing || noticeKey.startsWith(`${existing}/`) || existing.startsWith(`${noticeKey}/`));
      if (collision) {
        diagnostics.push(issue(`${at}/fontLicense/notice`, 'duplicate-theme-path', `font notice destination collides with "${collision[1]}"`));
        continue;
      }
      outputPaths.set(noticeKey, noticePath);
      const notice = [
        `Ownership: ${declaration.fontLicense.ownership}`,
        `License: ${declaration.fontLicense.license}`,
        ...(declaration.fontLicense.notice === undefined ? [] : ['', declaration.fontLicense.notice]),
        '',
      ].join('\n');
      files.push(siteFile(`${outputPath}.LICENSE.txt`, Buffer.from(notice, 'utf8')));
    }
  }

  // CSS references are checked against the complete declaration set. A declaration cannot
  // smuggle an undeclared source file into the bundle, and no URL is fetched.
  for (const asset of source.sourceIntent.assets) {
    if (asset.role === 'theme-file' && asset.kind !== 'stylesheet' && asset.cssUrls?.length) {
      diagnostics.push(issue(`/assets/${source.sourceIntent.assets.indexOf(asset)}/cssUrls`, 'css-url-scope', 'only a stylesheet can declare CSS URL uses'));
    }
  }

  if (emittedStylesheets.length > 0) files.push(siteFile('functions.php', Buffer.from(stylesheetBootstrap(emittedStylesheets), 'utf8')));
  return { files: sortFiles(files), diagnostics };
}

/** Re-read the declared source through the same no-symlink boundary and reject changed bytes. */
export async function verifyPreparedSiteAssets(source: PreparedSiteSource): Promise<void> {
  const { prepareSiteSource } = await import('./input.js');
  const refreshed = await prepareSiteSource(source.sourceIntent, source.assetRoot);
  if (!refreshed.ok) throw new Error(`site source assets changed or became unsafe: ${refreshed.diagnostics.map(({ path: at, message }) => `${at}: ${message}`).join('; ')}`);
  if (refreshed.source.sourceIdentity !== source.sourceIdentity) throw new Error('site intent changed after source preparation');
  const current = new Map(refreshed.source.assets.map((asset) => [asset.id, asset]));
  if (current.size !== source.assets.length || source.assets.some((asset) => current.get(asset.id)?.sha256 !== asset.sha256)) {
    throw new Error('site source assets changed after source preparation');
  }
}

export function siteThemeAssetPath(asset: Pick<SiteAssetIntent, 'path'>): string {
  if (!SAFE_ASSET_PATH.test(asset.path)) throw new Error('site asset path is unsafe for theme publication');
  return `assets/${asset.path}`;
}

function rewriteStylesheet(
  css: string,
  stylesheet: SiteAssetIntent,
  assetsById: Map<string, SiteAssetIntent>,
  diagnosticPath: string,
  diagnostics: SiteInputDiagnostic[],
): string | undefined {
  const declarations = stylesheet.cssUrls ?? [];
  const declarationMap = new Map<string, string>();
  for (const [index, declaration] of declarations.entries()) {
    if (declarationMap.has(declaration.url)) {
      diagnostics.push(issue(`${diagnosticPath}/${index}/url`, 'duplicate-css-url', 'a stylesheet cannot declare conflicting CSS URL tokens'));
      continue;
    }
    const target = assetsById.get(declaration.assetId);
    if (!target || target.role !== 'theme-file') {
      diagnostics.push(issue(`${diagnosticPath}/${index}/assetId`, 'theme-file-required', 'CSS references must map to a declared theme-file asset'));
      continue;
    }
    declarationMap.set(declaration.url, target.path);
  }

  let references;
  try { references = scanCssUrlReferences(css, stylesheet.path); }
  catch (error) {
    diagnostics.push(issue(diagnosticPath, 'css-parse', `stylesheet URL scan failed: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
  const referenceCounts = new Map<string, number>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const reference of references) {
    const targetPath = declarationMap.get(reference.url);
    if (!targetPath) {
      diagnostics.push(issue(diagnosticPath, 'undeclared-css-url', `CSS URL "${reference.url}" has no explicit theme asset declaration`));
      continue;
    }
    const target = assetsById.get(declarations.find(({ url }) => url === reference.url)?.assetId ?? '');
    if (!target || (reference.kind === 'font') !== (target.kind === 'font')) {
      diagnostics.push(issue(diagnosticPath, 'css-asset-kind', `CSS URL "${reference.url}" does not map to a compatible declared asset kind`));
      continue;
    }
    referenceCounts.set(reference.url, (referenceCounts.get(reference.url) ?? 0) + 1);
    const from = path.posix.dirname(siteThemeAssetPath(stylesheet));
    const to = siteThemeAssetPath({ path: targetPath });
    const relative = path.posix.relative(from, to);
    replacements.push({ start: reference.start, end: reference.end,
      value: reference.syntax === 'string' ? `${reference.raw[0]}${relative}${reference.raw[0]}` : `url("${relative}")` });
  }
  for (const [index, declaration] of declarations.entries()) {
    if (!referenceCounts.has(declaration.url)) diagnostics.push(issue(`${diagnosticPath}/${index}/url`, 'unused-css-url', `declared CSS URL "${declaration.url}" does not occur in the stylesheet`));
  }
  if (diagnostics.some(({ path: diagnostic }) => diagnostic.startsWith(diagnosticPath))) return undefined;
  let output = css;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

function isImage(bytes: Buffer, extension: string, diagnosticPath: string, diagnostics: SiteInputDiagnostic[]): boolean {
  if (extension === '.svg') {
    try { assertStaticSvg(bytes, diagnosticPath); return true; }
    catch (error) { diagnostics.push(issue(diagnosticPath, 'unsupported-svg', error instanceof Error ? error.message : String(error))); return false; }
  }
  const valid = extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : extension === '.jpg' || extension === '.jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : extension === '.gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))
        : extension === '.webp' ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          : false;
  if (!valid) diagnostics.push(issue(diagnosticPath, 'unsupported-image', 'image bytes do not match a supported PNG, JPEG, GIF, WebP, or static SVG extension'));
  return valid;
}

function isFont(bytes: Buffer, extension: string): boolean {
  const signature = bytes.subarray(0, 4).toString('ascii');
  return (extension === '.woff' && signature === 'wOFF') || (extension === '.woff2' && signature === 'wOF2');
}

function decodeUtf8(bytes: Buffer, diagnosticPath: string, diagnostics: SiteInputDiagnostic[]): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { diagnostics.push(issue(diagnosticPath, 'stylesheet-encoding', 'stylesheet must be valid UTF-8')); return undefined; }
}

function stylesheetBootstrap(stylesheets: string[]): string {
  const editorStyles = stylesheets.map((file) => `    add_editor_style(${phpString(file)});`).join('\n');
  const frontendStyles = stylesheets.map((file, index) => `    wp_enqueue_style('block-runner-site-${index}', get_theme_file_uri(${phpString(file)}), [], null);`).join('\n');
  return `<?php\nadd_action('wp_enqueue_scripts', static function (): void {\n${frontendStyles}\n});\nadd_action('after_setup_theme', static function (): void {\n    add_theme_support('editor-styles');\n${editorStyles}\n});\n`;
}

function phpString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function siteFile(filePath: string, bytes: Buffer): SiteFile {
  return { path: filePath, bytes: new Uint8Array(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function sortFiles(files: SiteFile[]): SiteFile[] {
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function issue(pathName: string, code: string, message: string): SiteInputDiagnostic {
  return { path: pathName || '/', code, message };
}
