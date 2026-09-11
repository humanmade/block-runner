# `assemble` — describe the structure, get valid blocks

This is §3 of the [agent guide](GUIDE.md). Read §1 there to confirm `assemble` is the right
command before describing a structure.

You emit a JSON tree describing *what blocks and where*. Deterministic code turns that into
markup. You never write `<!-- wp:... -->` markup yourself — that is the whole point. Writing
block markup by hand is how invalid output happens; this path cannot produce it.

```bash
printf '%s' "$INTENT_JSON" | npx -y block-runner@latest assemble - --json
```

## Node shape

```json
{
  "block": "core/<name>",
  "text":  "primary text — heading/paragraph/list-item content, button label, details question, quote",
  "url":   "image src / cover background / media-text image / button href",
  "alt":   "image alt text",
  "level": 2,
  "items": ["bullet one", "bullet two"],
  "rows":  [["Plan", "Price"], ["Pro", "$20"]],
  "citation": "who said it",
  "attrs": { "mediaPosition": "right" },
  "children": [ ]
}
```

Top level is `{ "blocks": [ ...nodes ] }`.

`attrs` is an open passthrough — put any extra block attribute there (`{"ordered": true}` for
a numbered list, `{"service": "github", "url": "..."}` for a social link). Unknown attributes
are harmless; a block ignores what it does not recognise.

## Available blocks

`core/cover`, `core/columns`, `core/column`, `core/media-text`, `core/group`, `core/heading`,
`core/paragraph`, `core/list`, `core/list-item`, `core/buttons`, `core/button`, `core/image`,
`core/quote`, `core/pullquote`, `core/details`, `core/gallery`, `core/table`, `core/code`,
`core/separator`, `core/social-links`, `core/social-link`, `core/video`, `core/audio`,
`core/embed`, `core/file`, `core/accordion`, `core/accordion-item`,
`core/accordion-heading`, `core/accordion-panel`.

## Structural rules

Reproduce the design's visual structure with the most idiomatic native blocks. Preserve
layout — do not flatten it away. If content sits in columns, keep `core/columns > core/column`.

**Sections.** Wrap each distinct band of the page (a hero, a feature row, an FAQ, a CTA band,
a logo strip) in a `core/group` holding that section's blocks — unless it is a full-bleed hero
with a background image, which is `core/cover` instead. So the top level is a list of one
`core/group` (or `core/cover`) per section.

**One wrapper per section.** That section group is the *only* wrapper, and everything in the
band goes directly inside it — including repeated items. Three feature rows are three
`core/media-text` siblings in one section group, not three groups of one. Do not add a
container the design does not actually show: an extra wrapper is a structural error, exactly
like a missing one.

**Containers nest — when the design shows a container.** When content sits inside a *visibly*
distinct card, tile, or overlaid panel — one with its own border, shadow, or background fill —
wrap that card's blocks in their own `core/group`. The visible boundary is what makes it a
card. Content merely sitting in a column, or in a repeated row, is not a card and takes no
extra group. When a card is real, it is a real container block, not loose blocks dropped into
the parent:

- pricing/feature card → `core/column > core/group > [heading, price, list, buttons]`
- hero overlay card → `core/cover > core/group > [...]`
- bento grid → `core/columns` whose columns each hold ONE compound block per tile. **Keep each
  tile's own idiomatic block rather than flattening it**: a tile that is text over a background
  image is a `core/cover`; a tile that is an image beside text is a `core/media-text`; a tile
  that is a plain bordered box of copy is a `core/group`. A bento grid is a grid OF compound
  blocks — dropping loose headings and paragraphs straight into the column loses the tile

Keep every real nesting level.

**Idiomatic mappings:**

- **Hero** (top-of-page banner with the main headline and primary CTA) → `core/cover`, even
  when the background is a solid colour or gradient rather than an image. If the hero sets
  copy beside a product image, that is `core/columns` *inside* the cover, with the image as a
  `core/image` in a `core/column` — not `core/media-text`.
- **Image beside text as a mid-page feature row** → a `core/media-text` (image on the media
  side, heading/paragraph/list/buttons on the text side). Never `core/columns` for this. Where
  several such rows alternate down the page, they are sibling `core/media-text` blocks sharing
  the one section group — do not give each row a group of its own.
