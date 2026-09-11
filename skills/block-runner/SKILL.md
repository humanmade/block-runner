---
name: block-runner
description: >-
  Turn WordPress page content or authored design HTML into valid, native, editable Gutenberg blocks,
  or plan a reusable named registered block for deterministic source generation. Use when creating
  WordPress page content or sections, converting authored HTML or a design-tool export into block
  markup, authoring a reusable named block in an existing WordPress project, continuing an
  in-scope Gutenberg component through custom PHP or editor code, understanding its block
  integration before generation, validating or repairing Gutenberg
  markup, or before writing blocks to WordPress. Do not use for general WordPress administration,
  unrelated plugin or theme code, frontend-scraped HTML, or non-WordPress HTML.
license: GPL-2.0-or-later
compatibility: Requires Node.js ^20.19.0 || ^22.13.0 || >=24.0.0 and shell access. An uncached npx run requires npm registry access.
---

# Block Runner

## Pick the artifact first

Choose the visible result before discovering a project. Read the named first reference, use the
condition, and stop at its stated boundary. Do not load a construction taxonomy for a
self-contained page-content or markup-repair task.

| Requested artifact | First reference | Use when | Completion boundary |
| --- | --- | --- | --- |
| Native page or post structure | [ASSEMBLE.md](references/ASSEMBLE.md), then [GUIDE.md §5–6](references/GUIDE.md) | You are inventing a page section and have no authored HTML whose styling must survive. Run `npx -y block-runner@latest assemble - --json` with an intent tree. | Valid native page `post_content`, delivered to the agreed destination. |
| Page or post content from authored design HTML | [GUIDE.md §4](references/GUIDE.md) | The supplied source is authored HTML; use `npx -y block-runner@latest convert - --json` when its CSS matters. | Valid native page `post_content` plus reported fallbacks and styling limits. Never treat frontend-scraped rendered HTML as authored input. |
| Reusable, named static registered block source | [AUTHORING.md](references/AUTHORING.md) | The requested result is a static `namespace/slug` block in code. | Confirmed source at its exact retained destination; build, integration, and WordPress proof remain separate. The complete plan in [AUTHORING-PLAN.md](references/AUTHORING-PLAN.md) is an advanced route, not a prerequisite. |
| Custom PHP renderer or editor behaviour in an existing project | [GUIDE.md §1.1](references/GUIDE.md) | Static generation cannot satisfy the requested component. | Continue in project-owned code; retain a useful native subtree only when it genuinely helps. Inspect [CONSTRUCTION-PATTERNS.md](references/CONSTRUCTION-PATTERNS.md) only when project facts needed for that implementation are missing. |
| Supplied block markup to repair or check | [GUIDE.md §5](references/GUIDE.md) | Markup already exists and must be safe to save. | `validate` → `fix` → `validate`; do not save a hard-invalid result. |

If “reusable section” does not say whether it is page `post_content` or a named registered source
block, ask that one artifact question before writing. Do not use this skill for unrelated WordPress
administration, non-WordPress HTML, or frontend-scraped HTML presented as source.

## Discover only missing project facts

For a component that belongs in an existing project, use [GUIDE.md §0](references/GUIDE.md) after
the artifact route is clear. Reuse established facts and inspect only the relevant source and site
context needed for this change. Existing-plugin integration needs inspection; a self-contained
paragraph repair does not. Use relevant facts to recommend reuse, supported generation or a
developer handoff. Recognizing a route does not add generator support. Ask only for choices that
the request and repository do not answer; use structured questions if your harness supports them,
otherwise ask in plain language.

## Generator boundary and continuation

- **A generated registered-block plan is declarative only.** Do not use React/JSX, PHP, a complete
  `block.json`, generated CSS, or `<!-- wp:… -->` delimiters as a substitute for that generator.
  Its model proposal makes reviewable semantic choices; deterministic code produces the executable
  files. See `references/AUTHORING.md` for the full proposal and confirmation contract.
- **Continue project-owned work normally when static generation does not fit.** If the component
  needs a custom PHP renderer or editor behaviour, inspect its project contracts and implement that
  code in the project. Do not generate a static shell that will immediately be replaced, and do not
  require later regeneration of ordinary project-owned source. Retain any useful native subtree from
  `assemble` or `convert`, and state precisely what Block Runner contributed. For example: “Block
  Runner cannot generate this custom renderer and editor. I’ll implement those in the project and
  use its supported helpers where useful.” See `references/GUIDE.md` §1.1.
- **Finish the job.** Deliver page markup or source to its agreed retained destination, never a
  temporary folder. Explain remaining wiring and unverified checks; see `references/AUTHORING.md`
  and `references/GUIDE.md` §6. For page content, paste through **Options ⋮ → Code editor**
  (`Ctrl+Shift+Alt+M`), not the visual editor.
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
  and `references/AUTHORING.md`.
- **Passwords go in `--wp-app-password-env <NAME>`, never in argv.**
- **It is an assist, not a gate.** If the tool is unavailable, fall back to your own checks and
  say so — never block the user on it.

Block structure rules, the full node schema and per-section mappings are in
`references/ASSEMBLE.md`. Token and media resolution, exit codes, and failure posture are in
`references/GUIDE.md`.
