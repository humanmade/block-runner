# Releasing

Block Runner publishes to npm from CI with **provenance** via **Trusted Publishing**
(OIDC) — there is no long-lived npm token in this repo. The publish runs on
`.github/workflows/release.yml` when a GitHub Release is published.

## One-time setup (must be done on npmjs.com — cannot be scripted)

1. **Create the package owner / org** on npmjs.com that will own `block-runner`.
2. **Enable 2FA** on that npm account (Account → Two-Factor Authentication).
   Publishing requires it, and it's a visible trust signal.
3. **Configure Trusted Publishing** for the package:
   Package settings → *Trusted Publisher* → add a **GitHub Actions** publisher with
   - Repository: `humanmade/block-runner`
   - Workflow filename: `release.yml`
   This lets the workflow authenticate via OIDC with no token.
   > For the very first publish, the package must exist. Either publish `0.1.0` once
   > manually (`npm publish --provenance --access public` from a 2FA'd local login),
   > then wire trusted publishing for all subsequent releases — or create the package
   > placeholder and configure trusted publishing before the first CI publish.

## Per-release flow

### 0.9 testing release

`0.9.x` is a **testing** release line for registered-block authoring. Publish it with the
`testing` npm dist-tag; it must not be described as the 1.0 stability promise. Before creating a
release, run the deterministic release candidate gates from the candidate checkout:

```sh
npm run release:check -- --receipt release/0.9-testing/receipts/<version>.json
```

The 13-fixture registered-block authoring benchmark is optional and does not
participate in the deterministic testing-release status. Run it separately only
when reviewed candidate plans and a WordPress/browser worker are available:

```sh
npm run authoring:prove -- --plans /absolute/path/to/saved-plans
```

The release checker never creates plans or calls a model. Its receipt records the
optional benchmark as pending/unscored unless that separate work is supplied.

Keep the resulting receipt with the release. It records the authoring suite/scorer/prompt/guide,
template, dependency, WordPress, theme, and browser hashes; the workload, model/effort, invalid
counts, and timing method; and the package, skill, and activation matrix. A browser or visual gate
without a receipt is `blocked`, not passed. The optional authoring benchmark is recorded as
pending/unscored unless its separate plans and worker run is retained. The detailed matrix and
product-preview state live in
[`release/0.9-testing`](release/0.9-testing/README.md).

1. Bump the version: `npm version patch|minor|major` (commits + tags).
2. Push the tag: `git push --follow-tags`.
3. Draft a **GitHub Release** for that tag and **Publish** it.
4. The Release workflow runs the complete release candidate check then publishes 0.9 tags with
   `npm publish --provenance --access public --tag testing`.
5. Confirm afterward: `npm view block-runner` shows the new version, and
   `npm audit signatures` passes (provenance attestation present).

## Pre-1.0 note

While on `0.x`, any release may include breaking changes — that's expected semver for `0.x`.
Do **not** promote 0.9 to 1.0 merely because the release matrix is green: 1.0 remains contingent
on real-project feedback and resolution of all release failures. Move to `1.0.0` only when the
public API (CLI flags + library exports) is stable enough to promise backward compatibility and
those conditions are satisfied. At that point, consider adopting
[changesets](https://github.com/changesets/changesets) to automate version bumps, changelogs, and
the publish PR.
