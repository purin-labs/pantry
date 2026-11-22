# FND-01 — Tenancy and placement

Purin Pantry serves many Organisations from one set of Workers. An Organisation is the
tenant: each record, each Actor name and each object key belongs to one Organisation.
Each Organisation has a placement, which names the cell that holds its records and runs
its Actors. A cell is one regional D1 database and one location hint for Durable
Objects. One global D1 database holds identity, the ingress directory and the published
placement. Code names the database of each D1 handle in its type. An execution scope
gives a request the regional database and a fence, and a frozen placement refuses each
fenced write. An operator moves an Organisation to another cell with a relocation. An
Organisation where nothing changes costs close to nothing, and one E2E journey guards
that rule.

## What it does

### Where each record lives

One fact has one durable owner. A D1 projection has no authority because it is easy to
query.

| State | Authority |
| --- | --- |
| The directory copy of each Organisation, the published placement, people (`app_user`), control sessions, Slack installations and routing, the placement move journals | Global D1 (`DB`) |
| The Organisation's name and status, the execution fence, members, integration accounts, policy, agents, cues, Projects, the Actor registry | Regional D1 of the cell |
| Provider ingress identity, delivery attempts and receipts | `ConnectorActor` SQLite |
| Case purpose, journal, bindings, assignments, proposals, output outbox | `CaseActor` SQLite |
| Session contract, private history, budget, checkpoint, turn lease | `AgentSessionActor` SQLite |
| The Organisation record of the Actor (`organisation_meta`), commerce projections, cue claims, the action ledger | `OrganisationActor` SQLite |
| Checkpoints, attachments, workspace revisions, artifacts | R2 `ARCHIVE` |
| Compiled policy and cue snapshots | `POLICY_KV`, a cache of D1 records |
| The counts of ignored cues: one key for each Organisation, source, event type and hour, with at most 3 samples | `POLICY_KV`, for 30 days. No D1 record holds them (`cues/ignore-aggregate.ts`) |

Durable Object SQLite owns the hot state of its Actor. D1 owns control records,
registries and projections that code can build again. R2 owns large immutable bytes. KV
owns the caches of D1 records and the counts of ignored cues. A queue carries work, not
domain state.

### The two D1 databases

- The Worker binds the global database as `DB`. Its baseline is
  `services/platform/migrations-global/0001_current_schema.sql`, with 28 tables.
- The Worker binds one regional database for each cell: `ORGANISATION_DB_WNAM`,
  `ORGANISATION_DB_APAC` or `ORGANISATION_DB_EU`. A profile can also bind a cell to
  `DB` itself. The baseline is `migrations-regional/0001_current_schema.sql`, with 193
  tables.
- Each handle has a type (`foundation/kernel/database-handles.ts`). `GlobalDatabase`
  is `env.DB`. `OrganisationDatabase` is the regional database that the placement
  selected. A call that passes the wrong database is a type error.
- A brand is a type-only property. At run time, a handle is the binding itself.
  `sameBinding(a, b)` tells when a profile binds a cell to `DB`.
- `SingleDatabase` holds both schemas. Only unit tests make one, from
  `singleDatabaseSchema()` (`services/platform/scripts/single-database-schema.mjs`).
- The E2E suite loads the two baselines into two databases, as production does. An E2E
  file reaches Organisation records through `organisationDatabase(id)` or
  `fixtureDatabase()` (`tests/e2e/organisation-database.ts`).

Three tables are in both baselines. `services/platform/src/data/shared-rows/` holds each
write of them that has fixed SQL text. A statement for one database takes a typed
handle: `GlobalDatabase`, `OrganisationDatabase`, `GlobalQuerySource` or
`OrganisationQuerySource`. A statement that both databases get takes a plain
`QuerySource` or `D1Database`, and the caller selects the database. The regional copier
(`data/organisation-regional-copy.ts`) is outside the folder. It copies and deletes
`control_mutation_receipt` rows with SQL that it builds, by the rules of
`shared-rows/regional-copy-rules.ts`.

