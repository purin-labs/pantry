# Refactor 10 — One definition for each concern, smaller modules

Date: 2026-11-04.
Status: complete on `dev`, 2026-11-06 (`ad766f253`). Steps 0A to 5 are done,
and no task is open. The E2E suite runs on two databases only: all 212 files
pass, and all 639 unit test files pass
([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/d6-two-database-run.md)). `pnpm lint:file-size`
passes: no file over 3,000 lines grew. Pushed to `origin/dev` and released on
2026-11-06 with the owner's approval: six Workers from `68043b231` (satyr-edge
`bd756c3f`). Health checks pass, and one live Portal chat turn passed: the
agent read the order queue through Code Mode and changed nothing. No live Slack
turn ran: this machine has no Slack user token. The user accepted the defaults of the
decisions on 2026-11-04 ("let's implement the plan"). The
[review](#review-on-2026-11-04) lists what the review changed. The
[baseline](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/baseline.md) records the checks on `dev` before
any change.

This refactor changes no product behavior. It makes a new feature cheaper to add and
safer to change. Each task lands on `dev` as soon as it passes its checks.

## Why

The architecture review on 2026-11-04 measured these facts:

- **A new agent tool touches about 9 files and about 20 places.** The trace of
  `order_queue_advance` touches `harness-tool-catalog.ts` in 12 places,
  `embedded-harness-tool-host.ts`, `pi-tool-replay.ts`, `agent-session.ts` in 3 places,
  `capability-catalogue.ts`, `requestable-capabilities.ts` and
  `policy/information-flow/sinks.ts`. Each tool has a hand-written JSON schema for
  the model and a second, hand-written parser for the same arguments. The two
  copies already disagree: the schema of `order_queue_advance` has a pattern for
  `fulfillmentId`, and its parser checks only that the string is not empty.
- **The files that change most are the largest files.** In the last 60 days:

  | File | Lines | Commits |
  | ---- | ----: | ------: |
  | `services/platform/src/actors/agent-session.ts` | 18,888 | 176 |
  | `apps/portal/src/portal.tsx` | 7,601 | 117 |
  | `services/platform/src/actors/harness-tool-catalog.ts` | 9,414 | 111 |
  | `apps/portal/src/features/chat/route.tsx` | 4,493 | 96 |
  | `services/platform/src/control-router.ts` | 645 | 94 |
  | `services/platform/src/control/routes/commerce.ts` | 6,594 | 78 |
  | `apps/portal/src/pages/settings.tsx` | 11,422 | 72 |
  | `services/platform/src/integration-gateway.ts` | 11,467 | 70 |

  About 6,900 lines of tool executors sit inline in `agent-session.ts` (lines 8226
  to 15114). One method, `runCanonicalEmbeddedHarnessTurn`, has about 1,200 lines
  and 59 tool bindings.
- **The actors repeat their lifecycle.** `SessionDO`, `OrganisationDO`, `ConnectorDO`
  and `CaseDO` each write their own `activate`, `exportPlacementState`,
  `importPlacementState`, `eraseInactivePlacementState`, `inspectRelocationReadiness`
  and quiesce method. They schedule alarms in 4 different ways, from 17 call sites.
  They keep 2 journals and migrate their SQLite schemas in 2 different ways.
  `ConnectorDO` and `CaseDO` hold about 105 hand-written request parsers.
- **Some dependencies point the wrong way.** `OrganisationDO` imports 9 route
  modules. `control/routes/commerce.ts` exports `executeCommerceAction`, which
  returns an HTTP `Response`, and Slack code uses it. Route files contain 32 direct
  D1 queries. 15 scripts import a file from the Portal app.
- **The test schema is a third copy, and it is wrong.** Tests load
  `services/platform/migrations/0001_current_schema.sql`, which a person keeps in
  step with the global and regional baselines. The table `control_mutation_receipt`
  has two different definitions: the global one has a foreign key to `app_user`,
  and the regional one has none. The combined copy has only the global one.
- **The Portal holds domain code.** 83 files (27.7k lines) in `workflow-simulator`
  and `production-run` contain no React, Three.js or DOM code. The same kinematics
  functions are copied into 8 scene files, and the same playback controller into
  8 view classes. `portal.tsx` chooses the page with 35 ternaries and holds 87
  control calls and 55 parse functions.
- **Packages copy code or have misleading names.** About 72% of the source lines in
  the 7 `*-crdt` packages have a twin in another CRDT package. `@satyr/bakery-model`
  contains the BakeryOS model and no Underclerk client code.
- **The repository carries large binaries.** Tracked files larger than 1 MB total
  about 770 MB:

  | Area | Size | Files |
  | ---- | ---: | ----: |
  | `apps/portal/public/bakery-physics/bundles` | 423 MB | 16 bundles of about 21 MB |
  | `docs/equipment` (vendor manuals) | 270 MB | 54 |
  | `docs/evidence` | 72 MB | 27 |

  9 of the 16 physics bundle hashes do not appear in source code. Each physics
  rebuild adds a new 21 MB bundle. `docs/evidence` also holds 123 MB in 2,387 files
  smaller than 1 MB. The git pack is 9 GB. `tmp/` holds 2 GB and is not ignored.

## Rules for every step

- **No behavior change.** A step that must change behavior stops, and the change
  goes to its owning plan.
- **Keep the wire values.** Do not change these:
  - tool names, capability ids, and the rerun rule of each tool
  - journal and receipt kinds
  - Durable Object class names, RPC method names and SQLite table names
  - the actor export envelope and its version
  - Pi checkpoint fields
  - CRDT frame bytes
  - D1 table names

  Old and new Worker versions run at the same time during a deploy. Pi journals
  replay tool calls by name.
- **One branch.** Work on the branch `refactor-10`. Land each verified task on
  `dev` with a fast-forward. Stage explicit paths, because another session edits
  the same checkout.
- **Moves are scripts.** Write each mechanical move (a file move, an import rewrite,
  a rename) as a script that can run again. If `dev` moves during the work, run the
  script again on the new `dev`. Do not merge a moved file by hand.
- **Start from a clean file.** Do not start a task on a file that has uncommitted
  changes from another session. On 2026-11-04, `apps/portal/src/portal.tsx` and
  `apps/portal/src/route.ts` have such changes.
- **No unit tests.** Use the type checks, the existing E2E journeys and the Portal
  browser journeys. If a step moves code that no journey covers, add one
  medium-hard journey for it first. Each step leaves a small, repeatable text
  artifact in `docs/evidence/refactor-10/`.
- **Keep the old path until production proof.** If a step changes a runtime path,
  one real production turn on the new path must pass before the old path is
  deleted.
- **One-way changes come last.** A deletion of stored data or a move of files out of
  git is the last task of its step. Each other task can be reverted with one
  `git revert`.
- **No adapters for old data.** If a move breaks stored test data, propose a
  deletion. Do not add a recovery path.
- **The size of a large file can only go down.** Step 0 adds a lint that refuses
  growth of the listed files.

## Steps and status

| Step | Scope | Depends on | Status |
| ---- | ----- | ---------- | ------ |
| 0A | Baseline, ignore rules, file size lint, dead scripts | — | Implemented, 2026-11-04 |
| 0B | Large binaries out of git | 0A, D1 | Done 2026-11-04: documents in R2 (366 MB); physics bundles stay in git |
| 1 | One module for each agent tool | 0A | Done 2026-11-06: pilot released, reads and a write proven in production; families 2 to 7, the facade removal, the handler move and `ToolContext` on `dev` (97 tools; `agent-session.ts` 18,848 to 10,902 lines) |
| 2 | Shared actor lifecycle, then split the four large actors | 1 | Done: released 2026-11-05; the TypeBox parser contracts landed 2026-11-06 |
| 3 | Dependency direction, domain folders, two test databases | 2 for the actor imports | Done 2026-11-06: tasks 1 to 6 on `dev`. The E2E suite runs on two databases only, and the combined schema is gone |
| 4 | Portal: simulation code out, pages and transports into features | 0A, clean Portal files | Done 2026-11-06: no raw control `fetch` in the Portal, 308 parsers in `@satyr/control-api`; the playback, empty state and dialog exceptions are recorded |
| 5 | Packages: the BakeryOS model name and one CRDT protocol | 0A | Done 2026-11-06: `@satyr/bakery-model`, and one CRDT protocol in six of seven packages; the workflow canvas stays |

Steps 1 and 2 both edit `agent-session.ts`, so they run one after the other.
Steps 0B, 4 and 5 touch other files and can run beside steps 1 to 3.

### Step 0A — Baseline, ignore rules, file size lint, dead scripts

1. **Baseline.** Before any change, record the results of these checks on `dev` in
   `docs/evidence/refactor-10/baseline.md`: `check:types`, `check:test-types`, the
   platform test suite with its known failures, the E2E suite, `pnpm portal:build`,
   `cargo test --workspace` and `pnpm lint`. A failure after a move is then easy to
   attribute.
2. **Ignore rules.** Add `tmp/` and `MUJOCO_LOG.TXT` to `.gitignore`.
3. **Dead scripts.** Delete `scripts/legacy-import-thread-keys.mjs`,
   `sign-slack-fixture.mjs` and `verify-ecommerce-browser.js`. No file names them.
   Keep the plan folders (D2).
4. **File size lint.** Add `scripts/check-file-size-ratchet.mjs` and a baseline
   file. The lint fails when a listed file grows past its baseline. When a file gets
   smaller, the baseline moves down. Generated files are not listed. Run it in
   `pnpm lint`.

Done: the baseline is recorded, and the lint runs in `pnpm lint`.

Result, 2026-11-04: the lint lists 32 files over 3,000 lines, and it refuses one
added line in `agent-session.ts`. `AGENTS.md` states the rule. The baseline on
`dev` is red before any change: 2 type errors, 3 lint errors and 20 unit failures in
9 files. A refactor task must not add a failure.

### Step 0B — Large binaries out of git

Result, 2026-11-04: the user asked for the bucket. `satyr-repo-binaries-apac` (APAC)
holds 133 files, 366 MB: every PDF in `docs/equipment` and `docs/evidence`, and each
other file there that is larger than 1 MB. `scripts/repo-binaries.mjs` uploads, fetches
and checks them by SHA-256, and it writes their `.gitignore` block. Git no longer
tracks them. Two changes to the tasks below:

- Physics bundles stay in git. CI (`.github/workflows/satyr.yml`) reads the pinned
  bundle from its checkout, and the owner does not want more GitHub secrets
  (2026-11-04). Each physics rebuild still adds about 21 MB to the history.
- No bundle is deleted. `scripts/bakery-robots/retain-appliance-builds.mjs` keeps old
  bundles on purpose: saved runs pin the bundle that they ran on. Task 4 is dropped.

1. **Physics bundles.** Keep only the bundles that source code names. Put them in an
   R2 bucket under their hash. `pnpm portal:build` and the verification scripts in
   `scripts/production-simulation` fetch a bundle by its hash and check its SHA-256.
   A physics rebuild uploads the new bundle and changes only the pin.
2. **Vendor manuals.** Move `docs/equipment/` to R2. Keep a manifest with the path,
   size and SHA-256 of each file, and add a fetch script.
3. **Evidence.** Move only the evidence files larger than 1 MB (72 MB in 27 files).
   45 scripts and tests name paths in `docs/evidence`, and the status ledgers link
   to evidence files. A link to a moved file points to its manifest entry.
4. **Last task.** Delete the 9 bundles that no source code names, after a search in
   scripts, configs and docs. Do not rewrite git history (D1).

Done: no tracked file is larger than 5 MB, and a new clone builds the Portal.

### Step 1 — One module for each agent tool

Target shape: each tool is one `defineTool` value in a family module under
`services/platform/src/agent-tools/`. One registry array lists all the tools.
Appendix B1 shows the code.

Each tool definition holds:

- the name and the description
- the input as a TypeBox schema, which is also the JSON schema for the model
- the capability that the tool uses
- the effect: read, write or proposal
- the rerun rule (`any_caller`, `script` or `none`), with its reason
- the selection rule: when a turn offers the tool
- the `execute` function

These parts derive from the registry, and no person writes them by hand:

- the model tool definitions and the tool name union
- the argument check (`Value.Check` replaces the hand-written parsers)
- the effect classification, and the capability and scope maps
- the rerun rule in `pi-tool-replay.ts`
- the dispatch in `executeNativeCatalogTool`, which becomes a map lookup
- the per-turn selection in `selectCatalogDefinitions`

These files stay by hand, because they are security policy that a person reviews:

- `authorization/capability-catalogue.ts`: the capability rows that production
  policy uses
- `policy/information-flow/sinks.ts`: the information-flow class of each
  capability. `pnpm lint:ifc-boundaries` reads this file as text.

A tool that uses an existing capability then needs one module and one registry
line. A tool with a new capability also needs one catalogue row and one sink class
entry.

Two kinds of tools are dynamic, and they stay dynamic sources beside the registry:

- the custom connector tools, one for each connector operation
- the permission request tool, whose description lists the missing capabilities

`SessionDO` builds one typed `ToolContext` for each turn. This replaces the 59
`.bind(` calls in `runCanonicalEmbeddedHarnessTurn`. Done 2026-11-05: 48 handlers take
one `SessionToolContext` (`agent-tools/context.ts`), and 25 calls that bind other
values remain ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-tool-context.md)).

