import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The only outcomes an authored CSS asset can have in a generated bundle. */
export type AssetOutcome = 'prepared' | 'copied' | 'external' | 'unresolved' | 'blocked';

export interface PreparedCssAsset {
  source: string;
  destination: string;
  content: Buffer;
  sha256: string;
  /** The source URL's transport class.  A font is never treated as an image/media asset. */
  kind: CssAssetKind;
}

/** The use is deliberately descriptive; it never implies a WordPress attachment ID. */
export type CssAssetKind = 'asset' | 'font';

/**
 * The minimum affirmative decision needed to redistribute a font in a generated block.
 *
 * A boolean such as `allowFontLicense: true` cannot establish which file was reviewed or who
 * owns its redistribution rights.  The reference, exact source path, and byte hash bind the
 * decision to one concrete file; `ownership` and `license` make the human decision auditable.
 */
export interface FontLicenseDecision {
  /** Exact CSS URL spelling this decision covers (before any package-relative rewrite). */
  reference: string;
  /** Exact local file that was reviewed, normally an absolute path below the source root. */
  source: string;
  /** SHA-256 of the reviewed file bytes. */
  sha256: string;
  /** Human-readable rights-holder or ownership decision; it is intentionally not inferred. */
  ownership: string;
  /** SPDX identifier, license URL, or other human-readable license record. */
  license: string;
  /** Optional supplied redistribution notice, copied into the generated source record verbatim after safe escaping. */
  notice?: string;
}

/** A conservative stack used when a source font cannot legally be carried into the package. */
export const SAFE_FONT_FALLBACK_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' as const;

export interface FontAssetWarning {
  reference?: string;
  family?: string;
  reason: string;
  source?: CssAssetLocation;
}

export interface FontFaceRecord {
  /** The face's declared family names, normalized for matching but not emitted as CSS. */
  families: string[];
  /** Every concrete URL in the face's `src` descriptor. */
  sourceUrls: string[];
  /** Byte offsets of the complete at-rule in the supplied stylesheet. */
  start: number;
  end: number;
  source?: CssAssetLocation;
}

export interface FontFallbackOptions {
  /** Families whose redistribution decision has already been confirmed. */
  licensedFamilies?: readonly string[];
  /** Families known to exist in the destination theme; this never approves a source @font-face. */
  destinationFamilies?: readonly string[];
  /** Override only when a destination explicitly supplies an equivalent safe stack. */
  fallbackStack?: string;
  sourcePath?: string;
}

export interface FontFallbackResult {
  /** CSS with unlicensed @font-face blocks removed and affected declarations made safe. */
  css: string;
  rewrittenCss: string;
  warnings: FontAssetWarning[];
  removedFamilies: string[];
  rewrittenDeclarations: number;
}

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
  /** Collect bytes without touching the destination; the owner writes only after confirmation. */
  prepareAsset?: (asset: PreparedCssAsset) => void;
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
   * Legacy switch retained for source compatibility. It is deliberately insufficient on its own:
   * fontLicenses must identify the exact local file and ownership decision.
   */
  /** @deprecated Use fontLicenses with a reference, source, hash, ownership, and license. */
  allowFontLicense?: boolean;
  /** Explicit, reference-bound local font decisions. Remote/data fonts can never be authorized. */
  fontLicenses?: readonly FontLicenseDecision[];
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
  /** Font references that were not copied because no complete licensed-file decision was supplied. */
  warnings: FontAssetWarning[];
}

interface AssetClassification {
  outcome: Exclude<AssetOutcome, 'copied' | 'prepared'>;
  reason: string;
  localPath?: string;
  suffix?: string;
  fontLicense?: FontLicenseDecision;
}

const FONT_EXTENSIONS = new Set(['.eot', '.otf', '.ttf', '.woff', '.woff2']);
const DANGEROUS_SCHEMES = new Set(['javascript', 'vbscript']);

/**
 * Find literal CSS `url(...)` functions without treating strings and comments as references.
 * This is a lexer, not a CSS formatter: the original CSS is retained byte-for-byte unless a local
 * asset is successfully copied and needs its URL rewritten.
 */