| Row | Source | Copy | How long the copies can differ |
| --- | --- | --- | --- |
| `organisation` at creation and at a Slack install | The request writes both | — | Until the request ends. If it stops after the regional commit, the next 15-minute onboarding run activates the global placement (`publishStoppedInitialPlacement`) |
| `organisation` name and status | Regional row | Global directory row | Until the request ends (`copyOrganisationRowToDirectory`). If that copy fails, the request still succeeds, and the next 15-minute run copies the values (`publishOrganisationDirectoryRow`) |
| `organisation` during a move | Source cell | Target cell | The move writes the target row before the copy of the other rows. Cleanup makes the old row blank. Routing reads the global placement |
| `organisation_placement` at creation and at a Slack install | The request writes both | — | The order is the reverse of a move. The request reserves epoch 1 in the global database, activates the regional row, and activates the global row last. If it stops before the last step, the Organisation does not route until the next 15-minute onboarding run |
| `organisation_placement` during a move | Global row: routing and publication | Regional row: the execution fence | The global row freezes first and publishes first. The regional row follows in the next step of the same move |
| `control_mutation_receipt` | — | No copy between the global and the regional database | A receipt is in the database of the effect that it records, in the same batch. Its replay reads that database. A move copies the receipts of the Organisation from the source cell to the target cell with its other rows |

A rename, an archive, a restore, a deletion and a purge write the regional
`organisation` row. The written status values are `active`, `deleted` and `purged`.

### Placement

- A placement has an epoch, a kind, a cell id and a location hint
  (`services/platform/src/placement.ts`). The kind is `affinity` or `residency`. A
  `residency` placement also has a jurisdiction: `eu` or `fedramp`.
- A cell id matches `^[a-z][a-z0-9-]{0,62}$`. A location hint is one of `wnam`, `enam`,
  `sam`, `weur`, `eeur`, `apac`, `oc`, `afr` and `me`.
- The variable `PANTRY_ORGANISATION_PLACEMENT_PROFILE` lists the cells. Each cell names
  its database binding. The first cell is the root cell, the onboarding default.
- Production has one cell: `production-apac`, kind `affinity`, hint `apac`, database
  `ORGANISATION_DB_APAC`. The local profile has three cells: `local-wnam`, `local-eu`
  and `multi-region-preview`, which uses `DB`.
- An Organisation that a signed-in person makes goes to the root cell
  (`organisation-access/creation.ts`). An Organisation that a Slack install makes goes
  to the deployed cell nearest to the request (`control/home-region.ts`).
- `readRequestLocation` (`control/home-region.ts`) reads the coordinates or the
  continent of `request.cf`. `nearestOrganisationPlacementCell` (`placement.ts`) orders
  the deployed cells by distance over the globe. The first deployed cell of the profile
  wins a tie and an unknown location.
- A deployed cell is a cell with a bound database. `GET /v1/control/home-regions` offers
  only the deployed cells. If no cell is deployed, it offers the root cell. For a
  profile that does not parse, it answers 503
  `organisation_placement_configuration_invalid`.
- The Slack ingress Worker (`services/platform/wrangler.slack-ingress.jsonc`) has its
  own copy of the profile and its own `DB` and `ORGANISATION_DB_APAC` bindings. Its
  check and its deploy (`scripts/slack-ingress-worker.mjs`) refuse a copy that differs
  from the production profile of the platform Worker.
- An Actor stub uses the placement (`actors/actor-stubs.ts`). It passes the location
  hint, and a `residency` placement selects the jurisdiction namespace.

A placement row has one of five states. At most one row of an Organisation is `active`.

| State | Meaning |
| --- | --- |
| `reserved` | The epoch has a cell and a fence token, and it admits no work |
| `active` | The epoch admits work. Its row has `activated_at` |
| `frozen` | A move stopped new work in this epoch |
| `retired` | A publication replaced this epoch with the next one |
| `abandoned` | A move released this target epoch before publication |

Epoch 1 is the initial placement, and each move takes the next epoch. A row has a fence
token. The token of a move target starts with `tpf_`.

### The execution scope and the fence

`OrganisationExecutionScope` (`services/platform/src/organisation-execution-scope.ts`)
takes a request from an Organisation id to its regional database and its fence. The
same file has two more ways to a regional database, without a scope.

1. `resolve` reads the active placement from the primary of the global database.
2. It selects the database of the cell from the profile. A cell with no bound database
   gives `organisation_cell_unavailable`.
3. If the cell has its own database, it reads the regional row. The epoch, the cell and
   the fence token must match, and the row must be `active`. If not, the result is
   `organisation_placement_conflict`.
