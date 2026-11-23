# FND-02 — Actor runtime

The Actor runtime is the durable part of Purin Pantry on Cloudflare. An Actor is a
Durable Object that owns one set of facts in its own SQLite storage. Four placed Actors
do the work of an Organisation: `OrganisationActor`, `ConnectorActor`, `CaseActor` and
`AgentSessionActor`. A registry in D1 gives each placed Actor its name, its placement
and its fence. One alarm for each Actor brings stored work back after the Actor leaves
memory. A harness and an executor compute, and they own no durable state. This spec
gives the platform layout, the registry, activation, the alarms, the leases and the
schema upgrades. FND-03 gives what a Case and a Session do with them.

## What it does

### The Workers and their resources

The platform Worker `pantry` starts in `workers/platform/src/integration-gateway.ts`
and exports each Actor class. `workers/platform/wrangler.jsonc` binds:

| Binding                                                              | Resource                                               | Responsibility                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `ORGANISATION`                                                       | `OrganisationDO`                                       | Policy head, action ledger, cue claims, commerce projections, shared drafts            |
| `CONNECTOR`                                                          | `ConnectorDO`                                          | Provider ingress, Case work, delivery and receipts                                     |
| `CASE`                                                               | `CaseDO`                                               | Journal, bindings, assignments, proposals, output outbox                               |
| `SESSION`                                                            | `SessionDO`                                            | Private history, turn lease, checkpoints, budget                                       |
| `CONVERSATION_RESIDENCY`                                             | `ConversationResidencyActor`                           | Keeps the Actors of an active conversation in memory                                   |
| `CODE_MODE_PLATFORM_GOVERNOR_ACTOR`                                  | `CodeModePlatformGovernorActor`                        | Platform admission of Code Mode scripts                                                |
| `CODE_MODE_SANDBOX`                                                  | `CodeModeSandbox`, in the Worker `pantry-code-sandbox` | The QuickJS VM of a Code Mode script                                                   |
| `DEVICE_FLEET`, `BAKE_RUN`                                           | `DeviceFleetActor`, `BakeRunActor`                     | Shop gateways (DEV-01) and bake runs (Plan 24)                                         |
| `WORKSPACE_EXECUTOR`, `MESSAGE_LINK_FETCH`, `CUSTOM_CONNECTOR_FETCH` | Three container classes                                | Linux-heavy work, link reads, custom connector egress                                  |
| `DB`                                                                 | D1, global                                             | Identity, ingress directory, placement, relocation and restore journals                |
| `ORGANISATION_DB_<REGION>`                                           | D1, one for each placement cell                        | The operational records of an Organisation, and the Actor registry                     |
| `POLICY_KV`                                                          | KV                                                     | The compiled policy snapshot, the cue snapshot and the hourly counters of ignored cues |
| `ARCHIVE`                                                            | R2                                                     | Checkpoints, attachments, workspace revisions, Actor exports                           |
| `EVENT_Q`, `CUE_Q`                                                   | Queues                                                 | `pantry-events` and `pantry-cues`                                                      |

- Service bindings reach `pantry-commerce`, `pantry-model-exit`, `pantry-chatgpt-exit`
  and `pantry-vault-onepassword`. Secrets Store binds `DATA_ENCRYPTION_ROOT` and
  `VAULT_ROOT_V1`.
- Production has one placement cell, `production-apac`, with `ORGANISATION_DB_APAC`. The
  Worker runs near `aws:ap-northeast-1`.
- A queue consumer tries a message again at most five times, 30 s apart. Then the
  message goes to `pantry-event-dlq` or `pantry-cue-dlq`. A queue carries work, not
  state.
- The Worker has three cron triggers. Each minute: paid receipt delivery. Each five
  minutes: the Commerce outbox reconciliation. Each fifteen minutes: onboarding
  reconciliation, schedule dispatch, file context reconciliation, attachment collection,
  payout reconciliation, the weekly ChatGPT sign-in refresh and the registry sweep.
- The Slack ingress Worker `pantry-slack-ingress` holds no Actor class. It binds
  `ConnectorDO` of `pantry` by `script_name`. It completes a signed message that its
  Connector accepts, and it sends each other request to `pantry`.

### The four placed Actors

```text
ConnectorActor -> CaseActor -> AgentSessionActor -> executor
```

