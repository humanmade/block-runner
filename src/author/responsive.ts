/**
 * The two responsive style states WordPress 7.1 can emit for a block instance.
 * `desktop` is the unqualified/base style; it is deliberately not a state here.
 */
export type WordPressResponsiveViewport = 'mobile' | 'tablet';

/** The `settings.viewport` inputs accepted by WordPress 7.1 theme.json. */
export interface WordPressViewportSettings {
  mobile?: unknown;
  tablet?: unknown;
}

/** A resolved WordPress 7.1 responsive range, retaining the configured CSS lengths. */
export interface WordPressViewportRange {
  mobile?: { max: string };
  tablet?: { min?: string; max: string };
}

const DEFAULT_VIEWPORT_SETTINGS: { mobile: string; tablet: string } = {
  mobile: '480px',
  tablet: '782px',
};

// Keep the unit check byte-for-byte compatible with WordPress's PHP regex.
const LENGTH = /^(?:\d+|\d*\.\d+)(?:px|em|rem)$/;
const CSS_LENGTH = '((?:\\d+|\\d*\\.\\d+)(?:px|em|rem))';
const CANONICAL_MOBILE = new RegExp(`^\\(\\s*width\\s*<=\\s*${CSS_LENGTH}\\s*\\)$`, 'i');
const MAX_WIDTH = new RegExp(`^\\(\\s*max-width\\s*:\\s*${CSS_LENGTH}\\s*\\)$`, 'i');
const CANONICAL_TABLET = new RegExp(`^\\(\\s*${CSS_LENGTH}\\s*<\\s*width\\s*<=\\s*${CSS_LENGTH}\\s*\\)$`, 'i');

function validLength(value: unknown): value is string {
  return typeof value === 'string' && LENGTH.test(value.trim());
}

function pixelsForOrdering(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized.endsWith('rem')) return Number.parseFloat(normalized.slice(0, -3)) * 16;
  if (normalized.endsWith('em')) return Number.parseFloat(normalized.slice(0, -2)) * 16;
  return Number.parseFloat(normalized.slice(0, -2));
}

/**
 * Reproduce `WP_Theme_JSON::sanitize_viewport_settings()` / `get_viewport_media_queries()`.
 * Invalid lengths are ignored, an entirely-invalid input falls back to WordPress defaults, and
 * a tablet breakpoint that is not strictly larger than mobile is removed.
 */
export function resolveWordPressViewportRanges(settings?: WordPressViewportSettings): WordPressViewportRange {
  const input = settings && typeof settings === 'object' ? settings : undefined;
  const mobile = input?.mobile;
  const tablet = input?.tablet;
  const validMobile = validLength(mobile) ? mobile.trim() : undefined;
  const validTablet = validLength(tablet) ? tablet.trim() : undefined;

  if (!validMobile && !validTablet) {
    return { mobile: { max: DEFAULT_VIEWPORT_SETTINGS.mobile }, tablet: { min: DEFAULT_VIEWPORT_SETTINGS.mobile, max: DEFAULT_VIEWPORT_SETTINGS.tablet } };
  }
  if (validMobile && !validTablet) return { mobile: { max: validMobile } };
  if (!validMobile && validTablet) return { tablet: { max: validTablet } };

  // Both lengths are valid here. WordPress compares em/rem using a 16px base solely for
  // ordering, while retaining the authored units in the generated media query.
  if (pixelsForOrdering(validMobile!) >= pixelsForOrdering(validTablet!)) {
    return { mobile: { max: validMobile! } };
  }
  return { mobile: { max: validMobile! }, tablet: { min: validMobile!, max: validTablet! } };
}

function sameLength(left: string, right: string): boolean {
  // Matching a configured WordPress query is intentionally textual after insignificant space
  // and case normalization. Cross-unit conversion would guess browser initial font semantics.
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Maps a media prelude to a WordPress 7.1 state only when its whole width interval is exactly
 * one emitted by `get_viewport_media_queries()`. It intentionally rejects min-width shorthand:
 * CSS min-width is inclusive, whereas the WordPress tablet lower bound is exclusive.
 */
export function mapExactWordPressResponsiveMedia(
  sourcePrelude: string,
  settings?: WordPressViewportSettings,
): WordPressResponsiveViewport | undefined {
  if (typeof sourcePrelude !== 'string') return undefined;
  const prelude = sourcePrelude.trim();
  if (!prelude || /,|\b(?:not|only|screen|print|all)\b/i.test(prelude)) return undefined;
  const ranges = resolveWordPressViewportRanges(settings);

  const mobile = prelude.match(CANONICAL_MOBILE) ?? prelude.match(MAX_WIDTH);
  if (mobile && ranges.mobile && sameLength(mobile[1]!, ranges.mobile.max)) return 'mobile';

  const tablet = prelude.match(CANONICAL_TABLET);
  if (
    tablet
    && ranges.tablet?.min
    && sameLength(tablet[1]!, ranges.tablet.min)
    && sameLength(tablet[2]!, ranges.tablet.max)
  ) return 'tablet';

  return undefined;
}
