import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The only outcomes an authored CSS asset can have in a generated bundle. */
export type AssetOutcome = 'copied' | 'external' | 'unresolved' | 'blocked';

/** The use is deliberately descriptive; it never implies a WordPress attachment ID. */
export type CssAssetKind = 'asset' | 'font';

export interface CssAssetLocation {
  /** The supplied CSS source path, when one was available. */
  path?: string;
  /** Zero-based offset in `sourceCss`. */
  offset: number;
  /** One-based line and column, useful for a conversion report. */
  line: number;
  column: number;
}

/**
 * A literal `url(...)` reference found in CSS. `start`/`end` delimit the complete function,
 * whereas `url` is the unquoted, CSS-unescaped reference inside it.
 */
export interface CssUrlReference {
  raw: string;
  url: string;
  start: number;
  end: number;
  location: CssAssetLocation;
  kind: CssAssetKind;
  /** `url` is a CSS url() function; `string` is a direct image-set() source string. */
  syntax?: 'url' | 'string';
}

/** One explicit ledger entry for one authored `url(...)` reference. */
export interface CssAssetLedgerEntry extends CssUrlReference {
  outcome: AssetOutcome;
  reason: string;
  /** The filesystem source used for a copied asset. Never set for a remote asset. */
  sourceAssetPath?: string;
  /** The copied destination. Never set for an unresolved, external, or blocked asset. */
  destinationAssetPath?: string;
  /** The URL substituted into the returned CSS. Omitted when the source CSS is left untouched. */
  rewrittenUrl?: string;
}

/**
 * Inputs for CSS asset processing. `sourcePath` names the authored stylesheet (or the HTML file
 * containing an inline stylesheet); relative URLs are resolved from its directory. The result CSS
 * is intended to live beside `destinationAssetDir`, so the default rewritten URLs are
 * `./<assets-dir-name>/<hashed-file>`.
 */
export interface RewriteCssAssetsOptions {
  sourcePath?: string;
  /**
   * Boundary for relative local URLs. Defaults to the directory containing `sourcePath`; a CSS
   * reference may name a file below this directory, but never a parent or sibling. Supplying an
   * asset root is useful when a stylesheet lives in a nested `css/` directory beside `assets/`.
   */
  assetRoot?: string;
  sourceCss: string;
  destinationAssetDir: string;
  /**
   * Public URL prefix for copied files, for example `/wp-content/blocks/acme/assets/`.
   * Defaults to `./<basename(destinationAssetDir)>/`.
   */
  assetUrlPrefix?: string;
  /**
   * A caller must make this affirmative licensing decision before a local or remote font URL is
   * carried forward. This module deliberately does not infer font redistribution rights.
   */
  allowFontLicense?: boolean;
}

export interface RewriteCssAssetsResult {
  /** CSS with only successfully copied local references rewritten. */
  css: string;
  /** Alias for consumers that prefer an explicit result name. */
  rewrittenCss: string;
  /** A complete, one-entry-per-`url()` asset ledger. */
  assets: CssAssetLedgerEntry[];
  /** Alias for `assets`, to make the accounting purpose clear at call sites. */
  ledger: CssAssetLedgerEntry[];
}

interface AssetClassification {
  outcome: Exclude<AssetOutcome, 'copied'>;
  reason: string;
  localPath?: string;
  suffix?: string;
}

const FONT_EXTENSIONS = new Set(['.eot', '.otf', '.ttf', '.woff', '.woff2']);
const DANGEROUS_SCHEMES = new Set(['javascript', 'vbscript']);

/**
 * Find literal CSS `url(...)` functions without treating strings and comments as references.
 * This is a lexer, not a CSS formatter: the original CSS is retained byte-for-byte unless a local
 * asset is successfully copied and needs its URL rewritten.
 */
