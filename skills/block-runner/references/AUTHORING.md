# Registered-block authoring — plan, preview, confirm, write, prove

This is §2 of the [agent guide](GUIDE.md). Read §0 and §1 there first to confirm a reusable
registered block is the requested artifact.

Use this path for one reusable `namespace/slug` block source package. The model interprets the
design into a semantic proposal; deterministic `author()` returns the canonical versioned
**`GeneratedAuthoringPlan`**, produces executable source, and serializes blocks. This is deliberately
different from converting a design into page `post_content`.

Registered-block authoring is available in 0.9.0. Use the project's installed version with
`npx --no-install block-runner`. An installed skill pins runtime commands to the version that
installed it; keep the compiler and guide aligned.

## The model's job: make a semantic proposal, never the implementation

For HTML, first call `collectSourceEvidence()` and send `AuthorOptions.proposal`: native structure
with its `sourceRef`s, fields, editability, locking, and reviewed source decisions. Make those
choices explicit, but do not manufacture ledgers, asset hashes, native CSS adapters, source hashes,
or mandatory warnings. `author()` owns them and returns the canonical `GeneratedAuthoringPlan`.
Inspection and validation need no consent; only the final canonical write identity needs it.

The proposal is declarative JSON only. Do **not** emit or ask the user to paste React, JSX, TSX,
PHP, `block.json`, generated CSS, `registerBlockType`, `register_block_type`, or `<!-- wp:… -->`
delimiters. The generator owns executable source and block serialization; the model owns the
reviewable semantic decisions.

## Primary HTML workflow: complete proposal → canonical plan

Read this proposal contract before the advanced complete-plan format in
[AUTHORING-PLAN.md](AUTHORING-PLAN.md). A proposal has only
these root keys: `structure` (required), and optional `fields`, `locking`, `allowedBlocks`,
`pattern`, and `sourceDecisions`. Do not put `version`, `generatorVersion`, `target`, `source`,
`coverage`, `styles`, `assets`, `files`, or `warnings` in it: `author()` derives and owns those
canonical-plan records.

Each `structure` node has required stable `id` and `block`, and optional `sourceRef`,
`attributes`, `lock`, and recursive `children`. A `sourceRef` is the exact opaque
`<source-sha256>:<start>-<end>` value returned by `collectSourceEvidence()` for this exact input;
never construct, shorten, reuse, or edit one. Bind source-content units to their matching native
block: headings to `core/heading`, paragraphs to `core/paragraph`, list items to
`core/list-item`, figures (or unwrapped images) to `core/image`, and standalone links to
`core/button`. Containers such as `section` and `div`, plus required wrappers such as
`core/buttons`, may use their source reference when they represent source structure. Synthetic
wrappers have an `id` and `block` but no `sourceRef`; use them only where native nesting requires
one, for example `core/buttons` around source-bound `core/button` children. Do not bind the same
source unit twice or bind overlapping content nodes.

`fields` are `{ id, label, mode, node?, attribute?, type?, default?, description? }`; `mode` is
exactly `fixed`, `editable`, or `override`. Point editable fields at the native node and attribute
they expose. Supported editing pairs are heading/paragraph/list-item `content`; image `id`,
`url`, `title`, `alt`, `caption`; and button `text`, `url`, `linkTarget`, `rel`.
`locking` is `{ mode: "all" | "contentOnly" | "insert" | "none", move?, remove?,
insert? }`; use a node's optional `{ move?, remove? }` `lock` for an individual node. `allowedBlocks`
is an optional direct-child insertion allowlist. `pattern` is optional
`{ ready, overrides: [{ field, label?, description? }] }` and refers to field IDs.

`sourceDecisions` are reviewed dispositions, never executable instructions:
`{ action: "add" | "replace" | "omit", sourceRef, node?, attribute?, value?, reason }`.
Every source-content unit must be bound or explicitly omitted with a reason. A replacement names
the exact bound `node` and `attribute`; an add describes proposal-owned material; an omission is
for a real source unit. Do not use a decision to hide an unconsumed source value.

Supported native source mappings include `figure > img + figcaption` owned together by one
`core/image` (`author()` derives and retains the image URL, valid source width and height, alt text, and caption), and `core/buttons > core/button` for
CTA links. An authored CSS grid is retained on its source-bound `core/group` when the native grid
mapping is supported. It is not a promise to convert arbitrary CSS grids into `core/columns`.
Node `label`, plus every complete-plan-only key listed above, belongs only to the advanced
`GeneratedAuthoringPlan` route and must not appear in a proposal.

