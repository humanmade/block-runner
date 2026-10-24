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

### Stable releases

The 1.x line establishes the public CLI and library compatibility baseline described below.
Check `npm view block-runner dist-tags` for published versions. Before creating a release, run the
deterministic release candidate gates from the candidate checkout on Node 24.22.1+ or 26.12.1+:

```sh
npm run release:check -- --manual-review proof/reviews/1.0.0/agent-review.json --receipt dev/release/0.9-testing/receipts/<version>.json
```

The 13-fixture registered-block authoring benchmark is optional and does not
participate in the deterministic release status. Run it separately only
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
[`dev/release/0.9-testing`](dev/release/0.9-testing/README.md).

1. Bump the version: `npm version patch|minor|major` (commits + tags).
2. Push the tag: `git push --follow-tags`.
3. Draft a **GitHub Release** for that tag and **Publish** it.
4. The Release workflow runs the complete release candidate check then publishes with
   `npm publish --provenance --access public --tag latest`.
5. Confirm afterward: `npm view block-runner@latest version` shows the new release version, and
   `npm audit signatures` passes (provenance attestation present).

## Compatibility policy

Starting with 1.0.0, backward-incompatible changes to public CLI flags and library
exports require a major release. Minor releases add compatible functionality;
patch releases contain compatible fixes. Document behaviour changes and migration
requirements in the changelog.

The 1.0 release follows owner acceptance of a real-project rendered result and the
required deterministic release checks. Valid block markup, rendered fidelity and
native editing remain separate proof layers; the version does not promise fidelity
for arbitrary input or remove warnings and verification gaps. Optional model
benchmarks remain separately authorised and unscored when not run.

Historical 0.x releases used the pre-1.0 policy and could include breaking changes
in any release. Existing release-evidence paths retain their original names.