export function scanCssUrlReferences(sourceCss: string, sourcePath?: string): CssUrlReference[] {
  const ranges = fontFaceRanges(sourceCss);
  const references: CssUrlReference[] = [];

  let index = 0;
  while (index < sourceCss.length) {
    if (startsComment(sourceCss, index)) {
      index = skipComment(sourceCss, index + 2);
      continue;
    }
    if (isQuote(sourceCss[index])) {
      index = skipQuoted(sourceCss, index);
      continue;
    }

    if (isImageSetFunctionAt(sourceCss, index)) {
      const parsed = parseUrlFunction(sourceCss, index);
      if (parsed) {
        references.push(
          ...imageSetStringReferences(sourceCss, parsed.valueStart, parsed.end - 1, sourcePath, ranges),
        );
      }
      // Do not skip the function: a later pass through its body still finds `url(...)` candidates
      // (which have different syntax and replacement boundaries than direct image-set strings).
      index += 1;
      continue;
    }

    if (!isUrlFunctionAt(sourceCss, index)) {
      index += 1;
      continue;
    }

    const parsed = parseUrlFunction(sourceCss, index);
    if (!parsed) {
      // A malformed url( is not safe to reinterpret as a file reference. Keep looking after the
      // token so a later, valid URL still gets a ledger entry.
      index += 3;
      continue;
    }

    references.push({
      raw: sourceCss.slice(index, parsed.end),
      url: unescapeCssUrl(parsed.value.trim()),
      start: index,
      end: parsed.end,
      location: locationAt(sourceCss, index, sourcePath),
      kind: ranges.some((range) => index >= range.start && index < range.end) || isFontUrl(parsed.value)
        ? 'font'
        : 'asset',
      syntax: 'url',
    });
    index = parsed.end;
  }

  return references;
}

/**
 * Pure classification for a CSS reference. Local files remain `unresolved` here because copying
 * is intentionally the responsibility of `rewriteCssAssets`; nothing is fetched or written by
 * classification alone.
 */
export function classifyCssUrlReference(
  reference: CssUrlReference,
  options: Pick<RewriteCssAssetsOptions, 'sourcePath' | 'assetRoot' | 'allowFontLicense'>,
): CssAssetLedgerEntry {
  const classified = classify(reference, options);
  return {
    ...reference,
    outcome: classified.outcome,
    reason: classified.reason,
    ...(classified.localPath ? { sourceAssetPath: classified.localPath } : {}),
  };
}

/**
 * Copy safe local URL targets to `destinationAssetDir` and replace exactly those `url(...)`
 * tokens in the returned CSS. HTTP(S) and protocol-relative URLs are deliberately never fetched;
 * they are ledgered as external and left as authored.
 */
export async function rewriteCssAssets(options: RewriteCssAssetsOptions): Promise<RewriteCssAssetsResult> {
  const references = scanCssUrlReferences(options.sourceCss, options.sourcePath);
  const prefix = publicPrefix(options.destinationAssetDir, options.assetUrlPrefix);
  const copied = new Map<string, { destinationAssetPath: string; rewrittenUrl: string }>();
  const ledger: CssAssetLedgerEntry[] = [];

  for (const reference of references) {
    const classified = classify(reference, options);
    if (!classified.localPath) {
      ledger.push({ ...reference, outcome: classified.outcome, reason: classified.reason });
      continue;
    }

    const reused = copied.get(classified.localPath);
    if (reused) {
      ledger.push({
        ...reference,
        outcome: 'copied',
        reason: 'local asset copied to destination assets directory',
        sourceAssetPath: classified.localPath,
        destinationAssetPath: reused.destinationAssetPath,
        rewrittenUrl: `${reused.rewrittenUrl}${classified.suffix ?? ''}`,
      });
      continue;
    }

    const result = await copyLocalAsset(
      classified.localPath,
      options.destinationAssetDir,
      prefix,
      path.resolve(options.assetRoot ?? sourceDirectoryFor(options.sourcePath)!),
    );
    if ('reason' in result) {
      ledger.push({
        ...reference,
        outcome: result.outcome,
        reason: result.reason,
        sourceAssetPath: classified.localPath,
      });
      continue;
    }

    copied.set(classified.localPath, result);
    ledger.push({
      ...reference,
      outcome: 'copied',
      reason: 'local asset copied to destination assets directory',
      sourceAssetPath: classified.localPath,
      destinationAssetPath: result.destinationAssetPath,
      rewrittenUrl: `${result.rewrittenUrl}${classified.suffix ?? ''}`,
    });
  }

  const css = rewriteReferences(options.sourceCss, ledger);
  return { css, rewrittenCss: css, assets: ledger, ledger };
}

/** Compatibility-friendly spelling for callers that describe this as processing rather than rewriting. */
export const processCssAssets = rewriteCssAssets;