**Facade.** 27 files import `harness-tool-catalog.ts`, among them Code Mode
admission, `pi-durable-tools.ts` and the Code Mode settlement. During the move,
`harness-tool-catalog.ts` keeps the same exports and reads both the registry and
the old definitions. When the last family moves, the importers change to
`agent-tools/` and the facade goes.

**New tools.** When the pilot family lands, `AGENTS.md` tells every session to add
a new tool to the registry. Tools that other sessions add during the move then do
not need a second move.

Tasks:

1. **Inventory.** List each tool with its family, capability, rerun rule, selection
   rule and the journeys that call it. Today only 6 chat-agent journeys exist:
   order queue (2), order read, permission request, recipes and suppliers, and
   stock report. For each family without a journey, add one medium-hard journey
   before its move.
2. **Pilot family.** Move order queue, sold out and payments.
3. **Production proof.** Ship the pilot. One real chat turn with
   `order_queue_advance` must pass before other families move.
4. **Other families**, one in each landing:
   1. Recipes, costs and suppliers.
   2. Devices.
   3. Drafts: workflow canvas, recipe workflow, product description, menu, email and
      production plan.
   4. Mail, Slack and WhatsApp.
   4b. The last static tools (17): the saved run read, Airtable, the integration
      list, the merchant report, the seven commerce proposals, the file and
      workspace reads, and the message attachment and link reads.
      `commerce_entity_context` (its own result shape) and
      `workspace_product_folder_update` (a Code Mode claim and effect) stay in the
      catalog until the facade goes.
   5. The bakery surface (38 tools). Done 2026-11-05
      ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-family-6.md)): the move changes only
      Platform files, so it did not wait for step 4.
   6. Memory, follow-up, side Case and permission tools. Done 2026-11-05 for the
      first three ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-family-7.md)); the
      permission tool stays dynamic.
