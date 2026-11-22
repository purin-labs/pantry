# ENG-02 — Code and repository

This spec describes how the source of Purin Pantry is organised and how the repository
guards that organisation. One git repository holds the Workers, the Portal, the shared
packages and the Rust crates. Large files are in an R2 bucket, and a manifest in git
names them. Each source file has a module in one of three layers or in the Workers
above them, and an import may only go down. Lint scripts refuse a new crossing, a new
copy, new unused code, a larger large file, a new broken link and an unknown plan
number. A ratchet file holds the known debt of a lint, so that the lint refuses new
debt and the list can get shorter. This subsystem has no runtime behavior, no route and
no agent tool.

## What it does

### The repository

- The repository is `purin-labs/pantry`. Its history starts with one import commit.
- The archive `seams-tech/pantry-history` holds the older history, the closed plans and
  most evidence. An old commit hash in a plan or in the evidence resolves there.
- `scripts/plan-92-port.sh` moves open work from an old checkout as one patch. It needs
  a clean tree, follows the moved files and lists changes to paths outside the import.

| Folder                                  | What it holds                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/`                                 | `portal`, `storefront` and `docs`                                                                                                                                                            |
| `services/`                             | `platform` and `commerce`, the two services in the pnpm workspace, and `chatgpt-exit`, `custom-connector-fetch`, `message-link-fetch`, `shop-gateway`, `shop-voice` and `workspace-executor` |
| `packages/`                             | The shared TypeScript packages, in the scope `@purin-labs/*`                                                                                                                                 |
| `foundation/`                           | The foundation modules in their final folder. It holds only `kernel` (`@purin-labs/kernel`)                                                                                                  |
| `crates/`                               | The Rust crates. `bakery-native` is outside the Cargo workspace, so `cargo test --workspace` does not run it                                                                                 |
| `scripts/`                              | The lints, the deploy scripts, the journeys, the builders and `punter`                                                                                                                       |
| `integrations/`, `recipes/`, `patches/` | The Shopify integration files, the Kitchen recipe files and the pnpm dependency patches                                                                                                      |
| `docs/`                                 | Specs, plans, runbooks and `docs/history/`                                                                                                                                                   |

### Large files in R2

- The bucket `pantry-repo-binaries-apac` holds the large files. Each object has the key
  `sha256/<hash>`, so a key never changes its content.
- `repo-binaries.json` is the manifest in git. `files` maps a path to its SHA-256 and
  size. `folders` maps a folder (a key with a final `/`) to the same data for each file.
- The manifest names the Kitchen models in `assets/`, the manuals in `docs/equipment`,
  some physics bundles that no pin names, and large brand and evidence files.
- Git keeps the pinned runtime bundle, the pinned execution bundle and each bundle that
  a Platform test fixture names. `pnpm lint:physics-bundle` refuses a fixture that names
  an execution bundle in R2, or an execution bundle whose runtime bundle is in R2.

Run `node scripts/repo-binaries.mjs fetch` after a clone, and before a Portal build, a
Kitchen build or the E2E suite. To add a large file, run `upload`, not `git add`.

| Command                                   | What it does                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch [--jobs N] [path-prefix]`          | Gets each missing or changed file and checks its SHA-256                                                                                                              |
| `check`                                   | Lists each missing or changed file. It exits with 1 only for a changed file                                                                                           |
| `upload [--dry-run] [--jobs N] <path>...` | Sends files or folders with Wrangler, then writes the manifest and the `.gitignore` block. It does not send a hash that the manifest names. `--dry-run` sends nothing |
| `ignore`                                  | Writes the `.gitignore` block from the manifest, so that git does not commit a fetched file                                                                           |
| `probe-write`                             | Proves that the S3 key cannot write: it exits with 1 when a `PUT` succeeds                                                                                            |

`fetch` uses the R2 S3 API when `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`R2_ENDPOINT` are set, and Wrangler otherwise. Each file also goes into a local cache
under its hash (`REPO_BINARIES_CACHE`, default `~/.cache/repo-binaries`), so a new
worktree on the same machine copies it.

### The three layers

`scripts/layers.json` gives each source file a module. The longest rule that starts a
path gives the module, and a line in `files` wins over a rule.

```text
workers     above the layers: Worker entries, class shells, wiring, and Punter
surfaces    portal, slack, email, whatsapp, webhooks, storefront, shop, voice, docs-site
areas       commerce, cafe, kitchen, inbox, brain, integrations, shopify, devices,
            organisation
foundation  std, async-control, kernel, contracts, tenancy, actor-runtime, connections,
            authority, control, ui, agent-tools, agent, conversation, tool-handlers,
            collaboration, testing
```

The map stores `workers` as a fourth value of `layers`, but it is the composition root
and not a fourth layer. `workers/punter` is the private acceptance package in
`scripts/punter`, and it is not a deployed Worker. The `worker-logic` debt counts the
logic that stays in `workers/platform`.

The foundation list is `foundationOrder`, from the bottom up. `pnpm lint:layers` applies
these rules:

- An import goes only down: `workers`, `surfaces`, `areas`, then `foundation`.
- A foundation module imports only a module that is earlier in `foundationOrder`.
- One area imports no file of another area. It may import a public file that
  `contracts` lists, or a workspace package of that area.
- A package of an area may depend on a package of another area only when `contracts`
  lists that package.
- A public file imports no non-public file of its own area, except with `import type`.
- Only the owner module of a D1 table writes it. `tables` names each owner.
- A source file with no module, a tracked file with no place, and a D1 table with no
  owner are faults. A file has a place when it is under `covers`, in a folder of
  `packages`, or under a key of `placement`.

To remove a crossing, use a port: the lower module defines an interface, and the higher
module gives the implementation. `definePort` is in `foundation/kernel/port.ts`.

The lint reads the `.ts` and `.tsx` files under `covers`: `services/platform/src/`,
`apps/portal/src/` and `foundation/`. For other packages, it reads only the workspace
dependencies in `package.json`. It finds a D1 write by a literal table name. Its list of
known crossings is empty. A new entry needs a `reason` and a `fix`.

`docs/layers.md` lists each module. After a new folder, a new table or a map change, run
`node scripts/check-layers.mjs --areas --write`, or `pnpm lint:layers-page` fails.

`pnpm lint:layer-debts` counts the crossings that `lint:layers` cannot see. A count may
not grow, and `scripts/layer-debts-ratchet.json` gives the reason and the fix of each
kind: `env-merge`, `foundation-misfit`, `table-read`, `surface-nonpublic`,
`area-package`, `worker-logic`, `shopify-rule`, `interpolated-table`, `portal-default`.

### The lints

`pnpm lint` runs `lint:static` and `lint:d1-patch`. `lint:static` runs `lint:source`,
`lint:physics-bundle` and `lint:appliance-registry`. Only `lint:d1-patch` needs a base
revision. These lints guard the repository:

| Command                 | What it refuses                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint:runtime-boundary` | A crossing between the commerce engine and the Platform, and a Platform route import from actor, Slack or chat code                         |
| `lint:file-size`        | A new source file over 3,000 lines, or growth of a listed file                                                                              |
| `lint:clones`           | A new copy of product code, or more copied lines in a file pair (jscpd)                                                                     |
| `lint:unused`           | A new unused file or export (knip), or more package entry exports with no importer                                                          |
| `lint:doc-links`        | A relative Markdown link to a file that does not exist, unless the ratchet lists its page and target. A second copy of a listed link passes |
| `lint:plan-numbers`     | A plan or refactor number in source code that the table "Old plan numbers" of `docs/specs/README.md` lacks                                  |
| `lint:lint-paths`       | A path in `eslint.config.mjs`, a check script or a ratchet file that matches no tracked file                                                |
| `check:shared-helpers`  | A local or renamed copy of an `@purin-labs/std` helper, an inline backoff formula, and `Extract<U, { kind: K }>`                            |

- `lint:doc-links` skips code blocks and code marks. A file of `repo-binaries.json`
  counts as present. In `apps/docs/src/`, a link that starts with `/` is a site route.
- `lint:lint-paths` also reads `scripts/layers.json` and `scripts/lib/source-roots.mjs`.
  Its `ABSENT` list holds the paths that may match no file.
- `check:shared-helpers` applies its name rule to tests too, and its other rules only
  to product code. It exempts `std`, `type-utils` and `async-control`. It allows one
  `Extract`, in `packages/collaboration/src/sync-protocol.ts`.

`lint:runtime-boundary` (`scripts/check-runtime-boundary.mjs`) holds these rules:

- Commerce code is `services/commerce`, `apps/storefront`,
  `packages/commerce-contracts`, `packages/commerce-client` and
  `packages/commerce-query-sqlite`. It imports only these, npm packages and the neutral
  packages `std`, `type-utils` and `contract-schema`.
- The neutral packages import and depend only on each other.
- The same rules apply to `package.json` dependencies, to the Cargo `path` dependencies
  of commerce code, and to quoted `../` file references in commerce and neutral code.
- Other code reaches the commerce engine only through the three commerce packages or
  the built Worker.
- Code outside a built-in plugin imports it only through its `index.ts`. Only the plugin
  names its tables in SQL.
- In `services/commerce/src`, only `CLOUDFLARE_ADAPTERS` files name a Cloudflare API.
- Platform files in `actors/`, `slack/` and `chat/` import no file in `control/routes/`.
  A route file calls no `.prepare(`.

Other lints guard one subsystem. The spec of that subsystem describes these:
`lint:state-machines` (FND-02), `lint:database-handles` and `lint:d1-patch` (FND-01),
`lint:ifc-boundaries` (FND-07), `lint:tool-effects` (FND-09), `lint:commerce-spec`
(COM-02), `lint:physics-bundle`, `lint:appliance-registry` and `lint:journey-index`
(KIT-02), and `lint:portal-fetch`, `lint:portal-requests` and `lint:portal-select`
(PRT-01). This spec describes the others:

- `lint:state-writers` refuses an SQL write of a machine's state column outside the
  owner module of that machine. `scripts/state-writers-ratchet.json` lists the known
  writers, and their counts may only fall.
- `lint:purge-catalogue` refuses a regional table with no entry in
  `foundation/tenancy/data/purge-catalogue.ts`, and a purge order that deletes a row
  before a row that refers to it.
- `lint:kitchen-dom` refuses a browser-only global in the source of `bakery-model`,
  `bakery-workflow` and `production-simulation`.
- `lint:provider-workflows` runs ESLint on one folder. "Code style" gives its rules.

### Where the lints run

- **Before a push.** `.githooks/pre-push` runs `pnpm -s lint:source`. The hook is off
  until a person runs `git config core.hooksPath .githooks` for the clone.
- **`.github/workflows/pantry.yml`.** It runs on a pull request to `main`, on
  `merge_group` and by hand. A draft pull request runs a job only with the label
  `run-ci`. The job `checks` fetches the R2 files and runs `pnpm check:packages`,
  `pnpm lint:static`, the D1 patch check on a pull request, the type checks,
  `pnpm test:units` and the E2E suite in four shards. The job `bakery-physics` runs the
  native and browser Kitchen journeys.
- **`.github/workflows/commerce-components.yml`.** It runs on a pull request that
  changes a commerce path and on each `merge_group`, with
  `pnpm lint:runtime-boundary` and the commerce checks.

### Code style

- Prettier sets the layout (`.prettierrc.json`). `pnpm format` writes each file, and
  `pnpm format:check` reports. CI and `pnpm lint` do not run Prettier.
- ESLint has three style rules: `curly`, `one-var` and the padding rule of `@stylistic`.
  `pnpm lint:provider-workflows` applies them and `no-unused-vars` to
  `services/platform/src/provider-workflows`. `pnpm lint:fix` repairs that folder.
- `pnpm lint:ifc-boundaries` first runs `scripts/check-ifc-destinations.mjs`, which
  refuses a new information-flow destination with no class. It then runs ESLint on
  `services/platform/src`, `foundation` and `apps/portal/src` with the style rules off.
  ESLint applies the restricted imports and refuses the global `fetch` as a value. Pass
  `runtimeFetch` from `foundation/kernel/runtime-fetch.ts`.
- For a file that you edit, run `pnpm exec eslint --fix <file>`, then
  `pnpm exec prettier --write <file>`.

### One definition for each concern

| Concern                   | The one place                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent tool             | One value from the definer of its family under `services/platform/src/agent-tools/`, and one line in `registry.ts`                                                                                                                                                                                                                     |
| The Actor lifecycle       | `PlacedActor` (`actors/lifecycle/placed-actor.ts`). `SessionActor`, `CaseActor`, `ConnectorActorBase` and `OrganisationActorBase` extend it. `DeviceFleetActor`, `ConversationResidencyActor`, `BakeRunActor` and `CodeModePlatformGovernorActor` extend `DurableObject` directly                                                      |
| An Actor alarm and schema | `rearmActorAlarm`, `setActorAlarm` and `armAlarmBy` (`actors/lifecycle/actor-alarm.ts`), and `actors/schema-migrations.ts`. The four direct Actors, `session-actor.ts`, `actor-export.ts` and `actor-activation.ts` also call `setAlarm` directly                                                                                      |
| A control route           | A route parses, checks authorization, calls one domain function and maps its result. In new and moved code, a domain function returns a `Result`, knows no HTTP and throws only for a programmer error                                                                                                                                 |
| A Portal page and request | `PAGES` in `apps/portal/src/pages.tsx`. `controlRead` and `controlMutation` in a feature request module, with `useLatestRead` and `useMutation` in a component                                                                                                                                                                         |
| A shared document         | `defineSharedDoc` (`packages/collaboration/src/shared-doc.ts`) and `definePlainTextDoc`. `workflow-canvas-crdt` does not use them. It imports `defineSharedEncoding`, the size check, the result helpers, the limits, the id and text checks and the protocol types from `@purin-labs/collaboration`, and keeps its own protocol files |
| A value helper            | `@purin-labs/std`, `@purin-labs/type-utils` and `@purin-labs/contract-schema`                                                                                                                                                                                                                                                          |

## Contracts

This subsystem has no D1 table, no Actor SQLite table, no route, no event, no capability
and no agent tool. Its contracts are these files:

| File                                                                        | What it holds                                                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `repo-binaries.json`                                                        | The bucket, and each large file and folder with its SHA-256 and size                                             |
| `scripts/layers.json`                                                       | `covers`, `layers`, `foundationOrder`, `packages`, `contracts`, `mixed`, `placement`, `tables`, `rules`, `files` |
| `scripts/layers-ratchet.json`, `scripts/layer-debts-ratchet.json`           | The known crossings and debt counts, each with its reason and fix                                                |
| `scripts/file-size-ratchet.json`, `scripts/doc-links-ratchet.json`          | Each file over the limit with its lines, and each known broken link                                              |
| `scripts/clones-ratchet.json`, `scripts/unused-ratchet.json`                | The copies of each file pair, and the known unused files and exports                                             |
| `scripts/portal-fetch-ratchet.json`, `scripts/portal-requests-ratchet.json` | The count of direct calls in each Portal file                                                                    |
| `.jscpd.json`, `knip.json`, `scripts/lib/source-roots.mjs`                  | The scan settings, the entry files and `SOURCE_ROOTS`                                                            |

- When a count falls, `lint:clones` and `lint:unused` **fail** until you run the script
  with `--update`. `lint:file-size`, `lint:layer-debts`, `lint:portal-fetch` and
  `lint:portal-requests` pass with a note. `lint:doc-links` passes, with a note when a
  listed link is gone.
- `lint:layers` passes with a note while a pair stays above zero. When a pair falls to
  zero, the lint fails until `--update`, because the written reason of the pair is stale.
- `--update` of the file size, unused and layer ratchets does not raise a count.
- `--update` of the clone ratchet does not raise the count of a listed pair. It records
  a new pair of two known files when the totals do not grow, because jscpd can report
  one copy between other files of the same group.
- `--update` of the doc link ratchet writes the current counts, so it can raise the
  count of a listed link. `--init` of each ratchet writes the baseline from the current
  tree, so it can raise a count.
- A file that only a tool starts, such as a new Worker entry, goes into the entry list
  of its workspace in `knip.json`. An export that something outside the import graph
  reads carries a `@public` tag with the name of the reader.

## Rules and limits

This subsystem has no role check. A person and an agent pass the same lints.

- A download from R2 needs a Wrangler sign-in or an R2 S3 key. A copy from the local
  cache needs neither. CI gives the S3 key from the secrets `R2_READ_ACCESS_KEY_ID`,
  `R2_READ_SECRET_ACCESS_KEY` and `R2_ENDPOINT`.
- An upload needs a Wrangler sign-in with write access. It does not use the S3 key.
- Secrets stay in `.env.local`, Wrangler secrets or the vault. Never commit a secret.

| Limit                                           | Value                               | Name                                           |
| ----------------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| Large source file                               | 3,000 lines                         | `LIMIT`, `scripts/check-file-size-ratchet.mjs` |
| Smallest copy that counts, in product code only | 70 tokens, weak mode                | `minTokens`, `mode`, `.jscpd.json`             |
| R2 transfers at one time                        | 8 (CI passes 16)                    | `--jobs`, `scripts/repo-binaries.mjs`          |
| R2 download tries                               | 4, with waits of 2, 8 and 30 s      | `DOWNLOAD_RETRY_DELAYS_MS`                     |
| A plan number                                   | At most three digits and one letter | `MENTION`, `scripts/check-plan-numbers.mjs`    |

- **File size scope.** The lint reads `.ts`, `.tsx`, `.mjs`, `.js` and `.css` under
  `SOURCE_ROOTS`, `.rs` under `crates/`, and `.mjs`, `.js` and `.py` under `scripts/`.
  It skips tests, bindings, generated files, `dist`, `public`, `vendor` and
  `packages/commerce-contracts/src/unicode-tables.ts`.
- **Tracked files only.** The file size, doc link and plan number lints read
  `git ls-files`. They do not see a new file until it is staged.
- **Information flow.** The lints do not read data. `lint:ifc-boundaries` guards the
  import boundary of source-derived content, and FND-07 owns that rule.
- **Out of scope:** a rewrite of the git history, a mass rewrite from `throw` to
  `Result`, and a move of Portal class components to hooks.

The boundaries to the neighbours:

- **ENG-01** records the decisions and **ENG-03** holds the names. The spec index gives
  testing to **ENG-04**.
- **FND-01** owns the two D1 databases and their patches. **FND-02** owns the Actor
  lifecycle, alarms and state machines. **FND-09** owns the tool catalog and its digest.
  **FND-10** owns the shared draft protocol. **FND-11** owns the contract packages.
- **COM-02** owns the commerce engine and `services/commerce/docs/spec.md`. **KIT-02**
  owns the physics bundles and pins. **PRT-01** owns the Portal components.
- **Refactor 17** stays a plan. It owns the folder moves of Stage B and
  `scripts/refactor-17/move-module.mjs`.

## Open work

**The folder moves (Refactor 17, Stage B).** Only the kernel is in its final folder. The
module `foundation/testing` is in the order and has no file. Many E2E journeys import
the inside of the Worker, so each module needs a `testing` entry or a lint exception.

**The rest of Plan 92.**

- Adapters for old stored shapes stay, and each deletion needs its own decision: the
  retired backend ids `picocodex` and `codex`, the commerce schema upgrades from version
  66, the opener of multi-tray files (`rehearsal-conversion.ts`, versions 1 to 4), and
  the D1 `CHECK` lists that name the actor kinds `surface` and `thread`.
- The Code Mode receipt keeps `workspaceExecutorUsage` and `workspaceRevisionReceipt`.
- The Plan 33B supplier payouts stay in `payouts/`, by the owner's decision.
- `DeviceFleetActor.clearTerminalResultUnknown` has no caller. Plan 90 decides if an
  operator action needs it.
- Batch E of the test sweep, the large cuts in money-path test files, is not done.
  Plan 92 lists the product code that has no test.

**The known debt.** The ratchet files list the files over 3,000 lines, the copies, the
unused exports and the broken links. Each kind of layer debt needs a fix or a written
acceptance before Stage B moves its files.

**Gaps in the lints.**

- `lint:plan-numbers` does not read a mention just before a period, such as "Plan 97."
- `lint:file-size` does not read `.ts` or `.cjs` files under `scripts/`.
- `lint:layers` finds a package by its folder name, so it does not see an import of
  `@purin-labs/commerce-worker`. `lint:runtime-boundary` refuses that import outside
  the commerce code.
- CI does not run Prettier, and the ESLint style rules apply only to
  `services/platform/src/provider-workflows`. The pre-push hook is off in a new clone.
- `lint:runtime-boundary` looks only for `.prepare(` in a route file. Route files still
  run D1 writes with `.batch(`, on statements that helpers prepare.
- No CI step runs `probe-write`, so no check proves that the `R2_READ_*` key cannot
  write. This spec does not confirm that the key can read the bucket of the new stack.

## Sources

- [Code style](../../code-style.md), [Refactor 10](../../history/refactor-10.md) and
  [Plan 92](../../history/plan-92-new-pantry-repository.md). Where they differ from the code,
  this spec follows the code.
- Background: [Refactor 17](../../refactor-17.md), [the module list](../../layers.md),
  the [spec index](../README.md) and [`AGENTS.md`](../../../AGENTS.md).
- The evidence of Refactor 10 in the archive:
  - [baseline](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/baseline.md), [two databases](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/d6-two-database-run.md), [routes and gateway](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-3-routes-and-gateway.md)
  - Tools: [pilot](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-pilot.md), [context](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-tool-context.md), [family 5b](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-family-5b.md), [family 6](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-family-6.md), [family 7](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-family-7.md), [facade](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-facade.md), [Session handlers](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-session-handlers.md)
  - Actors: [placed actor](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-placed-actor.md), [alarms](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-alarm-scheduler.md), [schemas](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-schema-migrations.md), [Session split](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-session-split.md), [actor splits](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-actor-splits.md), [parser contracts](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-parser-contracts.md)
  - Portal: [simulation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-simulation-package.md), [settings](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-settings-split.md), [split](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-portal-split.md), [sweep](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-portal-sweep.md), [playback](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-playback-controller.md), [typed reads](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-typed-reads.md)
- This subsystem has no product journey. The lints are its checks. Plan 92 names these
  journeys in `services/platform/tests/e2e/`: `case-context-discovery-access.test.ts`,
  `whatsapp-erasure.test.ts`, `session-quarantine-end.test.ts` and
  `pi-sdk-actor.test.ts`. The Kitchen journey index is
  `scripts/production-simulation/journeys.json`.