| Actor               | One for each                    | Owns                                                                                                               |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `OrganisationActor` | Organisation                    | Policy head, action ledger, cue claims, commerce projections, Code Mode reservations, the sockets of shared drafts |
| `ConnectorActor`    | Connector: one provider account | Ingress identity, Case work, delivery attempts and receipts, channel state                                         |
| `CaseActor`         | Case: one body of related work  | Shared journal, bindings, assignments, proposals, output outbox                                                    |
| `AgentSessionActor` | Session: one agent in one Case  | Private history, delivery stream, turn lease, checkpoints, budget                                                  |

- One fact has one durable owner. Only the code of an Actor holds its `ctx.storage`, so
  another component gets a fact through an RPC method of the owner.
- Actors call each other through typed RPC methods. Only `OrganisationActor` accepts
  `fetch()`, for the WebSockets of shared drafts.
- The Worker class of each Actor (`actors/case.ts`, `actors/agent-session.ts`,
  `actors/connector.ts`, `actors/organisation.ts`) keeps the deployed class name. It
  gives the Actor the parts of the product areas.
- The files in `actors/case/` and `actors/session/`, and
  `actors/connector/connector-actor-base.ts`, are in the foundation layer. They import
  no module of a product area, and `pnpm lint:layers` checks it. They still hold records
  with area names: the Case holds commerce proposals, and the Session holds Kitchen
  page effects. `actors/organisation/organisation-actor-base.ts` is in the layer
  `workers/platform`, and it imports modules of the areas, for example `mail-inbox/`,
  `evals/` and `shopify/`.
- `WorkspaceExecutorContainer` has one method, `inspectAttachment`. It gets one request
  and the bytes of one attachment, it has no internet access, and it destroys its
  container after each call. No registry row names a container.

### The registry and activation

Each placed Actor has one row in `durable_object_registry` for each placement epoch.
`actors/actor-router.ts` resolves an Actor in these steps:

1. `OrganisationExecutionScope.resolve` gives the regional database, the placement and
   the placement fence token.
2. `reserveActor` writes a `reserved` row with a registry id (`dor_…`), an activation
   token (`doa_…`), a fence token (`dof_…`), the physical name and the schema version.
   The write succeeds only while the `organisation_placement` row of that epoch and
   cell is `active`.
3. The router calls `activate`. The Actor checks the request against the directory and
   the registry row. Then it writes its one `state_object_activation` row.
4. The router sets the registry row to `active` with the state version of the Actor.

- A repeat with the same identity returns the first result. The Actor refuses another
  identity with `activation_conflict`, and a changed placement with
  `activation_placement_conflict`. The router returns these as
  `actor_activation_conflict` and `registry_placement_conflict`.
- A read that must create nothing uses `findActiveCaseActorAtScope`,
  `findActiveSessionActorAtScope`, `findActiveOrganisationActorAtScope` or
  `resolveImportedCanonicalSessionActor`. They address an Actor only from an `active`
  row with the exact schema version, and they reserve and activate nothing. The first
  three return `null` for each other row. The last returns the error, for example
  `registry_schema_mismatch`.
- `actorStub` (`actors/actor-stubs.ts`) gets the object by its physical name, with the
  `locationHint` of the placement. For a `residency` placement, it uses
  `namespace.jurisdiction(...)`. The registry table keeps each physical name and each
  activation token unique.
- A new Case and its Session reserve in one batch and activate at the same time.
- The physical name is the Organisation id for `OrganisationActor`, and
  `<organisationId>:<logicalObjectId>` for the others. After a move, the name ends with
  `:p<epoch>`. An Actor of epoch 1 keeps its first name.
- The registry lifecycle is `reserved`, `active`, `exporting`, `retired` or
  `quarantined`. Only `reserved` and `active` rows resolve.
- `actors/actor-registry.ts` writes only D1 rows. Only a method of the Actor empties
  its storage: `discardQuarantinedState` of a Case, `eraseUnregisteredState` and
  `eraseInactivePlacementState`.
- A request that stops between steps 2 and 4 leaves a `reserved` row. The fifteen-minute
  sweep (`actors/actor-registry-sweep.ts`) reconciles each Organisation with a
  reservation older than 15 minutes. It activates the Actor, or it quarantines the row.

### Admission before work

Before an alarm or a recovered call does work, the Actor calls `admitActorRecovery`
(`actors/actor-activation.ts`). The result is one of three:

