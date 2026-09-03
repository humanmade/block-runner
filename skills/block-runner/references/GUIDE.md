# Block Runner — agent guide

You are an AI agent producing or checking WordPress content. Block Runner is the tool that
gets it into the editor as real, native, editable blocks instead of one frozen HTML blob.

This guide is harness-neutral. Read it and act on it directly, or install it as a skill —
see the end.

Conversion, assembly, and validation run locally and deterministically. Block Runner never
calls a model and never needs an API key. An uncached `npx` invocation still needs npm registry
access to fetch the package. **You** are the model in this pipeline.

---

## 1. Pick the right command

| You need | Use | Why |
|---|---|---|
| A reusable named block that must live in plugin or theme source | **`author preview`** → confirmation → **`author write`**, then package and proof it | This produces registered-block source. It is not page `post_content`. |
| New content for a page or post, with no authored HTML | **`assemble`** | An intent tree becomes native page blocks. |
| Existing authored HTML that must become page or post `post_content` | **`convert`** | Rule-based translation of existing markup, and the only content path that carries CSS. Do not use frontend-scraped render output. |
| Block markup you already produced, before saving it to WordPress | **`validate`** → **`fix`** → **`validate`** | Proves the editor will accept it. |

Choose by the requested artifact, not merely by the input format. A supplied HTML design still
uses registered-block authoring when the user wants a reusable named block in code. Conversely,
`convert` and `assemble` produce page `post_content`; they do not create a plugin block source
package. Never use `convert` as a shortcut to author registered-block source.

The single most common mistake is reaching for `convert` when you were about to author the
HTML yourself. If you are the one inventing the structure, do not write HTML and convert it —
describe the structure to `assemble` directly. You will get better blocks with less work.

**The exception that matters:** if the input has meaningful CSS you need to preserve —
brand colours, custom spacing, a specific look — use `convert`, not `assemble`. An intent
tree carries structure and content, not styling, so `assemble` will produce clean but plainer
blocks. `convert --styling relaxed` keeps exact off-theme values on the block. If you are
unsure whether the styling matters, ask the user rather than silently flattening their design.

---

## 2. Registered-block authoring — plan, preview, confirm, write, prove

Use this path for one reusable `namespace/slug` block source package. The model interprets the
design and produces the versioned declarative **`AuthoringPlan`**; the deterministic source
generator produces all executable source and serializes blocks. This is deliberately different
from converting a design into page `post_content`.

### The model's job: make the authoring plan, never the implementation

The plan must state the target identity and **final** destination, native structure, field modes
(`fixed`, `editable`, or `override`), locking, style and asset dispositions, pattern-override
fields, planned outputs, and every warning. Make material choices explicit: which content can be
edited, which structure is locked, what maps to native/theme support, what requires scoped CSS,
which assets are available, and which fields a pattern may override. A missing destination is a
question for the user, not permission to use a temporary directory.

The plan is declarative JSON only. Do **not** emit or ask the user to paste React, JSX, TSX,
PHP, `block.json` or other block metadata, generated CSS, `registerBlockType` or
`register_block_type` calls, or `<!-- wp:… -->` delimiters. Do not put executable source in a
plan's file content. The generator owns executable source and block serialization; the model
owns the reviewable design decisions.

### `AuthoringPlan` v1 shape

The CLI accepts exactly this versioned JSON shape. Object keys may be in any order; arrays retain
their order and every listed value participates in the confirmation hash. `files` names the
generated source outputs and uses only safe relative POSIX paths. The fields are required, though
the arrays may be empty when a design genuinely has none of that item.

| Field | Required shape |
|---|---|
| `version` | The number `1`. |
| `generatorVersion` | Non-empty generator version string. |
| `target` | `{ "name": "namespace/slug", "title": "…" }`; optional `description`, `category`, `icon`, `textDomain`, `wordpress`, and safe relative `directory`. |
| `structure` | Ordered native nodes: `block`, optional stable `id`, `label`, JSON `attributes`, `lock`, and recursive `children`. Never HTML. |
| `fields` | Ordered `{ "id", "label", "mode" }` records; `mode` is exactly `fixed`, `editable`, or `override`. Optional `node`, `attribute`, `type`, `default`, and `description` explain the editor surface. |
| `locking` | `{ "mode": "all" | "contentOnly" | "none" }`, with optional boolean `move`, `remove`, and `insert`. |
| `styles` | `{ "strategy": "native" | "scoped-css" | "mixed", "outcomes": [] }`; an outcome has `property`, `outcome` (`native`, `token`, `scoped-css`, or `dropped`) and optional `value`, `token`, and `reason`. |
| `pattern` | `{ "ready": boolean, "overrides": [{ "field": "<field id>" }] }`, with optional override label and description. |
| `assets` | `{ "id", "source" }` records with optional `kind`, safe relative `destination`, `status` (`ready`, `missing`, `external`), and `required`. |
| `files` | `{ "path" }` records with optional `kind` and `operation` (`create` or `replace`; default `create`). `plannedFiles` is accepted only as an input alias and canonicalizes to `files`. |
| `warnings` | Ordered, non-empty warning strings; use `[]` when there are none. |

