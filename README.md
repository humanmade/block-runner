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
npm install block-runner          # requires Node.js ^20.19.0 || ^22.13.0 || >=24.0.0
```

This is the basic install: deterministic `convert`, `assemble`, `validate`, `fix`, and
authoring commands work without Docker, browser binaries, `wp-env`, or browser-proof
dependencies.

For the **0.9 registered-block authoring testing release**, use
`npm install block-runner@testing`. The stable `latest` channel remains on 0.8.0.

Then just ask your coding agent:

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

## Using Block Runner from an AI agent

If you are the one deciding the structure, don't write HTML and convert it. Describe the
structure as an intent tree and pipe it to `block-runner assemble` — deterministic code builds
the markup, so it cannot come out invalid.

Block Runner ships a canonical skill in the open Agent Skills layout. Install it into the
current project (ask the user before writing files):

```sh
npx -y block-runner@testing skill --install
```

That installs the same skill to the cross-agent `.agents/skills/block-runner` location and
Claude Code's `.claude/skills/block-runner` compatibility location. Project scope is the
default so the instructions can travel with a repository. Use user scope or one target when
that is what you want:

```sh
npx -y block-runner@testing skill --install --scope user
npx -y block-runner@testing skill --install --target agents
npx -y block-runner@testing skill --install --target claude
```

For a harness with another skills directory, use `--dir <skills-directory>`. With no skill
system, `npx -y block-runner@testing skill` prints the complete harness-neutral guide to stdout and writes
nothing. Project discovery is the most portable choice; user-wide discovery paths still vary
between harnesses, so use `--dir` when a client documents a different global root.

## Benchmark

![Historical HTML-to-block benchmark: five low-effort model lanes plus the deterministic rules engine, 63 HTML sections per lane; the adjacent caption gives invalid counts and timing method.](https://cdn.jsdelivr.net/gh/humanmade/block-runner@main/assets/benchmark.jpg)

The image is **historical conversion evidence**, not an authoring result. Its workload is 63
fixed HTML sections per lane (11 serial lanes, 693 conversions); the suite, models/low effort,
per-lane invalid counts, and monotonic serial timing method are labelled in the
[benchmark report](benchmarks/presentation/figures.html). Each model gets the same fixture in two
lanes: **Direct** writes Gutenberg markup itself; **Block Runner** returns an intent tree that the
package assembles and validates. The dashed line is the deterministic rules converter running
without an LLM. Every result is scored from 0 to 100 against the fixture's accepted block tree.

Registered-block authoring has a separate, currently unscored corpus in
[`benchmarks/authoring`](benchmarks/authoring/README.md). It has no combined score with this
suite: it records editable plans, generated plugin source, native-block use, the style ledger,
warnings, build, editor, frontend, pattern overrides, fidelity, and accessibility independently.
The authoring benchmark is optional for 0.9 testing and does not run automatically during release
checks. Required package and WordPress proof remain separate: a missing required gate is
`blocked`, never a pass.

## What it does

Two jobs: **convert** generated HTML into native blocks, and **validate** that what you ship
is editor-valid. Use either half on its own: convert in your agent pipeline, or run the gate
as a standalone validator in CI.

### Convert: generated HTML → native blocks

- **Native blocks, never locked in.** Real `wp:cover > wp:columns > wp:buttons`, properly nested, with real media ids: plain core blocks anyone can edit in any WordPress, not a builder's proprietary block types you have to keep its plugin installed to touch.
- **Broad element coverage.** Tables, quotes, code, separators, video/audio, `<details>`, YouTube/Vimeo embeds, and image galleries all map to their native core blocks — not just the hero primitives. What genuinely has no native home (inline SVG icons, definition lists, arbitrary iframes) is preserved as Custom HTML with a warning pointed at the line, never dropped and never crashing the run.
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
- **Colors, spacing, and fonts can map to your theme presets** (`var:preset|spacing|40`,
  `has-accent-color`) only when the captured theme category and literal value match; otherwise
  the reviewed literal or scoped CSS remains explicit.
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

| Command | What it does |
| --- | --- |
| `convert` | Authored HTML to native post-content blocks, including the legacy styling path. |
| `author <html> --json` | Analyze one authored design into a canonical registered-block plan, checked source, and style/asset ledgers. Does not write source. |
| `assemble` | An intent tree — JSON describing which blocks and how they nest — to native blocks, built with `createBlock` so the result cannot be invalid. |
| `author preview <plan\|->` | Validate and render a versioned registered-block GeneratedAuthoringPlan without writing files. |
| `author write <plan\|-> --confirm <hash> --output-dir <dir>` | Write the reviewed compiler-owned source package bound to its SHA-256 confirmation and destination. Build and runtime proof remain separate. |
| `validate` | Check block markup against headless Gutenberg. |
| `fix` | Canonicalize near-miss block markup. |
| `context` | Read a WordPress site into a `site.context.json` manifest (read-only). |
| `proof` | Run a real-WordPress proof profile for a built plugin ZIP and write an immutable receipt. |
| `skill` | Print or install the agent guide. |
| `plugin inspect` | Read-only detection of the supported `@wordpress/scripts` plugin profile. |
| `plugin preview` / `plugin write` | Preview, confirm, and integrate a generated registered-block directory; or create a standalone plugin wrapper. |

```sh
block-runner convert hero.html                    # blocks to stdout
block-runner author hero.html --name acme/hero --json
block-runner assemble intent.json                 # structure in, blocks out
block-runner validate "content/**/*.html" --json
block-runner fix post-content.html --out post-content.fixed.html

