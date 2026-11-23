# ENG-01 — Decision log

This log records the 48 architecture decisions of Purin Pantry, AD-001 to AD-048. Each
entry keeps its number and its date, because a decision log is a record of decisions.
Each entry gives the decision and its reason in the current names, and a state that
comes from a check against the code. Where the original text and the code differ, the
entry states what the code does. A decision that the code no longer follows is marked
superseded and names what replaced it. The subsystem specs describe the built behavior
in full. This log says why that behavior has its shape.

## What it does

### How to read an entry

Each entry has the form **number, date, state: title**, then the decision and the
reason. A later note in the same entry describes the code today.

| State         | Meaning                                                                      | Decisions |
| ------------- | ---------------------------------------------------------------------------- | --------: |
| Holds         | The code follows the decision                                                |        13 |
| Holds in part | The code follows the named part. The entry says what changed or is not built |        22 |
| Superseded    | The code does not follow the decision. The entry names the replacement       |        10 |
| Not built     | The decision stands, and no code implements it                               |         2 |
| Closed        | The decision was a one-time action, and the action is complete               |         1 |

### Runtime and placement

- **AD-001, 2026-07-04, Holds: Cloudflare-native runtime.** Workers, Durable Objects,
  Containers, D1, R2 and Queues are the substrate. Actors own serialized domain state, D1
  owns control records and R2 owns large immutable files. Queues carry durable
  asynchronous work. Containers run only for heavy or isolated work.
- **AD-005, 2026-07-06, Superseded: one container for each Session.** Per-session
  containers and warm container pools are removed. `AgentSessionActor` runs the harness
  in the Actor. It allocates a disposable `WorkspaceExecutorContainer` only for
  Linux-heavy work.
- **AD-011, 2026-07-07, Holds in part: an Actor id embeds the Organisation id.** The
  reason is tenant isolation. Organisation, Case, Session and Connector names start with
  the Organisation id. `CodeModePlatformGovernorActor` is one platform-wide object, and
  one `MessageLinkFetchContainer` serves each location hint. Their names have no
  Organisation id. AD-023 adds the epoch to the name.
- **AD-012, 2026-07-07, Superseded: `OrganisationActor` owns admission quotas.** The
  decision also removed a separate runner object, and no such object exists. No code
  enforces an Organisation limit of concurrent Sessions, and no error names one. One
  Connector runs at most 4 Case turns at a time (`CASE_WORK_CONCURRENCY`). The AI budget,
  the Code Mode budgets and the `max_instances` of each container class also limit the
  work.
- **AD-020, 2026-07-07, Superseded: greenfield, no live migration.** AD-039 replaced
  this decision when live state existed. Plan 93 later started a new stack with empty
  storage, so no stored value of the old stack remains.
- **AD-022, 2026-07-10, Holds in part: production gates and placement cells.** The
  decision named five gates: Session start, placement, Actor registration, Actor schema
  safety and context retrieval quality. Placement, registration and schema safety are
  built for the four registered Actor kinds. The D1 check on `object_kind` still allows
  the retired kinds `surface` and `thread`. `ConversationResidencyActor` has no registry
  row, but its name holds the physical name of its Connector, so the epoch reaches it.
  The pool parts of the gates ended with AD-005. Plan 3 records that a location hint is
  best effort and that only a jurisdiction is a hard boundary.
- **AD-023, 2026-07-10, Holds in part: placement epochs and the Actor registry.** A
  placement is fixed within one `placement_epoch`. A move reserves the next epoch,
  freezes the old one, copies and verifies the state and then publishes the new epoch.
  From epoch 2, a physical name ends in `:p<epoch>`. Epoch 1 has no suffix. The registry
  lifecycle is `reserved`, `active`, `exporting`, `retired` and `quarantined`.
  Residency allows `eu` and `fedramp`. Production has one `affinity` cell,
  `production-apac`. The regional pool shards of this decision are removed.
- **AD-025, 2026-07-10, Holds in part: resumable Sessions.** A thread is a long
  conversation, and idle compute must not end it. The Session keeps its state and an
  encrypted checkpoint, and it reactivates under a new generation. AES-GCM with an HKDF
  key protects the checkpoint. The sandbox and hibernation steps ended with AD-005 and
  AD-038. If the backend, build, format or model route differs, the Session starts a
  fresh lineage from its accepted history. A corrupt checkpoint fails the turn.