function classify(
  reference: CssUrlReference,
  options: Pick<RewriteCssAssetsOptions, 'sourcePath' | 'assetRoot' | 'allowFontLicense'>,
): AssetClassification {
  const value = reference.url.trim();
  const compact = stripUrlControls(value);
  const scheme = schemeOf(compact);

  if (!compact) {
    return { outcome: 'blocked', reason: 'empty CSS url() reference is not an asset' };
  }
  if (DANGEROUS_SCHEMES.has(scheme ?? '')) {
    return { outcome: 'blocked', reason: `unsafe CSS URL scheme "${scheme}:"` };
  }
  // These have no local file to copy. Keeping their literal values is safe and avoids inventing a
  // filesystem/media identity for inline data or a same-document fragment.
  if (compact.startsWith('#') || /^data:/i.test(compact)) {
    return { outcome: 'external', reason: 'inline or fragment CSS URL left unchanged' };
  }
  if (reference.kind === 'font' && options.allowFontLicense !== true) {
    return { outcome: 'unresolved', reason: 'font asset requires explicit font-license approval' };
  }
  if (/^https?:\/\//i.test(compact) || compact.startsWith('//') || /^blob:/i.test(compact)) {
    return { outcome: 'external', reason: 'external CSS URL left unchanged; remote fetching is disabled' };
  }
  if (scheme === 'file') {
    return { outcome: 'blocked', reason: 'file: CSS URLs are not allowed for asset copying' };
  }
  if (scheme) {
    return { outcome: 'blocked', reason: `unsupported CSS URL scheme "${scheme}:"` };
  }
  if (isRootRelative(compact)) {
    return { outcome: 'external', reason: 'root-relative CSS URL left unchanged' };
  }
  if (/^(?:var|env)\s*\(/i.test(compact)) {
    return { outcome: 'unresolved', reason: 'dynamic CSS URL cannot be resolved to a local asset' };
  }

  const sourceDirectory = sourceDirectoryFor(options.sourcePath);
  if (!sourceDirectory) {
    return { outcome: 'unresolved', reason: 'local CSS URL needs a sourcePath to resolve safely' };
  }
  const assetRoot = path.resolve(options.assetRoot ?? sourceDirectory);

  const { pathname, suffix } = splitSuffix(compact);
  if (!pathname) {
    return { outcome: 'external', reason: 'query-only CSS URL left unchanged' };
  }
  if (pathname.includes('\0')) {
    return { outcome: 'blocked', reason: 'CSS URL contains a null character' };
  }

  const localPath = path.resolve(sourceDirectory, pathname);
  if (!isWithin(assetRoot, localPath)) {
    return {
      outcome: 'blocked',
      reason: 'relative CSS URL escapes the allowed asset root',
    };
  }

  return {
    outcome: 'unresolved',
    reason: 'local CSS URL awaits copying',
    localPath,
    suffix,
  };
}

async function copyLocalAsset(
  sourceAssetPath: string,
  destinationAssetDir: string,
  prefix: string,
  allowedRoot: string,
): Promise<
  | { destinationAssetPath: string; rewrittenUrl: string }
  | { outcome: 'unresolved' | 'blocked'; reason: string }
> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(sourceAssetPath);
  } catch {
    return { outcome: 'unresolved', reason: 'local CSS asset file was not found' };
  }
  if (info.isSymbolicLink()) {
    return { outcome: 'blocked', reason: 'symbolic-link CSS assets are not copied' };
  }
  if (!info.isFile()) {
    return { outcome: 'unresolved', reason: 'local CSS asset is not a regular file' };
  }

  // A lexical `..` check is not enough: a directory *inside* the asset root can itself be a
  // symlink. Resolve both ends after lstat and keep the final target inside the declared root.
  try {
    const [realRoot, realAsset] = await Promise.all([realpath(allowedRoot), realpath(sourceAssetPath)]);
    if (!isWithin(realRoot, realAsset)) {
      return { outcome: 'blocked', reason: 'CSS asset resolves outside the allowed asset root' };
    }
  } catch {
    return { outcome: 'unresolved', reason: 'could not resolve local CSS asset safely' };
  }

  try {
    const bytes = await readFile(sourceAssetPath);
    const filename = copiedFilename(sourceAssetPath, bytes);
    const destinationAssetPath = path.resolve(destinationAssetDir, filename);
    await mkdir(path.dirname(destinationAssetPath), { recursive: true });
    try {
      await writeFile(destinationAssetPath, bytes, { flag: 'wx' });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      // A content-addressed filename should name identical bytes. Verify before treating an
      // existing file as reusable; never overwrite a user-owned asset on a hash collision.
      const existing = await readFile(destinationAssetPath);
      if (!existing.equals(bytes)) {
        return { outcome: 'blocked', reason: 'destination asset filename collision; existing file was not overwritten' };
      }
    }
    return { destinationAssetPath, rewrittenUrl: `${prefix}${encodeURIComponent(filename)}` };
  } catch (error) {
    return {
      outcome: 'unresolved',
      reason: `could not copy local CSS asset: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function rewriteReferences(sourceCss: string, entries: CssAssetLedgerEntry[]): string {
  // Rewrite from the tail so an earlier source offset is never disturbed by a later replacement.
  const replacements = entries.filter((entry) => entry.outcome === 'copied' && entry.rewrittenUrl);
  let output = sourceCss;
  for (const entry of [...replacements].sort((first, second) => second.start - first.start)) {
    const replacement = entry.syntax === 'string' ? renderString(entry.rewrittenUrl!) : renderUrl(entry.rewrittenUrl!);
    output = `${output.slice(0, entry.start)}${replacement}${output.slice(entry.end)}`;
  }
  return output;
}

function renderUrl(url: string): string {
  // A quoted URL is valid for every copied filename/prefix and cannot be confused with CSS syntax.
  return `url("${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

function renderString(url: string): string {
  return `"${url.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function copiedFilename(sourceAssetPath: string, bytes: Buffer): string {
  const parsed = path.parse(path.basename(sourceAssetPath));
  const base = safeFilenamePart(parsed.name || 'asset');
  const extension = safeFilenamePart(parsed.ext).replace(/^\.+/, '');
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return `${base}-${digest}${extension ? `.${extension}` : ''}`;
}

function safeFilenamePart(value: string): string {
  const safe = value.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'asset';
}

function publicPrefix(destinationAssetDir: string, configured?: string): string {
  const value = configured ?? `./${path.basename(path.resolve(destinationAssetDir))}/`;
  return value.endsWith('/') ? value : `${value}/`;
}

function sourceDirectoryFor(sourcePath: string | undefined): string | undefined {
  if (!sourcePath || sourcePath === '-' || /^<.*>$/.test(sourcePath)) {
    return undefined;
  }
  return path.dirname(path.resolve(sourcePath));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function splitSuffix(value: string): { pathname: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index === -1 ? { pathname: value, suffix: '' } : { pathname: value.slice(0, index), suffix: value.slice(index) };
}

function isFontUrl(value: string): boolean {
  const { pathname } = splitSuffix(value.trim().toLowerCase());
  return FONT_EXTENSIONS.has(path.extname(pathname));
}

function isRootRelative(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
}

function schemeOf(value: string): string | undefined {
  return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
}

function stripUrlControls(value: string): string {
  return [...value].filter((char) => {
    const code = char.codePointAt(0)!;
    return code > 0x20 && code !== 0x7f;
  }).join('');
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function startsComment(css: string, index: number): boolean {
  return css[index] === '/' && css[index + 1] === '*';
}

function skipComment(css: string, index: number): number {
  const end = css.indexOf('*/', index);
  return end === -1 ? css.length : end + 2;
}

function isQuote(value: string | undefined): value is '"' | "'" {
  return value === '"' || value === "'";
}

function skipQuoted(css: string, start: number): number {
  const quote = css[start];
  let index = start + 1;
  while (index < css.length) {
    if (css[index] === '\\') {
      index += 2;
      continue;
    }
    if (css[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return css.length;
}

function isUrlFunctionAt(css: string, index: number): boolean {
  if (css.slice(index, index + 3).toLowerCase() !== 'url') {
    return false;
  }
  const previous = css[index - 1];
  if (previous && /[-_A-Za-z0-9]/.test(previous)) {
    return false;
  }
  let cursor = index + 3;
  while (/\s/.test(css[cursor] ?? '')) {
    cursor += 1;
  }
  return css[cursor] === '(';
}

function isImageSetFunctionAt(css: string, index: number): boolean {
  const match = /^(?:-webkit-)?image-set\b/i.exec(css.slice(index));
  if (!match) return false;
  const previous = css[index - 1];
  if (previous && /[-_A-Za-z0-9]/.test(previous)) return false;
  let cursor = index + match[0].length;
  while (/\s/.test(css[cursor] ?? '')) cursor += 1;
  return css[cursor] === '(';
}

function parseUrlFunction(css: string, start: number): { value: string; valueStart: number; end: number } | undefined {
  const name = /^(?:url|(?:-webkit-)?image-set)\b/i.exec(css.slice(start))?.[0];
  if (!name) return undefined;
  let open = start + name.length;
  while (/\s/.test(css[open] ?? '')) {
    open += 1;
  }
  if (/image-set$/i.test(name)) {
    return parseBalancedFunction(css, open);
  }
  let cursor = open + 1;
  while (/\s/.test(css[cursor] ?? '')) {
    cursor += 1;
  }

  if (isQuote(css[cursor])) {
    const quote = css[cursor];
    const valueStart = cursor + 1;
    cursor = valueStart;
    while (cursor < css.length) {
      if (css[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (css[cursor] === quote) {
        const value = css.slice(valueStart, cursor);
        cursor += 1;
        while (/\s/.test(css[cursor] ?? '')) {
          cursor += 1;
        }
        return css[cursor] === ')' ? { value, valueStart, end: cursor + 1 } : undefined;
      }
      cursor += 1;
    }
    return undefined;
  }

  const valueStart = cursor;
  let depth = 1;
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (startsComment(css, cursor)) {
      cursor = skipComment(css, cursor + 2);
      continue;
    }
    if (isQuote(css[cursor])) {
      cursor = skipQuoted(css, cursor);
      continue;
    }
    if (css[cursor] === '(') {
      depth += 1;
    } else if (css[cursor] === ')') {
      depth -= 1;
      if (depth === 0) {
        return { value: css.slice(valueStart, cursor), valueStart, end: cursor + 1 };
      }
    }
    cursor += 1;
  }
  return undefined;
}

function parseBalancedFunction(css: string, open: number): { value: string; valueStart: number; end: number } | undefined {
  if (css[open] !== '(') return undefined;
  const valueStart = open + 1;
  let cursor = valueStart;
  let depth = 1;
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (startsComment(css, cursor)) {
      cursor = skipComment(css, cursor + 2);
      continue;
    }
    if (isQuote(css[cursor])) {
      cursor = skipQuoted(css, cursor);
      continue;
    }
    if (css[cursor] === '(') depth += 1;
    if (css[cursor] === ')') {
      depth -= 1;
      if (depth === 0) {
        return { value: css.slice(valueStart, cursor), valueStart, end: cursor + 1 };
      }
    }
    cursor += 1;
  }
  return undefined;
}

function imageSetStringReferences(
  css: string,
  start: number,
  end: number,
  sourcePath: string | undefined,
  fontRanges: Array<{ start: number; end: number }>,
): CssUrlReference[] {
  const references: CssUrlReference[] = [];
  let index = start;
  while (index < end) {
    if (!isQuote(css[index])) {
      index += 1;
      continue;
    }
    const quote = css[index];
    const valueStart = index + 1;
    let cursor = valueStart;
    while (cursor < end) {
      if (css[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (css[cursor] === quote) break;
      cursor += 1;
    }
    if (cursor >= end) break;

    // A quoted `url("...")` candidate is accounted for by the ordinary url() scanner. Only
    // image-set's direct string grammar needs this additional reference type.
    const before = css.slice(Math.max(start, index - 12), index);
    if (!/url\(\s*$/i.test(before)) {
      const value = unescapeCssUrl(css.slice(valueStart, cursor).trim());
      references.push({
        raw: css.slice(index, cursor + 1),
        url: value,
        start: index,
        end: cursor + 1,
        location: locationAt(css, index, sourcePath),
        kind: fontRanges.some((range) => index >= range.start && index < range.end) || isFontUrl(value) ? 'font' : 'asset',
        syntax: 'string',
      });
    }
    index = cursor + 1;
  }
  return references;
}

function unescapeCssUrl(value: string): string {
  return value.replace(/\\([0-9A-Fa-f]{1,6}[ \t\r\n\f]?|.)/g, (_, escaped: string) => {
    const hexadecimal = /^([0-9A-Fa-f]{1,6})/.exec(escaped)?.[1];
    if (!hexadecimal) {
      return escaped;
    }
    const codePoint = Number.parseInt(hexadecimal, 16);
    return codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
  });
}

function locationAt(css: string, offset: number, sourcePath?: string): CssAssetLocation {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (css[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { path: sourcePath, offset, line, column };
}

function fontFaceRanges(css: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const expression = /@font-face\b/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    let cursor = match.index + match[0].length;
    while (cursor < css.length && css[cursor] !== '{') {
      if (startsComment(css, cursor)) {
        cursor = skipComment(css, cursor + 2);
      } else if (isQuote(css[cursor])) {
        cursor = skipQuoted(css, cursor);
      } else {
        cursor += 1;
      }
    }
    if (css[cursor] !== '{') {
      continue;
    }
    const start = cursor + 1;
    let depth = 1;
    cursor += 1;
    while (cursor < css.length && depth > 0) {
      if (startsComment(css, cursor)) {
        cursor = skipComment(css, cursor + 2);
      } else if (isQuote(css[cursor])) {
        cursor = skipQuoted(css, cursor);
      } else {
        if (css[cursor] === '{') depth += 1;
        if (css[cursor] === '}') depth -= 1;
        cursor += 1;
      }
    }
    ranges.push({ start, end: cursor });
  }
  return ranges;
}