# Inspect a host before integrating generated block files. This writes nothing.
block-runner plugin inspect ./my-plugin --json

# Preview every exact target, then use the displayed fingerprint with `plugin write`.
block-runner plugin preview ./generated-block --host ./my-plugin

# For an absent or unsupported host layout, make a complete standalone plugin instead.
block-runner plugin preview ./generated-block --standalone ./my-notice-plugin
```

`plugin preview` never writes. Its fingerprint binds the exact target files; pass it to
`plugin write --confirm <fingerprint>`. Existing PHP or `package.json` files are marked as
separate replacement approvals, so their absolute preview paths must also be supplied with
`--approve-replace <path...>` before they can change. An unrecognised host is refused without
writing and the command offers the standalone form above.

Standalone previews include the complete, versioned npm lock for their pinned local
`@wordpress/scripts` toolchain. Confirmed writes only materialize the reviewed source and lock
bytes: they do not resolve dependencies, contact a registry, or run npm. Run `npm ci` separately
when preparing the generated plugin to build or package it.

### Registered-block authoring

HTML analysis returns `package.canonicalPlan`. Save that object as your plan, review its
native structure and editing policy, then use the same preview/write workflow below.
Successful analysis uses the canonical source compiler; unresolved Custom HTML regions,
unsafe assets, and unsupported CSS produce explicit failures, not a ready-to-install package.

For a reusable registered block, first make a versioned **GeneratedAuthoringPlan** rather than jumping
from a description or design directly to source. The plan records the block target and native
structure, editable and locked fields, style outcomes, pattern overrides, assets, planned files,
and warnings. Review it before any write:

```sh
block-runner author preview authoring-plan.json --output-dir generated/feature-grid
```

The plain preview is deterministic for a plan, generator version, destination snapshot, and
terminal width. It shows the plan SHA-256 and a separate confirmation SHA-256 bound to the
planned destination and its fingerprint, labels fixed/editable/override fields without relying
on colour, and ends with `No files written.` Preview is
read-only; it has no prompt. `NO_COLOR` is honoured, and `--json` never contains ANSI escape
sequences.

An installed Block Runner skill presents that preview to the user and asks for explicit
approval. The CLI itself is always non-interactive. After the user approves the displayed
confirmation hash, write the exact same plan to the previewed output directory. `--output-dir` is
the exact package destination (not a parent root):

```sh
block-runner author write authoring-plan.json \
  --confirm '<full-sha-256-from-preview>' \
  --output-dir '<the-previewed-directory>'
