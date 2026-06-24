# Block Runner — common section catalog + idiomatic block mappings

The recurring marketing/landing-page section archetypes, each with its **idiomatic
native WordPress block tree** (the "ideal end state" the converter should target) and
the third-party block that fits where core is awkward. This is the grounding behind the
eval corpus (`benchmarks/producers/`) and the extensibility tiers (`04-extensibility.md`).

## Provenance

Two parallel `/research` angles (2026-06-23, research-runner + web-runner):
(1) most-common section archetypes — converged across Tailwind UI, WordPress.com /
WordPress.org pattern directories, and Webflow's section taxonomy; (2) idiomatic block
mappings — grounded in the **Twenty Twenty-Five patterns** (`WordPress/twentytwentyfive`
on GitHub) and the **core block reference**
([developer.wordpress.org/.../core-blocks](https://developer.wordpress.org/block-editor/reference-guides/core-blocks/)).
CoBlocks / Layout Grid specifics from their repos (see `04-extensibility.md`). All
`verified` unless noted.

## The catalog

| Section | Typical structure | Idiomatic core tree | Third-party fit | Fixture / score |
|---|---|---|---|---|
| **Hero (centered cover)** | bg image + headline + subhead + CTA(s), text overlaid | `cover > [heading, paragraph, buttons>button]` | — | `hero-cover` · 100 |
| **Hero (split)** | text column + media column | `cover > columns > [column>(eyebrow, h1, p, buttons), column>image]` | — | `hero-split` · 100 |
| **Feature grid (icons)** | H2 + N cards: icon + h3 + paragraph | `group > [heading, columns > column*N>(image, heading, paragraph)]` | `coblocks/features`+`coblocks/icon` (real SVG icons) | `feature-grid` · 100 |
| **Media-text (alt rows)** | image beside text (h2 + p + list + button) | `core/media-text > [heading, paragraph, list, buttons]` (image = media attr) | — | `media-text` · 11 ⚠ |
| **Pricing table** | H2 + N plan cards: name, price, feature list, CTA, badge | `group > [heading, columns > column*N>(heading, paragraph, list, buttons>button)]` | `coblocks/pricing-table`+`-item` | `pricing-table` · 86 |
| **Testimonials** | H2 + N cards: quote + avatar + name/role | `group > [heading, columns > column*N>(quote, image, paragraph)]` | `coblocks/testimonials`+`-item` (avatar built-in) | `testimonials` · 38 ⚠ |
| **CTA band** | full-width band: H2 + p + button | `group(full, bg) > [heading, paragraph, buttons>button]` | — | `cta-band` · 100 |
| **Logo cloud** | label + horizontal strip of logos | `group(flex,wrap) > [paragraph, image*N]` | `coblocks/logos` | `logos-strip` · 26 ⚠ |
| **Stats / counters** | H2 + N figures: big number + label | `group > [heading, columns > column*N>(paragraph, paragraph)]` | `coblocks/counter` (animated) — **no core block** | `stats-counters` · 100 |
| **FAQ / accordion** | H2 + Q/A disclosures | `group > [heading, details*N>paragraph]` | `coblocks/accordion`+`-item` (styled) | `faq-accordion` · 22 ⚠ |
| **Team grid** | H2 + person cards: photo + name + role | `group(grid) > group*N>(image, heading, paragraph)` | — | *(not yet fixtured)* |
| **Gallery** | uniform image grid | `core/gallery > image*N` | — | *(not yet fixtured)* |
| **Comparison table** | feature matrix | `core/table` | — | *(not yet fixtured)* |

⚠ = current converter gap (see below). Scores are the corpus baseline at doc time
(`npm run bench`, corpus avg 68).

## Key judgment calls (these decide the ground-truth trees)

1. **Image-beside-text → `core/media-text`, not `core/columns`.** media-text is
   purpose-built for exactly two zones (one media, one text) and is the idiomatic choice;
   reserve `core/columns` for >1 media or richer per-column content. The converter has no
   media-text rule today → emits columns → `media-text` fixture scores low. *(Inferred
   from block descriptions; no official "when to use" page — `single-source`.)*
2. **No core icon block.** Icon feature grids use `core/image` as the icon proxy in core
   (Twenty Twenty-Five `services-3-col.php` does this). Real SVG icons require
   `coblocks/icon`.
3. **No core counter/stat block.** Static stats are `heading`/`paragraph` in columns; the
   big number is a **styled paragraph, not a heading** (a stat has no document-outline
   role). Animated counters → `coblocks/counter`.
4. **FAQ → `core/details` (one per Q/A).** Native `<details>`/`<summary>`, accessible, no
   JS. `coblocks/accordion` only when you need its styling/controls.
5. **Testimonials → `core/quote`, but it has no avatar slot.** Twenty Twenty-Five works
   around this by pairing quote + image in columns at the pattern level.
   `coblocks/testimonials` is cleaner (avatar is a block attribute).
6. **Hero with a background *image* → `core/cover`; hero with a background *color* →
   `core/group`** with a background color (don't force cover without an image).

## Converter gaps this catalog surfaces (the rules backlog, ranked by corpus impact)

- **`blockquote`/`cite` → `core/quote`** (testimonials 38) — and `figure` wrapping should
  recurse, not fall to Custom HTML.
- **flat image row → images, not empty columns** (logos 26) — current `columns` rule
  consumes a bare `<img>` cell and emits an empty `core/column`. Real bug.
- **`<details>` → `core/details`** (faq 22).
- **image-beside-text → `core/media-text`** (media-text 11).
- **decorative inline `<span>` → text**, not Custom HTML (pricing badge; pricing 86).

Each maps to a translation rule (and, for the styled variants, a future third-party
adapter per `04-extensibility.md`).

## How to extend the catalog

Add a fixture under `benchmarks/producers/<producer>/<layout>/` (`input.html` +
`expected.json` with the idiomatic tree). `npm run bench` regenerates `report/review.html`,
the single-page aggregator for reviewing every ideal end state side-by-side with the
input and the current converter output.