export function scanCssUrlReferences(sourceCss: string, sourcePath?: string): CssUrlReference[] {
  const ranges = fontFaceBlocks(sourceCss).map(({ bodyStart, bodyEnd }) => ({ start: bodyStart, end: bodyEnd }));
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
 * Return the small amount of @font-face metadata the 0.9 authoring seam needs. This is not a font
 * parser: descriptors are retained as source CSS, while family names and concrete URL sources are
 * extracted so the caller can make an explicit ownership decision.
 */
export function scanFontFaces(sourceCss: string, sourcePath?: string): FontFaceRecord[] {
  return fontFaceBlocks(sourceCss).map((block) => {
    const declarations = parseDeclarationSegments(sourceCss, block.bodyStart, block.bodyEnd);
    const family = declarations.find((declaration) => declaration.property === 'font-family');
    const source = declarations.find((declaration) => declaration.property === 'src');
    return {
      families: family ? parseFamilyList(family.value) : [],
      sourceUrls: source
        ? scanCssUrlReferences(source.value, sourcePath).map((reference) => reference.url)
        : [],
      start: block.start,
      end: block.end,
      source: locationAt(sourceCss, block.start, sourcePath),
    };
  });
}

/**
 * Remove unlicensed font faces and make declarations that named those fonts safe. Existing system
 * and destination-approved fallbacks are kept verbatim where possible; a deterministic system
 * stack is used only when no safe family remains. The returned warnings are intentionally tied to
 * the source range so an agent can ask for the missing license decision instead of hiding a visual
 * change behind a successful package.
 */
export function fallbackUnlicensedFonts(
  sourceCss: string,
  options: FontFallbackOptions = {},
): FontFallbackResult {
  const fallbackStack = safeFallbackStack(options.fallbackStack);
  const licensedFamilies = new Set((options.licensedFamilies ?? []).map(normalizeFamilyName).filter(Boolean));
  const safeFamilies = new Set([
    ...licensedFamilies,
    ...(options.destinationFamilies ?? []).map(normalizeFamilyName).filter(Boolean),
  ]);
  const blocks = fontFaceBlocks(sourceCss);
  const faces = scanFontFaces(sourceCss, options.sourcePath);
  const removed = new Set<number>();
  const removedFamilies = new Set<string>();
  const warnings: FontAssetWarning[] = [];

  for (const [index, face] of faces.entries()) {
    const licensed = face.families.length > 0 && face.families.every((family) => licensedFamilies.has(normalizeFamilyName(family)));
    if (licensed) continue;
    removed.add(index);
    for (const family of face.families) removedFamilies.add(family);
    warnings.push({
      family: face.families.join(', ') || undefined,
      reason: face.families.length
        ? `@font-face for ${face.families.join(', ')} was removed because no complete licensed-file decision was supplied`
        : '@font-face was removed because it has no explicit, licensed font family',
      source: face.source,
    });
  }

  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const [index, block] of blocks.entries()) {
    if (removed.has(index)) edits.push({ start: block.start, end: block.end, value: '' });
  }

  // Do not rewrite descriptors inside any @font-face block, including an approved one. A face's
  // family and src descriptors are part of the license-bound record, not ordinary component CSS.
  for (const declaration of scanFontDeclarations(sourceCss)) {
    if (blocks.some((block) => declaration.start >= block.start && declaration.end <= block.end)) continue;
    const sanitized = sanitizeFontDeclaration(declaration.property, declaration.value, safeFamilies, fallbackStack);
    if (!sanitized.changed) continue;
    edits.push({ start: declaration.valueStart, end: declaration.valueEnd, value: sanitized.value });
    warnings.push({
      reason: `${declaration.property} references an unlicensed font; retained safe fallback ${sanitized.value}`,
      source: locationAt(sourceCss, declaration.start, options.sourcePath),
    });
  }

  let css = sourceCss;
  for (const edit of [...edits].sort((first, second) => second.start - first.start)) {
    css = `${css.slice(0, edit.start)}${edit.value}${css.slice(edit.end)}`;
  }
  return {
    css,
    rewrittenCss: css,
    warnings,
    removedFamilies: [...removedFamilies],
    rewrittenDeclarations: edits.filter((edit) => edit.value !== '').length,
  };
}

