import postcss from 'postcss';
import { scanCssUrlReferences, type FontLicenseDecision, type FontFaceRecord } from '../author/assets.js';
import { scopeLocalSelectorList, type CssRule } from '../author/styles.js';
import type { AuthoringAsset, AuthoringCssRule, AuthoringStyles } from './schema.js';

/** A deliberately narrow @font-face descriptor set for the 0.9 source package. */
export interface LicensedFontFace {
  family: string;
  src: string;
  fontStyle?: string;
  fontWeight?: string;
  fontStretch?: string;
  fontDisplay?: string;
  unicodeRange?: string;
}

export interface FontLicenseNotice {
  family: string;
  source: string;
  ownership: string;
  license: string;
  /** Optional supplied notice text; it is recorded, never interpreted as legal advice. */
  notice?: string;
}

/**
 * Render a checked font-face descriptor for inclusion in the generated shared stylesheet. The
 * caller must have already copied and hash-confirmed the WOFF/WOFF2 file; this emitter accepts only
 * package-relative `./assets/` URLs and never emits a remote/data font source.
 */
export function renderLicensedFontFace(face: LicensedFontFace, at = 'font'): string {
  const family = cssString(face.family, `${at}.family`);
  const src = safeFontSource(face.src, `${at}.src`);
  const declarations = [
    `font-family: ${family};`,
    `src: ${src};`,
    ...optionalFontDescriptor(face.fontStyle, 'font-style', `${at}.fontStyle`),
    ...optionalFontDescriptor(face.fontWeight, 'font-weight', `${at}.fontWeight`),
    ...optionalFontDescriptor(face.fontStretch, 'font-stretch', `${at}.fontStretch`),
    ...optionalFontDescriptor(face.fontDisplay, 'font-display', `${at}.fontDisplay`),
    ...optionalFontDescriptor(face.unicodeRange, 'unicode-range', `${at}.unicodeRange`),
  ];
  return `@font-face { ${declarations.join(' ')} }`;
}

/** Render all faces in deterministic order while retaining the input order of equal families. */
export function renderLicensedFontFaces(faces: readonly LicensedFontFace[]): string {
  return faces.map((face, index) => renderLicensedFontFace(face, `fonts[${index}]`)).join('\n');
}

/**
 * Preserve the human redistribution decision in generated source. This is a provenance notice,
 * not a claim that a non-empty string proves legal compliance; callers remain responsible for
 * checking the supplied license terms. Values are escaped so an untrusted notice cannot close the
 * generated comment.
 */
export function renderFontLicenseNotice(notices: readonly FontLicenseNotice[]): string {
  if (!notices.length) return '';
  // Keep a readable source-side copy when the build preserves comments. The standalone text
  // artifact is the authoritative production record because wp-scripts may remove all comments.
  const lines = ['/*! Block Runner font redistribution record (reviewed input; not legal advice).'];
  for (const [index, notice] of notices.entries()) {
    const at = `fontNotices[${index}]`;
    requireNonEmpty(notice.family, `${at}.family`);
    requireNonEmpty(notice.source, `${at}.source`);
    requireNonEmpty(notice.ownership, `${at}.ownership`);
    requireNonEmpty(notice.license, `${at}.license`);
    lines.push(` * family: ${safeComment(notice.family)}`);
    lines.push(` * source: ${safeComment(notice.source)}`);
    lines.push(` * ownership: ${safeComment(notice.ownership)}`);
    lines.push(` * license: ${safeComment(notice.license)}`);
    if (notice.notice !== undefined) lines.push(` * notice: ${safeComment(notice.notice)}`);
  }
  lines.push(' */', '');
  return lines.join('\n');
}

/**
 * Render the same confirmed font decisions as plain text for a standalone package record.
 * WordPress's production CSS minifier is allowed to remove comments, so this copy deliberately
 * keeps the complete supplied notice (including line breaks) outside the stylesheet. Sources are
 * supplied by the generator as package-relative destinations; this helper never receives or emits
 * the original local file path.
 */
