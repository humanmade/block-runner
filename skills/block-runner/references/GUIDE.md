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

| You have | Use | Why |
|---|---|---|
| A reusable registered block to author — before source exists | **`author preview`** → user confirmation → **`author write`** | A versioned AuthoringPlan makes the consequential implementation choices reviewable and hash-binds the write. |
| A design in your head, or HTML you are about to write | **`assemble`** | You describe the structure; Block Runner builds valid blocks from it. Best structural results. |
| Authored source HTML — a design tool export, source file, or paste | **`convert`** | Rule-based translation of existing markup, and the only path that carries CSS. Do not use frontend-scraped render output. |
| Block markup you already produced, before saving it to WordPress | **`validate`** → **`fix`** → **`validate`** | Proves the editor will accept it. |

The single most common mistake is reaching for `convert` when you were about to author the
HTML yourself. If you are the one inventing the structure, do not write HTML and convert it —
describe the structure to `assemble` directly. You will get better blocks with less work.

**The exception that matters:** if the input has meaningful CSS you need to preserve —
brand colours, custom spacing, a specific look — use `convert`, not `assemble`. An intent
tree carries structure and content, not styling, so `assemble` will produce clean but plainer
blocks. `convert --styling relaxed` keeps exact off-theme values on the block. If you are
unsure whether the styling matters, ask the user rather than silently flattening their design.

---

## 2. Registered-block authoring — preview the plan before a write

Use this path when the requested result is a reusable, registered WordPress block source
package. It is not an HTML conversion path and it does not let a prose description stand in for
implementation decisions. First make an **`AuthoringPlan`**: a versioned JSON contract that
names the target block and records its native child structure, editable fields, locking, style
outcomes, pattern overrides, assets, planned files, and warnings. A plan is the thing being
reviewed and, eventually, written.

AuthoringPlan v1 has these top-level fields. Omitted optional sections canonicalize to their
documented empty/default form; object keys are recursively sorted for canonical JSON, while
array order remains material.

| Field | Contract |
|---|---|
| `version` | Required literal `1`. |
| `generatorVersion` | Required generator identity/version; it participates in the confirmation hash. |
| `target` | Required `{ "name": "namespace/slug", "title": "…" }`; `directory`, when present, is a safe relative package path. |
| `structure` | Native block nodes: `block`, optional stable `id`, `label`, `attributes`, per-node `lock`, and `children`. Never HTML. |
| `fields` | Editor values with `id`, `label`, and explicit `mode`: `fixed`, `editable`, or `override`; may identify a structure `node`, `attribute`, type, default, and description. |
| `locking` | Whole-block lock mode (`all`, `contentOnly`, or `none`) and optional move/remove/insert permissions. |
| `styles` | Strategy (`native`, `scoped-css`, or `mixed`) plus a disposition for each source property: `native`, `token`, `scoped-css`, or `dropped`. |
| `pattern` | Readiness flag and overrides that name their field. |
| `assets` | Identified sources with optional safe relative destinations, availability status, and required flag. |
| `files` | Planned safe relative paths, optional materialized `content`, optional kind, and `operation: create|replace` (omitted means `create`). `plannedFiles` is only accepted as an input alias and canonicalizes to `files`. |
| `warnings` | Any unresolved or deliberate caveats. |

The plan must make every material choice explicit. In particular, label fields as **fixed**,
**editable**, or **override**; say which styles map to native or theme support and which need a
different outcome; and identify every replacement as `replace` (new files default to `create`).
Do not hide those choices in generated code, HTML, a chat summary, or an implied default.

### Preview, then talk to the user

```bash
npx -y block-runner@latest author preview authoring-plan.json --output-dir generated/feature-grid
```

`author preview` is read-only. It validates and canonicalizes the plan, computes a SHA-256
confirmation value bound to both the plan and the selected destination fingerprint, and prints a
deterministic plain-text review. It includes the target, structure, editable fields, style
outcomes, assets, pattern readiness, planned files, warnings, destination fingerprint, and the
unambiguous line **`No files written.`** It labels fixed, editable, and override fields in text,
so colour is never needed to understand it. Terminal width affects wrapping only; `NO_COLOR` is
honoured and the preview never inserts ANSI escape sequences into JSON.

Read this preview before asking for consent. Summarize the decisions in ordinary language and
show the complete 64-character, lower-case hexadecimal confirmation SHA-256. The installed skill
owns the conversation: ask a clear yes/no
question such as “Approve writing exactly this plan, identified by `<hash>`, to `<directory>`?”
Do not ask the CLI to prompt, and do not consider an earlier or general “go ahead” to approve a
changed plan.

If any planned file is a replacement, ask separately and name the affected files. Replacing an
existing file is a distinct decision from creating the plan; no affirmative replacement answer
means no `author write`.

### Write only the previewed plan

After the user has affirmatively approved the displayed confirmation hash (and any replacements), run:

```bash
npx -y block-runner@latest author write authoring-plan.json \
  --confirm '<full-sha-256-from-preview>' \
  --output-dir '<the-previewed-directory>'
```

Pass the full confirmation hash exactly as the preview displayed it; `--output-dir` names the
exact package destination, rather than a parent directory. The command is intentionally
non-interactive: it never opens a prompt and never consumes stdin as confirmation. This also
applies with `--json` and when stdout is redirected. A missing, stale, or incorrect hash must
be treated as a no-write result, not as a reason to retry with a looser invocation.

`-` may supply the plan on stdin (`author preview -` or `author write -`); it is only plan input,
never confirmation input. For a write, provide the same canonical plan that was previewed, the
same destination, and the confirmation hash from that preview. If any changes, preview it again
and obtain fresh consent.

Do not work around a rejected write. Unsafe relative paths, absolute paths, `..` traversal,
destination changes, collisions, or a symlink in the selected output directory's prefix
are failures before any write. The command rechecks the destination fingerprint, paths,
symlinks, and collisions immediately before it uses exclusive, atomic file writes. Surface the
failure, revise the plan or destination safely, then start again at preview.

Generation of source is deliberately separate from this review loop. `author write` can
materialize only `files[].content` already present in the exact reviewed plan; a plan that only
describes future files is a valid no-op. Do not pretend that `author preview` generated files,
parse its display back into JSON, or use `author write` to fill decisions the plan omitted.

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

## 4. `convert` — someone else's HTML

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

## 5. The pre-flight loop — before anything is saved

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

## 6. Where the blocks go

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