/** Descriptive alias for callers that name the operation as a policy application. */
export const applyFontFallback = fallbackUnlicensedFonts;

export interface SanitizedFontValue {
  value: string;
  changed: boolean;
  removedFamilies: string[];
}

/**
 * Sanitize one `font-family` value. The operation is exported so the canonical plan adapter can
 * apply the same rule to structured declarations without reparsing an entire stylesheet.
 */
export function sanitizeFontFamilyValue(
  value: string,
  options: Pick<FontFallbackOptions, 'licensedFamilies' | 'fallbackStack'> = {},
): SanitizedFontValue {
  const fallbackStack = safeFallbackStack(options.fallbackStack);
  const licensedFamilies = new Set((options.licensedFamilies ?? []).map(normalizeFamilyName).filter(Boolean));
  const families = splitTopLevel(value, ',').map((family) => family.trim()).filter(Boolean);
  if (!families.length) return { value: fallbackStack, changed: value !== fallbackStack, removedFamilies: [] };
  const safe = families.filter((family) => isSafeFamily(family, licensedFamilies));
  const removedFamilies = families.filter((family) => !isSafeFamily(family, licensedFamilies));
  if (!removedFamilies.length) return { value, changed: false, removedFamilies: [] };
  const output = safe.length ? safe.join(', ') : fallbackStack;
  return { value: output, changed: output !== value, removedFamilies };
}

/**
 * Pure classification for a CSS reference. Local files remain `unresolved` here because copying
 * is intentionally the responsibility of `rewriteCssAssets`; nothing is fetched or written by
 * classification alone.
 */
