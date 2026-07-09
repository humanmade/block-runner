import { ReportItem, TokenConfig, WpBlock } from '../types.js';

// Nearest-mode color tolerance: maximum RGB euclidean distance for a hardcoded
// hex to snap onto a token. ~25 keeps near-identical brand colours (e.g. an
// anti-aliased #0074ab vs #0073aa) snapping while leaving distinct hues alone.
const NEAREST_DISTANCE = 25;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface TokenInverseMap {
  colors: Map<string, string>;
  colorRgb: Array<{ slug: string; rgb: Rgb }>;
  fonts: Map<string, string>;
  fontSizes: Map<string, string>;
  spacingSlugs: Set<string>;
  spacingValues: Map<string, string>;
  match: 'exact' | 'nearest';
  isEmpty: boolean;
}

export function buildTokenInverseMap(tokens: TokenConfig | undefined): TokenInverseMap {
  const colors = new Map<string, string>();
  const colorRgb: Array<{ slug: string; rgb: Rgb }> = [];
  for (const [slug, value] of Object.entries(tokens?.colors ?? {})) {
    const normalized = normalizeHex(value);
    if (!normalized) {
      continue;
    }
    colors.set(normalized, slug);
    const rgb = hexToRgb(normalized);
    if (rgb) {
      colorRgb.push({ slug, rgb });
    }
  }

  const fonts = new Map<string, string>();
  for (const [slug, value] of Object.entries(tokens?.fonts ?? {})) {
    fonts.set(value, slug);
  }

  const fontSizes = new Map<string, string>();
  for (const [slug, value] of Object.entries(tokens?.fontSizes ?? {})) {
    fontSizes.set(value, slug);
  }

  const spacingSlugs = new Set<string>();
  const spacingValues = new Map<string, string>();
  const spacing = tokens?.spacing;
  if (Array.isArray(spacing)) {
    for (const slug of spacing) {
      spacingSlugs.add(slug);
    }
  } else if (spacing) {
    for (const [slug, value] of Object.entries(spacing)) {
      spacingSlugs.add(slug);
      spacingValues.set(value, slug);
    }
  }

  const isEmpty =
    colors.size === 0 && fonts.size === 0 && fontSizes.size === 0 && spacingValues.size === 0;

  return {
    colors,
    colorRgb,
    fonts,
    fontSizes,
    spacingSlugs,
    spacingValues,
    match: tokens?.match ?? 'exact',
    isEmpty,
  };
}

export function applyTokens(blocks: WpBlock[], invMap: TokenInverseMap, config: TokenConfig): ReportItem[] {
  const items: ReportItem[] = [];

  for (const block of blocks) {
    visit(block, invMap, config, items);
  }

  return items;
}

function visit(block: WpBlock, invMap: TokenInverseMap, config: TokenConfig, items: ReportItem[]): void {
  const attributes = block.attributes;
  const style = attributes.style as Record<string, unknown> | undefined;

  if (style && typeof style === 'object') {
    repairColor(block, style, invMap, items);
    repairTypography(block, style, invMap, items);
    repairSpacing(block, style, invMap, items);
    pruneStyle(attributes);
  }

  for (const child of block.innerBlocks ?? []) {
    visit(child, invMap, config, items);
  }
}

function repairColor(
  block: WpBlock,
  style: Record<string, unknown>,
  invMap: TokenInverseMap,
  items: ReportItem[],
): void {
  const color = style.color as Record<string, unknown> | undefined;
  if (!color || typeof color !== 'object') {
    return;
  }

  const targets: Array<{ key: string; attribute: string; reason: string }> = [
    { key: 'background', attribute: 'backgroundColor', reason: 'background' },
    { key: 'text', attribute: 'textColor', reason: 'text' },
  ];

  for (const { key, attribute, reason } of targets) {
    const value = color[key];
    if (typeof value !== 'string' || !value.startsWith('#')) {
      continue;
    }
    const slug = matchColor(value, invMap);
    if (!slug) {
      continue;
    }
    block.attributes[attribute] = slug;
    delete color[key];
    items.push(repairItem(block, value, slug, attribute, `repaired ${reason} ${value} → preset "${slug}"`));
  }
}

