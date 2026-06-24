# Block Runner — third-party block extensibility

How Block Runner grows beyond core blocks to support CoBlocks, Layout Grid, and
others. Grounded in a deep-tier `/research` run (2026-06-23, 5 parallel angles +
context7, sourced primarily from direct Gutenberg/plugin source on GitHub + the WP
Handbook). This doc is the **decision record**; `03-open-questions.md` Q6 ("block
vocabulary") is the question it answers.

## Decisions taken (2026-06-23)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Audience: internal adapters for a few plugins**, not a public npm ecosystem (yet). Build the seam so it *can* be opened later without rework. | We control which plugins matter (CoBlocks, Layout Grid, our theme). Skip the cost of public packaging, naming registries, and a stable external API until there's demand. |
| D2 | **Validation degrades in tiers and never false-fails.** Static third-party blocks get a parse + optional **live-WP render** signal; they do *not* get full `isEquivalentHTML`. | The research proved full JS validation of a static third-party block is impossible without shipping its `save()` (see §1). Honest partial validation beats a spurious "invalid". |
| D3 | **Adapters are in-repo modules**, registered via config — not published `block-runner-plugin-*` packages. | Matches D1. The export *shape* mirrors what a public pack would export, so opening up later is a packaging change, not a redesign. |

## The constraint that shapes everything

`@wordpress/blocks` `validateBlock()` works by **re-running the block's `save()`** and
comparing the output to the stored markup via `isEquivalentHTML`. There is no code
path that skips `save()` for a normally-registered block, and `save` is *explicitly
excluded* from the `block.json` metadata path — it must be passed to
`registerBlockType()` as real JS.
([validation/index.ts](https://raw.githubusercontent.com/WordPress/gutenberg/trunk/packages/blocks/src/api/validation/index.ts),
[registration.ts](https://raw.githubusercontent.com/WordPress/gutenberg/trunk/packages/blocks/src/api/registration.ts))

Consequences:

- **Dynamic blocks** (`save: () => null`, server-rendered) store nothing between their
  delimiters, so `isEquivalentHTML("","")` → **valid**. Registering only the *name*
  with a stub null save is enough to validate them headlessly. *(CoBlocks dynamic
  examples: `posts`, `post-carousel`, `form`, `icon`, `events`.)*
- **Static blocks** (`save` returns HTML) can only be validated if we have their real
  `save()`. But **neither CoBlocks nor Layout Grid publish to npm** — the save
  functions live only in the plugin build. *(CoBlocks static: `row`, `accordion`,
  `hero`, `gallery-masonry`, … Layout Grid: both `jetpack/layout-grid` +
  `jetpack/layout-grid-column` are static, with client-side-computed responsive CSS
  classes.)*
- **PHP does not rescue this.** WordPress has *no* server-side equivalent of
  `isEquivalentHTML` — "validation is exclusively client-side". `parse_blocks()` is a
  purely syntactic parser that trusts its input; `render_block()` only *runs* dynamic
  blocks' callbacks and merely re-emits static blocks' stored HTML.
  ([block-edit-save](https://developer.wordpress.org/block-editor/reference-guides/block-api/block-edit-save/),
  [WP_Block_Parser](https://developer.wordpress.org/reference/classes/wp_block_parser/),
  [render_block](https://developer.wordpress.org/reference/functions/render_block/))

So there is no single gate that fully validates all third-party blocks. The design
embraces that instead of fighting it.

## Two independent seams

Extending Block Runner is two separate jobs with very different difficulty:

```
            TRANSLATE  (HTML → coblocks/row markup)        VALIDATE  (is the markup editor-valid?)
            ────────────────────────────────────────       ───────────────────────────────────────
core        built-in Rules (defaults.ts)                    registerCoreBlocks() → full isEquivalentHTML
            ─ already done ─                                 ─ already done ─

3rd-party   adapter ships Rule[]  (match/emit)              depends on block kind:
dynamic       └ trivial: reuse existing Rule interface        register name + save:()=>null → valid (Tier 2)
3rd-party   adapter ships Rule[]                            no save() available →
static                                                       parse + optional live-WP render (Tier 3)
```

The translate seam **already exists**: `src/types.ts:145` `Rule { id, match, emit }`,
wired through `assemble.ts:buildRules` (which already merges `config.rules.custom`).
The work is packaging adapters and tightening the `unknown[]` type — not new
architecture.

## The adapter contract

An adapter is a module describing one plugin's blocks. Same shape a public
`block-runner-plugin-*` package would export (D3), so we can lift it out later.

```ts
export interface BlockRunnerAdapter {
  meta: { name: string; apiVersion: number };   // name e.g. 'coblocks'; apiVersion = Block Runner's adapter API
  rules: Rule[];                                 // translation: HTML → this plugin's blocks
  blocks: AdapterBlock[];                        // registration hints for the gate
}

export interface AdapterBlock {
  name: string;                  // 'coblocks/row'
  dynamic: boolean;              // true → register save:()=>null, validates in JS (Tier 2)
  attributes?: object;           // from block.json; lets parse() read attrs correctly
  save?: (props) => unknown;     // OPTIONAL: only if the adapter author re-implements it → Tier 1
  deprecated?: unknown[];        // OPTIONAL: deprecation saves for version-skewed markup
}
```

The gate boot (`headless/env.ts`) gains a step after `registerCoreBlocks()`: for each
adapter block, `registerBlockType(name, { ...attributes, save: save ?? (() => null) })`.
For dynamic blocks the stub save is correct and complete. For static blocks without a
provided `save`, the stub makes `parse()`/attribute handling work but the block is
flagged **Tier 3** (see below) rather than strictly validated.

## Validation tiers (the gate, per block)

The gate already classifies each block as valid/invalid. It gains a *tier* dimension
so a Tier-3 block is reported honestly instead of failing:

| Tier | Applies to | Check | Report on mismatch |
|---|---|---|---|
| **1 strict** | core blocks; static 3rd-party blocks whose adapter ships a real `save()` | full `isEquivalentHTML` | `invalid` (hard) |
| **2 structural** | dynamic 3rd-party blocks (stub `save:()=>null`) | block parses; attributes valid; empty body matches | `invalid` (hard) |
| **3 lenient** | static 3rd-party blocks with no adapter `save()` | block parses + (optional) live-WP render succeeds | `warning`, never hard `invalid` — message points to "no save() registered; structural check only" |

`--strict` may promote Tier-3 warnings to failures for callers who want to block on
"contains an unvalidatable third-party block".

## Live-WP render check (D2)

An *optional* augmentation, not the primary gate — the research is clear that
`render_block()` only meaningfully exercises **dynamic** blocks (it runs their
callback); for static blocks it just re-emits stored HTML, so it confirms
"parses + renders without PHP error", not editor-validity.

Shape: when configured with a live WP target, the gate pipes candidate markup through
WordPress where *all* plugins are active:

```sh
echo '<!-- wp:coblocks/posts ... -->' | wp eval-file - 
# script: $blocks = parse_blocks(file_get_contents('php://stdin'));
#         echo do_blocks($serialized);   // non-empty, no fatal → render OK
```

Notes from the research:
- Use `wp eval-file -` (stdin); `wp eval` has **no** stdin.
- It bootstraps full WP, so `WP_Block_Type_Registry`, `parse_blocks`, `render_block`
  are all available with third-party blocks registered.
- Best signal it yields: dynamic block **renders non-empty without fatal** = "works".
  Static block = "parsed" only. Document this limit in the report so it isn't mistaken
  for strict validation.
- Round-trip caveat: PHP `serialize_blocks` strips the `core/` namespace and
  re-encodes attributes; it may diverge from JS `serialize()` on attribute-escaping
  edge cases. Don't compare PHP-serialized output byte-for-byte against JS output.

## Discovery & auto-pickup (config UX)

Per D1, keep it explicit and small now; the auto-pickup hooks are cheap to add later.

- **Explicit (now):** `block-runner.config.mjs` imports adapters and lists them.
  ```js
  import coblocks from 'block-runner/adapters/coblocks';
  import layoutGrid from 'block-runner/adapters/layout-grid';
  export default { adapters: [coblocks, layoutGrid] };
  ```
- **Auto-pickup from a live WP (optional, later):** `--from-wp <url|wp-cli>` reads
  `wp block type list --format=json` (no auth, runs as server) or
  `GET /wp/v2/block-types` (needs `edit_posts`). Both return every registered block
  with `name`, `is_dynamic`, `attributes` — but **never `save()`**. So auto-pickup can:
  - auto-register every **dynamic** block as a Tier-2 stub (zero config), and
  - **detect** static blocks and warn "no adapter for `coblocks/row`; Tier-3 only",
  but cannot promote a static block to Tier 1. *(`save` is absent from REST, WP-CLI,
  and disk-scanned `block.json` alike — confirmed across all three.)*

That cleanly answers "picked up automatically vs configured": **dynamic = automatic,
static = needs an in-repo adapter.**

## Sharp edges

1. **Static third-party validation has a hard ceiling.** Without the upstream `save()`
   we cannot do `isEquivalentHTML`. An adapter that re-implements `save()` (to reach
   Tier 1) takes on **version-skew debt** against the plugin — if the plugin changes
   its markup, our save() silently goes wrong-but-valid. Prefer Tier 3 + live-WP
   render over maintaining hand-copied save() functions unless a block really needs it.
2. **Layout Grid is entirely static** and its responsive CSS classes are computed
   client-side from attributes. It is the worst case: no npm, all static, so it lives
   at Tier 3 unless we port `getAsCSS()` into an adapter `save()`. It's also stale
   (last updated July 2023, untested past WP 6.2) — weigh before investing.
3. **`renderToString` in jsdom vs browser React** is unverified for SVG/void
   elements/inline styles; `isEquivalentHTML` is sensitive to these. If we ship any
   adapter `save()` (Tier 1), add a smoke test comparing its output against
   known-good markup from a real editor.
4. **Don't over-build discovery.** No JS tool auto-loads plugins by npm keyword at
   runtime; even the public ecosystems (ESLint/PostCSS/Prettier) use explicit config.
   Explicit `adapters: [...]` is the correct, unsurprising default.

## What to build (when D-next moves from "doc" to "code")

1. Types: `BlockRunnerAdapter` / `AdapterBlock`; narrow `RuleConfig.custom` and add
   `config.adapters`.
2. Gate: extend `headless/env.ts` boot to register adapter blocks after core; add the
   tier classification to `gate/validate.ts` reporting.
3. Adapters: `src/adapters/coblocks.ts` (rules for `row`/`hero`/etc. + block list with
   `dynamic` flags), `src/adapters/layout-grid.ts` (Tier-3, rules only to start).
4. Optional: `--from-wp` auto-pickup + the `wp eval-file -` live render check.
5. Smoke test: convert a CoBlocks-shaped HTML fixture end-to-end; confirm dynamic blocks
   hit Tier 2 and static ones hit Tier 3 with clear warnings.

## Provenance

Deep-tier `/research` (2026-06-23): 5 parallel research-runner angles + context7,
grounded in direct Gutenberg source (`trunk`), the CoBlocks
(`godaddy-wordpress/coblocks`) and Layout Grid (`Automattic/block-experiments`)
repos, and the WP Block Editor / REST / WP-CLI handbooks. The load-bearing claim —
*validateBlock() requires the registered `save()`, which block.json/REST/WP-CLI/disk
all omit* — was confirmed from Gutenberg source. A full URL-liveness/adversarial pass
was not separately run; treat `single-source` items in the brief as not-yet-corroborated.