```

Missing, stale, or incorrect confirmation values write nothing. If a plan replaces existing
files, get a distinct, explicit replacement decision; a path collision, traversal or absolute
path, changed destination, or any destination-prefix symlink fails before any write. The command
rechecks these conditions immediately before exclusive, atomic writes. Use `-` for plan input
only—never as a source of confirmation. `files` may declare only compiler-owned output paths and
their `create`/`replace` operation; it never accepts file content. The deterministic compiler
always emits its complete source set (and confirmed assets), including when `files` is empty.

### Complete source-to-build routes

Both routes begin with a reviewed `authoring-plan.json`; use `author <design.html> --name
<namespace/slug> --json` when you need the deterministic HTML analysis to produce its canonical
plan. Neither route requires hand-written React, PHP, block metadata, or a repair step.

For a retained standalone plugin:

```sh
block-runner author preview authoring-plan.json --output-dir generated/feature-grid
# Review the complete preview and obtain its displayed confirmation hash.
block-runner author write authoring-plan.json --confirm '<confirmation-hash>' --output-dir generated/feature-grid

block-runner plugin preview generated/feature-grid --standalone plugins/acme-feature-grid
# Review the complete plugin preview and obtain its displayed fingerprint.
block-runner plugin write generated/feature-grid --standalone plugins/acme-feature-grid --confirm '<plugin-fingerprint>'

cd plugins/acme-feature-grid
npm ci
npm run zip
npm run test:zip
```

`npm run zip` builds the compiler-generated source and creates
`acme-feature-grid.zip`; `npm run test:zip` checks the archive policy. That is build-ready
delivery, not WordPress runtime proof. Run `block-runner proof acme-feature-grid.zip --profile
full ...` with the reviewed source, markup, and fixture before claiming activation or editor
behaviour.

For a recognised existing plugin, inspect before making any integration plan:

```sh
block-runner plugin inspect plugins/acme-host --json
block-runner author preview authoring-plan.json --output-dir generated/feature-grid
# Review and approve the displayed confirmation hash.
block-runner author write authoring-plan.json --confirm '<confirmation-hash>' --output-dir generated/feature-grid

block-runner plugin preview generated/feature-grid --host plugins/acme-host
# Review the exact paths and separately approve every displayed replacement path.
block-runner plugin write generated/feature-grid --host plugins/acme-host \
  --confirm '<plugin-fingerprint>' --approve-replace '<approved-path>'

cd plugins/acme-host
npm run build
```

The recognised profile places the generated source and safe registration update into the host,
then `npm run build` produces the previewed build target. Create the host's normal delivery ZIP
and run the same `proof --profile full` route; source integration or a build alone is not a
runtime verification.

### WordPress proof profiles

Headless validation is a fast first rung. A generated plugin needs a separate real-WordPress proof before any claim that it activates, registers, edits, renders, or supports pattern overrides is credible. The `proof` command runs the cumulative profile you select against an installable ZIP and a checked-in JSON fixture:

| Entry point | Basic install requirements | Optional proof requirements |
| --- | --- | --- |
| Library plus `convert`, `assemble`, `validate`, `fix`, `author`, `plugin`, `context`, and `skill` | Block Runner's production dependencies. WP-CLI remains an external requirement only when selected for context, token, or media resolution. | None. |
| `proof --profile headless` | The same deterministic Gutenberg validator. | None; it does not start Docker. |
| `proof --profile runtime` or `editor` | — | Exact `wp-env`, Playwright, WordPress Playwright helpers, and Axe; Docker; an explicitly installed Chromium browser. |
| `proof --profile full` | — | The runtime/editor toolchain plus exact `pixelmatch` and `pngjs` visual-proof packages. |

The 0.9.0 package inventory moves the six real-WordPress/browser packages from the
19 direct production dependencies to six exact optional peers (retained as development
dependencies for this repository). A basic installed dependency tree therefore has none of
`@wordpress/env`, `@playwright/test`, `@wordpress/e2e-test-utils-playwright`, `axe-core`,
`pixelmatch`, or `pngjs`; install them only in a project that runs real-WordPress proof.

Set up the runtime/editor proof boundary before requesting `runtime` or `editor`:

```sh
npm install --save-dev --save-exact \
  @wordpress/env@11.12.0 \
  @playwright/test@1.61.1 \
  @wordpress/e2e-test-utils-playwright@1.51.0 \
  axe-core@4.11.0
