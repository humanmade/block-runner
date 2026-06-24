# Producers

Each producer answers the shared briefs in `../specs/<layout>/prompt.md` with its own
HTML. Drop one file per layout:

```
producers/<producer>/<layout>.html
```

`<layout>` must match a spec folder name (e.g. `hero-split`, `pricing-table`). `npm run
bench` scores every producer file it finds against the shared `specs/<layout>/expected.json`
— a producer only needs the layouts you have answers for.

Producer slugs name the *input source* (and are deliberately distinct from the LLM
*engines* that do the converting, so `claude-design` the input is never confused with the
Claude engine):

- **claude-impeccable** — ships semantic markup; `../base/claude-impeccable.css` is inlined at run time.
- **codex-tailwind** — Codex + Tailwind output, fully self-contained.
- **claude-design** — Claude design-app exports, fully self-contained.

A producer with a `../base/<producer>.css` file gets that CSS inlined; producers without
one must ship fully self-contained HTML (inline `<style>` is fine and is read for cover
detection).

## Generation provenance (`producer.json`)

Optionally, each producer carries `producers/<producer>/producer.json` describing *how* its
HTML was generated — distinct from the run's engine model/effort (which is the converter):

```json
{ "generator": "codex", "provider": "openai", "model": "gpt-5.5", "effort": "low", "note": "…" }
```

`npm run bench` reads these into each run record (`producerMeta`) and prints them in the
per-producer rollup, so a result is attributable to the model + effort that produced its
inputs. (e.g. `codex-tailwind` = gpt-5.5 / low; `claude-impeccable` = hand-authored; `claude-design` = design app.)

To add a producer: create `producers/<name>/`, drop `<layout>.html` files (and an optional
`producer.json`), run the bench.
