import { WpBlock } from '../types.js';

/**
 * Which inline declarations a structural rule actually read.
 *
 * Consumption has to be *proven*, not inferred. Inferring it from the block's name swallows the
 * background in `<img src="x.jpg" style="background-image:url(y.jpg)">`; inferring it from URL
 * equality still guesses wrong when the two URLs coincide
 * (`<img src="a.jpg" style="background-image:url(a.jpg)">` — the rule read `src`, not the
 * declaration). Only the rule that read the declaration knows, so the rule records it here.
 *
 * A WeakMap rather than a field on WpBlock: this keys on a DOM node, which has no business in a
 * public exported type, and entries disappear with the blocks they describe.
 */
const consumedBackgrounds = new WeakMap<WpBlock, Map<Element, Set<string>>>();

/**
 * Called by a rule that lifted an element's inline background declaration into block media. The
 * URL is part of the record, not just the element: an element can carry two background
 * declarations (`background-image:url(a.jpg);background:url(b.jpg)`) while only one becomes media,
 * so element-level provenance alone would mark both consumed.
 */
export function recordConsumedBackground(block: WpBlock, element: Element, url: string): void {
  const byElement = consumedBackgrounds.get(block) ?? new Map<Element, Set<string>>();
  const urls = byElement.get(element) ?? new Set<string>();
  urls.add(normalizeUrl(url));
  byElement.set(element, urls);
  consumedBackgrounds.set(block, byElement);
}

/**
 * Whether a rule recorded reading *this* URL from *this* element. Provenance and value together:
 * provenance alone cannot tell two background declarations apart, and value alone cannot tell a
 * declaration the rule read from one that merely happens to share its URL.
 */
export function backgroundWasConsumed(block: WpBlock, element: Element, url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  return consumedBackgrounds.get(block)?.get(element)?.has(normalizeUrl(url)) ?? false;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}
