#!/usr/bin/env bash
# Plan 91 phase 1: apply the code-name rename to a clean tree, then rebuild
# what the rename makes stale. Run it from the repository root on the freeze
# day, in a clean checkout of `dev`. Then run the Plan 91 phase 1 checks.
set -euo pipefail

if [ -n "$(git status --porcelain)" ]; then
  echo "The tree is not clean. Commit or park the open work first." >&2
  exit 1
fi

report="${1:-plan-91-codemod-report.md}"

node scripts/rename/plan-91-codemod.mjs --write --report "$report"

# Package names changed, so the lockfile and the workspace links change.
pnpm install --prefer-offline

# The Platform imports the built async-control package.
pnpm --filter @seams/async-control build

# Generated files name the renamed packages and identifiers.
(cd services/platform && node --experimental-strip-types scripts/generate-actions.ts)
node scripts/check-commerce-spec.mjs --write

echo "Applied. Report: $report. Next: the Plan 91 phase 1 checks."
