# 0.9 testing-release gate

This directory is the release record for the registered-block authoring preview.
It is deliberately separate from the HTML-to-page-block benchmark: a page-block
score is not evidence about authoring plans, generated source, editor persistence,
plugin packaging, pattern overrides, or a generated plugin's runtime.

`0.9.0` is a **testing release**, not a 1.0 compatibility promise. Publish it only
when every required row in [`matrix.json`](./matrix.json) has a receipt matching its
expected state in the release candidate. `1.0.0` remains contingent on real-project feedback and on
resolving every release-relevant failure discovered during that feedback.

## Required release commands

Run these against the exact release-candidate commit and package version. Do not
replace any command with an equivalent-looking local check: the command, artifact,
and environment in its receipt are the evidence.

```sh
npm run authoring:prove
npm run release:check
```

`authoring:prove` is the canonical full authoring suite and WordPress 7.1 proof.
It must exercise every release fixture in the registered-block authoring corpus,
including the expected-negative unsupported-interaction fixture. `release:check`
runs the package, skill, installer, generated-plugin ZIP activation, and artifact
checks defined in the matrix. `npm run verify` and `npm run pack:check` are retained
as named rows because a wrapper's success must not erase their individual receipts.

A run is releasable only when the proof has completed and all of the following are
true:

- Every required matrix row reaches its expected release status (`passed`, except
  the declared expected-negative row, which is `unsupported`); no row is assumed
  from a previous commit.
- The full WordPress 7.1 proof passed for the release fixture set: generation,
  generated-plugin build, install/activation, editor insert-edit-save-reopen,
  front-end render, pattern override, visual/fidelity, and accessibility gates.
- The expected-negative unsupported-interaction fixture is `unsupported` and fails
  closed; a generated best-effort interaction or a silent omission fails the gate.
- `npm run verify`, `npm run pack:check`, canonical skill validation, installer
  smoke, and generated plugin ZIP activation all passed from the candidate.
- No measurement is `engine_error` or `blocked`. Model/tool errors invalidate that
  measurement; they are never recorded as zero product points.
- The corpus provenance and every release artifact hash are present in the receipts.

An unrun browser, visual, accessibility, editor, front-end, or activation gate is
`blocked`/`pending`, not a pass. A `skipped` field or missing receipt is likewise
not evidence of success.

The release environment supplies two executable paths, not shell fragments:
`BLOCK_RUNNER_AUTHORING_RUNNER` for each authoring fixture and
`BLOCK_RUNNER_WP_ZIP_ACTIVATION_RUNNER` for ZIP activation. The latter receives
the generated ZIP, expected WordPress version, expected registered block, result
path, and log directory. It must return proof of WordPress 7.1, activation,
editor-visible registration, and clean logs; exit status alone is insufficient.

## Matrix and receipts

[`matrix.json`](./matrix.json) defines each required package, skill, and activation
row and the command that produces it. [`receipt.schema.json`](./receipt.schema.json)
defines one immutable JSON receipt per command invocation. Store completed receipts
outside the source tree's template directory (for example, release CI artifacts)
and reference them from the candidate release record. Never overwrite a receipt;
repeat a row with a new `receiptId` and link it with `supersedes`.

The receipt must bind the result to:

- candidate commit, package version, npm tarball hash, generated ZIP hash, and
  command stdout/stderr hashes;
- suite, scorer, prompt/guide, template, dependency, WordPress, theme, and browser
  hashes, plus fixture manifest and generated-source hashes where applicable;
- OS, Node/npm, WordPress 7.1, theme, browser/driver, test time, timeout, and the
  timing method;
- result state, gate-level outcomes, warnings, invalid-measurement reason, and links
  to retained logs/screenshots/editor/front-end artifacts.

## Measurement states

The authoring benchmark emits a **measurement state** separately from a release-row
status. This keeps a real score distinct from a deliberate unsupported result and
from a measurement that never became valid.

| Measurement state | Meaning | Scoring treatment |
| --- | --- | --- |
| `scored` | A supported fixture completed its assertions and produced dimension scores. | Eligible for reporting. |
| `unsupported` | A documented unsupported capability failed closed. | No product score; passes only an expected-negative fixture. |
| `blocked` | A required environment or dependency was unavailable. | No score; blocks release. |
| `engine_error` | Model, harness, tool, timeout, or infrastructure failed. | Invalid measurement, never a zero score. |

The receipt's **release status** then records whether its matrix row passed, failed,
was blocked, or was invalid:

| State | Meaning | Release treatment |
| --- | --- | --- |
| `passed` | The required assertion ran and passed. | Eligible only with a complete receipt. |
| `failed` | The product assertion ran and failed. | Blocks the testing release. |
| `unsupported` | The fixture requests a documented unsupported capability and failed closed. | Passes only for an expected-negative assertion. |
| `blocked` | The gate did not run because its required environment/dependency was unavailable. | Blocks; never reported as a pass. |
| `engine_error` | Model, harness, tool, timeout, or infrastructure failure made the measurement invalid. | Invalid measurement; rerun, never score as zero. |
| `pending` | Not yet attempted. | Blocks. |

`unsupported` is a fixture outcome, not a score. The only expected unsupported fixture
in the release set is `unsupported-interaction`; any other use requires a documented
fixture capability and a review of the suite contract.

## Product-preview and public copy

[`claims.template.md`](./claims.template.md) is the only source for measured 0.9
figures while the release is being prepared. A claim is not current merely because a
test plan exists: it becomes current only after the release fixture set passes and
its linked receipts are complete. Every published figure—README, website, release
notes, demo caption, or product-preview brief—must name its workload, suite size,
model and effort, invalid-measurement count, and timing method. It must link to the
receipt set and say whether the figure is a fixture result or real-project feedback.

Do not combine this suite's results with the 63-fixture page-block benchmark. They
measure different products and remain independently reported.