| Result     | When                                                                                       | Effect                             |
| ---------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `admitted` | The registry row is `active`, it matches the local activation, and the placement is active | The Actor gets its execution scope |
| `deferred` | The placement is `reserved` or `frozen`, or the row is not published yet                   | The alarm moves 15 s later         |
| `inactive` | No activation, or the row or the placement is retired, quarantined or abandoned            | The alarm is deleted               |

Case, Connector and Session also keep an execution barrier
(`state_object_cleanup_export_barrier`). `OrganisationActor` keeps
`state_object_policy_export_barrier`. An export closes the barrier, waits for each
admitted call, and then copies the state. While the barrier row exists, or the
placement is not active, `isActorExecutionActive` returns false
(`isOrganisationExecutionActive` for the Organisation). A method that calls the check
then stops.

`PlacedActor` (`actors/lifecycle/placed-actor.ts`) gives each placed Actor the same
lifecycle methods:

- `inspectRelocationReadiness` looks for each archive object that the Actor state
  names. An absent object gives `referenced_r2_missing`.
- `exportPlacementState` writes the export, and `importPlacementState` reads it. An
  Actor can apply an SQL migration to an older export. Only the Session has one.
- `eraseInactivePlacementState` empties the retired source or the abandoned target of
  a move. It keeps the activation row, the import row, the barrier and the schema
  tables, so a late request still fails at the fence.
- `eraseUnregisteredState` empties an Actor that no registry names.

### Alarms

Each Actor has one alarm (`actors/lifecycle/actor-alarm.ts`). A reconciler reads its own
rows and names the next time that it has work. `rearmActorAlarm` sets the alarm to the
earliest time, or deletes it when no reconciler has work. An alarm runs its work as
steps. A step that fails writes `actor.alarm_step_failed`, and the other steps still
run.