export function renderFontLicenseText(notices: readonly FontLicenseNotice[]): string {
  if (!notices.length) return '';
  const lines = [
    'Block Runner bundled font licenses',
    '===================================',
    'Generated from the confirmed authoring plan. Source paths are package-relative.',
    '',
  ];
  for (const [index, notice] of notices.entries()) {
    const at = `fontLicenses[${index}]`;
    requireNonEmpty(notice.family, `${at}.family`);
    requireNonEmpty(notice.source, `${at}.source`);
    requireNonEmpty(notice.ownership, `${at}.ownership`);
    requireNonEmpty(notice.license, `${at}.license`);
    lines.push(`Family: ${safeText(notice.family, `${at}.family`)}`);
    lines.push(`Source: ${safeText(notice.source, `${at}.source`)}`);
    lines.push(`Ownership: ${safeText(notice.ownership, `${at}.ownership`)}`);
    lines.push(`License: ${safeText(notice.license, `${at}.license`)}`);
    if (notice.notice !== undefined) {
      requireNonEmpty(notice.notice, `${at}.notice`);
      lines.push('Notice:');
      lines.push(safeText(notice.notice, `${at}.notice`));
    }
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** Convert a low-level URL decision into a source notice without exposing file bytes. */
export function fontLicenseNoticeFromDecision(
  face: Pick<FontFaceRecord, 'families'>,
  decision: Pick<FontLicenseDecision, 'source' | 'ownership' | 'license' | 'notice'>,
): FontLicenseNotice {
  return {
    family: face.families.join(', '),
    source: decision.source,
    ownership: decision.ownership,
    license: decision.license,
    ...(decision.notice !== undefined ? { notice: decision.notice } : {}),
  };
}

function cssString(value: string, at: string): string {
  requireNonEmpty(value, at);
  const trimmed = value.trim();
  // Font family names are data, but a control character or declaration boundary still makes a
  // malformed source record. Quote the value so spaces and punctuation remain one family name.
  if (/[\u0000-\u001f\u007f{};]|\/\*|\*\//.test(trimmed)) {
    throw new Error(`${at} contains unsafe CSS text`);
  }
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function safeFontSource(value: string, at: string): string {
  requireNonEmpty(value, at);
  const source = value.trim();
  if (/[\u0000-\u001f\u007f{};@]|\/\*|\*\//.test(source)) {
    throw new Error(`${at} contains unsafe CSS text`);
  }

  const references = scanCssUrlReferences(source);
  if (!references.length || references.some((reference) => reference.syntax !== 'url'
    || !/^\.\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.woff2?$/i.test(reference.url))) {
    throw new Error(`${at} must contain only package-relative WOFF/WOFF2 URLs`);
  }

  // A source descriptor may add a format hint, but cannot smuggle a second CSS function or a
  // local()/remote/data source around the checked URL. Remove only the references and the two
  // accepted format hints; anything else is an unsupported descriptor and fails visibly.
  let remainder = source;
  for (const reference of [...references].sort((first, second) => second.start - first.start)) {
    remainder = `${remainder.slice(0, reference.start)}${remainder.slice(reference.end)}`;
  }
  remainder = remainder.replace(/format\(\s*(["'])(?:woff|woff2)\1\s*\)/gi, '').replace(/[\s,]+/g, '');
  if (remainder) throw new Error(`${at} contains an unsupported font source descriptor`);
  return source;
}

function optionalFontDescriptor(value: string | undefined, property: string, at: string): string[] {
  if (value === undefined) return [];
  requireNonEmpty(value, at);
  const descriptor = value.trim();
  if (/[\u0000-\u001f\u007f{};@]|\/\*|\*\/|!\s*important|\b(?:url|expression|javascript)\s*\(/i.test(descriptor)) {
    throw new Error(`${at} contains unsafe CSS text`);
  }
  return [`${property}: ${descriptor};`];
}

function requireNonEmpty(value: string, at: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at} must be non-empty`);
}

function safeComment(value: string): string {
  requireNonEmpty(value, 'font notice value');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error('font notice contains unsafe control characters');
  }
  // Keep the complete human record while making line-oriented output and preventing comment
  // termination. This is escaping, not a claim that the supplied text proves legal entitlement.
  return value.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').trim();
}

function safeText(value: string, at: string): string {
  if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${at} contains unsafe control characters`);
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

// The generated file passes through Sass. Do not let a CSS value become a Sass-only function
// call (random(), call(), etc.) that can change the reviewed output during the build.
const CSS_FUNCTIONS = new Set(`abs acos asin atan atan2 attr blur brightness calc circle clamp color color-mix
  conic-gradient contrast cos counter counters cubic-bezier drop-shadow ellipse env exp fit-content grayscale
  hsl hsla hue-rotate hwb hypot image-set inset invert lab lch light-dark linear linear-gradient log matrix matrix3d
  max min minmax mod oklab oklch opacity path perspective polygon pow radial-gradient ray rem repeat
  repeating-conic-gradient repeating-linear-gradient repeating-radial-gradient rgb rgba rotate rotateX rotateY
  rotateZ rotate3d round saturate scale scaleX scaleY scaleZ scale3d sepia sign sin skew skewX skewY sqrt steps
  symbols tan translate translateX translateY translateZ translate3d type url var -webkit-image-set`.toLowerCase().split(/\s+/));

export class AuthoringStyleError extends Error {
  constructor(readonly reason: string, readonly source: { path: string }) {
    super(`${reason} at ${source.path}`);
    this.name = 'AuthoringStyleError';
  }
}

/** Carry a scanned residual graph into a plan without flattening conditions or double-scoping. */
export function authoringRulesFromStylesheet(rules: readonly CssRule[]): AuthoringCssRule[] {
  return rules.map((rule) => {
    if (rule.kind === 'blocked' || (rule.kind === 'style' && rule.nestedIn)) fail('blocked source rule cannot enter a plan', rule.id);
    if (rule.kind === 'conditional') return { kind: 'conditional', name: rule.name, prelude: rule.prelude,
      rules: authoringRulesFromStylesheet(rule.rules) };
    return { kind: 'style', selector: rule.selector, declarations: rule.declarations.map(({ property, value, important }) =>
      ({ property, value, ...(important ? { important } : {}) })) };
  });
}

/** The same checked rendering is used before preview, before asset reads, and during compilation. */
export function renderConfirmedStyleRules(
  rules: readonly AuthoringCssRule[], root: string, assets: readonly AuthoringAsset[], location = 'styles.rules',
): { css: string; assetIds: Set<string> } {
  if (!/^\.wp-block-[a-z0-9][a-z0-9-]*-[a-z0-9][a-z0-9-]*$/.test(root)) fail('invalid owned block root', location);
  const assetIds = new Set<string>();
  const render = (items: readonly AuthoringCssRule[], at: string, depth: number): string => {
    if (depth > 16) fail('conditional CSS nesting exceeds 16 levels', at);
    return items.map((rule, index) => {
      const ruleAt = `${at}[${index}]`;
      const indent = '  '.repeat(depth);
      if (rule.kind === 'conditional') {
        if (!['media', 'supports', 'container'].includes(rule.name)) fail('unsupported conditional rule', ruleAt);
        assertFragment(rule.prelude, `${ruleAt}.prelude`, false, true);
        assertCssFunctions(rule.prelude, `${ruleAt}.prelude`, true);
        // Conditions cannot fetch assets or evaluate Sass. Declarations belong in style rules.
        if (/url\s*\(/i.test(rule.prelude)) fail('URLs are not accepted in conditions', `${ruleAt}.prelude`);
        const body = render(rule.rules, `${ruleAt}.rules`, depth + 1);
        if (!body) fail('empty conditional rule', ruleAt);
        const css = `${indent}@${rule.name} ${rule.prelude} {\n${body}\n${indent}}`;
        const parsed = postcss.parse(css).nodes;
        if (parsed.length !== 1 || parsed[0]?.type !== 'atrule' || parsed[0].name !== rule.name || parsed[0].params !== rule.prelude) {
          fail('conditional rule changed during parsing', ruleAt);
        }
        return css;
      }
      assertFragment(rule.selector, `${ruleAt}.selector`, true, true);
      if (rule.selector.includes(root)) fail('selectors must be component-local; the compiler owns the root prefix', `${ruleAt}.selector`);
      const scoped = scopeLocalSelectorList(rule.selector, root);
      if (!scoped.ok) fail(scoped.reason, `${ruleAt}.selector`);
      if (!rule.declarations.length) fail('empty style rule', ruleAt);
      const declarations = rule.declarations.map((declaration, declarationIndex) => {
        const declarationAt = `${ruleAt}.declarations[${declarationIndex}]`;
        if (!/^(?:--[a-zA-Z_][a-zA-Z0-9_-]*|-?[a-z][a-z0-9-]*)$/.test(declaration.property)
          || /^(?:behavior|-moz-binding)$/i.test(declaration.property)) {
          fail('unsupported or unsafe CSS property', `${declarationAt}.property`);
        }
        assertFragment(declaration.value, `${declarationAt}.value`);
        assertCssFunctions(declaration.value, `${declarationAt}.value`);
        if (/expression\s*\(|!\s*important/i.test(declaration.value)) fail('value must not contain executable CSS or an embedded priority', `${declarationAt}.value`);
        for (const reference of scanCssUrlReferences(`x{${declaration.property}:${declaration.value}}`)) {
          // URL ownership is explicit. A local URL cannot silently resolve against the host page.
          const asset = assets.find((candidate) => candidate.status === 'external'
            ? candidate.source === reference.url && /^https?:\/\//.test(reference.url)
            : candidate.status === 'ready' && candidate.destination && reference.url === `./${candidate.destination}`);
          if (!asset) fail(`CSS asset is not confirmed: ${reference.url}`, `${declarationAt}.value`);
          assetIds.add(asset.id);
        }
        return `${declaration.property}: ${declaration.value}${declaration.important ? ' !important' : ''};`;
      });
      const css = `${indent}${scoped.selector} { ${declarations.join(' ')} }`;
      const parsed = postcss.parse(css).nodes;
      const parsedRule = parsed[0];
      if (parsed.length !== 1 || parsedRule?.type !== 'rule' || parsedRule.selector !== scoped.selector
        || parsedRule.nodes.length !== rule.declarations.length
        || parsedRule.nodes.some((node, i) => node.type !== 'decl'
          || node.prop !== rule.declarations[i]!.property || node.value !== rule.declarations[i]!.value
          || Boolean(node.important) !== Boolean(rule.declarations[i]!.important))) {
        fail('declaration changed during parsing', ruleAt);
      }
      return css;
    }).join('\n');
  };
  return { css: render(rules, location, 0), assetIds };
}

export function confirmedStylesheetAssets(styles: AuthoringStyles, name: string, assets: readonly AuthoringAsset[]): Set<string> {
  const root = `.wp-block-${name.replace('/', '-')}`;
  const shared = renderConfirmedStyleRules(styles.rules ?? [], root, assets);
  const editor = renderConfirmedStyleRules(styles.editorRules ?? [], root, assets, 'styles.editorRules');
  return new Set([...shared.assetIds, ...editor.assetIds]);
}

function assertFragment(value: string, at: string, allowEscapes = false, allowComparators = false): void {
  // Source SCSS is intentionally CSS data. These tokens can introduce another declaration,
  // Sass interpolation/variables/imports, comments, or an HTML boundary before the build.
  if (!value.trim() || value !== value.trim() || /[\u0000-\u001f\u007f;{}@$]/.test(value)
    || (!allowComparators && /[<>]/.test(value))
    || /\/\*|\*\/|(^|[^:])\/\//.test(value) || (!allowEscapes && value.includes('\\'))) {
    fail('unsafe CSS fragment', at);
  }
  // Keep structural punctuation balanced, ignoring quoted text and CSS selector escapes.
  const stack: string[] = [];
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === '\\' && allowEscapes) {
      if (i + 1 === value.length) fail('trailing selector escape', at);
      i++;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(' || char === '[') stack.push(char);
    else if (char === ')' || char === ']') {
      if (stack.pop() !== (char === ')' ? '(' : '[')) fail('unbalanced CSS fragment', at);
    }
  }
  if (quote || stack.length) fail('unbalanced CSS fragment', at);
}

function fail(reason: string, path: string): never { throw new AuthoringStyleError(reason, { path }); }

function assertCssFunctions(value: string, at: string, condition = false): void {
  // Quoted content and URLs are data, not function identifiers. Escapes have already been refused.
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (!/[a-z_-]/i.test(char)) continue;
    const match = /^[-a-z0-9_]+/i.exec(value.slice(index))![0];
    if (value[index + match.length] === '(' && !CSS_FUNCTIONS.has(match.toLowerCase())
      && !(condition && ['selector', 'style', 'scroll-state'].includes(match.toLowerCase()))) {
      fail(`unsupported CSS function: ${match}`, at);
    }
    index += match.length - 1;
  }
}
