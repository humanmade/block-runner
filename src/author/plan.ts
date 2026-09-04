import { createHash } from 'node:crypto';
import path from 'node:path';
import { compileRegisteredBlock, registeredBlockFontFamilyPrefix } from '../authoring/generate.js';
import { supportedPatternOverrideAttributes } from '../authoring/overrides.js';
import type {
  AuthoringCoverage,
  AuthoringCoverageAsset,
  AuthoringCoverageStyle,
  AuthoringFontFace,
  AuthoringPlan,
  AuthoringStructureNode,
  JsonValue,
} from '../authoring/schema.js';
import { authoringRulesFromStylesheet } from '../authoring/styles.js';
import type { AssetLedgerEntry, AuthoredStyleLedgerEntry, AuthorConfig, WpBlock } from '../types.js';
import { scanCssUrlReferences, type FontAssetWarning, type FontLicenseDecision, type PreparedCssAsset } from './assets.js';
import { scanStylesheet, scopeStylesheet, type CssRule } from './styles.js';

export interface PreparedAuthoringFonts {
  /** CSS after removing global @font-face rules and namespacing their owned families. */
  css: string;
  /** Shared editor/frontend faces; each points at one confirmed plan asset. */
  fonts: AuthoringFontFace[];
  /** Original-family to block-owned-family mapping for editor-only declarations. */
  familyNames: ReadonlyMap<string, string>;
}

/**
 * Extract the global font transport from the effective stylesheet. Font bytes are already prepared
 * by the adapter at this point; this step only binds each face to the deterministic plan asset ID,
 * gives its family a block-owned name, and leaves ordinary component CSS for the scoped-rule gate.
 * `style.scss` is loaded in both contexts, so these faces never enter editor.scss.
 */
