/**
 * Engine C — the deterministic core (schema + assembler + realize).
 *
 * The thesis (md/13): an LLM is a high-coverage *recognizer*, not a markup author. So it
 * emits a typed block-INTENT tree (block names + nesting + which content goes where) and
 * NEVER raw markup; deterministic code turns that intent into blocks via createBlock() +
 * serialize(). Because the markup IS each block's own save() output, it is canonical and
 * VALID-BY-CONSTRUCTION — the gate becomes a backstop, not a halving tax. This is the file
 * that makes Engine C "valid by construction": no hand-written innerHTML ever, only
 * createBlock. Every failure is therefore bounded to wrong structure/attributes (measurable,
 * fixable), never invalid markup.
 *
 * This module is LLM-free and deterministic — it can be exercised in T0 against hand-authored
 * golden intent trees with zero model calls. The model call lives in engine-c.ts (propose).
 */
import { createHash } from 'node:crypto';
export { assemble, extractIntent, realize } from '../../src/intent/index.js';
export type { IntentNode, IntentTree } from '../../src/types.js';

// The brief the model answers: emit a typed block-intent tree, never markup.
export const INTENT_PROMPT = `You convert a web design (HTML) into a typed WordPress block-INTENT tree.

Output ONLY a JSON object describing the intended native block structure. Do NOT output any
block markup, HTML, or <!-- wp:... --> comments — only the intent JSON. Deterministic code
turns your intent into valid markup, so your job is purely to decide the right blocks, the
right nesting, and which text/image goes where.

Use CORE blocks only. Node shape:
  {
    "block": "core/<name>",
    "text":  "primary text (heading/paragraph/list-item content, button label, details question, quote)",
    "url":   "image src / cover background / media-text image / button href",
    "alt":   "image alt text",
    "level": 2,                    // heading level only
    "items": ["bullet one", ...],  // core/list bullets (or use core/list-item children)
    "rows": [["Plan","Price"],...],// core/table rows of cell text (first row = header)
    "citation": "...",             // core/quote or core/pullquote
    "attrs": { },                  // extra block attributes, e.g. {"mediaPosition":"right"},
                                   //   {"ordered":true} for a numbered list,
                                   //   {"service":"github","url":"..."} for core/social-link
    "children": [ ...nodes ]
  }
Top level: { "blocks": [ ...nodes ] }.

Available blocks: core/cover, core/columns, core/column, core/media-text, core/group,
core/heading, core/paragraph, core/list, core/list-item, core/buttons, core/button,
core/image, core/quote, core/pullquote, core/details, core/gallery, core/table, core/code,
core/separator, core/social-links, core/social-link.

Reproduce the design's visual structure with the most idiomatic native blocks. Preserve
layout — do NOT flatten it away. If content sits in columns, keep core/columns > core/column.

Wrap each distinct page SECTION (one band of the page: a hero, a feature row, an FAQ, a CTA
band, a logo strip) in a core/group that holds that section's blocks — UNLESS the section is a
full-bleed hero with a background image, which is core/cover instead (not a group). The top
level is therefore a list of one core/group (or core/cover) per section.

Containers nest. When content sits inside a visually distinct CARD, TILE, or overlaid PANEL
(a bordered/shadowed box, a pricing card, a bento tile, a content card laid over a hero), wrap
that card's blocks in their own core/group — the card is a real container block, not loose
blocks dropped into the parent. So: a pricing/feature card is core/column > core/group >
[heading, price, list, buttons]; a hero's overlay card is core/cover > core/group > [...]; a
bento grid is core/columns whose columns each hold ONE compound block (a core/media-text, a
core/cover, or a core/group) per tile. Keep every real nesting level — do not flatten a card
away.

Within a section, use the idiomatic mapping:
- The hero — the top-of-page banner carrying the main headline and primary call-to-action —
  → core/cover wrapping its content, EVEN IF its background is a solid color or gradient rather
  than an image. If the hero sets copy beside a product image, keep that as core/columns INSIDE
  the cover (the image is a core/image in a core/column — NOT core/media-text; media-text is
  only for mid-page feature rows, never the hero).
- Image beside text as a plain feature row (no background) → a core/group containing ONE
  core/media-text (image = media side; heading/paragraph/list/buttons = text side); never
  core/columns for this.
- FAQ / accordion → a core/group of a heading then one core/details per question (text = the
  question; a core/paragraph child = the answer).
- Logo / brand strip → a core/group holding an eyebrow core/paragraph then the logo core/image
  elements DIRECTLY (not core/columns — a flat row of logos is images in a group).
- CTA band → a core/group of the heading/paragraph and a core/buttons > core/button.
- Feature or pricing cards (equal columns) → a core/group of core/columns > core/column; each
  column holds its heading, paragraph(s), an optional core/list, and core/buttons.
- Stats / figures row → a core/group of core/columns > core/column; each column is TWO
  core/paragraph — the big number as a PARAGRAPH (not a heading; a stat figure has no
  document-outline role), then its label.
- Testimonials grid → a core/group of core/columns > core/column; each column is a core/quote
  (the testimonial text), a core/image (the avatar), and a core/paragraph (name / role).
- Image gallery / photo grid → a core/group of a heading then a core/gallery holding the
  core/image elements.
- A comparison / data / pricing-matrix table → a core/group of a heading then a core/table
  with its "rows" (first row the header). Use a real table, not columns, for tabular data.
- Long-form / article content → a core/group; a numbered step list is a core/list with
  attrs {"ordered":true}; a highlighted standout quote is a core/pullquote; a code sample is
  a core/code; a thematic divider between parts is a core/separator.
- A social bar / footer icon row → a core/group of a core/social-links holding one
  core/social-link per network, each with attrs {"service":"<name>","url":"<href>"}.

Output the JSON between a line ===INTENT_START=== and a line ===INTENT_END===. Do not run any
commands or write any files.

HTML:
`;

// Cache-invalidation hash: bumps whenever the prompt/schema changes, so the tuner's cache
// auto-invalidates and T0 reports affected fixtures as stale until a T1/T2 refresh (md/13).
export const PROMPT_HASH = `c-${createHash('sha256').update(INTENT_PROMPT).digest('hex').slice(0, 10)}`;
