# References — sources

From the deep `/research` run, 2026-06-22. Grouped by topic. Confidence:
`verified` (2+ independent or direct authoritative source) · `single-source` ·
`inference`. **Liveness:** not yet machine-checked end-to-end — run a liveness pass
before treating `single-source` links as settled.

## rawHandler / raw transforms (what gets reconstructed)

- `rawHandler` pipeline + hardcoded `core/html` fallback — `packages/blocks/src/api/raw-handling/html-to-blocks.ts`, `get-raw-transforms.ts` — Gutenberg trunk — `verified`
- Block transforms reference (raw transform docs) — https://developer.wordpress.org/block-editor/reference-guides/block-api/block-transforms/ — `verified`
- Leaf blocks with raw transforms — `packages/block-library/src/{heading,paragraph,image,list,table,quote,separator,preformatted,video,gallery}/transforms.js` — `verified` (gallery/code `single-source`)
- **Cover/Columns/Buttons have NO raw transform** — `packages/block-library/src/{cover,columns,buttons}/transforms.js` (only `type:'block'`) — `verified` (3 runners)

## Headless Gutenberg in Node

- `@wordpress/blocks` npm (CJS+ESM, Node ≥18.12, browser-assuming) — https://www.npmjs.com/package/@wordpress/blocks — `verified`
- Jest `testEnvironment:'jsdom'` — `packages/jest-preset-default/jest-preset.js` — `verified`
- **Proven Markdown→blocks headless recipe (adamziel, core contributor)** — https://gist.github.com/adamziel/7dbc995d4fc4525f76978e0c9dcfe41b — `verified`/`single-source`
- `registerCoreBlocks()` version-skew crash (`DEFAULT_LINK_SETTINGS`) — https://github.com/WordPress/gutenberg/issues/68695 — `single-source`
- ESM `build-module` lacks `type:"module"` — https://github.com/WordPress/gutenberg/issues/73363 — `single-source`
- CJS require() of ESM dep — https://github.com/WordPress/gutenberg/issues/43434 — `single-source`

## Validation / canonicalization / "Attempt recovery"

- `serialize()` regenerates from `save()` when valid OR has inner blocks (`getBlockInnerHTML`) — `packages/blocks/src/api/serializer` — `verified`
- `validateBlock` uses `isEquivalentHTML()` (semantic, not byte-identical) — `packages/blocks/src/api/validation/index.ts` — `verified`
- Block deprecation = recovery mechanism (walk deprecations → migrate → re-save) — https://developer.wordpress.org/block-editor/reference-guides/block-api/block-deprecation/ — `verified`
- Cover ~14 deprecations / Columns ~3 — `packages/block-library/src/{cover,columns}/deprecated.js` — `verified`
- Layout-support classes (`is-layout-flex/constrained`, `wp-container-*`) injected at render, not in save() — https://github.com/WordPress/gutenberg/issues/76235 — `verified`/`single-source`
- "Convert to blocks in PHP" demand, still open — https://github.com/WordPress/gutenberg/issues/13163 — `verified`

## Official WP AI direction (2025–26)

- Abilities API handbook (capability exposure, no block authoring) — https://make.wordpress.org/ai/handbook/abilities-api/ — `verified`
- MCP Adapter — https://github.com/WordPress/mcp-adapter — `verified`
- AI Client / AI Plugin (PHP SDK, v1.0.0 May 2026) — https://github.com/WordPress/ai — `verified`
- Block Bindings API (dynamic data, narrow block set; not an authoring path) — https://developer.wordpress.org/block-editor/reference-guides/block-api/block-bindings/ — `verified`

## Agentic block-authoring patterns

- `wp-blockmarkup-mcp` — verified block-schema DB + markup validation for LLMs ("don't let AI guess block HTML") — https://github.com/pluginslab/wp-blockmarkup-mcp — `verified`
- `generateblocks-skills` — source-verified skill docs to constrain AI block gen — https://github.com/wpgaurav/generateblocks-skills — `verified`
- Greenshift "GreenLight Vibe Skill" bidirectional HTML↔blocks — https://greenshiftwp.com/ai-agents-for-wordpress-that-work/ — `single-source`
- SchemaBench — LLMs fail ~40% structured-gen unaided — https://arxiv.org/abs/2502.18878 — `verified`
- Hybrid deterministic+LLM schema-envelope pattern — https://arxiv.org/abs/2508.05192 — `single-source`

## context7

- WordPress Gutenberg — `/wordpress/gutenberg` (13k+ snippets, High reputation)
- HTML To Gutenberg (jverneaut, *wrong direction* — block authoring DX) — `/jverneaut/html-to-gutenberg`
- WP Block Documentation (block HTML markup reference) — `/house-of-giants/wp-block-docs`

---
*Research run: deep tier · 5 research-runner angles + context7 · ~30 web sources ·
sourcing weighted to direct Gutenberg `trunk` inspection · as of 2026-06-22.*
