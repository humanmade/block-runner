#!/usr/bin/env bash
#
# Backtest: run the CURRENT benchmark suite against OLDER engine versions, so the
# progress curve is apples-to-apples (suite held constant, engine varied).
#
# Usage:  scripts/backtest.sh <commit> [<commit> ...]
# Example: scripts/backtest.sh c2d6630 be03332
#
# For each commit it: adds a git worktree, installs + builds that version's engine,
# then runs THIS checkout's suite + harness against it (via BLOCK_RUNNER_ENGINE) and
# appends a record to benchmarks/results.jsonl tagged `engine=<commit>`.
#
# Caveats (see md/08-benchmark-system.md):
#   - Requires a stable convert() public API; a commit that broke it is a floor.
#   - parseMarkup (scoring) stays current, so it loads the current @wordpress while
#     the old engine loads its own. Same pinned @wordpress across commits = fine;
#     a commit that BUMPED @wordpress may need full isolation (consume the engine as
#     a published package instead). Treat this script as the scaffold.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
if [ "$#" -eq 0 ]; then
  echo "usage: scripts/backtest.sh <commit> [<commit> ...]" >&2
  exit 2
fi

for SHA in "$@"; do
  WT="$(mktemp -d -t "br-engine-${SHA}.XXXX")"
  echo "=== backtesting engine @ ${SHA} (worktree: ${WT}) ==="
  git worktree add -f "$WT" "$SHA" >/dev/null
  ( cd "$WT" && npm ci --silent && npm run build --silent )
  BLOCK_RUNNER_ENGINE="$WT/dist/index.js" BLOCK_RUNNER_ENGINE_LABEL="$SHA" \
    npm --prefix "$ROOT" run bench -- --record
  git worktree remove -f "$WT"
done

echo "=== done. See the scoreboard (report/scoreboard.html) for engine-tagged rows. ==="
