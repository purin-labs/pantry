# Runtime architecture

This document describes the Pantry runtime on Cloudflare: the platform
layout, the Actors and their storage, agent sessions, the Pi harness adapter,
Case coordination with Connector delivery, and cues. It states ownership,
invariants, data placement, flows and recovery rules. Security rules
(egress, Vault, policy, approval) are in [security.md](./security.md).
Organisation setup and lifecycle are in [onboarding.md](./onboarding.md).

| Replaces                                                 | Section                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Spec 0 — Platform Scaffold and Shared Conventions        | [Platform layout and conventions](#platform-layout-and-conventions)                   |
| Spec 1 — Data Model, Multitenancy, and Actor Persistence | [Data model and Actor persistence](#data-model-and-actor-persistence)                 |
| Spec 3 — Agent Session Lifecycle and Execution           | [Agent sessions](#agent-sessions)                                                     |
| Spec 4 — Agent Harness Adapter                           | [Harness adapter](#harness-adapter)                                                   |
| Spec 7 — Case Coordination and Connector Delivery        | [Case coordination and connector delivery](#case-coordination-and-connector-delivery) |
| Spec 9 — Cue Processing and Proactive Work               | [Cues and proactive work](#cues-and-proactive-work)                                   |

## Platform layout and conventions

### Workers and resources

The platform Worker `pantry` starts in
[`integration-gateway.ts`](../../services/platform/src/integration-gateway.ts)
and its Actors are in
[`services/platform/src/actors/`](../../services/platform/src/actors/). The
Cloudflare classes keep their deployed names (`OrganisationDO`,
`ConnectorDO`, `CaseDO`, `SessionDO`). This document uses the domain names
`OrganisationActor`, `ConnectorActor`, `CaseActor` and `AgentSessionActor`.
The platform profile in [`wrangler.jsonc`](../../services/platform/wrangler.jsonc)
binds:

| Binding                             | Resource                        | Responsibility                                                      |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| `ORGANISATION`                      | `OrganisationDO`                | Organisation state, commerce projections, action ledger, cue claims |
| `CONNECTOR`                         | `ConnectorDO`                   | provider ingress, Case work admission, delivery, receipts           |
| `CASE`                              | `CaseDO`                        | shared journal, bindings, assignments, proposals, output outbox     |
| `SESSION`                           | `SessionDO`                     | private history, harness lifecycle, checkpoints, budget             |
| `CONVERSATION_RESIDENCY`            | `ConversationResidencyActor`    | keeps the Actors of an active conversation in memory                |
| `CODE_MODE_PLATFORM_GOVERNOR_ACTOR` | `CodeModePlatformGovernorActor` | platform admission of Code Mode scripts                             |
| `CODE_MODE_SANDBOX`                 | `CodeModeSandbox` (own Worker)  | the QuickJS VM of a Pi Code Mode script                             |
| `WORKSPACE_EXECUTOR`                | `WorkspaceExecutorContainer`    | short-lived Linux-heavy execution                                   |
| `MESSAGE_LINK_FETCH`                | `MessageLinkFetchContainer`     | reads of links in messages                                          |
| `CUSTOM_CONNECTOR_FETCH`            | `CustomConnectorFetchContainer` | egress of custom API connectors                                     |
| `DB`                                | D1, global                      | identity, ingress directory, placement, relocation, restore         |
| `ORGANISATION_DB_<REGION>`          | D1, one per placement cell      | the Organisation's operational records                              |
| `POLICY_KV`                         | KV                              | compiled policy and cue snapshots, ignored-cue counters             |
| `ARCHIVE`                           | R2                              | checkpoints, attachments, workspace revisions, artifacts            |
| `EVENT_Q`, `CUE_Q`                  | Queues                          | `pantry-events` and `pantry-cues`                                     |

Secrets Store binds the data-encryption and Vault roots. Service bindings
reach the exit Workers, the 1Password store, Commerce and the Console.
Production has one placement cell in Asia Pacific (`ORGANISATION_DB_APAC`).
The D1 baselines are `migrations-global/` and `migrations-regional/`. The E2E
suite loads them into two databases; unit tests and local tools with one
database load the schema that `scripts/single-database-schema.mjs` builds
from them.

Queues carry work, not domain state. A consumer retries a message at most
five times, then sends it to `pantry-event-dlq` or `pantry-cue-dlq`. The
one-minute cron reconciles the Commerce outbox. The fifteen-minute cron
runs onboarding reconciliation, schedule dispatch, attachment collection,
payout reconciliation and other bounded passes.

The Slack ingress Worker
([`handler.ts`](../../services/platform/src/slack-ingress/handler.ts)) binds
`ConnectorDO` of `pantry` by `script_name`. It completes a signed message
that its Connector accepts, and forwards every other request to the platform
Worker. `CODE_MODE_SANDBOX` binds the class of a separate Worker by
`script_name`; the deploy command deploys it first. That Worker holds no
credential, database, storage or outbound binding, and
`pnpm --filter @purin-labs/platform code-mode-sandbox:check` fails if it gains one. If
the binding is missing, a Pi script fails before admission.

Durable Object classes are declared in the `exports` map of `wrangler.jsonc`.
A removed class stays there with `"state": "deleted"` until the release that
deletes its namespace.

### Actor routing

```text
ConnectorActor -> CaseActor -> AgentSessionActor -> executor
```

Every Actor is one Organisation-scoped coordination unit, resolved through
the registry by its exact logical identity
([`actor-router.ts`](../../foundation/actor-runtime/actors/actor-router.ts)).
One Connector serializes one provider-account delivery domain. One Case
serializes one body of related work. One Agent Session serializes one
agent's private lifecycle. An executor owns no durable state. Actors call
each other through typed RPC methods; `OrganisationActor` also accepts
`fetch()` for draft WebSockets. No component reads or writes the SQLite
storage of another Actor.

`ConversationResidencyActor` holds Actor names and a placement, and no
content. After each turn it calls the turn's Connector, Case and Session
about every 8 s, for 15 minutes. The call does no work. It calls only Actors
that the registry lists as active at the active placement.

### Contracts and envelopes

Cross-boundary contracts are TypeBox 1.x schemas with `Value` checks in
`packages/contracts`, which re-exports `packages/commerce-contracts`. No
contract remains in Rust. The session reducer is TypeScript
([`session-reducer.ts`](../../packages/contracts/src/session-reducer.ts)).
Branded Platform identities are in [`ids.ts`](../../foundation/kernel/ids.ts).

- Parse raw D1 rows, requests, Queue bodies and provider payloads once, at
  the boundary.
- Use discriminated unions for state, with exhaustive switches.
- Make identity, authority, revision, fence, budget and causation required.
- Return typed result unions for recoverable failures.

`CommandEnvelope` and `EventEnvelope` carry the envelope and payload
versions, the Organisation and Actor, the command or event identity (an
event adds stream and sequence), times, correlation, causation, idempotency
key, runtime revision, principal, sensitivity, retention and a typed body.
An exact redelivery converges on the first accepted result. A repeated
identity with different content fails closed. An external effect needs a
stable effect identity and a terminal provider receipt.

Durable Object SQLite owns the hot state of its Actor. D1 owns control
records, registries and rebuildable projections. R2 owns large immutable
bytes. KV owns caches of records held elsewhere. Persist critical state
before an in-memory cache advances. Commit related SQLite writes in one
transaction, with no external I/O between them.

## Data model and Actor persistence

### Storage placement

| State                                                                       | Authority                            |
| --------------------------------------------------------------------------- | ------------------------------------ |
| Organisation identity, placement, Slack installations, control sessions     | global D1                            |
| Integration accounts, connections, policy, agents, cues, Projects, registry | regional D1                          |
| Provider ingress identity, delivery attempts and receipts                   | `ConnectorActor` SQLite              |
| Case purpose, journal, bindings, assignments, proposals, outbox             | `CaseActor` SQLite                   |
| Session contract, private history, budget, checkpoint, turn lease           | `AgentSessionActor` SQLite           |
| Commerce deliveries and projections, cue outbox, action ledger              | `OrganisationActor` SQLite           |
| Checkpoints, attachments, workspace revisions, artifacts                    | R2 `ARCHIVE`                         |
| Compiled policy and cue snapshots                                           | `POLICY_KV`, a cache over D1 records |

One fact has one durable owner. A D1 projection gets no authority because
it is easy to query.

### Placement and the Actor registry

An Organisation has a placement: an epoch, a kind (`affinity` or
`residency`), a cell and a location hint (`organisation_placement`). The
global database publishes the epochs. The regional row is the execution
fence. `OrganisationExecutionScope.resolve`
([`organisation-execution-scope.ts`](../../foundation/tenancy/organisation-execution-scope.ts))
gives the regional database and placement of an Organisation.

A regional `durable_object_registry` row
([`actor-registry.ts`](../../foundation/actor-runtime/actors/actor-registry.ts))
binds the Organisation, Actor kind and logical identity, the physical name,
the schema and state versions, the placement epoch and cell, and an
activation token and fence token. Its lifecycle is `reserved`, `active`,
`exporting`, `retired` or `quarantined`. A registry change never deletes
Actor storage implicitly. Relocation and restore create explicit epochs and
fences (`state_object_relocation*`, `state_object_restore*`). A stale
registry entry, lease or placement cannot change an Actor. An Actor admits
recovery work only at its active placement.

### Actor-local storage

- `ConnectorActor`: `connector_ingress` (unique native event identity),
  `connector_delivery` (unique idempotency key), admitted and parked Case
  work, Slack stream state, email and WhatsApp runtime tables.
- `CaseActor`: `case_meta`, `case_trigger`, `case_journal`, `case_binding`,
  `case_assignment`, `case_proposal`, commerce and email proposals,
  `case_commerce_approval`, the `case_output` outbox and goal records.
- `AgentSessionActor`: `session_case_parent` (one row), the actor journal,
  `session_turn_attachment`, `session_turn_stream`, `session_budget_*`,
  `session_harness_lease`, `session_harness_history`,
  `turn_delivery_segment`, `session_harness_checkpoint(_payload)`,
  information-flow bindings, Code Mode receipts and the Pi Durable tables.
- `OrganisationActor`: `organisation_policy_head`, the action ledger (see
  [security.md](./security.md#action-ledger)), commerce projections,
  `commerce_cue_outbox`, `cue_delivery`, `shopify_location_observation` and
  collaborative drafts.

Each Actor owns its schema upgrades
([`schema-migrations.ts`](../../foundation/actor-runtime/actors/schema-migrations.ts)).
A chat trigger carries a `UserMessage`: one ordered, non-empty list of text,
link and attachment parts. Attachments belong to the parts; no separate
attachment list exists.

### Control-plane records

Global D1 holds Organisation identity and placement, users and control
sessions, Slack installations and routing, thread-to-Case pins, relocation
and restore journals and Console account links. Regional D1 holds
integration accounts and credential generations, Vault records,
`policy_snapshot`, `workspace_ai_budget`, agent definitions, installations
and skills, cue and schedule bindings, `cue_log`, `case_assignment_pin`,
`organisation_commerce_system`, `project`, `case_project`, workspace
revisions and harness erasure rows. Code parses each raw row into a precise
type at once. D1 commerce projections are rebuildable and never accept
provider deliveries.

A Case may have several independent sessions. Each session has exactly one
immutable parent Case and never changes a sibling or shared Case state
directly. Every Case has one `case_project` row; work with no named Project
is filed in the default Project ([Refactor 9](../refactor-9.md)).

### Commerce projections

`OrganisationActor` stores merchant-safe projections of the records in
[Commerce Domain Architecture](../commerce-domain-architecture.md). The
connected system stays authoritative. Each Organisation selects one system
in `organisation_commerce_system`: `builtin_commerce` (a Commerce binding)
or `shopify` (an integration account), with a revision. Only the selected
system updates projections; a mismatch fails with
`commerce_system_authority_mismatch` before the reducer runs.

`OrganisationActor.applyCommerceDelivery`
([`commerce-projection.ts`](../../services/platform/src/actors/commerce-projection.ts))
is the only acceptance point for a `CanonicalCommerceDelivery`. One
transaction records the receipt, all child observations, all projection
transitions and the pending cues. An exact replay is a `duplicate`. A
changed digest is `commerce_delivery_conflict`. Source revisions classify
each child as accepted, duplicate or out of order. An invalid child rejects
the whole delivery. A delete writes a tombstone, which a later complete
upsert clears in the same transaction. A Shopify location stays `pending`
until a `LocationKind` is assigned
([`location-observation.ts`](../../services/platform/src/shopify/location-observation.ts));
code never infers it from a name or address. Merchant reads use the
Commerce Read Layer
([`entity-plane/`](../../services/platform/src/commerce/entity-plane/)).

### Objects, reachability and erasure

R2 keys are Organisation-scoped. `harness-checkpoints/<organisation>/…`
holds AES-GCM encrypted checkpoints
([`harness-checkpoint.ts`](../../foundation/agent/harness-checkpoint.ts)).
`attachments/<organisation>/…` holds attachments by content digest and
their derived objects. A provider filename never builds a key. The cron
collector
([`message-attachment-collection.ts`](../../services/platform/src/message-attachment-collection.ts))
asks every live Case and Session which objects they name, keeps those and
recent uploads, and deletes the rest. It never deletes on a partial listing.

The onboarding reconciliation runner erases harness history from the D1
`organisation_harness_erasure` rows
([`onboarding-reconciliation.ts`](../../services/platform/src/data/onboarding-reconciliation.ts)).
Each `AgentSessionActor` deletes its own rows through `eraseHarnessHistory`
and returns its object keys. Each object becomes `retained` or `deleted`.
See the [harness erasure runbook](../runbooks/harness-erasure.md).

### Budget authority

`AgentSessionActor` owns one cumulative session budget and at most one
active Run reservation
([`agent-session-budget.ts`](../../foundation/agent/actors/agent-session-budget.ts)).
The session budget limits model tokens and capability calls; each Run has
its own time limit. Provider-reported tokens and active time settle as
actual usage. A capability call commits before its authoritative boundary
and is never refunded. A retry or restore cannot reset usage. The account,
reservation, event cursor and lifecycle commit in one transaction. The
Organisation's `workspace_ai_budget` sets new session limits through the
policy snapshot, and an installation ceiling can only tighten them.

### Isolation and schema change

Every D1 query, Actor identity, registry lookup and object key binds the
Organisation. A Connector identity binds the exact integration account.
Session tools get capability references, never Actor namespaces, raw SQL or
credentials. Cross-Organisation references fail closed. A D1 baseline
change ships with a patch script in `services/platform/scripts/`. Harness
checkpoints are never converted across a backend, build or format boundary.

## Agent sessions

`AgentSessionActor` owns one durable agent in one Case: private history,
harness lifecycle, checkpoints, budget, cancellation and execution receipts.
The parent `CaseActor` owns assignments and shared truth.

### Identity and model route

A session has one parent Case and one assignment (`session_case_parent`).
The `CaseAssignment` gives it the starting Case revision, role, objective,
`SessionAuthority`, `AuthorityPartition`, `SessionBudget` and a bounded
`CaseContextSnapshot`. The `SessionContract`
([`session-schemas.ts`](../../packages/contracts/src/session-schemas.ts))
pins the policy version, budget revision, runtime revision and model route.

Every route runs Pi in the Worker. The session pins exactly one route
([`model-route.ts`](../../packages/contracts/src/model-route.ts)):

| `keySource` + `provider`               | Funding and authentication                            |
| -------------------------------------- | ----------------------------------------------------- |
| `platform` + `openai-compatible`       | Pantry's `OPENROUTER_API_KEY`                          |
| `organisation_byo` + `openai`          | the Organisation's OpenAI API key, Vault-encrypted    |
| `organisation_byo` + `anthropic`       | the Organisation's Anthropic API key, Vault-encrypted |
| `organisation_oauth` + `anthropic`     | the Organisation's Claude account                     |
| `organisation_subscription` + `openai` | the Organisation's ChatGPT sign-in                    |

Missing or exhausted authority, or a transport failure, fails the pinned
route. A session never selects another route. See
[security.md](./security.md#model-routes-and-exit-workers).

### Lifecycle

```text
sleeping -> activating -> processing -> checkpointing -> sleeping
                              |  ^
                              v  |
                           recovering
active states -> cancelling -> terminal;  failures -> quarantined | terminal
```

The session reducer accepts every transition. A command carries the exact
state version and the required lease or fence. An invalid transition fails
with no partial write.

- `quarantined` keeps unproven state. Reasons: `activation_failure`,
  `integrity_failure`, `replay_failure`, `effect_indeterminate`,
  `journal_budget_exceeded`, `migration_blocked`. Recovery is `reactivate`
  or `terminate_only`.
- `terminal` closes work: `closed`, `expired`, `erased`, `cancelled`,
  `failed`. Neither state reactivates silently.
- `recovering` keeps an unfinished turn and a saved Pi task. Its action is
  `resume_task`, `retry_at`, `await_evidence` (model usage or an effect
  receipt) or `blocked`. Only `resume_task` returns to `processing`, with the
  next runtime generation, a new lease and an active budget reservation.

### Turns and the turn lease

A session runs sequential turns. Each turn has a mutable turn prompt; the
harness instructions are stable and bound to the checkpoint. At most one
runtime writes a turn. Activation persists a `HarnessTurnLease` (lease ID,
session, turn, runtime lease, runtime revision, request authority,
authority partition digest, expiry). `session_harness_lease` also stores the
history and delivery cursors. Every event, tool result, checkpoint,
cancellation and terminal result must match the current lease. A late
result or a replaced runtime loses the fence.

Slack keeps one Case for each thread
([`case-routing.ts`](../../services/platform/src/slack/case-routing.ts)).
The Case, Session and assignment identities derive from the thread root
timestamp; the Session and assignment also carry the authority partition
digest. A later message becomes a new turn. A redelivery reuses the
identities.

### Message preparation

Before the first model call, the session prepares the turn's attachments
([`message-preparation.ts`](../../foundation/agent/actors/message-preparation.ts)).
An image becomes native image input. A document becomes bounded extracted
text. Audio and video become container facts, with no transcription.
Sampled video stills become image input; the executor decodes a still once
and later reads reuse it. A file that no handler reads becomes an
`attachment_manifest` that says plainly that the content was not read.
Every read verifies the Organisation prefix, length and digest first.
Preparation shares the Run budget under an `attachment_preparation`
allocation. Recovery accepts a saved result and never dispatches a second
executor operation.

### History, delivery and checkpoints

Private history (`session_harness_history`) rebuilds model state and forms
a hash chain. The delivery stream (`turn_delivery_segment`) holds progress,
status and final output for Case, Connector, Slack and Portal consumers. A
subscriber owns only its connection and cursor. A disconnect never cancels
a turn, and a reconnect starts no new inference
([`agent-session-event-stream.ts`](../../foundation/agent/actors/agent-session-event-stream.ts)).

A checkpoint is written between turns. It binds both cursors; the backend,
build and format; the instruction, tool catalog and model route digests;
and the budget revision and usage. It needs a settled Run.

1. One transaction saves the record (`upload_pending`), the payload in
   chunks of at most 1 MiB (16 MiB limit), the alarm and `checkpointing`.
2. The upload writes one immutable encrypted R2 object from those bytes.
3. One transaction marks it `published` and deletes the local bytes.
4. The final lifecycle commit requires `published`.

A crash before step 3 retries the same object from the same bytes. On
restore, `classifyHarnessCheckpoint` returns `compatible` (same backend,
build, format and model route digest) or `fresh_lineage_restart`, which
starts a fresh lineage from accepted history. A malformed checkpoint is
never restored. Historical prompts and settled effects never run again.

### Interrupted execution and recovery

Actor construction checks the saved lifecycle before it serves requests:

- A resumable Pi Durable task resumes
  ([`pi-durable-recovery.ts`](../../foundation/agent/actors/pi-durable-recovery.ts)).
  Unknown model usage waits for evidence. An unsafe effect blocks replay.
- A `checkpointing` session with an accepted checkpoint keeps its state; an
  alarm finishes publication and output.
- Any other `activating`, `processing`, `checkpointing` or `cancelling`
  session lost its driver. One transaction quarantines it with
  `effect_indeterminate` and `terminate_only`, deletes the lease, marks the
  reservation indeterminate and fails the turn stream with
  `session_interrupted`
  ([`actor-journal.ts`](../../foundation/agent/actors/actor-journal.ts)).

The Session alarm finishes checkpoint publication, settles budget
deadlines, reconciles workspace commits and Code Mode settlements, and
resumes a pending Pi turn, each after an admission check at the active
placement. Interrupted inference and tools never rerun automatically. A
consequential effect is reconciled by its own authority and stable
operation identity first. A missing acknowledgement proves neither success
nor failure. Quarantine creates no successor session.

### Execution selection and cancellation

The Tool Host selects the cheapest sufficient route: a typed capability, a
workspace operation, Code Mode in the `CodeModeSandbox` Worker, or
`WorkspaceExecutorContainer` for Linux, browser, native, media or
filesystem-heavy work. The harness and generated code cannot allocate an
executor. An executor gets immutable inputs and grants, returns artifacts
and changesets, and keeps no agent state. See
[security.md](./security.md#delivery-execution-and-responses).

Cancellation first fences runtime authority, then reaches model transport,
tool calls and any executor. Cancelling one session does not change a
sibling. A budget exhaustion fails the turn and settles the assignment as
`budget_exhausted`.

## Harness adapter

`selectEmbeddedHarnessAdapterForModelRoute`
([`embedded-harness-adapter.ts`](../../foundation/agent/actors/embedded-harness-adapter.ts))
returns one Pi Durable adapter for each route and model
([`pi-embedded-adapter.ts`](../../foundation/agent/actors/pi-embedded-adapter.ts)).
The contract is in
[`embedded-harness.ts`](../../foundation/agent/actors/embedded-harness.ts).
The Codex and Picocodex backends are retired; their checkpoints start a
fresh lineage. `AgentSessionActor` owns identity, lifecycle, leases,
history, checkpoints and budget. The adapter owns the live conversation.
The Tool Host and Tool Gateway own tool authorization and effects. Pi types
never become Pantry persistence contracts.

### Adapter interface

```ts
type EmbeddedHarnessAdapter = {
  readonly manifest: EmbeddedHarnessManifest; // backend, build, format, model
  construct(input): Result<EmbeddedHarnessRuntime, ConstructionError>;
};
type EmbeddedHarnessRuntime = {
  startTurn(input): EmbeddedHarnessStartTask; // -> EmbeddedHarnessActiveTurn
  close(): void | Promise<void>;
};
type EmbeddedHarnessActiveTurn = {
  complete(); // final message, checkpoint, cursors, model usage
  cancel();
  steer(input);
  stopAtNextStep?(notice: string): void;
};
```

Construction gets the session identity, accepted input, model and token
allowance, harness instructions, route lease, checkpoint binding, Tool Host,
history and event sinks, and turn lease. Its `source` is `fresh`,
`resume_turn`, `fresh_after_abandoned_inputs`, `fresh_lineage` or
`restore`. Persistence is `actor` (Session SQLite) or `transient` (no durable
history, such as an email turn).

The route lease carries one authority: `platform_api_key`,
`organisation_openai_api_key`, `organisation_anthropic_api_key`,
`organisation_claude_oauth` or `organisation_chatgpt_subscription`
([`pi-model-transport.ts`](../../foundation/agent/actors/pi-model-transport.ts)).
Every route except OpenRouter calls the provider through the lease's
`providerFetch`, which uses the model exit Worker. Raw credentials stay out
of Actor state, prompts, generated code and tool arguments. The adapter gets
no Actor namespace, control token, raw D1 access or executor allocation.

### Input and output

The turn input is a list of `EmbeddedHarnessUserInput` parts: `text`,
`project_context`, `image`, `attachment_text`, `attachment_media` and
`attachment_manifest`. The accepted input digest binds the turn content.

The adapter writes through two Actor-owned sinks. `appendHarnessHistory`
accepts completed user, assistant, tool-call and tool-result entries.
`acceptCanonicalHarnessEvent` accepts progress and terminal events. Each
emission names the lease, turn, sequence and digest. The Actor rejects a
stale lease or cursor. Pi's own database writes use the same queue, so they
keep their order with the emissions
([`pi-durable-runtime.ts`](../../foundation/agent/actors/pi-durable-runtime.ts)).

### Tool calls and replay

Pi gets model-visible tools from the accepted catalog
([`agent-tools/`](../../services/platform/src/agent-tools/registry.ts), selected by
[`catalog/selection.ts`](../../foundation/agent-tools/catalog/selection.ts)).
The Tool Host
([`embedded-harness-tool-host.ts`](../../foundation/agent/actors/embedded-harness-tool-host.ts))
authorizes each call against the exact capability. Code Mode is one bounded
tool, and Pantry controls each nested call. Each tool has a replay rule for a
call that a lost process left in flight
([`pi-tool-replay.ts`](../../foundation/agent/actors/pi-tool-replay.ts)):

- `any_caller`: the call changes nothing, or its owner repeats it safely.
- `script`: the owner answers a repeat from its first receipt; only a Code
  Mode script may repeat it.
- `none`: the outcome is not proven, so the turn waits.

A proposal has one identity for one assignment and request. The Case and
the Organisation answer a repeat with the first proposal.

### Pi checkpoint

The build is `PI_DURABLE_BUILD`; the format is `pantry-pi-durable-sqlite-v1`
([`pi-durable-checkpoint.ts`](../../foundation/agent/actors/pi-durable-checkpoint.ts)).
The checkpoint copies the Pi Durable tables in Session SQLite, with the
checkpoint binding and history cursor. It holds script store values and the
Code Mode attempt of a turn (`pantry.codemode.store`), but no active script
journal: an unfinished script stays in Session SQLite until it settles.
Restore refuses a checkpoint whose session, binding or cursor differs. No
build reads another build's checkpoint; the Session starts a fresh lineage.

### Streaming, steering and stop

The adapter streams answer text in bounded deltas. The Actor persists
delivery events before consumers see them. `steer` adds a message from the
turn's requester
([`harness-steering.ts`](../../foundation/agent/actors/harness-steering.ts)).
The Session admits it first. The result is `queued` (Pi places it before the
next model request) or `refused` (`turn_not_running`,
`steering_unsupported`); the surface then runs it as the next turn.
`stopAtNextStep` ends a turn before its next model call. A running call
still returns its answer and usage, and the notice becomes the last answer.
Cancellation is idempotent. `close` changes no durable state.

| Failure                                   | Result                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| Pi event malformed or out of order        | reject at the adapter boundary                         |
| History or delivery cursor stale          | reject the emission                                    |
| Pinned authority unavailable or exhausted | fail the turn; select no other route                   |
| Model usage missing                       | `embedded_harness_model_usage_missing`; await evidence |
| Token allowance used                      | `embedded_harness_token_budget_exhausted`              |
| Tool outcome indeterminate                | wait before the model sees a result                    |

## Case coordination and connector delivery

A Case is one provider-neutral body of related work. Connector bindings
project it into Slack, email or WhatsApp. Several independent sessions may
work in one Case. Provider effects outside conversation delivery belong to
the action ledger and provider receipts.

### Ingress

```text
signed Slack event
  -> Slack ingress Worker or platform Worker: verify signature
  -> ConnectorActor.admitSlackCaseWork: durable admission, then acknowledge
  -> CaseActor.prepareOngoingTurn: accept the trigger once
  -> AgentSessionActor: initialise or restore, then run the turn
  -> ConnectorActor: stream the answer into the thread
```

The Connector deduplicates events by native identity. It admits interactive
work before Slack gets its acknowledgement and starts the work at once. Its
alarm recovers expired leases and scheduled retries. A new thread creates
its Case and Session together. The Session stays empty until the Case admits
the message, and a refused message retries with the same Session. A message
that opens no agent turn (a goal message, a settled configuration change, no
model route) creates only the Case
([`case-processing.ts`](../../services/platform/src/slack/case-processing.ts)).

A `CaseTrigger` source is `connector`, `cue` or `api`. APIs, cues and
schedules may open a Case with no Connector. Such a Case emits no provider
output until it has a binding.

### Case context

The Case owns the shared journal and current revision. Each assignment gets
an immutable `CaseContextSnapshot`: the revision, journal cursor, workspace
revision, entry references and an evidence dependency. The dependency is
`source_only` or one exact CaseContextCollection revision with policy and
recipient digests ([Plan 46](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-46-case-context-discovery.md)).
`CaseContent` is `user_message`, `record_message`, `text`, `artifact`,
`commerce_reference` or `entity_plane_proposal`. A `record_message` keeps
the message and its `SourceProvenance` together. A record locator is
untrusted and grants no read or disclosure authority. Sessions submit typed
proposals. They never append shared history, select a destination, deliver
provider output or change a sibling.

### Assignments and proposals

`assignSession`, `beginAssignment` and `settleAssignment` move an
assignment through `assigned -> running -> settled`. Settlement records
`completed` (with the proposal), `cancelled`, `failed` or
`budget_exhausted`, independently of siblings. An installed agent's
assignment has a `case_assignment_pin`: installation, definition revision,
policy revision, skills, granted capabilities and token ceiling. A later
revision affects only future assignments.

The Case alone decides what becomes shared truth.
`SessionProposalDisposition` is `accepted` (new revision and outputs),
`rebase_required` (current revision) or `rejected` (`assignment_missing`,
`assignment_mismatch`, `session_mismatch`, `empty_proposal`,
`invalid_entry`, `case_not_open`). Observations are append-only and settle
in completion order. A `shared_change` against a stale revision returns
`rebase_required`. A repeated proposal returns its first disposition.

For merchant review of a governed commerce proposal, the Case moves from
`open` to `waiting { approval }`, with the action nonce as the approval
request identity. It then accepts only observations with no requested
effects. The action ledger decides. The Case projects the approval or
rejection once and returns to `open`. A rejection starts no Run. See
[security.md](./security.md#identity-approval-and-authorization).

### Addressing and output

A `CaseBinding` holds a Connector and a `ConnectorAddress`: `slack` (a
thread), `slack_channel`, `email_thread` or `whatsapp_conversation`. A Case
with no binding produces no output. With one binding, output goes there.
With more than one, the Case refuses the output
(`case_output_binding_invalid`). A `CaseOutput` source is `agent_turn`,
`commerce_outcome` or `operator_command`. The shared entry and its
`case_output` row commit in one transaction. The output holds the immutable
`ConnectorDelivery`, so delivery needs no Case lookup.

```text
case_output (pending) -> ConnectorActor.deliver -> provider effect
  -> ConnectorDeliveryReceipt -> CaseActor.acceptDeliveryReceipt (settled)
```

Delivery and receipt replay are idempotent. A receipt settles only the
output it names. A delivery is `sending` (under a lease), `retryable`,
`delivered` or `rejected`. For a streamed Slack answer, each part waits
until the turn's current information-flow binding passes the destination
check, and the final binding must pass before the stream ends
([`case-conversation-sink.ts`](../../services/platform/src/actors/case-conversation-sink.ts),
[IFC guide](../../foundation/authority/policy/information-flow/README.md)).

### Recovery

Ingress replay returns the accepted trigger. Case, Session and Connector
each restore their own state from SQLite. The Case alarm resumes the
conversation and publishes pending context projections. A failed delivery
stays in the Connector retry lifecycle. A duplicate settlement appends no
Case transition. A missing or ambiguous binding produces no provider effect.

## Cues and proactive work

A cue is a typed commerce or payment event that may justify agent work.
Cue processing ignores it, stores it or opens Case work. `OrganisationActor`
owns claims, debounce and frequency (`cue_delivery`). `CaseActor` accepts
the trigger once. Sessions own reasoning and budget. Policy and the action
ledger govern effects. The D1 `cue_log` is an audit projection only.

### Event path

```text
Stripe or Shopify webhook, or OrganisationActor.applyCommerceDelivery
  -> CUE_Q "cue.event.v1" -> compiled snapshot (POLICY_KV) -> match
  -> OrganisationActor.claimCueDelivery
  -> processDirectCaseCommand (trigger source "cue")
  -> assignment and proposal -> Case outbox -> Slack channel
```

A commerce delivery writes its cues into `commerce_cue_outbox` with the
projection. The Worker sends each to `CUE_Q` and marks it enqueued. The
Commerce outbox reconciliation sends recoverable cues again
([`commerce-outbox-worker.ts`](../../services/platform/src/commerce-outbox-worker.ts)).
A `CueEvent` carries the Organisation, integration account, source, native
identity, event type, payload and time
([`cue-engine.ts`](../../services/platform/src/cue-engine.ts)):

- `stripe`: `charge.failed`, `invoice.payment_failed`, `refund.failed`,
  `customer.subscription.deleted`;
- `shopify`: `orders/create`, `inventory_levels/update`;
- `commerce`: `payment_failed`, `inventory_shortage`, `inventory_low_stock`,
  `order_unshipped`, `tracking_stalled`, `delivery_exception`,
  `cancellation_refund_proposed`, `entity_plane_changed`.

### Subscriptions and claims

A `cue_subscription` row is a deterministic Tier 1 rule: a source and event
type, a Slack scope (workspace, channel, thread key), a debounce time, a
maximum count for each hour and a `propose` action with a template.
`compileAndStoreCueSnapshot` writes the enabled rows as one versioned
snapshot to `POLICY_KV` (`cue:<organisation>:latest`). Matching
([`cue-queue-consumer.ts`](../../services/platform/src/cue-queue-consumer.ts))
reads only this snapshot and makes no model call. `entity_plane_changed`
matches a saved commerce view through a Commerce membership read.

`claimCueDelivery` returns `claimed` (with a lease), `duplicate`,
`in_progress` (retry later) or `suppressed` (`debounce` or
`max_per_hour`). One source event and one subscription create at most one
Case trigger, and redelivery returns the first outcome. After Case
acceptance, `completeClaimedCueDelivery` records `proposed`. An unmatched
event creates no Case, session or per-event row; it only adds to a bounded
KV counter.

### Case destination

The subscription's Slack scope resolves to the channel's active Slack
connection. The Case gets a `slack_channel` binding before assignment, and
the proposal follows the ordinary outbox path. Cues never take a
destination from model output. A `cue_binding` row may name an operational
area, an agent installation and instructions for one event type
([`agent-operations.ts`](../../foundation/agent/data/agent-operations.ts));
admission resolves the current revisions and writes a `case_assignment_pin`.
An inventory cue opens a coordinator and a specialist session; other cues
open one coordinator. The principal is the system component `cue_engine`.
A cue cannot approve itself or widen an agent's authority.

### Schedules

A `schedule_binding` sets an hourly, daily or weekly window in a time zone
([`schedule-window.ts`](../../services/platform/src/schedule-window.ts)).
The fifteen-minute cron claims each due window in D1, then sends one
`agent_schedule.dispatch.v1` message to `EVENT_Q`
([`schedule-dispatch.ts`](../../services/platform/src/schedule-dispatch.ts)).
The claim fences double dispatch. A missed window is not filled in later.
The consumer opens an unbound Case, so a scheduled run emits no provider
output, and records a `schedule_dispatch_receipt`.

### Audit and failure behavior

`cue_log` records `matched`, `store_only` (suppressed, with its reason) and
`proposed` (with the Case). Queue acknowledgement is not a domain outcome.

| Failure                                    | Outcome                                |
| ------------------------------------------ | -------------------------------------- |
| Message invalid                            | log and acknowledge                    |
| No snapshot                                | acknowledge; count an ignored event    |
| Snapshot invalid, or Organisation inactive | retry the Queue message                |
| Duplicate source event                     | return the first outcome               |
| Debounce or frequency reached              | record `store_only`; create no session |
| Slack destination or Case unavailable      | retry with the same command identity   |
| Provider effect unknown                    | keep the action indeterminate          |

Open: cues derived from Case or session state (stale work, pending approval)
and Tier 3 ambient scoring do not exist.
