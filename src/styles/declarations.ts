// The CSS declaration registry: which authored CSS properties Block Runner can carry onto a
// native block, and where they land.
//
// We own this table rather than importing one. `@wordpress/style-engine` holds the canonical
// style-path → CSS-property map, but it exports only `compileCSS`/`getCSSRules`/
// `getCSSValueFromRawStyle` — its internal `styleDefinitions` is not public API. It is the right
// oracle for tests (does our path produce the CSS we claim?) and the wrong thing to import.
//
// `supports` here is a *policy* key, not a serialization gate. The pinned serializer writes any
// style-engine-known key regardless of block supports, so gating is ours to enforce; we do it
// because an attribute the target editor gives the user no control over is styling they can see
// and cannot edit — the opposite of what this tool is for.

export type StyleTarget =
  /** Lands in the block's freeform `style` object attribute at `path`. */
  | { kind: 'style'; path: string[]; supports: SupportsQuery }
  /** The `background` shorthand — routed by value, since it folds colour/image/gradient into one. */
  | { kind: 'background' }
  /** Recognised, deliberately never emitted. `hint` points the fix upstream. */
  | { kind: 'refused'; hint: string };

export type SupportsQuery =
  | { feature: 'spacing'; key: 'padding' | 'margin'; side: BoxSide }
  | { feature: 'color'; key: 'text' | 'background' }
  | { feature: 'gradient' }
  | { feature: 'typography'; key: string }
  | { feature: 'border'; key: string }
  | { feature: 'dimensions'; key: string };

export const GRADIENT_TARGET: Extract<StyleTarget, { kind: 'style' }> = {
  kind: 'style',
  path: ['color', 'gradient'],
  supports: { feature: 'gradient' },
};

export const BACKGROUND_COLOR_TARGET: Extract<StyleTarget, { kind: 'style' }> = {
  kind: 'style',
  path: ['color', 'background'],
  supports: { feature: 'color', key: 'background' },
};

export type BoxSide = 'top' | 'right' | 'bottom' | 'left';

export const BOX_SIDES: BoxSide[] = ['top', 'right', 'bottom', 'left'];

/**
 * "Consumed" is deliberately narrow, and proven rather than inferred. A property-global consumed
 * list is worse than no list: it silently swallows declarations on blocks whose rule never read
 * them. Layout properties (`display`, `gap`, `flex-*`, `grid-*`) are NOT consumed by anything today
 * — no rule reads them — so they must be reported as dropped.
 *
 * For background images the proof comes from the rule itself (see `styles/provenance.ts`). Neither
 * cheaper test works: block name alone swallows the second URL in
 * `<img src="x.jpg" style="background-image:url(y.jpg)">`, and URL equality still guesses wrong
 * when the two coincide (`<img src="a.jpg" style="background-image:url(a.jpg)">` — that rule read
 * `src`, not the declaration).
 */

const REGISTRY = new Map<string, StyleTarget>([
  ['color', { kind: 'style', path: ['color', 'text'], supports: { feature: 'color', key: 'text' } }],
  [
    'background-color',
    { kind: 'style', path: ['color', 'background'], supports: { feature: 'color', key: 'background' } },
  ],
  // Routed by value: a colour maps, a gradient maps to color.gradient, an image belongs to the
  // structural rules, and a multi-component shorthand has no block home at all.
  ['background', { kind: 'background' }],

  // A background image only survives when the element became a media-bearing block (cover), which
  // isConsumedByStructure() checks. Reaching the registry means it did not.
  [
    'background-image',
    {
      kind: 'refused',
      hint: 'not the media this block carries — a background image only survives when a structural rule reads it as block media',
    },
  ],

  ...typography('font-size', 'fontSize'),
  ...typography('line-height', 'lineHeight'),
  ...typography('font-weight', 'fontWeight'),
  ...typography('font-style', 'fontStyle'),
  ...typography('font-family', 'fontFamily'),
  ...typography('letter-spacing', 'letterSpacing'),
  ...typography('text-transform', 'textTransform'),
  ...typography('text-decoration', 'textDecoration'),

  ['border-radius', { kind: 'style', path: ['border', 'radius'], supports: { feature: 'border', key: 'radius' } }],

  // WordPress 7.1's `dimensions.minWidth` support. It rides along free: the registry entry is
  // the same shape as everything else, and the supports gate limits it to blocks that opted in
  // (core/group only, as of the pinned block-library) without any version knowledge here.
  [
    'min-width',
    { kind: 'style', path: ['dimensions', 'minWidth'], supports: { feature: 'dimensions', key: 'minWidth' } },
  ],

  // WordPress 7.1 ships text-shadow in Global Styles only — theme.json
  // `styles.typography.textShadow`, with no block inspector control this release. The pinned
  // serializer *will* happily write it per-block (style-engine knows the key), which is exactly
  // why we refuse: it would render CSS the editor offers no control over.
  [
    'text-shadow',
    {
      kind: 'refused',
      hint: 'Global-Styles-only in WordPress 7.1 — set theme.json styles.typography.textShadow instead',
    },
  ],

  // Serialises as the `has-text-align-*` class rather than inline CSS, via the block-editor style
  // hooks that are part of the pinned set. It lands under `style.typography.textAlign` like any
  // other typography key — NOT as a top-level `textAlign` attribute, which core blocks do not
  // declare and `createBlock` therefore strips.
  ...typography('text-align', 'textAlign'),
]);