5. **Remove the facade.** Done 2026-11-05: `harness-tool-catalog.ts` is split into
   `agent-tools/catalog/` (`types`, `selection`, `execute`, `code-mode`, `permission`,
   `custom-connectors`), made by `scripts/refactor-10/split-module.py`, and its 38
   importers import from there ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-facade.md)).

Checks for each family:

- `check:types` and `check:test-types` pass, and `pnpm lint:ifc-boundaries` passes.
- The chat journeys of the family pass, including a person without the right, who
  stays refused.
- A one-time script prints the model tool definitions before and after the move, as
  canonical JSON with sorted keys. The two outputs must be equal. TypeBox writes the
  keys in a different order, and `Type.Union` of literals writes `anyOf` instead of
  `enum`. Use a `stringEnum` helper (`Type.Unsafe` with `type` and `enum`) to keep
  the old shape.
- The same script runs the old parser and the new check on a set of argument
  values: the values from the journey fixtures, and edge cases for each field. It
  prints each value that one accepts and the other refuses. Each difference needs a
  decision in the evidence file. The expected case is the `order_queue_advance`
  pattern: the schema is the stricter rule, and the model's strict mode already
  applies it.
- A tool that keeps its old parser as `decode` is `decodeOnly`: the parser is the
  only check, as before the move. The strict schema makes the model send each
  field, but a Code Mode script may leave out a field that the parser lets it omit,
  so the schema is not the call contract of such a tool
  ([family 5b](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-family-5b.md)). A tool gets the schema
  check when a person writes its input as a TypeBox schema.

Digest: the session pins a `toolCatalogDigest`, which is the SHA-256 of the JSON of
the selected definitions. `modelToolDefinition` keeps the old key order, so a move
keeps the digest. Each family landing must print the same digests before and after
the move with `scripts/refactor-10/run-ts.sh scripts/refactor-10/catalog-digest.ts`.
The pilot kept them ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-pilot.md)).

Done:

- A tool that uses an existing capability needs one module and one registry line.
- `harness-tool-catalog.ts` is deleted.
- `agent-tools/registry.ts` has less than 500 lines.
- `agent-session.ts` is about 7k lines smaller. Done 2026-11-05: 18,848 to 11,215 lines
  ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-1-session-handlers.md)).
- The "Agent access to features" section of `AGENTS.md` names the registry.

### Step 2 — Shared actor lifecycle, then split the four large actors

1. **Spike.** In local workerd, check that Durable Object RPC reaches a method that
   an actor inherits from a base class. If it does, use a base class
   `PlacedActor`. If it does not, use one lifecycle object and thin delegate
   methods. The RPC names stay the same in both cases. Done 2026-11-05: RPC reaches
   methods inherited through two classes, and an override of a hook is used
   (`node scripts/refactor-10/step-2-rpc-spike/run.mjs`, miniflare 4.20260701). The
   step uses the base class.
2. **Lifecycle module.** Add `actors/lifecycle/placed-actor.ts`. It owns these parts:
   - the constructor schema setup for activation, import and barrier
   - `activate`
   - the frame of export, import and erase
   - `inspectRelocationReadiness`
   - quiesce

   Each actor gives only its state hooks: `referencedArchiveKeys`, `exportState`,
   `importState` and `quiesce`. The export envelope and its version do not change.
   Done 2026-11-05: the four actors extend `PlacedActor`; the hooks are
   `acceptsActivation`, `quiesceForExport`, `referencedArchiveKeys`, `prepareExport`,
   `importSqlMigration` and `prepareErasure`. The Organisation keeps its own export
   and import frames ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-placed-actor.md)).
3. **One alarm scheduler.** Each reconciler gives a name, `nextDue()` and `run()`.
   `nextDue()` reads the reconciler's own durable state, so the stored rows are the
   one source of truth.
   - `alarm()` runs the reconcilers that are due, in the order of today, and then
     calls `rearm()`.
   - `rearm()` sets the alarm to the earliest `nextDue()`.
   - Code that stores new work calls `rearm()`. No code calls `setAlarm` or
     `deleteAlarm` directly, so no path can remove an alarm that another path needs.

   This replaces `scheduleSessionAlarm`, `armConnectorAlarm`,
   `recomputeOrganisationAlarm` and the 17 direct alarm calls in the four actors.
   Done 2026-11-05 for Case, Organisation and Connector, and `scheduleSessionAlarm`
   is gone (`actors/lifecycle/actor-alarm.ts`). The Session's recovery jobs keep
   their own alarm until the Session split (task 5). The lifecycle keeps its own
   calls: erasure, import and recovery admission
   ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-alarm-scheduler.md)).
