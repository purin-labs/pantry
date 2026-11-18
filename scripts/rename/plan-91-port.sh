#!/usr/bin/env bash
# Plan 91: move work that uses old code names to this repository. The old work
# is a branch of seams-tech/satyr (Satyr names) or a branch of this repository
# from before the Pantry rename of 18 November 2026 (Atelier names). The script
# renames both ends with the Plan 91 codemod (only a tree with Satyr names) and
# the Pantry pass, and applies the difference to the current branch here as
# one change.
#
#   bash scripts/rename/plan-91-port.sh <old checkout> <old ref> [<old base>]
#
# <old ref>  the old commit or branch to move, for example origin/dev or
#            refactor-16. Commit uncommitted work first.
# <old base> the old commit whose work this repository already holds. The
#            default is ba6277160, the old dev that the move imported. After a
#            port, use the old ref of the last port as the next base.
#
# The old ref must contain the base: rebase an older branch onto it first.
# Run it from the root of this repository, on a clean branch. Then review the
# change, run the checks and commit.
set -euo pipefail

old_repo=$(cd "$1" && pwd)
old_ref=$2
old_base=${3:-ba6277160}
here=$(pwd)
codemod="$here/scripts/rename/plan-91-codemod.mjs"
pantry="$here/scripts/rename/plan-91-pantry.mjs"

if [ -n "$(git status --porcelain)" ]; then
  echo "This tree is not clean. Commit or stash first." >&2
  exit 1
fi
ref_commit=$(git -C "$old_repo" rev-parse --verify "$old_ref^{commit}")
base_commit=$(git -C "$old_repo" rev-parse --verify "$old_base^{commit}")
if ! git -C "$old_repo" merge-base --is-ancestor "$base_commit" "$ref_commit"; then
  echo "$old_ref does not contain $old_base. Rebase it onto $old_base in $old_repo first." >&2
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/plan-91-port.XXXXXX")
cleanup() {
  git -C "$old_repo" worktree remove --force "$scratch/base" >/dev/null 2>&1 || true
  git -C "$old_repo" worktree remove --force "$scratch/ref" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# Rename both ends with the same codemod, so that the difference holds only
# the old work, in the new names.
for side in base ref; do
  commit=$base_commit
  [ "$side" = ref ] && commit=$ref_commit
  git -C "$old_repo" worktree add -q --detach "$scratch/$side" "$commit"
  (
    cd "$scratch/$side"
    if [ -d services/underclerk ]; then node "$codemod" --write >/dev/null; fi
    # The pass reports old file names that a string still uses; the port
    # applies the work anyway, so check the result with the Plan 91 checks.
    node "$pantry" --write >/dev/null || true
    git add -A
  )
done

base_tree=$(git -C "$scratch/base" write-tree)
ref_tree=$(git -C "$scratch/ref" write-tree)
# The two worktrees share one object store, so one repository can diff both trees.
git -C "$scratch/ref" diff --binary "$base_tree" "$ref_tree" > "$scratch/port.patch"
if [ ! -s "$scratch/port.patch" ]; then
  echo "Nothing to move: $old_ref adds no work after $old_base."
  exit 0
fi

git apply --3way --whitespace=nowarn "$scratch/port.patch" || {
  echo "Some hunks did not apply. Resolve the conflicts that git marked, then continue." >&2
  exit 2
}

echo "Applied the work of $old_ref (${ref_commit:0:9}) after ${base_commit:0:9}. Old commits:"
git -C "$old_repo" log --format='  %h %s' "$base_commit..$ref_commit"
echo "Next: pnpm install --prefer-offline, regenerate (services/platform actions, commerce spec --write),"
echo "run the checks, and commit with the old range in the message. The next base is ${ref_commit:0:9}."