- **FAQ / accordion (a SET of collapsible panels)** → `core/group` of a heading then ONE
  `core/accordion`, holding one `core/accordion-item` per question. Each item is a
  `core/accordion-heading` plus a `core/accordion-panel` whose answer is a `core/paragraph`
  child. **The heading's text goes in `attrs {"title": "..."}`, NOT `text` or `content`** —
  it is the one text block in core that does not use `content`, and getting it wrong produces
  a perfectly valid accordion with blank headings, which nothing will warn you about.
  A SINGLE standalone disclosure (one lone expandable item, not a set) stays `core/details`
  (`text` = the summary, a `core/paragraph` child = the body).
- **Logo / brand strip** → `core/group` holding an eyebrow `core/paragraph` then the logo
  `core/image` elements directly. A flat row of logos is images in a group, not columns.
- **CTA band** → `core/group` of the heading/paragraph and `core/buttons > core/button`.
- **Feature or pricing cards** → `core/group` of `core/columns > core/column > core/group`;
  the inner group holds the card heading, paragraphs, optional `core/list`, and
  `core/buttons`. The visible card boundary is a real container.
- **Stats / figures row** → `core/group` of `core/columns > core/column`; each column is TWO
  `core/paragraph` — the big number as a paragraph (a stat figure has no document-outline
  role, so it is not a heading), then its label. If each stat has its own visible border,
  shadow, or fill, preserve it as `core/column > core/group >` the two paragraphs.
- **Testimonials grid** → `core/group` of `core/columns > core/column`; each column holds a
  `core/quote` (the testimonial), a `core/image` (avatar), and a `core/paragraph` (name/role)
  directly — no group around them, even when the testimonial reads as a card.
- **Self-hosted video** (a `<video>` with a file source) → `core/video`, preserving
  `attrs {"src": "...", "poster": "...", "controls": true, "caption": "..."}` as the
  source requires. A caption belongs on the block's own `caption` attribute, not a sibling
  paragraph.
- **Third-party video / social embed** (YouTube, Vimeo, X, Spotify — an `<iframe>` or a bare
  provider URL) → `core/embed`, with the WATCH-PAGE URL and caption in
  `attrs {"url": "...", "caption": "...", "allowResponsive": true}` when responsive output
  is requested. Do not reach for `core/video`: that is for self-hosted files only, and never
  leave an `<iframe>` to fall through to Custom HTML.
- **Audio / podcast player** → `core/audio`, preserving the file and caption in
  `attrs {"src": "...", "caption": "..."}`.
- **Downloadable file** (a link to a PDF or similar, often with a download button) →
  `core/file`, with `attrs {"href": "...", "fileName": "...", "showDownloadButton": true,
  "downloadButtonText": "<the visible source label>"}` when the source shows that button
  (`"Download"` when that is the label). The block can render its own button, but its label is
  not automatic—never emit an empty download link. Do not
  add a `core/button` beside it, and do not settle for a link in a paragraph.
- **Gallery / photo grid** → `core/group` of a heading then a `core/gallery` of `core/image`.
- **Comparison / data / pricing matrix** → `core/group` of a heading then a `core/table` with
  its `rows` (first row is the header). Use a real table for tabular data, not columns.
- **Long-form article content** → a `core/group`; a numbered step list is a `core/list` with
  `attrs {"ordered": true}`; a standout quote is `core/pullquote`; a code sample is
  `core/code`; a thematic divider is `core/separator`.
- **Social bar / footer icon row** → `core/group` of a `core/social-links` holding one
  `core/social-link` per network, each with `attrs {"service": "<name>", "url": "<href>"}`.

## Native Query Loop

The intent route accepts a native `core/query` containing `core/post-template` with dynamic
post fields, plus sibling `core/query-pagination` and `core/query-no-results` blocks. Supply
explicit query settings such as `inherit: false`, `postType`, `perPage`, `order`, and `orderBy`
when the query should be independent of the containing page. Dynamic post titles are rendered
by WordPress; do not replace them with hardcoded text to make saved markup look populated.

The repository's focused WordPress proof covers this shape with two isolated posts, one result
per page, Next/Previous navigation, a filtered empty state, and clean save/reopen. This is native
intent output, not automatic Query inference from HTML or custom PHP-renderer generation.
Use the project's actual taxonomy IDs and verify the result on the target site.

## Reading the result

`assemble` runs the same validity gate as everything else, so valid output is proven, not
assumed. It fails loudly rather than quietly: malformed JSON, or JSON with no blocks in it,
exits `1` with a reason — it will never hand you a clean empty result. A block name that is
not registered produces a warning naming that node.