- **AD-026, 2026-07-11, Superseded: fleet capacity admission.** The capacity governor,
  the fleet manifest and the warm pool manager are not built or are removed. A fixed
  `max_instances` for each container class replaces them.
- **AD-038, 2026-07-28, Holds: the Actor lifecycle and the harness boundary.** The
  Session lifecycle is a closed set: `sleeping`, `activating`, `processing`,
  `recovering`, `checkpointing`, `cancelling`, `quarantined` and `terminal`. The code
  added `recovering`. Process eviction is a hosting event and not a lifecycle state.
  Harness adapters report facts, and the Actor derives the lifecycle. An adapter
  declares each effect as `idempotent`, `reconcile_by_stable_lookup` or
  `unsafe_to_retry`.
- **AD-039, 2026-07-28, Holds in part: bounded forward migrations for Actors.** Actor
  schemas move forward only. `runSchemaMigrations` stops an Actor at a version below the
  baseline or above the code. The first cutover that this decision named (schema 22 to 23) belongs to the old stack.
- **AD-040, 2026-08-03, Holds: Connector, Case and Session.** `ConnectorActor` owns
  provider ingress and delivery receipts. `CaseActor` owns shared context, assignments,
  accepted proposals and the output outbox. `AgentSessionActor` owns one restorable
  reasoning lineage. The Case alone decides which proposal becomes shared truth, so
  provider transport stays apart from reasoning state.

### Agent harness, context and streams

- **AD-004, 2026-07-06, Superseded: a two-track harness adapter.** AD-045 replaced the
  Managed Agents and container tracks, and the single Picocodex harness after them.
- **AD-024, 2026-07-10, Holds in part: latency and response streams.** The target is
  provider latency plus a small Pantry overhead. An answer that continues past the
  first release uses the native stream (`chat.startStream`, `chat.appendStream`,
  `chat.stopStream`). A short answer ends in one `chat.postMessage`. The Connector
  reads each event from the Session replay stream. The output check runs on each part
  and releases only a safe prefix. The warm pool, harness pre-initialization and the
  text-only edge route are removed. Warm Case and Session Actor slots exist, and they
  are a different mechanism.
- **AD-027, 2026-07-15, Holds in part: replaceable context and cues.** Canonical
  records are the truth. Search projections can be rebuilt. The assembler
  (`context/assembly`) emits a bounded bundle with provenance and a strategy version.
  The projection is SQLite full-text search, with no vector store. The Cue Engine reads
  `CueEvent` values and decides attention. Cue conditions are not built.
- **AD-045, 2026-08-19, Holds: Pi is the agent harness.** Every model route runs Pi.
  Each Session pins one route, and a missing or exhausted authority fails that route.
  Recovery never changes the funding authority. Pi data ends at the adapter boundary.
  The retired backends `picocodex` and `codex` restart from a fresh lineage.

| `keySource`                 | Provider                        | Authority                                                    |
| --------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `platform`                  | `openai-compatible`             | The Purin `OPENROUTER_API_KEY`                               |
| `organisation_byo`          | `openai`, `anthropic`, `google` | A purpose-bound key of the Organisation in the Vault         |
| `organisation_oauth`        | `anthropic`                     | The Claude account of the Organisation                       |
| `organisation_subscription` | `openai`                        | The ChatGPT sign-in, through pi-ai's `openai-codex` provider |

### Policy, approval and the Vault

- **AD-006, 2026-07-07, Holds in part: identity signing and the Vault are separate.**
  The Vault holds merchant secrets at rest. The wallet identity is not a secret store.
  AD-033 made wallet signing one optional approval branch, and that branch is not ready
  for use.
- **AD-009, 2026-07-07, Superseded: raw low-stakes tools, typed high-stakes tools.** The
  raw in-container path is removed. Each provider effect now crosses a trusted typed
  capability boundary. Code Mode and the executor receive only frozen, scoped
  capabilities, and the executor container has no internet access.
