# Block Runner — conversion-fidelity evals

How we measure whether the **translator** actually understood design intent — the gap
the gate cannot close. Grounded in the working harness (`scripts/eval.ts`,
`evals/`, `npm run bench`). This doc is the decision record; the authoring guide for
fixture writers lives at `evals/README.md`.

## Why this exists

`md/02-architecture.md` sharp edge #2: *"Canonicalization fixes shape, not intent… the
gate happily produces wrong-but-valid output. Validity ≠ correctness."* The gate
(`validate`/`canonicalize`) proves markup is **editor-valid**. Nothing proves the
converter chose the **right blocks, holding the right content, in the right order,
nested correctly**. That is what these evals score — the translator's correctness,
which is otherwise only checkable by a human eyeballing the editor.

## Decisions taken (2026-06-23)

| # | Decision | Rationale |
|---|---|---|
| E1 | **One self-contained design unit per fixture** (`input.html` with CSS + markup inline). | Single root → whole-tree comparison, no region/serial bookkeeping. Matches how generators emit a coherent section. |
| E2 | **Ground truth = prose intent, compiled once into a structured tree** (`expected.json`). | The author writes a GUI-level mental model; the compiled `tree` makes it machine-checkable. |
| E3 | **Deterministic scorer, not an LLM judge.** | A training ground must move predictably as rules change. Judge noise would mask small rule-by-rule gains. |
| E4 | **Scores are graduated, never binary.** Partial credit per axis. | Complex fixtures land partially-right; the *trend* is the signal. Drives durable fixtures (see E5). |
| E5 | **Fixtures are deliberately complex and durable.** | A rich, realistic corpus changes rarely; we iterate rules against a stable target instead of churning fixtures. |
| E6 | **Source origin is recorded but never fed to the converter or the score.** | The whole premise: Block Runner must handle diverse-origin HTML (Impeccable, /design, Figma) it knows nothing about. |

## Fixture layout

```
evals/<name>/
  input.html      # one design unit, CSS + markup inline — the converter's input
  expected.json   # { intent, source?, tree } — the intended block tree
```

`expected.json`:

```json
{
  "intent": "Prose, GUI-level: a cover; inside two columns; left an image; right a heading, paragraph, button group.",
  "source": "impeccable | /design | figma | hand-authored",
  "tree": { "block": "core/cover", "children": [ … ] }
}
```

Tree node = `{ block, children?, contains? }`:
- `block` — expected block name (`core/cover`, `coblocks/row`, `jetpack/layout-grid`…).
- `children` — nested blocks **in expected order**.
- `contains` *(optional)* — substring that must appear in that block's serialized
  attributes (text / url / alt / href). Asserts the right content reached the right block.

## Scoring model (matches `scripts/eval.ts`)

Per fixture, four axes:

| Axis | How it's computed |
|---|---|
| **STRUCT** | Ordered greedy alignment of `expected.tree` against the produced tree. Each expected node scores if a same-named block exists at its position; correct nesting and sibling order are enforced by walking children with a forward-only cursor. `matched / total expected nodes`. |
| **CONTENT** | Of the `contains` assertions, the fraction whose substring is present in the matched block's attributes. 100% if none asserted. |
| **VALID** | Produced markup passes the gate (`report.summary.invalid === 0`). |
| **FALLBKS** | Count of `core/html` blocks in the output. Every fallback is a conversion miss — surfaced loudly, never hidden. |

**Composite** = `0.75 × STRUCT + 0.25 × CONTENT`, then **halved if invalid**
(correctness presupposes validity). Reported 0–100, with per-node miss lines beneath
each row pointing at exactly which expected node wasn't satisfied — that is the signal
for which rule to fix next.

### Why graduated, not binary

The greedy alignment gives partial credit: a fixture that nails `cover > columns >
column×2` but flattens a `core/media-text` into `core/columns` loses only the nodes it
got wrong, not the whole fixture. A 12-node complex fixture might sit at 70–85% for a
long time and *creep upward* as rules improve — which is the point. Watch the corpus
average and the per-fixture deltas, not pass/fail.

