# Block Runner — conversion benchmark (directional design)

Where the evals are heading: from a local scorecard into a **conversion benchmark** —
an inventory of fixtures with ideal results, a log of scores over time tied to who/which
PR produced them, and publishable reports. Directional; nothing here is built beyond
Phase 0. The implemented pieces live in `05-evals.md` / `06-section-catalog.md`.

## The core idea: three separate planes

Today `evals/` tangles the inventory, the (implicit) scoring, and the generated report.
The whole design follows from pulling them apart:

| Plane | What it is | Lifecycle |
|---|---|---|
| **Suite** | the inventory — fixtures (`input.html`) + ideal end states (`expected.json`), grouped by producer | committed, curated, source of truth |
| **Results** | an append-only log of benchmark runs — scores + provenance (commit, PR, author, version) | committed history |
| **Reports** | rendered views — the *review* page (inputs vs ideal) and the *scoreboard* (scores over time) | generated, gitignored, publishable |

"Segregate the benchmarks from the report" = the Suite/Results planes are durable inputs;
the Reports plane is a disposable output built from them.

## Decisions (proposed)

| # | Decision | Rationale |
|---|---|---|
| B1 | **Three planes, physically separated** (suite / results log / generated reports). | Stops the current tangle; lets reports be regenerated and published without touching the source of truth. |
| B2 | **Producer = origin, and each producer carries a base style** reflecting its real output. | Impeccable output is consistent and well-designed; Figma output is positioned-div soup. The base style makes the suite realistic *and* presentable for publishing. |
| B3 | **Fixtures stay self-contained inputs**, but the shared base is the source of truth: author `base.css` + a per-layout snippet, and a build composes the standalone `input.html`. | Keeps eval rule (`05` E1: CSS inline so the converter sees it) while killing per-fixture ad-hoc ugliness and giving one place to control fonts/tokens. |
| B4 | **Results log = committed append-only JSONL**, one record per recorded run, with git/PR/author/version provenance. | Cheap, diffable, no DB; CI appends on merge; trend is just a reduce over the file. |
| B5 | **Two report artifacts**, both generated & static-publishable: a **review** page (inventory) and a **scoreboard** (history). | The review page is for designing fixtures; the scoreboard is the public progress story. |

## Proposed structure

```
evals/                              (the benchmark; rename to benchmarks/ later if wanted)
  base/
    impeccable.css                  shared design system for the impeccable producer (fonts, tokens, spacing)
    figma.css                       (or none — figma is intentionally raw/positioned)
  producers/
    impeccable/<layout>/
      layout.html                   the per-layout markup snippet (authored)
      expected.json                 ideal end state (authored)
      input.html                    GENERATED = base/impeccable.css inlined + layout.html  (what the converter ingests)
    figma/<layout>/{ input.html, expected.json }
  results.jsonl                     the benchmark log (committed)
  README.md                         authoring guide
report/                             generated, gitignored
  review.html                       inputs vs ideal end states (today's report.html, restyled)
  scoreboard.html                   scores over time, per producer, per fixture
scripts/
  bench.ts                          run suite → score → append results → build both reports
```

## Base style (B2/B3) — the publishable look

- One shared design system **per producer**, not per fixture. For `impeccable`: a small
  token set (font pairing, color roles, spacing scale) that reads as genuine Impeccable
  output. `figma` deliberately stays raw.
- **Self-contained tension:** the converter only receives `input.html` and reads inline
  `<style>` (e.g. for background detection), so styles can't live in an external file the
  converter never sees. Resolution: author `base/<producer>.css` + `layout.html`; a build
  step **inlines** base+layout into the standalone `input.html`. Single source of truth,
  still self-contained, no more ad-hoc CSS.
- **Offline caveat:** report previews render in sandboxed `srcdoc` iframes with no network.
  Web fonts must be self-hosted/inlined or fall back to a strong system stack. The
  published *report shell* (served) can use a real webfont; the *fixture previews* should
  stay system-font-safe unless we inline a variable font.
- The **report shell itself** uses the same base tokens, so the whole thing looks like one
  designed artifact when published.

## Results log (B4) — schema

One JSON object per line in `results.jsonl`:

```json
{
  "runAt": "2026-06-23T09:30:00Z",
  "commit": "0744f6e", "branch": "main", "pr": 42, "author": "dev",
  "blockRunnerVersion": "0.1.0",
  "suiteHash": "sha256:…",                         // detects suite changes vs converter changes
  "corpusAvg": 63,
  "producers": { "impeccable": 68, "figma": 8 },
  "fixtures": { "impeccable/hero-cover": 100, "impeccable/media-text": 11, "figma/hero-split": 8 }
}
```

