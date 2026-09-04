# Changelog

## 0.9.0 — 2026-09-04 — testing release

### Added

- A separate registered-block authoring benchmark and release matrix. Its fixture outcomes and
  dimension scores are intentionally independent of the historical HTML-to-block benchmark.
- Receipt-backed release-candidate checks for the package artifact, canonical skill, installer,
  and activation smoke. Model/tool errors are invalid measurements, not zero product scores.

### Release status

`0.9.0` is configured for the `testing` dist-tag once its receipt-backed release gate passes. It
is a testing release; 1.0 remains contingent on real-project feedback and resolved failures.

## 0.8.0 — 2026-09-02

### Changed

- Updated the bundled Gutenberg runtime to the WordPress 7.1 package releases.
- **The bundled agent skill is now canonical and cross-harness.** Its source lives at
  `skills/block-runner/`, where the directory matches the frontmatter name, with the detailed
  guide under `references/`. `skill --install` copies the complete bundle to both
  `.agents/skills/block-runner/` and `.claude/skills/block-runner/` by default; `--scope`,
  `--target`, and `--dir` cover user-wide, single-harness, and arbitrary roots.
- **Skill installation is inspectable and guarded.** `--dry-run` resolves destinations without
  writes, repeat installs are idempotent, managed files carry hashes, local changes are refused
  unless `--force` is explicit, and installed runtime commands are pinned to the installing
  package version while the explicit update command stays on `@latest`.

### Fixed

- Custom HTML fallbacks retain their source markup after the WordPress 7.1 `core/html`
  serialization change; unsupported input no longer collapses to an empty block.
- Validation no longer rejects a working Custom HTML fallback because `core/html` has no
  canonical saved output. The fallback warning and count remain unchanged.
- The skill metadata now states its Node/shell/registry requirements, and the guide no longer
  describes an uncached `npx` run as fully offline or treats frontend-scraped HTML as supported
  authored input.
- Pre-manifest 0.7.x installations now fail closed on their first upgrade. After review, rerun
  with `--force`; the obsolete root-level `GUIDE.md` is preserved rather than deleted.
- Skill installs reject symlinked discovery roots, and default dual-target installs preflight
  ordinary write permissions across both destinations before changing either one.

## 0.7.1

### Fixed

- **The guide now says where the blocks go.** It stopped at "here is valid markup", leaving an
  agent holding correct output with no instruction on what to do with it — so a request like
  "add a pricing section to my site" ended in improvisation. `GUIDE.md` §5 covers the three
  endings: write it where the user asked, offer to write it through an available WordPress
  connection, or show it with the paste instruction. Including the one users get wrong —
  block markup must go into the **Code editor** (`Ctrl+Shift+Alt+M`), not the visual editor,
  which turns it into a mess and reads as the tool being broken.

No code changes; the CLI and library are identical to 0.7.0.

## 0.7.0

**Block Runner now ships a skill.** Agents get markedly better conversions when told how to
use the tool, so the instructions travel with the package instead of being rediscovered by
every consumer.

```sh
npx block-runner skill              # print the guide — nothing installed or written
npx block-runner skill --install    # install it as a skill
```

Measured on the project's own 53-fixture benchmark, the guide takes the corpus from **28 to
97**, with 0 invalid and 0 fallbacks. Those figures come from a controlled harness rather than
a live session, so treat them as a ceiling.

### Added

- **The skill, shipped in the package and readable by any harness.** `skill/GUIDE.md` is the
  content; `skill/SKILL.md` is a thin wrapper over it. `skill --install` writes both into
  `.claude/skills/block-runner/`, with `--dir` for harnesses that keep skills elsewhere. The
  guide covers which command to reach for, the block mappings per section type, the
  validate/fix loop, and how to fail safely without stranding the user.
- **`assemble` — build blocks from a described structure, not from markup.** The command the
  skill drives. Give it an intent tree (JSON naming which blocks go where) and it builds the
  result with `createBlock`, so the output cannot be invalid. Describing a structure suits a
  model far better than authoring block markup, which is where invalid output comes from.
  Also available as `assemble` / `extractIntent` / `realize` library exports.
