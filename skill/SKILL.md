---
name: block-runner
description: >-
  Produce, convert, and validate WordPress Gutenberg block markup so it lands in the editor as
  real, native, editable blocks instead of one frozen Custom HTML blob. Use whenever you are
  building WordPress page content or sections (hero, pricing table, FAQ, CTA band, feature
  grid), converting HTML or a design-tool export into blocks, or checking block markup before
  saving it to a site. Also use before any WordPress write that carries block markup. Runs
  offline and deterministically via `npx block-runner` — no API key. NOT for WordPress admin
  tasks, plugin or theme code, or non-WordPress HTML.
---

# Block Runner

Read `GUIDE.md` next to this file — it is the full contract and is the same guide shipped in
the npm package.

## The short version

Three paths. Pick by what you have:

- **You are inventing the structure** → do not write HTML. Emit an intent tree (JSON
  describing which blocks and how they nest) and pipe it to
  `npx -y block-runner@latest assemble - --json`. Deterministic code builds the markup, so it
  cannot come out invalid. This is the best path and the one to reach for by default.
- **You have someone else's HTML** → `npx -y block-runner@latest convert - --json`. The only
  path that carries CSS; use it when the styling matters (`--styling relaxed` is the default).
- **You have block markup to check** → `validate` → `fix` → `validate`. Never save markup that
  is still invalid after `fix`.

## Rules that are easy to get wrong

- **Finish the job — the markup has to land somewhere.** Write it where the user asked; or
  offer to write it through a WordPress connection if one is available; or show it to them
  with the paste instruction (**Options ⋮ → Code editor**, or `Ctrl+Shift+Alt+M` — pasting
  into the *visual* editor produces a mess). Never leave it in a temp file. See `GUIDE.md` §5.
- **Always pass `--json`.** Without it the report items are dropped and you will miss
  fallbacks, warnings, and source locations.
- **Never hand-write `<!-- wp:... -->` markup.** That is how invalid output happens. Describe
  structure instead and let `assemble` build it.
- **A `core/html` fallback is not a success.** It means that part is an uneditable blob. Check
  the report and tell the user.
- **If the CSS matters, use `convert`, not `assemble`.** An intent tree carries structure and
  content, not styling. Ask the user rather than silently flattening their design.
- **Passwords go in `--wp-app-password-env <NAME>`, never in argv.**
- **It is an assist, not a gate.** If the tool is unavailable, fall back to your own checks and
  say so — never block the user on it.

Block structure rules, the full node schema, per-section mappings, token and media resolution,
exit codes, and failure posture are all in `GUIDE.md`.
