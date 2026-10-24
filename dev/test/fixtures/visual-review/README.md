# Visual finishing exercise

Two synthetic regions exercise [the rendered-delivery workflow](../../../../skills/block-runner/references/VISUAL.md): a long-copy page and a shared template part. The reference uses different HTML elements from the native block tree. Its copy must survive unchanged.

`styles/native.css` deliberately narrows the article and closing note and forces the highlight wider than a phone. `styles/native.corrected.css` contains the source correction, including the WordPress first-child spacing rule found during review. Keep the original fixture intact; copy it to a separate working directory before substituting corrected CSS.

## Replay

Build the checkout with `npm run build`. Serve this directory with a local static server and open `reference.html`. Compile the native source:

```sh
node dist/cli.js site compile dev/test/fixtures/visual-review/site.intent.json --asset-root dev/test/fixtures/visual-review --out /tmp/visual-review-before --strict --json
```

Use a new output path if that directory already exists. Install the emitted `theme/` as `visual-review-demo` on an explicitly selected disposable WordPress 7.1 site and activate it. Use the existing `site plan` / hash-confirmed `site apply` route from [SITE.md](../../../../skills/block-runner/references/SITE.md); retain the plan, journal and readback. No production target is needed.

Compare the rendered reference and native homepage at 1280×900 and 390×844, with the same scale and scrollbar state. Check content, then the article, highlight and closing note. Retain paired screenshots and targeted bounding boxes; inspect the images.

Copy this fixture to a working directory, replace that copy's `styles/native.css` with `styles/native.corrected.css`, then compile to a new output directory. Deploy the changed theme bytes to the same disposable target, plan/apply again and recapture the same regions. Do not patch serialized block delimiters or discard the initial evidence. Finish with a representative native editor edit, save and reopen.

## Observed comparison

On 2026-10-24, local WordPress 7.1 / PHP 8.4.27 and the in-app Chromium browser showed:

| Region / view | Reference | Before | After |
| --- | --- | --- | --- |
| Article / desktop | 720px wide | 480px; extra wrapping | 720px |
| Closing part / desktop | 960px, centred text | 440px, left-aligned | 960px, centred |
| Highlight / mobile | 342px | 520px; document overflow to 544px | 342px; document width 390px |
| Article top / desktop, mobile | 48px, 24px | 0px, 0px | 48px, 24px |

Matched mobile viewports used 390 CSS pixels with scrollbars hidden on both sides; desktop used 1280. The corrected region text, widths, heights, positions and alignment matched the reference. The screenshots showed the same wrapping and spacing. Both strict compilations had no diagnostics; the site applies completed with readback. These are separate validity, operational and visual observations, not a universal fidelity score.

No new helper, renderer, command or dependency was needed. A clean comparison ends after the paired inspection; it does not require a correction loop. Missing-reference, unavailable-browser and source-only cases remain explicitly unverified under the workflow, and do not block ordinary source delivery.

## Native editing and retained evidence

In Chrome 154, the page highlight paragraph was edited, saved and reopened in the native editor; the saved WordPress content and frontend both contained the test sentence. The closing-note template part passed the same edit/save/reopen and frontend check. Both original texts were then restored through the editor. The restored page also passed the existing validation gate.

- Desktop: [reference](evidence/reference-desktop-matched.png), [before](evidence/before-desktop-matched.png), [after](evidence/after-desktop-matched.png).
- Mobile: [reference](evidence/reference-mobile-matched.png), [before](evidence/before-mobile-matched.png), [after](evidence/after-mobile-matched.png).
- Native persistence: [page reopened](evidence/editor-reopened.png), [template part reopened](evidence/part-editor-reopened.png).

The paired after comparison was taken before the deliberate editor test edits. These captures show synthetic content only. The exercise was performed by one operator; independent reviewer replay remains separate.
