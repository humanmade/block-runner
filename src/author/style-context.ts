import { createHash } from 'node:crypto';
import type { TokenConfig } from '../types.js';
import { scanStylesheet, type CssRule } from './styles.js';

/** The preset categories that have a native WordPress transport in this release. */
export type ThemePresetCategory = 'color' | 'spacing' | 'font-size' | 'font-family';

export interface ThemePreset {
  category: ThemePresetCategory;
  slug: string;
  value: string;
}

/** The one WordPress-native destination for an exact category/value preset match. */
export type ThemePresetTransport =
  | { attribute: 'textColor' | 'backgroundColor' | 'fontSize' | 'fontFamily' }
  | { stylePath: readonly ['spacing', 'margin' | 'padding', 'top' | 'right' | 'bottom' | 'left']; value: string };

export type ExactThemePresetTransport = ThemePresetTransport & { preset: ThemePreset };

/** Facts the plan can bind and display without ever treating the theme snapshot as writable. */
export interface StyleContextFacts {
  settingsSha256?: string;
  presets: ThemePreset[];
  unresolvedVariables: string[];
  limitations: string[];
}

/**
 * Produce one coherent context record from the supplied theme envelope and the stylesheet being
 * analysed. Callers may pass either `{ settings }` or settings itself to keep CLI/config adapters
 * thin while retaining one canonical fingerprint and variable check.
 */
export function styleContextFrom(theme: unknown, css: string): StyleContextFacts {
  const envelope = record(theme);
  const settings = Object.hasOwn(envelope, 'settings') ? envelope.settings : theme;
  const settingsRecord = record(settings);
  const fontSizes = record(settingsRecord.typography).fontSizes;
  const fluidFontSizes = Array.isArray(fontSizes)
    && fontSizes.some((entry: unknown) => record(entry).fluid === true || typeof record(entry).fluid === 'object');
  return {
    ...(hashThemeSettings(settings) === undefined ? {} : { settingsSha256: hashThemeSettings(settings) }),
    presets: themePresets(settings),
    unresolvedVariables: unresolvedCssVariables(css, settings),
    limitations: [
      ...(fluidFontSizes ? ['Fluid font-size presets are not treated as exact literal matches.'] : []),
      ...(Object.keys(record(settingsRecord.blocks)).length > 0
        ? ['Block-specific theme settings are not modelled for native preset matching.']
        : []),
    ],
  };
}

/**
 * Extract only the theme settings fields the style mapper can actually transport.  The input is
 * deliberately `unknown`: a target snapshot is evidence supplied by a caller, not a second
 * theme.json schema we try to validate or rewrite here.
 */
export function themePresets(settings: unknown): ThemePreset[] {
  const root = record(settings);
  const color = record(root.color);
  const typography = record(root.typography);
  const spacing = record(root.spacing);
  return [
    ...presetEntries(color.palette, 'color', 'color'),
    ...presetEntries(spacing.spacingSizes, 'spacing', 'size'),
    ...presetEntries(typography.fontSizes, 'font-size', 'size'),
    ...presetEntries(typography.fontFamilies, 'font-family', 'fontFamily'),
  ];
}

/**
 * Convert an evidence snapshot into the existing token vocabulary.  Values remain category
 * separated, so a slug collision (for example `brand` colour and `brand` font) cannot select
 * the wrong native attribute.
 */
export function themePresetTokens(settings: unknown): Pick<TokenConfig, 'colors' | 'spacing' | 'fontSizes' | 'fonts'> {
  const result: Pick<TokenConfig, 'colors' | 'spacing' | 'fontSizes' | 'fonts'> = {
    colors: {}, spacing: {}, fontSizes: {}, fonts: {},
  };
  for (const preset of themePresets(settings)) {
    switch (preset.category) {
      case 'color': result.colors![preset.slug] = preset.value; break;
      case 'spacing': (result.spacing as Record<string, string>)[preset.slug] = preset.value; break;
      case 'font-size': result.fontSizes![preset.slug] = preset.value; break;
      case 'font-family': result.fonts![preset.slug] = preset.value; break;
    }
  }
  return result;
}