4. The scope holds the database, the placement, the fence token and the access checks
   of the Organisation.

- `resolveWithRead` joins one read to the regional placement row in one statement.
- `resolveAtPlacement` also requires that the caller's placement is the published one.
- `prepareMutationFence` gives a statement for the D1 batch of a write. If the placement
  is not active, the statement fails, and D1 rolls back the batch.
- `fetchWithOrganisationPlacement` checks the fence before and after a provider request.
  `dispatchWithOrganisationPlacement` checks it before the request only.
- The check of an Organisation control request (`authorizeOrganisationRequest`,
  `control/authorization.ts`) answers HTTP 409 with the code of the error when it cannot
  resolve the scope. The status is not the same on each path: `/v1/admin/person-roles`
  answers 503 with the same code.
- `selectOrganisationPlacementDatabase` gives the database of a placement that the
  caller holds. It makes no scope and reads no fence. Its callers include Actor
  activation, the bootstrap of a new Organisation, a relocation, a restore and the
  archive cleanup.
- `configuredOrganisationDatabases` lists each regional database, for code that has no
  Organisation id. Its callers include ingress that has only a provider identity, the
  scheduled runs and the reads of the grants of one person in each cell.

### A move to another cell

A relocation copies the Actors and the regional rows of an Organisation to a new cell. A
restore imports Actors from the exports of a retained relocation. Both are one machine
(`data/placement-move.machine.ts`), and an Organisation has one open move at a time.

| State | Meaning |
| --- | --- |
| `reserved` | The target epoch is reserved. The source still admits work |
| `frozen` | The source admits no new work. The move waits until the source is quiet |
| `copying` | A relocation exports the source Actors and copies the regional rows |
| `importing` | A restore imports the Actors of its manifest |
| `published` | The target is the active placement. The source Actors wait for retirement |
| `retained` | A relocation keeps the source copy as a recovery point |
| `cleaning` | A relocation erases the source copy and its exports |
| `quarantined` | An import failed for good. The source stays frozen |
| `complete` | The move ended |
| `abandoned` | The move ended without publication |

- If an earlier relocation of the Organisation is still `retained` or `cleaning`, a
  relocation start refuses its source cell as the target (`relocation_conflict`).
- A `retired` or `quarantined` Actor registry entry does not move. The start refuses
  each other entry that is not `active` (`relocation_inventory_changed`). It refuses an
  entry with a schema version above the version of the code
  (`target_schema_older_than_export`).
- The start also refuses provider work that is not resolved
  (`relocation_provider_work_unresolved`). It refuses when the two databases together
  reach the capacity limit (`regional_capacity_insufficient`) or give no size
  (`regional_capacity_unavailable`).
- The publication is one D1 batch in the global database. It retires the source row,
  activates the target row and moves the journal. Each write depends on the write
  before it.
- The first statement of the publication guards a relocation. The source is quiet, the
  data is verified, the count of verified table copies is the table count, and each
  item is `imported`. The freeze is less than 5 minutes old. A recovery relocation has
  no such limit.
- A regional freeze needs a quiet source. The source has no Actor reservation, no
  provider connection attempt in a callback or in provisioning, and no provider cleanup
  that runs. If the cell refuses the freeze, the move returns to `reserved` and the
  source admits work.
- An abandon never opens a frozen source again. It releases the target, reserves a
  recovery epoch in the cell of the source and starts a recovery relocation.
- An abandon of a move that is still `reserved` freezes the active source. The
  Organisation then admits no work until the recovery relocation publishes.
- A `resume` abandons a relocation that is still `frozen` or `copying` 5 minutes or more
  after its freeze. A recovery relocation has no such limit.
- A relocation keeps the source copy for 7 days. The operator can waive that time.
- Cleanup starts only when the retention ended or was waived, no restore of the
  Organisation is open and no provider work is unresolved.
- A restore start refuses when a relocation of the Organisation is open. It also
  refuses when a relocation that holds one of its exports is `cleaning` or `complete`.
- No cron drives a move. Each step runs when the operator sends a command.

### The cost of an idle Organisation

Each Organisation pays each recurring cost again. Cloudflare bills each written row of a
Durable Object and of D1, each queue message, each KV write and each R2 write.

- A run that finds no change writes nothing. Code compares before it writes. It records
  an audit row only when the run repairs something or fails.
