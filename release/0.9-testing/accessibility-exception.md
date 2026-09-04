# WordPress 7.1 editor exceptions for 0.9 testing

Approved by the project owner on 2026-09-04 for the **0.9 testing release only**.
This is not an accessibility certification or an exception for 1.0.

## Finding and evidence

Axe reports `aria-allowed-attr` and `aria-allowed-role` on the native WordPress
Heading editor control: an `h2` with `role="document"`, `aria-multiline="true"`,
and `aria-readonly="false"`. The same findings were reproduced in WordPress 7.1
with a standalone `core/heading`, without a Block Runner wrapper. Native heading
insertion, editing, saving, and reopening passed in that control run.

Axe also reports `aria-allowed-attr` on the native WordPress Paragraph editor
control: a `p` with `role="document"`, `aria-multiline="true"`, and
`aria-readonly="false"`. This was reproduced in WordPress 7.1 with a standalone
`core/paragraph`, without a Block Runner wrapper. Native paragraph insertion,
editing, saving, and reopening passed in that control run.

The retained control run includes `result.json`, the browser trace, and screenshots
in the `native-a11y-control/retained-control` evidence set. The generated-block
comparison is in `bundled-assets/browser-hydration`. Both are currently local
integration evidence, not published release artifacts. Archive both sets and link
their immutable hashes from the release candidate before relying on this exception
outside the integration run.

CI recreates each control with `npm run proof:control -- --block heading` and
`npm run proof:control -- --block paragraph`: each run starts the pinned
`proof/wp-env.json`, observes `wp core version` before and after the standalone
browser run, and retains the helper result plus those observations in its
block-specific control JSON. The generated-block proof then receives each file's
content hash; no version is inferred from the generated block itself.

The release checker will apply either exception only when the candidate supplies all
of the following: an observed WordPress version matching `7.1` inside the retained
control result, a retained control evidence path, and its exact
`sha256:<64-hex-digits>` hash. The declared version must match the version in that
file, and the generated proof must observe that same supported `7.1` version; a shell
variable or matching HTML snippet alone cannot establish it. It copies each control
file into the candidate receipt artifacts and records the path/hash in the
corresponding `acceptance.nativeHeadingControlEvidence` or
`acceptance.nativeParagraphControlEvidence` summary. A matching HTML snippet
without that immutable control reference is not sufficient.

## Boundary

- Keep the raw `accessibility_editor` finding as `fail`. Do not disable Axe rules,
  rewrite receipts, or claim that the full proof profile passed.
- The Heading exception covers only `aria-allowed-attr` and `aria-allowed-role` on
  the native Heading editing surface; the Paragraph exception covers only
  `aria-allowed-attr` on the native Paragraph editing surface. In both cases the
  retained native control must demonstrate the same failure.
- New findings, different affected elements, frontend failures, missing evidence,
  or missing manual review are not covered.
- Release reporting must say **accepted upstream editor exception**, link the raw
  generated-block and control evidence, and list any other incomplete gates.
- Recheck after a WordPress editor upgrade and before 1.0. Remove the exception
  when the native control passes; do not automatically carry it into another release.

The control collector also accepts a clean native Heading or Paragraph Axe result.
That is a successful control run, not an exception: when the native control is
clean, the generated block must pass its own editor accessibility gate. This keeps
a future WordPress fix from turning control collection into an artificial release
failure.

No other release criterion is waived by this decision.