This small public example uses only packed public imports. It derives source evidence, source
coverage, and the external image asset from the supplied HTML; it supplies no manual ledger,
asset, hash, adapter, or warning.

<!-- authoring-proposal-example:start -->
```js
import { author, collectSourceEvidence } from 'block-runner';

const html = `<style>.feature-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2rem; }</style>
<section><div class="feature-grid"><div><p>Release note</p><h2>Ship native editing</h2><p>Review the source trail before writing.</p><div><a href="/start">Start</a><a href="/docs">Read docs</a></div></div><figure><img src="https://cdn.example.test/editor.png" alt="Editor controls"><figcaption>Controls remain editable.</figcaption></figure></div></section>`;
const evidence = collectSourceEvidence(html);
const ref = (tag, occurrence = 0) => evidence.structure.filter((entry) => entry.tag === tag)[occurrence]?.sourceRef;
const report = await author(html, {
  author: { name: 'acme/feature-note', title: 'Feature note', styles: { mode: 'css' } },
  proposal: {
    structure: [{ id: 'feature', block: 'core/group', sourceRef: ref('section'), children: [
      { id: 'grid', block: 'core/group', sourceRef: ref('div', 0), children: [
        { id: 'copy', block: 'core/group', sourceRef: ref('div', 1), children: [
          { id: 'eyebrow', block: 'core/paragraph', sourceRef: ref('p', 0) },
          { id: 'title', block: 'core/heading', sourceRef: ref('h2') },
          { id: 'body', block: 'core/paragraph', sourceRef: ref('p', 1) },
          { id: 'actions', block: 'core/buttons', sourceRef: ref('div', 2), children: [
            { id: 'start', block: 'core/button', sourceRef: ref('a', 0) },
            { id: 'docs', block: 'core/button', sourceRef: ref('a', 1) },
          ] },
        ] },
        { id: 'image', block: 'core/image', sourceRef: ref('figure') },
      ] },
    ] }],
    fields: [{ id: 'title-content', label: 'Title', mode: 'editable', node: 'title', attribute: 'content' }],
    locking: { mode: 'contentOnly' },
  },
});
if (!report.ok || !report.package?.canonicalPlan) throw new Error('authoring proposal was rejected');
process.stdout.write(`${JSON.stringify(report.package.canonicalPlan, null, 2)}\n`);
```
<!-- authoring-proposal-example:end -->

Run it from a project with the packed package installed, then preview, obtain confirmation, and
write the exact canonical identity:

```bash
node author-proposal.mjs > feature-note.plan.json
npx --no-install block-runner author preview feature-note.plan.json --output-dir <exact-final-destination>
# Show the complete preview; obtain its full confirmation hash and explicit approval.
npx --no-install block-runner author write feature-note.plan.json --confirm '<full preview hash>' --output-dir '<exact-final-destination>'
```

## Advanced: complete `GeneratedAuthoringPlan` v1 shape

The complete plan format, its JSON example, and the styles, fonts, CSS and Tailwind rules live in
[AUTHORING-PLAN.md](AUTHORING-PLAN.md). It is an advanced compatibility route; the proposal workflow
above is primary.

## Preview the exact plan before asking

```bash
npx --no-install block-runner author preview authoring-plan.json \
  --output-dir <exact-final-destination>
```

`author preview` writes no files. Before requesting consent, lead with a compact plain-English
summary of editability, unresolved decisions/losses, style and asset ownership, and destination
changes. Then paste the literal plain-text terminal output verbatim. That summary supplements;
it never replaces or truncates the structure tree, `Warnings` section, exact touched paths,
replacement approvals, or full confirmation SHA-256. The user must see all of those details —
including the `Warnings` section when it says `- none`, and `No files written.`

Confirmation also binds the installed compiler template, which is shown in the preview.
After upgrading Block Runner, request a fresh preview and approval; an old confirmation
is not portable across compiler changes.

Only after showing that exact preview, ask a clear question such as: “Approve writing exactly
plan `<full hash>` to `<destination>`?” If replacements are listed, name them and obtain a
separate explicit replacement approval. A general “go ahead”, a changed plan, a changed
destination, or a changed destination fingerprint is not approval. The CLI is deliberately
non-interactive; it never obtains conversational consent for you.

## Write, then finish the delivery

After that exact approval, run:

```bash
npx --no-install block-runner author write authoring-plan.json \
  --confirm '<full preview hash>' \
  --output-dir '<exact previewed destination>'
```

