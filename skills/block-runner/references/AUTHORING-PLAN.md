# Advanced: complete `GeneratedAuthoringPlan` v1 shape

This is the advanced compatibility route from [AUTHORING.md](AUTHORING.md). For authored HTML, the
proposal workflow there is primary; use this shape only when a complete plan is genuinely required.

The CLI accepts exactly this versioned JSON shape. Object keys may be in any order; arrays retain
their order and every listed value participates in the confirmation hash. `files` names
compiler-owned source outputs and uses only safe relative POSIX paths. Core fields are required;
list fields may be empty when a design genuinely has none of that item.

| Field | Required shape |
|---|---|
| `version` | The number `1`. |
| `generatorVersion` | Non-empty generator version string. |
| `target` | `{ "name": "namespace/slug", "title": "…" }`; optional `description`, `category`, `icon`, `textDomain`, `wordpress`, safe relative `directory`, and `metadata`. `metadata` is hash-bound native declarative `block.json` data; safe forward-compatible fields pass through unchanged, while executable or file-loading capabilities are rejected. |
| `structure` | Ordered native nodes: `block`, optional stable `id`, `label`, JSON `attributes`, `lock`, and recursive `children`. Never HTML. |
| `allowedBlocks` | Optional direct-child insertion allowlist. It must include every initial direct child; nested blocks are not added implicitly. |
| `fields` | Ordered `{ "id", "label", "mode" }` records; `mode` is exactly `fixed`, `editable`, or `override`. Optional `node`, `attribute`, `type`, `default`, and `description` explain the editor surface. |
| `locking` | `{ "mode": "all" | "contentOnly" | "insert" | "none" }`. Use native per-node `lock` for movement/removal decisions. |
| `styles` | `{ "strategy": "native" | "scoped-css" | "mixed", "outcomes": [] }`; an outcome has `property`, `outcome` (`native`, `token`, `scoped-css`, or `dropped`) and optional `value`, `token`, and `reason`. Optional `rules` and `editorRules` carry structured residual CSS as described below. |
| `pattern` | `{ "ready": boolean, "overrides": [{ "field": "<field id>" }] }`, with optional override label and description. |
| `assets` | Local images require `id`, absolute `source`, `status: "ready"`, byte-level `sha256`, and an `assets/<filename>` destination. Declare native image references in `uses: [{ "node": "<image node id>", "attribute": "url" }]`, or reference the image in confirmed CSS. Supported bundled formats: PNG, JPEG, GIF, WebP, static SVG. An external HTTP(S) asset uses `status: "external"` without a destination or bundled uses. |
| `files` | `{ "path" }` records with optional `kind` and `operation` (`create` or `replace`; default `create`). `plannedFiles` is accepted only as an input alias and canonicalizes to `files`. |
| `warnings` | Ordered, non-empty warning strings; use `[]` when there are none. |

Here is a complete valid plan. Replace its identity, structure, decisions, and retained final
destination for the supplied design; do not copy its values blindly.

```json
{
  "version": 1,
  "generatorVersion": "0.9.0-preview.1",
  "target": {
    "name": "acme/feature-grid",
    "title": "Feature grid",
    "description": "A reusable feature grid.",
    "category": "design",
    "textDomain": "acme",
    "wordpress": "7.1",
    "directory": "blocks/acme-feature-grid"
  },
  "structure": [
    {
      "id": "root",
      "block": "core/group",
      "label": "Feature grid",
      "attributes": { "layout": { "type": "constrained" } },
      "children": [
        {
          "id": "heading",
          "block": "core/heading",
          "label": "Heading",
          "attributes": { "level": 2 }
        }
      ]
    }
  ],
  "fields": [
    {
      "id": "heading",
      "label": "Heading",
      "mode": "override",
      "type": "rich-text",
      "node": "heading",
      "attribute": "content",
      "default": "Our features"
    }
  ],
  "locking": { "mode": "contentOnly" },
  "styles": {
    "strategy": "native",
    "outcomes": []
  },
  "pattern": { "ready": true, "overrides": [{ "field": "heading", "label": "Heading" }] },
  "assets": [],
  "files": [],
  "warnings": []
}
```

Every declared field must resolve to a real node and native attribute. Native pattern
overrides enable the whole content region, not arbitrary style properties. Confirm all
supported attributes of an overridden node: heading/paragraph/list-item `content`;
image `id`, `url`, `title`, `alt`, `caption`; button `text`, `url`, `linkTarget`, `rel`.
Partial regions are rejected. Background colours and layout are not native pattern
content overrides. Generic Block Bindings are not supported by this authoring path.