npx --no-install playwright install chromium
```

The `full` profile adds the visual-proof pair:

```sh
npm install --save-dev --save-exact pixelmatch@7.1.0 pngjs@7.0.0
```

This is deliberately explicit: the proof command never downloads tooling or a browser, and
never makes a model call. If its optional tools are absent or on the wrong version, the receipt
is blocked before Docker starts and prints this exact install command. A working Docker CLI and
daemon are still required for real-WordPress profiles.

```sh
# Fast Gutenberg markup check; no Docker is started.
block-runner proof dist/acme-hero.zip --profile headless --markup fixtures/hero.blocks.html --input fixtures/hero.source.html --fixture fixtures/hero.proof.json

# Docker/MySQL WordPress 7.1, visible inserter, save/reopen, frontend, deactivation,
# visual and Axe checks. Evidence and the final receipt are SHA-256 addressed.
block-runner proof dist/acme-hero.zip --profile full --markup fixtures/hero.blocks.html --input fixtures/hero.source.html --fixture fixtures/hero.proof.json --receipt-dir artifacts/proof
```

Profiles build on each other: `headless` validates Gutenberg markup; `runtime` installs and activates the ZIP and checks PHP, REST, client registries, and observed runtime pins independently; `editor` adds visible insertion, every declared editable field, save, and reopen; `full` adds frontend, static deactivation, pattern override, visual, and accessibility gates. A required `fail`, `skip`, `blocked`, or missing result fails the selected profile. `not_applicable` can pass only for media when the fixture explicitly has no media; it never substitutes for omitted proof configuration.

The fixture supplies the generated block name, a non-empty editable field inventory, a titled pattern fixture with edits to persist, frontend scope/expectations, reviewed visual golden/masks/threshold, and Axe/manual-review scopes. The browser always navigates to the post it created and published during the run, then records that ID and permalink. Golden images are read-only inputs: the runner stores expected, actual, and diff evidence but never refreshes a golden. Axe output is preserved in full; it is an automated check plus a separately recorded manual-review status, not a claim of complete WCAG conformance.

Proof tooling is exact-pinned as optional peers and retained in this repository's development dependencies. The included `proof/wp-env.json` pins WordPress core 7.1 and PHP 8.3, while the packed `proof/dependency-pins.json` preserves the direct WordPress package integrity pins that npm intentionally omits from package tarballs. The receipt additionally captures running-container image IDs, database/PHP/core/theme/browser observations, observed plugin metadata, Node and WordPress-package pins, generator/input/plugin/ZIP hashes, command logs, and every evidence object. The environment gate verifies that every retained observation command exited successfully, parses each value against its requested version/hash format, and requires the lockfile or packed pin snapshot plus integrity-pinned direct `@wordpress/*` packages. Missing or malformed observations block the runtime profile. Use `--no-run` only to produce an honest blocked diagnostic receipt after proof tooling is available.

`npm run test:proof:mutations` is an opt-in Docker acceptance suite. It builds deliberately broken plugin ZIPs and proves that registration, save, stylesheet, and pattern failures reach their respective independent gates; it does not run as part of the ordinary unit suite.

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

`convert` adds styling flags:

| Flag | Description |
| --- | --- |
| `--styling <level>` | Styling ceiling: `strict`, `relaxed` (default), `open`. See [Styling fidelity](#styling-fidelity). |
| `--css-out <path>` | Write the sidecar CSS emitted by `--styling open` to a file. |

`convert` adds media-resolution flags:

| Flag | Description |
| --- | --- |
| `--resolver <kind>` | Media resolver: `noop`, `map`, `wpcli`, `rest`. |
| `--wp-url <url>` | WordPress URL for `wpcli` or `rest` resolution. |
| `--wp-user <user>` | WordPress username for `rest` resolution. |
| `--wp-app-password-env <name>` | Env var holding a WordPress application password. |

`author <html> --name <namespace/slug> --json` analyses exactly one design and returns a canonical
plan; it does not write source. Use `author preview` then the confirmed `author write` command to
materialize the compiler-owned package. Shared generated CSS is registered through `block.json`'s
`style` field, while `editorStyle` is reserved for explicitly supplied editor affordances.

`skill --install` adds installation flags:

| Flag | Description |
| --- | --- |
| `--scope project\|user` | Install for the current project (default) or the current user. |
| `--target all\|agents\|claude` | Install both discovery copies (default), only `.agents/skills`, or only `.claude/skills`. |
| `--dir <path>` | Install under one explicit skills directory; cannot be combined with `--scope` or `--target`. |
| `--dry-run` | Show resolved destinations without writing files. |
| `--force` | Replace locally changed or unmanaged files at canonical bundle paths. |

Installed instructions pin runtime commands to the package version that installed them, while
their explicit update command stays on `@testing` while authoring is testing-only. Re-run
`npx -y block-runner@testing skill --install` to update them. Existing local edits are refused
unless `--force` is explicit.

An installation made by 0.7.x predates the managed manifest, so the first upgrade is
deliberately refused as unmanaged. Review that copy, rerun once with `--force`, and remove the
preserved root-level `GUIDE.md` after confirming the new `references/GUIDE.md` copy.

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
  with: { node-version: 22.13.0 }
- run: npx block-runner validate "content/**/*.html" --strict
```

## Library

The library is ESM-only and requires Node.js ^20.19.0 || ^22.13.0 || >=24.0.0. This means
Node 20.19.0+ on the 20.x line, Node 22.13.0+ on the 22.x line, or Node 24.0.0+. Node 21 and
23 are intentionally unsupported. CommonJS callers should use
`await import('block-runner')` rather than `require('block-runner')`.

```ts
import { canonicalize, convert, validate } from 'block-runner';