function repairTypography(
  block: WpBlock,
  style: Record<string, unknown>,
  invMap: TokenInverseMap,
  items: ReportItem[],
): void {
  const typography = style.typography as Record<string, unknown> | undefined;
  if (!typography || typeof typography !== 'object') {
    return;
  }

  const fontSize = typography.fontSize;
  if (typeof fontSize === 'string') {
    const slug = invMap.fontSizes.get(fontSize);
    if (slug) {
      block.attributes.fontSize = slug;
      delete typography.fontSize;
      items.push(repairItem(block, fontSize, slug, 'fontSize', `repaired font size ${fontSize} → preset "${slug}"`));
    }
  }

  const fontFamily = typography.fontFamily;
  if (typeof fontFamily === 'string') {
    const slug = invMap.fonts.get(fontFamily);
    if (slug) {
      block.attributes.fontFamily = slug;
      delete typography.fontFamily;
      items.push(repairItem(block, fontFamily, slug, 'fontFamily', `repaired font family ${fontFamily} → preset "${slug}"`));
    }
  }
}

function repairSpacing(
  block: WpBlock,
  style: Record<string, unknown>,
  invMap: TokenInverseMap,
  items: ReportItem[],
): void {
  if (invMap.spacingValues.size === 0) {
    return;
  }

  const spacing = style.spacing as Record<string, unknown> | undefined;
  if (!spacing || typeof spacing !== 'object') {
    return;
  }

  for (const group of ['padding', 'margin']) {
    const box = spacing[group] as Record<string, unknown> | undefined;
    if (!box || typeof box !== 'object') {
      continue;
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const value = box[side];
      if (typeof value !== 'string' || value.startsWith('var:preset|')) {
        continue;
      }
      const slug = invMap.spacingValues.get(value);
      if (!slug) {
        continue;
      }
      const target = `var:preset|spacing|${slug}`;
      box[side] = target;
      items.push(
        repairItem(block, value, target, `${group}.${side}`, `repaired ${group} ${value} → preset "${slug}"`),
      );
    }
  }
}

function matchColor(value: string, invMap: TokenInverseMap): string | undefined {
  const normalized = normalizeHex(value);
  if (!normalized) {
    return undefined;
  }
  const exact = invMap.colors.get(normalized);
  if (exact) {
    return exact;
  }
  if (invMap.match !== 'nearest') {
    return undefined;
  }
  const rgb = hexToRgb(normalized);
  if (!rgb) {
    return undefined;
  }
  let best: { slug: string; distance: number } | undefined;
  for (const candidate of invMap.colorRgb) {
    const distance = colorDistance(rgb, candidate.rgb);
    if (distance <= NEAREST_DISTANCE && (!best || distance < best.distance)) {
      best = { slug: candidate.slug, distance };
    }
  }
  return best?.slug;
}

function repairItem(block: WpBlock, from: string, to: string, attribute: string, reason: string): ReportItem {
  return {
    block: block.name,
    status: 'valid',
    reason,
    rule: 'token-repair',
    source: block.__blockRunnerSource,
    details: { from, to, attribute },
  };
}

function pruneStyle(attributes: Record<string, unknown>): void {
  const style = attributes.style as Record<string, unknown> | undefined;
  if (!style || typeof style !== 'object') {
    return;
  }

  const color = style.color as Record<string, unknown> | undefined;
  if (color && typeof color === 'object' && Object.keys(color).length === 0) {
    delete style.color;
  }

  const typography = style.typography as Record<string, unknown> | undefined;
  if (typography && typeof typography === 'object' && Object.keys(typography).length === 0) {
    delete style.typography;
  }

  const spacing = style.spacing as Record<string, unknown> | undefined;
  if (spacing && typeof spacing === 'object') {
    for (const group of ['padding', 'margin']) {
      const box = spacing[group] as Record<string, unknown> | undefined;
      if (box && typeof box === 'object' && Object.keys(box).length === 0) {
        delete spacing[group];
      }
    }
    if (Object.keys(spacing).length === 0) {
      delete style.spacing;
    }
  }

  if (Object.keys(style).length === 0) {
    delete attributes.style;
  }
}

function normalizeHex(value: string): string | undefined {
  let hex = value.trim().toLowerCase();
  if (!hex.startsWith('#')) {
    return undefined;
  }
  hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((char) => char + char)
      .join('');
  }
  if (hex.length === 8 && hex.endsWith('ff')) {
    hex = hex.slice(0, 6);
  }
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return undefined;
  }
  return `#${hex}`;
}

function hexToRgb(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (!match) {
    return undefined;
  }
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

function colorDistance(a: Rgb, b: Rgb): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}
