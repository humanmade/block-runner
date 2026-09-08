import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockRunnerConfig, CommonOptions, TokenResolver } from '../types.js';
import { emptyTokens, parseThemeJsonSettings } from './resolver.js';

const cache = new Map<string, ReturnType<typeof emptyTokens>>();
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

type PresetKind = 'color' | 'font-family' | 'font-size' | 'spacing';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePresetRegistry(presets: unknown) {
  if (!Array.isArray(presets)) {
    return emptyTokens();
  }

  const tokens = emptyTokens();
  const maps: Record<PresetKind, Record<string, string>> = {
    color: tokens.colors,
    'font-family': tokens.fonts,
    'font-size': tokens.fontSizes,
    spacing: tokens.spacing,
  };

  for (const preset of presets) {
    if (!isRecord(preset)) {
      return emptyTokens();
    }

    const { kind, slug, value } = preset;
    if (
      (kind !== 'color' && kind !== 'font-family' && kind !== 'font-size' && kind !== 'spacing') ||
      typeof slug !== 'string' ||
      slug.trim().length === 0 ||
      unsafeKeys.has(slug) ||
      typeof value !== 'string' ||
      value.trim().length === 0
    ) {
      return emptyTokens();
    }

    maps[kind][slug] = value;
  }

  return tokens;
}

export function createContextTokenResolver(config: BlockRunnerConfig, options: CommonOptions): TokenResolver {
  return {
    kind: 'context',
    async resolve() {
      const manifestPath = options.context ?? config.tokens?.context;
      if (!manifestPath) {
        return emptyTokens();
      }

      const resolved = path.resolve(manifestPath);
      const cached = cache.get(resolved);
      if (cached) {
        return cached;
      }

      if (!existsSync(resolved)) {
        return emptyTokens();
      }

      try {
        const manifest = JSON.parse(readFileSync(resolved, 'utf8')) as unknown;
        const theme = isRecord(manifest) && isRecord(manifest.theme) ? manifest.theme : undefined;
        const themeTokens = theme && isRecord(theme.tokens) ? theme.tokens : undefined;
        const tokens = themeTokens && Object.hasOwn(themeTokens, 'presets')
          ? parsePresetRegistry(themeTokens.presets)
          : parseThemeJsonSettings(theme?.settings as Parameters<typeof parseThemeJsonSettings>[0]);
        cache.set(resolved, tokens);
        return tokens;
      } catch {
        return emptyTokens();
      }
    },
  };
}