- **A hint when a conversion falls back.** A `convert` run that drops to Custom HTML now says
  so on stderr and in `report.hint`, pointing at the path that usually handles that input
  cleanly. It is advisory: it never affects the exit code, the summary counts, or `--strict`.

### Changed

- **Media resolution and brand-token repair are shared by every path.** `convert` and
  `assemble` now run the same finalization, so a tree built from intent resolves images and
  maps colours onto theme presets exactly as a converted one does.

### Notes

- `--styling` and `--css-out` do not apply to `assemble` and are rejected with an explanation:
  an intent tree carries structure and content, never the source CSS. Use `convert` when the
  styling matters.
- Malformed or empty intent input is a hard failure (exit `1`) naming what went wrong, rather
  than a successful run that produced nothing.
- `convert`, `validate`, and `fix` are unchanged. Verified by running the benchmark at the
  previous release and at this one: identical scores across all 53 fixtures.

## 0.6.0

### Added

- **CSS is now carried onto blocks as native, editable styling.** Previously only
  `background-image` was read and every other declaration was discarded in silence — a
  `<div style="padding:64px;background:#f5f5f5">` produced a correct block tree with none of
  its design. Declarations from inline `style` attributes and from single-class `<style>`
  rules (`.hero { … }`) now map onto the block's own attributes, so padding lands in the
  spacing control and colours in the colour picker. Inline styles outrank class rules, and
  `!important` and shorthand resets are honoured as CSS defines them.
- **A `styling` ceiling: `strict` · `relaxed` · `open`.** `strict` keeps only values that
  snap onto theme presets; `relaxed` (the default) keeps exact values on the block;
  `open` additionally preserves CSS no block attribute can express, by putting a class on
  the block and emitting a stylesheet. Set it in config or per run with `--styling`.
- **`--css-out` and `report.sidecarCss`** for the stylesheet `open` produces. `--styling open`
  without one of them is an error: a level that quietly discarded the CSS it promised to keep
  would be worse than not offering it.
- **Every declaration is accounted for.** Each one is reported as mapped, consumed by the
  structural rules, or dropped — with the input line, the selector, and the rule that authored
  it. Warnings name the class (`max-width: 600px in .hero`) so the fix lands upstream.
- **`text-align` support**, mapped through `style.typography.textAlign`.
- **WordPress 7.1 `minWidth`**, gated on the block opting in, and recognised-but-refused
  `text-shadow` (Global-Styles-only in 7.1, so a per-block value would render CSS the editor
  gives no control over — the warning points at `theme.json`).
- **Capability gating against the real target site.** With a wesper `--context` manifest,
  styling is admitted only where the pinned block library *and* the target site's own block
  registry agree, so degradation across WordPress versions is measured rather than hardcoded.

### Fixed

- **Background images are chosen by the CSS cascade, not by first match.** A background that a
  later declaration replaced or removed no longer becomes cover media — the structural rules
  and the styling ledger now read a style attribute through the same parser.

### Changed

- `@wordpress/block-editor` is now a direct pinned dependency. It was already present
  transitively and governs the emitted markup, so it belongs in the pin rather than resolved
  by chance.

## 0.5.1

### Changed

- **Stop shipping sourcemaps.** `dist/*.js.map` were ~340KB of the published
  tarball and served no purpose for consumers. Dropping them roughly halves the
  package (unpacked 542KB → 202KB) and avoids leaking local build paths.

## 0.5.0

### Fixed

- **Inline SVG (and any foreign element) no longer crashes conversion.** An `<svg>`
  or MathML node anywhere in the input threw `className.split is not a function`
  and aborted the whole run with no output. Foreign elements now route straight to
  Custom HTML, and a per-rule error boundary guarantees no single node can abort a
  run.

### Added

- **Native-block coverage for traditional content.** New rules map `<table>` →
  `core/table` (colspan/rowspan/scope + `<caption>`), `<blockquote>` → `core/quote`,
  `<pre><code>`/`<pre>` → `core/code`/`core/preformatted`, `<hr>` → `core/separator`,
  `<video>`/`<audio>` → `core/video`/`core/audio` (with `<track>`), `<details>` →
  `core/details`, YouTube/Vimeo `<iframe>` → `core/embed`, and multi-image `<figure>`
  → `core/gallery`. A `<figure>` dispatcher carries `<figcaption>` onto the right block.