- **AD-010, 2026-07-07, Holds in part: layered policy under three rules.** Platform
  floors are not editable, grants live in structured rules, and looser layers can only
  restrict. The built form is one `organisation_capability_policy` row for each
  capability: `enabled`, `approval_required` or `disabled`. The catalogue limits the
  modes of each capability. Surface overrides, policy as code and an LLM advisor are not
  built.
- **AD-014, 2026-07-07, Not built: a predicate is a JSON AST.** The decision chose a
  small bounded AST over a CEL interpreter, for determinism and a small attack surface.
  No predicate engine exists. The Cue Engine writes `cue_subscription.condition` as
  `NULL`.
- **AD-015, 2026-07-07, Holds in part: GraphQL providers are typed only.** GraphQL puts
  each operation on POST, so a method rule cannot separate reads from writes. The
  built-in Shopify provider has no raw path. Its one registry action is
  `shopify_order_cancel`. The registry has no typed read passthrough verb. A custom API
  connector is a separate path, and its host check does not refuse a Shopify host.
- **AD-016, 2026-07-07, Holds: Vault envelope encryption.** Plan 3 records that a
  Secrets Store binding is one deploy-time secret, so it cannot hold a secret that an
  Organisation adds at run time. Root keys stay in Secrets Store. Wrangler binds
  `VAULT_ROOT_V1`, and the keyring also accepts an optional `VAULT_ROOT_V2`. Organisation
  ciphertexts stay in regional D1 (`vault_secret`).
- **AD-017, 2026-07-07, Holds in part: one action registry.** One registry defines 9
  provider actions, because hand-written copies drift: 8 for Stripe and 1 for Shopify.
  `actions:generate` builds `generated/action-registry.ts`. Only `shopify_order_cancel`
  has a runtime caller, and other provider effects do not use the registry. The
  in-container command shims are removed with the raw path.
- **AD-018, 2026-07-07, Holds in part: action ledger and resource serialization.** An
  idempotency key does not stop two different actions on one resource, such as two
  refunds of one order. `action_ledger` in `OrganisationActor` SQLite tracks `proposed`,
  `approval_requested`, `signed`, `executing`, `confirmed`, `failed`, `rejected`,
  `indeterminate` and `expired`. An action enters `executing` only if no other entry of
  its account and resource key is `executing` or `indeterminate`, or was `signed`
  before it. Otherwise it gets `resource_busy`. So approvals of one resource run in the
  order of their signs. Expiry applies only to `proposed`, `approval_requested` and
  `signed`. An `indeterminate` entry never expires, so it holds its resource key until a
  retry or a reconciliation settles it. A commerce key includes the action kind, so the
  ledger does not serialize a refund and a cancellation of one order.
- **AD-019, 2026-07-07, Superseded: split read and write credentials.** The split
  protected the raw path, and that path is removed. A connection holds one provider API
  credential (`credential_ref`). A Stripe or Shopify webhook signing secret is a separate
  Vault secret (`provider_webhook.signing_secret_ref`). All 9 registry actions declare
  the `write` scope.
- **AD-021, 2026-07-07, Holds in part: conversation-risk guardrails.** Guardrails only
  restrict. Natural-language rules and LLM evaluation of actions stay rejected. The
  output screen is built for Slack: it holds emails, card numbers, credentials and
  internal model markers. In a Slack direct message, it holds only the markers.
  A flow denial only refuses: it has no halt, escalation or coaching action. Suspicion
  escalation and redaction at rest are not built.
- **AD-033, revised 2026-08-05, Holds: approval is provider-neutral.**
  Pantry owns the identity, the role, the challenge and the receipt. An authentication
  provider only proves control of a principal. Each approval binds the action digest,
  the Organisation, the policy binding, the expiry and the nonce. The binding today is
  `unversioned_default`. An agent proposes and cannot approve.

| Approval branch       | State in the code                                          |
| --------------------- | ---------------------------------------------------------- |
| `google_oidc_step_up` | In use                                                     |
| `slack_verified_link` | In use for six action kinds that move no money             |
| `webauthn_step_up`    | Parsed. Readiness is false (`webauthn_credential_missing`) |
| `seams_nep413`        | Parsed. Readiness is false (`seams_identity_unlinked`)     |

