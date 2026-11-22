# Refactor 17, decision D1: the trial of packages and folders

Date: 2026-11-22. Branch: `refactor-17-d1-trial`, cut from `origin/dev` at
`0890dfc7`. The branch is a trial. Do not merge it.

## Result

The times do not decide D1. No variant is slower or larger than the baseline by
more than the noise of the machine. The obstacles decide it.

Recommendation: **a mix**. Make each foundation module a workspace package, from
the bottom of the foundation order. Keep the server code of an area a folder
until each module that it imports is a package. Variant M of this trial is that
mix, and it passes each check that variant F passes.

- Folders (variant F) work, with one lint failure. A root folder needs its
  package names in the root `package.json`, and each kernel import becomes a
  path with three to six `../`.
- Packages for both modules (variant P) build and run, but three lints fail and
  no package passes a type check of its own. The area imports 45 Worker files,
  so the package and the Worker depend on each other.

## What the trial did

- Area: `devices`, 25 server files, 6,679 lines. Its files were in
  `src/devices/`, `src/actors/device-*.ts`, `src/agent-tools/devices/` and
  `src/control/routes/devices.ts`.
- Foundation module: `kernel`, 16 files, 1,339 lines. Reasons: `devices` imports
  it more than each other module (31 of its 76 imports of Worker files). It is
  the lowest module in the Worker, and it imports only `@purin-labs/std`. It
  holds `env.ts` and the interface `Env`. Each part of the Worker imports it, so
  it gives the largest count of changed imports.
- The Portal part and the contract in `packages/control-api` did not move.

| Variant | Commit     | Layout                                                                                                                       |
| ------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0       | `0890dfc7` | The tree of `origin/dev`                                                                                                     |
| F       | `e624c4e2` | `areas/devices/server/` and `foundation/kernel/` at the root. Relative imports. No new `package.json`                        |
| P       | `c188e4a5` | The same folders as `@purin-labs/devices-server` and `@purin-labs/kernel`: `package.json`, `exports` map, `tsconfig.json`    |
| M       | `44897e77` | The tree of F, with only the kernel as a package. Added after the measures, to test the recommendation (`git diff e624c4e2`) |

The packages are source packages: the `exports` map names `.ts` files and there
is no build step. Each package of this repository has this form.

## Measures

Machine: Apple M4 Pro, 14 cores, 48 GB. Other sessions used the machine: the
1-minute load was 6.9 to 12.1 during the rounds. Each cell is the median of
three runs. The rounds went 0, F, P, three times, with a `git checkout` and
`pnpm install --offline` before each variant.

| Measure                                        | 0                     | F                     | P                                   |
| ---------------------------------------------- | --------------------- | --------------------- | ----------------------------------- |
| `check:types`, first run after the checkout    | 3.19 s                | 2.70 s                | 2.99 s                              |
| `check:types`, second run                      | 2.45 s                | 2.22 s                | 2.35 s                              |
| `tsrs --noEmit` of the Worker alone            | 0.79 s                | 0.65 s                | 0.75 s                              |
| `check:test-types`                             | 1.44 s                | 1.38 s                | 1.64 s                              |
| Worker bundle, to the line "Total Upload"      | 3.79 s                | 3.32 s                | 3.45 s                              |
| `wrangler deploy --dry-run`, whole command     | 8.17 s                | 7.36 s                | 7.52 s                              |
| Bundle, bytes of `integration-gateway.js`      | 10,394,797            | 10,394,679            | 10,394,780                          |
| Bundle, upload and gzip (KiB)                  | 10201.35 / 2416.01    | 10201.24 / 2415.64    | 10201.33 / 2416.01                  |
| Journey `devices-page`, time to the first test | 20.16 s               | 19.26 s               | 20.13 s                             |
| Journey, Vitest duration (transform, setup)    | 18.97 s (6.87, 15.53) | 18.22 s (6.51, 15.00) | 19.07 s (6.91, 15.75)               |
| `pnpm portal:build` (the Vite part)            | 4.26 s (2.81)         | 3.25 s (2.07)         | 3.45 s (2.06)                       |
| `pnpm lint:static`                             | passes, 32.0 s        | fails: 1 lint         | fails: 3 lints                      |
| Type check of each package alone               | no package            | no package            | kernel 5 errors, devices 159 errors |

- The Portal build reads no moved file, and its time differs by 1.0 s between
  the variants. So 1 s is the noise. No other time differs by more.