- **Atomic enclosing-unit fallback.** When a block's rich text contains content the
  editor can't hold (inline SVG/iframe, block-level markup), the whole enclosing block
  falls back to Custom HTML with a warning at the offending node — output, render, and
  editor-load state always agree. Empty decorative inline hooks (e.g. a CSS chevron
  `<span>`) are stripped so the block stays native; empty *semantic* elements
  (`id`/`href`/`datetime`/`aria-*`) fall back instead of being lost.

### Security

- **Hardened URL sanitization.** `javascript:`/`vbscript:` schemes obfuscated with
  control characters or whitespace (`java\nscript:`) are now stripped, and executable
  `<iframe srcdoc>` is removed before it can reach a Custom HTML block.
- **Exact-hostname embed matching.** Provider detection parses the URL and matches exact
  hostnames over HTTPS with anchored path shapes, so lookalike domains
  (`notyoutube.com`) can no longer be rewritten into a trusted `core/embed`.

## 0.4.1

- Strip unused Gutenberg media WASM from installs: override
  `@wordpress/vips` + `wasm-vips` to empty stubs, and prune them in
  `postinstall` when this package is a nested dependency (~155MB).
  Headless convert/validate never calls that pipeline.

## 0.4.0

### Dependencies

- `@wordpress/blocks` **14.15 → 15.23**, `@wordpress/block-library` **9.26 → 10.1**
  (current Gutenberg headless stack).
- `jsdom` 24 → 29, `commander` 12 → 15.
- Dev: `vitest` 2 → 4, `tsup` 8.5, `tsx` 4.23, `typescript` 5.9, types updated.
- Overrides: `uuid@11.1.1`, `esbuild@0.28.1` (clear remaining audit findings).

### Security

- `npm audit` reports **0 vulnerabilities** (was 18: 1 critical, 1 high, 16 moderate).

## 0.3.3

- README hero + benchmark images use jsDelivr (`cdn.jsdelivr.net/gh/...`) so they
  render on npmjs.com (raw.githubusercontent.com was returning 429).

## 0.3.2

- `check:private` supports both npm ≤11 and npm ≥12 `pack --json` shapes.
- CI/release pin `npm@11` (not floating `latest` / npm 12 engine cliff).

## 0.3.1

- Fix package-lock sync so `npm ci` works in CI (missing optional peer entries).
- Harden `check:private` JSON extraction for npm 11 (bracket-balanced parse;
  release workflow was failing after green tests).

## 0.3.0

### Features

- **Token repair** — map raw colors/fonts/spacing to theme presets via
  `noop` / `file` / `wpcli` / `rest` / `context` resolvers (`--token-resolver`,
  `--theme-json`, `--context`, `--token-match`).
- **`block-runner context`** — collect a [wesper](https://www.npmjs.com/package/wesper)
  `site.context.json` manifest over WP-CLI (library: `collectSiteContext`).
- Depend on published `wesper@0.0.2` for site context collection.

### Fixes & process

- README hero + benchmark images use absolute GitHub URLs so they render on npm.
- Harden `check:private` against `npm pack` stdout pollution (CI was red on main).
- CLI `--version` reads from `package.json` (no more hardcoded version).
- Package hygiene: `author`, `publishConfig`, top-level `types`.
- `engines.node` raised to `>=20` (Node 18 EOL); CI matrix is 20 / 22 / 24.
- Build target is `node20`; `pack:check` skips lifecycle scripts.

## 0.2.0

- Gate: render Gutenberg validation issues as readable messages.
- Prepare/prepublish build so git installs and npm publish produce `dist/`.
- Pre-commit hook config and “run it anywhere” docs.
- Benchmark section + fidelity chart in the README.

## 0.1.0

- Initial public v1 implementation: headless Gutenberg boot, validation,
  canonicalization, deterministic conversion rules, media resolvers, CLI, and
  library API.