4. **One schema migration path.** All actors use `schema-migrations.ts`. The ad-hoc
   `ensure*Column` calls in `case.ts` go. As the last task of this step, the legacy
   migrators and the `backfillLegacyJournalAuthorityScopes` read path go (D3).
   Done 2026-11-05: a plan has a baseline and the steps after it. The Commerce
   plans are squashed to frozen DDL, the Session and the Case have plans, and every
   legacy migrator is gone, about 3,200 lines
   ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-schema-migrations.md)).
5. **Split `SessionDO`.** After step 1, about 12k lines remain. Move these parts to
   their own modules: transient turns (email, eval, mail assistant, WhatsApp), the
   bakery surface, attachment materialization, proposal staging, harness source
   preparation, and runtime source inspection. Target: `actors/session/session-do.ts`
   holds the class and its RPC methods, in less than 3,000 lines.
   Done 2026-11-05 for the split: `agent-session.ts` keeps the class, its RPC
   methods and `alarm` in 1,476 lines (the file name stays, so no importer
   changes). Six abstract layers in `actors/session/` hold the rest of the class,
   and 13 modules hold its functions
   ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-session-split.md)). The Session
   alarm keeps its nine `armAlarmBy` jobs by decision: `armAlarmBy` only moves the
   alarm earlier, so no job can remove another job's wakeup. The last hand-written
   copies of that rule are gone.
6. **Split the other actors.** In `OrganisationDO`, a command table replaces the 72
   `admittedX` pairs. `ConnectorDO` and `CaseDO` replace their about 105
   hand-written parsers with TypeBox contracts in `@satyr/contracts`.
   Done 2026-11-05 for the splits: no file in `actors/` is over 3,000 lines. The
   71 `admittedX` wrappers share one `command` helper instead of a table, which
   would change the RPC surface. `#` members stay in the top class
   ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-actor-splits.md)). Done 2026-11-06 for
   the contracts: the parsers check with TypeBox schemas in
   `@satyr/contracts/connector-rpc` and `@satyr/contracts/case-rpc`, and a parity
   script found no difference on 224,095 inputs
   ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-2-parser-contracts.md)).

Checks: the actor fault journeys pass. These are eviction, relocation, delayed
admission and revoked access. `test:onboarding-closure` and the Portal chat
journeys also pass. A production release runs one real Slack turn and one Portal
chat turn before the old alarm code is deleted.

Done: no actor file is larger than 3,000 lines, and the four actors share one
lifecycle and one alarm scheduler.

### Step 3 — Dependency direction, domain folders, two test databases

1. **Two test databases.** The E2E suite already has a two-database mode
   (`SATYR_REGIONAL_E2E=1` in `vitest.e2e.config.ts`), but no script runs it.
   1. Run the suite in that mode, and record each failure. A failure there is a
      test that production cannot pass, because production has two databases.
   2. Fix those tests or the code under them.
   3. Make the two-database mode the default, and delete
      `services/platform/migrations/0001_current_schema.sql`.
   4. Update the "Persistence" section of `AGENTS.md` (D6).
2. **Thin route files.** A route parses the request, checks authorization, calls one
   domain function and maps the result. Move `executeCommerceAction` to
   `commerce/actions.ts`. It returns a typed `Result`, not an HTTP `Response`. Move
   the 32 direct D1 queries in route files to `data/` modules.
3. **New boundary rule.** Extend `check-runtime-boundary`: code in `actors/`,
   `slack/` and `chat/` must not import `control/routes/`.
4. **Thin gateway.** `integration-gateway.ts` keeps only the `fetch`, `queue` and
   `scheduled` dispatch. The handlers move to provider modules, for example
   `shopify/webhooks.ts` and `slack-ingress/install.ts`.
5. **Domain folders.** Move the 99 root files into domain folders: `mail/`,
   `shopify/`, `stripe/`, `payouts/`, `messages/` and `models/`.
   - Use `git mv` and an import rewrite script in one commit with no other change.
   - The script also rewrites the paths in `scripts/check-*.mjs`, `AGENTS.md`, the
     IFC guide and the docs. `check-ifc-destinations.mjs` names 17 source paths.
   - Before this commit, tell the other session, because the commit conflicts with
     each open branch. Land it in one short window.
6. **Error rule.** Domain functions return `Result`. Code throws only for a
   programmer error. This rule applies to new and moved code. There is no mass
   rewrite. Done 2026-11-06: the rule is in `AGENTS.md`, beside the route
   rule, and `executeCommerceAction` follows it.

Status 2026-11-06, task 1 ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/d6-two-database-run.md)):
the E2E suite runs on two databases only: `DB` holds the global baseline and
each Organisation's database holds the regional one. All 212 files pass.
`services/platform/migrations/` is deleted. Unit tests and local harnesses
with one database load `singleDatabaseSchema()`, which
`services/platform/scripts/single-database-schema.mjs` builds from the two
baselines. All 639 unit test files pass.

Status 2026-11-05 ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-3-routes-and-gateway.md)):
tasks 2, 3 and 4 are done. `executeCommerceAction` returns a `Result` from
`commerce/actions.ts`; the route files run no D1 query; actors, Slack and chat
import no route file; `integration-gateway.ts` is 338 lines of dispatch. The
runtime boundary check refuses a new route import or route query. Task 1 follows
D6. Task 5 renames many files at once, so it waits for a window that the owner
agrees with the other sessions. (Superseded on 2026-11-06: task 5 and task 1
are done; see the status of task 1 below.)

Done: tests run on two databases as production does, no route file contains
business logic or D1 queries, no actor imports a route, and the platform root holds
only entry points and shared helpers.

### Step 4 — Portal

Start only when `portal.tsx` and `route.ts` have no uncommitted changes from another
session.

1. **Simulation code out.** Move the 83 pure modules into
   `packages/production-simulation`. These include `morning-shift-appliances.ts`,
   `simulator-state.ts`, the `*-model.ts` files and the command surface in
   `workflow-simulator/bakery-surface.ts`. Move each module with the modules that it
   imports. Put `quatRotate`, `quatMul`, `forwardKinematicsFr` and `solveFr` into
   one kinematics module. Move the execution bundle manifest into the package, so
   that no script imports a file from the app.
2. **One playback controller.** It replaces the 8 copies in the recipe view
   classes.
3. **Split the settings page.** `pages/settings.tsx` becomes
   `features/integrations/` with one module for each area: Gmail, Slack,
   WhatsApp, Codex, inference, mailbox and workspace.
