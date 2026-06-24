# Block Runner — conversion benchmark

A training ground for the **translator** (HTML → native block tree). The gate proves
markup is *editor-valid*; it cannot tell us the converter understood the *intent*.
This benchmark measures intent fidelity — the gap `md/02-architecture.md` flags as
"validity ≠ correctness". Directional design: `md/08-benchmark-system.md`.

Run it:

```sh
npm run bench
```

This prints a scorecard (overall + per-producer) and writes two generated pages (gitignored,
segregated from the committed suite) under `report/`:

- **`report/review.html`** — per layout: the ideal end state beside *each producer's* render
  (the cross-producer comparison matrix).
- **`report/scoreboard.html`** — scores over time, built from the results log.

```sh
npm run bench:record   # same run, but appends one record to benchmarks/results.jsonl
```

`benchmarks/results.jsonl` is the **committed history** — one JSON record per recorded run,
tagged with commit / branch / author / version and a `suiteHash` (so a score change is
attributable to the converter only when the suite is unchanged). Plain `npm run bench` does
not append; only `--record` does (CI records on merge — see `md/08-benchmark-system.md`).

## Structure: shared specs, many producers

The ideal end state is defined **once per layout** (a spec); each producer supplies its own
HTML answer to the same brief, and all are scored against the shared spec:

```
benchmarks/
  specs/<layout>/
    prompt.md          # the brief given to EVERY producer (the shared question)
    expected.json      # { intent, tree } — the ideal native block tree (the shared answer)
  producers/<producer>/<layout>.html   # one producer's HTML answer to that layout's prompt
  base/<producer>.css                  # optional; inlined into that producer's layouts at run time
  results.jsonl        # committed run history
```

The scorer pairs every `producers/*/<layout>.html` with `specs/<layout>/expected.json`. A
producer only needs the layouts it has answers for. `claude-impeccable` ships semantic markup
and gets `base/claude-impeccable.css` inlined; `figma` / `codex-tailwind` / `claude-design` ship
fully self-contained HTML. See `producers/README.md` for the drop-in convention.

The producer is never fed to the converter and never affects scoring — the whole point is
that Block Runner handles diverse-origin HTML it knows nothing about.

> When authoring a `claude-impeccable` layout, keep the structural class tokens the converter
> reads (`row`/`grid`/`col`/`card`/`btn`/`actions`/…) — they drive block detection.

**Benchmark integrity.** The `claude-impeccable` inputs are *hand-authored* with semantic class
names that align with the converter's tokens, so treat `claude-impeccable` as a clean-reference
ceiling rather than a peer. The independent producers (`codex-tailwind`, `figma`, `claude-design`) generate
from the brief without that advantage, so their scores are the truer signal of how
convertible real generator output is. (Same brief, different markup, different
convertibility — that spread is the point.)

## Authoring a spec (`specs/<layout>/`)

`prompt.md` is the brief, with **specific copy** so every producer's output is comparable.
`expected.json` is the ideal tree — describe only the blocks and content that matter:

```json
{
  "intent": "A full-width cover. Two columns: left an image; right a heading, a paragraph, a button.",
  "tree": {
    "block": "core/cover",
    "children": [
      { "block": "core/columns", "children": [
        { "block": "core/column", "children": [ { "block": "core/image", "contains": "founder.jpg" } ] },
        { "block": "core/column", "children": [
          { "block": "core/heading", "contains": "Built for handoff" },
          { "block": "core/paragraph" },
          { "block": "core/buttons", "children": [ { "block": "core/button", "contains": "Start now" } ] }
        ]}
      ]}
    ]
  }
}
```

- `block` — expected block name (e.g. `core/cover`, `coblocks/row`).
- `children` — nested blocks, **in the order you expect them**.
- `contains` *(optional)* — a substring that must appear in that block's content/attrs
  (text, url, alt, href). Use it to assert the right content landed in the right block.

## How scoring works

Per fixture, four axes:

| Axis | Meaning |
|---|---|
| **STRUCT** | Right blocks, right nesting, right order (ordered tree alignment vs `tree`). |
| **CONTENT** | Of asserted `contains`, how many landed in the matched block. |
| **VALID** | The produced markup passes the gate. Invalid output halves the score — correctness presupposes validity. |
| **FALLBKS** | Count of `core/html` blocks. Every fallback is a conversion miss; surfaced loudly, never hidden. |

