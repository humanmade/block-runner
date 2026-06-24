# Block Runner — converter design (covering all ground without one-off fixes)

How the translator should grow so that **coverage compounds** — a handful of orthogonal,
composable patterns that multiply to cover infinite section types — rather than an
ever-growing list of targeted rules that each cover one case and collapse on the next.
Sits beneath `00-principles.md` (the north star) and is grounded in `10-engine-findings.md`.

## The asymmetry that decides everything

There are two sides to the conversion, and they could not be more different:

- **Output — the WP core block vocabulary — is closed, finite, and stable.** `core/cover`,
  `columns`, `media-text`, `details`, `quote`, `gallery`, `table` … essentially never
  change. Going deep on a specific block — its attributes, nesting, validity — is
  **permanent, compounding value**. A "block cover fix" is *not* a one-off; it's a brick in
  a wall that never moves. Know the output vocabulary cold; be exhaustively specific here.

- **Everything else is variable — and it has two axes, not one:**
  - the **producers** (impeccable, claude, codex, figma, … — *who generated the input*), and
  - the **harnesses / engines** (the deterministic rules, or an LLM via the codex / claude
    harness — *who does the conversion*).

  New producers appear; engines and models shift; both change constantly.

**The one-off trap is coupling to *either* variable axis** — `if producer == impeccable`,
handling a class only one tool emits, special-casing Claude's habits; *or* tuning the
pipeline (or the benchmark) around what one engine (gpt-5.5, opus) happens to do well.
Both are debt the moment the next producer or model arrives. (Today's token rules are the
producer version of the trap in disguise: `class="col"` really means "the idiom *this*
generator happened to use" — `10` measured the cost, 68 on tuned inputs, 7 on Tailwind
soup. And `10` flags the engine version: codex and claude have *complementary* strengths,
so anointing one bakes in its blind spots — ensemble, don't favourite.)

So the rule that generates all the others: **be exhaustively specific about the output,
and neutral to both variable axes — never target one producer or one engine.** Specialize
on the fixed thing; generalize across the variable ones. The test is literal — *the
converter core must name only core blocks*: no producer name, no model/engine assumption
baked in.

The LLM engines already behave this way — **input-agnostic (flat ~30–49 across
producers)** — but emit **invalid markup** (`10`: 0 fallbacks, 5–6 invalid). The
principles below get that input-agnosticism *and* valid-by-construction output from a
small, compounding core.

## The shape of the machine

A single pipeline, where the **only** extension points are orthogonal, level-agnostic
recognizers — never per-section rules:

```
normalize → accumulate signals → resolve to a typed intent tree (ladder per node)
          → assemble valid-by-construction → gate
```

Coverage = the **product** of the recognizers' capabilities (composition), not the **sum**
of special cases (enumeration). A new section type that is a composition of existing
primitives should require **zero new code**.

## Principles

### C1. Recognize signals, not strings
A column is not `class="col"`; it is *two-or-more similar-width siblings*. A cover is not
`class="hero"`; it is *a container with a background image*. Replace token allowlists with
general **signal detectors** that read structure the way a designer's eye does: geometry
(sibling count, equal widths, flex/grid), media presence, repetition, semantic tags
(`h1–6`, `ul`, `blockquote`, `details`), content type (a link styled as a button). Signals
are producer-independent, so the same detector covers Tailwind, Figma, and hand markup
alike. *This is the fix for the 68-vs-7 cliff.*

### C2. Accumulate evidence; don't race
`00`'s "ordered list, first match wins" is the one-off trap one level up: each rule is a
yes/no gate, so coverage grows only by adding gates. Instead every recognizer contributes
**weighted evidence**, and a node's block type is the best-supported hypothesis given *all*
signals plus context. Add a signal once and it refines decisions everywhere. Keep it
deterministic — deterministic scoring, not ML — so `00`'s "same input, same output, and
`--explain` shows why" still holds (the explanation becomes the signal tally).

### C3. A few orthogonal primitives, composed recursively
Do not write a "pricing-table" recognizer. Write ~6 orthogonal ones — **container,
collection (repetition), media, text-run, action (CTA), leaf-semantics** — that apply at
*every* level. A pricing table is `collection(card(heading + price + list + button))`; a
feature grid, team grid, and testimonial wall are the **same composition** with different
leaves. Section types are emergent, never enumerated. This is why a handful of patterns
cover all ground: coverage multiplies.

### C4. Normalize before you recognize
The reason rules die on Tailwind/Figma is they recognize raw *producer idioms*. Put a
normalization pass first that collapses presentational noise to a canonical structural
form — utility classes → layout intent, positioned divs → flow order, wrapper-soup
unwrapped, inline style → tokens — so the **same recognizers run on every producer**.
This is *why* the LLM engines are input-agnostic (`10`): they implicitly normalize. Make
it explicit and the deterministic core inherits the same robustness.

### C5. Recognizers emit a typed intent tree, never markup
The translator's output is a **typed block-intent tree**, and a single assembly step turns
it into blocks via `createBlock` (extending `00`'s valid-by-construction). This bounds
*every* failure to "wrong intent" — measurable, and fixable upstream per `00` #6 — and
structurally **eliminates "invalid markup,"** the exact ceiling the LLM engines hit in
`10`. The output *type* is a constraint that makes a whole class of bug impossible.

### C6. Degrade along a ladder, per node — never hard-fail
Generalize the styling ladder (`07`: Strict · Relaxed · Open · Source) to **structure**.
Each node resolves to the most specific block its signals support; when support is weak it
steps down — specific (`cover`/`media-text`) → general container (`columns`/`group`) →
`core/html` (last resort) — always valid, always logged (`00` #5). Coverage is therefore
*total* (everything maps to something valid) and quality is *monotonic* (more signal →
higher rung). An unrecognized shape degrades gracefully instead of needing a one-off.

### C7. The LLM is a recognizer, not a separate mode (Engine C as architecture)
`10` showed the split cleanly: rules are valid-but-brittle, the LLM is robust-but-invalid.
Unify them through C5: the LLM **proposes the typed intent tree** (its strength —
structural intuition on arbitrary input), the deterministic core **assembles valid blocks**
(its strength — validity), the gate backstops. The LLM is just another, high-coverage
signal source feeding one pipeline — not a parallel engine with its own emission path.
This is the synthesis the findings point to, and it keeps every other principle intact.

### C8. The benchmark is the fitness function — admit only generalizing changes
This is the governance that *enforces* "no one-offs." A change earns its place by moving a
**class** of fixtures across producers, not a single fixture — and it must not be coupled
to one engine (an improvement that only shows up when *codex* converts is engine debt, not
a pattern; read it across the input×engine matrix). If it improves exactly one producer or
one engine, it's a targeted patch — reject it or generalize it. The input×engine matrix + `suiteHash`
make "did this generalize?" measurable (`08`). Coverage is the metric; rule-count is a cost.
Orthogonality is the test: if a proposed capability overlaps an existing one, fold it in —
the machine stays small because every addition is independent and composition does the rest.

### C9. Account for every input, and say how sure you are

Two disciplines that make `00`'s "nothing degrades in silence" *measurable*:

- **Coverage — nothing vanishes.** Every input element is accounted for in the output:
  converted to a block, captured in a fallback, or explicitly flagged — never dropped. The
  benchmark measures this directly (the **`coverage` axis**: the fraction of the input's
  visible text that survives into the output), so *silent content loss* — text gone
  entirely, distinct from wrong structure (C3) or spaghetti (fallbacks) — shows up as a
  number, not a surprise. An LLM that skips or hallucinates, or a rule that drops a node,
  loses coverage.
- **Confidence — calibrated, never a filter.** Each conversion (ideally each block) carries
  a confidence the engine emits, calibrated hard: reserve HIGH for cases where *no judgment
  was involved*; anything inferred from ambiguous input is MEDIUM at best; non-semantic
  input (utility soup, positioned divs) carries a lower ceiling than clean semantic input.
  Confidence is **informational, not a gate** — a LOW node is still emitted (or flagged),
  never silently omitted (`00` #5). It makes the machine's uncertainty legible and points
  human review exactly where it's needed.

Together with the ladder (C6): coverage catches *loss*, confidence catches *guesses*, the
ladder guarantees *validity*. "Did anything get quietly lost or guessed?" becomes three
measured signals instead of a hope.

## What this means for the next build

The deterministic rules (`src/convert/defaults.ts`) are the C1/C2 violation in the flesh.
The path is not "add a media-text rule, a details rule, a quote rule" (one-offs that `10`
shows barely move the corpus). It is:

1. **Normalization pass (C4)** + **signal-based recognizers (C1/C2)** replacing token rules
   — one general change that should lift *every* producer at once.
2. **Typed intent tree + assembly (C5)** + **structural degradation ladder (C6)** — makes
   output valid-by-construction and coverage total.
3. **LLM as a recognizer (C7)** feeding the same pipeline — Engine C — for the open-ended
   structural intuition the deterministic signals can't reach.
4. Every step **gated by the benchmark (C8)**: keep it only if it moves a class of fixtures.

Test of success: adding support for a brand-new section type requires **no new code** —
it falls out as a composition of the primitives already there.
