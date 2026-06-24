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
import { createBlock, serializeBlocks } from '../../src/headless/wp.js';
import { validate } from '../../src/index.js';
import type { WpBlock, BlockRunnerReport, ConvertOptions } from '../../src/types.js';

/**
 * The intent node the model emits. Deliberately small: structure + content, plus a few
 * high-value attributes. The model decides *what block and where*; the assembler decides
 * *how to make that valid*. Unknown attributes are harmless — block save() ignores what it
 * doesn't know, so validity is never at risk from an over-eager model.
 */
export interface IntentNode {
  block: string; // a core/* block name
  text?: string; // primary text: heading/paragraph/list-item content, button label, details summary, quote
  url?: string; // image src, cover background, media-text media, button href
  alt?: string; // image / media-text alt
  level?: number; // heading level (default 2)
  citation?: string; // quote / pullquote citation
  items?: string[]; // convenience: list bullet strings (alternative to core/list-item children)
  rows?: string[][]; // core/table: rows of cell text (first row = header)
  attrs?: Record<string, unknown>; // any extra block attributes (mediaPosition, ordered, service, …)
  children?: IntentNode[];
}

export interface IntentTree {
  blocks: IntentNode[];
}

// Pull the intent JSON out of a model response however it wrapped it: the
// ===INTENT_START/END=== markers, a ```json fence, or the first balanced {...}/[...] span.
export function extractIntent(out: string): IntentTree {
  const marked = out.match(/===INTENT_START===([\s\S]*?)===INTENT_END===/);
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (marked ? marked[1] : fence ? fence[1] : out).trim();
  const json = body.startsWith('{') || body.startsWith('[') ? body : sliceFirstJson(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { blocks: [] };
  }
  return normalizeTree(parsed);
}

function sliceFirstJson(s: string): string {
  const start = s.search(/[{[]/);
  if (start === -1) return '';
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < s.length; i += 1) {
    if (s[i] === open) depth += 1;
    else if (s[i] === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return '';
}

// Accept { blocks: [...] }, a bare array of nodes, or a single root node.
function normalizeTree(parsed: unknown): IntentTree {
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as IntentTree).blocks)) {
    return { blocks: (parsed as IntentTree).blocks };
  }
  if (Array.isArray(parsed)) return { blocks: parsed as IntentNode[] };
  if (parsed && typeof parsed === 'object' && typeof (parsed as IntentNode).block === 'string') {
    return { blocks: [parsed as IntentNode] };
  }
  return { blocks: [] };
}

/**
 * Assemble an intent tree into a real WpBlock tree. Pure createBlock — no innerHTML — so the
 * serialized output is canonical and valid by construction. Each branch routes the node's
 * content into the block's own content attributes so it survives serialize() (and so the
 * benchmark's `contains` assertions land in the right block).
 */
export async function assemble(nodes: IntentNode[]): Promise<WpBlock[]> {
  const out: WpBlock[] = [];
  for (const node of nodes) {
    const block = await assembleNode(node);
    if (block) out.push(block);
  }
  return out;
}

async function assembleNode(node: IntentNode): Promise<WpBlock | null> {
  if (!node || typeof node.block !== 'string') return null;
  const name = node.block;
  const text = node.text;
  const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
  const children = await assemble(node.children ?? []);

  switch (name) {
    case 'core/heading':
      if (text != null) attrs.content = text;
      attrs.level = node.level ?? attrs.level ?? 2;
      return createBlock(name, attrs, []);

    case 'core/paragraph':
    case 'core/list-item':
      if (text != null) attrs.content = text;
      return createBlock(name, attrs, []);

    case 'core/button':
      if (text != null) attrs.text = text;
      if (node.url != null) attrs.url = node.url;
      return createBlock(name, attrs, []);

    case 'core/image':
      if (node.url != null) attrs.url = node.url;
      if (node.alt != null) attrs.alt = node.alt;
      return createBlock(name, attrs, []);

    case 'core/list': {
      let items = children;
      if (items.length === 0 && Array.isArray(node.items)) {
        items = [];
        for (const t of node.items) items.push(await createBlock('core/list-item', { content: t }, []));
      }
      return createBlock(name, attrs, items);
    }

    case 'core/quote': {
      if (node.citation != null) attrs.citation = node.citation;
      const body = children;
      if (body.length === 0 && text != null) body.push(await createBlock('core/paragraph', { content: text }, []));
      return createBlock(name, attrs, body);
    }

    case 'core/details':
      if (text != null) attrs.summary = text;
      return createBlock(name, attrs, children);

    case 'core/pullquote':
      // pullquote holds its text in `value` (not `content`), plus an optional citation.
      if (text != null) attrs.value = text;
      if (node.citation != null) attrs.citation = node.citation;
      return createBlock(name, attrs, []);

    case 'core/table': {
      // Build the table's head/body from rows of cell text (first row = header).
      if (Array.isArray(node.rows) && node.rows.length > 0) {
        const toCells = (row: string[], tag: 'th' | 'td'): { cells: { content: string; tag: string }[] } => ({
          cells: row.map((content) => ({ content, tag })),
        });
        attrs.head = [toCells(node.rows[0], 'th')];
        attrs.body = node.rows.slice(1).map((row) => toCells(row, 'td'));
      }
      return createBlock(name, attrs, []);
    }

    case 'core/cover':
      if (node.url != null) attrs.url = node.url;
      return createBlock(name, attrs, children);

    case 'core/media-text':
      if (node.url != null) {
        attrs.mediaUrl = node.url;
        attrs.mediaType = 'image';
      }
      if (node.alt != null) attrs.mediaAlt = node.alt;
      return createBlock(name, attrs, children);

    // Pure containers — structure only.
    case 'core/columns':
    case 'core/column':
    case 'core/buttons':
    case 'core/group':
    case 'core/gallery':
    case 'core/table':
      return createBlock(name, attrs, children);

    default:
      // An unrecognized name: still build it via createBlock so the gate (not us) judges it,
      // routing any text into a content attr. Keeps the assembler general, not a fixed list.
      if (text != null) attrs.content = text;
      return createBlock(name, attrs, children);
  }
}

/**
 * realize — the deterministic tail the tuner replays for free: intent JSON → blocks →
 * serialize → gate. Same BlockRunnerReport contract as every other engine.
 */
export async function realize(raw: string, _opts?: ConvertOptions): Promise<BlockRunnerReport> {
  const tree = extractIntent(raw);
  const blocks = await assemble(tree.blocks);
  const output = await serializeBlocks(blocks);
  const gate = await validate(output);
  return { ok: gate.ok, command: 'convert', summary: gate.summary, items: gate.items, output };
}

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
