# Block Runner

**The primitive between everything and WordPress blocks.**

[![npm version](https://img.shields.io/npm/v/block-runner.svg)](https://www.npmjs.com/package/block-runner)
[![npm downloads](https://img.shields.io/npm/dm/block-runner.svg)](https://www.npmjs.com/package/block-runner)
[![CI](https://github.com/humanmade/block-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/humanmade/block-runner/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/humanmade/block-runner.svg)](./LICENSE)

![Block Runner converts messy design HTML into clean, nested, native Gutenberg blocks: wp:cover ▸ wp:columns ▸ wp:buttons](https://cdn.jsdelivr.net/gh/humanmade/block-runner@main/demo/demo.gif)

Block Runner is the layer between **generated content and WordPress**. AI tools, agents, and
design tools spit out HTML, but the block editor only trusts blocks it recognizes, so it
freezes everything else into a single "Custom HTML" blob, or breaks the block outright with
"Attempt Block Recovery." Block Runner converts that output into real, nested, **native**
Gutenberg blocks (`wp:cover > wp:columns > wp:buttons`) and proves every result is
editor-valid. Built to sit in an agent loop, a content pipeline, or a CI gate, and
deliberately a primitive rather than a platform: the blocks it emits are plain, native
WordPress, editable in any editor with nothing proprietary to keep installed.

| | Generated HTML reaches the editor as… |
| --- | --- |
| **Today** ❌ | one frozen `Custom HTML` blob, or a broken block and *"Attempt Block Recovery"* |
| **With Block Runner** ✅ | `wp:cover > wp:columns > wp:buttons`: real, nested, editable, valid |

## Quickstart

```sh
npm install block-runner          # requires Node 20+
```

Then just ask your coding agent (Claude Code, Codex):

> Use block-runner to convert this hero into a native Gutenberg block.

Or run the CLI yourself:

```sh
# native blocks stream to stdout by default; pipe them anywhere
block-runner convert hero.html

# pipe in from an agent, a generator, or curl
generate-page | block-runner convert -

# or write straight to a file
block-runner convert hero.html --out hero.blocks.html
```

Every run is checked against headless Gutenberg, so what comes back is guaranteed
editor-valid, or Block Runner tells you exactly what wasn't and points at the line.

## Benchmark

![Fidelity benchmark: raw Claude and Codex writing block markup themselves score 35 to 73, while Block Runner with the same models scores 93 to 99, across simple and complex blocks](https://cdn.jsdelivr.net/gh/humanmade/block-runner@main/assets/benchmark.png)

Every conversion is scored from 0 to 100 against a fixed suite of design sections with a
known ideal block tree, by how faithfully it reproduces the intended `wp:*` structure and
content. The comparison is raw LLMs writing the block markup themselves versus Block Runner
pairing the same model (GPT-5.5, Opus) with its validity gate, across simple and complex layouts.

## What it does

Two jobs: **convert** generated HTML into native blocks, and **validate** that what you ship
is editor-valid. Use either half on its own: convert in your agent pipeline, or run the gate
as a standalone validator in CI.

### Convert: generated HTML → native blocks

- **Native blocks, never locked in.** Real `wp:cover > wp:columns > wp:buttons`, properly nested, with real media ids: plain core blocks anyone can edit in any WordPress, not a builder's proprietary block types you have to keep its plugin installed to touch.
- **Any model, any agent.** Feed it whatever your LLM, agent, or design tool emits, from any vendor, and drop it into your own pipeline instead of adopting someone else's editor.
- **Media resolution.** Resolve images to real attachment ids via a map, WP-CLI, or the REST API.
- **Styling fidelity, your call.** Keep off-theme styles or map them to your theme, up to a ceiling you set.
- **Extensible.** Built-in rules out of the box; add your own, or hand the hardest layouts to an LLM (experimental).

### Validate: prove it's editor-valid

- **A seatbelt for generated blocks.** Models and builders will cheerfully emit markup that corrupts the editor; every result is held to a gate wired to headless Gutenberg first, so *valid* means what the editor means, not what a generator hoped.
- **Reproducible gate.** Same markup, same verdict, every time. Safe to run on every request and in CI.
- **Canonicalize.** Rewrite near-miss markup into the exact shape the editor expects.
- **Never fails silently.** When something can't be expressed natively, it says so and points at the exact line.

## Why Block Runner

Content pours out of AI and agents faster than anyone can hand-build it, but "a block the
editor actually accepts" is a brutally exact bar. To land one valid block, every one of these
has to be right:

- **Markup is validated against what the block's `save()` would output.** Attribute order,
  class names, whitespace, a stray self-closing slash: one mismatch and the editor throws
  *"This block contains unexpected or invalid content"* and offers Attempt Block Recovery.
- **Attributes live in a typed HTML-comment schema** (`<!-- wp:cover {"dimRatio":50,...} -->`),
  order-sensitive, with defaults that must or must not appear depending on the block.
- **Nesting is enforced.** `wp:columns` accepts only `wp:column`, `wp:buttons` only `wp:button`,
  `wp:cover` wraps a specific inner container. Put the wrong child inside and the block is invalid.
- **Each block expects its exact generated classes** (`wp-block-cover`, `wp-element-button`,
  `has-background-dim`, `wp-image-1234`). Miss one and it breaks or renders wrong.
- **Images need a real attachment ID**, not just a URL, so you also have to resolve and import
  media into the library and thread the id through the markup.
- **Colors, spacing, and fonts have to map to your theme presets** (`var:preset|spacing|40`,
  `has-accent-color`), not raw hex and pixels, or the result is off-brand or rejected outright.
- **Blocks carry deprecations.** Markup that validated against last year's `save()` may not
  validate against this year's.
- **Anything it can't place collapses into one frozen "Custom HTML" blob**, and the structure,
  nesting, and editability are gone.

Get any of it wrong and you ship invalid blocks, broken layouts, or one giant uneditable blob.
Block Runner gets all of it right: it turns whatever your agents and tools generate into real,
nested, editable blocks with resolved media, then proves every result against headless
Gutenberg before it reaches the editor.

**Any content in. Real blocks out.**

## CLI

Three commands: `convert` (HTML to blocks), `validate` (check block markup), and `fix`
(canonicalize block markup).

```sh
block-runner convert hero.html                    # blocks to stdout
block-runner validate "content/**/*.html" --json
block-runner fix post-content.html --out post-content.fixed.html
```

Read from stdin with `-`:

```sh
cat hero.html | block-runner convert -
```

### Flags

All commands:

| Flag | Description |
| --- | --- |
| `--config <path>` | Use a specific config file (otherwise auto-loaded from the working directory). |
| `--json` | Emit a machine-readable JSON report instead of text or markup. |
| `--strict` | Exit `1` on strict warnings (unresolved media, fallback blocks). |
| `--explain` | Include rule attribution and near-misses in the report. |

`convert` and `fix` also take `--out <path>` to write the result to a file instead of stdout.

`convert` adds media-resolution flags:

| Flag | Description |
| --- | --- |
| `--resolver <kind>` | Media resolver: `noop`, `map`, `wpcli`, `rest`. |
| `--wp-url <url>` | WordPress URL for `wpcli` or `rest` resolution. |
| `--wp-user <user>` | WordPress username for `rest` resolution. |
| `--wp-app-password-env <name>` | Env var holding a WordPress application password. |

### Exit codes

- `0`: clean
- `1`: problems found
- `2`: usage or I/O error
- `3`: headless Gutenberg boot failure

## Run it anywhere

It's a Node CLI, so it drops into whatever you already use: your shell, a pre-commit hook,
GitHub Actions, or any other CI (GitLab, CircleCI, and friends all run Node). And it's
model-agnostic: it works on the output of any model, from any vendor.

**pre-commit** (add to `.pre-commit-config.yaml`):

```yaml
- repo: https://github.com/humanmade/block-runner
  rev: v0.1.0
  hooks:
    - id: block-runner
      args: ['content/**/*.html']   # glob of files that contain block markup
```

**GitHub Actions** (or any CI) validate blocks on every push:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx block-runner validate "content/**/*.html" --strict
```

## Library

```ts
import { canonicalize, convert, validate } from 'block-runner';

const validation = await validate(markup);
const fixed = await canonicalize(markup);
const converted = await convert(html, { resolver: 'noop' });
```

## Media Resolution

A `<img src="hero.jpg">` in generated HTML is just a URL, but WordPress image and cover blocks
want a real media-library attachment with an ID (`wp-image-1234`). Media resolution is how
Block Runner connects the two: matching or importing each image into the library and threading
the right id into the block. Choose how it does that:

- `noop`: leave URLs as-is and warn when an ID is missing (good for a dry run).
- `map`: look up IDs and URLs from a JSON map you provide.
- `wpcli`: find or import media with `wp media list` and `wp media import`.
- `rest`: find or import via the WordPress REST API, with credentials supplied explicitly.

Remote sideloading is off by default. Under `--strict`, unresolved media (and fallback blocks)
cause exit code `1`.

## Configuration

Block Runner auto-loads `block-runner.config.{mjs,js,json}` from the working
directory, so most runs need no flags; the config sets the media resolver, tokens,
and rules. Pass `--config <path>` only to point at a config elsewhere.

`block-runner.config.mjs`:

```js
export default {
  strict: false,
  media: {
    resolver: 'map',
    mapFile: './media-map.json',
  },
  tokens: {
    colors: {
      dark: 'contrast',
      light: 'base',
      accent: 'accent',
    },
    fonts: {
      heading: 'display',
      body: 'body',
    },
    spacing: ['20', '30', '40', '50', '60'],
  },
};
```

## Styling fidelity

Design HTML often carries custom CSS (and sometimes JavaScript) that doesn't match
the target theme. The `styling` level controls how much of it Block Runner keeps. The
levels run from safest (cleanest, most editable blocks) to most faithful (keeps the
original look, but less editable):

| Level | What it does |
|---|---|
| `strict` | Map to the theme only. Off-theme styles are dropped. Cleanest, fully on-brand, fully editable. |
| `relaxed` | Keep exact off-theme values on the block (custom color, size, spacing). Still native and fully editable. |
| `open` | Also keep CSS no block can express, by wrapping the element and shipping that CSS alongside. Look preserved, structure still editable. |
| `source` | Keep the original markup as a Custom HTML block. Exact, but not editable. Last resort. |

You set one ceiling. Per block, Block Runner uses the **strictest level that still
captures the design**, and never goes past your ceiling. It's configured in
`block-runner.config.mjs`:

```js
export default { styling: 'relaxed' }; // default (a per-run --styling flag is planned)
```

Custom JavaScript is never inlined. A behavior maps to a native interactive block,
comes from a block plugin, or is dropped, and every drop or escalation is reported.

> Status: `relaxed` and `open` are in progress. Today the converter behaves like
> `strict` (off-theme styling is dropped) with a `source` (Custom HTML) fallback.

## Running the benchmark

A conversion benchmark lives under `benchmarks/`: it measures how faithfully real generator
output (Impeccable, Codex, Claude, and more) converts to native blocks, across swappable
converters (the built-in rules, plus experimental LLM translators run via their CLIs).

```sh
npm run bench          # score the suite; write benchmarks/presentation/review.html + benchmarks/presentation/scoreboard.html
npm run bench:record   # also append a provenance-tagged run to benchmarks/results.jsonl
```

Runs are recorded with `engine` / `model` / `effort` / `suiteHash`, so older engines stay
backtestable against the current suite (`scripts/backtest.sh`). See `benchmarks/README.md`
for adding producers and engines.

## License

GPL-2.0-or-later.
