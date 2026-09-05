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

This 0.9 authoring workflow is available from the testing channel. In this printed source guide,
run its authoring, plugin, and proof commands with `npx -y block-runner@testing`. An installed
skill rewrites runtime commands to the exact version that installed it, so its compiler and guide
cannot drift. Do not substitute `@latest` while stable lacks `author`.

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
their order and every listed value participates in the confirmation hash. `files` names
compiler-owned source outputs and uses only safe relative POSIX paths. Core fields are required;
list fields may be empty when a design genuinely has none of that item.

| Field | Required shape |
|---|---|
| `version` | The number `1`. |
| `generatorVersion` | Non-empty generator version string. |
| `target` | `{ "name": "namespace/slug", "title": "…" }`; optional `description`, `category`, `icon`, `textDomain`, `wordpress`, and safe relative `directory`. |
| `structure` | Ordered native nodes: `block`, optional stable `id`, `label`, JSON `attributes`, `lock`, and recursive `children`. Never HTML. |
| `allowedBlocks` | Optional direct-child insertion allowlist. It must include every initial direct child; nested blocks are not added implicitly. |
| `fields` | Ordered `{ "id", "label", "mode" }` records; `mode` is exactly `fixed`, `editable`, or `override`. Optional `node`, `attribute`, `type`, `default`, and `description` explain the editor surface. |
| `locking` | `{ "mode": "all" | "contentOnly" | "insert" | "none" }`. Use native per-node `lock` for movement/removal decisions. |
| `styles` | `{ "strategy": "native" | "scoped-css" | "mixed", "outcomes": [] }`; an outcome has `property`, `outcome` (`native`, `token`, `scoped-css`, or `dropped`) and optional `value`, `token`, and `reason`. Optional `rules` and `editorRules` carry structured residual CSS as described below. |
| `pattern` | `{ "ready": boolean, "overrides": [{ "field": "<field id>" }] }`, with optional override label and description. |
| `assets` | Local images require `id`, absolute `source`, `status: "ready"`, byte-level `sha256`, and an `assets/<filename>` destination. Declare native image references in `uses: [{ "node": "<image node id>", "attribute": "url" }]`, or reference the image in confirmed CSS. Supported bundled formats: PNG, JPEG, GIF, WebP, static SVG. An external HTTP(S) asset uses `status: "external"` without a destination or bundled uses. |
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
      "mode": "override",
      "type": "rich-text",
      "node": "heading",
      "attribute": "content",
      "default": "Our features"
    }
  ],
  "locking": { "mode": "contentOnly" },
  "styles": {
    "strategy": "native",
    "outcomes": []
  },
  "pattern": { "ready": true, "overrides": [{ "field": "heading", "label": "Heading" }] },
  "assets": [],
  "files": [],
  "warnings": []
}
```

Every declared field must resolve to a real node and native attribute. Native pattern
overrides enable the whole content region, not arbitrary style properties. Confirm all
supported attributes of an overridden node: heading/paragraph/list-item `content`;
image `id`, `url`, `title`, `alt`, `caption`; button `text`, `url`, `linkTarget`, `rel`.
Partial regions are rejected. Background colours and layout are not native pattern
content overrides. Generic Block Bindings are not supported by this authoring path.

Bundled images are copied byte-for-byte only after confirmation. Hash the source bytes;
do not invent a hash, media-library ID, or final site URL. The build resolves bundled
image URLs. Missing, changed, symlinked, or unsupported bundled assets are rejected.
Static SVGs may contain geometry, text, gradients, and self-contained fragment references.
Scripts, animation, embedded HTML, external dependencies, and unresolved fragments are
rejected rather than stripped. Native Image SVGs are emitted as files; CSS SVGs may be
inlined by the build. Do not substitute a `data:` URL for a native image.
An empty `files` list lets the compiler enumerate its complete
source set in the preview; it does not mean no output. A native SVG adds an owned
`asset-urls.mjs` source file, which is included in confirmation and the manifest.

For existing HTML/CSS input, `author <html> --name <namespace/slug> --json` returns deterministic
source evidence before any rules proposal: authored elements and locations, stylesheet/build
dependencies, source hashes, and complete style/asset ledgers (including unresolved entries).
Rules conversion is an advisory proposal source, not a prerequisite for inspecting messy or
unknown-safe markup. It does not write source. A caller may supply an independently designed
native plan through the API, but it must carry the exact source hash and complete evidence
coverage; changing the proposed tree cannot erase an unresolved declaration or asset obligation.
The same registered-block compiler, preview, confirmation, and write gate apply to either plan.

Tailwind detection is advisory. Supplied compiled CSS can be handled as ordinary CSS; Tailwind
source/runtime output needs an explicit, pinned build graph (including custom variants, plugins,
variables, reset/Preflight effects, and dependencies) before fidelity is claimed. Block Runner
does not infer utility semantics or execute package/config files. Missing build inputs are reported
as a specific dependency diagnostic. Scripts, event handlers, unsafe CSS URLs, and executable
browser behaviour remain blocked by the output policy.

Licensed local WOFF/WOFF2 fonts use an asset with `kind: "font"`, an absolute source,
confirmed byte hash/destination, and `fontLicense: { ownership, license, notice? }`.
Retain the complete required redistribution notice; Block Runner validates the declared
decision and bytes, not legal permission. Add `styles.fonts: [{ assetId, family }]`, with
optional `fontStyle`, `fontWeight`, `fontStretch`, `fontDisplay`, and `unicodeRange`.
Use the namespaced families returned by HTML analysis. For a manually authored plan, compute
the prefix `block-runner-<namespace>-<slug>-<first 8 hex characters of SHA-256(target.name)>-`
and append a local family name; do not invent hashes. Use that exact family in every CSS/native
reference. Faces load through shared CSS; `font-licenses.txt` retains notices in production
archives. Remote fonts, other font formats, and editor-only font faces are not supported.
Unlicensed HTML font faces fall back with explicit warnings; destination theme presets do not
authorize copying font files. Keep the analyzer's `source` and `coverage` records in the plan.

For styling that native block supports cannot express, use `styles.rules`. Each rule is
either `{ "kind": "style", "selector": ".card:hover", "declarations": [
{ "property": "transform", "value": "translateY(-2px)" } ] }`, or a conditional rule:
`{ "kind": "conditional", "name": "media", "prelude": "(min-width: 48rem)",
"rules": [ ... ] }`. Conditional names are `media`, `supports`, or `container`;
conditions may nest. A declaration may explicitly include `"important": true`.

Use component-local selectors, not a `wp-block-…` prefix. The compiler adds the owned
wrapper selector to every branch. It preserves declaration order and hover/focus states.
Put supplemental editor affordances in `styles.editorRules`; shared design styles belong
in `rules`. Both appear in the confirmation preview and affect its hash. These are typed
design decisions, not permission to supply a complete stylesheet or Sass program.
Global selectors, imports, unsupported functions, and unsafe fragments are rejected.
A local CSS URL must exactly match a confirmed asset destination, such as
`url("./assets/photo.png")`. Remote CSS URLs must match a declared external asset.
Do not treat these residual rules as a complete source-style ledger: retain the separate
declaration-by-declaration accounting, including native mappings and explicit refusals.

### Preview the exact plan before asking

```bash
npx -y block-runner@testing author preview authoring-plan.json \
  --output-dir <exact-final-destination>