- The rule in `AGENTS.md` gives the reason: Cloudflare stops an idle Durable Object
  after about ten seconds, and the next call starts it again. Thus the constructor and
  the first call of an object write nothing when its data is current.
- Before you add a cron trigger, an alarm, a poll or a queue retry, calculate its cost
  for one idle Organisation for 30 days. An alarm that arms itself again needs an end.
- The guard is `services/platform/tests/e2e/idle-tenant-cost.test.ts`. It runs each
  production cron trigger for one hour on a shop where nothing changes. It stops each
  object before each five minutes.
- `IDLE_HOUR_BUDGET` permits one line: 12 rows of `OrganisationActor` SQLite in one
  hour, for the time of the last check with the commerce engine. That is $0.009 for 30
  days.
- Each other line must stay at zero: D1 rows, queue messages, KV writes and R2 writes.
  An object start must write nothing, and no alarm of the idle hour is armed again.
- `USD_PER_MILLION` (`tests/e2e/write-meter.ts`) holds the list prices: rows 1.0, queue
  messages 1.2, KV writes 5.0 and R2 writes 4.5.

The production Worker has three cron triggers (`services/platform/wrangler.jsonc`,
`integration-gateway.ts`):

| Trigger | Work |
| --- | --- |
| `* * * * *` | Delivery of paid receipts |
| `*/5 * * * *` | Reconciliation of the commerce outbox, the backstop for a lost event |
| `*/15 * * * *` | Onboarding reconciliation, schedule dispatch, file context, attachment collection, payout reconciliation, the weekly ChatGPT sign-in refresh, the Actor registry |

## Contracts

- Global D1 tables of this module: `organisation`, `organisation_placement`,
  `control_mutation_receipt`, `app_user`, `control_session`, `state_object_relocation`
  and `state_object_restore`.
- Regional D1 tables of this module: `organisation`, `organisation_placement`,
  `control_mutation_receipt`, `person`, `service_role_grant`, `organisation_invitation`,
  `organisation_onboarding`, `onboarding_event`, `onboarding_audit_event`,
  `organisation_archive_cleanup`, `organisation_archive_tombstone`,
  `surface_installation` and `workspace_ai_budget`.
- `organisation`: `organisation_id`, `name`, `plan` (default `beta`), `created_at`,
  `organisation_handle` and `status` (`active`, `suspended`, `deleted`, `purged`).
- `organisation_placement`: the key is `(organisation_id, placement_epoch)`. A unique
  index permits one `active` row for each Organisation. `environment` is `development`
  or `production`.
- `workspace_ai_budget`: a regional trigger makes the row when the `organisation` row is
  made. The defaults are 64,000 tokens, 180,000 ms and 20 tool calls.
  `WORKSPACE_AI_BUDGET_MAXIMUM` is 1,000,000 tokens, 600,000 ms and 200 tool calls.
- `OrganisationActor` SQLite: the key of `organisation_meta` is `organisation_id`, and
  the read takes one row (`LIMIT 1`). One Actor serves one Organisation. A command for
  another Organisation gets `organisation_mismatch`
  (`actors/organisation/organisation-record.ts`).
- The name of a registered Actor (Organisation, Connector, Case, Session) starts with
  the Organisation id (`actors/actor-registry.ts`). From epoch 2, a derived name ends
  with `:p<epoch>`.
- Errors: `invalid_organisation_placement`, `organisation_placement_missing`,
  `organisation_placement_corrupt`, `organisation_placement_immutable`,
  `organisation_placement_move_conflict`, `organisation_placement_conflict`,
  `organisation_cell_unavailable`, `organisation_placement_configuration_invalid` and
  `placement_move_open`.
- Errors of a relocation start: `relocation_conflict`, `relocation_inventory_changed`,
  `target_schema_older_than_export`, `relocation_provider_work_unresolved`,
  `regional_capacity_insufficient` and `regional_capacity_unavailable`.