Here is a complete valid plan. Replace its identity, structure, decisions, and retained final
destination for the supplied design; do not copy its values blindly.

```json
{
  "version": 1,
  "generatorVersion": "0.9.0-preview.1",
  "target": {
    "name": "acme/feature-grid",
    "title": "Feature grid",
    "description": "A reusable feature grid.",
    "category": "design",
    "textDomain": "acme",
    "wordpress": "7.1",
    "directory": "blocks/acme-feature-grid"
  },
  "structure": [
    {
      "id": "root",
      "block": "core/group",
      "label": "Feature grid",
      "attributes": { "layout": { "type": "constrained" } },
      "lock": { "move": false, "remove": false },
      "children": [
        {
          "id": "heading",
          "block": "core/heading",
          "label": "Heading",
          "attributes": { "level": 2 }
        }
      ]
    }
  ],
  "fields": [
    {
      "id": "heading",
      "label": "Heading",
      "mode": "editable",
      "type": "rich-text",
      "node": "heading",
      "attribute": "content"
    },
    {
      "id": "layout",
      "label": "Layout",
      "mode": "fixed",
      "type": "layout"
    },
    {
      "id": "accent",
      "label": "Accent",
      "mode": "override",
      "type": "color"
    }
  ],
  "locking": { "mode": "contentOnly", "move": false, "remove": false, "insert": false },
  "styles": {
    "strategy": "mixed",
    "outcomes": [
      { "property": "color", "outcome": "token", "token": "accent" },
      { "property": "display", "outcome": "scoped-css", "value": "grid", "reason": "No native support." }
    ]
  },
  "pattern": { "ready": true, "overrides": [{ "field": "accent", "label": "Accent" }] },
  "assets": [
    { "id": "logo", "source": "assets/logo.svg", "kind": "svg", "destination": "assets/logo.svg", "status": "ready", "required": true }
  ],
  "files": [
    { "path": "block.json", "kind": "metadata", "operation": "create" },
    { "path": "index.js", "kind": "editor", "operation": "create" },
    { "path": "style.css", "kind": "style", "operation": "create" }
  ],
  "warnings": []
}
```

### Preview the exact plan before asking

```bash
npx -y block-runner@latest author preview authoring-plan.json \
  --output-dir <exact-final-destination>
```

`author preview` writes no files. Before requesting consent, paste the literal plain-text
terminal output verbatim. Do not replace the structure tree or the `Warnings` section with a
prose summary. The user must see the full confirmation SHA-256, destination, destination
fingerprint, tree, planned files, replacement markers, and warnings — including the `Warnings`
section when it says `- none`, and `No files written.`

Only after showing that exact preview, ask a clear question such as: “Approve writing exactly
plan `<full hash>` to `<destination>`?” If replacements are listed, name them and obtain a
separate explicit replacement approval. A general “go ahead”, a changed plan, a changed
destination, or a changed destination fingerprint is not approval. The CLI is deliberately
non-interactive; it never obtains conversational consent for you.

### Write, then finish the delivery

After that exact approval, run:

```bash
npx -y block-runner@latest author write authoring-plan.json \
  --confirm '<full preview hash>' \
  --output-dir '<exact previewed destination>'
```

Use the full hash and exact destination from the preview. If either changes, preview again and
obtain fresh consent. Do not write into `mktemp`, an auto-deleted staging folder, or an
unspecified location. A source package is incomplete until it lands in the requested existing
plugin or retained standalone-plugin directory.

### Existing-plugin output

Use this only after inspecting the target plugin. Do not guess its build or registration layout.

```bash
npx -y block-runner@latest plugin inspect <plugin-root>
npx -y block-runner@latest plugin preview <generated-block-dir> --host <plugin-root>
# Show this complete preview, then obtain its displayed fingerprint and any separate replacement approvals.
npx -y block-runner@latest plugin write <generated-block-dir> --host <plugin-root> \
  --confirm '<plugin preview fingerprint>' \
  --approve-replace '<each explicitly approved path>'
```