Use the full hash and exact destination from the preview. If either changes, preview again and
obtain fresh consent. Do not write into `mktemp`, an auto-deleted staging folder, or an
unspecified location. The write report means **source delivered only**: it has not built,
activated, registered, rendered, or proved the block. Follow its displayed `plugin preview`
command for the existing-plugin or standalone boundary.

## Shipped notice: source to standalone ZIP

The shipped `authoring-plan.mjs` is a complete small consumer route. After installing the package,
run it from
`node_modules/block-runner/examples/authoring-plan.mjs`. Its authored source is:

```js
const html = '<section><h2>A native notice</h2><p>Review this message before publishing.</p><a href="/details">Read more</a></section>';
```

It proposes a native Group containing a Heading, Paragraph, and Buttons parent with a Button
child, with `locking: { mode: 'contentOnly' }`. Its explicit fields are the complete editing
contract; supplying a field list does not merge in other inferred fields.

| Source | Node / native attribute | Label | Choice |
| --- | --- | --- | --- |
| `A native notice` | `title / content` | Title | Editable |
| `Review this message before publishing.` | `message / content` | Message | Editable |
| `Read more` | `link / text` | Link text | Editable |
| `/details` | `link / url` | Link URL | Editable |

The `contentOnly` policy locks the template structure, while these native fields remain editable.
There is no implicit fixed field: to make a native field fixed, declare it as such. WordPress
applies `lock.edit` to a whole native node, so a fixed button text plus an editable button URL on
the same Button is rejected rather than silently presenting a misleading control.

The example writes only JSON on success, so the redirected file is the reviewed plan:

```sh
node node_modules/block-runner/examples/authoring-plan.mjs > notice.plan.json
npx --no-install block-runner author preview notice.plan.json --output-dir generated/notice
# Review the complete preview and copy its confirmation hash.
npx --no-install block-runner author write notice.plan.json \
  --confirm '<author-confirmation-from-preview>' --output-dir generated/notice

npx --no-install block-runner plugin preview generated/notice --standalone plugins/acme-notice
# Review the complete plugin preview and copy its separate fingerprint.
npx --no-install block-runner plugin write generated/notice --standalone plugins/acme-notice \
  --confirm '<plugin-fingerprint-from-preview>'

cd plugins/acme-notice
npm ci
npm run zip
npm run test:zip
```

The author confirmation binds the plan and source destination; the plugin fingerprint separately
binds the standalone wrapper destination. `npm run zip` produces `acme-notice.zip`, and
`npm run test:zip` checks its archive policy. Those checks establish reviewed source delivery and
a buildable archive, not WordPress activation, editor controls, saved-content reopening, or
frontend persistence.

To see stale confirmation protection, preview an empty destination, change the `link-text` label
in `notice.plan.json`, then attempt `author write` with the old confirmation. It fails with
`authoring confirmation does not match the reviewed plan and destination; no files written`.
Confirm the changed plan with a new preview before writing it. This exercise is intentionally
separate from the successful route above.