- `tsrs` keeps no cache. The "first run" is the first run after the checkout.
  The file cache of the system was not cleared.
- The whole dry run also builds three container images from the Docker cache.
- Variant M, one run: the same bundle bytes as P, journey duration 19.07 s, each
  type check passes, three other Workers build.
- Each sample with its load: `refactor-17-d1-trial/measures.jsonl`.

## Obstacles

### The move, in F and in P

| Obstacle                                      | Count                                                                                                                              | Cause and cost                                                                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files with a changed import                   | 1,224: 917 Worker files (2,102 imports), 172 unit test files (251), 101 journey files (126), 15 repository scripts, 19 moved files | The kernel causes almost all of them. A script does the change (`refactor-17-d1-trial/move.mjs`). The commit collides with each open branch                                        |
| Lints that find files by a root name          | 8                                                                                                                                  | They lose the moved files and still pass: state machines, state writers, ESLint, IFC destinations, database handles, tool effects, jscpd, knip. The trial added the roots: 9 files |
| Stale paths that `pnpm lint:lint-paths` found | 30                                                                                                                                 | 27 in `scripts/layers.json`, 2 in a ratchet, 1 in a check script                                                                                                                   |
| The path guard itself                         | 24 false faults                                                                                                                    | It did not read `areas/` or `foundation/`. With those roots, a module name such as `foundation/std` looks like a path. The trial taught it the module names                        |
| Paths in a string of a source file            | 2                                                                                                                                  | The import in the template of `generate-actions.ts`, and the `owner` path in `device-command.machine.ts` (14 other machine files hold such a path)                                 |
| Rule folders in `check-runtime-boundary.mjs`  | 2 lists                                                                                                                            | The rules "a route runs no query" and "an Actor imports no route" name `control/routes` and `actors`. A moved route or Actor leaves the rule                                       |
| `pnpm lint:clones`                            | 1 new copy, not fixed                                                                                                              | A kernel import is longer, so the formatter wraps it. Two import blocks then reach the size of a copy. Also 3 paths and 1 pair changed in the ratchet                              |
| Formatter                                     | 249 files                                                                                                                          | They fail Prettier after the move, and not before. The net change is +889 lines in F and +723 in P                                                                                 |
| Documents                                     | 1 link, 1 generated page                                                                                                           | `docs/architecture/runtime.md` and `docs/layers.md`. 26 old paths in 10 plan documents stay, by the rule for plans                                                                 |

Nothing to change: the D1 baselines (`pnpm lint:d1-patch` passes), the 6
Wrangler files, the 5 Dockerfiles, the CI path filters and the file-size
ratchet. `.dockerignore` is a deny list, so a new root folder enters each image
build context.

### Folders only (F)

- **Package imports do not resolve from a root folder.** 23 imports of 5 package
  entries in 19 moved files fail (46 type errors). pnpm links the packages of
  the Worker only inside `services/platform/node_modules`. Fix in the trial: 4
  workspace dependencies in the root `package.json`. That list grows with each
  folder. The other fix: keep the folders inside the Worker package.
- Each `tsconfig` of the Worker (3 files) must include the new folders.
- 2,051 kernel imports in the Worker now have three to six `../`.
- Node prints a module type warning when a script imports a moved `.ts` file,
  because the root `package.json` has no `type`.

### Packages only (P)

- **Imports back into the Worker: 45**, to 26 files (33 value imports, 12 type
  imports). They go to 7 foundation modules (`tenancy` 14, `agent-tools` 8,
  `actor-runtime` 5, `agent` 5, `authority` 5, `control` 3, `tool-handlers` 3)
  and to 2 area contracts. To import them by name, the Worker gets an `exports`
  map, and pnpm reports "cyclic workspace dependencies".
- `pnpm lint:layers` fails: 47 new crossings. The lint gives a package one
  module, so each import of the Worker by name is an upward import.
- `pnpm lint:unused` fails: the `exports` map makes each of the 1,238 Worker
  files an entry. knip then stops its check of their exports: 7 of the 16 known
  unused exports go from its list.
- A folder walk follows the links of the cycle with no end.
  `check-database-handles.mjs` stopped with `ENAMETOOLONG` (fixed: it skips
  `node_modules`).
- No package passes a type check alone (the next section). `tsrs -b` with the
  kernel as a project reference fails with the same 5 errors.
