# Block Runner

**The primitive between everything and WordPress blocks.**

![Block Runner converts messy design HTML into clean, nested, native Gutenberg blocks — wp:cover ▸ wp:columns ▸ wp:buttons](demo/demo.gif)

Block Runner is a primitive. A small, fast CLI — and a library — built to sit in
the one place nothing else does: the gap between everything that generates content
and the blocks WordPress actually trusts. Drop it into a project, a pipeline, an
agent loop, a CI job. It does one thing, with precision: turn raw HTML into clean,
native, editable WordPress blocks — and prove they're valid.

That gap is everywhere now. Content pours out of AI, agents, design tools,
templates, plain HTML — faster than anyone can hand-build it. But the WordPress
editor only trusts blocks it recognizes. The moment generated HTML reaches it, the
magic dies at the door: your paragraphs and headings survive, then it surrenders —
your cover, your columns, your buttons collapse into a single frozen "Custom HTML"
blob. Beautiful design in, spaghetti out.

**Block Runner ends that.**

It translates design-intent HTML into the real thing — `wp:cover > wp:columns >
wp:buttons`, properly nested, real media, exactly how you'd have built it by hand.
Then it runs every result through a deterministic gate wired to headless Gutenberg,
so *valid* means what the editor means — not what a converter hopes.

```
Design in  →  one frozen Custom HTML blob        ❌  today
Design in  →  wp:cover > wp:columns > wp:buttons  ✅  with Block Runner
              real · nested · editable · zero "attempt recovery" warnings
```

Fast, deterministic, offline — no API keys, runs anywhere Node does. And built to
be built on: bring your own rules, your own blocks, your own media resolvers, and
wire it into the workflows you already have. CLI, library, or CI check — your call.

Nothing ever degrades in silence. The instant something can't be expressed
natively, Block Runner tells you — and points at the exact line that caused it.

This is the layer WordPress has been missing: the connective tissue between how
content is made now, and how WordPress was built to render it.

**Any content in. Real blocks out.**

## Install

```sh
npm install block-runner
```

Block Runner requires Node 18.12 or newer.

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

The v1 converter is deterministic and offline. It uses ordered rules to emit
Gutenberg block objects with `createBlock()` and serializes them with
`serialize()`. It does not use language models, API keys, or the WordPress paste
pipeline as a converter.

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
    mapFile: './examples/media-map.json',
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
