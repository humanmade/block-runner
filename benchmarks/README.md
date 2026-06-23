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

- **`report/review.html`** — per fixture, the rendered input beside the ideal end state.
- **`report/scoreboard.html`** — scores over time, built from the results log.

```sh
npm run bench:record   # same run, but appends one record to benchmarks/results.jsonl
```

`benchmarks/results.jsonl` is the **committed history** — one JSON record per recorded run,
tagged with commit / branch / author / version and a `suiteHash` (so a score change is
attributable to the converter only when the suite is unchanged). Plain `npm run bench` does
not append; only `--record` does (CI records on merge — see `md/08-benchmark-system.md`).

## The suite is grouped by producer

Each fixture is a self-contained design unit, grouped by the tool that produced its HTML
(the input side — a benchmark testbed per producer):

```
benchmarks/
  base/<producer>.css            # shared design system for that producer (fonts, tokens, components)
  producers/<producer>/<layout>/
    layout.html                  # semantic markup only — no <style>; the base owns the look
    expected.json                # { intent, source, tree } — the ideal block tree
```

e.g. `benchmarks/producers/impeccable/hero-split/`. At run time the runner composes the
converter input by inlining `base/<producer>.css` into `layout.html`, so fixtures stay
self-contained (the converter sees styling inline) with one place controlling the look.
A producer with no base (e.g. raw Figma exports) can instead ship a full self-contained
`input.html` and skip `layout.html`.

`source` in `expected.json` is the authoritative producer label for the per-producer
rollup. The source is never fed to the converter and never affects scoring — the whole
point is that Block Runner handles diverse-origin HTML it knows nothing about. Keep one
coherent design unit per fixture (typically one top-level block subtree).

> Keep structural class tokens the converter reads (`row`/`grid`/`col`/`card`/`btn`/
> `actions`/…) when restyling via the base — they drive block detection, so changing them
> changes scores.

## Authoring `expected.json`

Write the GUI-level intent in prose, then express it as a tree. You describe only the
blocks and the content that matter — you never have to spell out every attribute.

```json
{
  "intent": "A full-width cover. Inside, two columns: left an image; right a heading, a paragraph, then a button group with one button.",
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

- `block` — the expected block name (e.g. `core/cover`, `coblocks/row`).
- `children` — nested blocks, **in the order you expect them**.
- `contains` *(optional)* — a substring that must appear in that block's content/attrs
  (text, url, alt, href). Use it to assert the right content landed in the right block.

Workflow: you supply `input.html` + the prose intent; the intent is compiled once into
the `tree` above for you to eyeball. The scorer is then deterministic, so rule changes
move the score predictably.

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
