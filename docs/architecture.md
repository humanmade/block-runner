# Architecture

Block Runner produces Gutenberg page markup, reusable registered-block source and whole-site block-theme bundles. These are available through the CLI and library. The optional skill teaches an external coding agent how to use them; the package does not call a model. Theme/site routes are current-source features, unreleased after npm 0.9.10.

## Choose a workflow

| Starting point | Operation | Result |
| --- | --- | --- |
| HTML with structures the rules recognise | `convert(html)` / CLI `convert` | Block markup and a report of warnings and invalid blocks |
| A JSON tree describing blocks | `realize(json)` / CLI `assemble` | Block markup and the same kind of report |
| HTML for a reusable named block, with an optional proposal | `author(html, options)` / CLI `author` | A generated plan and source files in a report |
| Existing Gutenberg markup | `validate(markup)` or `canonicalize(markup)` / CLI `validate` or `fix` | A validation report or canonicalised markup |
| An existing block theme | CLI `validate <dir>` / `fix <dir> --write` | Markup, theme.json schema and local-reference checks; eligible file repairs |
| Caller-authored `SiteIntent` | `prepareSiteSource` → `compileSite` or `compileThemeDocuments` → `writeCompiledSite` | A local hashed bundle, including retained source/assets |
| Reviewed source and a deployed active theme | `planSite` → confirmed `applySite` | Owned WordPress pages, media, synced patterns and front-page options |
| Saved template/part overrides | `inspectSiteDrift` → `previewSitePull` → confirmed `confirmSitePull` | Read-only comparison, then selected local theme edits |

An agent can interpret a design and supply a tree or proposal. A program or person can supply the same inputs. Installing the skill does not add a model client to the library.

## Page-content conversion

```text
HTML -> convert -> prepare DOM -> match rules -> create Gutenberg blocks --+
                                                                         |
intent JSON -> realize -> extract tree -> assemble Gutenberg blocks ------+
                                                                         v
                                                                   finalizeBlocks
                                                                         |
                                              resolve media -> repair theme tokens
                                                                         |
                                                    serialize -> validate -> report
```

Start in [`src/convert/assemble.ts`](../src/convert/assemble.ts), which exports `convert` despite the filename. [`defaults.ts`](../src/convert/defaults.ts) defines the built-in HTML rules; [`walk.ts`](../src/convert/walk.ts) selects a rule for each node and applies styles to its output. [Custom rules](extending.md) use the same walker.

The other entry point is [`realize`](../src/intent/index.ts). It reads intent JSON, builds Gutenberg objects and calls the shared [`finalizeBlocks`](../src/convert/finalize.ts) step. The **CLI command `assemble` calls `realize`**. The **library function `assemble` only builds block objects**: it does not resolve media, repair tokens, serialize or run the final validation report. Use `realize` when you need that complete workflow.

Finalisation retains conversion warnings alongside validation findings. Unsupported HTML can remain as a warned Custom HTML block; a valid report alone does not establish that every structure became a native block. Strict mode makes designated warnings, such as fallbacks and unresolved media, fail the operation.

## Registered-block generation

“Authoring” means generating the source for a reusable registered block, such as `acme/notice`. The current compiler produces a static wrapper with native editable children. It does not generate arbitrary PHP renderers or application behaviour.

```text
HTML + optional proposal
  -> author: inspect source, CSS and assets; use conversion for source analysis
  -> bind proposal choices to the source, or derive structure from analysis
  -> either compileAnalyzedDesign (build plan and call compileRegisteredBlock)
     or validate a supplied complete plan and call compileRegisteredBlock
  -> report containing package.canonicalPlan and generated files

reviewed plan -> author preview -> destination-bound confirmation -> author write
written source -> plugin preview -> separate fingerprint -> plugin write
built plugin ZIP + fixtures -> proof -> runtime evidence
```

[`src/author/index.ts`](../src/author/index.ts) coordinates source analysis. [`proposal.ts`](../src/author/proposal.ts) connects proposed block choices to source elements; [`plan.ts`](../src/author/plan.ts) builds the compiler plan and checks source coverage. A caller can also supply a complete plan, which must match the source and its coverage records.

[`src/authoring/schema.ts`](../src/authoring/schema.ts) validates that plan. [`generate.ts`](../src/authoring/generate.ts) creates the block metadata, editor code, styles and other package files. This workflow has its own asset, style and source-content checks; its final package is not produced by simply passing an intent tree through `finalizeBlocks`.

The analysis CLI returns JSON without writing source. The library also has a separate direct write path: `author(..., { outDir })` writes generated output without the CLI preview confirmation hash. In the plan preview/write workflow, [`destination.ts`](../src/authoring/destination.ts) checks the destination and confirmation before publication. [`src/plugin/profile.ts`](../src/plugin/profile.ts) handles supported plugin integration separately, with its own preview fingerprint.