/** Find a preset only when both its WordPress category and normalized literal value match. */
export function findThemePreset(
  settings: unknown,
  category: ThemePresetCategory,
  value: string,
): ThemePreset | undefined {
  const expected = normalizeCssValue(value);
  return themePresets(settings).find((preset) => preset.category === category && normalizeCssValue(preset.value) === expected);
}

/**
 * Map an authored CSS longhand through the exact destination preset it can actually serialize to.
 * This is deliberately one shared transport table: plan fulfillment, coverage classification, and
 * output checks must not each recreate a partial property list and silently lose a category.
 */
export function exactThemePresetTransport(
  settings: unknown,
  property: string,
  value: string,
): ExactThemePresetTransport | undefined {
  const target = presetTransportTarget(property);
  const preset = target && findThemePreset(settings, target.category, value);
  if (!preset) return undefined;
  const transport = presetTransport(property, preset);
  return transport ? { preset, ...transport } : undefined;
}

/**
 * Stable evidence fingerprint for the exact target settings snapshot.  It is intentionally not
 * a fingerprint of theme slug/version: those identify a theme, not the preset values consulted.
 */
export function hashThemeSettings(settings: unknown): string | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  return createHash('sha256').update(stableJson(settings), 'utf8').digest('hex');
}

/**
 * Report variable dependencies that cannot be proven from the supplied stylesheet and target
 * preset snapshot. Custom-property names are case-sensitive. We accept only an unconditional
 * provider in the same source rule: inheritance, selector overlap, conditions, and cycles need
 * a real cascade evaluator, so treating them as resolved here would overstate fidelity.
 */
export function unresolvedCssVariables(css: string, settings?: unknown): string[] {
  const unresolved = new Set<string>();
  const visit = (rules: readonly CssRule[], conditional: boolean): void => {
    for (const rule of rules) {
      if (rule.kind === 'conditional') {
        visit(rule.rules, true);
        continue;
      }
      if (rule.kind !== 'style') continue;
      const providers = !conditional
        ? resolvedSameRuleProviders(rule.declarations)
        : new Set<string>();
      for (const declaration of rule.declarations) {
        for (const use of variableUses(declaration.value)) {
          // A fallback is the authored value when this provider is absent. Nested var() calls
          // are independently observed by the scanner.
          if (use.hasFallback) continue;
          if (use.name.startsWith('--wp--preset--')) {
            if (!hasThemePresetVariable(settings, use.name)) unresolved.add(use.name);
          } else if (!providers.has(use.name)) {
            unresolved.add(use.name);
          }
        }
      }
    }
  };
  visit(scanStylesheet(css).rules, false);
  return [...unresolved].sort();
}

/** Normalize harmless lexical differences, never a semantic CSS conversion. */
export function normalizeCssValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return /^#[0-9a-f]{3,8}$/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function presetEntries(input: unknown, category: ThemePresetCategory, valueKey: string): ThemePreset[] {
  if (!Array.isArray(input)) return [];
  const result: ThemePreset[] = [];
  for (const entry of input) {
    const item = record(entry);
    const slug = string(item.slug);
    const value = string(item[valueKey]);
    // WordPress derives a `clamp()` expression for fluid presets. A source literal equal to the
    // nominal `size` is therefore not exact runtime equivalence.
    if (slug && value && !(category === 'font-size' && (item.fluid === true || typeof item.fluid === 'object'))) {
      result.push({ category, slug, value });
    }
  }
  return result;
}

type PresetTransportTarget =
  | { kind: 'attribute'; category: ThemePresetCategory; attribute: 'textColor' | 'backgroundColor' | 'fontSize' | 'fontFamily' }
  | { kind: 'style'; category: 'spacing'; group: 'margin' | 'padding'; side: 'top' | 'right' | 'bottom' | 'left' };