const validation = await validate(markup);
const fixed = await canonicalize(markup);
const converted = await convert(html, { resolver: 'noop' });
```

### Registered-block authoring contract

`GeneratedAuthoringPlan` is the public authoring contract at the preview/confirmation/write
boundary. `AuthoringPlan` remains the semantic input contract for existing consumers, with
`SemanticAuthoringPlan` available as its additive alias. HTML analysis (`author()`) and the
deprecated semantic `compileAuthoringPlan()` adapt that contract; their returned `canonicalPlan`
is a `GeneratedAuthoringPlan` that consumers review and write.
The runnable [authoring lifecycle example](examples/authoring-plan.ts) uses the same shape as the
CLI and skill examples from proposal through preview, confirmation identity, and generation.

| Supported entry point | Compatibility boundary |
| --- | --- |
| `GeneratedAuthoringPlan`, `validateAuthoringPlan`, `hashAuthoringPlan`, `renderAuthoringPreview`, `planRegisteredBlockOutput`, `compileRegisteredBlock`, destination inspection/write helpers | Supported v1 confirmation contract. The canonical hash is its sole plan identity. |
| `AuthoringPlan` / `SemanticAuthoringPlan`, `author()` and `compileAuthoringPlan()` / `compileAuthoringBlock()` | Supported semantic adapters. They return a `GeneratedAuthoringPlan`; semantic input is not a second preview/write contract. The compile names are deprecated through 1.x. |
| `generateRegisteredBlock`, `materializeAuthoringPlan` | Deprecated compatibility aliases through 1.x. Migrate to `compileRegisteredBlock`; no runtime behaviour changes. |
| `emit*`, `validateBlockMetadata`, generated-source and destination primitives | Advanced/internal-facing helpers. |
| `convert`, `assemble`, `validate`, `fix`/`canonicalize`, `extractIntent`, `realize` | Existing page-content APIs, unchanged and outside registered-block authoring. |

`target.metadata` carries hash-bound native `block.json` metadata without forcing a reduced
vendor schema at plan parsing time. The static compiler validates capabilities: executable keys
and string `metadata.variations` PHP-file references fail with a precise compilation error.
Inline declarative variation records and safe native metadata pass through unchanged.

Migration boundary: `AuthoringPlan` remains the supported semantic import throughout this
compatibility line, and `SemanticAuthoringPlan` is an additive alias. Use
`GeneratedAuthoringPlan` for every confirmation flow. Existing semantic values remain accepted
by the deprecated adapters.
Passing one to `compileRegisteredBlock` intentionally fails with
`invalid authoring plan: $.version must be 1`; adapt it first and preview the returned canonical
plan. No page-content API is renamed or removed by this migration.

## Synced-pattern overrides (WordPress 7.1)

The semantic adapter `compileAuthoringPlan()` makes native content regions of a generated wrapper ready for
WordPress's synced-pattern override flow. It adds a deterministic `metadata.name` and explicit
`core/pattern-overrides` binding only to supported Core child attributes: rich text
`content`, image `id`/`url`/`alt`, and button `text`/`url`. Layout remains the one canonical
InnerBlocks template; the compiler never binds or synthesizes `innerBlocks`.

Stable names derive from the reviewed plan path, so a synced pattern stores an instance's local
values in the normal `core/block` `content` map. Use `templateLock: 'all'` or
`'contentOnly'` when the pattern must retain canonical structure.

The full proof route is intentionally fail-closed:

```sh
block-runner proof generated-plugin.zip \\
  --profile full \\
  --input design.html \\
  --markup generated.blocks.html \\
  --fixture proof-fixture.json
