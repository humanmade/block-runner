import type { FocusedContext, SiteContext, ThemeToken } from 'wesper';
import type { ResolvedTokens } from '../types.js';
import { emptyTokens } from './resolver.js';

/** Adapt Wesper's public native-preset records to Block Runner's value maps. */
export function tokensFromWesperContext(context: SiteContext | FocusedContext): ResolvedTokens {
  const resolved = emptyTokens();
  const tokens = isFocusedContext(context) ? context.tokens : context.theme?.tokens?.presets ?? [];

  for (const token of tokens) {
    switch (token.kind) {
      case 'color':
        resolved.colors[token.slug] = token.value;
        break;
      case 'font-family':
        resolved.fonts[token.slug] = token.value;
        break;
      case 'font-size':
        resolved.fontSizes[token.slug] = token.value;
        break;
      case 'spacing':
        resolved.spacing[token.slug] = token.value;
        break;
    }
  }
  return resolved;
}

/** FocusedContext is intentionally a projection, not a valid SiteContext. */
export function isFocusedContext(value: unknown): value is FocusedContext {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { kind?: unknown; tokens?: unknown };
  return candidate.kind === 'wesper.focused-context'
    && Array.isArray(candidate.tokens)
    && candidate.tokens.every(isThemeToken);
}

function isThemeToken(value: unknown): value is ThemeToken {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { kind?: unknown; slug?: unknown; value?: unknown };
  return (candidate.kind === 'color' || candidate.kind === 'font-family'
    || candidate.kind === 'font-size' || candidate.kind === 'spacing')
    && typeof candidate.slug === 'string'
    && typeof candidate.value === 'string';
}
