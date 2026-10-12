import type { WpBlock, WpModules } from '../types.js';

/**
 * Build the Custom HTML fallback block.
 *
 * `core/html` changed shape in @wordpress/block-library 10.5.0 (WordPress 7.1): its `content`
 * attribute lost `source: 'raw'` and became `role: 'local'`, and its `save()` now returns null
 * with the note that "the block's markup is serialized from its innerContent". Passing the
 * markup as an attribute alone therefore serializes to a bare `<!-- wp:html /-->` — a fallback
 * that silently discards the very markup it exists to preserve.
 *
 * Fallbacks are the safety net for everything we cannot convert, so losing their payload is the
 * worst failure this codebase can have: output that looks clean while discarding its input.
 * The attribute is still set, for editors that read it; `innerContent` is what actually
 * survives serialization.
 */
export function createHtmlFallback(wp: WpModules, html: string, attrs: Record<string, unknown> = {}): WpBlock {
  const block = wp.createBlock('core/html', { ...attrs, content: html }, []) as WpBlock & {
    innerContent?: unknown[];
    originalContent?: string;
  };
  block.innerContent = [html];
  block.originalContent = html;
  return block;
}