```

`author preview` writes no files. Before requesting consent, lead with a compact plain-English
summary of editability, unresolved decisions/losses, style and asset ownership, and destination
changes. Then paste the literal plain-text terminal output verbatim. That summary supplements;
it never replaces or truncates the structure tree, `Warnings` section, exact touched paths,
replacement approvals, or full confirmation SHA-256. The user must see all of those details —
including the `Warnings` section when it says `- none`, and `No files written.`

Confirmation also binds the installed compiler template, which is shown in the preview.
After upgrading Block Runner, request a fresh preview and approval; an old confirmation
is not portable across compiler changes.

Only after showing that exact preview, ask a clear question such as: “Approve writing exactly
plan `<full hash>` to `<destination>`?” If replacements are listed, name them and obtain a
separate explicit replacement approval. A general “go ahead”, a changed plan, a changed
destination, or a changed destination fingerprint is not approval. The CLI is deliberately
non-interactive; it never obtains conversational consent for you.

### Write, then finish the delivery

After that exact approval, run:

```bash
npx -y block-runner@testing author write authoring-plan.json \
  --confirm '<full preview hash>' \
  --output-dir '<exact previewed destination>'
```

Use the full hash and exact destination from the preview. If either changes, preview again and
obtain fresh consent. Do not write into `mktemp`, an auto-deleted staging folder, or an
unspecified location. The write report means **source delivered only**: it has not built,
activated, registered, rendered, or proved the block. Follow its displayed `plugin preview`
command for the existing-plugin or standalone boundary.

### Existing-plugin output

Use this only after inspecting the target plugin. Do not guess its build or registration layout.

```bash
npx -y block-runner@testing plugin inspect <plugin-root>
npx -y block-runner@testing plugin preview <generated-block-dir> --host <plugin-root>
# Show this complete preview, then obtain its displayed fingerprint and any separate replacement approvals.
npx -y block-runner@testing plugin write <generated-block-dir> --host <plugin-root> \
  --confirm '<plugin preview fingerprint>' \
  --approve-replace '<each explicitly approved path>'