export function prepareAuthoringFonts(
  stylesheet: string,
  blockName: string,
  preparedAssets: readonly PreparedCssAsset[],
  assets: readonly AssetLedgerEntry[],
): PreparedAuthoringFonts {
  const scanned = scanStylesheet(stylesheet);
  const faces: Array<{ rule: Extract<CssRule, { kind: 'blocked' }>; declarations: Map<string, string> }> = [];
  collectFontFaceRules(scanned.rules, faces);
  if (faces.length === 0) {
    return { css: stylesheet, fonts: [], familyNames: new Map() };
  }

  const familyNames = new Map<string, string>();
  const fonts: AuthoringFontFace[] = [];
  const namespace = registeredBlockFontFamilyPrefix(blockName).slice(0, -1);

  for (const [faceIndex, face] of faces.entries()) {
    const familyValue = face.declarations.get('font-family');
    const sourceValue = face.declarations.get('src');
    const families = familyValue ? splitFontFamilyList(familyValue) : [];
    if (families.length !== 1) {
      throw new Error(`@font-face ${faceIndex + 1} must declare exactly one font-family for registered-block authoring`);
    }
    const originalFamily = families[0]!;
    const familyKey = normalizeFontFamily(originalFamily);
    const ownedFamily = familyNames.get(familyKey) ?? `${namespace}-${safeCssSlug(originalFamily)}`;
    familyNames.set(familyKey, ownedFamily);

    const references = sourceValue
      ? scanCssUrlReferences(sourceValue).filter((reference) => reference.kind === 'font')
      : [];
    if (references.length === 0) {
      throw new Error(`@font-face for ${originalFamily} must reference a local, confirmed WOFF or WOFF2 asset`);
    }
    for (const reference of references) {
      const ledger = assets.find((entry) => entry.kind === 'font'
        // The adapter passes the effective stylesheet after the asset gate. A confirmed local
        // face therefore names its package-relative rewrite here, while a direct helper caller
        // may still supply the original URL; accept either spelling but keep the ledger as the
        // source of truth for the prepared bytes.
        && (entry.reference === reference.url || entry.rewritten === reference.url)
        && (entry.outcome === 'prepared' || entry.outcome === 'copied'));
      const rewrittenName = ledger?.rewritten?.split(/[?#]/, 1)[0]?.replace(/^\.\/assets\//, '');
      const preparedIndex = rewrittenName
        ? preparedAssets.findIndex((asset) => path.basename(asset.destination) === path.basename(rewrittenName))
        : -1;
      if (!ledger || preparedIndex < 0) {
        throw new Error(`@font-face for ${originalFamily} is not bound to a prepared local font asset (${reference.url})`);
      }
      const assetId = `asset.${preparedIndex}`;
      const descriptor = (property: string): string | undefined => {
        const value = face.declarations.get(property);
        return value === undefined ? undefined : value;
      };
      fonts.push({
        assetId,
        family: ownedFamily,
        ...(descriptor('font-style') === undefined ? {} : { fontStyle: descriptor('font-style') }),
        ...(descriptor('font-weight') === undefined ? {} : { fontWeight: descriptor('font-weight') }),
        ...(descriptor('font-stretch') === undefined ? {} : { fontStretch: descriptor('font-stretch') }),
        ...(descriptor('font-display') === undefined ? {} : { fontDisplay: descriptor('font-display') }),
        ...(descriptor('unicode-range') === undefined ? {} : { unicodeRange: descriptor('unicode-range') }),
      });
    }
  }

  // Remove each global face using the scanner's exact source range. Removing before the second
  // scan keeps all component declaration coordinates internally consistent and prevents the
  // generic stylesheet gate from treating a deliberately handled face as an unsafe global rule.
  let css = stylesheet;
  for (const face of [...faces].sort((first, second) => second.rule.source.start.offset - first.rule.source.start.offset)) {
    css = `${css.slice(0, face.rule.source.start.offset)}${css.slice(face.rule.source.end.offset)}`;
  }
  css = namespaceFontDeclarations(css, familyNames);
  return { css, fonts, familyNames };
}

/** Apply an already-established block-owned family mapping to editor-only declarations. */
export function namespaceAuthoringFontReferences(
  stylesheet: string,
  familyNames: ReadonlyMap<string, string>,
): string {
  return namespaceFontDeclarations(stylesheet, familyNames);
}

/** Adapt analyzed HTML to the same data-only compiler used by author preview/write. */
export function compileAnalyzedDesign(input: {
  definition: AuthorConfig;
  name: string;
  /** The exact HTML string already read and analysed by `author`; never a caller-supplied hash. */
  source: string;
  sourcePath?: string;
  blocks: WpBlock[];
  rules: readonly CssRule[];
  preparedAssets: readonly PreparedCssAsset[];
  assets: readonly AssetLedgerEntry[];
  /** Complete shared-style ledger produced by the analysis pass. */
  styleLedger: readonly AuthoredStyleLedgerEntry[];
  /** Effective stylesheet bytes used for conversion, after deterministic asset rewrites. */
  stylesheet?: string;
  /** Effective editor-only stylesheet after the same deterministic asset gate. */
  editorStylesheet?: string;
  /** Shared editor/frontend faces extracted from the effective stylesheet. */
  fonts?: readonly AuthoringFontFace[];
  /** Safe fallback decisions made while analysing shared/editor CSS. */
  fontWarnings?: ReadonlyArray<{ warning: FontAssetWarning; scope: 'shared' | 'editor' }>;
  /** Exact decisions used to prepare local font assets. */
  fontLicenses?: readonly FontLicenseDecision[];
}) {
  const { definition, name } = input;
  if (Object.entries(definition.supports ?? {}).some(([key, value]) => key !== 'html' || value !== false)) {
    throw new Error('Wrapper supports require an explicit supported authoring-plan contract; no arbitrary supports are emitted.');
  }
  const nodes: AuthoringStructureNode[] = [];
  const convert = (block: WpBlock, id: string): AuthoringStructureNode => {
    if (block.name === 'core/html') throw new Error(`Unresolved native structure at ${id}: describe this region as native blocks before authoring source; Custom HTML is not a registered-block substitute.`);
    const node: AuthoringStructureNode = { id, block: block.name,
      attributes: Object.fromEntries(Object.entries(block.attributes).filter(([key]) => !key.startsWith('__blockRunner'))) as Record<string, JsonValue>,
      children: block.innerBlocks.map((child, index) => convert(child, `${id}.${index}`)) };
    nodes.push(node);
    return node;
  };
  const structure = input.blocks.map((block, index) => convert(block, `source.${index}`));
  const sourceEntry = input.sourcePath ?? '<inline>';
  const assets: AuthoringPlan['assets'] = input.preparedAssets.map((asset, index) => {
    const destination = `assets/${path.basename(asset.destination)}`;
    const license = asset.kind === 'font'
      ? input.fontLicenses?.find((candidate) => path.resolve(candidate.source) === path.resolve(asset.source)
        && candidate.sha256 === asset.sha256)
      : undefined;
    return { id: `asset.${index}`, source: asset.source, kind: asset.kind === 'font' ? 'font' : 'image', destination, status: 'ready', sha256: asset.sha256,
      ...(license ? {
        fontLicense: {
          ownership: license.ownership,
          license: license.license,
          ...(license.notice === undefined ? {} : { notice: license.notice }),
        },
      } : {}),
      uses: nodes.filter((node) => node.block === 'core/image' && node.attributes?.url === `./${destination}`)
        .map((node) => ({ node: node.id!, attribute: 'url' as const })) };
  });
  for (const reference of new Set(input.assets.filter((asset) => asset.outcome === 'external' && /^https?:\/\//.test(asset.reference)).map((asset) => asset.reference))) {
    assets.push({ id: `external.${createHash('sha256').update(reference).digest('hex').slice(0, 16)}`, source: reference, status: 'external' });
  }
  const editorCss = input.editorStylesheet ?? definition.styles?.editorCss;
  const editor = scopeStylesheet(scanStylesheet(editorCss ?? ''), { root: `.wp-block-${name.replace('/', '-')}` });
  if (editor.ledger.some((entry) => entry.outcome === 'blocked' || entry.outcome === 'warned') || editor.ruleRecords.some((rule) => rule.outcome === 'blocked')) {
    throw new Error('Editor-only CSS must use supported component-local rules; global or unsupported rules cannot be emitted.');
  }
  const editorStyleLedger: AuthoredStyleLedgerEntry[] = editor.ledger.map((entry) => ({
    property: entry.property,
    value: entry.value,
    outcome: entry.outcome === 'native' || entry.outcome === 'preset' || entry.outcome === 'literal'
      || entry.outcome === 'scoped-css' || entry.outcome === 'blocked' ? entry.outcome : 'warned',
    reason: entry.reason,
    atRules: entry.atRules,
    source: {
      path: input.sourcePath,
      offset: entry.source.start.offset,
      htmlLine: entry.source.start.line,
      htmlColumn: entry.source.start.column,
    },
  }));
  const coverage: AuthoringCoverage = {
    ...(input.stylesheet === undefined ? {} : {
      stylesheet: {
        entry: definition.styles?.css !== undefined ? '<author.styles.css>' : sourceEntry,
        sha256: sha256(input.stylesheet),
      },
    }),
    ...(editorCss === undefined ? {} : {
      editorStylesheet: { entry: '<author.styles.editorCss>', sha256: sha256(editorCss) },
    }),
    styles: [
      ...input.styleLedger.map((entry) => toCoverageStyle(entry, 'shared')),
      ...editorStyleLedger.map((entry) => toCoverageStyle(entry, 'editor')),
      ...(input.fontWarnings ?? []).map(({ warning, scope }) => toCoverageFontWarning(warning, scope)),
    ],
    assets: input.assets.map((entry) => toCoverageAsset(entry, input.preparedAssets)),
  };
  const plan: AuthoringPlan = {
    version: 1, generatorVersion: '0.9.0', target: { name,
      title: definition.title ?? name.split('/')[1]!.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      category: definition.category ?? 'widgets', wordpress: '7.1' },
    source: { entry: sourceEntry, sha256: sha256(input.source), format: 'html' },
    coverage,
    structure, fields: nodes.flatMap((node) => supportedPatternOverrideAttributes(node.block).map((attribute) => ({
      id: `${node.id}.${attribute}`, label: `${node.block} ${attribute}`, mode: 'editable' as const, node: node.id, attribute,
    }))),
    // Analysis proposes the legacy unrestricted policy; the returned plan exposes it for review.
    locking: definition.locking ?? { mode: 'none' },
    styles: { strategy: input.rules.length ? 'mixed' : 'native', outcomes: [],
      rules: authoringRulesFromStylesheet(input.rules), editorRules: authoringRulesFromStylesheet(editor.localRules),
      ...(input.fonts?.length ? { fonts: [...input.fonts] } : {}) },
    pattern: { ready: false, overrides: [] }, assets, files: [],
    warnings: (input.fontWarnings ?? []).map(({ warning }) => warning.reason),
  };
  return { plan, generated: compileRegisteredBlock(plan), editorStyleLedger };
}

function collectFontFaceRules(
  rules: readonly CssRule[],
  output: Array<{ rule: Extract<CssRule, { kind: 'blocked' }>; declarations: Map<string, string> }>,
): void {
  for (const rule of rules) {
    if (rule.kind === 'conditional') {
      collectFontFaceRules(rule.rules, output);
      continue;
    }
    if (rule.kind !== 'blocked' || rule.name.toLowerCase() !== 'font-face') continue;
    output.push({
      rule,
      declarations: new Map(rule.declarations.map((declaration) => [declaration.property.toLowerCase(), declaration.value])),
    });
  }
}

function splitFontFamilyList(value: string): string[] {
  const families: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let parentheses = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    if (index === value.length || (char === ',' && parentheses === 0)) {
      const family = value.slice(start, index).trim();
      if (family) families.push(stripFontFamilyQuotes(family));
      start = index + 1;
    }
  }
  return families;
}

function stripFontFamilyQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  return trimmed;
}

function normalizeFontFamily(value: string): string {
  return stripFontFamilyQuotes(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function safeCssSlug(value: string): string {
  const slug = normalizeFontFamily(value).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'font';
}

function namespaceFontDeclarations(css: string, families: ReadonlyMap<string, string>): string {
  if (families.size === 0) return css;
  const scanned = scanStylesheet(css);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  for (const entry of scanned.ledger) {
    if (entry.property !== 'font-family' && entry.property !== 'font') continue;
    const start = entry.source.start.offset;
    const end = entry.source.end.offset;
    const segment = css.slice(start, end);
    const colon = declarationColon(segment);
    if (colon < 0) continue;
    const rawValue = segment.slice(colon + 1);
    const leading = rawValue.length - rawValue.trimStart().length;
    const trailing = rawValue.length - rawValue.trimEnd().length;
    const valueStart = start + colon + 1 + leading;
    const valueEnd = end - trailing;
    const value = css.slice(valueStart, valueEnd);
    const rewritten = rewriteFontValue(value, families);
    if (rewritten !== value) edits.push({ start: valueStart, end: valueEnd, value: rewritten });
  }
  for (const edit of edits.sort((first, second) => second.start - first.start)) {
    css = `${css.slice(0, edit.start)}${edit.value}${css.slice(edit.end)}`;
  }
  return css;
}

function declarationColon(value: string): number {
  let quote: string | undefined;
  let parentheses = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') parentheses += 1;
    else if (char === ')') parentheses = Math.max(0, parentheses - 1);
    else if (char === ':' && parentheses === 0) return index;
  }
  return -1;
}

function rewriteFontValue(value: string, families: ReadonlyMap<string, string>): string {
  let output = value.replace(/(["'])(.*?)\1/g, (whole, quote: string, family: string) => {
    const owned = families.get(normalizeFontFamily(family));
    return owned ? `${quote}${owned}${quote}` : whole;
  });
  for (const [family, owned] of [...families.entries()].sort((first, second) => second[0].length - first[0].length)) {
    const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'gi'), owned);
  }
  return output;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toCoverageStyle(
  entry: Omit<Pick<AuthoredStyleLedgerEntry, 'property' | 'value' | 'outcome' | 'reason' | 'atRules' | 'source'>, 'outcome'> & { outcome: string },
  scope: AuthoringCoverageStyle['scope'],
): AuthoringCoverageStyle {
  const outcome: AuthoringCoverageStyle['outcome'] = entry.outcome === 'native' || entry.outcome === 'preset'
    || entry.outcome === 'literal' || entry.outcome === 'scoped-css' || entry.outcome === 'blocked'
    ? entry.outcome
    : 'warned';
  return {
    property: entry.property,
    value: entry.value,
    outcome,
    scope,
    ...(entry.reason ? { reason: entry.reason } : {}),
    atRules: [...entry.atRules],
    ...(entry.source ? { source: entry.source } : {}),
  };
}

function toCoverageFontWarning(
  warning: FontAssetWarning,
  scope: AuthoringCoverageStyle['scope'],
): AuthoringCoverageStyle {
  return {
    property: '@font-face',
    value: warning.family ?? warning.reference ?? '<unnamed font>',
    outcome: 'warned',
    scope,
    reason: warning.reason,
    atRules: ['@font-face'],
    ...(warning.source ? {
      source: {
        path: warning.source.path,
        offset: warning.source.offset,
        htmlLine: warning.source.line,
        htmlColumn: warning.source.column,
      },
    } : {}),
  };
}

function toCoverageAsset(entry: AssetLedgerEntry, preparedAssets: readonly PreparedCssAsset[]): AuthoringCoverageAsset {
  const rewritten = entry.rewritten;
  const rewrittenName = rewritten?.split(/[?#]/, 1)[0]?.replace(/^\.\/assets\//, '');
  const prepared = rewritten
    ? preparedAssets.find((asset) => path.basename(asset.destination) === rewrittenName)
    : undefined;
  return {
    reference: entry.reference,
    ...(rewritten ? { rewritten } : {}),
    kind: entry.kind,
    outcome: entry.outcome,
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(prepared ? { sha256: prepared.sha256, destination: `assets/${path.basename(prepared.destination)}` } : {}),
    ...(entry.source ? { source: entry.source } : {}),
  };
}
