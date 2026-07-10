import { isForeignElement, stripUrlControlChars } from './dom.js';

// Tags Gutenberg's RichText round-trips inside a block's editable content. Anything outside
// this set (notably <svg>, <iframe>, <img>, and any block-level element) is either stripped
// by the editor on load or breaks block validation — so a block whose rich text contains it
// must fall back to Custom HTML rather than ship a lie (principles #4, #5).
const PHRASING_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i',
  'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time',
  'u', 'var', 'wbr',
]);

// Inline elements that carry meaning even when they hold no text.
const VOID_INLINE = new Set(['br', 'wbr', 'img', 'hr']);

// An element with no text and no void descendant renders nothing on its own.
function isEmptyInline(element: Element): boolean {
  return (element.textContent ?? '').trim() === '' && !element.querySelector('img, br, wbr, hr');
}

// Attributes that make an otherwise-empty element meaningful — a jump/scroll target, an
// icon-link, an accessible label, machine-readable time, etc. Such elements must survive
// (via atomic fallback), never be cleaned away as decoration. `aria-hidden` is the one aria
// attribute that signals the opposite — genuinely decorative.
function hasSemanticAttrs(element: Element): boolean {
  if (['id', 'name', 'href', 'title', 'datetime', 'role'].some((attr) => element.hasAttribute(attr))) {
    return true;
  }
  return [...element.attributes].some((attr) => {
    const name = attr.name.toLowerCase();
    return name.startsWith('aria-') && name !== 'aria-hidden';
  });
}

/**
 * Gutenberg's RichText silently drops empty formatting elements on save — a decorative
 * `<span class="chev" aria-hidden="true"></span>` (a common CSS hook in accordions/buttons)
 * makes the stored attribute mismatch what RichText regenerates, failing validation. Strip
 * those empty, non-void inline elements up front so the block is valid by construction. The
 * removed nodes render nothing, but the caller still reports the strip (nothing silent).
 */
export function cleanRichText(element: Element): { html: string; stripped: boolean } {
  const clone = element.cloneNode(true) as Element;
  let stripped = false;
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of [...clone.querySelectorAll('*')]) {
      if (VOID_INLINE.has(el.tagName.toLowerCase())) {
        continue;
      }
      if (!isEmptyInline(el)) {
        continue;
      }
      // Never strip a semantic element — those are handled by richTextSafe (atomic fallback).
      if (hasSemanticAttrs(el)) {
        continue;
      }
      el.remove();
      stripped = true;
      changed = true;
    }
  }
  return { html: clone.innerHTML.trim(), stripped };
}

export interface RichTextPolicy {
  /** Allowed inline tags; defaults to the shared phrasing set. */
  allow?: Set<string>;
  /**
   * Structural container tags to walk through without treating them as offenders — e.g. the
   * `ul`/`ol`/`li` of a nested list, whose inline contents are still checked. Their own tag is
   * not required to be phrasing-safe.
   */
  structural?: Set<string>;
}

export type RichTextCheck = { safe: true } | { safe: false; offender: Element; reason: string };

/**
 * Decide whether an element's descendant markup is safe to carry verbatim into a native
 * block's RichText attribute. Walks descendants (not a re-parse) and rejects on the first
 * unsupported tag, foreign (SVG/MathML) node, event handler, or javascript: URL. The returned
 * offender drives a source-located warning aimed at the input.
 */
export function richTextSafe(element: Element, policy: RichTextPolicy = {}): RichTextCheck {
  const allow = policy.allow ?? PHRASING_TAGS;
  const structural = policy.structural;

  for (const el of element.querySelectorAll('*')) {
    if (isForeignElement(el)) {
      return { safe: false, offender: el, reason: 'foreign element (SVG/MathML)' };
    }
    const tag = el.tagName.toLowerCase();
    if (structural?.has(tag)) {
      continue;
    }
    if (!allow.has(tag)) {
      return { safe: false, offender: el, reason: `<${tag}> is not RichText-safe` };
    }
    for (const attribute of el.attributes) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        return { safe: false, offender: el, reason: `event handler attribute ${attribute.name}` };
      }
    }
    // Match the scheme the way a browser resolves it — after stripping the whitespace/control
    // characters it ignores — so `java\nscript:` can't slip through.
    const url = stripUrlControlChars(el.getAttribute('href') ?? el.getAttribute('src') ?? '');
    if (/^(?:javascript|vbscript):/i.test(url)) {
      return { safe: false, offender: el, reason: 'javascript: URL in rich text' };
    }
    if (/^data:/i.test(url)) {
      return { safe: false, offender: el, reason: 'data: URL in rich text' };
    }
    // An empty, non-void element carrying semantic attributes (href/id/title/datetime/aria/…)
    // is meaningful — RichText would drop it on save, so it can't be cleaned away; keep the
    // whole enclosing block as Custom HTML instead.
    if (!VOID_INLINE.has(tag) && isEmptyInline(el) && hasSemanticAttrs(el)) {
      return { safe: false, offender: el, reason: 'empty element with semantic attributes not RichText-safe' };
    }
  }

  return { safe: true };
}
