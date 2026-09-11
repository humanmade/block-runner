# Project-owned block runtime result

Date: 2026-09-11. This is an isolated local Docker proof, not a production or
owner-acceptance claim.

## Identity

- Block Runner source: `0c764d82ae59f6c4f458067337937d006afdb8d5` (`0.9.3`).
- Installed skill: `0.9.3`, from that same revision. The separately retained
  fresh attempt is documented in `SKILL-ATTEMPT.md`; its model and effort are
  unknown, and it was incomplete before the later source intervention.
- Runtime: `wp-env 11.12.0`, WordPress `7.1`, PHP `8.3.33`, and the checkout's
  explicitly installed Playwright Chromium.
- Rebuild provenance: editor source `c19f0973412efeb83d760f42faf8c4c9e41480b0c3e68be6d508bb93cfad8f2c`,
  renderer source/build `4b3f51fd59c263f8c6ed72ae0357426a6849d5175d08805f4e1e183dc2e50b35`,
  built editor `3e576239feaf2b27a22427c71327085f398d1b1fef27521dc774ed76be7af303`,
  and the installed ZIP `5f106877002c960eca33305a1237574bd085c3244698a8a8a2b3cde29f678203`.

## Commands and result

```sh
npx vitest run dev/test/project-owned-blocks.test.ts
npm run build --prefix dev/acceptance/project-owned-blocks
node evidence/proof-browser.mjs --category 3 --out evidence/browser-result.json
```

The source test passed (3/3), the consumer build completed, and the browser
control created two instances of each block via the visible inserter. It changed
only the second hero/list through labelled, keyboard-focusable visible controls.
It first saved/reopened an edited native introduction with the draft-only empty
category (`4`) and limit `6`, then changed that second list to published category
`3` and limit `1`, saved/reopened again, and found four valid blocks with a
clean editor. The reopened second hero retained image attachment `6`, focal
point `20% 80%`, `h3`, and a secure new-tab link, while the first hero kept its
defaults. The second list retained its native Heading/Paragraph children across
both cycles. The complete machine-readable state is `browser-result.json`.
`project-owned-controls.png` records the second instance's media, focal-point,
heading, link and new-tab controls; `project-owned-frontend.png` records the
rendered local output.

On the published local proof page, the attachment image emitted WordPress
`srcset` and `sizes`, focal placement, `h3`, and `target="_blank"` with rel
protection. Updating an already-matching published post title with WP-CLI,
without saving the containing page, changed the resource result while the
retained introduction stayed intact. The empty-category page retained its
native introduction and `No resources found.`; its matching draft did not
render. A direct `do_blocks()` negative control with malformed category/focal
data, a bad image ID, an oversized heading level, and unsafe URLs completed
without PHP notices, clamped to `h6`, retained child content, and emitted no
unsafe URL or event attribute.

After that first success, ordinary source changes renamed the editor control to
`Choose hero image` and changed the missing-image renderer text to `Choose a
hero image to complete this hero.`. `npm run build --prefix ...` produced new
dynamic-hero build hashes, the rebuilt ZIP was force-installed into the same
runtime, and both the live editor and frontend showed those source changes.

## Boundary

This establishes the local WordPress 7.1/PHP 8.3 mechanic, serialized editor
persistence, and local frontend behavior. It does not establish production
deployment, a physical-device check, accessibility acceptance, or owner review.
