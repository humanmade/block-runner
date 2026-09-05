# Authoring corpus contract

## Scope and isolation

This corpus evaluates authoring a registered WordPress block from a source
layout and an explicit authoring plan. It does **not** measure conversion of
arbitrary page markup into a page block tree. Do not merge its fixture count,
dimension results, or timings with `benchmarks/specs`.

The unit of measurement is `(fixture, source variant, runner/scorer, candidate
artifact, environment)`. A source variant can share a desired plan with another
variant, but it is still a separate input measurement.

## Input contract

Each fixture document supplies:

- an immutable `id`, `family`, `producer`, and `sourceStyle`;
- a source path whose bytes are hashed into the run record;
- a human prompt and an `expected-plan.json` design expectation that define the
  required editable result; this is not a canonical candidate plan;
- `requiredDimensions`, plus detailed per-dimension assertions;
- an `expectedStatus` describing the only successful terminal outcome.

The two producer styles are intentional: `semantic` represents structured,
hand-authored semantic input; `utility` represents utility/Tailwind-oriented
generated source. A runner may normalize source styles, but must preserve their
identity in results.

## Candidate artifact contract

A candidate starts as the production compiler's registered-block source package:
`block.json`, `index.js`, `edit.js`, `save.js`, `style.scss`, `editor.scss`, and
`block.php`, plus confirmed assets and audit files. It is not yet an installable
plugin. The worker must package those exact files through the production plugin
profile and retain the actual build, ZIP, and dependency lock before runtime proof.

The saved input is a canonical `AuthoringPlan` validated by the production schema.
The runner snapshots the fixture source and every declared source dependency
under the candidate before invoking a worker, so style and fidelity checks do
not read mutable files from the checkout.
The expected-plan files retain the fixture's intended design and editing contract;
they must never be substituted for candidate output. `style-decisions.json` records
the plan's choices; it is not evidence that every source declaration was accounted
for. The worker must supply and verify `style-ledger.json` against the source for
that claim. File locations and receipt fields are defined in
`candidate-contract.json`. Use fresh install directories and keep receipts under
`<run-root>/receipts`, separate from the candidate source.

Required proof uses WordPress **7.1**, the suite theme configuration, and the
named browser configuration in the run provenance. A candidate can adapt
style implementation, but must not evade a native-block assertion by dumping
the layout in `core/html` or a raw custom HTML field.

## Outcome model

Every fixture ends in exactly one terminal outcome:

| Outcome | Meaning | Dimension scores allowed? |
| --- | --- | --- |
| `scored` | Candidate was built and every required executable gate produced evidence. Individual dimension values may pass or fail. | Yes |
| `unsupported` | Fixture asks for a documented, intentionally unsupported capability and the candidate fails closed with its required warning. | No |
| `blocked` | A required external prerequisite was unavailable or not run (for example no WordPress/browser receipt). | No |
| `engine_error` | Runner/model/tool failed to produce a valid measurement. Includes timeout, malformed plan, process error, and lost receipt. | No |

`unsupported`, `blocked`, and `engine_error` are invalid measurements. They
must be counted separately in output and excluded from product figures. The
eleven dimensions are reported independently; this corpus has no fixture,
suite, or product composite score. A tool exception is never a zero product
score. An expected-negative
fixture passes only if its result is `unsupported` and its fail-closed assertion
is evidenced. A runner that emits an interactive implementation for that
fixture must report `scored` with a failed warning/source assertion (or an
`engine_error` if the run itself is unusable); it must not reinterpret it as an
unsupported pass.

## Receipts and comparability

The required receipt captures command, exit status, paths, timestamps,
environment hash, browser artifacts, and assertion outcomes. A missing editor,
frontend, pattern, accessibility, or fidelity receipt makes the run `blocked`.
Use the canonical timing method from `provenance.template.json`: monotonic wall
clock around each fixture from reading the saved plan through evidence retention,
before receipt serialization. It excludes prior model interpretation and receipt I/O.
Record no latency as a product figure unless that method is named.

Each publication must label every figure with workload (fixture IDs and source
variants), suite size, runner/model/effort, invalid count by terminal outcome,
and timing method. A figure without all five labels is not publishable.

Runtime provenance comes from retained observed inventories, not the suite's
requested environment. `dependencyHash`, `wordpressHash`, `themeHash`, and
`browserHash` identify those inventory artifacts. In an incomplete or refused
run they may be `null`; a scored receipt requires all four and their observed
versions/configuration. See the README for the worker inventory fields.