```

It starts a real WordPress 7.1 `wp-env`, records the canonical `wp_block` content and each
`core/block.content` instance value in an immutable receipt, then verifies two instances,
reopen, canonical update, reset, structural policy, a missing-binding negative, and frontend
output. Consumer proofs require an installable plugin archive and reviewed visual/accessibility
inputs for a passing full receipt.

The repository builds its generated fixture plugin and native markup from
`test/fixtures/authoring/pattern-overrides.plan.json`. Its WordPress visual assertion compares
the completed page with the checked-in, reviewed
`proof/wordpress-7.1-pattern-overrides.expected.png` golden; it never creates a baseline while
evaluating one. The real receipt runs without a proof adapter or externally supplied artifacts:

```sh
npm run verify
npm run test:proof:wordpress
```

`verify` runs repository and packaging checks; `test:proof:wordpress` runs the real editor and
frontend lifecycle. The latter requires a working Docker CLI and daemon. Proof commands record bounded
Docker, `wp-env`, and browser phases in receipt evidence, so a failed runtime is reported as a
specific blocked or failed phase instead of exhausting the general test timeout.

On GitHub Actions, the separate WordPress proof job uploads a
`wordpress-7.1-pattern-overrides-receipt` artifact on success or failure, retained for 14 days. It contains
`receipt-index.json`, the content-addressed `receipts/sha256` record, and its
`evidence/sha256` objects, so reviewers can inspect the WordPress 7.1 lifecycle evidence from
the relevant build without committing environment-specific run output.

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
| `open` | Also keep CSS no block can express, by putting a class on the block and emitting that CSS as a stylesheet you ship alongside. Look preserved, structure still editable. |
| `source` | Keep the original markup as a Custom HTML block. Exact, but not editable. Last resort. |

You set one ceiling. Per block, Block Runner uses the **strictest level that still
captures the design**, and never goes past your ceiling. Configure it in
`block-runner.config.mjs`, or per run with `--styling`:

```js
export default { styling: 'relaxed' }; // the default
```

Styling is read from inline `style` attributes and from single-class `<style>` rules
(`.hero { … }`). An inline style outranks a class rule, matching CSS. Every declaration
is accounted for: mapped onto the block, recognised as consumed by the structure, or
reported with the input line and the rule that authored it — nothing is dropped silently.

`open` emits a stylesheet, so it needs somewhere to put it. `--styling open` requires
either `--css-out <path>` or `--json` (where it arrives as `sidecarCss`) and is an error
otherwise — a level that quietly discarded the CSS it promised to keep would be worse
than not offering it.

Custom JavaScript is never inlined. A behavior maps to a native interactive block,
comes from a block plugin, or is dropped, and every drop or escalation is reported.

### Registered-block CSS and assets

`author` accepts compiled CSS through `author.styles.css` (or `<style>` content in the design), but
its `author.styles.mode` must explicitly be `css` or `tailwind`. It does not infer Tailwind from
compiled utility declarations or ship it at runtime. In `tailwind` mode, supply the complete
`author.styles.tailwind` graph: CSS entries, resolved imports and directives, sources, safelist,
plugins, environment, browser target, and the project’s pinned compiler. `author` materializes that
graph and runs the compiler; source directives use its output, while separately supplied CSS must
match it. Missing inputs, unreadable entries/imports, compiler failures, and mismatches are reported
field by field and generation stops. Every referenced `--tw-*` variable must also be defined in that
output.

Non-native selectors are preserved only when they can be rooted beneath the generated block's
deterministic `.wp-block-<namespace>-<slug>` class. Responsive, container-query, and pseudo-state
rules retain their conditions. Preflight/global rules, escaping selectors, imports, and keyframes
are ledgered and blocked rather than silently scoped. Confirmed local static assets are copied
into `assets/` and rewritten; remote image URLs remain external by default.

Authoring records the target theme snapshot hash, configured WordPress viewport ranges, unresolved
custom variables, and reset assumptions in the hash-bound plan preview. It never edits `theme.json`.
Without that target context it explicitly limits its fidelity claim; conditional source CSS remains
scoped rather than being mechanically renamed as a responsive native state.

Local WOFF/WOFF2 fonts require an explicit source, SHA-256, ownership, and license decision.
Approved font families get block-specific names and shared editor/frontend CSS. Full redistribution
notices are retained separately in the production archive because minifiers can remove CSS comments.
Unlicensed or unsupported faces use a safe fallback with a source-located warning. Destination
theme font presets do not require copying font files.

> Status: `strict`, `relaxed` and `open` are implemented. `source` is not built yet and is
> rejected rather than silently downgraded — though the converter already falls back to a
> Custom HTML block for structure it cannot convert.

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

The registered-block authoring corpus is deliberately separate from that conversion suite:

```sh
npm run authoring:prove -- --plans ./candidate-plans
```

This requires saved canonical candidate plans and the configured WordPress runtime worker; see
the corpus README. Without them it reports blocked work, not a benchmark result. It does
not turn unrun browser/editor work or a model/tool failure into a zero product score. The 0.9
testing-release package, installer, and activation checks are run with `npm run release:check`;
see [`release/0.9-testing`](release/0.9-testing/README.md) for the receipt matrix and the
draft product-preview brief.

## License

GPL-2.0-or-later.
