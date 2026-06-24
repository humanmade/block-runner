# Benchmark visuals

Public, screenshot-ready visualisations for the README and other collateral. One
self-contained `index.html` + one lightweight `style.css` (Geist, no build, no
dependencies).

## View

Open `index.html` directly, or serve the folder:

```sh
cd visuals && python3 -m http.server 8799
# http://localhost:8799/index.html
```

Then screenshot each figure card (or the whole page) and drop the PNGs into the
main `README.md`.

## What's in it

1. **Models head-to-head** — grouped bars: fidelity by converter, split by input quality.
2. **Score distribution over runs** — every fixture score per run + a corpus-average trend line.
3. **How it works** — the conversion pipeline (input → translate → gate → media → blocks).
4. **The benchmark loop** — spec → producers → engine → scorer → log → reports, with the backtest loop.

Figures 1–2 are data-driven; 3–4 are static diagrams.

## Refreshing the data

The numbers are embedded as `MODELS` and `RUNS` constants in a `<script>` at the
bottom of `index.html`, transcribed from `benchmarks/results.jsonl`. When new runs
land, update those two constants and re-screenshot — the charts scale to any number
of runs automatically.

Fonts are vendored in `fonts/` so the page renders identically offline.
