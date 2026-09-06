# 0.9 owner-acceptance inputs

This directory prepares the two bounded workflows from issue #54. It is not
an authoring benchmark, a release receipt, or evidence that a real-project
journey has passed. The two inputs are project-authored fixtures committed in
`af0808f`; their exact bytes and repository licence are recorded in
[`inputs.json`](./inputs.json).

The fixture pair deliberately separates the risks that need to be seen in an
ordinary session: the semantic feature carries a checked local SVG and
alternative text; the utility-CSS feature carries the 1/2/4-column responsive
rules and reduced-motion treatment. Neither fixture is presented as an
unfamiliar external design. A later real-project input must be supplied and
licensed explicitly before making that claim.

## Prepare one candidate

Start from a fresh checkout of the candidate and record its full Git revision;
the preparation revision in `inputs.json` is not a release-candidate claim.
Before any analysis, use the small staging harness below. It checks the pinned
source bytes and refuses to overwrite an evidence directory:

```sh
node acceptance/0.9-testing/prepare-inputs.mjs --check
node acceptance/0.9-testing/prepare-inputs.mjs \
  --output /absolute/path/to/evidence/inputs \
  --candidate-revision "$(git rev-parse HEAD)"
```

The staged layout preserves each input's relative CSS and asset references and
writes `input-receipt.json`. Pack the CLI and use the packed tarball and its
shipped skill in a clean consumer project. Retain the tarball and its hash; do
not analyse from this checkout after staging.

```sh
mkdir -p /absolute/path/to/evidence/package /absolute/path/to/evidence/consumer
npm pack --pack-destination /absolute/path/to/evidence/package
cd /absolute/path/to/evidence/consumer
npm init -y
npm install --ignore-scripts --save-exact /absolute/path/to/evidence/package/block-runner-0.9.0.tgz
npx --no-install block-runner skill --install --dir .agents/skills
```

For each journey, run analysis with the packed CLI and save the whole JSON
report before extracting `package.canonicalPlan`. Keep plans in the evidence
directory and invoke the packed binary by absolute path: `author preview` and
`author write` intentionally accept only safe, relative plan paths. The
responsive input has a linked stylesheet, so create a consumer-local
configuration that supplies the staged `tailwind-responsive.css` as
`author.styles.css` with `author.styles.mode: 'css'`; it is compiled CSS, not
permission to run a Tailwind project. The local-asset journey needs no
stylesheet configuration.

```sh
# Set these after installing the packed tarball.
export EVIDENCE=/absolute/path/to/evidence
export BLOCK_RUNNER="$EVIDENCE/consumer/node_modules/.bin/block-runner"

# Journey 1: local SVG. Run from the journey directory so the plan path is safe and relative.
mkdir -p "$EVIDENCE/local-asset-feature"
cd "$EVIDENCE/local-asset-feature"
"$BLOCK_RUNNER" author \
  "$EVIDENCE/inputs/local-asset-feature/benchmarks/authoring/sources/semantic/local-assets.html" \
  --name block-runner/asset-feature --json > analysis.json

# Journey 2: retain compiled CSS explicitly; do not run Tailwind or load its config.
mkdir -p "$EVIDENCE/responsive-panel-grid"
node --input-type=module -e '
  import { readFile, writeFile } from "node:fs/promises";
  const css = await readFile(process.argv[1], "utf8");
  await writeFile(process.argv[2], `${JSON.stringify({ author: { styles: { mode: "css", css } } }, null, 2)}\\n`);
' "$EVIDENCE/inputs/responsive-panel-grid/benchmarks/authoring/sources/utility/tailwind-responsive.css" \
  "$EVIDENCE/responsive-panel-grid/block-runner.config.mjs"
cd "$EVIDENCE/responsive-panel-grid"
"$BLOCK_RUNNER" author \
  "$EVIDENCE/inputs/responsive-panel-grid/benchmarks/authoring/sources/utility/tailwind-responsive.html" \
  --name block-runner/responsive-panel-grid --config block-runner.config.mjs --json > analysis.json

# Run this in each journey directory after analysis. It stops if no usable canonical plan was produced.
node --input-type=module -e '
  import { readFile, writeFile } from "node:fs/promises";
  const report = JSON.parse(await readFile(process.argv[1], "utf8"));
  if (!report.ok || !report.package?.canonicalPlan) throw new Error("No canonical plan in analysis report");
  await writeFile(process.argv[2], `${JSON.stringify(report.package.canonicalPlan, null, 2)}\\n`);
' analysis.json authoring-plan.json
"$BLOCK_RUNNER" author preview authoring-plan.json --output-dir "$PWD/generated" > preview.txt
```

Show the complete preview. Only after the owner authorises its exact hash, run
`author write` with that hash and exact destination. Then use `plugin inspect`,
`plugin preview`, and `plugin write` against a supported existing-plugin target
(with separately approved replacements), build its normal ZIP, and invoke
`proof --profile full` with a fixture whose editable fields, visual baseline,
and manual-review scope were created for that generated package. Source
generation alone is not an installable-plugin claim. Record corrections to the
plan as corrections, not as if they had been in the original input.

The full proof cannot be prefilled from this manifest: its fixture must bind
the generated block name/markup, editable inventory, pattern assertions,
reviewed golden, and manual-review file to the final ZIP. Until those inputs
exist, `proof` is correctly blocked rather than runnable evidence.

The standard proof fixture may be used for the shared pattern and regeneration
exercises named in `inputs.json`; it does not replace either of these supplied
design journeys. Keep raw proof failures and the narrow 0.9 native-control
exception visible under the existing release policy.

## Owner session

Prepare the candidate and access instructions before asking the owner to join.
The owner should spend about 20–30 minutes on the remaining judgement:

1. Inspect each block in the normal editor: its fixed structure, editable
   fields, local asset handling, and the responsive layout controls.
2. Save, reopen, and inspect the frontend at the relevant widths; decide
   whether the visual result and editing feel are acceptable.
3. Review the retained accessibility result and any unresolved diagnostics.

Only the owner can authorise confirmation/replacement decisions and make the
visual, editing-feel, and manual-accessibility judgements. Those decisions must
remain `required` or `blocked` until a hash-bound record is retained; an agent
must not mark them passed.

## Later fixes

For a source or style change after preparation, rerun the affected journey's
generation/build/proof checks and the applicable shared integration exercise.
Repeat the owner session only when the edited behaviour can affect visual
fidelity, editing feel, accessibility judgement, or the approved confirmation
surface; otherwise explain why the retained owner evidence still applies.