Write the generated block directly below the existing plugin's lasting source directory, not a
temporary directory. If `plugin inspect` says the layout is unsupported, stop and offer
standalone output rather than improvising registration or a build configuration.

### Standalone-plugin output

Use a retained, explicitly named plugin directory. Preview the wrapper before it is written,
then build the final plugin archive from that same directory.

```bash
npx -y block-runner@latest plugin preview <generated-block-dir> \
  --standalone <retained-plugin-directory>
# Show this complete preview, then obtain its displayed fingerprint and any replacement approvals.
npx -y block-runner@latest plugin write <generated-block-dir> \
  --standalone <retained-plugin-directory> \
  --confirm '<plugin preview fingerprint>'
```

### Proof is part of completion

Headless validation, source generation, or a successful build is not a full success claim. Build
the final plugin ZIP and run a full proof against the exact reviewed input and generated package:

```bash
npx -y block-runner@latest proof dist/acme-feature-grid.zip \
  --profile full \
  --input designs/feature-grid.html \
  --markup fixtures/feature-grid.blocks.html \
  --fixture fixtures/feature-grid.proof.json \
  --receipt-dir artifacts/proof
```

Call the result fully successful only after a passing immutable `proof --profile full` receipt.
That profile must include real WordPress runtime registration/activation and editor gates plus a
passing `pattern_overrides` gate. `skip`, `blocked`, missing, or failed runtime or override gates
mean the source is still unproven; report it as incomplete rather than successful.

---

## 3. `assemble` — describe the structure, get valid blocks

You emit a JSON tree describing *what blocks and where*. Deterministic code turns that into
markup. You never write `<!-- wp:... -->` markup yourself — that is the whole point. Writing
block markup by hand is how invalid output happens; this path cannot produce it.

```bash
printf '%s' "$INTENT_JSON" | npx -y block-runner@latest assemble - --json
```

### Node shape

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

### Available blocks

`core/cover`, `core/columns`, `core/column`, `core/media-text`, `core/group`, `core/heading`,
`core/paragraph`, `core/list`, `core/list-item`, `core/buttons`, `core/button`, `core/image`,
`core/quote`, `core/pullquote`, `core/details`, `core/gallery`, `core/table`, `core/code`,
`core/separator`, `core/social-links`, `core/social-link`, `core/video`, `core/audio`,
`core/embed`, `core/file`, `core/accordion`, `core/accordion-item`,
`core/accordion-heading`, `core/accordion-panel`.

### Structural rules

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

### Reading the result

`assemble` runs the same validity gate as everything else, so valid output is proven, not
assumed. It fails loudly rather than quietly: malformed JSON, or JSON with no blocks in it,
exits `1` with a reason — it will never hand you a clean empty result. A block name that is
not registered produces a warning naming that node.

---

## 4. `convert` — someone else's HTML into page `post_content`

```bash
printf '%s' "$PASTED_HTML" | npx -y block-runner@latest convert - --json
```

Rule-based, no model involved. It produces native blocks where it can and falls back to a
`core/html` (Custom HTML) block where it cannot. Output is always valid — but a fallback is
editable as a blob, not as native blocks, so **check the report for fallbacks and tell the
user**. Do not present a run full of `core/html` as a clean conversion.

`convert` handles messy real-world markup far less well than `assemble` handles a structure
you describe. If the HTML came from a design tool and converts badly, consider reading the
design yourself and describing it as an intent tree instead.

### Styling

`--styling` applies to `convert` only.

| Level | What it does |
|---|---|
| `strict` | Map to the theme only. Off-theme styles are dropped. Cleanest and fully on-brand. |
| `relaxed` *(default)* | Keep exact off-theme values on the block. Still native and fully editable. |
| `open` | Also keep CSS no block can express, via a class plus a stylesheet you ship alongside. Requires `--css-out <path>` or `--json`. |

---

## 5. The pre-flight loop — before page markup is saved

Run this on block markup before you write it to WordPress:

```bash
npx -y block-runner@latest validate variant.html --json
# exit 1 → repair and re-check
npx -y block-runner@latest fix variant.html --out variant.fixed.html
npx -y block-runner@latest validate variant.fixed.html --json
```

Or through stdin, no temp file: `printf '%s' "$MARKUP" | npx -y block-runner@latest validate -`

- **Pass** (exit 0) → present the markup.
- **Near-miss** (validate 1 → fix 0 → validate 0) → present the *repaired* markup.
- **Hard-invalid** (fix exits 1, still invalid) → do **not** present it and do not send it to
  a write endpoint. Surface the failing block and line to the user.