const PRESET_TRANSPORT_TARGETS: Readonly<Record<string, PresetTransportTarget>> = {
  color: { kind: 'attribute', category: 'color', attribute: 'textColor' },
  background: { kind: 'attribute', category: 'color', attribute: 'backgroundColor' },
  'background-color': { kind: 'attribute', category: 'color', attribute: 'backgroundColor' },
  'font-size': { kind: 'attribute', category: 'font-size', attribute: 'fontSize' },
  'font-family': { kind: 'attribute', category: 'font-family', attribute: 'fontFamily' },
  'margin-top': { kind: 'style', category: 'spacing', group: 'margin', side: 'top' },
  'margin-right': { kind: 'style', category: 'spacing', group: 'margin', side: 'right' },
  'margin-bottom': { kind: 'style', category: 'spacing', group: 'margin', side: 'bottom' },
  'margin-left': { kind: 'style', category: 'spacing', group: 'margin', side: 'left' },
  'padding-top': { kind: 'style', category: 'spacing', group: 'padding', side: 'top' },
  'padding-right': { kind: 'style', category: 'spacing', group: 'padding', side: 'right' },
  'padding-bottom': { kind: 'style', category: 'spacing', group: 'padding', side: 'bottom' },
  'padding-left': { kind: 'style', category: 'spacing', group: 'padding', side: 'left' },
};

function presetTransportTarget(property: string): PresetTransportTarget | undefined {
  return PRESET_TRANSPORT_TARGETS[property.trim().toLowerCase()];
}

/**
 * Return the sole native destination for an already-exact preset. The category check remains
 * here rather than in each caller, so a colour slug cannot accidentally become a font/spacing
 * transport merely because the spelling is shared.
 */
export function presetTransport(property: string, preset: ThemePreset): ThemePresetTransport | undefined {
  const target = presetTransportTarget(property);
  if (!target || target.category !== preset.category) return undefined;
  if (target.kind === 'attribute') return { attribute: target.attribute };
  return { stylePath: ['spacing', target.group, target.side], value: `var:preset|spacing|${preset.slug}` };
}

function hasThemePresetVariable(settings: unknown, variable: string): boolean {
  const match = /^--wp--preset--(color|spacing|font-size|font-family)--([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(variable);
  if (!match) return false;
  return themePresets(settings).some((preset) => preset.category === match[1] && preset.slug === match[2]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function variableUses(value: string): Array<{ name: string; hasFallback: boolean }> {
  const uses: Array<{ name: string; hasFallback: boolean }> = [];
  const expression = /var\(\s*(--[A-Za-z_][A-Za-z0-9_-]*)\s*(,)?/g;
  for (const match of value.matchAll(expression)) uses.push({ name: match[1]!, hasFallback: match[2] === ',' });
  return uses;
}

/**
 * A custom-property declaration is not evidence of a usable provider if it participates in a
 * same-rule cycle or depends on an absent provider. This remains intentionally local: inherited
 * and selector-dependent values are reported rather than guessed.
 */
function resolvedSameRuleProviders(declarations: ReadonlyArray<{ property: string; value: string }>): Set<string> {
  const definitions = new Map(declarations.filter((declaration) => declaration.property.startsWith('--'))
    .map((declaration) => [declaration.property, declaration.value]));
  const resolved = new Map<string, boolean>();
  const visiting = new Set<string>();
  const canResolve = (name: string): boolean => {
    const known = resolved.get(name);
    if (known !== undefined) return known;
    if (visiting.has(name)) return false;
    const value = definitions.get(name);
    if (value === undefined) return false;
    visiting.add(name);
    const ok = variableUses(value).filter((use) => !use.hasFallback)
      .every((use) => canResolve(use.name));
    visiting.delete(name);
    resolved.set(name, ok);
    return ok;
  };
  return new Set([...definitions.keys()].filter(canResolve));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
