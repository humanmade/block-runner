# References — prior art (existing HTML→blocks tools)

Surveyed 2026-06-22. **Headline: nothing off-the-shelf reconstructs Cover/Columns
from HTML.** Maintained tools are PHP and leaf-only; the one JS `rawHandler` CLI is
abandoned; no public AI converter exists. The gap Block Runner targets is real.

## JavaScript / npm

| Tool | Approach | Semantic Cover/Columns? | Status | Link |
|---|---|---|---|---|
| `front/gutenberg-converter` | Wraps `@wordpress/blocks` `rawHandler`+`serialize` as a CLI — the *only* JS one | No (rawHandler can't) | **Abandoned** — 2022, pinned `@wordpress/blocks@11`, 6★ | https://github.com/front/gutenberg-converter |
| `jverneaut/html-to-gutenberg` | **Wrong direction** — Webpack plugin compiling annotated HTML templates → `block.json`/`edit.js`/`render.php` (block authoring DX) | n/a | Maintained, 114★ | https://github.com/jverneaut/html-to-gutenberg |

## PHP / WordPress

| Tool | Approach | Semantic Cover/Columns? | Status | Link |
|---|---|---|---|---|
| Alley `wp-block-converter` | DOM walk → blocks, mirrors rawHandler in PHP; WP-CLI bulk; extensible "macros" | No — leaf blocks (para/heading/list/image/quote/separator/embed) | **Maintained** — v1.8.2 Dec 2025, commits Jun 2026, 65★ | https://github.com/alleyinteractive/wp-block-converter |
| chubes4 `html-to-blocks-converter` | Wraps Automattic Blocks Engine `HtmlTransformer` (`WP_HTML_Processor`, WP 6.4+/PHP 8.1+) | No — leaf blocks; unsupported → `core/html` | **Maintained** — v0.7.2 Jun 2026, fast cadence, 23★ | https://github.com/chubes4/html-to-blocks-converter |
| Automattic `blocks-engine` | Upstream `HtmlTransformer` + FormatBridge + ArtifactCompiler; Automattic internal going public | Unclear — leaf-oriented | **New** — commits Jun 2026, 1★ (watch this) | https://github.com/Automattic/blocks-engine |
| WP core `WP_HTML_Tag_Processor` | Used for block *rendering*, not HTML→block *conversion* | n/a | Core | — |

## AI / MCP

| Tool | Approach | Note | Status | Link |
|---|---|---|---|---|
| `wp-blockmarkup-mcp` (pluginslab) | MCP: verified block-schema DB + 2-tier markup validation for LLMs | **Closest to our gate philosophy** — "don't let AI guess block HTML"; composable as our validation/reference layer | Maintained — Jun 2026, 35★ | https://github.com/pluginslab/wp-blockmarkup-mcp |
| `generateblocks-skills` (wpgaurav) | Source-verified skill docs constraining AI block gen | Slot-fill/constraint pattern for a *third-party* block plugin | Maintained — Jun 2026 | https://github.com/wpgaurav/generateblocks-skills |
| `f/to-wordpress` | AI full-site migration (Jekyll/Hugo/Astro→WP) via Claude Code test-fix loop | End-to-end migration, not an HTML→blocks unit | New — Jun 2026, 12★ | https://github.com/f/to-wordpress |

## Takeaways

1. **The leaf-only ceiling is universal** — JS *and* PHP converters stop at
   paragraph/heading/image/list. None infer Cover/Columns/Buttons. Confirms the
   research §1 structural finding from the *tooling* side, independently.
2. **Automattic `blocks-engine` is the one to watch** — if Automattic productizes
   HTML→blocks, it may become the canonical upstream; re-check before building the
   translator.
3. **`wp-blockmarkup-mcp` is a reuse candidate** — its verified-schema + validation
   layer is exactly the constraint/gate our LLM translator (Engine B/C) needs; worth
   evaluating as a dependency rather than rebuilding.
4. **No one has shipped translator + gate together** — that combination is the open
   space Block Runner occupies.
