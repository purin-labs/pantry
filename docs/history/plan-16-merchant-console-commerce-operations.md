# Plan 16 — Merchant Console and Commerce Operations

Status: complete. The merchant commerce loop, integrations, policy-selected
authentication readiness, structured automation configuration, Actor-owned
history, and automatic retained-data erasure are implemented.
Date: 2026-08-03 · Updated: 2026-08-24
Depends on:
[Plan 5 — Merchant Onboarding Experience](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-5-merchant-onboarding-experience.md),
[Plan 9 — Commerce Kernel and Provider Integration](plan-9-commerce-lifecycle-lab.md),
[Plan 15 — Case-Centered Multi-Session Actors](plan-15.md),
[Plan 14 NF9 — Actor-Owned Harness History](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-14-nf9-actor-owned-history.md),
[Plan 21 — CafeOS UX Foundation](plan-21-cafeos-ux-foundation.md),
[Plan 22 — Commerce Domain Replacement](plan-22-commerce-capabilities-and-storefront-demos.md), and
[Plan 24 — CafeOS Bakery Automation](../plan-24-cafeos-bakery-automation.md), and
[Refactor 2 — Statically Compiled Integration Adapters](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-2.md).

[Plan 19 — Organisation Commerce System](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-19-organisation-commerce-system.md) owns
commerce-system selection, role-specific connections, and the migration from
the combined setup-account model.

