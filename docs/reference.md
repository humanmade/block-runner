# Command and API reference

Start with the [README](../README.md) for a first conversion, or the [architecture guide](architecture.md) for the code paths. This reference covers commands, configuration and compatibility details. The [registered-block delivery guide](../skills/block-runner/references/AUTHORING.md#shipped-notice-source-to-standalone-zip) owns the complete source-to-ZIP procedure.

## CLI

For a local installation, run these commands with `npx --no-install block-runner`.

| Command | What it does |
| --- | --- |
| `convert` | HTML to native post-content blocks using deterministic rules. |
| `author <html> --json` | Analyze one authored design into a canonical registered-block plan, checked source, and style/asset ledgers. Does not write source. |
| `assemble` | An intent tree to native page-content blocks, assembled and validated by Gutenberg. |
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

# If a standalone plugin suits the project, preview that destination.
block-runner plugin preview ./generated-block --standalone ./my-notice-plugin
```

`plugin preview` never writes. Its fingerprint binds the exact target files; pass it to
`plugin write --confirm <fingerprint>`. Existing PHP or `package.json` files are marked as
separate replacement approvals, so their absolute preview paths must also be supplied with
`--approve-replace <path...>` before they can change. An unrecognised host is refused without
writing. Retain the generated source for developer integration into the existing project, or
choose a standalone plugin if that suits the project.

Standalone previews include the complete, versioned npm lock for their pinned local
`@wordpress/scripts` toolchain. Confirmed writes only materialize the reviewed source and lock
bytes: they do not resolve dependencies, contact a registry, or run npm. Run `npm ci` separately
when preparing the generated plugin to build or package it.

### Registered-block authoring

HTML analysis returns `package.canonicalPlan`, a versioned `GeneratedAuthoringPlan` containing
the target, native structure, fields, locks, style/asset decisions and warnings. Unresolved Custom
HTML, unsafe assets and unsupported CSS are failures, not a ready-to-install package.

Preview the plan before writing:

```sh
block-runner author preview authoring-plan.json --output-dir generated/feature-grid
```

The preview shows the tree, files, warnings and a confirmation hash bound to the plan and
destination. It writes nothing and does not prompt. After explicit approval, pass that hash and
the same destination to `author write`.

Missing or stale confirmation, changed destinations, unsafe paths and symlinks are refused.
Existing-file replacements require a separate decision. The compiler owns file content;
`files` can declare only its output paths and create/replace operations.

### Complete source-to-build routes

For the complete source-to-ZIP walkthrough, the route-specific confirmation boundaries, and the
source-only and existing-plugin alternatives, read [registered-block delivery](../skills/block-runner/references/AUTHORING.md#shipped-notice-source-to-standalone-zip).
It is bundled with the installed skill, so it remains available without this checkout.

The shipped [`authoring-plan.mjs`](../examples/authoring-plan.mjs) is the executable notice plan used
by that walkthrough. After installation it is available at
`node_modules/block-runner/examples/authoring-plan.mjs`; it writes only JSON on success, so its
redirected output is the reviewed plan. The marked proposal example in the authoring reference
teaches the proposal API; it is a separate contract, not a replacement for the complete notice
route.

All delivery routes begin with a reviewed `authoring-plan.json`; use `author <design.html> --name
<namespace/slug> --json` when deterministic HTML analysis must produce its canonical plan. The
author confirmation binds that plan and source destination, while the separate `plugin preview`
fingerprint binds the wrapper or host destination. Missing or stale confirmation, changed
destinations, unsafe paths and symlinks are refused; existing-file replacements require separate
approval. Neither route requires hand-written React, PHP, block metadata, or a repair step.

The detailed reference covers [standalone delivery](../skills/block-runner/references/AUTHORING.md#standalone-plugin-output),
[recognised existing-plugin integration](../skills/block-runner/references/AUTHORING.md#existing-plugin-output),
and [source-only developer integration](../skills/block-runner/references/AUTHORING.md#source-for-an-existing-project-developer-integration).
Source delivery or a successful build is not WordPress runtime proof; use the applicable proof
profile with the reviewed ZIP, source, markup, and fixture before claiming activation, editing,
saved-content reopening, or frontend behavior.

### WordPress proof requirements

Headless validation is a fast first rung. A generated plugin needs a separate
real-WordPress proof before any claim that it activates, registers, edits, or
renders is credible. Before running, the proof report derives the required gates
from the selected claim and the hash-matched artifact contract rather than treating
every artifact as pattern-override-ready:

| Claim / profile | What it establishes | Extra proof requirements |
| --- | --- | --- |
| `generated` | Deterministic Gutenberg validation. | None; it does not start Docker. |
| `built` | ZIP installation, activation, and runtime registration. | Exact `wp-env`, Playwright, WordPress Playwright helpers, and Axe; Docker; an explicitly installed Chromium browser. |
| `editor-verified` | Built behavior plus insertion, declared editable fields, save, and reopen. | The runtime/editor toolchain. |
| `fidelity-checked` | Editor behavior plus frontend, visual, and automated accessibility checks. | The runtime/editor toolchain plus exact `pixelmatch` and `pngjs`. |
| `pattern-verified` | The two-instance pattern-override lifecycle. | A hash-matched artifact contract that declares `capabilities.patternOverrides: true` and its complete pattern fixture. |
| `full` | The exhaustive release-profile gate set. | All full-profile inputs, including pattern, visual, and manual-review evidence. |

Library plus `convert`, `assemble`, `validate`, `fix`, `author`, `plugin`, `context`,
and `skill` need only Block Runner's production dependencies. WP-CLI remains an
external requirement only when selected for context, token, or media resolution.

The browser-proof packages are optional peers with compatible caret ranges, absent from a basic
installation. The proof setup below deliberately pins the known-good versions for reproducible
real-WordPress proof.

Set up the runtime/editor proof boundary before requesting `runtime` or `editor`:

```sh
npm install --save-dev --save-exact \
  @wordpress/env@11.15.0 \
  @playwright/test@1.61.1 \
  @wordpress/e2e-test-utils-playwright@1.51.0 \
  axe-core@4.11.0
npx --no-install playwright install chromium
```

The `full` profile adds the visual-proof pair:

```sh
npm install --save-dev --save-exact pixelmatch@7.1.0 pngjs@7.0.0
```

Proof never downloads tooling or browsers or calls a model. Missing or mismatched tooling blocks
the run before Docker starts and reports the required installation command. Runtime profiles
also require a working Docker daemon.

```sh
block-runner proof dist/acme-hero.zip --profile full \
  --markup fixtures/hero.blocks.html --input fixtures/hero.source.html \
  --fixture fixtures/hero.proof.json --receipt-dir artifacts/proof
```

The fixture supplies editable fields, frontend expectations and reviewed visual/accessibility
inputs; pattern claims require a pattern fixture. Required failed, skipped, blocked or missing
gates fail the selected claim. Golden images are read-only inputs, never refreshed during proof.
Axe results are automated evidence, not complete accessibility certification or owner acceptance.

The pinned environment and package hashes, runtime observations, logs and evidence objects are
retained in the receipt. See the [proof guide](../skills/block-runner/references/AUTHORING.md#proof-is-part-of-completion)
and [release gate](https://github.com/humanmade/block-runner/blob/main/dev/release/0.9-testing/README.md)
for profile inputs, accepted upstream findings and release requirements.

### Flags

Page-content options (see each command's `--help`):

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

Installed instructions pin runtime commands to the package version that installed them. To
update an installed skill after upgrading Block Runner, re-run
`npx --no-install block-runner skill --install`. Existing local edits are refused unless
`--force` is explicit.

An installation made by 0.7.x predates the managed manifest, so the first upgrade is
deliberately refused as unmanaged. Review that copy, rerun once with `--force`, and remove the
preserved root-level `GUIDE.md` after confirming the new `references/GUIDE.md` copy.

### Exit codes

- `0`: clean
- `1`: problems found
- `2`: usage or I/O error
- `3`: headless Gutenberg boot failure

## Run it anywhere

Use the CLI in shell scripts, pre-commit hooks or CI.

**pre-commit** (add to `.pre-commit-config.yaml`):

```yaml
- repo: https://github.com/humanmade/block-runner
  rev: v0.9.1
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

```js
import { canonicalize, convert, validate } from 'block-runner';

const converted = await convert('<p>Hello WordPress</p>', { resolver: 'noop' });
const validation = await validate(converted.output);
const fixed = await canonicalize(converted.output);
```

`realize(json)` consumes an intent JSON string and returns the complete assembly report, including media/token processing and validation. CLI `assemble` calls it. Library `assemble(nodes)` only builds Gutenberg block objects; it does not run that finalisation workflow.

### Registered-block authoring contract

`GeneratedAuthoringPlan` is the public authoring contract at the preview/confirmation/write
boundary. `AuthoringPlan` remains the semantic input contract for existing consumers, with
`SemanticAuthoringPlan` available as its additive alias. HTML analysis (`author()`) returns a generated plan from HTML and an optional source-linked proposal. The deprecated `compileAuthoringPlan()` adapts the older semantic input. Both expose a `canonicalPlan` that consumers review and write.

For HTML authoring, the primary path first calls `collectSourceEvidence()` and then sends
`AuthorOptions.proposal`: an ordered native structure with the returned `sourceRef`s, editor
fields/locks, and reviewed source decisions. Block Runner owns exact source hashes/content coverage,
assets, native style adapters, CSS coverage, and mandatory warnings before returning the canonical
plan. Inspection/validation need no consent; only the final canonical write identity does. Existing
complete `AuthorOptions.plan` callers remain supported as an advanced compatibility route.
The runnable [authoring example](../examples/authoring-plan.mjs) derives a canonical plan from
HTML and a semantic proposal using only public imports. From a project with Block Runner installed:

```sh
node node_modules/block-runner/examples/authoring-plan.mjs > notice.plan.json
npx --no-install block-runner author preview notice.plan.json --output-dir generated/notice
# Review the complete preview and approve its destination-bound confirmation hash.
npx --no-install block-runner author write notice.plan.json \
  --confirm '<confirmation-hash-from-preview>' --output-dir generated/notice
```

The example emits JSON only. The CLI supplies the same destination-bound preview and write checks
used by other plans; the plan hash alone is not a write confirmation. Continue with either plugin
packaging route above.

#### Regeneration and saved content

Compiler-owned output is only replaced after the destination-bound preview marks each replacement
and its confirmation is supplied. An unchanged package is a no-op. Preview classifies a replacement
as content-defaults, style-only, or saved-markup/structure. Style and asset changes can alter
rendered appearance, but do not migrate saved block markup. Updated editor defaults apply to new
insertions; existing saved content remains its own content record, though changed editor code can alter its editing experience.

A same-identity change to saved markup, registration identity, or attribute schema is refused.
Use a new block identity, or add a tested WordPress deprecation/migration before replacing it.
Block Runner does not edit a site's database, templates, or posts. Synced-pattern canonical updates
are separate site operations and source changes make no sitewide propagation claim. Direct insertion,
synced-pattern use, and plugin deactivation each need their own WordPress acceptance proof. Generated
packages are static WordPress source and contain no Block Runner runtime dependency.

| Supported entry point | Compatibility boundary |
| --- | --- |
| `GeneratedAuthoringPlan`, `validateAuthoringPlan`, `hashAuthoringPlan`, `renderAuthoringPreview`, `planRegisteredBlockOutput`, `compileRegisteredBlock`, destination inspection/write helpers | Supported v1 confirmation contract. The canonical hash is its sole plan identity. |
| `author()` | HTML analysis with an optional source-linked proposal or complete generated plan. Returns a report containing `package.canonicalPlan` when generation succeeds. |
| `AuthoringPlan` / `SemanticAuthoringPlan`, `compileAuthoringPlan()` / `compileAuthoringBlock()` | Supported semantic adapters. They return a `GeneratedAuthoringPlan`; semantic input is not a second preview/write contract. The compile names are deprecated through 1.x. |
| `generateRegisteredBlock`, `materializeAuthoringPlan` | Deprecated compatibility aliases through 1.x. Migrate to `compileRegisteredBlock`; no runtime behaviour changes. |
| `emit*`, `validateBlockMetadata`, generated-source and destination primitives | Advanced/internal-facing helpers. |
| `convert`, `assemble`, `validate`, `fix`/`canonicalize`, `extractIntent`, `realize` | Existing page-content APIs, unchanged and outside registered-block authoring. |

`target.metadata` carries hash-bound native `block.json` metadata without forcing a reduced
vendor schema at plan parsing time. The static compiler validates capabilities: executable keys
and string `metadata.variations` PHP-file references fail with a precise compilation error.
Inline declarative variation records and safe native metadata pass through unchanged.

Pass a `GeneratedAuthoringPlan` to `compileRegisteredBlock`. Adapt legacy semantic plans first;
they are not a second confirmation contract. No page-content API is renamed or removed.

## Synced-pattern overrides (WordPress 7.1)

Generated wrappers can expose supported native child fields as synced-pattern overrides through
reviewed `fields` and `pattern.overrides`. Layout remains the canonical InnerBlocks template;
the compiler does not bind or synthesize `innerBlocks`. Generic Block Bindings are not supported.

The full proof checks two instances, save/reopen, canonical updates, reset, structural policy,
a missing-binding negative and frontend output. Use a built plugin ZIP and the reviewed fixture,
visual and accessibility inputs described under [proof requirements](#wordpress-proof-requirements).

These are checks of the supplied artifact, not a human judgement of visual fidelity, editing
feel or accessibility.

## Media resolution

Media resolution connects source image URLs to WordPress attachment IDs:

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

## Site context from Wesper

Supply a full Wesper manifest as a token source for conversion or canonicalisation:

```sh
block-runner convert '<p style="color:#0057ff">Hello</p>' --context site.context.json
```

The resolver prefers the manifest's `theme.tokens.presets`: collected colour, font-family,
font-size and spacing values map to the matching WordPress preset category and slug.
An explicitly empty registry stays empty; it does not fall back to old settings. Manifests
without this registry retain the legacy `theme.settings` route. Malformed context yields no
resolved tokens, following the existing resolver contract. This mapping does not attest the
manifest's source hash or turn partial collection into complete site compatibility evidence.

Wesper's `focusContext()` output is a derived view, not a manifest for `--context`. Callers can
map its selected tokens into `config.tokens.colors`, `fonts`, `fontSizes` and `spacing` for
the library API. Registered-block authoring separately accepts an explicit theme settings
snapshot at `author.styles.context.theme.settings`; `--context` does not populate that snapshot
or import binding permissions. Use Wesper's validation and compatibility helpers in the calling
harness when those checks are needed.

The bundled `context` command uses the pinned Wesper 0.4.1 WP-CLI collector. Its manifests
provide the native preset registry consumed by the resolver above.

## Styling fidelity

The styling ceiling controls how conversion handles CSS that does not match the target theme:

| Level | What it does |
|---|---|
| `strict` | Map to theme presets; report dropped off-theme styles. |
| `relaxed` | Keep supported off-theme values as native block attributes. |
| `open` | Also emit supported residual CSS as a sidecar stylesheet to ship alongside the blocks. |
| `source` | Reserved; not implemented. Requests are rejected. |

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
otherwise.

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
Without that target context it explicitly limits its fidelity claim. Only an exact WordPress 7.1
viewport interval on one unambiguous, supported native child can use a responsive state; every
other conditional source rule remains scoped CSS.

Local WOFF/WOFF2 fonts require an explicit source, SHA-256, ownership, and license decision.
Approved font families get block-specific names and shared editor/frontend CSS. Full redistribution
notices are retained separately in the production archive because minifiers can remove CSS comments.
Unlicensed or unsupported faces use a safe fallback with a source-located warning. Destination
theme font presets do not require copying font files.