Bundled images are copied byte-for-byte only after confirmation. Hash the source bytes;
do not invent a hash, media-library ID, or final site URL. The build resolves bundled
image URLs. Missing, changed, symlinked, or unsupported bundled assets are rejected.
Static SVGs may contain geometry, text, gradients, and self-contained fragment references.
Scripts, animation, embedded HTML, external dependencies, and unresolved fragments are
rejected rather than stripped. Native Image SVGs are emitted as files; CSS SVGs may be
inlined by the build. Do not substitute a `data:` URL for a native image.
An empty `files` list lets the compiler enumerate its complete
source set in the preview; it does not mean no output. A native SVG adds an owned
`asset-urls.mjs` source file, which is included in confirmation and the manifest.

For existing HTML/CSS input, the proposal workflow in [AUTHORING.md](AUTHORING.md) is primary.
Complete `AuthorOptions.plan`
remains supported as an advanced compatibility route, but do not make a model copy ledgers, asset
hashes, destinations, CSS rules, or warnings.

Tailwind detection is advisory. Supplied compiled CSS can be handled as ordinary CSS; Tailwind
source/runtime output needs an explicit, pinned build graph (including custom variants, plugins,
variables, reset/Preflight effects, and dependencies) before fidelity is claimed. Block Runner
does not infer utility semantics or execute package/config files. Missing build inputs are reported
as a specific dependency diagnostic. Scripts, event handlers, unsafe CSS URLs, and executable
browser behaviour remain blocked by the output policy.

Licensed local WOFF/WOFF2 fonts use an asset with `kind: "font"`, an absolute source,
confirmed byte hash/destination, and `fontLicense: { ownership, license, notice? }`.
Retain the complete required redistribution notice; Block Runner validates the declared
decision and bytes, not legal permission. Add `styles.fonts: [{ assetId, family }]`, with
optional `fontStyle`, `fontWeight`, `fontStretch`, `fontDisplay`, and `unicodeRange`.
Use the namespaced families returned by HTML analysis. For a manually authored plan, compute
the prefix `block-runner-<namespace>-<slug>-<first 8 hex characters of SHA-256(target.name)>-`
and append a local family name; do not invent hashes. Use that exact family in every CSS/native
reference. Faces load through shared CSS; `font-licenses.txt` retains notices in production
archives. Remote fonts, other font formats, and editor-only font faces are not supported.
Unlicensed HTML font faces fall back with explicit warnings; destination theme presets do not
authorize copying font files. Keep the analyzer's `source` and `coverage` records in the plan.

CSS input is analysed once into source facts with exact ranges, declaration/asset ledgers, and
blocked-input records. Exact target-backed declarations may become native mappings; safe local
rules remain scoped residual CSS; ambiguous or unsupported input remains warned or blocked. This
is intentionally not a browser engine: the offset-sensitive `url()`/`image-set()` lexer stays
separate for byte-exact rewrites, while selector cascade matching and responsive media equivalence
stay separate conservative semantic checks. PostCSS validates generated output, not malformed
author input, so it does not replace the tolerant source-facts scanner.

For styling that native block supports cannot express, use `styles.rules`. Each rule is
either `{ "kind": "style", "selector": ".card:hover", "declarations": [
{ "property": "transform", "value": "translateY(-2px)" } ] }`, or a conditional rule:
`{ "kind": "conditional", "name": "media", "prelude": "(min-width: 48rem)",
"rules": [ ... ] }`. Conditional names are `media`, `supports`, or `container`;
conditions may nest. A declaration may explicitly include `"important": true`.

Use component-local selectors, not a `wp-block-…` prefix. The compiler adds the owned
wrapper selector to every branch. It preserves declaration order and hover/focus states.
Put supplemental editor affordances in `styles.editorRules`; shared design styles belong
in `rules`. Both appear in the confirmation preview and affect its hash. These are typed
design decisions, not permission to supply a complete stylesheet or Sass program.
Global selectors, imports, unsupported functions, and unsafe fragments are rejected.
A local CSS URL must exactly match a confirmed asset destination, such as
`url("./assets/photo.png")`. Remote CSS URLs must match a declared external asset.
Do not treat these residual rules as a complete source-style ledger: retain the separate
declaration-by-declaration accounting, including native mappings and explicit refusals.
