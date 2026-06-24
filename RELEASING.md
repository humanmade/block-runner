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

1. Bump the version: `npm version patch|minor|major` (commits + tags).
2. Push the tag: `git push --follow-tags`.
3. Draft a **GitHub Release** for that tag and **Publish** it.
4. The Release workflow runs `npm run verify` then
   `npm publish --provenance --access public`.
5. Confirm afterward: `npm view block-runner` shows the new version, and
   `npm audit signatures` passes (provenance attestation present).

## Pre-1.0 note

While on `0.x`, any release may include breaking changes — that's expected semver
for `0.x`. Move to `1.0.0` when the public API (CLI flags + library exports) is
stable enough to promise backward compatibility. At that point, consider adopting
[changesets](https://github.com/changesets/changesets) to automate version bumps,
changelogs, and the publish PR.