Current reading guide (2026-10-06): this plan records the accepted merchant
console foundation. [Plan 31A](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31A-commerce-entity-plane-lists-and-views.md)
owns the implemented entity-plane replacement. [Runtime architecture: harness adapter (was Spec 4)](../architecture/runtime.md#harness-adapter)
owns all three current inference routes. Picocodex references and dated test
counts below describe the original acceptance only.

## Product direction

Plan 16 provides the merchant operations foundation consumed by CafeOS. A
merchant connects the required accounts, sees provider-owned commerce truth in
the operator console, asks questions through Slack, and submits governed
proposals with durable receipts. Provider systems remain authoritative for
transactional state. Satyr owns organisation-scoped projections, Cases, policy
decisions, proposal records, and delivery evidence.

[Plan 24](../plan-24-cafeos-bakery-automation.md) owns the active operating path:
export-oriented bakery commerce, production automation, one measured robotics
integration, and robot fleet access. Slack carries instructions, approvals,
exceptions, progress, and final receipts. Plan 16 continues to own the shared
console, agent, Case, playbook, governance, and approval contracts used by that
path.

[Commerce Domain Architecture](../commerce-domain-architecture.md) owns the
merchant-native aggregates and invariants. Plan 9 owns versioned provider
adapters, signed delivery, projections, query semantics, and governed command
mechanics. Plan 22 owns the breaking replacement and the Cafe / Patisserie plus
online packaged-goods proofs.
The Lexicon role names shared domain contracts; the Blotter role names
rebuildable merchant views. Plan 16 owns authenticated merchant operations,
Cases, agent configuration, approvals, and receipt presentation. Plan 21 owns
CafeOS presentation. Plan 16 defines no second commerce model.

The operating sequence is:

```text
NF9 harness closure
  → integrations dashboard
  → Plan 9 canonical spine correction
  → commerce query APIs
  → products and orders dashboard
  → governed management actions
  → end-to-end merchant acceptance
  → operational areas and Agents
  → playbook and agent configuration
  → Plan 22 merchant-native replacement
  → Plan 21 capability-gated CafeOS operations
  → Plan 24 bakery export and robot-assisted production
```

This plan extends the contracts and ownership already defined by Plan 5, Plan
9, Plan 15, and NF9. It does not create a second integration model, commerce
authority, actor hierarchy, or session-history store.

### Implementation outcome after Refactor 2

The completed integrations dashboard now consumes one typed Portal
presentation catalogue, while the Worker consumes one exhaustive executable
catalogue for Airtable, Gmail, Notion, Shopify, Slack, Stripe, and WhatsApp.
Shared lifecycle owns attempts, Vault, D1, retries, and receipts; compiled
provider workflows and protocol modules own provider sequencing and API
mechanics. Connect, observe, disable, reconnect, and remove actions therefore
use the same lifecycle boundary instead of Portal-specific provider branches.

## Layer boundary

Plan 16 is filesystem-independent. The merchant console manages canonical
cloud records through authenticated APIs:

```text
Commerce Domain Architecture and Plan 9 provider boundary
  -> authenticated query and command APIs
  -> Plan 16 merchant console
  -> Cases and AgentSessionActors
```

The console may later gain a desktop client, local SQLite projection, folder
import/export, and synchronized Markdown playbooks. Those are optional adapters
over the same records and commands. They cannot become prerequisites for the
web console, agent runtime, or commerce backend.

The merchant-facing model has six primary concepts:

| Concept            | Meaning                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| Operational area   | A responsibility domain such as inventory, fulfillment, customer care, or marketing |
| Agent profile      | A versioned role, purpose, instructions, and capability requirements                |
| Agent installation | One organisation's active use of an exact agent-profile revision                    |
| Playbook           | Merchant-readable operating procedure attached to areas and agents                  |
| Governance         | Merchant-owned capability grants, autonomy, approvals, budgets, and escalation      |
| Case               | One live body of work coordinated across people and independent agent sessions      |

Connections use three merchant-readable roles:

```text
Organisation
├── Commerce system: Satyr Commerce or Shopify
├── Payment connections: Stripe
└── Communication connections: Slack
```

Plan 19 owns this role model. The console presents one selected commerce
system, independent payment connections, and independent communication
connections and destinations.

Markdown is suitable for instructions and playbook bodies. Structured cloud
records own identity, assignment, cues, schedules, effective grants, approvals,
and lifecycle. A file representation can be added later without changing these
contracts.

This document is a completed implementation record. Historical milestone tables
describe the accepted slice and excluded breadth; they create no remaining
Plan 16 backlog. New CafeOS behavior belongs to Plan 24 or a focused plan
created after a demonstrated need.

## Starting evidence

The following is the evidence available at the start of this plan. It records
what can be relied on without turning an implementation intention into a
completion claim.

| Area                             | Current evidence                                                                                                                                                                                                                                                                                                                                                                | Original gap                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case routing and ownership       | Plan 15 has a production Case/Connector path for fresh Slack roots, direct Cue/API input, follow-up restore, and two-session Case coordination.                                                                                                                                                                                                                                 | Automatic post-retention erasure was the final original MC0 gap.                                                                                                                 |
| NF9 history                      | Neutral actor-owned history, hash-chain cursors, semantic ordering, checkpoint binding, aggregate budgets, warning projection, deployed checkpoint disposition, crash-after-effect recovery, and fresh production activation are complete.                                                                                                                                      | Organisation-wide automatic erasure was added after the original slice.                                                                                                          |
| Slack and Cue operating fixtures | The production-shaped local operating test now covers three interactive Slack Case turns across Session, Case, and Connector replacement: 12 accepted history rows, three settled Slack receipts, and idempotent duplicate ingress. A separate direct Cue test covers one fresh durable Picocodex turn with four history rows, no Connector output, and a committed checkpoint. | Later Cue interaction requires an explicit Case user-facing binding. Same-session Cue continuation without that binding and alternating Slack/Cue are intentionally outside MC0. |
| Commerce projections             | The lab, complete Shopify order/catalog webhooks, bounded initial snapshot, CK0R query envelopes, governed receipts, and merchant presentation provide working evidence. The deployed Nuki organisation completed one live governed cancellation and shows the refreshed projection and receipt in the portal.                                                                  | Broader provider and browser breadth was outside the accepted slice.                                                                                                             |
| Onboarding                       | Plan 5 defines the resumable organisation, connection, resource-selection, readiness, activation, and first-task contracts.                                                                                                                                                                                                                                                     | The first operational task must land in the new commerce console and the connection section must become a merchant page.                                                         |

The current NF9 evidence is concentrated in the [history authority tests](../../services/platform/tests/agent-session-harness-authority.test.ts),
[checkpoint classification tests](../../services/platform/tests/nf9-checkpoint-classification.test.ts),
and the current [Slack Actor journey](../../services/platform/tests/e2e/slack-actor-journey.test.ts).

The August local evidence separated two operating paths. The historical
interactive Slack test drives the real Case, Session, and Connector persistence
through three completed turns and replaces each actor between checkpoints. It
proves one accepted 12-row history chain, three settled outputs, and idempotent
duplicate ingress. The direct Cue test drives one fresh durable Case assignment
through Picocodex, proves four history rows and a sleeping checkpoint, and emits
no Connector output. Later Cue interaction requires an explicit Case user-facing
binding. Same-session Cue continuation without that binding and alternating
Slack/Cue are intentionally outside MC0 rather than missing acceptance work.

## Guardrails

- Read paths are authenticated and organisation-scoped. Raw provider payloads are
  parsed at ingress and never become portal domain state.
- Commerce writes use typed provider actions, policy, approval, idempotency, and
  the Tool Gateway. A browser never calls a provider directly.
- Cases own shared work and addressed output. AgentSessionActors own private
  history and checkpoints. Connectors own provider ingress and delivery.
- The first commerce acceptance loop requires Slack and one selected commerce
  system. Satyr Commerce is the default first-party path; Shopify is an
  alternative commerce system. Stripe is an optional payment connection.
  Additional providers are outside the accepted Plan 16 slice.
- Plan 22 activates Core, Online Commerce, Food Service, and the measured
  Retail Operations slice only when their walking scenarios pass. POS and
  autonomous operation are outside Plan 16.
- Keep the first UI operational: counts, filters, freshness, lifecycle,
  exceptions, proposals, and receipts. Charts and broad analytics wait.

## Phased implementation checklist

This checklist is the implementation order. A checked local item remains
subject to its phase's production or browser exit gate.

MC0 through MC5 record the initial Shopify-derived operating release. Their
Case, approval, ActionLedger, receipt, and presentation evidence remains valid.
Plan 22 supersedes their commerce types, generic Underclerk mutations, and
absolute inventory adjustment.

The commerce implementation followed CK0R, CK1, MC2/MC3, CK3/MC4, then
CK4/MC5. The milestone sections below preserve that completed sequence.

### MC0 — Actor-owned history activation

- [x] Enforce per-session history entry and inline-byte ceilings and expose the
      warning and hard-limit usage state.
- [x] Return private-history and checkpoint references from per-session export
      and erasure planning.
- [x] Emit the organisation-scoped operator warning projection at the aggregate
      history threshold.
- [x] Coordinate read-only organisation-wide SessionActor enumeration, erasure
      planning, and shared-object reachability inspection.
- [x] Automate organisation-wide SessionActor erasure after the retention fence and
      persist terminal receipts for every addressed SessionActor.
- [x] Classify compatible and incompatible Picocodex checkpoints at the
      persistence boundary.
- [x] Inventory deployed checkpoints and accept an explicit disposition for
      every active lineage.
- [x] Prove repeated Slack restore and one durable Cue turn locally.
- [x] Prove recovery after an accepted effect and before checkpoint commit,
      including the explicit indeterminate-effect quarantine branch.
- [x] Activate NF9 for fresh production sessions and record its operating
      evidence.

### MC1 — Integrations dashboard

- [x] Project canonical provider account, resource, scope, credential,
      webhook, and recency fields.
- [x] Add organisation navigation and the integrations page using existing Plan 5
      lifecycle actions.
- [x] Complete browser acceptance for OAuth-window recovery, refresh,
      reconnect, disable, keyboard operation, and asynchronous status. The
      repeatable credential-free run is `pnpm plan16:mc1:browser`; the evidence is
      [`plan-16-mc1-integrations-browser-acceptance-2026-08-18.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-16-mc1-integrations-browser-acceptance-2026-08-18.md).

### MC2 — Commerce query APIs

- [x] Adopt Plan 9 CK0R `ProductView`, `InventoryView`, and `OrderView` and
      remove the previous projection contracts.
- [x] Implement the five authenticated, organisation-scoped commerce routes.
- [x] Parse projections into provider-neutral, privacy-bounded responses.
- [x] Define the versioned list, detail, cursor, freshness, and error contracts
      described below.
- [x] Implement those envelopes and cursors at the five route boundaries.
- [x] Run all six revised local commerce scenarios through the server-owned
      view composers and portal boundary parsers after the canonical lab seed.
- [x] Run live acceptance for product, inventory, and order reads on one fresh
      Satyr Commerce organisation. The broader six-scenario matrix is deferred provider
      hardening rather than an initial-release gate.

### MC3 — Products and orders dashboard

- [x] Remap products to variants, offers by channel, inventory items, and
      positions by location; remap orders to explicit origin, buyer, totals,
      payment, fulfillment method, and shipment views.
- [x] Add commerce overview, product/order lists, detail routes, and typed
      loading, empty, stale, and failure states.
- [x] Add bounded projection history plus Case-linked action and receipt views
      from server-owned data, plus organisation-scoped active Case projections and
      assignment/output status in Operations.
- [x] Complete merchant-critical browser acceptance for products, inventory,
      customer orders, filtering, Operations, and the integrations surface, including a
      narrow-screen Operations pass. The read-only deployed pass in
      [`plan-16-browser-readonly-2026-08-09.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-16-browser-readonly-2026-08-09.md)
      and the Plan 19 production acceptance record the supporting evidence.
      Exhaustive failure-state and device breadth remain ordinary release
      hardening.

#### MC3A — Merchant Operations simplification

The first Operations implementation exposed configuration forms, full Case
state, durable identifiers, receipts, and action controls in one continuous
page. That layout is useful for engineering inspection and unsuitable as the
merchant's daily workflow. The merchant-facing page is **Operations**, with
**Needs attention** as its primary queue.

The primary flow is deliberately linear:

```text
Needs attention
  → understand the proposed change
  → approve or reject
  → apply an approved change
  → confirm the provider receipt in Recent activity
```

| Default view                                                                                         | Progressive disclosure                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain action title, affected resource, exact change, status, time, next action, and provider outcome | Receipt and effect IDs, canonical IDs, Case and proposal IDs, action nonce, retry controls, live Case telemetry, operational areas, and playbooks |

- [x] Use Operations in merchant navigation and headings.
- [x] Put proposed, approved, failed, and indeterminate changes in a dedicated
      Needs attention queue.
- [x] Translate commerce verbs, lifecycle states, and canonical resource keys
      into plain merchant language.
- [x] Present the selected action as one decision: understand the change,
      approve or reject it, then apply an approved change.
- [x] Show the provider, terminal outcome, and observation time in the primary
      action view and Recent activity. Keep receipt IDs, effect IDs, provider event
      IDs, Case IDs, proposal IDs, action nonces, and retry controls under Technical
      details.
- [x] Separate completed work from expired proposals.
- [x] Collapse live Case telemetry under Agent activity.
- [x] Collapse operational areas and playbooks under Automation.
- [x] Replace identifier-derived action summaries with exact typed action
      parameters such as the target inventory quantity and expected revision. This requires
      the action read boundary to return the already-persisted typed proposal body;
      it does not justify a second action model.
- [x] Persist the proposal-time available quantity for inventory adjustments so
      the merchant sees the item, old quantity, new quantity, and reason after the
      provider projection advances. The snapshot belongs to the canonical action
      draft rather than a UI reconstruction from current data. Historical actions
      whose persisted path predates the snapshot display their target quantity and
      state that the previous quantity was not recorded.
- [x] Complete the merchant-critical narrow-width, approval, execution, receipt,
      and recent-activity browser path. Typed rejection, failed, and indeterminate
      behavior remains covered at the control and UI boundaries without blocking
      the initial release.

### MC4 — Governed management actions

- [x] Prove the first provider-neutral listing and order action path on the
      CK0R projection shape through the lab and provider-dispatch fixtures.
- [x] Rebind Plan 9's `publish_catalog_listing` to an exact Product,
      SellableVariant, Offer, and SalesChannel revision set, changing publication
      state without editing content or price; bind `cancel_order` to an exact
      `CommerceOrder` revision.
- [x] Give AgentSessionActor one typed `commerce.propose_action` capability that
      submits an exact-revision proposal to its CaseActor and cannot dispatch a
      provider effect directly. The embedded host binds the capability to the
      assigned Case and action ledger.
- [x] Implement the local same-Case terminal outcome path: the action ledger
      provider receipt or typed merchant rejection is appended to the originating
      Case and delivered through its addressed Connector outbox with idempotent
      receipt settlement.
- [x] Prove the provider-effect branch with live Shopify approval and terminal
      Slack delivery in the marked acceptance organisation. The typed rejection branch
      remains covered locally because it deliberately creates no provider effect.
- [x] Put ordinary merchant completion behind the provider-neutral approval
      receipt and typed authentication union from Spec 8. The optional Seams
      approval adapter remains the NEP-413 branch.
- [x] Implement recent Google OIDC step-up for ordinary merchant approvals and
      bind it to the exact action challenge.
- [x] Implement the merchant decision lifecycle locally. The Case moves from
      `open` to `waiting { approval }` after the action ledger accepts the proposal,
      then returns to `open` after approval or rejection. Rejection records typed
      control-identity evidence as the terminal `rejected` action state and cannot
      enter provider execution.
- [x] Remove `seams_approver_missing` from ordinary provider-write readiness.
- [x] Add policy-selected authentication readiness reporting for action classes
      that opt into a non-default branch. A policy body may select
      `approvalAuthentication.highStakes` as `webauthn_step_up` or `seams_nep413`;
      the readiness assessment then persists and reports that branch's
      `ApprovalAuthenticationReadiness` (unready until the branch's verifier can be
      satisfied) without blocking ordinary organisation readiness, and the portal
      explains the unready branch beside the readiness panel. The default Google
      OIDC step-up produces no report.
- [x] Accept local merchant and AgentSession proposals through Case revision,
      policy, approval, action-ledger, and resource-serialization boundaries. The
      marked Shopify cancellation also proved the live terminal Slack outcome.
- [x] Map each accepted action to one provider adapter and stable provider
      effect identity.
- [x] Return settled, reconciled, indeterminate, or failed receipts and refresh
      the provider-derived projection.
- [x] Render proposal and approval entry points in the portal, including
      bounded receipt detail fields.
- [x] Prove stale revision, duplicate submit, missing approval, unauthorized
      principal, and cross-organisation rejection before provider mutation in local
      action-ledger and control-boundary tests.

### MC5 — Merchant acceptance and closure

The first provider-neutral action and receipt walking slice is recorded in
[`Plan 9/16 local loop evidence`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-16-local-commerce-loop-2026-08-04.md).
MC5 completed through the fresh Plan 19 production acceptance organisation.

- [x] Freeze one versioned Plan 9 CK0R fixture manifest and its expected
      identities, revisions, action classes, scenario set, and acceptance
      assertions. The manifest is
      [`plan-9-16-ck0r-fixture-manifest-2026-08-08.json`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-16-ck0r-fixture-manifest-2026-08-08.json)
      and contains no credentials or customer data. Run-specific Case history and
      receipt IDs remain generated evidence rather than fixture inputs.
- [x] Complete onboarding, provider connection, resource selection, activation,
      and console entry for one clean organisation.
- [x] Ingest signed Shopify order events and show their projections, source
      revisions, history, and action receipts in the console.
- [x] Register and project signed Shopify order, catalog, and inventory-level
      webhook payloads through the canonical commerce event queue; inventory
      updates now refresh `InventoryPosition` without fabricating a Location. A
      clean connection also queues the current per-location available quantities
      from Shopify's `inventoryItems` snapshot, so the dashboard does not wait for
      a later webhook before showing stock.
- [x] Complete a commerce Slack root plus follow-up on the same Case-owned
      session. The deployed human root returned
      `SATYR_PRODUCT_LISTING_FIXED_20260805_OK`, and the same-thread follow-up
      returned `SATYR_CASE_FOLLOWUP_RESTORE_20260805_OK`; the Case and Connector
      delivery receipts settled successfully.
- [x] Deliver one provider-derived inventory-shortage Cue into `#test-commerce`
      through a two-session Case. The coordinator and inventory observations
      produced two settled Case outputs and exact Slack receipts, while both
      Picocodex sessions returned to quiescent sleeping checkpoints.
- [x] Approve and execute one governed order action in the marked Shopify
      development store and observe the refreshed provider-derived projection.
- [x] Record zero unauthorized effects, zero duplicate effects, complete
      causation links, bounded customer data, and green Actor/queue health for the
      live acceptance run.
- [x] Publish a repeatable credential-free local acceptance command
      (`pnpm plan9:16:local`).
- [x] Mark the initial cloud commerce loop complete after live provider,
      browser, Slack, and receipt evidence.

### MC6 — Operational areas and Agents

- [x] Add Operations and Agents navigation over canonical cloud records for
      the first local control-plane slice.
- [x] Define operational areas, versioned agent profiles, organisation installations,
      responsibilities, and merchant capability grants in D1-backed records.
- [x] Enforce that an installation can grant only capabilities requested by its
      pinned agent-definition revision.
- [x] Assign one active agent installation to the inventory operational area
      through the authenticated operations command boundary.
- [x] Show Case-linked proposals, approvals, settled receipts, and recent work
      through the existing Organisation action ledger and bounded Operations snapshot.
- [x] Show organisation-scoped active Case projections, assignment lifecycles, and
      pending/settled Case outputs in Operations. Area-specific Case automation is
      outside the accepted slice.
- [x] Keep the UI independent of local files and desktop synchronization;
      Operations reads D1 and Actor-owned records only.

### MC7 — Playbooks and agent configuration

- [x] Create and publish the first immutable Markdown-backed playbook revision
      through the merchant console.
- [x] Attach an exact playbook revision to an operational area or agent
      definition through the authenticated command boundary.
- [x] Separate agent capability requirements from merchant capability grants;
      the definition revision owns requested capabilities, the installation owns
      merchant grants, the command boundary enforces subset semantics, and the
      Agents page displays both plus missing grants.
- [x] Configure cue bindings, schedules, budgets, approval thresholds, and
      escalation through structured controls. `cue_binding` selects the area and
      installation a commerce cue wakes; `schedule_binding` records cadence
      (consumed when the scheduler slice lands); installation governance caps the
      per-session token budget and binds at cue admission; the area escalation
      policy owns the approval reminder threshold and owner escalation window.
      All five are versioned upserts on the authenticated operations boundary
      with portal forms.
- [x] Publish an immutable agent-definition revision while existing
      installations remain pinned to their accepted revision.
- [x] Pin new assignments to exact installation, definition, playbook, policy,
      and grant revisions. Cue admission resolves the enabled binding and records
      one `case_assignment_pin` per created assignment with the exact
      installation, definition revision, bound playbook revision, policy
      revision, grant set, and budget cap; later definition publications leave
      recorded pins unchanged.
- [x] Let an agent propose configuration improvements without publishing its
      own instructions, permissions, or approval policy.
      `AgentConfigurationProposal` accepts only the proposing installation's own
      definition instructions or a playbook bound to that definition or its
      areas; grants, budgets, thresholds, and integrations are structurally
      impossible targets. Submission is replay-safe and never publishes; only the
      merchant accept command publishes the immutable revision (existing
      installations stay pinned), and dismissal is terminal. Exposing the
      embedded `operations_propose_configuration` tool to live Picocodex sessions
      ships with the next coordinated tool-catalog rotation, because the catalog
      digest is pinned by every deployed checkpoint and rotating it retires
      sleeping lineages.

## MC0 — Actor-owned history closure

MC0 makes actor-owned history the only selectable history path for fresh
production sessions. It is the entry gate for the rest of this plan.

### Current implementation status

| Item                                              | Status                   | Evidence                                                                                                                                                                                                                  |
| ------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aggregate entry-count and inline-byte rejection   | Complete locally         | `appendHarnessHistory` enforces 100,000 entries and 256 MiB; the authority test covers rejection and warning/hard-limit usage flags.                                                                                      |
| Actor export key inventory and SessionDO erasure  | Complete                 | History/checkpoint keys and per-session rows are returned and erased; the organisation inventory enumerates SessionActors, applies reachability filtering, and feeds the automatic post-retention purge.                  |
| Checkpoint classification and fresh-lineage start | Complete in production   | The deployed inventory classified 8 compatible Picocodex NF9 checkpoints, 9 no-checkpoint sessions, and 17 incompatible Pi checkpoints. The incompatible sessions were retired through bounded, replay-safe dispositions. |
| Repeated Slack restore                            | Complete locally         | Three turns replace Session, Case, and Connector actors between checkpoints, settle three Slack outputs, persist 12 history rows, and replay duplicate ingress idempotently.                                              |
| Direct Cue path                                   | Complete locally for MC0 | One fresh durable Cue turn persists four history rows and a sleeping checkpoint without Connector output. Later interaction requires an explicit Case user-facing binding.                                                |
| NF9 production activation                         | Complete                 | Crash-after-effect recovery and indeterminate-effect quarantine are proven. Archived organisation history is purged automatically after its retention fence.                                                              |

### Accepted implementation

- The implemented NF9 H0 budget path retains per-session entry and byte
  ceilings, projects the warning through OrganisationActor, and fails new turns
  through the safe recovery path at the hard limit. The
  projection and replay evidence is recorded in
  [`NF9 MC0 and CK4 local evidence`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-nf9-mc0-ck4-local-2026-08-06.md).
- History rows and history-only artifacts connect to session retention, actor
  export, per-session erasure, and the existing reachability inventory. The
  private history lane must not leak through surface or Connector reads.
- The SessionDO erasure RPC returns candidate object keys, and the read-only
  organisation inventory now enumerates all registered SessionActors while applying
  the reachability filter. The operator surface and durable receipts are
  implemented: support administrators read the pre-erasure inventory at
  `GET /v1/control/operator/organisations/:organisation/harness-history` and the
  `organisation_harness_erasure_receipts.v1` document at
  `GET /v1/control/operator/organisations/:organisation/harness-erasure`; per-session
  receipts (`harness_erasure_<registryId>`) persist erased row counts and
  survive the final purge (see
  [the harness-erasure runbook](../runbooks/harness-erasure.md)). The scheduled
  reconciler runs the same path automatically after each archived
  organisation's retention fence. Individual purge observation is an operational
  diagnostic rather than a Plan 16 gate.
- Existing Picocodex checkpoints were classified at the persistence boundary.
  Compatible records completed on their compatible build; older or
  incompatible records started a fresh NF9 lineage. No old checkpoint is
  parsed as an NF9 checkpoint and no synthetic history cursor is inserted.
- Interactive Slack acceptance covers repeated multi-turn sleep/restore cycles,
  and Cue-created Cases cover one real durable turn. Later Cue
  interaction continues only through an explicit Case user-facing binding.
  Same-session Cue continuation without that binding and an alternating
  Slack/Cue sequence are intentionally outside MC0. Record accepted history
  cursors, checkpoint lineage, Case revisions, output receipts, provider effect
  receipts, duplicate counts, and indeterminate outcomes for the supported
  paths.
- The accepted-effect/before-checkpoint boundary is closed by durable receipts,
  duplicate-safe replay, and explicit indeterminate-effect quarantine.

### Organisation-wide erasure and checkpoint disposition

`OrganisationActor` coordinates organisation-wide erasure from one immutable Actor-registry
snapshot. Each addressed `AgentSessionActor` remains authoritative for its
private history and returns an idempotent erasure plan or terminal typed
blocker. The coordinator may finalize shared object deletion only after every
reachable Actor has responded and the existing reachability filter proves that
no retained authority references the object. Partial completion remains
resumable under the same operation identity.

Every deployed checkpoint receives exactly one accepted disposition:

```text
compatible_completion | fresh_lineage | quarantined
```

The disposition binds organisation, session, backend, build, checkpoint format,
history lineage, registry fence, and accepted evidence. Mixed lineages fail at
the persistence boundary. A fresh lineage becomes irreversible when its first
history entry is accepted.

### Accepted guarantees

- Fresh production Sessions accept and restore actor-owned history with the
  new checkpoint format and build identity.
- An older checkpoint either completes on its declared compatible build or
  starts a fresh lineage without a model replay or a synthetic NF9 history
  row.
- Aggregate entry-count and byte limits are enforced, observable through usage
  flags, and covered by one behavioral test.
- Per-session export and erasure return private history and checkpoint object
  keys; the organisation coordinator records terminal per-session receipts and the
  reachability finalizer accounts for every candidate object.
- Interactive Slack repeated sleep/restore evidence shows one 12-row history
  chain, exact duplicate handling, and three settled deliveries.
- Cue-created Cases complete one durable turn with four history rows and no
  Connector output; later interaction requires an explicit Case user-facing
  binding. Same-session Cue continuation without that binding and mixed
  Slack/Cue evidence are intentionally outside MC0.
- The accepted-effect recovery boundary is proven or visibly paused for
  reconciliation.

## MC1 — Integrations dashboard

MC1 turns the existing connection-management section in
[`apps/portal/src/portal.tsx`](../../apps/portal/src/portal.tsx) into a merchant
page. Plan 5 remains the authority for connection attempts, provider account
identity, resource selection, readiness, activation, reconnect, disable, and
removal.

### Initial routes

```text
/portal/:organisationId
/portal/:organisationId/integrations
/portal/:organisationId/commerce
/portal/:organisationId/products
/portal/:organisationId/orders
```

### Current implementation status

| Item                                                                    | Status                                | Evidence                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical account projection fields                                     | Complete locally                      | Scopes, selected resources, credential/webhook health, and explicit event-recency availability are projected from onboarding records; `onboarding-projection.test.ts` covers the detail projection.                                                                                                                 |
| Integrations page, organisation navigation, and first-task destinations | Complete; browser acceptance recorded | Portal route tests and the portal build pass. Commerce/products/orders have distinct handoff shells; CK0R data views are implemented locally. The repeatable browser acceptance (`pnpm plan16:mc1:browser`) covers OAuth-window recovery, refresh, reconnect, disable, keyboard operation, and asynchronous status. |
| Provider lifecycle actions                                              | Accepted                              | Connect, reconnect, rotate, disable, primary-account, and removal handlers use the Plan 5 control routes; browser acceptance is recorded above.                                                                                                                                                                     |

### Work

- Group connections into one selected Commerce system, Payment connections,
  and Communication connections.
- Show Satyr Commerce or Shopify selection, Slack workspace/channel, and
  optional Stripe account, plus credential health, event-delivery health, and
  last successful
  event.
- Reuse Plan 5's typed connect, reconnect, disable, remove, and repair actions.
  Repeated submits and callbacks return the existing canonical receipt.
- Keep technical provider identifiers in support details rather than as the
  primary merchant label. Never return tokens, OAuth bodies, webhook secrets,
  or raw provider errors to the browser.
- Make the first page useful after activation: the first operational task links
  to the relevant commerce page or Case.

### Exit gate

- The dashboard reads the canonical onboarding/setup projection and does not
  infer lifecycle from several browser-owned responses.
- Satyr Commerce can be provisioned and selected, while Slack and Shopify can be
  connected, repaired, disabled, and reconnected with organisation isolation and
  idempotent receipts. Stripe follows the same acceptance when the merchant
  enables the optional payment connection.
- A stale readiness assessment sends the merchant to the affected stage and
  leaves the prior healthy connection unchanged.
- Browser acceptance covers refresh, closed OAuth windows, provider failure,
  keyboard operation, and visible asynchronous status.

## MC2 — Commerce query APIs

MC2 exposes the provider-neutral Plan 9 projections through authenticated,
organisation-scoped Control API reads. Plan 9 owns the projection and response
semantics. Plan 16 owns route authentication, organisation scoping, portal-facing
delivery, and browser acceptance. It is a read/proposal foundation; it does
not make Satyr a transactional commerce authority.

Plan 16 consumes three composed views rather than the kernel's persistence
resources directly:

| View            | Merchant composition                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `ProductView`   | Product, variants, channel/location offers, inventory items and positions                                      |
| `InventoryView` | Inventory item, location, quantity states, related variants and offers                                         |
| `OrderView`     | Commerce order, immutable lines and totals, origin, buyer, payments, fulfillment, shipment, Cases and receipts |

### Routes

```text
GET /v1/control/organisations/:organisationId/commerce/summary
GET /v1/control/organisations/:organisationId/products
GET /v1/control/organisations/:organisationId/products/:productId
GET /v1/control/organisations/:organisationId/orders
GET /v1/control/organisations/:organisationId/orders/:orderId
```

### Versioned read boundary

Every response uses a versioned envelope with required organisation, organisation
environment, projection snapshot, generated time, source-account identities,
and aggregate freshness state. List routes return a stable continuation union
of `end` or `continue` with an opaque cursor; normalized filters and sort order
are part of the cursor identity. Detail routes return one exact resource or a
typed `commerce_resource_not_found` error.

Product and order records carry source identity and revision, related
projection references, active exceptions, and server-derived governed-action
capabilities. Customer references are display-bounded. Raw provider payloads,
credentials, and unrestricted customer data never enter the envelope.

After control authentication, the route error union is
`commerce_query_invalid`, `commerce_cursor_invalid`,
`commerce_resource_not_found`, or `commerce_query_unavailable`. Authentication
and organisation-membership failures remain the existing Control API errors and occur
before commerce projection reads.

### Current implementation status

| Item                                           | Status   | Evidence                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Five authenticated organisation-scoped routes  | Accepted | `commerce-control-router.test.ts` exercises all routes plus unauthenticated and cross-organisation requests.                                                                                                                                                          |
| Typed projection records and source boundaries | Accepted | Projection safety and commerce query tests cover provenance, organisation/environment checks, lab-account identity, freshness, customer-reference redaction, related records, exceptions, and action capabilities. The marked Shopify run proved one live order view. |
| Revised scenario merchant acceptance           | Accepted | The marked run proved signed ingress, merchant reads, a governed cancellation, projection convergence, and receipt display. Broader provider breadth is outside Plan 16.                                                                                              |

### Work

- Return provider and integration-account identity, source identity and
  revision, projection freshness, current lifecycle branch, related inventory,
  payment, fulfillment, and shipment references, active exceptions, and
  available governed actions.
- Parse request, D1, and projection records once at each boundary. Core query
  functions receive precise organisation, account, identity, and revision types.
- Use Plan 9's strict composed views. Label stale projections and expose each
  resource's exact source authority without leaking adapter fields.
- Enforce control-session, organisation, environment, and idempotency boundaries.
  Cross-organisation, unknown-provider, and mixed-lifecycle records fail closed.

### Exit gate

- All five routes return stable typed responses for the revised Plan 9
  scenarios.
- A response identifies its source provider, integration account, source
  revision, freshness, lifecycle state, related records, exceptions, and
  action capabilities without exposing raw provider payloads or customer
  credentials.
- Unauthorized and cross-organisation reads fail before projection or model work.
- Rebuilding the response from the same projection is deterministic, and stale
  source data is visibly labeled.

## MC3 — Products and orders dashboard

MC3 builds the smallest operator UI on MC2. The UI should help a merchant act
on exceptions and proposals; it is not an analytics product.

### Current implementation status

| Item                                                                              | Status   | Evidence                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commerce overview, product/order lists, detail shells, typed loading/error states | Accepted | The deployed café seed renders all ten products, the Espresso Blend product detail, and the shortage order. Commit `b150f97c` prevents ordinary commerce pages from blocking on the Operations page's active-Case scan. |
| Product and order traceability                                                    | Accepted | Product detail exposes offers, variants, inventory by location, source revision, freshness, and projection history. The marked Shopify order exposes its confirming history and Case-linked cancellation receipt.       |
| Privacy and organisation boundary                                                 | Accepted | The UI uses authenticated control reads and the server's customer-reference redaction; no provider credentials or raw payloads are rendered. Additional device and scenario breadth is ordinary product hardening.      |

### Work

- **Commerce overview:** product count, low-stock products, open orders,
  payment failures, fulfillment exceptions, delayed shipments, and recent Cases
  and provider events.
- **Products:** search and filtering; product, variants, offers by channel and
  location, inventory items and positions, source authority, freshness, offer
  lifecycle, media, and bounded projection history.
- **Orders:** search and lifecycle filtering; origin and guest or identified
  buyer summary; immutable lines and typed totals; payment state; fulfillment
  method and shipment timeline; active exceptions; Case-linked action and
  receipt references.
- Show loading, empty, stale, and recoverable-error states from typed API
  results. Keep lifecycle labels and action availability derived from the
  server projection.
- Preserve Plan 5's responsive, keyboard, focus, and asynchronous-status
  requirements. Defer charts, cohort views, and advanced analytics.

### Exit gate

- A merchant can find each seeded product and order through the dashboard and
  trace its source revision, freshness, bounded Case-linked action references,
  and projection history.
- The six Plan 9 scenarios render their expected lifecycle and exception state
  without browser-side lifecycle inference.
- Customer context is bounded and safe; provider credentials and raw payloads
  never reach the page.
- The pages remain usable on desktop and mobile at the Plan 5 onboarding
  accessibility bar.

## MC4 — Governed management actions

MC4 adds a narrow proposal surface after MC2 and MC3 reads are stable. Every
action remains a typed request through the existing policy, Case, Tool Gateway,
and provider-receipt boundaries. Plan 9 owns the provider-neutral action and
receipt contracts; Plan 16 owns the authenticated routes, Case initiation,
merchant review, approval, and receipt presentation.

### Current implementation status

| Item                                                                             | Status                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing Case, policy, approval, action-ledger, and provider-receipt authorities | Case-owned proposal linkage implemented locally                                                                  | Merchant and embedded-agent action proposals now create or resolve a Case, append a typed commerce proposal to Case history, and bind the same Case/proposal identity into the action ledger.                                                                                                                                                                                                                                                              |
| Embedded AgentSession proposal capability                                        | Accepted                                                                                                         | The embedded catalog exposes read-only catalog, inventory, and order queries plus `commerce_propose_action`; the callback validates exact revisions and records a Case proposal before any provider dispatch.                                                                                                                                                                                                                                              |
| Portal proposal and governed dispatch surface                                    | Accepted                                                                                                         | Authenticated proposal, approval, rejection, and execution routes expose the initial actions. The marked Shopify cancellation used action-bound Google OIDC approval and displayed its bounded receipt. A synthetic café listing then proved the portal-originated proposal, approval, receipt, and addressed Slack outcome path.                                                                                                                          |
| Requested action coverage                                                        | Initial Shopify cancellation, Underclerk listing publication, and Underclerk inventory adjustment completed live | This is historical evidence for approval, dispatch, observation, receipt, and replay. Plan 22 replaces the absolute inventory command with `receive_inventory`, `record_inventory_count`, and `record_waste`.                                                                                                                                                                                                                                              |
| Underclerk transaction boundary                                                  | Deployed catalog, order, inventory, and action authority                                                         | Underclerk owns catalog, inventory, order, payment, fulfillment, and shipment records plus exact-revision listing and inventory actions. Satyr mints a dedicated integration identity, verifies the merchant and signer, applies each signed delivery through OrganisationActor, and acknowledges it afterward. The acceptance organisation shows six trompe-l'oeil bakery drinks, five orders, low-stock automation, and the completed inventory receipt. |
| MC4 deterministic replay and receipt exit gate                                   | Accepted                                                                                                         | The marked Shopify run proved one provider effect, one signed confirming observation, one terminal Slack delivery, and no duplicate effect or delivery after replay. The café follow-up proved that a newly created merchant-action Case inherits the configured Slack destination and delivers its terminal provider receipt exactly once. Typed merchant rejection remains covered locally.                                                              |

### First action slice

The replacement command surface preserves MC4's governance protocol. Its first
two merchant-facing commands are:

- `publish_offer` publishes one existing Offer to one exact
  SalesChannel using the accepted Product, SellableVariant, Offer, and
  SalesChannel revisions as preconditions. It changes publication state only;
  content and price changes use future, separate actions; and
- `cancel_order` cancels the exact accepted `CommerceOrder` source revision with a
  normalized reason, refund choice, restock choice, notification choice, and
  bounded staff-note choice.

Provider account and environment come from the canonical connection. The
request supplies no credential, host, or provider authority. Both actions bind
the originating Case proposal, resource revision, normalized parameter digest,
policy decision, approval receipt when required, action identity, provider
effect identity, and terminal or indeterminate receipt. A stale source revision
requires a new proposal.

### Agent proposal and approval return path

The live agent receives read-only commerce query capabilities and one typed
proposal capability. It never receives a provider-write capability.

```text
Slack request
  -> AgentSessionActor reads canonical views
  -> commerce.propose_action(exact identities and revisions)
  -> CaseActor accepts the proposal
  -> policy authorizes or creates an approval challenge
  -> Case remains waiting_for_approval when merchant input is required
  -> portal approval or rejection settles the challenge
  -> ActionLedger dispatches the authorized provider effect
  -> provider receipt and later authority observation reconcile the action
  -> Case records the outcome
  -> ConnectorActor delivers the final result to the original Slack binding
```

Proposal replay returns the original Case acceptance. Approval replay returns
the original receipt. Provider dispatch remains fenced by the action ledger and
idempotency identity. A stale canonical revision returns `rebase_required`
before approval or provider mutation.

### Provider-neutral approval authentication

Satyr's approval protocol owns the principal, role, action challenge, policy
binding, expiry, nonce, and receipt. The authentication adapter verifies one
closed `ApprovalAuthentication` branch and returns normalized evidence to that
protocol. Neither the portal nor the action ledger switches on SDK-specific
response objects.

The active policy schema selects the required high-stakes authentication branch
and reports its readiness. Ordinary portal approvals use Google OIDC step-up;
Seams NEP-413 remains an optional policy-selected adapter. Plan 16 has no
additional approval-authentication work.

Implementation proceeds in this order:

1. [x] Replace the approval ledger's opaque identity/signature pair with the
       typed principal, authentication branch, and proof digest at the persistence
       boundary.
2. [x] Move ordinary completion behind authenticated control mutation,
       same-origin CSRF, organisation membership, approval-role, and recent-auth checks.
3. [x] Add a short-lived Google OIDC step-up bound to the approval challenge;
       identical replay returns the original approval receipt.
4. [x] Keep NEP-413 outside the ordinary provider-write activation gate. Google
       OIDC is the current default authentication branch; Seams remains an optional
       adapter for a future policy-selected action class and is not required for
       this plan's closure.
5. [x] Record merchant rejection as a typed, terminal action decision. The
       rejection binds the control identity, active control session, organisation,
       action nonce, action digest, reason, and decision time. It creates no
       provider execution lease.
6. [x] Prove changed digest, stale policy, expired challenge, consumed nonce,
       insufficient role, cross-organisation identity, and requesting-agent approval all
       fail before provider mutation. The focused Google approval-boundary fixture
       exercises the action binding, grant expiry, one-time ceremony consumption,
       and closed principal/policy parsers without acquiring provider authority.
7. [x] Complete one Google-authenticated Shopify approval and provider receipt
       in the marked development organisation. A Seams canary is outside the Plan 16
       release gate unless a selected policy requires it.

### MC4 closure dependency

The narrow terminal-result protocol is implemented locally. After OrganisationActor
records a terminal provider receipt or typed merchant rejection, the
originating CaseActor accepts the outcome under the existing action/proposal
identity, appends one deterministic terminal journal entry, and atomically
creates an addressed outbox entry from the Case's sole active binding.
ConnectorActor delivers the snapshot and CaseActor settles the exact delivery
receipt. Replays are idempotent. The protocol never settles the commerce
effect; OrganisationActor's action ledger and provider receipt remain authoritative.
Live Shopify interruption and Slack acceptance are recorded in
[`Plan 9 CK4 Shopify production acceptance`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-ck4-shopify-production-acceptance-2026-08-08.md).
Broader browser breadth is outside the accepted Plan 16 slice.

### Work

Products:

- prepare or update product content;
- create a listing proposal;
- publish an approved release; and
- reconcile a provider rejection.

Orders:

- propose cancellation;
- propose refund;
- propose fulfillment;
- draft customer communication; and
- open an exception Case.

Every governed commerce mutation exposes this lifecycle and its evidence:

```text
proposed
  → approval required or authorized
  → dispatching
  → settled | reconciled | indeterminate
```

The UI displays the policy decision, approval identity, provider receipt,
correlation/causation links, and resulting projection update. The browser does
not call a provider and does not mark an effect settled from a diagnostic
response.

Automatic policy authorization is limited to non-mutating Case output, such as
an operator notification or a customer-communication draft. Those outputs use
the Case outbox and Connector receipt path. `publish_offer`,
`record_inventory_count`, `record_waste`, `receive_inventory`, and
`cancel_order` mutate provider state and use the policy and approval result for
their exact command and activated capability.

### Exit gate

- One product proposal and one order proposal complete through the existing
  provider-neutral action/approval boundary with deterministic replay. At least
  one approval uses the ordinary Google OIDC step-up branch.
- Provider idempotency or reconciliation yields exactly one settled or
  reconciled effect. An adapter without a safe guarantee stops visibly at
  `indeterminate` and does not retry automatically.
- Duplicate submits, stale revisions, missing approvals, unauthorized
  operators, and cross-organisation actions fail before external mutation.
- The dashboard shows the receipt and the updated provider-derived projection.

## MC5 — End-to-end merchant acceptance

MC5 is the release acceptance path for the first usable ecommerce product. Use
one marked development organisation and the Plan 9 synthetic catalog. Keep all
evidence free of credentials and real customer data.

### Frozen acceptance fixture

MC5 uses one versioned fixture manifest from the Plan 9 synthetic catalog. The
local run instantiates it in the independent lab provider. The live run
instantiates its marked test resources in a Shopify development store. The
lab catalog includes café ingredients, menu inventory, and smallware alongside
the retained deterministic watch fixture used by the original replay scenarios.
The manifest fixes the organisation role, provider account class, selected resources,
catalog and order identities, source revisions, signed event, expected
projection changes, Slack prompts, Case and assignment outcomes, governed
actions, policy/approval outcomes, provider receipts, cleanup behavior, and
final projections. The manifest and evidence record identities, digests,
lifecycle, timings, and receipts without secrets or real customer data.

### Walking scenario

1. Sign in and create an organisation through the Plan 5 journey.
2. Select Shopify as the commerce system and connect Slack. Connect Stripe only
   when the fixture exercises a separate payment observation.
3. Select the Slack destination by merchant-facing name.
4. Provision the marked synthetic product, offer, inventory, and cancellable
   order in the Shopify development store and ingest them through the normal
   snapshot or signed-webhook boundary. The local variant of this step seeds
   the independent lab provider.
5. Receive an order or inventory event through signed ingress.
6. See the updated product or order in the overview and detail pages.
7. Ask Satyr about it through Slack.
8. Confirm a Case is created, the first turn completes, and a follow-up
   restores the same Case-owned AgentSessionActor checkpoint.
9. Ask the Slack agent to submit one governed product or order proposal against
   exact canonical revisions.
10. Follow the Case-linked portal approval, approve or reject it with the
    configured authentication branch, and return to the same Case.
11. Accept the provider receipt or visibly reconcile/hold an indeterminate
    effect.
12. See the resulting provider-derived state and action receipt in the console
    and receive the terminal outcome in the originating Slack thread.

### Exit gate

- One clean organisation run completes the Plan 5 journey:
  `create organisation → connect integrations → select resources → choose safe
defaults → activate → enter commerce dashboard`.
- One Plan 9 event updates a product or order projection and is visible in the
  console with source revision and freshness.
- Slack creates and restores the same Case and session on follow-up; the MC0
  multi-turn evidence remains valid after the dashboard is in the loop.
- One governed proposal records policy, approval, dispatch, receipt, and
  resulting projection state.
- The run records zero unauthorized effects, zero duplicate effects, complete
  causation links, and no credentials or real customer PII in evidence.
- A new engineer can repeat the acceptance from the documented local lab
  commands without editing production records or fixture payloads.

## MC6 — Operational areas and Agents

### Current implementation status

The first local MC6 slice is implemented. `operational_area`,
`agent_definition`, `agent_definition_revision`, `agent_installation`, and
`agent_area_assignment` are organisation-scoped D1 records. The authenticated
`/v1/control/organisations/:organisation/operations` boundary parses commands once and
returns a complete typed snapshot. The portal now exposes Operations and Agents
pages over those records. The Operations page also shows bounded,
Case-linked commerce work from the Organisation action ledger, including proposal
state, Case/proposal identity, and settled receipt identifiers. Cue-created
work and Case-to-area automation are outside the accepted Plan 16 slice.

MC6 turns the existing Case runtime into a merchant-readable operating team.
It adds no new Actor kind. Operational areas, agent definitions,
installations, responsibility assignments, and summaries are control-plane
records; live work continues through CaseActor and AgentSessionActor. The
Operations snapshot now reads active Case actors through the organisation registry
and exposes each Case revision, lifecycle, assignment lifecycle, and pending
or settled output counts. A future plan may add area-specific automation when a
measured CafeOS path requires it.

### Canonical records

```text
OperationalArea
AgentDefinitionRevision
AgentInstallation
AgentAreaAssignment
EscalationPolicy
```

An `AgentDefinitionRevision` contains a stable agent identity, display profile,
role, purpose, Markdown instructions, requested capabilities, available
playbook references, delegation-role templates, and a content digest. An
`AgentInstallation` binds one exact definition revision to an organisation, current
policy revision, integration requirements, and lifecycle.

The definition requests capabilities. The installation receives only the
merchant-authorized grants accepted by Spec 8. Installing a definition cannot
create credentials, provider accounts, approvals, or authority.

### Merchant experience

Add these primary views:

```text
Operations
Agents
Commerce
Integrations
```

Plan 21 owns the merchant-facing navigation labels. Governed work appears in
Operations under **Needs attention**; agent definitions, installations, and
activity appear under **Agents**.

An operational-area page shows its current exceptions, Cases, responsible
agents, playbooks, triggers, autonomy, approvals, and escalation. An agent page
shows mission, responsibilities, assigned areas, requested and granted access,
active work, recent proposals, receipts, and current definition revision.

### Accepted scope

- A merchant creates one inventory operational area and installs one agent
  profile without editing files.
- The merchant assigns the agent to that area and sees the exact requested and
  granted capabilities.
- The assignment pins the installation and definition revision.
- Removing or changing the installation affects future admission and does not
  rewrite an existing session lineage.

## MC7 — Playbooks and agent configuration

### Current implementation status

The MC7 slice is implemented. A merchant can publish an immutable
Markdown playbook revision, publish an agent definition revision, install an
agent with explicit grants, and bind an exact playbook revision to an area or
definition. Definition requirements and installation grants are separate
records, subset-checked at installation, and displayed together with missing
grants on Agents. The structured automation controls landed 2026-08-18:
cue bindings, schedule bindings, per-installation session budgets, area
escalation policies with approval-reminder thresholds, cue-admission
assignment pinning, and the agent configuration-proposal record with
merchant accept/dismiss review. Agent-authored changes remain proposals until a
merchant accepts them.

MC7 adds merchant-authored operating knowledge and reviewed agent evolution.
The web console is the primary editor. Markdown is one field format inside a
versioned cloud record.

### Canonical records

```text
PlaybookRevision
PlaybookBinding
CapabilityRequirement
CueBinding
ScheduleBinding
AgentConfigurationProposal
```

A playbook has stable identity, immutable revision, Markdown body, owning
organisation, applicable operational areas, sensitivity, author, and digest. A
binding selects an exact playbook revision for an agent definition or
operational area.

Capability requirements describe what a definition can use. Merchant-owned
grants describe what an installation may use. Cue and schedule bindings select
eligible operational areas and installations; they do not grant action
authority.

### Configuration flow

```text
merchant form or agent proposal
  -> typed configuration draft
  -> meaningful diff
  -> validation
  -> merchant publication
  -> immutable definition and playbook revisions
  -> installation update
  -> future assignments pin the new revisions
```

An agent may submit `AgentConfigurationProposal` with a rationale and proposed
instruction, skill, or playbook changes. It cannot publish the change, alter
its effective grants, raise a budget, change approval thresholds, or bind a new
integration.

### Accepted scope

- A merchant creates a Markdown playbook in the portal and attaches its exact
  revision to the inventory area and agent profile.
- Publication creates immutable definition and playbook revisions plus an
  audit receipt.
- A new Case assignment receives the new revisions; an existing sleeping
  session remains pinned to its original lineage.
- An agent-proposed playbook improvement remains a proposal until an authorized
  merchant accepts it.
- No desktop application, local database, filesystem watcher, or file sync is
  required.

## Future ownership

Plan 24 owns bakery production automation, the first measured robot-assisted
step, equipment enrollment, and robot fleet access. Plan 22 owns first-party
public discovery, Food Service, and the measured Retail Operations slice. Plan
21 owns their CafeOS presentation after each walking scenario passes.

Plan 16 has no deferred implementation queue. Production POS, new messaging
channels, heavy media, native execution, advanced analytics, desktop
applications, local SQLite, filesystem materialization, and file synchronization
require a new focused plan after demonstrated demand. Agent-authored
configuration changes remain proposal-only and cannot self-publish. Plan 24
owns the bakery-specific operating path.

## Validation

Future changes use the repository's standard checks and the narrowest relevant
commerce or onboarding scenario. Plan 16 has no outstanding acceptance run or
evidence packet.