4. **A page table renders the page.** `route.ts` stays data only, because
   `early-reads.ts` and `bootstrap.tsx` import it before the page code loads. A new
   file `pages.tsx` holds `Record<WorkspaceDetailPage, PageEntry>`, so the type check
   refuses a page with no entry. The 35 ternaries in `ControlPortalApp` go. The
   transports and the parse functions in `portal.tsx` move to their features.
5. **Typed reads.** A feature reads the control API only through
   `controlRead`/`controlMutation` and the `@satyr/control-api` parsers. This
   replaces the 87 raw `fetch` calls and the 342 local parsers where they read the
   control API.
6. **One copy of each primitive.** Keep one `EmptyState`, one dialog and one money
   formatter. Change the other uses when their file moves.

Checks: `pnpm portal:build` passes, the 5 `.test.mjs` files in `workflow-simulator`
pass, and the browser journeys of each page that moves pass. Take before and after
screenshots of each page, and keep their hashes in `docs/evidence/refactor-10/`.

Done: `portal.tsx` holds the shell state and no feature transports, and no Portal
file has pure simulation code.

Status 2026-11-06: step 4 is done. Tasks 1, 3 and 4 have this evidence
([simulation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-simulation-package.md),
[settings](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-settings-split.md),
[portal.tsx](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-portal-split.md),
[sweep](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-portal-sweep.md)). The survey finds no pure
simulation module left in the Portal: the 99 that stay use React, Three.js, a
browser global or a Vite asset import, or import a module that does.

Task 2: six recipe views share one playback controller; siphon and cafe shift
keep their own, because their playback rules differ
([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-playback-controller.md)). Task 5: all
72 raw calls to the control API go through the control client, and `pnpm
lint:portal-fetch` refuses a new one. The 308 parse functions that read a
control API answer are in `@satyr/control-api/portal/*` (52 modules). The 20
that stay in the Portal read forms, routes, scenes, browser messages and
markdown ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/step-4-typed-reads.md)). Task 6: the five money
formatter copies that gave the same text are two shared formatters (parity:
`money-parity.mjs`). The two empty states look different, so they stay until
their files move; the Portal has one dialog helper (`syncDialog`).

### Step 5 — Packages

1. **The BakeryOS model name.**
   1. Change the 154 imports of the root of `@satyr/bakery-model` to
      `@underclerk/client`, and delete the root re-export.
   2. Rename the package to `@satyr/bakery-model` (D4).
   3. Rewrite the 332 subpath imports with a script.
2. **One CRDT protocol.** Move the shared parts into `packages/collaboration`, with
   generic types for each document schema. The shared parts are the `FRAME_`,
   `SOCKET_`, `PRESENCE_` and `POINTER_` constants, the client and server message
   parse and encode functions, and `createEmptyDocument`, `cloneDocument`,
   `validateDocument` and `#replace`. Each `*-crdt` package keeps only its schema
   and its domain operations. `workflow-canvas-crdt` merges `protocol.ts` and
   `draft-protocol.ts`.

Checks: the frame bytes must stay identical, because live clients and stored
documents use them. The encode functions must write the fields in the same order. A
one-time script encodes a fixed set of messages and documents with the old code and
with the new code, and compares the bytes. The Plan 40C multiplayer journeys and the
existing CRDT tests pass.

Done: the CRDT packages copy no protocol code, and no package name says Underclerk
unless the package is Underclerk code.

## Not in this refactor

- Class components to hooks in the Portal. The gain does not pay for the risk.
- A mass rewrite from `throw` to `Result`. Step 3 sets the rule for new code only.
- A git history rewrite (D1).
- A split of `apps/storefront/src/storefront.tsx`. It is a demo storefront with a
  fixed merchant. Split it when it becomes a product surface.
- The Underclerk `commerce-authority.ts` facade (204 one-line delegations). It is
  large but simple, and it changes little.

## Size targets

| File | Now | Target |
| ---- | --: | -----: |
| `actors/agent-session.ts` | 18,888 | `session/session-do.ts` < 3,000 |
| `actors/harness-tool-catalog.ts` | 9,414 | deleted; registry < 500 |
| `actors/organisation.ts` | 8,229 | < 3,000 |
| `actors/connector.ts` | 7,638 | < 3,000 |
| `actors/case.ts` | 6,802 | < 3,000 |
| `integration-gateway.ts` | 11,467 | < 1,000 |
| `control/routes/commerce.ts` | 6,594 | < 2,000 |
| `apps/portal/src/portal.tsx` | 7,601 | < 2,500 |
| `apps/portal/src/pages/settings.tsx` | 11,422 | deleted; no module > 2,000 |
| Tracked files larger than 1 MB | about 770 MB | none larger than 5 MB |

## Decisions

- **D1. Large binaries.**
  - Recommendation: move the files to R2 with a manifest, and do not rewrite git
    history.
  - Cost: the pack stays at 9 GB. Step 0B stops the growth: today each physics
    rebuild adds 21 MB.
  - A rewrite saves at least 0.8 GB on new clones, but it breaks every clone, worktree
    and open branch, including those of the other session.
  - Default: R2, no rewrite.
- **D2. Plan scripts without a runner.** Decided in step 0A, 2026-11-04.
  - Keep every plan folder. Five folders changed in the last 4 days, and Plan 42H
    acceptance is still open. The plan docs and the evidence files name these
    scripts as their manual harnesses and repeat commands: for example, Plan 76
    uses `scripts/plan47/underclerk-upgrade-rehearsal`, and a runbook names
    `scripts/plan40/real-worker.mjs`. A `package.json` entry adds nothing to that.
  - Delete only the three root scripts that no file names.
- **D3. Legacy SQLite migrators in the actors.**
  - Recommendation: delete them as the last task of step 2.
  - Cost: an actor that has not started since the migration loses its old rows.
    Since the regional cutover, production holds only one Organisation. I did not
    check if all its actors have started since then.
  - Default: delete. First, list each actor class that still has a legacy table
    in production, and report it.
  - Closed 2026-11-05: none can. Every new shape shipped by 2026-10-06, and
    production storage started empty on 2026-10-09. Deleted in step 2.4.
- **D4. Name of the BakeryOS model package.**
  - Recommendation: `@satyr/bakery-model`. Code keeps the BakeryOS name.
  - Cost: one rewrite of the imports by a script.
  - Default: `@satyr/bakery-model`.
- **D5. The catalog digest at each step 1 landing.** Closed by the pilot,
  2026-11-04. A move keeps the digest, and the digest script checks each landing.
  A family that cannot keep the digest stops, and the user decides.
