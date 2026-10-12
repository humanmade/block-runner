import { BlockRunnerConfig, CommonOptions, ResolvedTokens, TokenResolver, TokenResolverKind } from '../types.js';
import { createContextTokenResolver } from './context.js';
import { createFileTokenResolver } from './file.js';
import { createNoopTokenResolver } from './noop.js';
import { createRestTokenResolver } from './rest.js';
import { createWpCliTokenResolver } from './wpcli.js';

export function createTokenResolver(
  config: BlockRunnerConfig,
  options: CommonOptions = {},
): TokenResolver {
  const kind = (options.tokenResolver ?? config.tokens?.resolver ?? 'noop') as TokenResolverKind;

  switch (kind) {
    case 'file':
      return createFileTokenResolver(config, options);
    case 'wpcli':
      return createWpCliTokenResolver(config);
    case 'rest':
      return createRestTokenResolver(config);
    case 'context':
      return createContextTokenResolver(config, options);
    case 'noop':
    default:
      return createNoopTokenResolver();
  }
}

interface ThemeJsonSettings {
  color?: {
    palette?: Array<{ slug?: string; color?: string }>;
    gradients?: Array<{ slug?: string; gradient?: string }>;
  };
  typography?: {
    fontFamilies?: Array<{ slug?: string; fontFamily?: string }>;
    fontSizes?: Array<{ slug?: string; size?: string }>;
  };
  spacing?: { spacingSizes?: Array<{ slug?: string; size?: string }> };
}

export function parseThemeJsonSettings(settings: ThemeJsonSettings | undefined): ResolvedTokens {
  const tokens: ResolvedTokens = { colors: {}, gradients: {}, fonts: {}, fontSizes: {}, spacing: {} };
  if (!settings || typeof settings !== 'object') {
    return tokens;
  }

  for (const entry of presetEntries(settings.color?.palette)) {
    if (isRecord(entry) && typeof entry.slug === 'string' && entry.slug && typeof entry.color === 'string' && entry.color) {
      tokens.colors[entry.slug] = entry.color;
    }
  }
  for (const entry of presetEntries(settings.color?.gradients)) {
    if (isRecord(entry) && typeof entry.slug === 'string' && entry.slug && typeof entry.gradient === 'string' && entry.gradient) {
      tokens.gradients![entry.slug] = entry.gradient;
    }
  }
  for (const entry of presetEntries(settings.typography?.fontFamilies)) {
    if (isRecord(entry) && typeof entry.slug === 'string' && entry.slug && typeof entry.fontFamily === 'string' && entry.fontFamily) {
      tokens.fonts[entry.slug] = entry.fontFamily;
    }
  }
  for (const entry of presetEntries(settings.typography?.fontSizes)) {
    if (isRecord(entry) && typeof entry.slug === 'string' && entry.slug && typeof entry.size === 'string' && entry.size) {
      tokens.fontSizes[entry.slug] = entry.size;
    }
  }
  for (const entry of presetEntries(settings.spacing?.spacingSizes)) {
    if (isRecord(entry) && typeof entry.slug === 'string' && entry.slug && typeof entry.size === 'string' && entry.size) {
      tokens.spacing[entry.slug] = entry.size;
    }
  }

  return tokens;
}

export function emptyTokens(): ResolvedTokens {
  return { colors: {}, gradients: {}, fonts: {}, fontSizes: {}, spacing: {} };
}

function presetEntries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