Composite `SCORE` = 75% structure + 25% content, halved if invalid. Misses print
beneath each row, pointing at the exact expected node that wasn't satisfied — that's
the signal for which rule to fix next.

## Engines (the converter axis)

The thing *doing* the HTML→blocks conversion is swappable. The default is the
deterministic **rules engine** in `src/` (no `--engine` flag): it walks authored markup
through its rule set and assembles native blocks — cheap, valid, and unbeatable on clean
semantic input, but it falls back to `core/html` on markup it doesn't recognize.

The other real engine is **Engine C** — a *split* engine in `scripts/engines/engine-c.ts`
(+ its deterministic core `intent.ts`). It separates the two halves of conversion:

- **propose** (`engine-c.ts`) — the costly, non-deterministic half: the model reads the HTML
  and emits a typed block-**intent** tree (block names + nesting + which content goes where),
  *never* markup.
- **realize** (`intent.ts`) — the deterministic half: `assemble()` turns that intent into a
  real block tree via `createBlock()` + `serialize()` — no hand-written innerHTML, so the
  markup is each block's own `save()` output and therefore **valid by construction**. The gate
  is a backstop, not a halving tax. Every failure is bounded to wrong structure/attributes,
  never invalid markup.

Engine C exports the tuner's split contract — `propose` / `realize` / `promptHash` — so the
tuner caches the model's intent tree once and replays `realize()` for free (T0) while you
iterate on the assembler, calling the model again only when the prompt or schema changes.

Run Engine C:

```sh
npm run tune  -- --tier t2 --engine scripts/engines/engine-c.ts --engine-label engine-c --model opus
npm run tune  -- --tier t2 --engine scripts/engines/engine-c.ts --engine-label engine-c --model gpt-5.5 --cli codex --effort high
npm run bench -- --engine scripts/engines/engine-c.ts --engine-label engine-c --model opus --record
```

