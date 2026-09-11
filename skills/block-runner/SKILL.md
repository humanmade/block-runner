---
name: block-runner
description: >-
  Turn WordPress page content or authored design HTML into valid, native, editable Gutenberg blocks,
  or plan a reusable named registered block for deterministic source generation. Use when creating
  WordPress page content or sections, converting authored HTML or a design-tool export into block
  markup, authoring a reusable named block in an existing WordPress project, understanding its
  block integration before generation, validating or repairing Gutenberg
  markup, or before writing blocks to WordPress. Do not use for general WordPress administration,
  unrelated plugin or theme code, frontend-scraped HTML, or non-WordPress HTML.
license: GPL-2.0-or-later
compatibility: Requires Node.js ^20.19.0 || ^22.13.0 || >=24.0.0 and shell access. An uncached npx run requires npm registry access.
---

# Block Runner

## Start with the user's project

For a component that belongs in an existing project, read `references/GUIDE.md` §0 before
choosing an output, and `references/CONSTRUCTION-PATTERNS.md` to choose an implementation route
and inspect its contracts. Use relevant source and site context to recommend reuse, supported
generation or a developer handoff. Recognizing a route does not add generator support. Ask only
for choices that the request and repository do not answer; use structured questions if your
harness supports them, otherwise ask in plain language. Skip discovery for a self-contained
markup check or when the relevant project facts are already established.

## The short version

Pick by the requested artifact:

- **You need a reusable, named static registered block in code** → read `references/GUIDE.md` §2.
  For authored HTML, submit a declarative `AuthorOptions.proposal`, then run `author preview`, show
  its literal tree and warnings, obtain confirmation for its exact hash, and run `author write`.
  The deterministic generator writes executable source; follow the agreed source-only or plugin
  delivery route and name the proof it has not established. The complete `AuthorOptions.plan` is an
  advanced compatibility route.

- **You are inventing the structure** → do not write HTML. Emit an intent tree (JSON
  describing which blocks and how they nest) and pipe it to
  `npx -y block-runner@latest assemble - --json`. Deterministic code builds the markup, so it
  cannot come out invalid. This is the best path and the one to reach for by default.
- **You have authored source HTML** → `npx -y block-runner@latest convert - --json`. The only
  path that carries CSS; use it when the styling matters (`--styling relaxed` is the default).
  Its result is page `post_content`, not a reusable source package.
- **You have block markup to check** → `validate` → `fix` → `validate`. Never save markup that
  is still invalid after `fix`.

## Generator boundary and continuation

- **A generated registered-block plan is declarative only.** Do not use React/JSX, PHP, a complete
  `block.json`, generated CSS, or `<!-- wp:… -->` delimiters as a substitute for that generator.
  Its model proposal makes reviewable semantic choices; deterministic code produces the executable
  files. See §2 for the full proposal and confirmation contract.
- **Continue project-owned work normally when static generation does not fit.** If the component
  needs a custom PHP renderer or editor behaviour, inspect its project contracts and implement that
  code in the project. Do not generate a static shell that will immediately be replaced, and do not
  require later regeneration of ordinary project-owned source. Retain any useful native subtree from
  `assemble` or `convert`, and state precisely what Block Runner contributed. For example: “Block
  Runner cannot generate this custom renderer and editor. I’ll implement those in the project and
  use its supported helpers where useful.” See `references/GUIDE.md` §1.1.
- **Finish the job.** Deliver page markup or source to its agreed retained destination, never a
  temporary folder. Explain remaining wiring and unverified checks; see `references/GUIDE.md` §2
  and §6. For page content, paste through **Options ⋮ → Code editor** (`Ctrl+Shift+Alt+M`), not the
  visual editor.
- **Prefer `--json` for automation.** Text output includes concise reasons and selected repair
  context, but JSON preserves the complete machine-readable report.
- **Never hand-write `<!-- wp:... -->` markup.** That is how invalid output happens. Describe
  structure instead and let `assemble` build it.
- **A `core/html` fallback is not a success.** It means that part is an uneditable blob. Check
  the report and tell the user.
- **If the CSS matters, use `convert`, not `assemble`.** An intent tree carries structure and
  content, not styling. Ask the user rather than silently flattening their design.
- **Name the proof claim and retain its receipt.** Headless markup checks do not establish custom
  PHP, custom controls, frontend behaviour, or editor persistence. See `references/GUIDE.md` §1.1
  and §2.
- **Passwords go in `--wp-app-password-env <NAME>`, never in argv.**
- **It is an assist, not a gate.** If the tool is unavailable, fall back to your own checks and
  say so — never block the user on it.

Block structure rules, the full node schema, per-section mappings, token and media resolution,
exit codes, and failure posture are all in `references/GUIDE.md`.