- **D6. Tests on two databases.** Measured 2026-11-04: 204 of 220 files fail. The shared fixtures are fixed (2026-11-05), but the rest needs work in each of about 190 files ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-10/d6-two-database-run.md)). The two-database mode became the only E2E mode on 2026-11-06 (step 3 task 1). Decided with the owner, 2026-11-05: a session that changes a test file moves that file to the Organisation's database (`organisationDatabase`, `fixtureDatabase`) in the same change.
  - Recommendation: make the two-database mode the default in step 3.
  - Cost: unknown until the suite runs in that mode. Each failure is a test that
    production cannot pass, or a bug.
  - Default: run the suite in that mode, report the count of failures, and wait for
    your word before the fixes.

## Review on 2026-11-04

The review checked the plan against the code. It changed these parts:

1. **Binary sizes.** The physics bundles are 423 MB, not 81 MB. Step 0B is new, and
   it keeps the used bundles in R2 by hash.
2. **Dead scripts.** The first list held active plans and live harnesses (D2).
3. **Schema equality.** A byte-for-byte check is not possible, because TypeBox
   writes the keys in a different order. The check now compares canonical JSON and
   the accept or refuse result of the parsers.
4. **Catalog digest.** Sessions pin a digest of the tool definitions. D5 is new.
5. **Information-flow class.** The class belongs to the capability in `sinks.ts`,
   and the IFC lint reads that file as text. The tool definition no longer names a
   sink. The capability catalogue and `sinks.ts` stay as reviewed policy files.
6. **Tool selection.** Each turn selects tools by capability, by bakery surface
   command and by four flags. Custom connector tools and the permission request are
   dynamic. The registry now has a selection rule and two dynamic sources.
7. **Facade.** 27 files import the catalog, among them Code Mode. The catalog stays
   as a facade until the last family moves.
8. **Test schema.** The combined schema could not be generated by a plain
   union, because `control_mutation_receipt` differs between the two baselines.
   The difference is only a foreign key to `app_user`. The E2E suite now runs on
   two databases (D6), and `singleDatabaseSchema()` builds the one-database
   schema for unit tests from the two baselines.
9. **Alarms.** The scheduler owns all 17 alarm calls, and the stored rows are the one
   source of truth. The first design could remove an alarm that another path needed.
10. **Page table.** `route.ts` stays data only, because the early reads import it.
11. **New rules.** These rules are new: a baseline before the work, moves as
    scripts that can run again, no start on a file with another session's
    uncommitted changes, one-way changes last, a journey for each tool family
    before its move, and new tools in the registry as soon as the pilot lands.

## Appendix A — Target layout

These trees show only the folders that the steps add or change.

### Platform (`services/platform/src`)

```text
services/platform/src/
├── integration-gateway.ts        fetch, queue and scheduled dispatch only (step 3)
├── agent-tools/                  step 1
│   ├── define-tool.ts            defineTool, ToolDefinition, stringEnum
│   ├── context.ts                ToolContext, built once for each turn
│   ├── registry.ts               TOOLS: the one list of all static tools
│   ├── dynamic.ts                custom connector tools, permission request
│   ├── derived.ts                model definitions, selection, rerun rule, capability and scope maps
│   ├── commerce/                 order-queue.ts, sold-out.ts, payments.ts
│   ├── kitchen/                  recipes.ts, costs.ts, suppliers.ts
│   ├── devices/                  devices.ts
│   ├── drafts/                   workflow-canvas.ts, menu.ts, email.ts, production-plan.ts, …
│   ├── channels/                 mail.ts, slack.ts, whatsapp.ts
│   ├── bakery-surface/           the 38 bakery surface tools
│   └── case/                     memory.ts, follow-up.ts, side-case.ts, permission.ts
├── authorization/
│   └── capability-catalogue.ts   stays: reviewed policy
├── policy/information-flow/
│   └── sinks.ts                  stays: reviewed policy, read by the IFC lint
├── actors/
│   ├── lifecycle/                step 2
│   │   ├── placed-actor.ts       activate, export, import, erase, relocation readiness
│   │   ├── alarm-schedule.ts     one scheduler for all actors
│   │   ├── schema-migrations.ts  one migration path for all actors
│   │   └── actor-export.ts, actor-relocation.ts, actor-journal.ts
│   ├── session/                  SessionDO
│   │   ├── session-do.ts         class and RPC methods, < 3,000 lines
│   │   ├── turn/                 admission, text turn, steer, cancel, stream
│   │   ├── checkpoint/           commit, restore, finalization, publication
│   │   ├── transient-turns.ts    email, eval, mail assistant, WhatsApp
│   │   ├── attachments.ts
│   │   ├── proposals.ts
│   │   ├── harness-source.ts
│   │   └── inspection.ts
│   ├── organisation/             OrganisationDO and its command table
│   ├── connector/                ConnectorDO; email/, slack/, whatsapp/
│   └── case/                     CaseDO and its contracts
├── control/
│   ├── router.ts
│   └── routes/                   parse, authorize, call one domain function, map the result
├── commerce/
│   └── actions.ts                executeCommerceAction, moved from control/routes/commerce.ts
├── mail/                         gmail-*, email-*, google-pubsub, mail-inbox/
├── shopify/                      connector, auth, webhooks, action-execution, acceptance
├── stripe/
├── payouts/                      payout-*, supplier-payout-*
├── messages/                     message-attachment-*, message-link-*, message-derived-stills
└── models/                       model-catalog, model-route, model-exit/, chatgpt-exit/

services/platform/migrations/     deleted in step 3 (2026-11-06); tests load the two real baselines
```

### Portal and packages

```text
apps/portal/src/
├── portal.tsx                    shell state only, < 2,500 lines (step 4)
├── route.ts                      page descriptors, data only
├── pages.tsx                     Record<WorkspaceDetailPage, PageEntry>
└── features/
    ├── integrations/             was pages/settings.tsx
    │   ├── gmail/  slack/  whatsapp/  codex/  inference/  mailbox/  workspace/
    ├── production-run/
    │   ├── shared/playback-controller.ts   one copy, was 8
    │   └── <recipe>/             physics-view.tsx and recipe-author.tsx only
    └── workflow-simulator/       React and Three.js views only

apps/portal/public/bakery-physics/bundles/   not tracked; fetched from R2 by hash (step 0B)

packages/production-simulation/src/
├── kinematics/                   quaternion.ts, fr-arm.ts (was 8 copies)
├── appliances/morning-shift.ts   was portal morning-shift-appliances.ts
├── floor/simulator-state.ts      was portal simulator-state.ts
├── surface/bakery-surface.ts     the Plan 81 command surface
├── recipes/<recipe>/model.ts     was portal <recipe>-model.ts
└── execution-bundle.ts           the manifest that scripts import

packages/collaboration/src/
└── sync-protocol.ts              one protocol for all 7 CRDT packages (step 5)

packages/bakery-model/            was packages/underclerk-client (@satyr/bakery-model)
```

