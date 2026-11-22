#!/usr/bin/env bash
# Plan 92: move work from the old repository (seams-tech/pantry-history) to this
# one. The new repository started with one import commit, so the histories do
# not join; this script carries the work as one patch.
#
#   bash scripts/plan-92-port.sh <old checkout> <old branch> [<old base>]
#
# <old branch> the branch or commit to move. Commit open work first.
# <old base>   the old dev commit that the branch starts from. The default is
#              the merge base of the branch and the old origin/dev.
#
# Run it from the root of this repository, on a clean branch. Paths that the
# import moved follow their new place; changes to paths that the import left out
# (evidence, closed plans, the centaur tools, one-off scripts) are listed and
# not applied. Then review the change, run the checks and commit.
set -euo pipefail

old_repo=$(cd "$1" && pwd)
old_ref=$2
old_base=${3:-$(git -C "$old_repo" merge-base "$old_ref" origin/dev)}

if [ -n "$(git status --porcelain)" ]; then
  echo "This tree is not clean. Commit or stash first." >&2
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/plan-92-port.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

git -C "$old_repo" diff --binary --find-renames "$old_base" "$old_ref" > "$scratch/work.patch"
if [ ! -s "$scratch/work.patch" ]; then
  echo "Nothing to move: $old_ref adds no work after $old_base."
  exit 0
fi

# Files that the import moved.
sed -i.bak \
  -e 's#services/platform/scripts/plan55c/binding-observation.ts#services/platform/tests/e2e/binding-observation.ts#g' \
  -e 's#services/platform/scripts/plan55c/sqlite-observation.ts#services/platform/tests/e2e/sqlite-observation.ts#g' \
  -e 's#services/platform/scripts/plan55/full-worker.ts#services/platform/tests/e2e/full-worker.ts#g' \
  -e 's#services/platform/scripts/plan55/merchant-fixture.ts#services/platform/tests/e2e/merchant-fixture.ts#g' \
  -e 's#output/bakery-assets/models/#areas/kitchen/ui/features/production-run/models/#g' \
  "$scratch/work.patch"

# Paths that this repository does not hold: list them and leave them out.
excluded=()
while IFS= read -r path; do
  [ -z "$path" ] && continue
  # A path that the old base held and this repository does not: the import left it out.
  if ! git ls-files --error-unmatch "$path" >/dev/null 2>&1 &&
    git -C "$old_repo" cat-file -e "$old_base:$path" 2>/dev/null; then
    excluded+=("$path")
  fi
done < <(grep -E '^diff --git ' "$scratch/work.patch" | sed -E 's#^diff --git a/(.*) b/.*#\1#' | sort -u)

apply_args=(--3way --whitespace=nowarn)
for path in ${excluded[@]+"${excluded[@]}"}; do apply_args+=(--exclude="$path"); done
git apply "${apply_args[@]}" "$scratch/work.patch"

echo "Applied the work of $old_ref after $old_base from $old_repo."
if [ "${#excluded[@]}" -gt 0 ]; then
  echo "Left out ${#excluded[@]} paths that this repository does not hold:"
  printf '  %s\n' "${excluded[@]}"
fi
echo "Next: review, run the checks, and commit with the old range in the message."