## Matching algorithm (the honest limits)

Ordered greedy, single-root. For each expected node it finds the first same-named
produced block at or after the previous sibling match, then recurses. Consequences to
keep in mind:

- **Extra produced blocks** (noise the converter invented) aren't directly penalised in
  STRUCT today — they show up indirectly via FALLBKS and by displacing order. A future
  axis could penalise unmatched produced nodes.
- **Block name only** at the structural level; attributes are checked solely through
  `contains`. Wrong attributes that don't surface in `contains` won't be caught — by
  design, to keep authoring light (E2). Tighten per-node with more `contains` anchors
  when an attribute genuinely matters (e.g. heading `level`).
- **First-match greedy** can mis-align when two same-named siblings differ only by
  content; add `contains` to disambiguate.

## Corpus workflow

1. **Acquire** a design unit — generator output (Impeccable, `/design`, a Figma/HTML
   export) or a representative hand-built section — into `evals/<name>/input.html`.
   Record where it came from in `expected.json.source`; never act on it.
2. **Author intent** in prose; compile to `expected.tree`. The fixture author owns the
   ground truth — when seeded by an agent, the human reviews the tree.
3. **Run** `npm run bench`; read the scorecard and miss lines.
4. **Iterate rules** (`src/convert/defaults.ts` and, later, third-party adapters);
   re-run; watch the score move.

## Relationship to the rest of the project

- **Extensibility (`04-extensibility.md`):** once an adapter exists, fixtures whose
  `tree` expects `coblocks/*` / `jetpack/layout-grid` become the proof that translation
  *and* the tiered gate cooperate. Until then, such fixtures legitimately score low —
  honest signal that the third-party path is unbuilt.
- **Not a unit test.** Lives outside the vitest suite and outside the npm `files` list.
  A baseline-regression test (assert corpus average ≥ N) can be added later to catch
  rule regressions in CI.

## Sharp edges

1. **Ground truth is opinion.** `expected.tree` encodes *a* correct editor outcome;
   reasonable designers may differ (columns vs media-text for image-beside-text). Keep
   the prose `intent` in the file so the judgement is auditable and adjustable.
2. **Don't tune rules to the corpus.** Fixtures must stay representative of real
   generator output, not become a spec the rules overfit. Grow the corpus from genuinely
   diverse sources (E6).
3. **Media ids.** Evals run with `resolver: 'noop'`, so Cover/Image carry URLs without
   attachment ids. That's fine for structure/content scoring; it is not a media-resolution
   test.
4. **Self-contained only.** Inline CSS is honoured (the converter extracts `<style>`);
   external stylesheets/assets are not fetched. Keep each unit standalone.

## Coverage axis

Beyond structure/content/validity/fallbacks, the scorer reports **COVERAGE**: the fraction
of the input's visible text that survives into the output. It catches *silent content loss*
— text dropped entirely — which is distinct from wrong structure (it parsed to the wrong
blocks) and from fallbacks (Custom HTML still preserves the text). An engine that skips or
hallucinates loses coverage even when its structure score looks fine. It's the measurable
half of "nothing degrades in silence" (`00` #5, `11` C9); confidence (engine-emitted) is
the other half, recorded as `confidence` once an engine reports it.

## Known gap: visual fidelity

Structure, content, coverage, and validity together still do **not** prove the converted
blocks *look* like the original design — validity ≠ fidelity (`00` #4). A conversion can
pass every axis and render wrong (off colours, spacing, an order that reads differently).
The missing axis is a **rendered before/after diff**: render the input and the produced
blocks (the latter needs a WP/theme render), screenshot both, and diff. `report/review.html`
already renders the input, so it's the natural place to grow this. Until then design
fidelity stays an explicit human-eye check, kept separate from the scored axes so a green
score never masquerades as "looks right."
