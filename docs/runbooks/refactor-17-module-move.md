# Refactor 17: the move of a module

Status: Active runbook for Stage B of [Refactor 17](../refactor-17.md)
Last reviewed: 2026-11-24

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

Each foundation module and each product area is a package since 2026-11-23
([The area group](#the-area-group-of-2026-11-23)). The kernel moved first.
`tenancy`, `actor-runtime`, `connections` and `authority` moved as one group
([The group of 2026-11-23](#the-group-of-2026-11-23)). `agent-tools`,
`contracts`, `control`, `agent`, `conversation`, `tool-handlers`, `ui` and
`collaboration` moved as the second group
([The second group](#the-second-group-of-2026-11-23)). Since 2026-11-24 the
public files that another area imports are the contract package
`areas/<area>/contract` of their area
([The contract group](#the-contract-group-of-2026-11-24)).

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

| Check                                                                                                                                                                                                                                         | Time     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `pnpm lint:static`                                                                                                                                                                                                                            | 1 minute |
| `pnpm --filter <package> check:types`, the new package alone                                                                                                                                                                                  | 1 s      |
| `pnpm --filter @purin-labs/platform check:types`                                                                                                                                                                                              | 7 s      |
| `pnpm --filter @purin-labs/platform check:test-types`                                                                                                                                                                                         | 3 s      |
| `pnpm --filter @purin-labs/portal exec tsc --noEmit -p .`                                                                                                                                                                                     | 34 s     |
| `pnpm check:packages`                                                                                                                                                                                                                         | 7 s      |
| `pnpm portal:build`                                                                                                                                                                                                                           | 4 s      |
| `pnpm exec wrangler deploy --dry-run --env production --outdir <folder>` in `workers/platform`. With Docker, it also builds the three container images                                                                                        | 9 s      |
| The five other Workers: `pnpm --filter @purin-labs/platform` with `code-mode-sandbox:check`, `model-exit:check`, `chatgpt-exit:check`, `vault-onepassword:check` and `slack-ingress:check`                                                    | 30 s     |
| When the move takes Portal files, one browser journey: start the Portal dev server of the checkout on a free port, then `node scripts/production-simulation/run-journeys.mjs --id persistent-chat-browser --base-url http://127.0.0.1:<port>` | 1 minute |

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
  to 8 one time, after the last move.
- **The clone lint and the order of the scan.** jscpd reads the files in the
  order of their paths and pairs each copy with the first file that holds it.
  A moved file comes earlier or later in the scan, so jscpd can pair the same
  copied lines in another way: a pair gets smaller, a new pair appears in a
  group of copies, or a pair grows by a line. No file changed. Do not touch
  the baseline between two moves of a group. After the last move:
  - If the lint reports only smaller or moved pairs, run
    `node scripts/check-clones.mjs --update`.
  - If it reports a new pair or a pair that grew, prove for each file of each
    such pair that the group changed nothing in it but import specifiers and
    paths (`git diff -M <before>..HEAD`), and that the copied lines hold no
    changed line. Then run `node scripts/check-clones.mjs --init`. The limit is
    3 copies and 40 lines for one group. Above it, stop.
  - Either way it is one commit of its own after the last move. Its message
    gives the totals before and after, each changed pair and the proof.
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
  move, and then one commit. The first group has the tags
  `refactor-17-foundation-1-before` and `refactor-17-foundation-1-after` and
  the plans `tenancy`, `actor-runtime`, `connections` and `authority`. The
  second group has the tags `refactor-17-foundation-2-before` and
  `refactor-17-foundation-2-after` and the plans `agent-tools`, `contracts`,
  `control`, `agent`, `conversation`, `tool-handlers`, `ui` and
  `collaboration`. The area group has the tags `refactor-17-areas-1-before` and
  `refactor-17-areas-1-after` and the plans `area-devices`, `area-brain`,
  `area-organisation`, `area-cafe`, `area-inbox`, `area-integrations`,
  `area-commerce` and `area-kitchen`. The surfaces group has the tags
  `refactor-17-surfaces-1-before` and `refactor-17-surfaces-1-after` and the
  plans `surface-whatsapp`, `surface-email`, `shopify`, `surface-slack`,
  `surface-webhooks`, `surface-voice` and `surface-portal`. The contract group
  has the tags `refactor-17-contracts-1-before` and
  `refactor-17-contracts-1-after` and the plans `contract-commerce`,
  `contract-inbox`, `contract-devices`, `contract-kitchen`, `contract-brain`,
  `contract-cafe`, `contract-integrations` and `contract-organisation`, in
  that order. A branch that was cut before the groups does the steps for the
  first group, then for the second, then for the areas, then for the
  surfaces, then for the contracts.
- Between the two tags of the second group there are four small commits that
  are not moves: the Portal lints read `PORTAL_SOURCE`, 17 `ui` names lose
  `export`, the layer check reads `packages/collaboration`, and one script
  correction. Where the branch changed the same lines, `-X theirs` keeps the
  lines of the branch. Run `pnpm lint:static` after step 4 to find such a line.
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
- A browser journey mounts a page from source files of the Portal dev server.
  It names a file by its path in the repository: `sourceUrl("<path>")` in the
  page (`/source-url.js`, which `apps/portal/vite.config.ts` serves) and
  `checkoutUrl("<path>")` in Node (`scripts/bakery-robots/simulator-navigation.js`).
  The script changes such a path as it changes each path from the root. It
  does not read an address below the Portal folder (`/src/styles.css`);
  `pnpm lint:lint-paths` refuses a journey path of either kind that matches no
  file.

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

No foundation module, no area and no surface is left. These plan options exist
for the cases so far:

- `package.existing: true` moves the files into a package that exists
  (`contracts`, `collaboration`). The script changes no manifest field but the
  dependencies.
- A module with Worker files and Portal files gets one package with the
  sub-folders `worker/` and `portal/` (`control`, `collaboration`). Add each
  such folder to `PLATFORM_SOURCE` or `PORTAL_SOURCE` in
  `scripts/lib/source-roots.mjs` with an edit of the plan: the Portal lints
  (`lint:portal-fetch`, `lint:portal-select`, the portal requests lint) and
  ESLint read these lists.
- A Portal package (`ui`) takes the compiler settings of the Portal and
  `vite/client`. Its exports map gives an entry to each file that another
  module imports; a component behind `index.ts` stays behind it, so knip judges
  it as before the move.
- `scripts/check-runtime-boundary.mjs` reads a route file in
  `foundation/*/control/routes/` and in `foundation/control/worker/routes/`,
  and an import by package name.
- A class that a Worker entry exports for a binding carries `@public` with the
  entry and the binding, because knip judges each export of a foundation
  package.
- `stays` names the files of the module that do not move: a path, or a folder
  that ends with `/` (`surface-portal`: the entries of the Portal build and
  `dev/` stay in `apps/portal/src`).
- A plan can move a module into a folder of the package of another module
  (`shopify` in `areas/integrations/shopify/`), with `package.existing: true`.
  The folder gets the rule of the module in `scripts/layers.json`, and a second
  run of the plan of that package keeps the export entry and the rule.
- A moved surface file keeps a relative import to a surface that has not moved
  yet, as an area file does for a public file of another area.
- An edit with an empty `replace` removes its `find` text.

## The contract group of 2026-11-24

Branch `r17-contracts`, on `origin/dev` at `cfc38227`. The public files of each
area that another area imports, with the public files that they import, are
its contract package `@purin-labs/area-<area>-contract` in
`areas/<area>/contract/`, the module `areas/<area>/contract`. A Worker file is
in `server/` and a Portal file in `ui/`, with its sub-path below `server/` or
`ui/` of the area, less a folder `contract/`: the file `contract/media.ts` below
`server/` of `cafe` is `areas/cafe/contract/server/media.ts`. 17 public files that only their own
area, a surface, a Worker or the Shopify module import stay public in the area
(`stays` in each plan; they keep their lines in `contracts`). The tags
`refactor-17-contracts-1-before` (the commit before the first plan) and
`refactor-17-contracts-1-after` (the last move) are made at the landing.

| Area           | Files to `server/` | Files to `ui/` | Public files that stay | Files changed | Imports changed (by name / relative) |
| -------------- | ------------------ | -------------- | ---------------------- | ------------- | ------------------------------------ |
| `commerce`     | 21                 | 6              | 1                      | 203           | 293 (289 / 4)                        |
| `inbox`        | 8                  | 8              | 4                      | 89            | 112 (111 / 1)                        |
| `devices`      | 2                  | 0              | 2                      | 30            | 26 (26 / 0)                          |
| `kitchen`      | 12                 | 1              | 0                      | 67            | 78 (73 / 5)                          |
| `brain`        | 4                  | 3              | 0                      | 47            | 43 (42 / 1)                          |
| `cafe`         | 7                  | 0              | 0                      | 36            | 37 (37 / 0)                          |
| `integrations` | 11                 | 9              | 7                      | 104           | 115 (115 / 0)                        |
| `organisation` | 3                  | 5              | 3                      | 44            | 35 (35 / 0)                          |

- **The rule.** The owner decided on 2026-11-24: a contract imports the
  foundation, outside packages and the contract of another area, and never
  the `server/` or `ui/` of an area, a surface or a Worker. The layer check
  refuses such an import, also with `import type`, and such a package
  dependency; a temporary probe contract proved each refusal. A run-time call
  of a public file to a foundation module above `contracts` is the counted
  debt `contract-runtime` (94 imports in 42 files). Each other debt count
  reads a contract as a part of its area, and so does the owner rule of the
  D1 tables.
- **The scope.** 100 files moved: the 87 source files and 3 style sheets of
  the approved plan, and 10 public files that the type repairs made. 9 React
  components moved; they needed no preparation, because each imports only
  public files.
- **The order.** A contract imports only contracts that moved before it:
  `commerce`, `inbox`, `devices`, `kitchen`, `brain`, `cafe`, `integrations`,
  `organisation`.
- **Before the moves, in their own commits:** the layer check, the debt kind
  and the import rule; the 28 old plans match the tree of `dev` again (10
  files that product commits deleted, 4 export entries, 1 dependency, 1
  obsolete edit); the script moves files out of the package of an area
  (`moduleFrom`, `stays`, imports by the old package name, `movedFolders`, the
  pruning of a dependency that no file uses, a file that a later plan moved
  again).
- **Type repairs.** 23 public files of the scope, and `approval-card-texts.ts`,
  took types from a private file of their area. With type-only changes, each
  now takes them from a public file: 10 new public files, function types for
  the service interfaces, and 4 interfaces that their classes implement
  (`DeviceFleetRpc`, and the graph reader, the engine source and the
  organisation reader of commerce). The stock operation types moved from the
  kitchen contract to the commerce contract, so the contracts have no cycle.
- **The result.** `pnpm` reports no cycle between the area packages; the two
  cycles between the surfaces stay (`email`, `whatsapp`, `slack`, `webhooks`;
  `portal`, `voice`). Each move commit is the output of the script, and
  `--check` prints "Nothing to change." for each of the 36 plans. The layer
  check finds 0 crossings.
- **The bundle.** The Worker bundle after the last move has the same bytes as
  before the first move (10,420,940 bytes). Against `cfc38227` it has the same
  code, and 26 minified names have other letters. The cause is in
  `cd487834`: `read-support.ts` lost an import of `CommerceGraphReader` that
  only a moved type used, and `routes.ts` imports the class with
  `import type`. esbuild counts an import binding when it gives out the short
  names, also when it drops the import. Only the unused import gives the same
  bytes again, and `noUnusedLocals` refuses it. The Portal build has the same
  5 pages and 574 files.
- **Ratchets.** The clone baseline fell from 779 copies (13,908 lines) to 778
  copies (13,874 lines); one 27-line copy moved with its type, and its key
  follows the file. `env-merge` fell from 83 to 76 methods. Each other count
  stays.
- **Checks on the branch:** `pnpm lint:static`, the Worker, test and journey
  type checks, the Portal type check, `pnpm check:packages`, the five other
  Workers, `pnpm test:units`, and the E2E files `idle-tenant-cost`,
  `slack-commerce-approval`, `mailbox-setup`, `chat-agent-permission-request`
  and `counter-register-journey`.
- Not run: the full E2E suite, the browser journeys, the Kitchen journeys that
  need `MUJOCO_DIR`, and a release.

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

## The folder of the Worker (2026-11-23)

`services/platform` is `workers/platform` since 2026-11-23, by one run of
`scripts/refactor-17/rename-folder.mjs`. The table of renamed folders is
`scripts/refactor-17/folder-renames.mjs`; the move script reads it, so each
plan still finds its files. Tags `refactor-17-workers-platform-before` and
`refactor-17-workers-platform-after`.

- **What changed.** 890 files moved, and 134 other files name the new path:
  documents, scripts, lints, ratchets, `scripts/layers.json` and the configs.
  Paths from the folder to a sibling got one more step
  (`../../services/shop-gateway/build.sh`, the Dockerfiles of the three
  containers and of the ChatGPT exit). Plans, evidence and history keep the old
  path in their text.
- **What did not change.** No Worker name, Durable Object class, binding,
  route or R2 key. The package is still `@purin-labs/platform`, and CI finds it
  by that name. The bundle of the Platform Worker and of the Slack ingress
  Worker has the same bytes before and after, and the four other Worker checks
  pass. So the rename needed no release.
- **Another checkout, after the pull.** Git leaves the ignored files in the
  old folder. Run `node scripts/refactor-17/rename-folder.mjs --local-files`
  to list them and `--move-local` to move them: `.dev.vars` and its variants
  (the local secrets), `.wrangler/` (the local D1 and Actor state) and
  `output/`. Then run `pnpm install`, and start each `wrangler dev` again.
- **An open branch.** `git rebase refactor-17-workers-platform-before`, then
  `git -c merge.directoryRenames=true rebase -X theirs
refactor-17-workers-platform-after`, then the script with `--stage` and one
  commit, then `git rebase origin/dev`, `pnpm install` and the type check.
  Without the config, git stops at each new file of the old folder: `git add`
  it and continue.
- **Checked before the landing:** `--check` of the script and of the 28 move
  plans, each lint with the same counts, the type checks, `pnpm test:units`,
  the Portal build, nine E2E files and two browser journeys, one of them on
  the built Portal. The dry run also built the four container images and ran
  the deploy command as a dry run.
- **A limit of the script.** It reads a relative path from the folder of its
  file or of its package. It does not find a path that is relative to another
  working folder; the type checks, the bundles and the journeys guard that
  case.

## The surfaces group of 2026-11-23

Branch `refactor-17-surfaces-1`, on `origin/dev` at `c5cabc48`. Tags
`refactor-17-surfaces-1-before` and `refactor-17-surfaces-1-after`. Each surface
is one package `@purin-labs/surface-<name>` in `surfaces/<name>/`. The Shopify
module is the folder `areas/integrations/shopify/` of the package
`@purin-labs/area-integrations`.

| Module     | Files to `server/`                   | Files to `ui/` | Files changed | Imports changed (by name / relative) |
| ---------- | ------------------------------------ | -------------- | ------------- | ------------------------------------ |
| `whatsapp` | 8                                    | 0              | 30            | 26 (23 / 3)                          |
| `email`    | 10                                   | 0              | 17            | 12 (12 / 0)                          |
| `shopify`  | 23, to `areas/integrations/shopify/` | —              | 22            | 24 (24 / 0)                          |
| `slack`    | 63                                   | 0              | 81            | 141 (80 / 61)                        |
| `webhooks` | 18                                   | 0              | 19            | 22 (22 / 0)                          |
| `voice`    | 11                                   | 17             | 34            | 26 (23 / 3)                          |
| `portal`   | 39                                   | 79             | 90            | 88 (86 / 2)                          |

- **The Portal.** `apps/portal` stays the Vite application: its HTML pages, its
  config, `public/` and, in `apps/portal/src`, the entries that an HTML page
  names (`bootstrap.tsx`, `tv/main.tsx`), the folder `dev/` and
  `vite-env.d.ts`: 70 files, which `stays` in the plan names. The shell, the
  router, the page table, `styles.css` and the chat feature are in
  `surfaces/portal/ui/`. The Wrangler file names the build folder
  `apps/portal/dist`, so a rename of `apps/portal` belongs with the rename of
  `workers/platform`.
- **The Worker.** 31 files stay in `workers/platform/src`, all of
  `workers/platform`: the six Worker entries, the Actor class files and the
  wiring files. The entry of the Slack ingress Worker joined them before the
  moves.
- **The order.** `whatsapp`, `email`, `shopify`, `slack`, `webhooks`, `voice`,
  `portal`. The surfaces import each other in two circles (`slack` and
  `webhooks`; `portal` and `voice`). Five imports stayed relative until the
  other surface moved, and none is left.
- **Shopify.** The module keeps its name `areas/shopify` and its rule in
  `scripts/layers.json`. Temporary imports from `areas/commerce`, from
  `areas/integrations/server` and from a Worker file were refused by
  `pnpm lint:layers` and by the count `shopify-rule` of `pnpm lint:layer-debts`.
  `REMOVE.md` names each file by its path in the repository.
- **The action registry.** Before the moves, the generated registry went to
  `foundation/authority/generated/action-registry.ts`, beside the action
  ledger: two Shopify files import it, and a package imports no file of the
  Worker. `actions:generate` writes it there, with the same bytes.
- **Lints.** The three type check programs of the Worker read
  `surfaces/*/server` and the Shopify folder, and the program of the Portal
  reads `surfaces/*/ui`. The runtime boundary lint and the tool effects lint
  read `surfaces/*/server`; the files of `slack/` are the top-level files of
  `surfaces/slack/server/`. For each of these, a temporary fault was refused.
  The layer debt `portal-default` fell from 26 rules to 2.
- **Journeys.** Before the moves, ten browser journeys and the loader of the
  voice bench named their Portal files with `sourceUrl` and `checkoutUrl`, so
  the script changed those paths.
- **The result.** Each move commit is the output of the script, and `--check`
  prints "Nothing to change." for each of the 28 plans. Each quick check of the
  table passes. The clone baseline did not change (795 copies, 14,331 lines).
  The Worker bundle has the same bytes before and after (10,411,698 bytes), and
  so has the bundle of the Slack ingress Worker. The Portal build has the same
  5 pages and 563 files. Twelve shared chunks have other names, because the
  bundler names a chunk after a module and the order of the modules follows
  the paths: compare the modules of each chunk in the source maps, not the
  names. `pnpm` reports two more cycles between packages (`email`, `whatsapp`,
  `slack` and `webhooks`; `portal` and `voice`).
- Run again on the branch before the landing: the lints, the type checks,
  `pnpm test:units`, the Portal build, the five other Workers, the bundle
  comparison, nine E2E files (Slack, the Slack ingress Worker, the mailbox,
  WhatsApp, voice, the Portal chat, the webhooks, the idle tenant cost) and
  four browser journeys, one of them on the built Portal.
- Not run before the landing: the full E2E suite (CI runs it), the Kitchen
  journeys that need `MUJOCO_DIR`, the live Slack journey and a release.

## The area group of 2026-11-23

Branch `refactor-17-areas-group-1`, on `origin/dev` at `316429ba`. Tags
`refactor-17-areas-1-before` and `refactor-17-areas-1-after`. Each area is one
package `@purin-labs/area-<name>` in `areas/<name>/`.

| Area           | Files to `server/` | Files to `ui/` | Files changed | Imports changed (by name / relative) |
| -------------- | ------------------ | -------------- | ------------- | ------------------------------------ |
| `devices`      | 25                 | 6              | 42            | 50 (28 / 22)                         |
| `brain`        | 21                 | 23             | 53            | 64 (61 / 3)                          |
| `organisation` | 22                 | 53             | 108           | 139 (109 / 30)                       |
| `cafe`         | 43                 | 58             | 70            | 106 (68 / 38)                        |
| `inbox`        | 115                | 37             | 144           | 347 (331 / 16)                       |
| `integrations` | 105                | 56             | 167           | 254 (177 / 77)                       |
| `commerce`     | 137                | 83             | 291           | 585 (415 / 170)                      |
| `kitchen`      | 78                 | 275            | 128           | 204 (143 / 61)                       |

- **The layout.** A Worker file keeps its sub-path below
  `workers/platform/src/`, without its first folder when that folder is the
  name of the area or `commerce/`. The `sourcePrefixes` of each plan hold this
  rule, so `--sync-plan` gives a later file the same place. A Portal file keeps
  its sub-path below `apps/portal/src/` (`ui/features/<feature>/`). No two
  files collide.
- **The order.** The eight areas import each other's public files in a circle,
  and a public file imports types of its own area. So no order moves each
  public file before its importers. The script lets a moved file import a
  public file of an area that has not moved yet: the import stays a relative
  path into the Worker until that area moves, and the script then names it by
  package. 75 imports took this way, and none is left after the last area.
- **Package cycles.** `pnpm` reports three cycles between the area packages.
  The layer check still refuses an import of a file that is not public. A
  `contract` package for each area removes the cycles; it is open work.
- **Type checks.** No area package has a type check of its own
  (`typeCheck: false`): each reads a binding that an Actor file merges into
  `Env`. The Worker programs read `areas/*/server` and the Portal program
  reads `areas/*/ui`, so each area file is checked.
- **Lints.** The layer check finds a package by its manifest name and reads an
  area package file by file. The runtime boundary lint and the tool effects
  lint read `areas/*/server`. Each plan adds its folders to `PLATFORM_SOURCE`
  and `PORTAL_SOURCE`. knip judges the exports of an area package, without its
  fixture files and its declaration files. For each of these, a temporary fault
  in an area folder was refused.
- **The clone baseline** changed one time after the last move: from 791 copies
  (14,202 lines) to 795 copies (14,331 lines), in 32 pairs. This is above the
  limit of the rule, and the proof took its place: of the 35 files of those
  pairs, 22 have the same content as before the group and 13 changed only
  import lines, and no changed line is inside a copied range.
- **The result.** Each move commit is the output of the script, and `--check`
  prints "Nothing to change." for each of the 21 plans. Each quick check of the
  table passes. The Worker bundle has 10,411,723 bytes before and 10,411,698
  bytes after; the `owner` paths of five state machine files are the whole
  difference. The Portal build has the same 5 pages and 563 files. The script
  corrected 59 paths of area files in the specs.
- Not run: the full E2E suite, the Kitchen journeys that need `MUJOCO_DIR` and
  a release.
- **Found by CI after the group** (run 45071075553 on `e67faac0`): the E2E
  suite passed, and five browser journeys of the Kitchen failed. A journey
  imported a Portal file by its address on the dev server
  (`/src/features/workflow-simulator/route.tsx`), which the script did not
  read; a file of `areas/` has the address `/@fs/<checkout>/areas/...`. 60
  imports in 20 journey files were wrong, two of them since the second
  foundation group. The correction is the last item of "Limits": the dev
  server gives the address of a file from its path in the repository, the
  journeys name each file by that path, and `pnpm lint:lint-paths` checks the
  paths. The check table has a browser journey now.

## The second group of 2026-11-23

Branch `refactor-17-foundation-group-2`, on `origin/dev` at `5c66062c`. Tags
`refactor-17-foundation-2-before` and `refactor-17-foundation-2-after`.

| Module          | Target                                                 | Files moved | Files changed | Imports changed (by name / relative) | Own type check                |
| --------------- | ------------------------------------------------------ | ----------- | ------------- | ------------------------------------ | ----------------------------- |
| `agent-tools`   | `foundation/agent-tools`                               | 16          | 103           | 180 (173 / 7)                        | No                            |
| `contracts`     | `packages/contracts/src/boundary.ts`                   | 1           | 18            | 14 (14 / 0)                          | Yes                           |
| `control`       | `foundation/control`, with `worker/` and `portal/`     | 26          | 356           | 605 (601 / 4)                        | No                            |
| `agent`         | `foundation/agent`                                     | 204         | 439           | 942 (865 / 77)                       | No                            |
| `conversation`  | `foundation/conversation`                              | 96          | 230           | 493 (479 / 14)                       | No                            |
| `tool-handlers` | `foundation/tool-handlers`                             | 8           | 33            | 32 (30 / 2)                          | No                            |
| `ui`            | `foundation/ui`                                        | 96          | 264           | 417 (412 / 5)                        | Yes, with the Portal settings |
| `collaboration` | `packages/collaboration`, with `worker/` and `portal/` | 14          | 49            | 54 (54 / 0)                          | Yes, for the CRDT core `src/` |

- Before the moves, in their own commits: the class `CodeModeSandbox` and its
  `Env` merge left the entry of the sandbox Worker for `sandbox.ts` (the
  sandbox bundle differs by one blank line); the entries of `model-exit`,
  `chatgpt-exit` and `code-mode-sandbox` went to `workers/platform`; seven
  corrections of the script; the `contracts` type check reads the Workers
  types; the runtime boundary lint and the Portal lints read the new folders;
  17 `ui` names that only their own file uses lost `export`; the layer check
  reads `packages/collaboration`, and its core imports only `@purin-labs/std`
  and `yjs`.
- Each move commit is the output of the script, and `--check` prints "Nothing
  to change." for each of the 13 plans.
- After the last move, each quick check of the table passes, with the type
  checks of `kernel`, `contracts`, `ui` and `collaboration`. The layer check
  finds 0 crossings. The unused-code counts and the layer debts do not change.
- The clone baseline changed one time, after the last move, by the rule above:
  from 790 copies (14,190 lines) to 791 copies (14,202 lines). The scan order
  is the whole cause: four of the five files of the new and grown pairs have
  the same content as before the group, and the fifth changed one import line
  outside its copied lines.
- The Worker bundle has 10,411,723 bytes before and after. Seven `owner` paths
  of state machine files are the whole difference.
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
