# Changelog

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