| Actor               | Alarm work                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConnectorActor`    | Renews the leases of running Case work, stops a due Gmail watch (`beforeCaseWork` of the email channel), starts the Case work drain, then runs the alarm steps of the email and WhatsApp channels. The Slack channel has no alarm step |
| `CaseActor`         | `context_projections`, `conversation`, `undelivered_outputs`, `commerce_approval_wait`, `abandoned_assignments`, all at the same time                                                                                                  |
| `AgentSessionActor` | In order: `checkpoint_finalization`, `run_budget_deadline`, `code_mode_settlements`, `quarantine_end`, `ended_executions`, `bakery_surface_effects`, `goal_usage`, `pending_pi_turn`, `run_budget_deadline_arm`                        |
| `OrganisationActor` | In order: `leases` (actions, Code Mode reservations, abandoned cue claims), `socket_sweep`, `typesafe_credentials`, `jev_usage`, `case_context_invalidations`                                                                          |

- Connector, Session and Organisation arm the alarm again after a failed step: 15 s,
  then doubled, to at most 15 minutes. The Case sets its retry time before the steps
  run.
- The Session moves its alarm earlier with `armAlarmBy` when it stores work. It has no
  reconciler list.
- `OrganisationActor` names its next alarm time from six reconcilers: `leases`,
  `cue_claims`, `case_context_invalidations`, `credential_cleanup`, `socket_sweep` and
  `jev_usage`. It runs one alarm at a time: a second alarm waits for the first.
- An `OrganisationActor` that is `inactive` closes all its sockets, so each client
  connects to the Actor that serves the Organisation now.
- When a Session starts and finds a turn with no driver, it resumes the saved Pi task.
  The alarm step `pending_pi_turn` does the same. Pi then continues the inference with
  no action from a person.
- Pi runs an interrupted tool call again only when the rule of the tool permits it
  (`actors/pi-tool-replay.ts`): `any_caller` for each caller, and `script` for a call
  from a Code Mode script. A call with the rule `none`, or a model call with no usage
  receipt, keeps the turn stopped. The Session marks the run budget as indeterminate,
  and it does not resume the task.
- A Session that has no Pi task to resume ends the turn as failed
  (`session_interrupted`). Only a turn that cannot end this way puts the Session in
  quarantine.

### Leases

| Lease                 | Held by                            | Stored in                                   | Time                                                      |
| --------------------- | ---------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| Harness turn lease    | The one runtime that writes a turn | `session_harness_lease`                     | The caller sets the expiry. A Slack turn gives 10 minutes |
| Case work             | The Case work drain of a Connector | `connector_case_work` (`running`, `due_at`) | 120 s; the alarm renews it while the drain runs           |
| Delivery              | A Connector send (`sending`)       | `connector_delivery`                        | 30 s; a retry waits 5 s                                   |
| Action execution      | An `OrganisationActor` action      | `action_ledger`                             | 5 minutes                                                 |
| Cue claim             | A cue queue consumer               | `cue_delivery`                              | 30 s; the alarm ends the claim 15 minutes after the lease |
| Code Mode reservation | A Session script                   | `code_execution_reservation`                | The `lease_expires_at` of the reservation                 |

Case work has five attempts for the turn (`CASE_WORK_MAX_ATTEMPTS`). Then it has three
attempts to post a notice in the thread (`CASE_WORK_NOTICE_ATTEMPTS`).

Before the Session accepts an event, a history entry or a checkpoint,
`validateCurrentLease` (`actors/agent-session-harness-authority.ts`) compares the lease
id and the expiry with `session_harness_lease`. Another lease id gives
`harness_lease_stale`, and a passed expiry gives `harness_lease_expired`. A late result
from a replaced runtime fails this check.

### Schema upgrades

- `runSchemaMigrations` (`actors/schema-migrations.ts`) runs one plan for one set of
  tables. A new Actor applies the baseline, then each step. A stored version below the
  baseline stops the Actor (`schema_version_retired`). A stored version above the code
  also stops it (`schema_version_ahead`).
- Each step runs in one transaction with its validation. A preserved table keeps its row
  count, unless the step says `may_grow` or `may_shrink`. `do_schema_meta` holds the
  version, and `do_schema_migration` holds an `applying` or `failed` step.
- Plans: `case` (version 2), `session_hot_schema` (baseline 33, no step),
  `session_actor_outbox` (3), `session_turn_continuation` (1), `cue_delivery` (2),
  `commerce_projection` (17), `commerce_query` (5), `connector_whatsapp_proposal` (2),
  `device_fleet` (5) and `bake_run` (1).
- The other tables of the Connector and the Organisation use `CREATE TABLE IF NOT
EXISTS` in the constructor, with no plan.
- The registry and the activation row hold one schema version for each Actor kind
  (`actors/actor-schema-versions.ts`): Organisation 10, Case 2, Connector 2, Session 33.
  In the four-step path, a `reserved` row must have the current version. An `active`
  row may be older, because the Actor upgrades its own tables when it starts.
- The operator command `advance_actor_schema` moves an Organisation or a Connector one
  version at a time. It changes the activation row first, then the registry row.

### Residency and warm slots

- A Durable Object can leave memory 10 s after its last event. A Slack Case turn names
  its Connector, its Case and its Session to the `ConversationResidencyActor` of the
  Connector (`keepConversationResident` in `slack/case-processing.ts`). The call starts
  before the turn runs, and the turn does not wait for it. An email, WhatsApp or Portal
  chat turn makes no such call.
- The residency Actor calls each named Actor every 8 s for 15 minutes. The call does no
  work.
- It holds names and one placement, and no content. It calls a Connector, a Case or a
  Session only while the registry lists it as `active` at the active placement. A warm
  slot has no registry row: the residency Actor calls a slot only while the registry
  lists the Connector as `active`.
- It keeps at most 65 names and 4 warm slots, and one request names at most 8 Actors.
  When a request names another placement, it drops each earlier name.
- When a Slack message finds its Session in the registry, the Slack Case turn also
  calls the Session before the turn's own call (`startSessionBeforeItsTurn`). The
  Session then starts while the Case admits the message.
- A warm slot is a Case or a Session object with a random name
  (`<organisationId>:warm:<kind>:<hex>`) that a Connector starts before a thread needs
  it (`actors/warm-actor-slots.ts`). It holds no identity and no content. A new Slack
  thread takes one slot of each kind, and the registry row names the slot.
- A slot of another placement or schema version is never taken. Pantry erases it.

### Execution routing

The Session gives Pi three kinds of tool (`actors/pi-durable-tools.ts`): each tool that
the Tool Host of the Session defines, which runs in Pantry code; `tool_search`; and
`codemode`, which runs a script. The Tool Host admits each call. Only the model can
call `tool_search` and `codemode`, so a script cannot start a script. A script does not
get a tool with the rule `modelOnly`. Pantry code checks each nested call.

`routeCodeModeExecution` (`actors/code-mode-router.ts`) has one placement: the
`CodeModeSandbox` Worker, which has no credential, database, storage or outbound
binding. A tool call names no placement. `WorkspaceExecutorContainer` runs only the
inspection of an attachment (`actors/message-attachment-preparation.ts`).
`OrganisationActor` and `CodeModePlatformGovernorActor` reserve and settle the budget
of each script and of each executor allocation.

### Operator inspection and repair

All routes need the bearer token `ORGANISATION_ADMIN_TOKEN`. Without it, the answer is 404.

| Route                                                                 | Purpose                                                                                                                                                                            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/state-object-registry`                                 | The registry rows of one Organisation                                                                                                                                              |
| `POST /v1/admin/state-object-registry`                                | `bootstrap_organisation`, `reconcile_reserved`, `advance_actor_schema`, `interrupt_session`, `recover_connector_case_work`, `discard_quarantined_case`, `erase_unregistered_actor` |
| `GET /v1/admin/machine-census`                                        | For each state machine in Actor SQLite: the rows in each open state, the oldest age and the rows past their exit. Counts and times only                                            |
| `/v1/admin/state-object-relocation`, `/v1/admin/state-object-restore` | A move or a restore of an Organisation (FND-01)                                                                                                                                    |

