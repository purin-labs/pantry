# Plan 14 — Durable Actor Runtime

Status: implemented architecture · Reconciled: 2026-10-06

The Actor owns durable agent state. Route-selected harnesses and temporary
executors provide replaceable computation. Historical cutover evidence remains
in the [closure record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-closure-2026-08-02.md).

## Current execution contract

`AgentSessionActor` pins one inference authority for each session:

| Route                                  | Harness and authority                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `organisation_subscription` + `openai` | Organisation-addressed Codex App Server with the organisation's ChatGPT OAuth connection |
| `organisation_byo` + `openai`          | Pi in the Worker with a purpose-bound organisation OpenAI API key from Vault             |
| `platform` + `openai-compatible`       | Pi in the Worker with Satyr's `OPENROUTER_API_KEY`                                       |

Missing, revoked, or exhausted authority fails the selected route. Recovery
never selects another funding authority. Raw credentials remain within trusted
transport and credential boundaries. They do not enter prompts, transcripts,
generated code, accepted history, or executor storage.

[Runtime architecture: harness adapter (was Spec 4)](../architecture/runtime.md#harness-adapter) owns the adapter interface and current route
contract. [Plan 28](plan-28-organisation-codex-oauth.md) records Codex integration.
[Plan 50](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-50-pi-durable-execution-multiplayer.md) owns proposed durable
execution extensions and their unclosed acceptance gates.

## Request path

```text
Slack / Portal / provider event
  -> authorized ingress
  -> ConnectorActor or authenticated Portal admission
  -> CaseActor shared context, assignments, and output outbox
  -> AgentSessionActor history, route, checkpoints, budgets, and cancellation
  -> trusted Tool Host and governed capabilities
  -> accepted result and destination-authorized delivery
```

[Plan 15](plan-15.md) defines coordination. The selected commerce authority owns
inventory, order, payment, and fulfillment facts. BakeryOS simulation receipts
establish simulated results; physical dispatch remains scoped by Plan 24.

## Durable authority

Each fact has one owner:

| State                                                                                    | Durable authority                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| Organisation policy, quota, and provider configuration                                   | `OrganisationActor`                      |
| Provider ingress deduplication, addressing, delivery, and provider receipts              | `ConnectorActor`                         |
| Shared context, assignments, accepted proposals, and output outbox                       | `CaseActor`                              |
| Independent model-turn lifecycle, private history, checkpoints, budget, and cancellation | `AgentSessionActor`                      |
| Canonical files                                                                          | immutable workspace revision             |
| Provider effects                                                                         | Tool Gateway ledger and provider receipt |
| Temporary files and processes                                                            | current executor                         |

The Actor accepts events under one fenced runtime generation. A stale harness
or executor may return a result, but it cannot append accepted state.

Checkpoints accelerate restore. They bind to an accepted journal cursor,
workspace revision, model route, instruction digest, tool catalog, and policy
revision. Recovery replays recorded facts through deterministic reducers. It
never reruns historical prompts through the model.

Plan 14 is closed. NF9 separates the Actor's private accepted harness history
from its delivery-safe stream. Tool results become durable before a replacement
harness can continue, while Slack and the portal consume canonical delivery
events through the Connector and Case boundaries. The protocol and recovery
ordering are defined in
[the Actor-owned harness history design](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-14-nf9-actor-owned-history.md).

## NF9 Actor persistence and harness protocol map

NF9 uses two accepted streams under one fenced `HarnessTurnLease`:

```text
                    AgentSessionActor
                           |
          +----------------+----------------+
          |                                 |
          v                                 v
 private harness history             canonical delivery
 user / assistant / tool result      deltas / status / final
          |                                 |
          v                                 v
 harness reconstruction              Slack / portal replay
```

The streams have separate hash-chained cursors. A committed checkpoint binds
both cursors to the same session, turn, lease generation, model route,
instructions, tool catalog, workspace revision, and policy revision.

### Persistence surfaces

| Persistence surface                                 | Purpose                          | Payload                                                            |
| --------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `session_harness_lease`                             | current single-writer fence      | turn identity, runtime generation, delivery cursor, history cursor |
| `session_harness_history`                           | private model reconstruction     | bounded backend-neutral user, assistant, and tool-result entries   |
| `turn_delivery_segment`                             | surface replay                   | existing canonical `AgentEventEnvelope`                            |
| `session_harness_checkpoint` plus encrypted R2 blob | replacement-runtime acceleration | both cursors, semantic bindings, opaque backend continuation data  |

Large attachments and oversized model-visible results remain in existing
content-addressed storage. History rows carry bounded content or verified
references. Actor export and organisation erasure cover the history rows and
their referenced artifacts.

### Protocol ports

| Port                     | Direction                  | Responsibility                                                                  |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `EmbeddedHarnessAdapter` | Actor to backend           | construct, restore, turn, steer, cancel, close                                  |
| private history sink     | backend to Actor           | accept completed model-visible facts under the current lease                    |
| canonical event sink     | backend to Actor           | accept surface-safe progress and terminal events                                |
| `HarnessToolHost`        | backend to Satyr authority | authorize and execute tools through the gateway, workspace, or execution router |
| model-route lease        | backend to Model Gateway   | open credential-free model transport                                            |

Backend adapters translate native events exactly once. Actor persistence,
surfaces, policy, budgets, receipts, and executor placement never import Codex or
Pi event types.

### Tool-result commit order

```text
completed assistant tool call
  -> accept private history entry
  -> derive stable invocation identity
  -> authorize and execute
  -> settle or reconcile authoritative receipt
  -> accept exact model-visible tool result
  -> return accepted result to the harness
```

The harness cannot observe an unaccepted result. A replacement runtime loads
the accepted result and continues without repeating the provider effect.
`indeterminate` provider effects remain paused at the Tool Gateway boundary
until reconciliation produces a terminal receipt.

### Restore boundary

Restore performs this ordered reduction:

1. Authenticate and validate the checkpoint and both cursors.
2. Verify the private history digest chain.
3. Reduce private history to a backend-neutral conversation.
4. Let the selected adapter materialize its native message state.
5. Inject fresh model transport and tool implementations.
6. Attach both Actor sinks before continuing.

Historical prompts and settled tool effects are never rerun during restore.
Codex rebuilds ephemeral App Server threads from accepted Actor state. Pi
restores its Actor-owned checkpoint projection. Both preserve accepted history,
fencing, receipts, and the surface protocol.

The two history lanes are implemented.
[The NF9 protocol](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-14-nf9-actor-owned-history.md) defines their contract.
[Runtime architecture: harness adapter (was Spec 4)](../architecture/runtime.md#harness-adapter) defines current route-specific reconstruction.

## Naming

Use Actor terminology for Satyr's durable domain owners:

- `OrganisationActor`
- `ConnectorActor`
- `CaseActor`
- `AgentSessionActor`

An agent identity may participate in several Cases and own several independent
sessions. It is a product identity rather than another Durable Object class.

Cloudflare `DurableObject`, the deployed `SessionDO`, `CaseDO`, and
`ConnectorDO` exports, and Wrangler binding names remain provider-boundary
identifiers. Domain documentation uses Actor terminology. A provider class
rename would require an explicit storage migration and is outside this plan.

Containers and Dynamic Workers are executors, never Actors.

## Harness placement

Pi executes in the Worker. Codex App Server executes in the organisation-addressed
`CodexHarnessContainer`. The container owns live process and thread state.
`AgentSessionActor` owns accepted history and reconstructs the conversation after
container replacement. A harness container is separate from a disposable heavy
workspace executor.

The adapter translates native harness events at one boundary. The Actor controls
leases, checkpoints, budgets, cancellation, and accepted output. The Tool Host
controls capability authorization and provider effects. The harness cannot
allocate an executor, approve its own action, or broaden a grant.

## Execution routing

Use the cheapest sufficient path:

1. direct typed provider capability;
2. direct workspace read, list, search, or changeset operation;
3. bounded Worker transformation;
4. Dynamic Worker Code Mode;
5. short-lived Container for Linux, browser, native, media, or
   filesystem-heavy work.

Recurring bakery and commerce work uses existing typed capabilities. Examples
include inventory investigation, purchasing proposals, order attention, product
drafting, and accepted BakeryOS run controls.

Generated code receives typed capabilities, never credentials, arbitrary
network access, Actor bindings, or authority to approve its own effects.
Provider writes continue through policy, approval, idempotency, and audit
boundaries.

Code Mode is an internal routing strategy. Merchants buy useful tasks or
automation allowances rather than a named runtime implementation.

### Code Mode operating boundary

The retained execution foundation includes the Actor-owned `HarnessToolHost`,
direct typed tools, a digest-bound JavaScript entrypoint, deterministic
Dynamic Worker selection, organisation and platform budget reservations, fenced
leases, capability-call accounting, durable settlement, and one terminal
receipt identity per admitted execution.

The harness and generated program cannot choose an executor. Generated code
receives a frozen execution-scoped capability surface without credentials,
Actor bindings, arbitrary network access, package installation, raw SQL, or
raw provider clients. Trusted Satyr code rechecks organisation, session, turn, lease,
policy, catalog, and budget authority for every nested call. Nested Code Mode
executions are rejected.

Subagents use the explicit `CaseActor` assignments defined by
[Plan 15](plan-15.md). Code Mode performs bounded filtering, joining,
aggregation, and branching inside one assignment. It does not create a second
child-agent or shared-state protocol.

Execution context comes from an immutable Case revision, Actor-owned session
history, stored attachments, typed tool results, or an immutable workspace
revision. The deleted `ThreadActor` is absent from this path.

## Workspace contract

Immutable revisions remain canonical:

```text
immutable revision
  -> materialize or read directly
  -> bounded work
  -> artifacts + validated changeset
  -> accept new revision
  -> destroy executor
```

Ordinary reads, edits, grep, glob, and structured transformations should not
wake a Container.

A mutable SQLite/R2 working-tree facade is optional. Add it only after a
measured file-operation bottleneck. It remains a cache or branch over an
immutable base revision, never the canonical multi-writer authority.

Concurrent writers submit changesets against explicit base revisions. A stale
base produces a conflict or explicit merge. A raw shared writable mount is
outside the design.

## Verification and evidence

Changes must preserve replacement recovery, stale-result rejection, organisation
isolation, credential authority, and an end-to-end operator journey. Reuse the
current [E2E coverage guide](../../test-coverage-e2e.md) and owning feature evidence.
Do not rerun retired cutover commands as current acceptance instructions.

The [Plan 14 closure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-closure-2026-08-02.md) records the historical
placement cutover. The [NF9 production closure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-nf9-production-closure-2026-08-08.md)
records history and checkpoint acceptance. Those dated results do not certify
later harness builds or deployments.

## Cost rule

Measure cost per successful task: inference, Actor CPU and storage, Dynamic
Worker execution, container startup and residency, artifacts, and failed work.
Reserve and settle the task budget through existing authorities. Use measured
operator value to justify recurring autonomous work.

[Economics](../economics-costs.md) retains dated planning inputs. Its earlier cost
comparisons do not establish current provider prices or production performance.

## Scope limits

The runtime provides one durable authority for each fact. General desktop
filesystem synchronization, unrestricted generated code, and physical robot
control are outside this architecture. Existing provider names and deployment
bindings remain stable at their persistence and request boundaries.