For a real-WordPress claim, prepare the reviewed source input, generated block markup, the ZIP,
and a real fixture that names this block's editable fields and required assertions. Install the
optional proof dependencies in [Proof is part of completion](#proof-is-part-of-completion) and use
a working Docker daemon, then run the applicable
`block-runner proof acme-notice.zip --profile <claim> --input <reviewed-source> --markup <generated-markup> --fixture <real-fixture>`
command. The notice plan does not declare pattern overrides, so do not use a pattern fixture or
claim pattern-override readiness for it.

## Existing-plugin output

Use this only after inspecting the target plugin. Do not guess its build or registration layout.

```bash
npx --no-install block-runner plugin inspect <plugin-root>
npx --no-install block-runner plugin preview <generated-block-dir> --host <plugin-root>
# Show this complete preview, then obtain its displayed fingerprint and any separate replacement approvals.
npx --no-install block-runner plugin write <generated-block-dir> --host <plugin-root> \
  --confirm '<plugin preview fingerprint>' \
  --approve-replace '<each explicitly approved path>'
```

Write the generated block directly below the existing plugin's lasting source directory, not a
temporary directory. If `plugin inspect` says the layout is unsupported, offer source-only delivery with a developer
handoff or standalone output. Keep the existing host profile conservative; do not improvise
registration or a build configuration as though the tool has verified it.

After that exact plugin write, source integration is delivered but no build or WordPress proof
has run. The report's next command is the host build:

```bash
cd <plugin-root> && npm run build
```

That produces the reviewed build target reported by `plugin preview`. Create the host's normal
installable ZIP after the build, then run the proof command below against that exact ZIP.

## Source for an existing project: developer integration

When the user wants source for a theme, shared bundle or another unsupported host, the source-only
route is a useful deliverable. Select a retained output directory together; it need not be an
active build entry. Use the same `author preview` and confirmed `author write` as above.

Read the generated file list, `block.json`, editor imports and style/asset references. Explain:

- Which source entry the developer needs to connect to the existing editor bundle.
- Which built JavaScript/CSS paths the metadata expects, and which assets/notices must be retained.
- Where the repository evidence points to PHP registration and build wiring, citing the files.
- Which paths or dependencies remain unresolved and what build/save/reopen checks have not run.

Use the host's established WordPress dependency handling; do not recommend bundling duplicate
WordPress runtimes. Register the built metadata directory: including a source registration file
without compiling its assets is insufficient. Do not output a guessed patch or an executable
command containing unresolved placeholders. This handoff is the agent's source-backed explanation,
not an additional Block Runner command or an automatic integration claim.

Deliver the source at the agreed location and the concrete handoff. Say **source delivered;
integration, build and WordPress proof remain unverified**. This completes a source-only request,
but does not complete a request for a working installed block. If the user has authorised manual
host integration, work within that scope and test it; do not claim the automatic profile supports
it or weaken the compiler to generate unsupported executable behavior.

## Standalone-plugin output

Use a retained, explicitly named plugin directory. Preview the wrapper before it is written,
then build the final plugin archive from that same directory.

```bash
npx --no-install block-runner plugin preview <generated-block-dir> \
  --standalone <retained-plugin-directory>
# Show this complete preview, then obtain its displayed fingerprint and any replacement approvals.
npx --no-install block-runner plugin write <generated-block-dir> \
  --standalone <retained-plugin-directory> \
  --confirm '<plugin preview fingerprint>'
```

After the exact write, the standalone source and its pinned lock are delivered; it is not built
or runtime-proven. Run the reported next command without hand-authoring React or PHP:

```bash
cd <retained-plugin-directory> && npm ci && npm run zip && npm run test:zip
```

`npm run zip` runs the generated `wp-scripts` build and creates the plugin ZIP; `npm run
test:zip` verifies its release contents. Those are build checks, not WordPress runtime proof.

## Proof is part of completion

Headless validation, source generation, or a successful build is not a full success claim. Build
the final plugin ZIP, then select the narrowest proof claim that matches the artifact. A full
proof is exhaustive; it is not the only credible claim for an artifact that does not promise
pattern overrides.
Real-WordPress proof is an explicit optional setup: install the exact proof tooling alongside the
same locally installed Block Runner version, then install Chromium yourself. This never triggers
a browser download or model call from the proof command:

```bash
npm install --save-dev --save-exact \
  /absolute/path/to/block-runner-0.9.0.tgz \
  @wordpress/env@11.12.0 \
  @playwright/test@1.61.1 \
  @wordpress/e2e-test-utils-playwright@1.51.0 \
  axe-core@4.11.0 \
  pixelmatch@7.1.0 \
  pngjs@7.0.0
npx --no-install playwright install chromium
```

A working Docker CLI and daemon are also required. If any proof package is absent or does not
match its pin, the proof receipt is blocked before Docker starts and gives the exact setup
command. After setup, run the locally installed CLI:

```bash
npx --no-install block-runner proof dist/acme-feature-grid.zip \
  --profile full \
  --input designs/feature-grid.html \
  --markup fixtures/feature-grid.blocks.html \
  --fixture fixtures/feature-grid.proof.json \
  --receipt-dir artifacts/proof
```

Name the proof claim in the result. `generated`, `built`, `editor-verified`, and
`fidelity-checked` establish progressively broader behavior. A hash-matched artifact that
declares `patternOverrides: false` does not require or claim pattern behavior for the
editor/fidelity claims. `pattern-verified` requires `patternOverrides: true` plus the complete
two-instance pattern fixture. `full` is exhaustive and includes the pattern, visual, and manual
review gates. `skip`, `blocked`, missing, or failed required gates mean the named claim remains
unproven; report it as incomplete rather than successful.

An automated receipt establishes only its named artifact and claim. A prepared owner session is
not a passed session, and an agent-assisted keyboard/screenshot review is not a human
accessibility certification. Keep owner visual, editing-feel, and manual-accessibility decisions
required until their hash-bound record exists; none of these records authorises publication.