- **AD-034, 2026-07-15, Holds in part: audience and retention policy.** Customer
  messages never grant authority. Each `integration_account` row must carry an
  `audience_policy` and a `retention_policy`. The audience is `operator` or `customer`
  with consent. The only retention is `organisation_default`: no retention period is
  built.

### Connections and channels

- **AD-002, 2026-07-06, Holds: Slack is an unlisted app with a forward stream.** Plan 3
  records that Slack capped history reads for unlisted apps at 15 messages a minute from
  2026-03-03. A bulk backfill is therefore not practical. Messages reach Pantry through
  the Events API. The one history call reads the files of one message.
- **AD-008, 2026-07-07, Holds: no matterbridge.** It is a long-running process and a
  simple relay, so it fits neither the runtime nor the domain. `ConnectorActor` owns
  ingress and delivery.
- **AD-028, 2026-07-15, Holds: connections and integration accounts.** A
  `provider_connection` is one authorization grant. An `integration_account` is one
  external resource behind it. One connection can expose many accounts, and provider
  resource ids are never treated as globally unique.
- **AD-029, 2026-07-15, Holds: shared Pantry provider applications.** Small businesses
  connect through provider applications that Purin owns. `auth_mode` is
  `shared_pantry_app`, `api_key` or `webhook_secret`. `provider_authorization_state`
  binds a hashed single-use state to the Organisation, the user, the provider and the
  expiry. Applications for each Organisation are deferred.
- **AD-030, revised 2026-08-25, Holds in part: WhatsApp is customer support first.**
  Each phone number has a customer audience and an ingress policy (`enabled` or
  `disabled`). A reply must fall in the 24-hour service window. The customer identity
  comes from `wa_id`. The decision required an exact approval for each reply. Plan 83
  changed this: `agent_mode` is `off`, `draft` or `answer`, with the default `answer`.
  In `draft`, each agent reply waits for a person. In `answer`, a reply on a matched
  topic goes at once, with no approval. A message that names an always-wait topic still
  waits for a person. If no topic matches, the fixed acknowledgement goes with no agent
  and no approval. In `off`, the fixed acknowledgement also goes with no approval. An
  operator mode is deferred.
- **AD-031, 2026-07-15, Holds in part: Shopify authority.** Shopify stays the authority
  for the records of a Shopify shop. The Meta half of this decision is not built: no
  `catalog_link` record and no Meta catalog code exist.
- **AD-032, 2026-07-15, Not built: TikTok Shop keeps its records.** TikTok would stay
  the authority for its orders, and Pantry would keep projections only. No TikTok code
  exists.
- **AD-047, 2026-08-29, Holds in part: a compiled provider catalogue.** One closed
  catalogue (`provider-adapters/catalogue.ts`) is compiled into the Worker, and a missing
  entry is a type error. It has 10 providers: Airtable, Dropbox, Gmail, Google Drive,
  Notion, Shopify, Slack, Square, Stripe and WhatsApp. Airtable, Gmail, Notion and
  WhatsApp have no observe step (`observeUnsupportedConnection`). Shared lifecycle code
  still branches on some provider names. Custom API connectors and the merchant plugins
  of the commerce engine are later, separate extension paths.

### Commerce

- **AD-003, 2026-07-06, Superseded: Rust owns the contracts.** Pantry's contracts are
  TypeBox schemas in TypeScript packages (Plan 78). One Rust-only wire protocol remains:
  `crates/cobot-protocol` joins the shop gateway and the controller simulator. Rust also
  keeps the executor, the shop gateway and the physics code. Python is not confined to
  sandboxed tools now: the shop voice service and the Kitchen scripts use it.
- **AD-036, 2026-07-27, Holds: commerce authority.** The commerce engine is the only
  writer of its transactional state: catalog, checkout, orders, stock, payments and
  fulfillment. Shopify and other external systems stay the authority for their records.
  Pantry owns projections, Cases, policy, approvals and receipts. The old module names
  map to Sous Chef and the Commerce Read Layer. One old module is removed.
