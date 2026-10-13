# Block themes and whole sites

These routes require Block Runner 0.9.11 or later; 0.9.10 predates them. Check your
installed version and `block-runner site --help` before using these commands.

## Check an existing theme

```sh
block-runner validate ./my-theme --strict --json
block-runner fix ./my-theme --write --strict --json
block-runner validate ./my-theme --strict --json
```

The folder gate discovers templates, parts and static PHP patterns. It preserves
pattern metadata headers and skips bodies containing PHP rather than executing them.
It checks a present `theme.json` against the pinned WordPress 7.1 schema and checks
local part, pattern and preset references. Block-scoped presets apply to their block
type. Core-default preset categories can remain explicitly skipped.

`fix --write` is only for theme folders. It canonicalises eligible markup files;
it does not rewrite `theme.json`. Schema errors fail the aggregate report; strict
reference failures prevent the affected file from being rewritten. Config-file `strict: true`
also applies. Review skips and warnings even when the command succeeds.

## Compile a whole site

Use caller-authored `SiteIntent`, with native blocks for each section and editable
descendants. A whole page or section inside `core/html` does not establish native
conversion. Existing authored HTML can inform the trees through `convert`; use
[ASSEMBLE.md](ASSEMBLE.md) for the node schema. Templates surround page content with
`core/post-content`; they must not duplicate the page body.

Save this minimal input as `site.intent.json`. Omitted page status defaults to draft:

```json
{
  "version": 1,
  "siteId": "sample-studio",
  "homePageId": "home",
  "theme": {
    "slug": "sample-studio",
    "title": "Sample Studio",
    "themeJson": { "version": 3 }
  },
  "templates": {
    "index": { "body": { "blocks": [{ "block": "core/post-content" }] } }
  },
  "parts": {},
  "patterns": {},
  "pages": [{
    "id": "home", "route": "/", "title": "Home", "template": "index",
    "body": { "blocks": [{ "block": "core/paragraph", "text": "Hello WordPress" }] }
  }],
  "assets": [],
  "assetUses": []
}
```

```sh
mkdir -p assets
block-runner site compile site.intent.json --asset-root ./assets --out ./site-bundle --strict --json
```

Compilation writes a new local bundle containing the block theme, page content,
retained source/assets and a hashed manifest. It passes documents through the existing
finalisation and theme gates. It does not contact WordPress. Each template/part has a
`body`; static patterns additionally have `title` and `slug`. Page IDs are stable
logical identities, separate from routes; `parentId` declares hierarchy.

Declare every asset by `id`, safe relative `path`, `kind` and `role` (`theme-file` or
`attachment`). `assetUses` bind its `assetId` to a `documentId`, zero-based `nodePath`
and `attribute` (`url`, `attrs.url`, `attrs.src` or `attrs.id`). Local WOFF/WOFF2 fonts
need an explicit `fontLicense` redistribution decision; stylesheet `cssUrls` declare
their referenced theme files. No source CSS or asset is silently inferred as deployed.

For database media, full compilation requires an explicit `--bindings <json>` map
keyed by asset ID. `--theme-only` emits deployable theme files while retaining pending
page and synced-pattern bindings. Dependencies used by theme documents must already
resolve; pending data is not a finished site artifact. `--theme-asset-base-url` supplies
the deployed base URL when needed. Inspect the JSON diagnostics.

Optional `syncedPatterns` has `version: 1`, `definitions` keyed by logical ID
(`title`, `body`) and explicit `uses` (`documentId`, `nodePath`, `patternId`, optional
named override `content`). These are database-owned reusable patterns, distinct from
static theme PHP files. Keep their native editable structure and declared bindings.

## Plan and apply to WordPress

Deploy and activate the exact compiled theme independently first. Block Runner
does not deploy or activate it. Use WordPress 7.1 and an explicit WP-CLI target/user.
For first installs with pending database bindings, plan from the retained intent:

```sh
block-runner site plan site.intent.json --asset-root ./assets \
  --wp-path /path/to/wordpress --wp-user 1 --out ./site.plan.json --strict --json

# Review the plan, then supply its exact confirmation hash and a durable journal.
block-runner site apply site.plan.json --source site.intent.json --asset-root ./assets \
  --wp-path /path/to/wordpress --wp-user 1 --confirm <hash> --journal ./site.apply.json --strict
```

`plan` makes a read-only WordPress observation and writes a new local plan. Its
confirmation binds source/assets, target, principal, active theme and live state.
Use `--wp-url` for a specific multisite target; `--wp-binary` selects the WP-CLI binary.
A fully bound bundle can replace the intent as plan/apply source.

`apply` imports declared images, creates or updates owned pages/synced patterns and
sets the static front page. It does not adopt unrelated records by title or route,
delete them, or overwrite unmanaged post fields. Pages remaining drafts keep their
dates; publishing a floating draft uses WordPress's native publication time.

The journal records each step before mutation. A partial or unknown outcome is a
failed apply, not a completed receipt. Held blog locks are never stolen, even by the
same journal. After a hard stop, preserve the plan, journal and native operation marker;
establish that every executor has stopped before guarded operator lock reconciliation.
There is no automatic lock expiry or recovery command. Never delete a lock blindly
or retry an uncertain effect without proving its outcome. This is not a transaction
with concurrent human edits or WordPress hooks.

## Inspect drift and pull saved theme edits

```sh
block-runner site drift ./site-bundle --wp-path /path/to/wordpress --wp-user 1 --json
block-runner site pull ./site-bundle --wp-path /path/to/wordpress --wp-user 1 \
  --select 'part:sample-studio//footer:123' --out ./pull-preview --json
block-runner site pull ./site-bundle --wp-path /path/to/wordpress --wp-user 1 \
  --out ./pull-preview --confirm <hash> --json
```

Drift is read-only: exit codes are 0 clean, 1 actionable, 2 blocked and 3 inspection
failure. Pull selection is an exact `part:theme//slug:wp-id` or
`template:theme//slug:wp-id`; replace the example with an observed database override.
Preview writes only a new local staging directory. Confirmation reuses that directory,
omits `--select`, and checks fresh target/source/before bytes before updating the
selected local theme files and sealed manifest. Database overrides remain untouched.
Pull does not reverse-infer the original intent. Reconcile that retained input and
recompile before planning another apply; unreconciled bundles are blocked.

## Prove the right result

`proof --theme ./my-theme --wp-env-config ./wp-env.json` saves mounted Site Editor
content and compares fresh REST bytes with pinned theme files. It honours wp-env's
effective fixed development port and refuses `autoPort`; a site marker guards the
browser target. This proves save persistence for the exercised files, not visual fidelity.

`proof --site ./site-bundle --wp-env-config ./wp-env.json` exercises a controlled
owned sandbox, with a nonempty set of explicitly published pages and declared header
and footer parts. The minimal draft example above needs those additions first.
Never use production as the proof fixture. Site proof requires PHP 8.4 in wp-env;
theme proof checks the theme's declared PHP requirement. Both routes require the
optional pinned WordPress/browser tooling. They pin the captured theme snapshot
automatically, so a separate plugin-style `--input` is unnecessary. Save proof and
visual/editor acceptance are separate claims.