- `suiteHash` is the lever that keeps the trend honest: a score change is attributable to
  the converter only when the suite is unchanged. Changing fixtures starts a new baseline.
- Recorded via `npm run bench --record` locally and by CI on merge. Plain runs don't append.

## Provenance & CI (who/which PR)

- A GitHub Action runs the suite on each PR: posts the **score delta vs base branch** as a
  PR comment, uploads `report/` as an artifact, and (optionally) fails if `corpusAvg`
  regresses past a threshold.
- On merge to `main`, it appends one `results.jsonl` record (commit/PR/author from the CI
  env) and commits it. That's the historical log.

## Reports (B5)

- **review.html** — today's page, restyled to the base tokens: per producer, input preview
  beside the ideal end state. About the *inventory*. (No scores — that's the scoreboard.)
- **scoreboard.html** — corpus average over time, per-producer lines, per-fixture
  sparklines, latest run's provenance. Built from `results.jsonl`. About *progress*.
- Both static → publishable on GitHub Pages.

## Natural progression (each step shippable on its own)

- **Phase 0 — done.** Suite (11 fixtures, 2 producers), scorer, review report.
- **Phase 1 — segregate + base style.** Split suite / results / report dirs; add
  `base/impeccable.css` + the inline build; restyle review.html to the base tokens. *(No
  new capability, just clean + presentable — the immediate ask.)*
- **Phase 2 — results log.** `results.jsonl` + `npm run bench --record`; a basic
  scoreboard.html rendering the trend.
- **Phase 3 — CI provenance.** Action: PR score-delta comment + report artifact; append a
  log record on merge with commit/PR/author.
- **Phase 4 — publish.** Host review + scoreboard on Pages; the public benchmark.
- **Phase 5 — grow.** More producers (real vendors), more layouts, optional regression
  gate (fail PR on corpus-avg drop), per-rung styling-fidelity scoring (ties to `07`).

## Open forks (decide before Phase 1)

1. **Base-style approach (B3):** the build-and-inline model above (single source of truth,
   adds a build step) vs. keeping fixtures fully hand-authored but pasting a shared
   `<style>` header into each (no build, mild duplication). Recommend build-and-inline.
2. **Naming:** keep `evals/` or rename to `benchmarks/` now (before history/links exist, so
   rename is cheap). Recommend rename to `benchmarks/` — it's what this is.
3. **Results log home:** committed `results.jsonl` (diffable, simple) vs CI-artifacts only
   (no repo churn). Recommend committed JSONL.

## Backtesting (engine-version axis) — built

The recorded `results.jsonl` trend is **not** apples-to-apples: each run scored the engine
against the suite *as it was then*, so the curve mixes "engine improved" with "suite grew".
`suiteHash` marks those regime changes. Backtesting gives a true curve by **holding the
suite constant and varying the engine** — re-run *older* engines against *today's* suite.

How it's wired:
- The engine in `bench.ts` is loaded **dynamically** and is swappable: `--engine <path>` or
  `BLOCK_RUNNER_ENGINE` points at another version's built entry (default = this repo's
  source). `parseMarkup` (scoring) stays current — it's a stable utility, not the thing
  under test. The suite is the constant; the engine is the variable.
- Records carry `engine` (label, default `local`) alongside `version` + `commit` (the suite
  checkout) + `suiteHash`. A backtest row is `engine=<old-sha>` with the *current* suiteHash.
- `scripts/backtest.sh <commit>…` loops commits: `git worktree` per version (its own deps),
  `npm ci && npm run build`, then runs the current suite against `…/dist/index.js` with
  `--record`. Verified: `--engine dist/index.js` reproduces the live scores exactly.

The load-bearing constraint: a **stable `convert()` public API** (the suite↔engine
contract). A commit that broke it is a backtest floor (or needs a shim).

Caveats:
- **Cross-version `@wordpress`.** Same pin across commits → fine. A commit that *bumped*
  `@wordpress/*` loads a second copy alongside current `parseMarkup`; for full isolation
  there, consume the engine as a **published/pinned package** rather than a worktree dist.
  Treat `backtest.sh` as the scaffold.
- **New fixtures on old engines** legitimately score low (the old engine never knew about
  them) — that *is* the progress signal.

## Relationships

- `05-evals.md` is the scoring engine this wraps; `06-section-catalog.md` is the inventory's
  design rationale; `07-styling-policy.md` adds a future per-rung scoring dimension; the
  producer axis feeds the source-detection open question (`03` #9).