`erase_unregistered_actor` empties an Actor that no registry names. Its kinds are the
four placed Actors, `conversation_residency`, `device_fleet` and
`custom_connector_fetch`. The route refuses an Actor that a registry names
(`actor_registered`). The Actor refuses while its storage names an Organisation that
the directory still has (`actor_owner_exists`). A fetch container that runs refuses
with `actor_in_use`.

`discard_quarantined_case` asks the Case to discard its state. Then it deletes the
registry row.

## Contracts

- Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`):
  `durable_object_registry`. Global D1 (`migrations-global/`):
  `state_object_relocation_item`, `state_object_relocation_exclusion`,
  `state_object_relocation_copy` and `state_object_restore_item`.
- Actor SQLite of each placed Actor (`actors/lifecycle/placed-actor.ts`):
  `state_object_activation` (one row), `state_object_import`, the execution barrier,
  `do_schema_meta` and `do_schema_migration`.
- `ConnectorActor`: `connector_meta`, `connector_ingress` (unique native event id),
  `connector_delivery` (unique idempotency key), `connector_case_work` and its receipt
  tables, `connector_parked_case_work`, `connector_slack_stream`, `warm_actor_slot`, and
  the `connector_email_*` and `connector_whatsapp_*` tables of INB-01.
- `CaseActor` (`actors/case-schema.ts`): `case_meta`, `case_trigger`, `case_journal`,
  `case_binding`, `case_assignment`, `case_proposal`, `case_commerce_proposal`,
  `case_commerce_approval`, `case_email_proposal`, `case_output` and
  `case_context_projection_outbox`.
- `AgentSessionActor` (`actors/agent-session-schema.ts`): `session_meta`,
  `session_case_parent`, `actor_journal`, `actor_inbox`, `actor_outbox`,
  `session_budget_*`, `session_harness_lease`, `session_harness_history`,
  `turn_delivery_segment`, `session_harness_checkpoint`, `session_turn_stream` and the
  Pi Durable tables.
- `OrganisationActor` (`actors/organisation/schema.ts`): `organisation_meta`,
  `organisation_policy_head`, `action_ledger`, `cue_delivery`, the `code_execution_*`
  tables, `hibernatable_socket_sweep`, and the tables of the product areas.
- `ConversationResidencyActor`: `residency_scope`, `resident_actor`, `warm_slot`.
- An Actor export is in R2 `ARCHIVE`, under
  `state-object-exports/<organisationId>/<exportId>/` (`actors/actor-export.ts`). It
  has one AES-GCM manifest, `manifest.bin`, and one copy of each archive object that
  the Actor state names, `objects/<index>.bin`. The export writes the bytes of an
  object as it reads them, with the SHA-256 digest in the metadata. It does not encrypt
  a copy.
- Events: `actor.alarm_step_failed`, `actor_registry.reserved_sweep_*` and
  `residency.*` go to `traceWarn`.
- The capability catalogue and `agent-tools/` have no entry for the registry, the
  census or the residency Actor. Only the operator routes reach them.
- Packages: `@purin-labs/std/state-machine` (machine definitions),
  `@purin-labs/contracts` (`CommandEnvelope`, `EventEnvelope`, `HarnessTurnLease`).

| File in `workers/platform/src/actors/`                                                                                           | Content                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `actor-router.ts`, `actor-stubs.ts`                                                                                              | Resolve an Actor; the stub at its placement                                          |
| `actor-registry.ts`, `actor-activation.ts`, `actor-placement-admission.ts`                                                       | The registry row, the activation row, the placement fence                            |
| `lifecycle/placed-actor.ts`                                                                                                      | The lifecycle RPC of each placed Actor: activate, readiness, export, import, erase   |
| `actor-export.ts`, `actor-execution-quiescence.ts`, `unregistered-actor-erasure.ts`                                              | The export and the import, the execution barrier, the erase of an unregistered Actor |
| `lifecycle/actor-alarm.ts`, `connector-alarm.ts`, `case-alarm.ts`, `organisation-alarm.ts`                                       | The alarm helpers and the reconcilers of each Actor                                  |
| `lifecycle/state-transition.ts`, `lifecycle/machine-census.ts`, `actor-machines.ts`                                              | Compare-and-set moves of a machine, and the census                                   |
| `schema-migrations.ts`, `actor-schema-versions.ts`                                                                               | The migration runner and the schema versions                                         |
| `connector/connector-actor-base.ts`, `case/case-actor.ts`, `session/session-actor.ts`, `organisation/organisation-actor-base.ts` | The four Actors                                                                      |
| `conversation-residency.ts`, `warm-actor-slots.ts`, `hibernatable-sockets.ts`                                                    | Residency, warm slots, the socket sweep                                              |

## Rules and limits

| Action                                                             | Person, any role | Agent | Operator with the admin token          |
| ------------------------------------------------------------------ | ---------------- | ----- | -------------------------------------- |
| Call an Actor directly                                             | No               | No    | No: only Worker code holds a namespace |
| Read the registry or the census                                    | No               | No    | Yes                                    |
| Repair the registry, advance a schema, erase an unregistered Actor | No               | No    | Yes                                    |

| Limit                                                                          | Value                                | Constant                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------- |
| Stale reservation                                                              | 15 minutes                           | `ACTOR_RESERVATION_STALE_MS`                                        |
| Organisations in one sweep, for each database                                  | 50                                   | `ORGANISATION_PAGE`                                                 |
| Alarm retry after a failed step                                                | 15 s to 15 minutes                   | `ALARM_RETRY_FIRST_MS`, `ALARM_RETRY_MAX_MS`                        |
| Case retry of stored work                                                      | 15 s                                 | `CASE_RECOVERY_INTERVAL_MS`                                         |
| Case read of a waiting approval                                                | 60 s for 10 minutes, then 15 minutes | `APPROVAL_READ_FIRST_MS`, `APPROVAL_READ_LATER_MS`                  |
| Undelivered Case output                                                        | Dropped after 24 hours               | `UNDELIVERED_OUTPUT_TTL_MS`                                         |
| Assignment with no move                                                        | Abandoned after 30 minutes           | `ASSIGNMENT_ABANDON_AFTER_MS`                                       |
| Organisation retry of stored work                                              | 30 s                                 | `ORGANISATION_RETRY_MS`                                             |
| Socket sweep; silent socket                                                    | 300 s; 90 s                          | `SOCKET_SWEEP_INTERVAL_MS`, `SOCKET_SILENCE_LIMIT_MS`               |
| Case work lease; delivery lease and retry                                      | 120 s; 30 s and 5 s                  | `CASE_WORK_LEASE_MS`, `DELIVERY_LEASE_MS`, `DELIVERY_RETRY_MS`      |
| Action lease; cue claim lease                                                  | 5 minutes; 30 s                      | `ACTION_EXECUTION_LEASE_DURATION_MS`, `CUE_DELIVERY_LEASE_MS`       |
| Residency time and call interval                                               | 15 minutes; 8 s                      | `CONVERSATION_RESIDENCY_MS`, `CONVERSATION_RESIDENCY_TICK_MS`       |
| Residency names; warm slots; names in one request                              | 65; 4; 8                             | `MAX_RESIDENTS`, `MAX_WARM_SLOTS`, `MAX_NAMES_PER_REQUEST`          |
| Census size                                                                    | 2,000 Actors                         | `CENSUS_ACTOR_LIMIT`                                                |
| Actor export manifest                                                          | 64 MiB                               | `MAX_EXPORT_MANIFEST_BYTES`                                         |
| Code Mode scripts and executor allocations at one time, for the whole platform | 8; 4                                 | `MAX_CONCURRENT_EXECUTIONS`, `MAX_CONCURRENT_WORKSPACE_ALLOCATIONS` |
| Code Mode scripts of one Organisation at one time                              | 2                                    | `PILOT_ORGANISATION_MAX_CONCURRENT_EXECUTIONS`                      |

- **Isolation.** Each registry row, Actor name, activation and export key binds the
  Organisation. An Actor refuses an activation for another identity.
- **Order of writes.** The Actors write related rows in `ctx.storage.transactionSync`.
  Its callback is synchronous, so no external I/O runs inside one transaction.
- **Cost of an idle Organisation.** An alarm with no work deletes itself. A constructor
  creates tables only when they are missing. The residency calls end after 15 minutes.
  `tests/e2e/idle-tenant-cost.test.ts` is the guard.
- **Information flow.** The census, the residency Actor and a warm slot hold no content.
  The rules for content that leaves an Actor are in FND-07.
- **State machines.** A machine in Actor SQLite is a `*.machine.ts` file in the list
  `ACTOR_MACHINES`. `pnpm lint:state-machines` checks each one.
- **Out of scope:** desktop file synchronization, generated code with no limits, and
  physical robot control. Deployed class names and binding names do not change.

Boundaries:

- **FND-01** owns `organisation_placement`, the placement epochs, and the move and
  restore of an Organisation. This spec owns the Actor side: the registry row, export,
  import and erase.
- **FND-03** owns the Case and Session behavior: triggers, assignments, proposals,
  outputs, the Session lifecycle and the turn. **FND-04** owns the Pi harness, the model
  routes and the checkpoint format. **FND-05** owns messages and attachments.
- **FND-06** owns the action ledger and policy. **FND-09** owns the agent tools that the
  Tool Host runs. **FND-10** owns the shared drafts on the Organisation sockets.
  **FND-11** owns the envelope contracts.
- **COM-01** and **COM-03** own the commerce projections in `OrganisationActor`.
  **INB-01** owns the email and WhatsApp channels of the Connector.
- **[DEV-01](../areas/devices/01-devices.md)** owns `DeviceFleetActor`.
  [Plan 24](../../plan-24-cafeos-bakery-automation.md) owns `BakeRunActor`.

## Open work

- No command advances the registry schema version of a Case or a Session:
  `advance_actor_schema` refuses both kinds.
- The base tables of the Connector and the Organisation have no migration plan and no
  recorded version in `do_schema_meta`.
- The Session alarm has no reconciler list. The other three Actors have one.
- Production has one placement cell. The code also accepts a `residency` placement
  (`eu`, `fedramp`), and no production cell uses it.
- Plan 14 names a mutable working-tree cache over an immutable workspace revision as
  optional. It is not built.
- The durable execution extensions of
  [Plan 50](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-50-pi-durable-execution-multiplayer.md)
  keep their acceptance gates in the archive.

## Sources

- [Plan 14](../../history/plan-14-actor-runtime-architecture.md) and the
  [runtime architecture](../../architecture/runtime.md) (platform layout, Actors). Where
  they differ from the code, this spec follows the code. Their evidence in the archive:
  [Plan 14 closure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-closure-2026-08-02.md),
  [the Actor-owned harness history design](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-14-nf9-actor-owned-history.md),
  [NF9 production closure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-nf9-production-closure-2026-08-08.md).
- Related: [security](../../architecture/security.md), [Plan 15](../../history/plan-15.md),
  [Refactor 10](../../history/refactor-10.md), [Refactor 12](../../history/refactor-12.md), the
  [deploy runbook](../../runbooks/platform-production-deploy.md) and the
  [E2E coverage guide](../../../test-coverage-e2e.md).
- E2E journeys in `workers/platform/tests/e2e/`: `actor-recovery.test.ts`,
  `actor-activation-placement.test.ts`, `placement-move.test.ts`,
  `unregistered-actors.test.ts`, `session-alarm-steps.test.ts`,
  `session-quarantine-end.test.ts`, `case-undelivered-output.test.ts`,
  `case-command-recovery.test.ts`, `slack-actor-journey.test.ts`,
  `slack-connector-admission.test.ts`, `slack-warm-actor-pair.test.ts` and
  `idle-tenant-cost.test.ts`.
- The lint `scripts/check-state-machines.mjs` checks the machines of the Actors.