- `--engine <path>` (or `BLOCK_RUNNER_ENGINE`) — the engine module; omit for the local rules.
- `--engine-label` / `--model` / `--effort` — recorded as the run's `engine` / `model` / `effort` provenance.
- `--cli claude` (default; harness/OAuth, no API key) or `--cli codex` — which model CLI Engine C shells out to.
- `--producer <name>` / `--layouts a,b` — scope a run to a subset (cheap iteration; don't `--record` a scoped run as a baseline).

To add an engine: drop a module in `scripts/engines/`. Prefer the **split-engine contract** —
export `propose(html, opts) => { raw }` (the costly model call), `realize(raw, opts) =>
BlockRunnerReport` (pure + deterministic: assemble → serialize → gate), and a `promptHash`
that bumps whenever the prompt/schema changes (so the tuner's cache auto-invalidates). Have
`realize()` assemble via `createBlock()` (valid by construction) and `validate()` through the
gate. Give the model call a per-call timeout so an unattended run can't stall.

## Backtesting

Because the engine is swappable and every record carries a `suiteHash`, you can re-run the
**current** suite against **older** engine versions for a true apples-to-apples curve
(suite held constant, engine varied):

```sh
scripts/backtest.sh <commit> [<commit> …]
```

It worktrees each commit, builds it, and runs the current suite against its `dist/`,
recording `engine=<commit>`. Load-bearing rule: keep `convert()`'s public API stable.
Full methodology + caveats: `md/08-benchmark-system.md`.

## Tuning loop

`npm run bench` *scores* an engine. The **tuner** (`npm run tune`) is the loop that *moves
that score up* — cheaply, and honestly. It shares the scorer's core (`scripts/tuner/score.ts`)
so the measurement is defined once, and adds three deterministic mechanics on top: a
cheap replay cache, honest attribution, and a regression ratchet. No LLM in the loop — the
tuner's intelligence is bookkeeping + selection; the LLM is only ever an engine under test.

### Three tiers

| Tier | What runs | Cost | Run it |
|---|---|---|---|
| **t0 — inner** | replay cached artifacts + score (live for the rules engine — it has no costly step) | sub-second | every change to the deterministic half |
| **t1 — smoke** | live over the auto-selected smoke set, then score | ~minutes | after changing the prompt / intent schema |
| **t2 — full** | live over all fixtures, then score | 15–30 min (LLM) | to certify a milestone / refresh the baseline |

```sh
npm run tune -- --tier t0 --engine scripts/engines/engine-c.ts --model opus                  # replay cache, deterministic, sub-second
npm run tune -- --tier t0 --full --engine scripts/engines/engine-c.ts --model opus           # replay ALL cached fixtures (re-score after a scorer/assembler edit)
npm run tune -- --tier t1 --engine scripts/engines/engine-c.ts --model opus                  # smoke, live
npm run tune -- --tier t2 --engine scripts/engines/engine-c.ts --model gpt-5.5 --cli codex   # full, live
npm run tune -- --tier t0 --refresh --engine scripts/engines/engine-c.ts --model opus        # ignore cache (force a live re-run)
npm run tune -- --tier t2 --engine scripts/engines/engine-c.ts --model opus --baseline-update # accept current as the new ratchet baseline
```

`npm run tune:t0` is the shorthand for the inner loop.

### The cost insight (why it's cheap)

In any engine, exactly one step is slow + non-deterministic: the **LLM call**. Everything
after it — assemble, serialize, gate, score — is instant + deterministic. So the tuner
caches the costly artifact (*propose*) and replays the deterministic tail (*realize*) for
free. Iterating on the assembler / gate / mapping needs **no LLM call** — replay the cache.

- **Split engine** (exports `propose` / `realize` / `promptHash`, e.g. Engine C): the tuner
  caches `propose().raw`; t0 replays `realize(raw)`. Editing the assembler or gate → pure t0,
  zero LLM. The tuner runs split engines only (the LLM-writes-markup engine is retired).
- **Rules engine** (no `--engine`): no costly step, so all tiers run it live; the tiers
  differ only in fixture scope and the attribution/ratchet they apply.

Cache key = `sha(engineLabel + model + effort + inputHtml + promptHash)`. A fixture edit
changes `inputHtml`; a prompt/schema edit bumps the engine's `promptHash` — either
invalidates the entry, so t0 reports the affected fixtures as **stale** / **uncached**
(skipped loudly, never scored 0) until a t1/t2 refresh repopulates them.

### Auto-selected smoke set

The t1/t0 sample is not a frozen hand-list. It is a committed seed of archetype probes
(`smoke.seed.json` — the validity-halving case, two structure cases on the same brief across
producers, a messy-input case) **plus** auto-augmentation from `results.jsonl` history: the
highest-variance fixtures, the most-recently-regressed, and a guarantee of ≥1 per producer.
The tuner prints *why* each fixture was selected — selection is explainable, never magic.

### Honest attribution (kills single-cell overfits)

Every run diffs against the previous **comparable** run (same `suiteHash` + `engine` +
`model`) and reports per-fixture deltas grouped by class — producer and layout — then
classifies the change:

- **class-move** (the win we want): moved ≥2 fixtures across ≥2 producers, same direction.
- **single-cell** (the trap): moved one fixture (or one producer) → `⚠ overfit suspect`,
  because tuning to one producer/model is the cardinal sin (`md/11`).

It also aggregates misses by expected block (`core/media-text` expected but absent in N
fixtures across M producers) so the next fix is chosen by which *class* it unlocks.

### Regression ratchet (nothing degrades in silence)

Per engine/model, the tuner keeps a best-ever score per fixture
(`baselines/<engine>__<model>.json`, committed). Any run where a fixture drops below its
baseline by more than a small threshold **exits non-zero** — the loop cannot silently
regress, and coverage only ratchets up.

- `--baseline-update` accepts the current run as the new baseline (a deliberate act; it only
  ever raises the recorded ceiling).
- `--capture` writes the regressed fixture's current axes + misses beside its prior golden
  into `regressions/` (gitignored) for inspection.

`baselines/` and `smoke.seed.json` are **committed**; `.cache/` and `regressions/` are
**gitignored**. Full design: `md/13-engine-tuner.md`.

## Contributing

Three additive extension points — none requires touching the core:

1. **Producer** (an input source) — `producers/<name>/<layout>.html` (+ optional `producer.json`).
2. **Engine** (a converter) — `scripts/engines/<name>.ts` exporting `convert()`.
3. **Output target** (a block vocabulary, e.g. CoBlocks) — an adapter; directional, see `md/04` + `md/09`.

Run `npm run bench` (prints the scorecard + writes `report/`); `npm run bench:record`
appends a provenance-tagged run to `results.jsonl`. The golden rule (`md/11`): **be
specific about the output (core blocks), neutral about the variable axes — never
special-case one producer or one engine/model.** The `suiteHash` tells you when two runs
are comparable; a change should move a *class* of fixtures across producers and engines,
not a single cell.