- **AD-037, 2026-07-27, Holds in part: modules and deployments are separate.**
  Repository proximity does not merge authority. Runtimes use versioned APIs and signed
  events, with no shared database and no private imports. The Rust kernel of this
  decision is gone. The contracts are in `packages/commerce-contracts`, the client is in
  `packages/commerce-client`, and Punter is in `scripts/punter`.
- **AD-042, 2026-08-03, Holds in part: cloud application, optional desktop.** The cloud
  records need no local filesystem, and a desktop layer stays optional and deferred.
  AD-043 and AD-044 replaced the kernel model of this decision.
- **AD-043, 2026-08-08, Holds in part: commerce deliveries.** A provider delivery is one
  `CanonicalCommerceDelivery`. `OrganisationActor` applies it in one SQLite transaction.
  An exact repeat is a `duplicate`, and other content under the same id fails with
  `commerce_delivery_conflict`. AD-044 replaced the Shopify-derived domain model.
- **AD-044, 2026-08-11, Holds: merchant-native commerce and a stock ledger.** Product,
  offer, inventory, checkout, order, payment, preparation and fulfillment are separate
  aggregates. Movements, allocations and lots are the stock facts, and positions are
  derived. A stock count gives an observed quantity, and the engine records it as a
  `stock_count` movement.

### Product direction and authoring

- **AD-007, 2026-07-07, Superseded: no CRDT or OT for thread sync.** Threads use
  Case-owned revisions and append-only history. Thread and file sync are deferred. Yjs
  CRDTs are in use for shared drafts, which AD-048 covers.
- **AD-013, 2026-07-07, Closed: the first plan became a record.** Its surviving
  decisions moved into this log, and its file was deleted on 2026-08-03.
- **AD-035, 2026-07-26, Superseded: file-native commerce content.** AD-041 deferred this
  direction, and AD-048 retired its plans.
- **AD-041, 2026-08-03, Holds: no file-native commerce or file sync.** Desktop
  applications, local projections and external file sync are deferred. A new
  owner-approved plan must cover authority, sync, security, contracts and migration. The
  immutable workspace revision of the executor is a separate internal boundary.
- **AD-046, 2026-08-19, Holds in part: bakery and café automation.** Pantry operates the
  full bakery and café business. The decision leaves emergency stop and safe motion to a
  machine controller. The repository holds only a simulated controller, and the gateway
  protocol has no raw motion command. If the connection is lost or the device is
  revoked, Pantry sends no new task. Plan 24 replaced the first path of this decision
  (one export route) with a cobot bake in the first café kitchen, in simulation.
- **AD-048, 2026-09-08, Holds in part: feature-scoped collaborative authoring.** Shared
  application drafts are the authority, and publication is a separate governed action.
  Purin builds no merchant websites. Agents edit a draft through typed tools in its
  shared room.

## Contracts

The log owns no table, route, event, capability or agent tool. The decisions rest on
these records and files, under `workers/platform/src/` unless a path has another root.

