# Registered-block authoring benchmark

This is a **separate** corpus for the product claim “an authoring plan can be
turned into a registered, editable WordPress block”. It is not an extension of
the HTML-to-page-block conversion benchmark in `benchmarks/`; its results must
never be averaged with that suite or used as a substitute for it.

The 0.9 release set contains 13 fixtures across nine authoring families. The
four structural families have independent semantic and utility/Tailwind source
variants. A fixture is a question with a known contract, not a pre-recorded
pass: browser, editor, build, and visual results must come from a run receipt.
Missing receipts are `blocked`, not passes.

## Layout

```
authoring/
  suite.json                 # suite identity, required environment, hash inputs
  fixtures.json              # machine-readable index and assertions
  fixtures/<id>/             # one prompt and expected editable plan per fixture
  sources/{semantic,utility}/ # independent producer/source-style inputs
  sources/assets/            # local fixtures that must be preserved by the output
  contract.md                # candidate artifact and outcome contract
  candidate-contract.json    # JSON form of the output/receipt contract
  release-matrix.json        # 0.9 package/skill/activation combinations to retain
  provenance.template.json   # required run-record fields and independent hashes
  schema.json                # constrained fixture-document schema
```

## What a run measures

Every scored fixture evaluates these dimensions independently. There is no
composite authoring score in this corpus:

| Dimension | Evidence |
| --- | --- |
| `plan` | plan is typed, ordered, editable, and names registered blocks |
| `source` | generated source has the expected file contract and imports |
| `native` | native/registered blocks are used where the plan requires them |
| `style` | style ledger maps declarations to editor/theme/plugin ownership |
| `warnings` | limitations are explicit and machine-readable |
| `build` | package build and lint/type gates produce the declared artifacts |
| `editor` | a WordPress editor can insert, edit, save, and reload the block |
| `frontend` | saved markup renders without editor-only failures |
| `pattern` | patterns and overrides preserve allowed customization boundaries |
| `fidelity` | a named browser capture/metric compares to the fixture reference |
| `accessibility` | required semantic and keyboard checks pass |

`unsupported`, `blocked`, and `engine-error` are measurement outcomes, not
zeroes. Only `scored` can contain dimension scores. See `contract.md` for the
closed status model and `provenance.template.json` for the hashes that make a
record comparable.

## Use

`npm run authoring:prove` reads `fixtures.json`, materializes the
candidate into a fresh plugin workspace, then write an immutable receipt per
fixture under its run directory. It must hash the source bytes, prompts,
template, scorer, dependency lockfile, WordPress/theme install, and browser
configuration before publishing results. It may report a visual or browser
gate only when the matching receipt exists.

The isolated fixture executable is configured with
`BLOCK_RUNNER_AUTHORING_RUNNER`. It is invoked once per fixture with the fresh
candidate directory, WordPress 7.1, theme configuration, browser viewport, and
an output-result path. It must build/install the generated plugin and run the
editor, front-end, pattern, fidelity, and accessibility gates. Its JSON result
names candidate-relative evidence files for every check; the harness copies and
SHA-256 verifies them before accepting the receipt. A missing executable or a
missing result/evidence file is recorded as `blocked`, never as a pass.

The `unsupported-interaction` fixture is intentional. Its interaction asks for
a capability the registered-block contract does not support. Passing means the
runner refuses to emit a fake interactive block, emits the prescribed warning,
and records `unsupported`; trying to silently ship JavaScript or treating the
fixture as a zero-point product failure is a failure of the suite contract.

The release package/skill/activation matrix is declarative in
`release-matrix.json`. Its `pending` state is deliberate: only executed checks
with receipts can become `passed` in a release record.
