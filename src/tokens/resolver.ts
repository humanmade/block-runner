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
  color?: { palette?: Array<{ slug?: string; color?: string }> };
  typography?: {
    fontFamilies?: Array<{ slug?: string; fontFamily?: string }>;
    fontSizes?: Array<{ slug?: string; size?: string }>;
  };
  spacing?: { spacingSizes?: Array<{ slug?: string; size?: string }> };
}

export function parseThemeJsonSettings(settings: ThemeJsonSettings | undefined): ResolvedTokens {
  const tokens: ResolvedTokens = { colors: {}, fonts: {}, fontSizes: {}, spacing: {} };
  if (!settings || typeof settings !== 'object') {
    return tokens;
  }

  for (const entry of settings.color?.palette ?? []) {
    if (entry.slug && entry.color) {
      tokens.colors[entry.slug] = entry.color;
    }
  }
  for (const entry of settings.typography?.fontFamilies ?? []) {
    if (entry.slug && entry.fontFamily) {
      tokens.fonts[entry.slug] = entry.fontFamily;
    }
  }
  for (const entry of settings.typography?.fontSizes ?? []) {
    if (entry.slug && entry.size) {
      tokens.fontSizes[entry.slug] = entry.size;
    }
  }
  for (const entry of settings.spacing?.spacingSizes ?? []) {
    if (entry.slug && entry.size) {
      tokens.spacing[entry.slug] = entry.size;
    }
  }

  return tokens;
}

export function emptyTokens(): ResolvedTokens {
  return { colors: {}, fonts: {}, fontSizes: {}, spacing: {} };
}