Source generation, plugin build and successful editing in WordPress are different results. [`src/proof/runner.ts`](../src/proof/runner.ts) runs the selected verification profile; runtime profiles need a built ZIP, fixtures and the WordPress/browser environment. Follow the [registered-block delivery guide](../skills/block-runner/references/AUTHORING.md#shipped-notice-source-to-standalone-zip) for the complete procedure.

## Validation and error locations

[`src/headless/`](../src/headless/) loads the pinned Gutenberg packages in Node. Ordinary conversion does not require a running WordPress site. [`src/gate/validate.ts`](../src/gate/validate.ts) parses markup and checks blocks against their saved form. Custom HTML is treated as raw passthrough, so inspect fallback warnings as well as the invalid-block count.

An error found in generated markup may have an offset that means nothing in the original HTML. [`src/gate/provenance.ts`](../src/gate/provenance.ts) marks that location as `generated-markup`, removes the misleading source path and retains the input path separately. It prevents a report from pointing at the wrong place to fix. [`src/styles/provenance.ts`](../src/styles/provenance.ts) has a different job: recording inline background declarations that a structural rule explicitly lifted into block media.

These checks establish markup validity against the bundled Gutenberg version. They do not establish visual fidelity, support for every installed block, or compatibility with every site.

## Whole-site compilation and owned apply

[`src/site/input.ts`](../src/site/input.ts) prepares explicit SiteIntent and an asset
root. [`compile.ts`](../src/site/compile.ts) finalises native documents through the
existing intent pipeline and [`src/theme/`](../src/theme/) checks. Theme-only output
can retain pending database bindings; complete site output requires resolved content.
[`write.ts`](../src/site/write.ts) publishes the local bundle and hashed manifest.
Compilation never contacts WordPress or deploys a theme.

[`plan.ts`](../src/site/plan.ts) makes one WordPress observation and binds its plan to
source/assets, target, principal, active theme and live state. After confirmation,
[`apply.ts`](../src/site/apply.ts) records steps before mutation, uses the WP-CLI/PHP
adapter and requires provable outcomes before retrying. Ownership indexes, a shared
blog lock and initial/final source/live comparisons retain the safety boundary.
Hard-stop recovery requires guarded operator reconciliation; no held lock is stolen.

[`drift.ts`](../src/site/drift.ts) compares database template/part overrides with the
bundle. [`pull.ts`](../src/site/pull.ts) previews selected saved markup and publishes it
locally after confirmation, leaving WordPress overrides intact. It cannot reconstruct
intent: the retained input must be reconciled before further apply planning.

The [theme and site guide](../skills/block-runner/references/SITE.md) owns command
examples and mutation boundaries. Mounted-editor save proof and desktop visual/editor
acceptance remain separate from deterministic compilation and headless validity.

## Names used in the code

| Term | Meaning and example |
| --- | --- |
| Intent tree | A block description, such as a `core/paragraph` node with text, consumed by the page-content assembly workflow. |
| `SiteIntent` | Caller-authored theme documents, pages, assets and explicit bindings with stable logical IDs; each body is an intent tree. |
| Authoring proposal | Source-linked choices for a registered block: structure, editable fields and locks. `collectSourceEvidence` supplies the source references. |
| `AuthoringPlan` / `SemanticAuthoringPlan` | The older semantic input type retained for compatibility. The deprecated `compileAuthoringPlan` adapter turns it into a generated plan. It is distinct from an HTML proposal. |
| `GeneratedAuthoringPlan` | The complete public plan used for preview, confirmation and generation. Internally, `src/authoring/schema.ts` calls this type `AuthoringPlan`; the package exports it under the longer name. |
| Canonical plan | The validated compiler plan returned as `package.canonicalPlan`. Its hash identifies the plan; a write confirmation additionally binds the destination. |
| Gate | A validation step that determines whether an operation meets its checks. Passing headless validation does not mean runtime proof has run. |
| Ledger / coverage | Records of what happened to source styles and assets, for example whether a declaration became a native attribute or scoped CSS. |
| Receipt | The verification result and references to the evidence collected by a proof run. |

## Where to make a change

| Task | Start here |
| --- | --- |
| Add an HTML conversion rule | [Custom-rule guide](extending.md), [`src/convert/defaults.ts`](../src/convert/defaults.ts) |
| Change media or theme-token handling | [`src/convert/finalize.ts`](../src/convert/finalize.ts), [`src/media/`](../src/media/), [`src/tokens/`](../src/tokens/) |
| Change a validation diagnostic | [`src/gate/`](../src/gate/); also check how [`src/report/`](../src/report/) presents it |
| Change registered-block source analysis | [`src/author/`](../src/author/) |
| Change theme discovery, schema or local references | [`src/theme/`](../src/theme/) |
| Change site compilation, planning, apply, drift or pull | [`src/site/`](../src/site/) |
| Change generated files or confirmed writes | [`src/authoring/`](../src/authoring/) |
| Change plugin integration or runtime verification | [`src/plugin/`](../src/plugin/), [`src/proof/`](../src/proof/) |
| Trace a public command or import | [`src/cli.ts`](../src/cli.ts), [`src/index-implementation.ts`](../src/index-implementation.ts) |
| Change instructions used by an agent | [`skills/block-runner/`](../skills/block-runner/) |

The public entry point includes advanced compiler helpers as well as everyday operations. Start with `convert`, `realize`, `author`, `validate`, `canonicalize` or the site lifecycle exports above; follow their callers before changing lower-level helpers or compatibility aliases.
