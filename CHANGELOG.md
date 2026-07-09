# Changelog

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