```

Write the generated block directly below the existing plugin's lasting source directory, not a
temporary directory. If `plugin inspect` says the layout is unsupported, stop and offer
standalone output rather than improvising registration or a build configuration.

After that exact plugin write, source integration is delivered but no build or WordPress proof
has run. The report's next command is the host build:

```bash
cd <plugin-root> && npm run build
```

That produces the reviewed build target reported by `plugin preview`. Create the host's normal
installable ZIP after the build, then run the proof command below against that exact ZIP.

### Standalone-plugin output

Use a retained, explicitly named plugin directory. Preview the wrapper before it is written,
then build the final plugin archive from that same directory.

```bash
npx -y block-runner@testing plugin preview <generated-block-dir> \
  --standalone <retained-plugin-directory>
# Show this complete preview, then obtain its displayed fingerprint and any replacement approvals.
npx -y block-runner@testing plugin write <generated-block-dir> \
  --standalone <retained-plugin-directory> \
  --confirm '<plugin preview fingerprint>'
```

After the exact write, the standalone source and its pinned lock are delivered; it is not built
or runtime-proven. Run the reported next command without hand-authoring React or PHP:

```bash
cd <retained-plugin-directory> && npm ci && npm run zip && npm run test:zip
```

`npm run zip` runs the generated `wp-scripts` build and creates the plugin ZIP; `npm run
test:zip` verifies its release contents. Those are build checks, not WordPress runtime proof.

### Proof is part of completion

Headless validation, source generation, or a successful build is not a full success claim. Build
the final plugin ZIP and run a full proof against the exact reviewed input and generated package.
Real-WordPress proof is an explicit optional setup: install the exact proof tooling alongside the
same locally installed Block Runner version, then install Chromium yourself. This never triggers
a browser download or model call from the proof command:

```bash
npm install --save-dev --save-exact \
  block-runner@testing \
  @wordpress/env@11.12.0 \
  @playwright/test@1.61.1 \
  @wordpress/e2e-test-utils-playwright@1.51.0 \
  axe-core@4.11.0 \
  pixelmatch@7.1.0 \
  pngjs@7.0.0
npx --no-install playwright install chromium
```

A working Docker CLI and daemon are also required. If any proof package is absent or does not
match its pin, the proof receipt is blocked before Docker starts and gives the exact setup
command. After setup, run the locally installed CLI:

```bash
npx --no-install block-runner proof dist/acme-feature-grid.zip \
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
npx -y block-runner@testing skill --install
```

That writes the same skill to the cross-agent `.agents/skills/block-runner` location and to
Claude Code's `.claude/skills/block-runner` compatibility location. Narrow it when needed:

```bash
npx -y block-runner@testing skill --install --target agents
npx -y block-runner@testing skill --install --target claude
npx -y block-runner@testing skill --install --scope user
npx -y block-runner@testing skill --install --dir .another-agent/skills
npx -y block-runner@testing skill --install --dry-run
```

Project discovery is the most portable choice. User-wide discovery paths still vary between
harnesses, so use `--dir` when a client documents a different global skills root.
The installer pins runtime examples to its own package version so the guide and CLI contract
stay aligned. To update later, rerun `npx -y block-runner@testing skill --install`.

**Ask the user first.** This writes files into their project, which is their call, not yours.
If they decline, or their harness has no skill system, nothing is lost — reading this guide is
the same information. `npx -y block-runner@testing skill` prints it without installing anything.
