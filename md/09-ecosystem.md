# Block Runner — the conversion matrix (ecosystem direction)

Where the benchmark and the extensibility work converge: a two-sided **conversion
compatibility matrix** — many inputs, many outputs — that the community contributes to.
Directional vision; nothing here is built beyond the single-output (core) benchmark. This
doc unifies `04-extensibility.md` (outputs), `06-section-catalog.md` (ideal mappings),
`08-benchmark-system.md` (benchmark), and the source-detection open question (`03` #9).

## The model: input × output × layout

Block Runner converts *some producer's HTML* into *some destination's block vocabulary*.
Both sides vary, so the benchmark is a matrix, not a list:

```
              OUTPUT →   core (block editor)   coblocks   layout-grid   core+coblocks+…
INPUT ↓
  impeccable                 score                score       score
  figma                      score                …
  codex / tailwind           score                …
  claude                     score                …
```
…per **layout** (hero, pricing, …). Three axes: **input producer × output target × layout.**

- **Input (producer)** — the source HTML and its conventions (semantic, Tailwind utility,
  Figma positioned-div). The benchmark's current axis (`08`).
- **Output (target)** — the destination's block vocabulary. The new axis.
- **Layout** — the section archetype (`06`).

## What an "output target" is

A destination's **block capability profile** — "what blocks the target site supports"
(core-only, or core+CoBlocks, or +Layout Grid). It is first-class because it determines
three things at once:

1. **The ideal tree.** Pricing → `core/columns` of cards for a core target, but →
   `coblocks/pricing-table` when CoBlocks is available. The "right answer" is
   output-dependent.
2. **What the converter may emit.** The allowed block set = the adapters registered for
   that target.
3. **The validation tier.** Core = strict `isEquivalentHTML`; third-party = the
   dynamic-stub / lenient / live-WP tiers from `04`. (Static third-party blocks can't be
   strictly validated headlessly — see [[static-block-validation-ceiling]].)

So an output target **is** the `04-extensibility.md` adapter system, promoted to an axis.
And it's **discoverable**: `04`'s `/wp/v2/block-types` / `wp block type list` auto-pickup
reads a live site's capability profile — that profile *is* the output target.

## "A schema for each" — the two contribution surfaces

| Surface | What it is | Who contributes |
|---|---|---|
| **Output schema** | A block-vocabulary pack: the blocks (names, dynamic/static, validation), the emit rules, and the ideal section→block mappings. This is a Block Runner **adapter** (`04`). | **Block-plugin authors** — "make Block Runner target my blocks well." |
| **Input schema** | A producer profile/fingerprint (markup conventions, detection signals). The source-detection idea (`03` #9). | **Design-tool vendors** / us — "make sure my output converts." |

## The community play

A two-sided ecosystem with the **public benchmark as the shared incentive**:

- **Block-plugin authors** add **output** adapters → their blocks become a conversion
  target, and the matrix shows how convertible design output is *to their blocks*.
- **Design-tool vendors** add **input** fixtures/profiles → the matrix shows how
  convertible *their output* is, and flags where it isn't.
- Everyone reads the same **compatibility matrix** (the published benchmark) — a neutral,
  cited scoreboard. That transparency is the reason to contribute.

Distribution uses the `04` research's convention: `block-runner-plugin-*` packages
(output adapters) discovered explicitly via config; input fixtures live in the benchmark
suite. No runtime magic — explicit registration, like ESLint/PostCSS.

## Private / custom extensions (enterprise)

The community surface is public packages, but the **same contract must work privately** —
this is the enterprise case, and it's high-value on both axes:

- **Custom output = an org's own block library.** Large orgs invest heavily in a bespoke
  design-system block set. A private **output adapter** makes *their* blocks the conversion
  target, so any design-tool output lands as on-brand, governed blocks. This is the big one.
- **Custom input = an org's internal generator / CMS / design system.** A private **input**
  profile + fixtures benchmark *their own* pipeline.

Three things make this clean rather than a special case:

1. **One contract, two distribution modes.** A private extension is the *same* shape as a
   community one (`04`'s adapter / input-profile); it's just loaded from a **local path**
   instead of a published package — `adapters: [import('./acme-blocks')]`. No registry, no
   publishing, no phoning home. Config-driven and auditable — fits enterprise governance.
2. **Owned blocks flip the validation ceiling.** Public third-party *static* blocks can't be
   strictly validated headlessly because their `save()` is unobtainable
   ([[static-block-validation-ceiling]]). But an org **owns its block source**, so it can
   ship the real `save()` in its adapter and reach **strict (Tier 1) validation** for its own
   static blocks — a genuine advantage of the private path.
3. **Private matrix cells.** Their inputs × their outputs run through the same harness
   **locally**, scored and gated in their own CI, never published to the public matrix.

Net: an enterprise converts any design-tool output into *its* design-system blocks, with a
private compatibility benchmark enforcing quality at scale — using the public mechanism,
kept entirely in their infra.

## Decisions (proposed)

| # | Decision | Rationale |
|---|---|---|
| M1 | **Output is a first-class axis**, equal to input. | Both sides genuinely vary; the ideal tree depends on the target's block vocabulary. |
| M2 | **Output target = a destination capability profile** (set of available block vocabularies), not a single plugin. | Real sites have core + N plugins; matches the `/wp/v2/block-types` signal. |
| M3 | **`expected.json` becomes output-scoped**; `output=core` is the default. | A spec's ideal answer differs per target. Cheap retrofit — today's specs are the `core` cell. |
| M4 | **Outputs and inputs are both community-contributed**, via the `04` adapter/packaging convention. | This is the ecosystem; we seed it, we don't own every cell. |
| M5 | **Keep the matrix sparse.** No obligation to fill every input×output×layout cell. | Combinatorial blow-up; only meaningful cells earn a fixture. |
| M6 | **One contract, public or private.** Extensions load identically from a published package or a local path; private by default, no registry required. | The enterprise case (custom blocks / internal generators) must not be a fork of the design — and owned blocks can reach strict validation. |

## Structural change (when output becomes an axis)

```
benchmarks/specs/<layout>/<output>/expected.json   # ideal tree for that target
benchmarks/specs/<layout>/prompt.md                # the brief stays output-agnostic
```

- `output=core` is the default and is exactly today's `specs/<layout>/expected.json`
  (move it to `specs/<layout>/core/expected.json`, or special-case `core`).
- The converter gains an **output profile** (which adapters/blocks it may emit + the
  validation tier). `core` profile = current behavior.
- The scoreboard gains the output dimension (per-output rollups; the published matrix).

## Roadmap (each step shippable)

1. **Solidify single-output (core) across inputs** — *where we are*: impeccable / codex /
   figma / (claude) vs the core specs.
2. **Build the output-adapter mechanism** (`04` Phase 1) so a *second* output can exist.
3. **Add one real second output** (CoBlocks) for a few layouts → the first true matrix
   cell; prove output-scoped expected + tiered validation end-to-end.
4. **Open contribution + publish** the matrix (Pages) — the community surface.

## Sharp edges

1. **Matrix sparsity is mandatory** (M5) — surface what's *not* covered so a blank cell
   reads as "untested," not "passes."
2. **Per-output ideal trees are opinions** (`05` sharp-edge #1), now multiplied by target.
   Each output adapter owns its mappings; keep the prose brief shared and output-agnostic.
3. **Validation asymmetry per output** — core is strictly validatable; static third-party
   targets are not, headlessly ([[static-block-validation-ceiling]]). The matrix must show
   *validation confidence*, not just a score, per output.
4. **Don't let the platform outrun the converter.** The ecosystem is only worth opening
   once the core converter + one third-party output are genuinely good; otherwise the
   public matrix is all red.

## Relationships

- `04-extensibility.md` — the output axis *is* the adapter/tier system.
- `06-section-catalog.md` — per-layout ideal mappings; gains an output dimension.
- `08-benchmark-system.md` — the benchmark/scoreboard; gains the output rollup + the
  published matrix.
- `03` #9 — input schemas are the source-detection profiles.
