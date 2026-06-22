# Block Runner

Block Runner is a deterministic Node CLI and library for turning design-intent
HTML into native WordPress Gutenberg block markup. It targets clean, editable
trees such as `wp:cover > wp:columns > wp:buttons` instead of opaque Custom HTML
blocks.

It also ships a validation and canonicalization gate powered by headless
Gutenberg. The gate parses real block markup, validates it with registered core
blocks, and rewrites near-miss markup through `serialize(parse(markup))`.

## Install

```sh
npm install block-runner
```

Block Runner requires Node 18.12 or newer.

## CLI

```sh
block-runner validate "content/**/*.html" --json
block-runner fix post-content.html --out post-content.fixed.html
block-runner convert hero.html --resolver map --config block-runner.config.mjs --out hero.blocks.html
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

## License

GPL-2.0-or-later.