## Appendix B — Code examples

These are sketches of the target code. The names of new modules can change during
the work. The wire values stay the same.

### B1. One agent tool (step 1)

Today the JSON schema for the model and the parser are two separate copies, and
they already disagree. The schema has a pattern for `fulfillmentId`. The parser
checks only that the string is not empty:

```ts
// harness-tool-catalog.ts, today
function parseOrderQueueAdvanceArgs(input: unknown): OrderQueueAdvanceRequest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["fulfillmentId", "action"]) ||
    typeof input.fulfillmentId !== "string" ||
    input.fulfillmentId.length === 0 ||
    !isOrderQueueAction(input.action)
  )
    throw new TypeError("order_queue_advance arguments are invalid");
  return { fulfillmentId: input.fulfillmentId, action: input.action };
}
```

After: one definition. The pilot family uses this shape: see
`services/platform/src/agent-tools/define-tool.ts` and
`agent-tools/commerce/order-queue.ts`. The schema is the structural check, and
`decode` holds the checks that a schema cannot state.

```ts
// agent-tools/commerce/order-queue.ts
export const orderQueueAdvance = defineTool({
  name: "order_queue_advance",
  description:
    "Move one order through the shop's order queue, as staff do on the order queue page. …",
  input: Type.Object({
    fulfillmentId: Type.String({
      pattern: ID_PATTERN,
    }),
    action: stringEnum(["start", "ready", "hand_over"]),
  }, { additionalProperties: false }),
  decode: (input) => ({
    fulfillmentId: input.fulfillmentId,
    action: input.action,
  }),
  capability: CAPABILITY_KEYS.commerceOrderQueueAdvance,
  effect: "receipt",
  rerun: {
    kind: "any_caller",
    reason: "A move has a receipt under the call's key, and the queue's stage refuses a step that already happened, so a repeated call moves nothing twice.",
  },
  selection: { kind: "capability" },
  unavailable: "order queue move is unavailable",
  handler: ({ advanceOrderQueue }) =>
    advanceOrderQueue === undefined
      ? undefined
      : (request, call) => advanceOrderQueue(request, call.operationId),
});
```

`sold_out_mark` shows a `decode` with rules that a schema cannot state:

```ts
decode: (input): SoldOutMarkRequest => {
  if (!input.soldOut) {
    if (input.timeZone !== null)
      throw new TypeError("sold_out_mark timeZone must be null to clear a mark");
    return {
      variantId: input.variantId,
      mark: { kind: "cleared" },
    };
  }
  if (!isIanaTimezone(input.timeZone))
    throw new ProposalArgumentError(
      "sold_out_mark needs the shop's IANA time zone, such as Asia/Tokyo. Ask the person if you do not know it.",
    );
  return {
    variantId: input.variantId,
    mark: { kind: "today", timeZone: input.timeZone },
  };
},
```

The catalog runs a registered tool in the same order as the old hand-written
cases. A missing handler fails first, then the arguments, then the capability
claim, so a refused call claims nothing:

```ts
// actors/harness-tool-catalog.ts, the facade during step 1
async function executeRegisteredTool(tool, authority, execution, input, callId) {
  const handler = tool.handler(authority);
  if (handler === undefined) throw new Error(tool.unavailable);
  const request = tool.parse(input);
  await claimDirectCapability(
    authority.claimCapability,
    callId,
    tool.capability,
  );
  return handler(request, {
    callId,
    operationId: logicalToolOperationId(execution, callId),
  });
}
```

`modelToolDefinition` writes each schema with `type`, `properties` and `required`
first and `additionalProperties` last. It adds `required: []` to an object schema
that has none. With this rule, the definitions keep the old bytes, and the catalog
digest does not change.

### B2. Shared actor lifecycle (step 2)

Today `SessionDO` and `CaseDO` each have a copy of `inspectRelocationReadiness`.
Only the list of R2 keys is different:

```ts
// agent-session.ts:1813 and case.ts:1170, today (nearly the same code)
async inspectRelocationReadiness(request: {
  readonly expectedFenceToken: ActorFenceToken;
  readonly stage: "preflight" | "quiescent";
}): Promise<Result<ActorRelocationReadiness, ActorExportError>> {
  const ready = inspectActorRelocationReadiness(this.ctx.storage, request);
  if (!ready.ok || ready.value.kind === "blocked") return ready;
  try {
    const keys = new Set([
      ...sessionPlacementR2Keys(this.ctx.storage.sql),
      ...sessionReachableAttachmentObjectKeys(this.ctx.storage.sql),
    ]);
    for (const key of keys) {
      if ((await this.env.ARCHIVE.head(key)) === null)
        return { ok: false, error: { code: "referenced_r2_missing", key } };
    }
    return ready;
  } catch (error) { /* … */ }
}
```

After: the frame is written one time. Each actor gives only its own state.

```ts
// actors/lifecycle/placed-actor.ts
export interface PlacedActorState {
  readonly schemaVersion: number;
  referencedArchiveKeys(): Promise<Iterable<string>>;
  exportState(request: ActorExportRequest): Promise<Result<ActorStateExport, ActorExportError>>;
  importState(request: ActorImportRequest): Promise<Result<null, ActorExportError>>;
  quiesce(): Promise<Result<null, ActorExportError>>;
}

export abstract class PlacedActor extends DurableObject<Env> {
  protected abstract readonly placement: PlacedActorState;
  protected abstract readonly alarms: AlarmSchedule;

  async activate(input: ActorActivationRequest): Promise<ActorActivationResult> {
    if (!(await admitActorActivation(this.env, input)))
      return { ok: false, error: { code: "activation_placement_conflict" } };
    if (input.schemaVersion !== this.placement.schemaVersion)
      return { ok: false, error: { code: "activation_conflict" } };
    return this.ctx.storage.transactionSync(() =>
      activateActor(this.ctx.storage.sql, input),
    );
  }

  async inspectRelocationReadiness(request: RelocationReadinessRequest) {
    const ready = inspectActorRelocationReadiness(this.ctx.storage, request);
    if (!ready.ok || ready.value.kind === "blocked") return ready;
    return requireArchivedKeys(this.env.ARCHIVE, await this.placement.referencedArchiveKeys(), ready);
  }

  async eraseInactivePlacementState(request: InactiveActorErasureRequest) {
    return eraseInactiveActorState(this.env, this.ctx.storage, request);
  }

  // exportPlacementState and importPlacementState call this.placement in the same way.

  async alarm(): Promise<void> {
    await this.alarms.run(Date.now());
  }
}
```

