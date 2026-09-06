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

Work from the revision pinned in `inputs.json`, or update that revision and all
input hashes together. Pack the CLI and use the packed tarball and its shipped
skill in a clean consumer project. Copy the input HTML and its listed local
dependencies into the candidate evidence directory before analysis; retain the
copy and hash, not merely a path back to this checkout.

For each journey, follow the shipped guide's sequence: `author` analysis,
save the canonical plan, `author preview`, obtain an explicit confirmation for
the displayed hash, `author write`, `plugin preview/write`, build the plugin
ZIP, then run the applicable `proof` profile. Source generation alone is not
an installable-plugin claim. Record corrections to the plan as corrections,
not as if they had been in the original input.

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
