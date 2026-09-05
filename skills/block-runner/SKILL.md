---
name: block-runner
description: >-
  Turn WordPress page content or authored design HTML into valid, native, editable Gutenberg blocks,
  or plan a reusable named registered block for deterministic source generation. Use when creating
  WordPress page content or sections, converting authored HTML or a design-tool export into block
  markup, authoring a reusable named block in a WordPress plugin, validating or repairing Gutenberg
  markup, or before writing blocks to WordPress. Do not use for general WordPress administration,
  unrelated plugin or theme code, frontend-scraped HTML, or non-WordPress HTML.
license: GPL-2.0-or-later
compatibility: Requires Node.js 20+ and shell access. An uncached npx run requires npm registry access.
---

# Block Runner

Read `references/GUIDE.md` for the full contract. It is the same guide shipped in the npm
package.

## The short version

Four paths. Pick by the requested artifact:

- **You need a reusable, named registered block in code** → create a `GeneratedAuthoringPlan`, not
  source code. It records the block identity, design structure, editability and locking, style
  and asset outcomes, pattern overrides, final destination, and proof inputs. Run `author
  preview`, show the literal tree and every warning, ask for a clear confirmation, then run
  `author write` using that exact confirmation. Follow it through plugin packaging and a full
  proof. The deterministic generator, not the model, writes the executable source.

- **You are inventing the structure** → do not write HTML. Emit an intent tree (JSON
  describing which blocks and how they nest) and pipe it to
  `npx -y block-runner@latest assemble - --json`. Deterministic code builds the markup, so it
  cannot come out invalid. This is the best path and the one to reach for by default.
- **You have authored source HTML** → `npx -y block-runner@latest convert - --json`. The only
  path that carries CSS; use it when the styling matters (`--styling relaxed` is the default).
  Its result is page `post_content`, not a reusable source package.
- **You have block markup to check** → `validate` → `fix` → `validate`. Never save markup that
  is still invalid after `fix`.

## Rules that are easy to get wrong

- **A registered-block plan is declarative only.** Never emit React/JSX, PHP, a complete `block.json`,
  generated CSS, or `<!-- wp:… -->` delimiters in the plan or chat as a
  substitute for the generator. The model interprets the design and makes reviewable choices;
  deterministic code produces executable files. Safe native `block.json` fields belong in
  `target.metadata`; do not use that field for executable or file-loading capabilities.
- **Registered-block authoring is preview first.** `author preview` writes no files. Before
  asking, show the preview's terminal tree, destination, planned files, and warnings verbatim;
  then obtain a specific yes for its full confirmation hash. A changed design, plan, or
  destination needs a fresh preview and consent. The CLI never prompts for this itself.
- **Finish the job.** Page markup has to land where the user asked; source packages must land in
  their final plugin destination, never a temporary folder. For page content, write it where the user asked; or
  offer to write it through a WordPress connection if one is available; or show it to them
  with the paste instruction (**Options ⋮ → Code editor**, or `Ctrl+Shift+Alt+M` — pasting
  into the *visual* editor produces a mess). Never leave it in a temp file. See
  `references/GUIDE.md` §6.
- **Always pass `--json`.** Without it the report items are dropped and you will miss
  fallbacks, warnings, and source locations.
- **Never hand-write `<!-- wp:... -->` markup.** That is how invalid output happens. Describe
  structure instead and let `assemble` build it.
- **A `core/html` fallback is not a success.** It means that part is an uneditable blob. Check
  the report and tell the user.
- **If the CSS matters, use `convert`, not `assemble`.** An intent tree carries structure and
  content, not styling. Ask the user rather than silently flattening their design.
- **Do not claim a complete registered block without proof.** A full success requires the
  pattern-override gate and the real WordPress runtime/editor proof, with its receipt. A
  headless conversion check alone is not enough.
- **Passwords go in `--wp-app-password-env <NAME>`, never in argv.**
- **It is an assist, not a gate.** If the tool is unavailable, fall back to your own checks and
  say so — never block the user on it.

Block structure rules, the full node schema, per-section mappings, token and media resolution,
exit codes, and failure posture are all in `references/GUIDE.md`.
