# Block Runner

**The primitive between everything and WordPress blocks.**

[![npm version](https://img.shields.io/npm/v/block-runner.svg)](https://www.npmjs.com/package/block-runner)
[![npm downloads](https://img.shields.io/npm/dm/block-runner.svg)](https://www.npmjs.com/package/block-runner)
[![CI](https://github.com/humanmade/block-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/humanmade/block-runner/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/humanmade/block-runner.svg)](./LICENSE)

![Block Runner converts messy design HTML into clean, nested, native Gutenberg blocks — wp:cover ▸ wp:columns ▸ wp:buttons](demo/demo.gif)

Block Runner is the layer between **generated content and WordPress**. AI tools, agents, and
design tools spit out HTML — but the block editor only trusts blocks it recognizes, so it
freezes everything else into a single "Custom HTML" blob. Block Runner converts that output
into real, nested, **native** Gutenberg blocks (`wp:cover > wp:columns > wp:buttons`) and
proves every result is editor-valid. Built to sit in an agent loop, a content pipeline, or a
CI gate.

```
Design in  →  one frozen Custom HTML blob        ❌  today
Design in  →  wp:cover > wp:columns > wp:buttons  ✅  with Block Runner
              real · nested · editable · zero "attempt recovery" warnings
```

## Quickstart

```sh
npm install block-runner          # requires Node 18.12+
```

```sh
# any HTML in → native, validated blocks out
block-runner convert hero.html --out hero.blocks.html
```

Every run is checked against headless Gutenberg, so what comes back is guaranteed
editor-valid — or Block Runner tells you exactly what wasn't, and points at the line.

## What it does

Two jobs: **convert** generated HTML into native blocks, and **validate** that what you ship
is editor-valid. Use either half on its own — convert in your agent pipeline, or run the gate
as a standalone validator in CI.

### Convert — generated HTML → native blocks

- **Native blocks, not blobs** — real `wp:cover > wp:columns > wp:buttons`, properly nested, with real media ids.
- **Built for agents & pipelines** — feed it whatever your LLM, agent, or design tool emits; get back blocks the editor trusts.
- **Media resolution** — resolve images to real attachment ids via a map, WP-CLI, or the REST API.
- **Styling fidelity, your call** — keep off-theme styles or map them to your theme, up to a ceiling you set.
- **Pluggable engines** — deterministic rules out of the box; bring your own rules, or plug an LLM/agent engine into the same seam.

### Validate — prove it's editor-valid

- **Valid means what the editor means** — every result runs through a gate wired to headless Gutenberg, not a converter's wishful thinking.
- **Deterministic gate** — reproducible: same markup, same verdict, no nondeterministic model in the loop. Safe to run on every request and in CI.
- **Canonicalize** — rewrite near-miss markup into the exact shape the editor expects.
- **Never fails silently** — when something can't be expressed natively, it says so and points at the exact line.

## Why Block Runner

Content now pours out of AI and agents faster than anyone can hand-build it — but the
WordPress editor only trusts blocks it recognizes. The moment that generated HTML reaches it,
your cover, columns, and buttons collapse into a single frozen "Custom HTML" blob. Beautiful
design in, spaghetti out.

Block Runner is the missing layer between the two: it turns whatever your agents and tools
generate into the real thing — properly nested blocks, real media, exactly how you'd have
built it by hand — then proves it's valid against headless Gutenberg before it reaches the
editor. The connective tissue between how content is made now and how WordPress renders it.

**Any content in. Real blocks out.**

## CLI

```sh
block-runner validate "content/**/*.html" --json
block-runner fix post-content.html --out post-content.fixed.html
block-runner convert hero.html --out hero.blocks.html
```

Use `-` to read from stdin:

```sh
cat hero.html | block-runner convert - --json
```

Exit codes:

- `0`: clean
- `1`: problems found
- `2`: usage or I/O error
- `3`: headless Gutenberg boot failure

## Library

```ts
import { canonicalize, convert, validate } from 'block-runner';

const validation = await validate(markup);
const fixed = await canonicalize(markup);
const converted = await convert(html, { resolver: 'noop' });
```

## Conversion Scope

The v1 converter uses ordered, deterministic rules — emitting block objects with
`createBlock()` and serializing them with `serialize()`, rather than the brittle WordPress
paste pipeline. The rule walker is a seam: bring your own rules, or plug an LLM/agent engine
in for harder cases (experimental).

Built-in rules cover:

- Cover sections with inline or CSS background images
- Columns and column-like rows
- Buttons and button groups
- Images, headings, paragraphs, and lists
- Generic groups
- Last-resort Custom HTML fallback with warnings

Every `convert` run validates the final block markup. Warnings are part of the
report and are never silently discarded.

## Media Resolution

Cover and Image blocks can be resolved with:

- `noop`: keep URLs and warn when IDs are missing
- `map`: read IDs and URLs from a JSON map
- `wpcli`: use `wp media list` and `wp media import`
- `rest`: use the WordPress REST media API when credentials are explicitly
  supplied

Remote sideloading is off by default. Under `--strict`, unresolved media and
fallback blocks cause exit code `1`.

## Configuration

Block Runner auto-loads `block-runner.config.{mjs,js,json}` from the working
directory, so most runs need no flags — the config sets the media resolver, tokens,
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

Design HTML often carries custom CSS — and sometimes JavaScript — that doesn't match
the target theme. The `styling` level controls how much of it Block Runner keeps. The
levels run from safest (cleanest, most editable blocks) to most faithful (keeps the
original look, but less editable):

```
strict ───────────────────────────────────────────────► source
cleaner · more on-brand · more editable   ·   more faithful to the original
```

| Level | What it does |
|---|---|
| `strict` | Map to the theme only. Off-theme styles are dropped. Cleanest, fully on-brand, fully editable. |
| `relaxed` | Keep exact off-theme values on the block (custom color, size, spacing). Still native and fully editable. |
| `open` | Also keep CSS no block can express, by wrapping the element and shipping that CSS alongside. Look preserved, structure still editable. |
| `source` | Keep the original markup as a Custom HTML block. Exact, but not editable. Last resort. |

You set one ceiling. Per block, Block Runner uses the **strictest level that still
captures the design**, and never goes past your ceiling.

```js
// block-runner.config.mjs
export default { styling: 'relaxed' }; // default
```

```sh
block-runner convert hero.html --styling open
```

Custom JavaScript is never inlined. A behavior maps to a native interactive block,
comes from a block plugin, or is dropped — and every drop or escalation is reported.

> Status: `relaxed` and `open` are in progress. Today the converter behaves like
> `strict` (off-theme styling is dropped) with a `source` (Custom HTML) fallback.

## Benchmark

A conversion benchmark lives under `benchmarks/`: it measures how faithfully real generator
output (Impeccable, Codex, Claude, …) converts to native blocks, across swappable conversion
engines (the deterministic rules; experimental LLM translators run via their CLIs — no API
key).

```sh
npm run bench          # score the suite; write report/review.html + report/scoreboard.html
npm run bench:record   # also append a provenance-tagged run to benchmarks/results.jsonl
```

Runs are recorded with `engine` / `model` / `effort` / `suiteHash`, so older engines stay
backtestable against the current suite (`scripts/backtest.sh`). See `benchmarks/README.md`
for adding producers and engines.

## License

GPL-2.0-or-later.