- CI runs `pnpm check:packages` on `./packages/*` only. `check-unused.mjs` looks
  for a package one level under a root, and `areas/<area>/server` is deeper.
- What packages give: 2,510 imports by name that a later move does not change,
  no list in the root `package.json`, and an `exports` map. The Worker uses 15
  of the 25 `devices` files, from 14 files.

With relative imports from the area into the Worker (variant M), the cycle, the
two lint failures and the endless walk go away.

## `Env` and the declaration merges

14 files add bindings to `Env` with `declare module "../env"`. One is in
`devices` (`DEVICE_FLEET`). One more file merges `CommerceTypeParts`, also in
the kernel. The move script changed these 15 specifiers.

- F: the specifier is a longer relative path. The merge works as today.
- P: the specifier is `@purin-labs/kernel/env`. The merge works in the Worker
  type check, because the name resolves to the same source file and one program
  holds each file.
- P, each package alone: the merge is absent. A program sees only the merges of
  its own files. `kernel/env.ts` reads four merged keys for its Actor stub types
  (4 errors). `devices` reads `env.BAKE_RUN`, which the Kitchen Actor file
  merges (2 errors). Its 45 imports pull 395 Worker files into the program (153
  errors there).

So a package boundary gives no type check of its own while the bindings of a
module come from a merge in another module.

## Import cycles

- Package level: one, in P only, between `devices-server` and the Worker.
- File level: the Worker has 18 cycles of value imports today (the largest has
  8 files). No cycle holds a `devices` file or a kernel file. The packages add
  no cycle at the start of the Worker, and the journey Worker starts in each
  variant.

## Tests that import the inside

- Today 236 of 316 journey files and 373 unit test files import `src/` of the
  Worker by path.
- Kernel: 172 unit test files (251 imports) and 98 journey files (122 imports).
  `ids` has 251 of them and `database-handles` 97.
- `devices`: no unit test. 4 journey files, 4 imports, each of
  `contract/fleet-stub`, which is public.
- F gives each import a deeper relative path. P gives it the package name. The
  kernel `exports` map is `./*`, because the Worker imports each of its 16
  files. Neither module needed a `testing` entry.

## Types that the Worker and the Portal share

The Portal `devices` feature imports no server file. Its types come from
`@purin-labs/control-api`, which 13 of the 25 server files also import. That
contract is a source package today, and no variant changed it.

## Not measured

- A start with an empty file cache: `purge` needs `sudo`.
- The move of the contract to `areas/devices/contract/` and of the Portal part
  to `ui/`. The Portal build time therefore says nothing about D1.
- The full unit suite and the full E2E suite: one journey and one unit test file
  ran for each variant. A container build with changed paths.
- A package with a build step and declaration files.
- Variant M with three rounds: it ran one time.
- The conflicts with the open branches of other sessions.
- The commit hooks: the trial commits ran without them.

## Recommendation for D1

A mix, in this order:

1. Foundation modules become packages, bottom-up, the kernel first. An import by
   name stays valid through each later move, and no root folder needs a
   dependency list.
2. The server code of an area stays a folder with relative imports into the
   Worker. It can become a package when each of its imports goes to a package.
   For `devices` that is 7 foundation modules and 2 area contracts.
3. Before step 1, move the four Actor stub types out of `kernel/env.ts` (29
   files use them). The kernel then needs no merged key.

Cost, measured in variant M for the kernel and `devices`: 1,272 files (41
renames, 1,229 edits, 2 new files), of which 26 are configuration, lint and document
files (21 in F, 25 in P). The script makes each import change.

Main risk: the `Env` merge at 14 sites. It works while only the Worker program
checks types. A type check for each package, a project reference or a package
build step fails until each module declares the bindings that it reads.

Open point for the owner: a root folder needs its package names in the root
`package.json` (5 for `devices` in variant M). Without that list, the area
folders must stay inside the Worker package folder.

## How to repeat

The folder `refactor-17-d1-trial/` beside this file holds the tools:

- `move.mjs <root> <plan.json> [--dry]` moves files and changes the imports.
  `plan-F.json`, `plan-P.json` and `plan-M.json` are the three plans. P and M
  run on the tree of F.
- `repath.mjs` changes the paths in lint and ratchet files.
- `measure.mjs <worktree> <out.jsonl> 3 0=<sha> F=<sha> P=<sha>` runs the
  rounds. `summary.mjs <out.jsonl>` prints each median with its samples.