| Topic         | Records                                                                                                                  | Main files                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Actors        | Bindings `ORGANISATION`, `CASE`, `SESSION`, `CONNECTOR` (classes `OrganisationDO`, `CaseDO`, `SessionDO`, `ConnectorDO`) | `actors/organisation.ts`, `actors/case.ts`, `actors/agent-session.ts`, `actors/connector.ts`          |
| Placement     | `organisation_placement`, `durable_object_registry`, `state_object_relocation`, `state_object_restore`                   | `placement.ts`, `actors/actor-registry.ts`, `actors/actor-export.ts`                                  |
| Schema        | `do_schema_meta`, `do_schema_migration`                                                                                  | `actors/schema-migrations.ts`, `actors/actor-schema-versions.ts`                                      |
| Harness       | `session_harness_checkpoint`, `session_harness_history` (Actor SQLite)                                                   | `packages/contracts/src/model-route.ts`, `harness-checkpoint.ts`, `actors/pi-durable-runtime.ts`      |
| Lifecycle     | `AgentSessionLifecycle`, `TurnLifecycle`                                                                                 | `packages/contracts/src/session-schemas.ts`                                                           |
| Streams       | `IncrementalScreenState`                                                                                                 | `slack/stream.ts`, `redaction.ts`, `incremental-output-screen.ts`, `actors/connector-slack-stream.ts` |
| Context, cues | `context_projection`, `context_projection_fts`, `cue_subscription`                                                       | `context/`, `cues/engine.ts`                                                                          |
| Policy        | `organisation_capability_policy`                                                                                         | `policy-snapshot.ts`, `authorization/capability-catalogue.ts`                                         |
| Approval      | `action_ledger` (Actor SQLite)                                                                                           | `actors/action-ledger.ts`, `approval-authentication.ts`, `commerce/action-model.ts`                   |
| Actions       | `ActionDef`, `CanonicalAction`                                                                                           | `workers/platform/action-registry/registry.ts`, `generated/action-registry.ts`                        |
| Vault         | `vault_secret`                                                                                                           | `credential-vault/`                                                                                   |
| Connections   | `provider_connection`, `integration_account`, `provider_authorization_state`                                             | `provider-adapters/catalogue.ts`, `provider-workflows/`, `provider-lifecycle/`                        |
| WhatsApp      | `whatsapp_ingress_policy`, `whatsapp_ingress_policy_revision`                                                            | `whatsapp/`, `actors/connector-whatsapp.ts`                                                           |
| Commerce      | `CanonicalCommerceDelivery`; engine stock tables                                                                         | `actors/commerce-projection.ts`, `services/commerce/src/`, `packages/commerce-contracts/`             |
| Drafts        | Yjs documents in the `*-crdt` packages                                                                                   | `packages/collaboration/`, `actors/workflow-draft.ts`                                                 |

## Rules and limits

### Rules of the log

- A decision keeps its number and its date. A number is never used again.
- A new decision takes the next number, AD-049.
- To reverse a decision, add a new one, and mark the old one superseded.
- If the code stops following a decision, correct its state in the same change.

### Permissions

The log is a document and has no role check. These decisions fix who can act:

| Action                                       | Viewer | Operator                              | Admin and owner                                  | Agent                          |
| -------------------------------------------- | ------ | ------------------------------------- | ------------------------------------------------ | ------------------------------ |
| Approve an `action_ledger` entry (AD-033)    | No     | No                                    | With a step-up, or on a Slack card for six kinds | No. It proposes                |
| Decide a bake proposal (AD-046)              | No     | Yes, in the Portal or on a Slack card | Yes, in the Portal or on a Slack card            | No. It proposes                |
| Approve a WhatsApp reply proposal (AD-030)   | No     | No                                    | Yes, with no step-up                             | No. See the note below         |
| Approve a workflow change proposal (Plan 84) | No     | No                                    | Yes, with no step-up, only the person who asked  | No. It proposes                |
| Answer an agent permission request (AD-010)  | No     | No                                    | Yes, with no step-up                             | No. It asks                    |
| Change a capability policy mode (AD-010)     | No     | No                                    | Yes                                              | Asks with `request_permission` |

An owner, an admin or an operator can also tell the agent to send a WhatsApp reply. The
tool `whatsapp_support_reply_send` sends only text that is verbatim in that request, and
it records that person as the approver.

### Limits that the decisions fix

| Limit                                         | Value    | Constant or place                                                                                  |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| Session schema version                        | 33       | `CANONICAL_SESSION_SCHEMA_VERSION`                                                                 |
| Organisation, Case, Connector schema versions | 10, 2, 2 | `ORGANISATION_ACTOR_SCHEMA_VERSION`, `CASE_ACTOR_SCHEMA_VERSION`, `CONNECTOR_ACTOR_SCHEMA_VERSION` |
| Checkpoint plaintext                          | 16 MiB   | `MAX_CHECKPOINT_PLAINTEXT_BYTES`                                                                   |
| WhatsApp service window                       | 24 hours | `WHATSAPP_SERVICE_WINDOW_MS`                                                                       |
| Workspace executor instances                  | 4        | `max_instances`, `workers/platform/wrangler.jsonc`                                                 |
| Link fetch, custom connector fetch instances  | 1, 10    | `max_instances`, `workers/platform/wrangler.jsonc`                                                 |

### Information flow

The log holds no customer data. [FND-07](../foundation/07-information-flow.md) owns the
flow rules that AD-021, AD-027 and AD-034 depend on.