export function classifyCssUrlReference(
  reference: CssUrlReference,
  options: Pick<RewriteCssAssetsOptions, 'sourcePath' | 'assetRoot' | 'allowFontLicense' | 'fontLicenses'>,
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
  const warnings: FontAssetWarning[] = [];
  const successOutcome = options.prepareAsset ? 'prepared' : 'copied';
  const successReason = options.prepareAsset ? 'local asset prepared in memory; no destination files written' : 'local asset copied to destination assets directory';

  for (const reference of references) {
    const classified = classify(reference, options);
    if (!classified.localPath) {
      ledger.push({ ...reference, outcome: classified.outcome, reason: classified.reason });
      if (reference.kind === 'font' && classified.outcome !== 'external') {
        warnings.push({ reference: reference.url, reason: classified.reason, source: reference.location });
      }
      continue;
    }

    const reused = copied.get(classified.localPath);
    if (reused) {
      ledger.push({
        ...reference,
        outcome: successOutcome,
        reason: successReason,
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
      options.prepareAsset,
      reference.kind,
      classified.fontLicense,
    );
    if ('reason' in result) {
      ledger.push({
        ...reference,
        outcome: result.outcome,
        reason: result.reason,
        sourceAssetPath: classified.localPath,
      });
      if (reference.kind === 'font') {
        warnings.push({ reference: reference.url, reason: result.reason, source: reference.location });
      }
      continue;
    }

    copied.set(classified.localPath, result);
    ledger.push({
      ...reference,
      outcome: successOutcome,
      reason: successReason,
      sourceAssetPath: classified.localPath,
      destinationAssetPath: result.destinationAssetPath,
      rewrittenUrl: `${result.rewrittenUrl}${classified.suffix ?? ''}`,
    });
  }

  const css = rewriteReferences(options.sourceCss, ledger);
  return { css, rewrittenCss: css, assets: ledger, ledger, warnings };
}

/** Compatibility-friendly spelling for callers that describe this as processing rather than rewriting. */
export const processCssAssets = rewriteCssAssets;

function classify(
  reference: CssUrlReference,
  options: Pick<RewriteCssAssetsOptions, 'sourcePath' | 'assetRoot' | 'allowFontLicense' | 'fontLicenses'>,
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
  const fontLicense = reference.kind === 'font' ? findFontLicense(reference, options.fontLicenses) : undefined;
  // A font is executable presentation data with redistribution terms, not an ordinary external
  // image.  Data URLs, fragments, and remote URLs therefore remain unresolved even when the
  // legacy boolean switch is set: only a reviewed local WOFF/WOFF2 file may cross this boundary.
  if (reference.kind === 'font') {
    if (!fontLicense) {
      return {
        outcome: 'unresolved',
        reason: options.allowFontLicense === true
          ? 'allowFontLicense is not sufficient; supply a reference-bound local font license decision'
          : 'font asset requires an explicit reference-bound local font license decision',
      };
    }
    if (compact.startsWith('#') || /^data:/i.test(compact) || /^https?:\/\//i.test(compact)
      || compact.startsWith('//') || /^blob:/i.test(compact)) {
      return { outcome: 'unresolved', reason: 'licensed font transport requires a local WOFF or WOFF2 file' };
    }
    if (scheme === 'file' || scheme) {
      return { outcome: 'blocked', reason: 'licensed font transport accepts only relative local URLs' };
    }
    const fontExtension = path.extname(splitSuffix(compact).pathname).toLowerCase();
    if (!FONT_EXTENSIONS.has(fontExtension) || (fontExtension !== '.woff' && fontExtension !== '.woff2')) {
      return { outcome: 'unresolved', reason: 'licensed font transport accepts only .woff and .woff2 files' };
    }
  }
  // These have no local file to copy. Keeping their literal values is safe and avoids inventing a
  // filesystem/media identity for inline data or a same-document fragment.
  if (compact.startsWith('#') || /^data:/i.test(compact)) {
    return { outcome: 'external', reason: 'inline or fragment CSS URL left unchanged' };
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
  if (reference.kind === 'font' && fontLicense && path.resolve(fontLicense.source) !== localPath) {
    return {
      outcome: 'unresolved',
      reason: 'font license decision does not name the exact local file referenced by the stylesheet',
    };
  }

  return {
    outcome: 'unresolved',
    reason: 'local CSS URL awaits copying',
    localPath,
    suffix,
    ...(fontLicense ? { fontLicense } : {}),
  };
}

async function copyLocalAsset(
  sourceAssetPath: string,
  destinationAssetDir: string,
  prefix: string,
  allowedRoot: string,
  prepareAsset?: (asset: PreparedCssAsset) => void,
  kind: CssAssetKind = 'asset',
  fontLicense?: FontLicenseDecision,
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
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (kind === 'font') {
      const extension = path.extname(sourceAssetPath).toLowerCase();
      if (extension !== '.woff' && extension !== '.woff2') {
        return { outcome: 'unresolved', reason: 'licensed font transport accepts only .woff and .woff2 files' };
      }
      if (!fontLicense || !/^[a-f0-9]{64}$/.test(fontLicense.sha256) || fontLicense.sha256 !== hash) {
        return { outcome: 'blocked', reason: 'font bytes do not match the explicitly licensed SHA-256' };
      }
      if (!fontLicense.ownership.trim() || !fontLicense.license.trim()) {
        return { outcome: 'unresolved', reason: 'font license decision needs non-empty ownership and license records' };
      }
      const signature = bytes.subarray(0, 4).toString('ascii');
      if ((extension === '.woff' && signature !== 'wOFF') || (extension === '.woff2' && signature !== 'wOF2')) {
        return { outcome: 'blocked', reason: `font bytes do not match the declared ${extension} container` };
      }
    }
    const filename = copiedFilename(sourceAssetPath, bytes);
    const destinationAssetPath = path.resolve(destinationAssetDir, filename);
    if (prepareAsset) {
      prepareAsset({ source: sourceAssetPath, destination: destinationAssetPath, content: bytes, sha256: hash, kind });
      return { destinationAssetPath, rewrittenUrl: `${prefix}${encodeURIComponent(filename)}` };
    }
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

function findFontLicense(
  reference: CssUrlReference,
  decisions: readonly FontLicenseDecision[] | undefined,
): FontLicenseDecision | undefined {
  const decision = decisions?.find((candidate) => candidate.reference === reference.url);
  if (!decision) return undefined;
  if (typeof decision.source !== 'string' || !path.isAbsolute(decision.source)) return undefined;
  if (typeof decision.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(decision.sha256)) return undefined;
  if (typeof decision.ownership !== 'string' || !decision.ownership.trim()) return undefined;
  if (typeof decision.license !== 'string' || !decision.license.trim()) return undefined;
  return decision;
}

interface FontFaceBlock {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

interface DeclarationSegment {
  property: string;
  value: string;
  start: number;
  end: number;
}

interface FontDeclaration {
  property: 'font-family' | 'font';
  value: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
}

function fontFaceBlocks(css: string): FontFaceBlock[] {
  const blocks: FontFaceBlock[] = [];
  let index = 0;
  while (index < css.length) {
    if (startsComment(css, index)) {
      index = skipComment(css, index + 2);
      continue;
    }
    if (isQuote(css[index])) {
      index = skipQuoted(css, index);
      continue;
    }
    const match = /^@font-face\b/i.exec(css.slice(index));
    if (!match || (index > 0 && /[-_A-Za-z0-9]/.test(css[index - 1]!))) {
      index += 1;
      continue;
    }
    let cursor = index + match[0].length;
    while (cursor < css.length && css[cursor] !== '{') {
      if (startsComment(css, cursor)) cursor = skipComment(css, cursor + 2);
      else if (isQuote(css[cursor])) cursor = skipQuoted(css, cursor);
      else cursor += 1;
    }
    if (css[cursor] !== '{') {
      index += match[0].length;
      continue;
    }
    const close = matchingBrace(css, cursor);
    if (close === -1) {
      index += match[0].length;
      continue;
    }
    blocks.push({ start: index, bodyStart: cursor + 1, bodyEnd: close, end: close + 1 });
    index = close + 1;
  }
  return blocks;
}

function matchingBrace(css: string, open: number): number {
  let depth = 1;
  let index = open + 1;
  while (index < css.length) {
    if (startsComment(css, index)) {
      index = skipComment(css, index + 2);
      continue;
    }
    if (isQuote(css[index])) {
      index = skipQuoted(css, index);
      continue;
    }
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function parseDeclarationSegments(css: string, start: number, end: number): DeclarationSegment[] {
  const declarations: DeclarationSegment[] = [];
  let segmentStart = start;
  let index = start;
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  while (index <= end) {
    const char = css[index];
    if (quote) {
      if (char === '\\') index += 2;
      else {
        if (char === quote) quote = '';
        index += 1;
      }
      continue;
    }
    if (startsComment(css, index)) {
      index = Math.min(end, skipComment(css, index + 2));
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    const boundary = index === end || (char === ';' && parentheses === 0 && brackets === 0);
    if (boundary) {
      const rawStart = segmentStart;
      const rawEnd = index;
      const raw = css.slice(rawStart, rawEnd);
      const colon = topLevelColon(raw);
      if (colon >= 0) {
        const property = stripCssComments(raw.slice(0, colon)).trim().toLowerCase();
        const value = stripCssComments(raw.slice(colon + 1)).trim();
        if (property && value) declarations.push({ property, value, start: rawStart, end: rawEnd });
      }
      segmentStart = index + 1;
    }
    index += 1;
  }
  return declarations;
}

function scanFontDeclarations(css: string): FontDeclaration[] {
  const declarations: FontDeclaration[] = [];
  const expression = /(?:^|[;{])([ \t\r\n]*)(font-family|font)([ \t]*):/gi;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(css))) {
    const property = match[2]!.toLowerCase() as FontDeclaration['property'];
    const valueStart = expression.lastIndex;
    const valueEnd = declarationValueEnd(css, valueStart);
    const value = css.slice(valueStart, valueEnd).trim();
    const trimmedStart = valueStart + (css.slice(valueStart, valueEnd).length - css.slice(valueStart, valueEnd).trimStart().length);
    const trimmedEnd = trimmedStart + value.length;
    declarations.push({
      property,
      value,
      start: match.index,
      end: valueEnd,
      valueStart: trimmedStart,
      valueEnd: trimmedEnd,
    });
    expression.lastIndex = valueEnd + (css[valueEnd] === ';' ? 1 : 0);
  }
  return declarations;
}

function declarationValueEnd(css: string, start: number): number {
  let index = start;
  let parentheses = 0;
  let quote = '';
  while (index < css.length) {
    const char = css[index];
    if (quote) {
      if (char === '\\') index += 2;
      else {
        if (char === quote) quote = '';
        index += 1;
      }
      continue;
    }
    if (startsComment(css, index)) {
      index = skipComment(css, index + 2);
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if ((char === ';' || char === '}') && parentheses === 0) return index;
    index += 1;
  }
  return css.length;
}

function topLevelColon(value: string): number {
  let parentheses = 0;
  let brackets = 0;
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets = Math.max(0, brackets - 1);
    else if (char === ':' && parentheses === 0 && brackets === 0) return index;
  }
  return -1;
}

function stripCssComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseFamilyList(value: string): string[] {
  return splitTopLevel(value, ',').map((family) => family.trim()).filter(Boolean).map(stripFamilyQuotes);
}

function stripFamilyQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return unescapeCssUrl(trimmed.slice(1, -1));
  }
  return trimmed;
}

function normalizeFamilyName(value: string): string {
  return stripFamilyQuotes(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function splitTopLevel(value: string, delimiter: ',' | ' '): string[] {
  const parts: string[] = [];
  let start = 0;
  let parentheses = 0;
  let quote = '';
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    const boundary = index === value.length || (delimiter === ',' && char === ',' && parentheses === 0)
      || (delimiter === ' ' && /\s/.test(char ?? '') && parentheses === 0);
    if (boundary) {
      parts.push(value.slice(start, index));
      start = index + 1;
      while (delimiter === ' ' && /\s/.test(value[start] ?? '')) start += 1;
    }
  }
  return parts;
}

const SAFE_FONT_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', '-apple-system', 'BlinkMacSystemFont',
  'Arial', 'Helvetica', 'Segoe UI', 'Times New Roman', 'Times', 'Georgia', 'Cambria', 'Garamond',
  'Courier New', 'Courier', 'Verdana', 'Tahoma', 'Trebuchet MS',
].map(normalizeFamilyName));

const SAFE_FONT_SHORTHANDS = new Set(['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);

function isSafeFamily(value: string, licensedFamilies: Set<string>): boolean {
  const normalized = normalizeFamilyName(value);
  return SAFE_FONT_FAMILIES.has(normalized)
    || licensedFamilies.has(normalized)
    || SAFE_FONT_SHORTHANDS.has(normalized)
    || /^(?:var|env)\s*\(/i.test(value.trim());
}

function safeFallbackStack(value: string | undefined): string {
  const stack = value?.trim() || SAFE_FONT_FALLBACK_STACK;
  if (!stack || /[\u0000-\u001f\u007f;{}@]/.test(stack) || topLevelColon(stack) >= 0) {
    throw new Error('font fallback stack contains unsafe CSS syntax');
  }
  return stack;
}

function sanitizeFontDeclaration(
  property: 'font-family' | 'font',
  value: string,
  licensedFamilies: Set<string>,
  fallbackStack: string,
): SanitizedFontValue {
  if (property === 'font-family') return sanitizeFontFamilyValue(value, { licensedFamilies: [...licensedFamilies], fallbackStack });
  if (SAFE_FONT_SHORTHANDS.has(normalizeFamilyName(value))) {
    return { value, changed: false, removedFamilies: [] };
  }
  const familyStart = fontShorthandFamilyStart(value);
  if (familyStart === undefined) {
    return { value: `normal 1rem ${fallbackStack}`, changed: true, removedFamilies: [value] };
  }
  const family = sanitizeFontFamilyValue(value.slice(familyStart), { licensedFamilies: [...licensedFamilies], fallbackStack });
  if (!family.changed) return { value, changed: false, removedFamilies: [] };
  return {
    value: `${value.slice(0, familyStart)}${family.value}`,
    changed: true,
    removedFamilies: family.removedFamilies,
  };
}

function fontShorthandFamilyStart(value: string): number | undefined {
  const tokens = topLevelWhitespaceTokens(value);
  const size = tokens.find((token) => isFontSizeToken(token.value));
  if (!size) return undefined;
  let start = size.end;
  while (/\s/.test(value[start] ?? '')) start += 1;
  if (value[start] === '/') {
    start += 1;
    while (/\s/.test(value[start] ?? '')) start += 1;
    const lineHeight = tokens.find((token) => token.start >= start);
    if (lineHeight) start = lineHeight.end;
  }
  while (/\s/.test(value[start] ?? '')) start += 1;
  return start < value.length ? start : undefined;
}

function topLevelWhitespaceTokens(value: string): Array<{ value: string; start: number; end: number }> {
  const tokens: Array<{ value: string; start: number; end: number }> = [];
  let start: number | undefined;
  let parentheses = 0;
  let quote = '';
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      if (start === undefined) start = index;
      continue;
    }
    if (char === '(') {
      parentheses += 1;
      if (start === undefined) start = index;
      continue;
    }
    if (char === ')') {
      parentheses = Math.max(0, parentheses - 1);
      continue;
    }
    if (index === value.length || (/\s/.test(char ?? '') && parentheses === 0)) {
      if (start !== undefined) {
        tokens.push({ value: value.slice(start, index), start, end: index });
        start = undefined;
      }
      continue;
    }
    if (start === undefined) start = index;
  }
  return tokens;
}

function isFontSizeToken(value: string): boolean {
  const base = value.split('/', 1)[0]!.toLowerCase();
  return /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large)$/.test(base)
    || /^0(?:[a-z%]+)?$/.test(base)
    || /^[+-]?(?:\d+\.?(?:\d*)?|\.\d+)(?:[a-z%]+)$/.test(base)
    || /^(?:var|env|calc|min|max|clamp|round|mod)\s*\(/.test(base);
}

function rewriteReferences(sourceCss: string, entries: CssAssetLedgerEntry[]): string {
  // Rewrite from the tail so an earlier source offset is never disturbed by a later replacement.
  const replacements = entries.filter((entry) => (entry.outcome === 'copied' || entry.outcome === 'prepared') && entry.rewrittenUrl);
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
  for (const candidate of imageSetCandidates(css, start, end)) {
    // CSS Images permits a direct string only in the candidate image position. Quoted strings in
    // descriptors such as `type("image/avif")`, or inside url(), are not assets themselves.
    const candidateStart = skipCssSpaceAndComments(css, candidate.start, candidate.end);
    if (!isQuote(css[candidateStart])) {
      continue;
    }
    const quote = css[candidateStart];
    const valueStart = candidateStart + 1;
    let cursor = valueStart;
    while (cursor < candidate.end) {
      if (css[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (css[cursor] === quote) break;
      cursor += 1;
    }
    if (cursor >= candidate.end) {
      continue;
    }
    const value = unescapeCssUrl(css.slice(valueStart, cursor).trim());
    references.push({
      raw: css.slice(candidateStart, cursor + 1),
      url: value,
      start: candidateStart,
      end: cursor + 1,
      location: locationAt(css, candidateStart, sourcePath),
      kind: fontRanges.some((range) => candidateStart >= range.start && candidateStart < range.end) || isFontUrl(value) ? 'font' : 'asset',
      syntax: 'string',
    });
  }
  return references;
}

/** Top-level image-set candidates; commas in url(), type(), comments, and strings stay nested. */
function imageSetCandidates(css: string, start: number, end: number): Array<{ start: number; end: number }> {
  const candidates: Array<{ start: number; end: number }> = [];
  let candidateStart = start;
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < end; index += 1) {
    const char = css[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (startsComment(css, index)) {
      index = skipComment(css, index + 2) - 1;
      continue;
    }
    if (isQuote(char)) {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      candidates.push({ start: candidateStart, end: index });
      candidateStart = index + 1;
    }
  }
  candidates.push({ start: candidateStart, end });
  return candidates;
}

function skipCssSpaceAndComments(css: string, start: number, end: number): number {
  let index = start;
  while (index < end) {
    if (/\s/.test(css[index])) {
      index += 1;
    } else if (startsComment(css, index)) {
      index = Math.min(end, skipComment(css, index + 2));
    } else {
      break;
    }
  }
  return index;
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