If the step 2 spike shows that Durable Object RPC does not reach inherited methods,
each actor keeps thin delegate methods with the same names, and the bodies stay in
one module.

### B3. One alarm scheduler (step 2)

Today `SessionDO.alarm()` calls 10 reconcilers in a fixed order, and 17 call sites in
the four actors set or delete the alarm directly. After: each reconciler reads its
own stored rows to say when it is due. Only the scheduler sets the alarm.

```ts
// actors/lifecycle/alarm-schedule.ts
export interface Reconciler {
  readonly name: string;
  // Reads the reconciler's own stored rows. Null when no work waits.
  nextDue(): number | null;
  run(now: number): Promise<void>;
}

export function alarmSchedule(input: {
  storage: DurableObjectStorage;
  beforeAdmission: readonly Reconciler[];
  admit: () => Promise<boolean>;
  afterAdmission: readonly Reconciler[];
}) {
  const all = [...input.beforeAdmission, ...input.afterAdmission];

  async function rearm() {
    const next = earliest(all.map((reconciler) => reconciler.nextDue()));
    if (next === null) await input.storage.deleteAlarm();
    else await input.storage.setAlarm(next);
  }

  async function runDue(reconcilers: readonly Reconciler[], now: number) {
    for (const reconciler of reconcilers) {
      const due = reconciler.nextDue();
      if (due !== null && due <= now) await reconciler.run(now);
    }
  }

  return {
    // Code that stores new work calls rearm(). Nothing else sets the alarm.
    rearm,
    async run(now: number) {
      await runDue(input.beforeAdmission, now);
      if (await input.admit()) await runDue(input.afterAdmission, now);
      await rearm();
    },
  };
}
```

```ts
// actors/session/session-do.ts
protected readonly alarms = alarmSchedule({
  storage: this.ctx.storage,
  beforeAdmission: [this.billing],
  admit: () => this.admitRecovery(),
  afterAdmission: [
    this.checkpointFinalization,
    this.runBudgetDeadline,
    this.workspaceCommitIntents,
    this.codeModeSettlements,
    this.endedExecutions,
    this.bakerySurfaceEffects,
    this.goalUsage,
    this.pendingPiTurn,
  ],
});
```

The list order is the run order, so the order of today stays the same. Because
`rearm()` reads the stored rows, it cannot remove an alarm that stored work still
needs.

### B4. A thin route (step 3)

Today `executeCommerceAction` lives in a route file and returns an HTTP
`Response` or a result. Slack code imports it from the route file:

```ts
// control/routes/commerce.ts:5374, today
export async function executeCommerceAction(input: …): Promise<
  Response | Readonly<{ kind: "done"; body: Record<string, unknown> }>
> { /* 363 lines */ }
```

After: the domain function returns a typed `Result` and knows no HTTP. The route
and the Slack approval both call it.

```ts
// commerce/actions.ts
export async function executeCommerceAction(
  input: CommerceActionInput,
): Promise<Result<CommerceActionDone, CommerceActionError>> { /* … */ }
```

```ts
// control/routes/commerce.ts
const result = await executeCommerceAction(input);
return result.ok
  ? jsonResponse(200, result.value.body)
  : commerceActionErrorResponse(result.error);
```

### B5. A page table renders the page (step 4)

Today `ControlPortalApp` chooses the page with 35 ternaries:

```tsx
// portal.tsx:3487, today
) : state.page === "menus" ? (
  <MenuDraftRoute organisationId={state.organisation.organisation.organisationId} />
) : state.page === "payments" ? (
  <PaymentsRoute
    key={state.organisation.organisation.organisationId}
    organisationId={state.organisation.organisation.organisationId}
  />
) : state.page === "payouts" ? (
  …
```

After: `route.ts` keeps the descriptors as data, because the early reads import it.
A new `pages.tsx` maps each page to its component. The `Record` type makes the type
check refuse a page with no entry.

```tsx
// pages.tsx
interface PageEntry {
  readonly component: React.LazyExoticComponent<React.ComponentType<any>>;
  readonly props: (page: PageContext) => object;
  readonly remountOn: "organisation" | "never";
}

export const PAGES: Record<WorkspaceDetailPage, PageEntry> = {
  payments: {
    component: React.lazy(loadPaymentsRoute),
    props: (page) => ({
      organisationId: page.organisationId,
    }),
    remountOn: "organisation",
  },
  payouts: {
    component: React.lazy(loadBankPayoutsRoute),
    props: (page) => ({
      organisationId: page.organisationId,
      integrationsPath: page.pathTo("integrations"),
    }),
    remountOn: "organisation",
  },
  // … one entry for each page
};
```

```tsx
// portal.tsx
const entry = PAGES[state.page];
const Page = entry.component;
return (
  <Page
    key={entry.remountOn === "organisation" ? page.organisationId : undefined}
    {...entry.props(page)}
  />
);
```

### B6. One CRDT protocol (step 5)

Today `parseMenuBoardClientMessage` and `parseMenuDraftClientMessage` are the same
30 lines. Only 4 names are different: the protocol id, the selection check, the
state vector parser and the update parser. After: one factory in `collaboration`.

```ts
// packages/collaboration/src/sync-protocol.ts
export function createSyncProtocol<Selection, StateVector, Update>(spec: {
  protocol: string;
  frameLimit: number;
  isSelection: (value: unknown) => value is Selection;
  parseStateVector: (bytes: Uint8Array) => Parsed<StateVector>;
  parseUpdate: (bytes: Uint8Array) => Parsed<Update>;
}) {
  return {
    parseClientMessage(frame: unknown): Parsed<SyncClientMessage<Selection, StateVector, Update>> {
      /* the 30 shared lines, written one time */
    },
    parseServerMessage(frame: unknown) { /* … */ },
    // Writes the fields in the same order as today, so the frame bytes stay the same.
    encodeClientMessage(message: SyncClientMessage<Selection, StateVector, Update>) { /* … */ },
    encodeServerMessage(message: SyncServerMessage<StateVector, Update>) { /* … */ },
  };
}
```

```ts
// packages/menu-board-crdt/src/protocol.ts
const menuBoardProtocol = createSyncProtocol({
  protocol: MENU_BOARD_PROTOCOL,
  frameLimit: FRAME_LIMIT,
  isSelection: isBoardSelection,
  parseStateVector: parseMenuBoardStateVector,
  parseUpdate: parseMenuBoardUpdate,
});

// The exported names stay, so no importer changes.
export const parseMenuBoardClientMessage = menuBoardProtocol.parseClientMessage;
export const encodeMenuBoardClientMessage = menuBoardProtocol.encodeClientMessage;
```
