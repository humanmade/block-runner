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
producer only needs the layouts it has answers for. `impeccable` ships semantic markup and
gets `base/impeccable.css` inlined; `figma` / `codex` / `claude` ship fully self-contained
HTML. See `producers/README.md` for the drop-in convention.

The producer is never fed to the converter and never affects scoring — the whole point is
that Block Runner handles diverse-origin HTML it knows nothing about.

> When authoring an `impeccable` layout, keep the structural class tokens the converter
> reads (`row`/`grid`/`col`/`card`/`btn`/`actions`/…) — they drive block detection.

**Benchmark integrity.** The `impeccable` inputs are *hand-authored* with semantic class
names that align with the converter's tokens, so treat `impeccable` as a clean-reference
ceiling rather than a peer. The independent producers (`codex`, `figma`, `claude`) generate
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

The thing *doing* the HTML→blocks conversion is swappable. An **engine** is a module
exporting `convert(html, options) => { output, summary }` (output = block-markup string).
The default is the deterministic rules in `src/`. Experimental LLM translator engines live
in `scripts/engines/` (Engine B — the LLM translates, the gate validates), all sharing
`prompt.ts`:

- `codex.ts` — Codex CLI (`codex exec`).
- `claude.ts` — Claude Code CLI (`claude -p`, harness/OAuth — no API key).

Run a non-default engine:

```sh
npm run bench -- --engine scripts/engines/codex.ts  --engine-label codex       --model gpt-5.5 --effort high --record
npm run bench -- --engine scripts/engines/claude.ts --engine-label claude-code --model sonnet  --effort high --record
```

- `--engine <path>` (or `BLOCK_RUNNER_ENGINE`) — the engine module; omit for the local rules.
- `--engine-label` / `--model` / `--effort` — recorded as the run's `engine` / `model` / `effort` provenance.
- `--producer <name>` / `--layouts a,b` — scope a run to a subset (cheap iteration; don't `--record` a scoped run as a baseline).

To add an engine: drop a module in `scripts/engines/` exporting `convert()`. For an LLM
engine, translate then `validate()` through the gate, and parse the model's output with
`extractBlocks()` from `prompt.ts` (tolerates missing markers / code fences). Give it a
per-call timeout so an unattended run can't stall.

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
