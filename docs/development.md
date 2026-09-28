# Development and verification

Work from a repository checkout on a supported Node version:

```sh
npm ci
npm run build
```

Choose checks based on the change. Ordinary conversion uses the bundled headless Gutenberg runtime; real-WordPress proof has additional prerequisites. See the [proof requirements](reference.md#wordpress-proof-requirements) before running browser or Docker checks.

## Testing workflow

For ordinary changes, run the focused affected tests first:

```sh
npx vitest run <affected files>
```

For changes to proof startup or publication recovery, run:

```sh
npx vitest run dev/test/proof-control-setup.test.ts dev/test/proof.test.ts dev/test/publication.test.ts dev/test/publication.public-api.test.ts
npm run typecheck
```

`npm run verify` remains the required repository gate. It runs the deterministic repository
suite.

CI classifies both pull-request and main-push changes with [`scripts/ci-scope.mjs`](../scripts/ci-scope.mjs). Additions or modifications limited to its root-documentation/demo allowlist use the docs route; eligible shipped-skill changes use the skill route. Runtime, package, proof, workflow, release and unclassified paths use the full route. Deletions, renames and unavailable diffs cannot select a reduced route. New `docs/` files are currently unclassified, so they select full CI.

Run `npm run test:consumer` separately to build the clean standalone release archive and
the native style-adapter fixture; it needs npm, `unzip`, and enough time for an isolated
`npm ci` and two ZIP builds.

Run `npm run build && npm run test:package`
when changing exports, packed files, dependency pins, or consumer behavior. The full CI and
release matrix run both repository and consumer suites.

Run
`npm run test:proof:wordpress` for proof-runner, browser, emitted-editor layout, persistence,
or pattern changes; it requires Docker. Run the opt-in `npm run test:proof:mutations` only when
detector wiring changes, and run the existing release check only for release candidates or release
automation. Do not relax the visible mutation skips, runtime-proof gates, thresholds, or the
intentional `fileParallelism: false` Gutenberg serialization.

The consumer suite owns these archive assertions: `standalone consumer release archive > resolves,
clean-installs, builds, and inspects the actual release archive` in
`plugin.consumer.test.ts`, and `native style adapter proof fixture > retains and pins the public
utility hero package with authored image sizing` in
`proof-native-style-adapter-builder.test.ts`.

## Historical conversion results

The [README chart](../README.md#benchmark) is **historical conversion evidence**, not an authoring result. Its workload is 63
fixed HTML sections per lane (11 serial lanes, 693 conversions); the suite, models/low effort,
per-lane invalid counts, and monotonic serial timing method are labelled in the
[benchmark report](https://github.com/humanmade/block-runner/blob/main/dev/benchmarks/presentation/figures.html). Each model gets the same fixture in two
lanes: **Direct** writes Gutenberg markup itself; **Block Runner** returns an intent tree that the
package assembles and validates. The dashed line is the deterministic rules converter running
without an LLM. Every result is scored from 0 to 100 against the fixture's accepted block tree.

The separate [registered-block authoring corpus](https://github.com/humanmade/block-runner/blob/main/dev/benchmarks/authoring/README.md)
remains unscored. This image does not measure generated plugins, editor persistence or authoring
quality. Required package and WordPress release proof are separate from either benchmark.

## Running the benchmark

A conversion benchmark lives under `dev/benchmarks/`: it measures how faithfully real generator
output (Impeccable, Codex, Claude, and more) converts to native blocks, across swappable
converters (the built-in rules, plus experimental LLM translators run via their CLIs).

```sh
npm run bench          # score the suite; write dev/benchmarks/presentation/review.html + dev/benchmarks/presentation/scoreboard.html
npm run bench:record   # also append a provenance-tagged run to dev/benchmarks/results.jsonl
```

Runs are recorded with `engine` / `model` / `effort` / `suiteHash`, so older engines stay
backtestable against the current suite (`scripts/backtest.sh`). See [dev/benchmarks/README.md](../dev/benchmarks/README.md)
for adding producers and engines.

The registered-block authoring corpus is deliberately separate from that conversion suite:

```sh
npm run authoring:prove -- --plans ./candidate-plans
```

This requires saved canonical candidate plans and the configured WordPress runtime worker; see
[the corpus README](../dev/benchmarks/authoring/README.md). Without them it reports blocked work, not a benchmark result. It does
not turn unrun browser/editor work or a model/tool failure into a zero product score. The 0.9
package, installer, and activation checks are run with `npm run release:check`;
see [`dev/release/0.9-testing`](https://github.com/humanmade/block-runner/blob/main/dev/release/0.9-testing/README.md) for the receipt matrix and the
draft product-preview brief.

## WordPress and Gutenberg compatibility probe

The development compatibility suite builds the existing pattern-override plugin once,
then installs the same ZIP in three sequential, isolated PHP 8.3 environments:
WordPress 7.1; WordPress 7.1.2; and WordPress 7.1.2 with Gutenberg 24.0.0.
It uses ports 8891–8893 and refuses to claim an already-running lane.

```sh
npm ci
npx --no-install playwright install chromium
BLOCK_RUNNER_COMPAT_OUTPUT_DIR=/tmp/block-runner-compat \
  npx --no-install vitest run --config vitest.gutenberg-compat.config.ts
```

Use a fresh output directory for each run. Without that variable, the suite creates
an isolated temporary directory and prints its path. `compatibility.json` records the
ZIP, input and generated-template hashes plus each lane's result. Each lane retains
`receipt.json` (versions and command output), `browser-result.json` (editor states,
frontend checks and pattern isolation), and browser screenshots/trace under `artifacts/`.
Build or runtime failures retain failure evidence and fail the suite; they are not skips.
On macOS, use OrbStack and check the effective Docker endpoint before running it.

This is a development compatibility observation, not the public WordPress 7.1 release
receipt or manual acceptance. It compares child trees immediately after insertion and
after save/reopen, exercises bundled media and a supported field edit, and reuses the
existing two-instance pattern-override lifecycle. Browser console warnings remain
visible, including Gutenberg's expected template-prop deprecation. No model calls or
collaborative-editing server are involved.
