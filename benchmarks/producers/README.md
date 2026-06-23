# Producers

Each producer answers the shared briefs in `../specs/<layout>/prompt.md` with its own
HTML. Drop one file per layout:

```
producers/<producer>/<layout>.html
```

`<layout>` must match a spec folder name (e.g. `hero-split`, `pricing-table`). `npm run
bench` scores every producer file it finds against the shared `specs/<layout>/expected.json`
— a producer only needs the layouts you have answers for.

- **impeccable** — ships semantic markup; `../base/impeccable.css` is inlined at run time.
- **figma** — raw exports (positioned-div soup), fully self-contained.
- **codex** — Codex + Tailwind output, fully self-contained.
- **claude** — Claude design app exports, fully self-contained.

A producer with a `../base/<producer>.css` file gets that CSS inlined; producers without
one must ship fully self-contained HTML (inline `<style>` is fine and is read for cover
detection).

To add a producer: create `producers/<name>/`, drop `<layout>.html` files, run the bench.
