# Block Runner

Turn HTML into editable WordPress blocks, or generate the source for a reusable registered block.

[![npm version](https://img.shields.io/npm/v/block-runner.svg)](https://www.npmjs.com/package/block-runner)
[![npm downloads](https://img.shields.io/npm/dm/block-runner.svg)](https://www.npmjs.com/package/block-runner)
[![CI](https://github.com/humanmade/block-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/humanmade/block-runner/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/humanmade/block-runner.svg)](./LICENSE)

![Block Runner driven from Claude Code: preview the registered block, confirm, write it into the plugin](https://cdn.jsdelivr.net/gh/humanmade/block-runner@main/demo/demo.gif)

Block Runner is an open-source CLI and JavaScript library from Human Made. It converts supported HTML into native Gutenberg blocks and checks the generated markup with the Gutenberg packages used by the WordPress editor. It can also generate a static registered block: source files you build into a plugin, with native editable blocks inside.

**The package makes no AI model calls.** Built-in rules can convert HTML on their own. An external agent can interpret a design and give Block Runner a structured plan to assemble or compile. The optional skill provides instructions for that agent.

## Quickstart

Requires Node.js **20.19.0+ on 20.x, 22.13.0+ on 22.x, or 24.0.0+**. Node 21 and 23 are unsupported. Basic conversion needs no AI agent, Docker or running WordPress site.

```sh
npm install block-runner
printf '<p>Hello WordPress</p>\n' > hello.html
npx --no-install block-runner convert hello.html
```

Output:

```html
<!-- wp:paragraph -->
<p>Hello WordPress</p>
<!-- /wp:paragraph -->
```

This is Gutenberg page content, ready to paste into the editor's code view. To save the markup or inspect its warnings:

```sh
npx --no-install block-runner convert hello.html --out hello.blocks.html
npx --no-install block-runner convert hello.html --json
```

The JSON report includes `ok`, block counts, warnings and source locations. Review it when converting a more complex design. The [shipped hero example](https://github.com/humanmade/block-runner/blob/main/examples/hero.html) is a larger input to explore.

## Choose your workflow

| What you need | Use | Output |
| --- | --- | --- |
| Convert HTML using built-in rules | `convert` | Gutenberg markup for page content |
| Build page content from an agent's block tree | CLI `assemble` | Gutenberg markup, assembled and validated |
| Create a reusable named block from a design | `author` | A plan and generated block source; preview and confirm before writing |
| Check or repair existing block markup | `validate` / `fix` | A report or canonicalised markup |

For straightforward HTML, start with `convert`. For a design that needs interpretation, an agent can choose the block structure and send it to CLI `assemble`. Both page-content routes finish with media resolution, theme-token handling and validation. Neither creates a registered block's source files.

### Registered-block authoring

Use `author` when the result should be a named block such as `acme/notice`, available for repeated insertion. Here, “authoring” means generating block source code. Block Runner can analyse HTML directly or accept an agent's source-linked proposal for the structure and editable fields.

The output is a static wrapper around native blocks, with block metadata, editor code, styles and assets. Source generation, plugin build and verification in WordPress are separate steps. Follow the [complete registered-block delivery guide](https://github.com/humanmade/block-runner/blob/main/skills/block-runner/references/AUTHORING.md#shipped-notice-source-to-standalone-zip), including the shipped notice example and destination-specific write confirmations. That guide is also bundled with the installed skill.

## Library

The library is ESM-only. Save this as `hello.mjs` in the project where you installed Block Runner, then run `node hello.mjs`:

```js
import { convert } from 'block-runner';

const result = await convert('<p>Hello WordPress</p>');
console.log(result.output);
console.log(result.items); // Warnings and validation findings; empty for this input.
```

`convert` returns the same report used by the CLI. For an intent JSON string, use `realize` to get the complete assembly and validation report. The lower-level library `assemble` only builds Gutenberg objects; it does not run that full workflow. See the [API reference](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#library) for validation, registered-block generation and compatibility contracts.

CommonJS callers can use `await import('block-runner')`.

## Using Block Runner from an AI agent

Install the bundled skill in your project:

```sh
npx --no-install block-runner skill --install
```

This writes `.agents/skills/block-runner` and `.claude/skills/block-runner`. Then ask your agent:

> Use Block Runner to create a reusable block from this design in the existing plugin.

Your agent interprets the design and runs the tools. The package handles conversion, generation and validation. Installing the skill does not add a model or require an API key for Block Runner.

See [skill installation options](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#flags) for user scope, specific harnesses and upgrades. Without `--install`, the command prints the guide without writing files.

## Capabilities and limits

- Supported HTML becomes native blocks. Unsupported structures can remain as Custom HTML, with warnings; `--strict` fails on fallback blocks and unresolved media.
- Media IDs can come from a supplied map, WP-CLI or REST. Collecting site context or using WP-CLI resolution needs a site and the selected external tooling.
- Styles can map to existing theme presets, native block attributes or supported CSS. Block Runner does not rewrite `theme.json`.
- Registered-block generation produces static source. It does not generate arbitrary PHP renderers, custom field editors or JavaScript interactions.

Use the original design HTML rather than scraped frontend markup. **Valid markup does not prove visual fidelity or compatibility with every site.** Inspect warnings and verify the result in its target WordPress environment. The [construction guide](https://github.com/humanmade/block-runner/blob/main/skills/block-runner/references/CONSTRUCTION-PATTERNS.md) explains other approaches when the static generator does not fit.

## Benchmark

![Historical HTML-to-block benchmark: five low-effort model lanes plus the deterministic rules engine, 63 HTML sections per lane; the linked report gives invalid counts and timing method.](https://cdn.jsdelivr.net/gh/humanmade/block-runner@main/assets/benchmark.jpg)

This historical benchmark compares models writing Gutenberg markup directly with models supplying block trees to Block Runner. The deterministic rules converter has its own separately scored lane; the model-assisted scores do not describe plain `convert`. Each lane uses the same 63 HTML sections.

These are page-content conversion results, not measurements of registered-block generation, visual fidelity or editor persistence. See the [method and limitations](https://github.com/humanmade/block-runner/blob/main/docs/development.md#historical-conversion-results) and the [original report](https://github.com/humanmade/block-runner/blob/main/dev/benchmarks/presentation/figures.html).

## Documentation

<!-- Keep earlier README fragment links usable after moving the detailed sections. -->
<a id="cli"></a>
<a id="flags"></a>
<a id="exit-codes"></a>
<a id="run-it-anywhere"></a>
<a id="complete-source-to-build-routes"></a>
<a id="wordpress-proof-requirements"></a>
<a id="registered-block-authoring-contract"></a>
<a id="regeneration-and-saved-content"></a>
<a id="synced-pattern-overrides-wordpress-71"></a>
<a id="testing-workflow"></a>
<a id="media-resolution"></a>
<a id="configuration"></a>
<a id="site-context-from-wesper"></a>
<a id="styling-fidelity"></a>
<a id="registered-block-css-and-assets"></a>
<a id="running-the-benchmark"></a>

| Topic | Guide |
| --- | --- |
| Commands, flags, exit codes and CI usage | [CLI reference](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#cli) |
| Reusable block delivery | [Source-to-ZIP walkthrough](https://github.com/humanmade/block-runner/blob/main/skills/block-runner/references/AUTHORING.md#shipped-notice-source-to-standalone-zip) |
| WordPress proof requirements and synced patterns | [Verification profiles](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#wordpress-proof-requirements) and [pattern overrides](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#synced-pattern-overrides-wordpress-71) |
| Library contracts and regeneration | [API reference](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#library) |
| Media, theme tokens and Wesper context | [Configuration](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#configuration) and [media resolution](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#media-resolution) |
| CSS and assets | [Styling reference](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#styling-fidelity) |
| Workflows, source map and terminology | [Architecture](https://github.com/humanmade/block-runner/blob/main/docs/architecture.md) |
| Custom HTML conversion rules | [Runnable extension example](https://github.com/humanmade/block-runner/blob/main/docs/extending.md) |
| Repository checks and benchmarks | [Development guide](https://github.com/humanmade/block-runner/blob/main/docs/development.md) |

The bundled `context` command uses Wesper **0.4.1**. See the [site-context reference](https://github.com/humanmade/block-runner/blob/main/docs/reference.md#site-context-from-wesper) for what the manifest supplies and its limitations.

## License

GPL-2.0-or-later.
