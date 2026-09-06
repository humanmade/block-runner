# Prepared Wesper consumer integration — release held

This branch preserves the prepared Block Runner adapter from 6 September 2026.
It is not a release candidate and must not be merged with its current dependency
state. The integration change is `e6930e3`, based on main `51886e9`.

The adapter accepts full and focused Wesper context and delegates collection to
Wesper. Its package manifest requests `wesper@0.0.3`, while the lockfile still
records the published `0.0.2`. The npm registry was checked again on 6 September
and still reported `0.0.2`; the explicit publication hold remains in force.

Earlier prepared-candidate checks passed: 19 token tests, 85 style tests, the
focused-context CLI case, typecheck, build and package checks. These are not
registry-install proof for the manifest/lockfile combination preserved here.

After an explicitly authorised Wesper release, refresh this branch against
current main, update the lockfile from the registry, and verify a clean installed
consumer before opening a merge-ready PR. Track that release handoff in
[issue #55](https://github.com/humanmade/block-runner/issues/55). Do not publish a
package, change npm tags, or relax acceptance requirements merely to finish this
integration.

The optional packed-CLI recorder is preserved separately on Wesper branch
`codex/wesper-12-packaged-recorder` at `f6d9804`. Wesper PR #28 already merged the
main packaged-consumer proof; the recorder adds a supplied-0.9-tarball CLI probe
and is not required to recreate that merged proof.
