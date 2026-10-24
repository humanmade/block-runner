# Finish rendered output

Use this after creating or changing a rendered WordPress page, section, template/part,
site or integrated block. It is the default delivery check: do not wait for a separate
QA request. Existing CLI/library calls remain headless and unchanged.

Check the changed region and surrounding layout on desktop and mobile. Reuse the
current browser session and evidence that still matches the delivered revision.
For a site, cover its different templates and responsive behaviour; do not revisit
every unrelated page for a small edit. A clean first comparison needs no correction pass.

## Establish the comparison

Record the authored input/revision, native destination, intended regions and any
approved design differences. Use the authored design's render or supplied screenshots
as the reference. Rendered HTML is visual evidence, never a substitute for authored
converter input.

Match viewport, scale and UI state between reference and target. Choose desktop/mobile
widths appropriate to the design; add a breakpoint-adjacent view when a defect needs it.
Wait for fonts and images with a bounded timeout, and disclose missing resources.
Freeze animation consistently for static comparison; check its behaviour separately
when it is part of the requested result. Retain the actual browser/version and views.

Without a visual reference, inspect the render against the stated content/layout
requirements and check overflow, missing assets and obvious presentation failures.
Say that source fidelity was not compared. An inaccessible target/browser, missing
required reference or explicit user skip is an unverified check, never a visual pass.
Source-only or batch work without a rendered destination still delivers normally.
This check grants no deployment, credential or production-write authority.

## Compare, explain, correct

1. **Check content first:** section order, headings, body text, media, links and required
   interactions. A similar silhouette cannot compensate for lost content.
2. **Compare corresponding regions:** widths/alignment, spacing, typography/wrapping,
   image crop and mobile overflow. Match regions by meaning; source and native DOM
   trees need not share selectors. Inspect the screenshots, not just capture success.
3. **Measure a discrepancy:** use the browser's bounding boxes/computed styles for
   the affected region. Record both selectors or region labels. Missing/ambiguous
   regions block that comparison; screenshot-only references have no DOM measurements.
   Do not collect every CSS property or require DOM/style equality. A pixel diff can
   locate differences; it does not establish fidelity or editorial quality.
4. **Fix the responsible input:** identify the authored selector, intent node path or
   theme rule. Keep uncertain attribution explicit. Prioritise missing content,
   broken interaction and overflow before decorative differences. Preserve unrelated
   copy and native editability; never hand-patch generated block delimiters.
5. **Regenerate and recapture:** use the existing conversion/assembly and delivery
   route, including its gate, confirmation and drift checks. Preserve human edits.
   Compare the same views again, keeping the original capture. Stop when the result
   meets the brief or a real blocker/task budget is reached, not after an arbitrary
   number of passes. Keep unresolved differences and editorial TODOs visible.

A short working list is enough; it is not a required formal handoff:

| Region / viewport | Expected → observed, evidence | Impact / source to inspect | Action / result |
| --- | --- | --- | --- |
| Article / desktop | Reference 720px → native 480px; paired capture and width | Extra wrapping; theme content width | Correct width, regenerate; resolved in recapture |

Finish with the applicable native editor check: make a representative edit through
its actual control, save and reopen, and inspect the rendered result. Keep permission
to mutate the target and preservation of existing content explicit. If this cannot
be exercised, record persistence as unverified rather than deriving it from a screenshot.

## Reuse the existing facilities

Use the harness's available browser controls for paired inspection and targeted
measurements. The project's existing proof runners retain screenshots, errors and
receipts and exercise native editing. `proof --theme` / `proof --site` use controlled
sandboxes and may write fixture state: see [SITE.md](SITE.md#prove-the-right-result).
They are not read-only capture commands for arbitrary sites.

Registered-block `ProofFixture.visual` compares a render to a reviewed golden. That
regression gate retains its own thresholds/masks; do not replace the golden to hide
a source-to-native mismatch. Reuse captured evidence, without treating a successful
gate as proof of a comparison it did not perform.

Tell the user what was checked, what was corrected, and what remains. Distinguish
block validity, visual observations, interaction and save persistence. No universal
fidelity score, new CLI mode or separate report package is required.