- This module has no capability and no agent tool.

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /v1/control/home-regions` | A signed-in person | The deployed cells (`choices`) and the nearest one (`suggested`) |
| `GET`, `POST /v1/admin/state-object-relocation` | The platform operator | Inspect a relocation. Commands: `start`, `resume`, `abandon`, `reconcile_receipt`, `reconcile_mail_receipt`, `waive_retention` |
| `GET`, `POST /v1/admin/state-object-restore` | The platform operator | Inspect a restore. Commands: `prepare`, `start`, `resume`, `abandon` |

The contract of the home regions is `packages/control-api/src/home-region.ts`. The main
files are in `services/platform/src/`:

| File | Purpose |
| --- | --- |
| `placement.ts` | The placement types, the profile parser and the nearest cell |
| `database-handles.ts` | The handle types and their makers |
| `organisation-execution-scope.ts` | The scope, the fence and the database selection |
| `data/organisation-placement.ts` | The placement record, its reads and its errors |
| `data/shared-rows/` | The writes of the three shared tables, and the rules for the regional copier |
| `data/placement-move.ts`, `data/placement-move.machine.ts` | The one writer of a move's state, and the machine |
| `data/query-source.ts` | `GlobalQuerySource` and `OrganisationQuerySource` |
| `control/home-region.ts` | The offered cells and the placement of a new Organisation |
| `gateway/admin/actor-relocation.ts` | The two admin routes |

The lints: `pnpm lint:database-handles` (`scripts/check-database-handles.mjs`) refuses a
cast to a handle type outside `database-handles.ts`. It refuses a new plain `D1Database`
above the count in `scripts/database-handles-ratchet.json`. It refuses SQL text that
writes a shared table outside `data/shared-rows/`. `pnpm lint:d1-patch` refuses a
baseline change without a patch script in `services/platform/scripts/`.
`pnpm --filter @purin-labs/platform d1:schema:remote:check` runs
`scripts/check-d1-schema.mjs` for production. It fails when a bound database lacks a
table, a column, an index or a trigger of its baseline.

## Rules and limits

| Action | Signed-in person | Sous Chef agent | Platform operator |
| --- | --- | --- | --- |
| Read the home regions | Yes | No | — |
| Choose the cell of a new Organisation | No | No | Only through the profile: the root cell for an Organisation that a person makes, the nearest deployed cell for a Slack install |
| Start, resume or abandon a relocation or a restore | No | No | Yes, with `ORGANISATION_ADMIN_TOKEN` as a bearer token |
| Waive the retention of a relocation | No | No | Yes |
| Read or write the records of an Organisation where the actor has no role | No | No | Yes, with the same token, through the admin routes of other specs for one named Organisation: for example `/v1/admin/person-roles`, `/v1/admin/integration-accounts`, `/v1/admin/external-records-read` and `/v1/admin/shopify-credential` |

An admin route answers 404 to a request without the token.

| Limit | Value | Constant |
| --- | --- | --- |
| Time from freeze to publication of a relocation | Less than 5 minutes | `ORGANISATION_RELOCATION_PUBLICATION_BUDGET_MS` |
| Retention of the source copy after a relocation | 7 days | `ACTOR_RELOCATION_RETENTION_MS` |
| `expires_at` of a control mutation receipt | 24 hours after creation | `MUTATION_RECEIPT_TTL_MS` |
| Size of the source and the target database together, at the start of a relocation | Below 10,000,000,000 bytes | `REGIONAL_DATABASE_CAPACITY_BYTES` |
| Repair of a stopped publication or directory copy | The next 15-minute run | The `*/15 * * * *` trigger |
| Writes of an idle Organisation | 12 Actor rows in one hour | `IDLE_HOUR_BUDGET` |
| Active Organisations that one person owns. Only the creation by a signed-in person checks it; a Slack install does not | 5 | `ORGANISATION_OWNER_LIMIT` |

- **Isolation.** A query for one Organisation binds its id, and so does an Actor
  identity, a registry lookup and an object key. A reference to another Organisation
  fails closed.
- **Queries that bind no Organisation.** A query of the global identity tables binds a
  person or a session. The owner limit and the list of the memberships of a person read
  the grants of one person in each cell. The scheduled runs and the ingress lookups read
  each regional database (`configuredOrganisationDatabases`).
- **Object keys.** An R2 key starts with the kind of the object and then the
  Organisation id. The kinds are `attachments`, `harness-checkpoints`,
  `workspace-revisions`, `state-object-exports`, `device-snapshots`, `bakery-runs`,
  `bakery-workflows`, `bakery-run-artifacts` and `bakery-run-prepared`.
- **Routing and execution.** Routing reads the global placement. Execution checks the
  regional fence. Control sessions are global records and stay live during a move.
- **Receipts.** A receipt is written in the batch of its effect. A purge deletes the
  expired receipts of its Organisation.
- **Information flow.** This module defines no source label and no output. A read
  through the scope uses the access checks of the scope
  (`organisation-access/access.ts`). FND-07 owns the labels.
- **Baselines.** The two baselines are replaceable files. A change ships with a patch
  script, and the operator applies it to each bound database before the release.
- **Out of scope:** a Postgres store; a dedicated deployment for one merchant; a cell
  that a person chooses in the Portal; billing.

The boundaries:

- FND-02 owns `durable_object_registry`, the Actor router, and the export and the
  import of an Actor. It also owns the regional copy
  (`data/organisation-regional-copy.ts`) and the item tables of a move. This spec owns
  the placement rows and the journal state.
- FND-04 owns the model routes and their funding. FND-06 owns identity, roles, control
  sessions, policy and the AI budget routes. FND-08 owns Purin Vault.
- ORG-01 owns creation, setup, archive, restore, deletion and purge of an Organisation,
  and its invitations. ORG-02 owns the monthly allowance of Jev from Purin.
- DEV-01 places each `DeviceFleetActor` with its Organisation. ENG-04 owns the test
  rules.
- [Plan 93](../../plan-93-clean-cutover.md) stays a plan. It owns the names of the
  deployed stack: `pantry-global-apac`, `pantry-organisation-apac` and
  `pantry-archive-apac`.

## Open work

- Production has one cell. No second regional database is bound, and the production
  profile has no `residency` cell.
- A person cannot choose the home region. The creation request carries only
  `operationId` and `name`, and no Portal page reads `GET /v1/control/home-regions`.
- A move has no Portal page, no capability and no agent tool. Only the admin routes
  start and continue it.
- No code writes the status `suspended` to the `organisation` row. The plan is always
  `beta`.
- Subscription plans are not built. The two baselines have no table for a plan tier or
  a quota. Other modules have spend limits: the monthly allowance of Jev from Purin
  (ORG-02), and the daily and monthly Code Mode cost limits of each Organisation
  (`actors/code-mode-budget.ts`) and of the whole platform
  (`actors/code-mode-platform-governor.ts`). `economics-costs.md` gives plan tiers,
  task counts and overage as a historical model, with prices that nobody checked again.
- The stream of audit and billing events from Queues to R2 is not built. The two queues
  carry events and cues only.
- The write meter is test code (`tests/e2e/write-meter.ts`). For production, an operator
  reads `rowsWritten` in the Cloudflare GraphQL Analytics datasets.
- No scheduled job deletes expired rows of `control_mutation_receipt`. A replay does
  not read `expires_at`.
- The idle-cost journey does not count the D1, queue, KV and R2 writes that a Durable
  Object makes itself. It counts the rows of the object.
- A Postgres projection has no code. `economics-costs.md` lists the conditions for one.

## Sources

- [Runtime architecture](../../architecture/runtime.md), the sections "Platform layout
  and conventions" and "Data model and Actor persistence".
- [Refactor 12](../../refactor-12.md). Its evidence in the archive:
  [the full E2E run](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/full-e2e-run.md),
  [the part 2 journeys](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/part-2-journeys.md),
  [the hand edits](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/hand-edits.md),
  [the handle analysis](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/database-roles.json)
  and
  [the wrong-database probe](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/refactor-12/wrong-database-probe.md).
- [Economics and costs](../../economics-costs.md). It names
  [Plan 55](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-55.md)
  in the archive for regional placement and latency.
- Background: [Plan 93](../../plan-93-clean-cutover.md). The rule for the cost of each
  tenant is in `AGENTS.md`, section "Cost of each tenant".
- Where a source differs from the code, this spec follows the code.
- E2E journeys in `services/platform/tests/e2e/`: `idle-tenant-cost.test.ts`,
  `shared-organisation-rows.test.ts`, `regional-onboarding.test.ts`,
  `placement-move.test.ts`, `organisation-lifecycle-placement.test.ts`,
  `control-receipt-placement.test.ts`, `actor-activation-placement.test.ts`,
  `session-execution-placement.test.ts`, `grant-placement.test.ts` and
  `policy-publication-placement.test.ts`.