### Out of scope

The log does not repeat subsystem behavior and is not a plan of work. The original
text, with its status and milestones, stays in the source document.

### Boundaries

| Decisions                      | Owner of the built behavior                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| AD-001, AD-011, AD-022, AD-023 | [FND-01](../foundation/01-tenancy-and-placement.md), [FND-02](../foundation/02-actor-runtime.md)            |
| AD-025, AD-038, AD-039, AD-040 | [FND-02](../foundation/02-actor-runtime.md), [FND-03](../foundation/03-cases-sessions-and-conversations.md) |
| AD-024, AD-045                 | [FND-04](../foundation/04-agent-harness-and-model-routes.md)                                                |
| AD-027                         | [FND-05](../foundation/05-messages-attachments-and-context.md), FND-03                                      |
| AD-010, AD-018, AD-033         | [FND-06](../foundation/06-identity-policy-and-approval.md)                                                  |
| AD-006, AD-016                 | [FND-08](../foundation/08-vault.md)                                                                         |
| AD-003                         | [FND-11](../foundation/11-contracts.md)                                                                     |
| AD-048                         | [FND-10](../foundation/10-shared-drafts.md), CAFE-01                                                        |
| AD-002, AD-028, AD-029, AD-047 | INT-01                                                                                                      |
| AD-030                         | INB-01, INT-01                                                                                              |
| AD-036, AD-043, AD-044         | [COM-01](../areas/commerce/01-commerce-domain.md), COM-02, COM-03                                           |
| AD-046                         | KIT-01, [DEV-01](../areas/devices/01-devices.md), Plan 24                                                   |

## Open work

- **Actors outside the registry.** `DeviceFleetActor` and `BakeRunActor` have no registry
  row and no epoch in their names, so a placement move does not carry their state.
  `ConversationResidencyActor` has no registry row and no placement export, but the epoch
  reaches its name through its Connector. AD-022 asks for each state-bearing Actor to be
  registered.
- **Not built from a decision:** the predicate AST (AD-014), TikTok Shop (AD-032) and
  the Meta catalog link (AD-031). Also not built: suspicion escalation and redaction at
  rest (AD-021), an applied retention period (AD-034), and policy as code (AD-010).
- **Action ledger.** A refund and a cancellation of one order are not serialized
  (AD-018).
- **Approval branches.** WebAuthn and the wallet branch have no working ceremony. A
  versioned policy binding must exist before an Organisation can select one (AD-033).
- **Residency.** No residency cell is deployed. EU and FedRAMP cells stay closed until
  every substrate of the cell has a proven boundary (AD-023).
- **WhatsApp.** Live acceptance depends on Meta approval
  ([blocked and deferred tasks](../../blocked-deferred-tasks.md)).
- **Deferred:** the desktop layer and file sync (AD-041, AD-042), applications for each
  Organisation (AD-029), the internal WhatsApp mode (AD-030).

These questions from the original log stay undecided:

- Retention and erasure across all stores.
- Reliability of agent commerce.
- Placement, capacity and residency beyond one cell, from measured workloads only.
- Quality limits for agent memory and context assembly.
- Approval fatigue: the cost of each prompt to the operator, measured in lab stores.

## Sources

- [Plan 3](../../history/plan-3-decisions.md). Where it differs from the code, this spec follows
  the code.
- Evidence in the archive:
  [Plan 32](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-32-whatsapp-customer-support.md),
  [Plan 42 release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md),
  [Refactor 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-2.md).
- E2E journeys in `workers/platform/tests/e2e/`: `placement-move.test.ts`,
  `actor-activation-placement.test.ts`, `checkpoint-restart.test.ts`,
  `chat-model-route-unavailable.test.ts`, `claude-oauth.test.ts`,
  `slack-actor-journey.test.ts`, `slack-commerce-approval.test.ts`,
  `commerce-write-permission.test.ts`, `providers-connection.test.ts`,
  `inbox-whatsapp.test.ts`, `commerce-lab.test.ts`, `collaboration-drafts.test.ts`,
  `bake-run.test.ts` and `cobot-gateway.test.ts`.