### Always pass `--json`

Without it, the default output is the markup alone and the report items are dropped — you
will miss warnings, fallbacks, and source locations. With it you get:

```json
{
  "ok": false,
  "command": "validate",
  "summary": { "blocks": 2, "valid": 0, "invalid": 2, "warnings": 0 },
  "items": [
    { "block": "core/cover", "status": "invalid",
      "reason": "<why it failed>", "source": { "path": "-", "htmlLine": 1, "htmlColumn": 1 } }
  ]
}
```

Read `.ok` and `.summary.invalid` for the verdict, `.items[].source.htmlLine` for the location.

### Exit codes

`0` success · `1` invalid or unrepairable · `2` usage error · `3` headless boot failure.

---

## 6. Where page blocks go

Producing valid markup is not the end of the job. Every run ends in one of three places, and
you pick based on what is available — never leave the markup sitting in a temp file or scroll
past in your own output.

**The user named a destination** (a file, a page, a post) → put it there. If they named an
existing page and it already has content, ask before replacing it. Overwriting someone's page
is not yours to assume.

**A WordPress connection is available** — an MCP server, WP-CLI, REST credentials already in
the environment → offer to write it. Say which page or post you would write to and get a yes
first, unless they already told you. Block markup goes in the post content field as-is; it
does not need escaping or wrapping.

**No connection and no destination** → show the user the markup and tell them how to use it:

> Open the page in the WordPress editor, switch to the Code editor
> (**Options ⋮ → Code editor**, or `Ctrl+Shift+Alt+M`), paste, then switch back to the
> visual editor. The blocks will appear as normal, editable blocks.

That last instruction matters. Pasting block markup into the *visual* editor produces a mess;
into the Code editor it becomes real blocks. A user who does not know this will conclude the
tool is broken.

**Always say what you did** — where it went, how many blocks, and anything that fell back to
Custom HTML. A silent success is indistinguishable from a silent failure.

---

## 7. Matching the user's site

Optional, and worth it when you know the target site.

- **Brand tokens** — `--token-resolver <noop|file|wpcli|rest|context>` rewrites hardcoded
  colours, fonts, and spacing to the site's own preset slugs, so output lands on-brand and
  stays editable through the theme. Pair with `--theme-json <path>` or the site credentials.
- **Media** — `--resolver <noop|map|wpcli|rest>` turns image URLs into real attachment IDs.
  Without it, images reference bare URLs and are not proper media library items.
- **Credentials** — application passwords come from an environment variable via
  `--wp-app-password-env <NAME>`, never as a command-line argument. Do not put a password in
  argv; it is visible in process listings and shell history.

---

## 8. Failure posture

Block Runner is an assist, not a gate that can strand the user.

- **`npx` missing, no network on first fetch, timeout, or exit `3`** → skip validation, fall
  back to your own checks, and tell the user automated validation was unavailable.
- **Exit `2` (usage error)** → say so loudly. That means a broken invocation or a changed CLI
  contract, not an infrastructure blip. Do not let it silently disable the check.
- Time-box every call (~60s cold, less when warm) and treat a hang as unavailable.

**First run is slow.** Cold start is roughly 30–60s while `@wordpress/blocks` and `jsdom` are
fetched; warm runs are 1–2s. The first fetch prints npm peer-dependency warnings on stderr —
harmless. Read results from stdout or `--json`. Users who run this often can
`npm i -g block-runner` to skip the cold start.

---

## 9. Installing this as a skill

If your harness supports skills, install the canonical skill into the current project:

```bash
npx -y block-runner@latest skill --install
```

That writes the same skill to the cross-agent `.agents/skills/block-runner` location and to
Claude Code's `.claude/skills/block-runner` compatibility location. Narrow it when needed:

```bash
npx -y block-runner@latest skill --install --target agents
npx -y block-runner@latest skill --install --target claude
npx -y block-runner@latest skill --install --scope user
npx -y block-runner@latest skill --install --dir .another-agent/skills
npx -y block-runner@latest skill --install --dry-run
```

Project discovery is the most portable choice. User-wide discovery paths still vary between
harnesses, so use `--dir` when a client documents a different global skills root.
The installer pins runtime examples to its own package version so the guide and CLI contract
stay aligned. To update later, rerun `npx -y block-runner@latest skill --install`.

**Ask the user first.** This writes files into their project, which is their call, not yours.
If they decline, or their harness has no skill system, nothing is lost — reading this guide is
the same information. `npx -y block-runner@latest skill` prints it without installing anything.
