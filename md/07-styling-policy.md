# Block Runner — styling & deviation policy

How Block Runner handles custom CSS, custom JavaScript, and any styling that
deviates from the target theme. The escalation ladder is **`Strict · Relaxed ·
Open · Source`**. This doc is the decision record; the public, plain-language
version lives in the project `README.md`.

## The principle

WordPress separates concerns, and Block Runner honours it:

- **content** → post markup (the block tree)
- **presentation** → the theme (or a block's own registered styles)
- **behavior** → a block's own registered script

So **post content should never carry arbitrary CSS or JS.** Block Runner's job is
to *sort* incoming custom material into the right home — and where it can't, to say
so out loud rather than smuggle a `<style>`/`<script>` into the content.

## Decisions taken (2026-06-23)

| # | Decision | Rationale |
|---|---|---|
| S1 | **One escalation ladder: `Strict · Relaxed · Open · Source`** — safest/cleanest → most faithful/least editable. | A single, plain-language axis ("how strict are we about staying on the theme's system") is easy to understand and use. |
| S2 | **One knob: a ceiling with auto-escalation.** Per element, use the *strictest* rung that still captures the design, never exceeding the configured ceiling. | Keeps it to one setting while doing the smart thing block-by-block. |
| S3 | **Default ceiling: `relaxed`.** | Faithful where it matters (exact values survive) but output stays 100% native and editable. |
| S4 | **Custom JS is never inlined, at any rung.** | Behavior belongs in a registered block script, not post content. Security + the native model. |
| S5 | **Every escalation or drop is logged as a deviation.** | The deviation list is the work queue (add a token / rule / adapter). Never silent. |

## The ladder

```
Strict ──────────────────────────────────────────────► Source
cleaner · more on-brand · more editable   ·   more faithful to the original
```

| Rung | What it does | Custom CSS | Editable? | Reach for it when |
|---|---|---|---|---|
| **`strict`** | Convert to the theme's vocabulary only. Off-theme values snap to the nearest theme token; anything with no token home is dropped. | dropped (logged) | fully | you own the design system and want consistency over pixel-fidelity (e.g. the generation pipeline targeting theme tokens) |
| **`relaxed`** | Like strict, but instead of dropping an off-theme value it **keeps the exact value** on the block (native `style` attribute: custom color / size / spacing). | kept where a block attribute can hold it; the rest dropped (logged) | fully | the default — faithful where it matters, still clean and native |
| **`open`** | Also keeps CSS no block attribute can express, by **wrapping** the element in a Group with a `className` and emitting that CSS as a **sidecar** stylesheet. | kept (rides along via class + sidecar) | structure yes; styles live outside content | a section's bespoke look matters and you can ship the extra CSS |
| **`source`** | Stop converting — keep the original markup as a **Custom HTML** (`core/html`) block. | preserved verbatim (inline) | no (opaque to the editor) | the irreducible bits: a third-party embed, a one-off you can't model |

### Custom JavaScript (cross-cutting, all rungs)

Never inlined. A behavior is handled by, in order of preference:
1. a **native interactive block** that needs no JS (e.g. an accordion → `core/details`);
2. a **third-party block adapter** that ships its own `viewScript` via `block.json`
   (the `04-extensibility.md` path — `coblocks/accordion`, `coblocks/counter`, …);
3. **dropped and logged.**

Even `source` strips `<script>` — it preserves markup and styling, not behavior. This
matches the converter's existing `sanitizeDocument` (it already removes `<script>`,
`<style>`, `on*` handlers, and `javascript:` URLs).

## The one knob

Set a **ceiling**; per element the converter uses the strictest rung that still
captures the design, climbing only as far as it must, never past the ceiling.

```js
// block-runner.config.mjs
export default { styling: 'relaxed' }; // default — prefer strict, allow up to relaxed
```
```sh
block-runner convert hero.html --styling open
```

- Pipeline that enforces the system hard → `strict`.
- A migration that must look identical → `source`.
- `--styling open` means "prefer strict, allow up to open, never source."

## The deviation report

Every climb above the ceiling-preferred rung, and every drop at `strict`, emits a
warning (the report already carries warnings). That list is the queue:

- recurring off-theme **value** → add a theme token;
- recurring **structure** the rules miss → add a translation rule;
- recurring **custom block** (CSS+JS that belongs together) → adopt/build an adapter
  (`04-extensibility.md`). Recurring custom material is a *vote for an adapter*, not a
  reason to inline CSS.

`--strict` mode can promote "had to reach `source`" into a hard failure for CI.

## Relationships

- **Token discipline** (`02-architecture.md` sharp-edge #5: preset slugs, not raw
  hex/px) is exactly the `strict` rung.
- **Extensibility** (`04-extensibility.md`): the honest home for custom CSS+JS that
  recurs is a block that encapsulates its own assets — `open`/adapters, not content CSS.
- **Evals** (`05-evals.md`): add fixtures that carry off-theme styling and assert how
  much survives at each rung, so the policy is measurable, not just stated.

## Sharp edges

1. **Fidelity vs consistency is a real trade.** `strict` can change the look (snapping a
   one-off colour to the nearest token); `relaxed`+ preserve it but drift off-system.
   The ceiling is how the caller chooses; the deviation log keeps the choice visible.
2. **`source` does double duty.** It's both the styling last-resort *and* the structural
   last-resort (no native tree could be built). One word covers "couldn't style it
   natively" and "couldn't build it natively" — intentional, keeps the ladder to four.
3. **`open` needs somewhere to put the sidecar CSS.** The class rides on the block, but
   the CSS must be shipped (theme additional-CSS, a stylesheet, or theme.json custom).
   `open` is only honest if the caller wires that up.
4. **Snapping needs a tolerance and a token set.** `strict`/`relaxed` snapping assumes
   the theme actually defines the tokens; with no token, the value is dropped (`strict`)
   or kept raw (`relaxed`).

## Status (implementation)

Target design; partially built. Today the converter behaves roughly like `strict`
*minus snapping* (it drops `<style>`/inline styling) and uses `core/html` as the
`source` fallback for unconvertible structure. `relaxed` (carry exact values to block
`style`), `open` (wrap + sidecar), token-snapping, and the `styling` ceiling option are
**not yet implemented** — see "what to build" below.

## What to build

1. Config + CLI: `styling: 'strict'|'relaxed'|'open'|'source'` (default `relaxed`) and
   `--styling`; thread a `ceiling` into `RuleContext`.
2. `strict`/`relaxed`: a styling-extraction step that maps inline styles → block
   supports (preset slug under `strict`, raw `style` attribute under `relaxed`), with
   per-property snapping + a deviation warning when it drops/keeps-off-system.
3. `open`: a wrapper emitter (Group + `className`) + sidecar CSS collection in the report.
4. Wire deviations into the existing warnings; let `--strict` fail on reaching `source`.
5. Evals: off-theme-styling fixtures scored per rung.
