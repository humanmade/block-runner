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

`unsupported`, `blocked`, and `engine_error` are measurement outcomes, not
zeroes. Only `scored` can contain dimension scores. See `contract.md` for the
closed status model and `provenance.template.json` for the hashes that make a
record comparable.

## Use

`npm run authoring:prove -- --plans /absolute/path/to/saved-plans` reads
`fixtures.json` and requires a canonical `AuthoringPlan` in `<fixture-id>.json`
for every candidate. It runs the production source compiler, including its
confirmed assets and declared source dependencies, into a fresh workspace.
Expected plans are scoring contracts; they are never copied in as candidate
answers. The runner never calls a model. A supplied `--fixture <id>` runs one
fixture for a focused check; it does not change the suite identity in the
receipt.

Omitting `--plans` is a deterministic prerequisite audit: it writes one
`blocked` receipt per fixture and exits non-zero. Supplying plans without a
worker compiles the candidates and then records the missing WordPress/browser
runtime as `blocked`. Neither mode is an LLM benchmark or a product score.

The candidate contains the compiler's seven root-level source files, confirmed
assets, an immutable snapshot of the declared source inputs, and audit
manifests. It is not yet a plugin ZIP. Its style decisions do not replace the
worker's source-declaration coverage ledger. The worker must package and prove
the exact generated source; see `candidate-contract.json`.

The runtime worker then writes an immutable receipt per fixture under its run
directory. It must hash the source bytes, prompts,
template, scorer, dependency lockfile, WordPress/theme install, and browser
configuration before publishing results. It may report a visual or browser
gate only when the matching receipt exists.

The isolated fixture executable is configured with
`BLOCK_RUNNER_AUTHORING_RUNNER`. It is invoked once per fixture with the fresh
candidate directory, WordPress 7.1, theme configuration, browser viewport, and
an output-result path. It must build/install the generated plugin and run the
editor, front-end, pattern, fidelity, and accessibility gates. Its JSON result
names candidate-relative evidence files for every check; the harness copies and
SHA-256 verifies them before accepting the receipt. No configured worker means
`blocked`. A configured worker that crashes, times out, or returns unusable
results is an `engine_error`, never a product score. The worker has an
eight-minute execution limit per fixture. Receipts are saved after each fixture,
so a later failure does not discard earlier evidence.

Runtime hashes identify retained observations, not the requested configuration.
A scored receipt requires these JSON artifacts from the worker:

| Artifact key | Required content |
| --- | --- |
| `dependencyLock` | Resolved candidate package-lock with its dependency tree |
| `dependencyInventory` | `lockSha256` matching that lock plus installed `packages` with `name` and `version` |
| `wordpressInventory` | Observed 7.1 `version`, `coreHash`, and installed `plugins` |
| `themeInventory` | Observed `slug`, `version`, and full `configuration` matching the fixture theme |
| `browserInventory` | Observed Chromium `name` and `version`, 1440×1024 `viewport`, and `deviceScaleFactor: 1` |

The top-level run hashes describe suite requirements; per-fixture provenance
holds the observed runtime hashes. Unobserved runtime values remain `null`.
Free-form worker environment labels cannot substitute for these artifacts.

The `unsupported-interaction` fixture is intentional. Its interaction asks for
a capability the registered-block contract does not support. Passing means the
runner refuses to emit a fake interactive block, emits the prescribed warning,
and records `unsupported`; trying to silently ship JavaScript or treating the
fixture as a zero-point product failure is a failure of the suite contract.
The production compiler's explicit executable-behavior refusal can satisfy
this negative case without running WordPress. Its diagnostic and rejected plan
are retained, and no source package is emitted. A malformed plan or missing
asset is an engine error, not an unsupported-interaction pass.

The package/skill/activation matrix in `release-matrix.json` is benchmark-only
and optional for the deterministic 0.9 testing-release gate. Its `pending` state
is deliberate: only explicitly executed checks with receipts can become
`passed` in a benchmark record. The required deterministic release matrix lives
in `release/0.9-testing/matrix.json`.

## Corpus integrity

`node --import tsx scripts/authoring-hashes.ts --check` checks every recorded
corpus hash with the scorer's exact algorithm. Without `--check`, the command
prints a replacement `hashes.json`; it does not write files or execute fixtures.
Changing prompts, contracts, fixture expectations, or source bytes invalidates
the old corpus identity. Keep old receipts with their original identity.
