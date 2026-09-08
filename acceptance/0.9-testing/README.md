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
export CANDIDATE_CHECKOUT="$PWD"
export EVIDENCE=/absolute/path/to/evidence
mkdir -p "$EVIDENCE"
node acceptance/0.9-testing/prepare-inputs.mjs --check
node acceptance/0.9-testing/prepare-inputs.mjs \
  --output "$EVIDENCE/inputs" \
  --candidate-revision "$(git rev-parse HEAD)"
```

The staged layout preserves each input's relative CSS and asset references and
writes `input-receipt.json`. Pack the CLI and use the packed tarball and its
shipped skill in a clean consumer project. Retain the tarball and its hash; do
not analyse from this checkout after staging.

```sh
mkdir -p "$EVIDENCE/package" "$EVIDENCE/consumer"
npm pack --pack-destination "$EVIDENCE/package"
cd "$EVIDENCE/consumer"
npm init -y
npm install --ignore-scripts --save-exact "$EVIDENCE/package/block-runner-0.9.0.tgz"
npx --no-install block-runner skill --install --dir .agents/skills
```

The two inputs use the prepared semantic proposals in [`author-input.mjs`](./author-input.mjs).
Copy that script into the clean consumer so its public `block-runner` import resolves the
installed tarball. The script prints the complete analysis JSON and exits nonzero if no
canonical plan is produced. It does not write generated source.

The SVG proposal explicitly permits reads beneath the staged `sources/` directory because
its image is a sibling of `semantic/`. The responsive proposal uses native Groups for the
CSS grid, supplies the linked compiled CSS, and opts into `foundation: 'component'`: the
universal reduced-motion rule is contained within this block. This is a deliberate scope
change, recorded in the plan's warnings, not a claim of page-wide equivalence. Neither
source file is rewritten, no Tailwind compiler runs, and no content is omitted.

```sh
export BLOCK_RUNNER="$EVIDENCE/consumer/node_modules/.bin/block-runner"
cp "$CANDIDATE_CHECKOUT/acceptance/0.9-testing/author-input.mjs" "$EVIDENCE/consumer/author-input.mjs"

for journey in local-asset-feature responsive-panel-grid; do
  mkdir -p "$EVIDENCE/$journey"
  (
    set -e
    cd "$EVIDENCE/$journey"
    node "$EVIDENCE/consumer/author-input.mjs" "$journey" \
      "$EVIDENCE/inputs/$journey/benchmarks/authoring/sources" > analysis.json
    node --input-type=module -e '
      import { readFile, writeFile } from "node:fs/promises";
      const report = JSON.parse(await readFile("analysis.json", "utf8"));
      if (!report.ok || !report.package?.canonicalPlan) throw new Error("No canonical plan in analysis report");
      await writeFile("authoring-plan.json", `${JSON.stringify(report.package.canonicalPlan, null, 2)}\n`);
    '
    "$BLOCK_RUNNER" author preview authoring-plan.json --output-dir "$PWD/generated" > preview.txt
  ) || break
done
```

`npm run smoke:package` exercises these same prepared proposals with staged input bytes in a
clean packed consumer, then confirms and writes each source package. It checks the copied SVG,
editable alternative text, grid-item span, responsive breakpoints, reduced-motion CSS and the
containment warning. That automated check does not record an owner review or WordPress result.

Show the complete preview. Only after the owner authorises its exact hash, run
`author write` with that hash and exact destination. Then use `plugin inspect`,
`plugin preview`, and `plugin write` against a supported existing-plugin target
(with separately approved replacements), build its normal ZIP, and invoke
`proof --profile fidelity-checked` with the hash-matched artifact contract and a fixture whose
editable fields and visual baseline were created for that generated package. These two proposals
do not declare pattern overrides; the shared pattern fixture supplies that separate full-profile
exercise. Retain the owner’s manual review alongside each journey. Source
generation alone is not an installable-plugin claim. Record corrections to the
plan as corrections, not as if they had been in the original input.

The runtime proof cannot be prefilled from this manifest: its fixture must bind
the generated block name/markup, editable inventory, artifact capabilities, and
reviewed golden to the final ZIP. Until those inputs
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
