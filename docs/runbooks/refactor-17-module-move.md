# Refactor 17: the move of a module

Status: Active runbook for Stage B of [Refactor 17](../refactor-17.md)
Last reviewed: 2026-11-23

A foundation module of the Platform becomes a workspace package (decision D1).
One script does the whole move:

```bash
node scripts/refactor-17/move-module.mjs scripts/refactor-17/plans/<module>.json
```

The first plan is `scripts/refactor-17/plans/kernel.json`: the module `kernel`
becomes `@purin-labs/kernel` in `foundation/kernel/`. The head of the script
lists what one run does. This runbook covers the day of the move, a branch that
was cut before the move, the limits, and the plan of the next module.

The move changes paths and import specifiers only. In the dry run of the
kernel, the Worker bundle had the same bytes before and after the move.

Five modules are packages: `kernel`, and since 2026-11-23 `tenancy`,
`actor-runtime`, `connections` and `authority`, which moved as one group in one
freeze ([The group of 2026-11-23](#the-group-of-2026-11-23)).

## Before the day

1. Land the commit that holds the script, its plan, this runbook and the shared
   root list (`scripts/lib/source-roots.mjs`). Each other session gets the
   script with its next rebase. The commit changes one line of product code,
   with no change of behavior: `isolate-location.ts` does not pass an
   undefined timer to `clearTimeout`, so that the kernel passes a type check
   with the Workers types alone.
2. Tell the other sessions the date and the hour. A move of the kernel changes
   about 1,250 files, so each open branch must follow the steps of
   [An open branch](#an-open-branch).
3. On the day, no session lands on `dev` between step 2 and step 9 below.

## The day of the move

Use a clean worktree at the newest `origin/dev`, with `pnpm install` done and
the R2 files present (`node scripts/repo-binaries.mjs fetch`). The times are
from the dry run of the kernel on an Apple M4 Pro, with other sessions at work.

| Step | Command                                                                                    | Time                     |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------ |
| 1    | `pnpm lint:static` on the tree before the move. It must pass                               | 1 minute                 |
| 2    | `git tag refactor-17-<module>-before`                                                      | —                        |
| 3    | `node scripts/refactor-17/move-module.mjs scripts/refactor-17/plans/<module>.json --stage` | 40 s                     |
| 4    | `git commit`, one commit with no hand edit                                                 | —                        |
| 5    | The same command with `--check`. It must print "Nothing to change."                        | 5 s                      |
| 6    | The quick checks of the table below                                                        | 3 minutes                |
| 7    | `pnpm test:units`                                                                          | 1 to 2 minutes           |
| 8    | The E2E suite: four shards, one at a time on one machine, or CI on the branch              | 17 to 23 minutes a shard |
| 9    | `git tag refactor-17-<module>-after`, land on `dev` with a fast-forward, push the two tags | —                        |

The quick checks of step 6:

| Check                                                                                                                                                                                      | Time     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `pnpm lint:static`                                                                                                                                                                         | 1 minute |
| `pnpm --filter <package> check:types`, the new package alone                                                                                                                               | 1 s      |
| `pnpm --filter @purin-labs/platform check:types`                                                                                                                                           | 7 s      |
| `pnpm --filter @purin-labs/platform check:test-types`                                                                                                                                      | 3 s      |
| `pnpm --filter @purin-labs/portal exec tsc --noEmit -p .`                                                                                                                                  | 34 s     |
| `pnpm check:packages`                                                                                                                                                                      | 7 s      |
| `pnpm portal:build`                                                                                                                                                                        | 4 s      |
| `pnpm exec wrangler deploy --dry-run --env production --outdir <folder>` in `services/platform`. With Docker, it also builds the three container images                                    | 9 s      |
| The five other Workers: `pnpm --filter @purin-labs/platform` with `code-mode-sandbox:check`, `model-exit:check`, `chatgpt-exit:check`, `vault-onepassword:check` and `slack-ingress:check` | 30 s     |

Rules for the day:

- **The move commit is the output of the script and nothing more.** An open
  branch runs the same script, so a hand edit in the move commit comes back as
  a conflict in each branch. If a check fails, correct the plan or the script,
  go back to the tag of step 2 (`git reset --hard`), land the correction as
  its own commit before the move, and run the script again.
- **A fault stops the script before it changes a file.** Each fault names its
  repair. A file that the module got after the plan was written:
  run the script with `--sync-plan`. A text edit of the plan that finds no
  text: a lint or a config changed on `dev`; correct the `find` text.
- **A ratchet that counts lines or tokens.** An import by package name is
  longer than the relative import, so Prettier wraps some imports: three more
  lines and one more comma. Two lints count that as new code. The clone lint
  (`pnpm lint:clones`) reports a new copy where two files with the same
  imports pass the token limit of jscpd. The layer debt lint
  (`pnpm lint:layer-debts`) reports more lines of the kind `worker-logic`. Do
  not raise a count, and do not run `--init` or
  `--update`. Read the lines that the lint prints. If each new line is an
  import that Prettier wrapped, add the file to `keepForm` in the plan with its
  reason, go back to the tag and run the script again: the imports of that file
  stay on their lines, and each count stays as it was. If the lint names other
  code, the move did not make it: stop.
- **Prettier.** The script formats a changed file only if the file was clean
  before. A file that was not clean keeps its form, and so does a file of
  `keepForm`: it then has an import line of more than 80 characters.
- **The bundle.** Compare the Worker bundle before and after the move. A state
  machine file (`*.machine.ts`) holds its own path as the text `owner`, and
  that text is in the bundle. So the rule is: the same bytes after the old
  `owner` paths in the bundle of before are replaced by the new ones.
- **A group of modules in one freeze.** Run the plans in the order of
  `foundationOrder`, with one move commit for each. Use one pair of tags for the
  group (`refactor-17-<group>-before` and `-after`). Run the checks of steps 6
  to 8 one time, after the last move. Between two moves of a group, `pnpm
lint:clones` can report a pair that got smaller: jscpd reads the files in a
  new order and pairs the same lines in another way. No file changed. Do not
  run `--update`; the count returns when the last module of the group moves. A
  ratchet that still differs after the last move is a real difference.
- **To go back** before step 9: `git reset --hard refactor-17-<module>-before`
  and `pnpm install`. After step 9: revert the one move commit.

A freeze of `dev` lasts from step 2 to step 9. The move, its commit and the
checks of steps 5 to 7 need about 10 minutes. The E2E suite decides the rest:
about 30 minutes in all with one shard, and about 90 minutes with the four
shards on one machine. The time of four shards is an estimate from two runs of
shard 1 (17 and 23 minutes).

## An open branch

A branch that was cut before the move holds imports of the old paths. Do these
steps on the branch, with no uncommitted change:

```bash
git fetch origin
git rebase refactor-17-<module>-before             # 1. the usual conflicts
git rebase -X theirs refactor-17-<module>-after    # 2. across the move
node scripts/refactor-17/move-module.mjs scripts/refactor-17/plans/<module>.json --stage
git commit -m "Refactor 17: the <module> move for this branch"   # 3.
git rebase origin/dev                              # 4. the usual conflicts
pnpm --filter @purin-labs/platform check:types
```

- For a group, do step 3 with each plan of the group, in the order of the
  move, and then one commit. The group of 2026-11-23 has the tags
  `refactor-17-foundation-1-before` and `refactor-17-foundation-1-after` and
  the plans `tenancy`, `actor-runtime`, `connections` and `authority`.
- Step 2 has only the move between the two tags. Where the branch and the move
  changed the same lines, `-X theirs` keeps the lines of the branch, with their
  old imports. The move changed nothing but imports there, so no work is lost.
- Step 3 changes each old import that is left, in committed and in new files.
  It moves nothing a second time. If the branch added a file to the module,
  the script stops and asks for `--sync-plan`.
- Use `-X theirs` only between the two tags. In another rebase it hides a real
  conflict.

The test of 2026-11-23 used a scratch branch with six changed files: a kernel
import with one more name, a new kernel import beside the old ones, a change
far from the imports, a new source file, a new test file and a change of a
kernel file.

| Order                                       | Result                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `git rebase`, then the script               | Works. The rebase stops in the 2 files where the branch changed a line beside a kernel import. Resolve by hand |
| `git rebase -X theirs`, then the script     | Works with no hand work. The script then changes 8 imports in 4 files, and the type check passes               |
| The script on the branch, then `git rebase` | Works, but with the same 2 conflicts, and the branch needs the script commit first. It gives nothing more      |

In each order, git follows the rename: the change of the kernel file arrives in
`foundation/kernel/`. A second run of the script changes nothing.

## Limits

- Plans, refactor documents, evidence and handovers keep the old paths in
  their text. In `docs/plan-*`, `docs/refactor-*`, `docs/evidence/`,
  `docs/handoffs/` and `docs/history/` the script changes one thing: the target
  of a Markdown link to a moved file, because `pnpm lint:doc-links` refuses a
  link to a file that is gone. It does not read `scripts/refactor-17/`.
- A folder that moves whole takes its name with it in each lint, config and
  document, and its old line in `scripts/layers.json` goes. A glob of the
  Worker source that selects a moved file of a folder that does not move whole
  is a fault: add the new path to the plan as an edit.
- A document that moves (a `README.md` in a module folder) gets its own
  relative links corrected.
- `AGENTS.md` gets no line about `foundation/`. Write it by hand after the
  move.
- `node scripts/list-tests.mjs --of <file>` counts relative imports only. It
  does not see a test that imports a package entry by name.
- Two lints name folders of the Platform by their old place:
  `scripts/check-tool-effects.mjs` (`agent-tools/`, `custom-connectors/`) and
  `scripts/check-runtime-boundary.mjs` (`control/routes/`, `actors/`, `slack/`,
  `chat/`). The kernel has no such folder. A module that holds one needs an
  edit of these lints in its plan.
- A file that a Dockerfile copies cannot import the package: the image has no
  workspace. The script stops with a fault for such a file.
- A package passes its own type check only if it reads no key that another
  module merges into `Env`. The kernel reads none since the Actor stub types
  left `env.ts`. `tenancy`, `actor-runtime`, `connections` and `authority` read
  `ORGANISATION`, `SESSION`, `CONNECTOR` and `CASE`, which the Actor files of
  the Worker merge, and `authority` reads `CommerceTypeParts.entityPlaneEffect`,
  which the commerce area merges. Their plans set `package.typeCheck: false`:
  the package has no `check:types` script, and the type check of the Worker
  checks each of its files. The debt kind `env-merge` of `pnpm
lint:layer-debts` counts these merges.
- A package cannot import a file of the Worker. The script stops and names the
  import. For the group of 2026-11-23, the type `InstallModel` moved to
  `@purin-labs/contracts`, and the entry of the 1Password store Worker
  (`vault-onepassword/worker.ts`) went to `workers/platform` in
  `scripts/layers.json`. The entries of the other Workers (`model-exit`,
  `chatgpt-exit`, `code-mode-sandbox`) need the same line before the module
  `agent` moves.
- knip judges each export of a foundation package (`includeEntryExports` for
  `foundation/*` in `knip.json`), so a known unused export keeps its line in
  `scripts/unused-ratchet.json` under its new path.

## The plan of the next module

Copy `scripts/refactor-17/plans/kernel.json` and change:

- `module`, `target` and `package.name`. The last name of the folder and of the
  package must be the same.
- `files`: leave it empty, give `sourcePrefixes`, and run the script with
  `--sync-plan`. Then read the list.
- `package.exports`: one entry for each file that another module imports, or
  `./*` if each file is an entry.
- `package.dependencies`: the workspace packages that the module imports. The
  script stops if a moved file imports a file of the Worker that does not move.
- `edits`: the six edits of the kernel plan that add the root `foundation` are
  done. Keep only the edits that the new module needs.
- `keepForm`: empty at the start.
- `package.typeCheck`: `false` if the module reads a key that another module
  merges into `Env`. Give the keys in `about`.

The modules that are left, with what each needs first:

| Module                                   | What it needs                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-tools`                            | An ESLint edit for `context/**`, the dependencies `typebox` and `@earendil-works/pi-codemode`, and an edit of `scripts/check-tool-effects.mjs`, which names the folder `agent-tools/` |
| `agent`, `conversation`, `tool-handlers` | The Worker entries of `model-exit`, `chatgpt-exit` and `code-mode-sandbox` in `workers/platform` first. `agent` has 206 files                                                         |
| `contracts`                              | One Worker file (`boundary.ts`) beside the package `@purin-labs/contracts`. The script cannot move a file into a package that exists                                                  |
| `control`                                | 21 Worker files and 5 Portal files. `scripts/check-runtime-boundary.mjs` must read an import of `control/routes/` by package name                                                     |
| `ui`                                     | 64 Portal files: React and DOM code, so the package needs the `tsconfig` of the Portal                                                                                                |
| `collaboration`                          | 8 Portal files and 4 Actor files beside `packages/collaboration`. The script moves a module into one target only                                                                      |

Run the script with `--check` first: it changes nothing and prints each fault.

## The group of 2026-11-23

Branch `refactor-17-foundation-group-1`, on `origin/dev` at `e4be3233`. Before
the moves, in their own commits: five corrections of the script, the split-D1
statement test reads `foundation/`, the knip option, `InstallModel` in
`@purin-labs/contracts`, the 1Password Worker entry in `workers/platform`, and
the four plans.

| Module          | Files moved | Files changed | Imports changed (by name / relative) | `keepForm`                                           |
| --------------- | ----------- | ------------- | ------------------------------------ | ---------------------------------------------------- |
| `tenancy`       | 33          | 735           | 1,116 (1,094 / 22)                   | `actors/organisation/support.ts`, for `worker-logic` |
| `actor-runtime` | 31          | 445           | 670 (653 / 17)                       | —                                                    |
| `connections`   | 26          | 309           | 483 (481 / 2)                        | —                                                    |
| `authority`     | 79          | 640           | 1,217 (1,189 / 28)                   | —                                                    |

- The four moves change 1,231 files in all. Each move commit is the output of
  the script, and `--check` prints "Nothing to change." for each plan.
- After the last move, each quick check of the table passes, with the type
  check of the kernel as the only package type check. The five other Workers
  pass their checks. The layer check finds 0 crossings, and no ratchet count
  changes.
- The Worker bundle has 10,411,729 bytes before and 10,411,723 bytes after.
  The `owner` paths in `organisation-lifecycle.machine.ts` and
  `placement-move.machine.ts` are the whole difference: with the new paths in
  the bundle of before, the bytes are the same.
- Not run: the full E2E suite, the Kitchen journeys and a release.

## The dry run of the kernel

Date: 2026-11-23. Branch `refactor-17-kernel-package`, on `origin/dev` at
`ae105f47`. `dev` got new commits three times during the work, and the script
ran again on each new tree with no change of the plan.

- One run of the script: 16 files moved, 2 package files made, 1,229 files
  changed. 2,506 imports changed (2,486 by name, 20 relative), with the 15
  `declare module` merges. Prettier changed 144 files. 236 changed files were
  not clean before, and 3 files are in `keepForm`.
- Each check of the tables above passes. The layer check finds 0 crossings.
  The clone lint, the unused-code lint and the layer debt lint give the same
  counts before and after.
- The Worker bundle has the same 10,411,729 bytes before and after the move.
- E2E shard 1 of 4: 59 files pass and 3 fail, with 11 tests. The 3 files are
  the cobot journeys `bake-faults`, `bake-pause` and `bake-run`. The machine
  had no `MUJOCO_DIR`. The same 11 tests fail with the same error on
  `origin/dev`.
- Unit suites: 2 tests of the Platform fail, in `email-mailbox.test.ts` and
  `connector-email-evaluation.test.ts`. The same 2 tests fail on `origin/dev`.
- Not run: shards 2 to 4 of the E2E suite, the Kitchen journeys and a release.