function typography(cssProperty: string, key: string): Array<[string, StyleTarget]> {
  return [[cssProperty, { kind: 'style', path: ['typography', key], supports: { feature: 'typography', key } }]];
}

/**
 * Look up a *longhand* CSS property. Shorthands are expanded before this is called; a shorthand
 * that reaches here has no entry and is reported as unmapped, which is the honest answer.
 */
export function lookupDeclaration(property: string): StyleTarget | undefined {
  const target = REGISTRY.get(property);
  if (target) {
    return target;
  }

  const box = matchBoxLonghand(property);
  if (box) {
    return {
      kind: 'style',
      path: ['spacing', box.key, box.side],
      supports: { feature: 'spacing', key: box.key, side: box.side },
    };
  }

  return undefined;
}

/**
 * Whether the block that was actually emitted consumed this declaration as structure.
 *
 * Requires an actual `url()`: the structural rules find backgrounds via a `url(...)` match, so
 * `background-image: linear-gradient(...)` is never read by them even on a cover, and claiming it
 * as consumed would lose it silently.
 *
 * `partial` marks a composite shorthand (`background: red url(a.jpg) center/cover`) where only the
 * image survives — the caller reports the components that did not.
 */
export function backgroundConsumption(
  property: string,
  value: string,
  /** Whether a rule *recorded* reading this element's background declaration. */
  wasRead: boolean,
): 'none' | 'full' | 'partial' {
  const carriesImage = property === 'background-image' || property === 'background';
  if (!carriesImage || !wasRead || !hasUrl(value)) {
    return 'none';
  }

  return isUrlOnly(value) ? 'full' : 'partial';
}

export function hasUrl(value: string): boolean {
  return /\burl\(/i.test(value);
}

/** The URL inside the first `url(...)`, unquoted and trimmed. Undefined when there is none. */
export function extractUrl(value: string): string | undefined {
  const match = /\burl\(\s*(['"]?)(.*?)\1\s*\)/i.exec(value);
  return match?.[2]?.trim() || undefined;
}


/** A value that is nothing but a single `url(...)` — no colour, position, size or repeat riding along. */
function isUrlOnly(value: string): boolean {
  return /^url\((?:[^()]|\([^()]*\))*\)$/i.test(value.trim());
}

/**
 * Classify a `background` shorthand. It folds colour, image, gradient, repeat and position into
 * one value, so only the cases with an unambiguous block home may be mapped.
 */
export function classifyBackground(value: string): 'image' | 'gradient' | 'color' | 'unmappable' {
  if (hasUrl(value)) {
    return 'image';
  }
  if (/\b(linear|radial|conic)-gradient\(/i.test(value)) {
    return 'gradient';
  }
  return isColorValue(value) ? 'color' : 'unmappable';
}

/**
 * A single colour token — hex, rgb()/hsl(), a var() reference, or a bare keyword. Deliberately
 * conservative: `none`, `transparent 0 0 / cover`, and multi-component shorthands fall through to
 * unmappable rather than being written into `style.color.background` as if they were colours.
 */
export function isColorValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) && !/^(rgb|rgba|hsl|hsla|color|var)\(/i.test(trimmed)) {
    return false;
  }
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) {
    return true;
  }
  if (/^(rgb|rgba|hsl|hsla|color|var)\([^()]*\)$/i.test(trimmed)) {
    return true;
  }
  if (/^(none|transparent|inherit|initial|unset|revert|currentcolor)$/i.test(trimmed)) {
    // Valid CSS, but none of these express a colour a block colour control can hold.
    return false;
  }
  return /^[a-z]+$/i.test(trimmed);
}

export function matchBoxLonghand(property: string): { key: 'padding' | 'margin'; side: BoxSide } | undefined {
  const match = /^(padding|margin)-(top|right|bottom|left)$/.exec(property);
  if (!match) {
    return undefined;
  }
  return { key: match[1] as 'padding' | 'margin', side: match[2] as BoxSide };
}
