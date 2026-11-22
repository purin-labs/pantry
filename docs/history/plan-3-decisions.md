# Plan 3 — Decision Log (ADRs)

Current authority map reviewed: 2026-10-06. Dated decisions retain their original
scope. Superseded entries explain historical choices and create no active work.

## Current authority

- [Repository guide](../../AGENTS.md) and [README](../../README.md): BakeryOS and CafeOS
  product direction, current source boundaries, and development commands.
- [Plan 15](plan-15.md): Connector, Case, and AgentSession ownership.
- [Plan 14](plan-14-actor-runtime-architecture.md) and
  [Runtime architecture: harness adapter (was Spec 4)](../architecture/runtime.md#harness-adapter): runtime placement and three pinned inference authorities.
- [Architecture](../architecture): subsystem and security contracts (the old
  `spec-*.md` files), including custom connectors (was Spec 14) in
  [integrations](../architecture/integrations.md#custom-api-connectors).
- [Commerce architecture](../commerce-domain-architecture.md) and
  [monorepo guide](../commerce-monorepo.md): Contracts, Underclerk, Platform, and Commerce Read Layer ownership.
- [Plan 42](plan-42-bakery-workflow-simulator.md) and its
  [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md): accepted BakeryOS software and remaining gates.
- [Plan 60A](plan-60A-bakery-equipment-models.md) and Plans 61A–E: equipment and
  draft recipe workflows. [Plan 24](../plan-24-cafeos-bakery-automation.md) owns planned physical integration.
- [Plans 40](plan-40-product-description-drafting.md) and
  [40B](plan-40B-collaborative-menu-editor.md): accepted drafting and the proposed collaborative menu editor.
- [Blocked and deferred tasks](../blocked-deferred-tasks.md): external dependencies
  and proposals outside the active implementation scope.

Each owning plan states its acceptance status. Later scoped evidence can close
an earlier checklist item only for the behavior it proves. Dated cost estimates,
cutover plans, and withdrawn experiments do not override current contracts.

## Decisions

### AD-001 — Cloudflare-native fork (2026-07-04)

Workers/DO/Containers/D1/R2/Queues replace the Kubernetes substrate; domain
core carries over. Durable Objects own serialized domain state, D1 owns
control-plane projections, R2 owns large immutable artifacts, Queues carry
durable asynchronous work, and containers are allocated only for heavy
execution. Plans 14 and 15 define the current ownership model. **Active.**

### AD-002 — Slack: unlisted app + Events-API forward stream (2026-07-06)

Post-2026-03-03 history caps (15 msg/min unlisted) kill bulk backfill. Channel
memory is the forward stream; deep backfill is gated behind Marketplace or
per-organisation custom apps. E5 report is the evidence; [spec-5](../architecture/integrations.md#ingress-gateway)
is the mechanism. **Active.**

### AD-003 — Language strategy (2026-07-06)

Rust owns provider-neutral commerce contracts and reviewed portable runtime
components. TypeScript owns the Worker, Durable Objects, queues, portal-facing
control plane, and platform adapters. Python remains confined to sandboxed
tools. Shared contracts are canonical in Rust and generated to TypeScript.
**Active.**

### AD-004 — Two-track adapter; Track 2 ships first (2026-07-06)

The original two-track Managed Agents/container adapter strategy has been
removed. The former single Picocodex production-harness decision is
superseded: `AgentSessionActor` now pins either
`organisation_subscription` + `openai`, which uses organisation-addressed Codex App Server
with the organisation's ChatGPT OAuth profile, or `platform` + `openai-compatible`,
which runs Pi with `OPENROUTER_API_KEY`. A route failure never selects the
other route. Heavy execution uses the disposable workspace executor boundary.
AD-045 and [spec-4](../architecture/runtime.md#harness-adapter) define the replacement.
**Superseded.**

### AD-005 — Per-session containers, never recycled (2026-07-06)

Per-session containers and warm pools were removed. `AgentSessionActor` runs
the embedded harness and allocates a disposable `WorkspaceExecutorContainer`
only for Linux-heavy work. Plan 14 and
[spec-3](../architecture/runtime.md#agent-sessions) define the replacement. **Superseded.**

### AD-006 — Seams complements the Satyr Vault (2026-07-07)

Seams = identity + MPC action signing; the Satyr Vault = the at-rest merchant
secret. One gate, two systems. Supersedes plan-1's D5 ("store merchant
credentials in Seams… 1Password as adapter") — Seams is not the at-rest
merchant vault. AD-016 later fixes the Vault backend: root wrapping keys live in
Cloudflare Secrets Store; per-organisation ciphertexts live in D1.
[spec-6](../architecture/security.md#vault-policy-and-revocation), [spec-8](../architecture/security.md#identity-approval-and-authorization).
**Active.**

### AD-007 — CRDT/OT ruled out for thread sync (2026-07-07)

The proposed thread/file synchronization protocol is deferred with the desktop
workspace scope. Runtime coordination now uses Case-owned revisions, proposals,
and append-only shared history. [spec-7](../architecture/runtime.md#case-coordination-and-connector-delivery)
and AD-041 define the current boundary. **Superseded.**

### AD-008 — matterbridge ruled out (2026-07-07)

Wrong runtime (long-running process) and wrong abstraction (dumb relay).
Provider ingress and delivery belong to `ConnectorActor`; mine matterbridge
only for historical platform-quirk reference. The former chat record is
historical provenance. **Active.**

### AD-009 — Tool-execution split: low-stakes raw, high-stakes typed (2026-07-07)

Resolves the fork between plan-1's Typed Tool Gateway (all merchant ops in
trusted Worker code) and the earlier spec-2/8 shape (tools in-container, raw
HTTP classified and signature-gated at the outbound handler).

- **Raw Class-B egress is low-stakes only, structurally**: the outbound
  handler denies mutating verbs to merchant hosts unless the injection rule
  explicitly marks them low-stakes. No signature machinery on the raw path —
  there is nothing there worth signing.
- **High-stakes verbs exist only as typed tool-gateway endpoints** (trusted
  Worker): typed args → schema validation → `CanonicalAction` built from args
  (no HTTP parsing) → spec-8 signature gate → provider call with an
  `Idempotency-Key` derived from the action nonce.
- Centaur's Python tools survive unchanged for reads/low-stakes; money-verb
  tools become thin shims over the typed endpoints.

Rationale: the trusted layer must understand provider semantics anyway (to
canonicalize and classify); parsing raw HTTP into money actions makes every
parsing bug a money bug, while typing only the ~dozen money verbs per provider
keeps the 60+-tool catalog intact. [spec-10](../architecture/integrations.md#capabilities-and-tools).
**Supersedes** plan-1 "Typed Tool Gateway" (as sole path) and the original
spec-2/8 raw-path signature gate. The raw in-container route was subsequently
removed: all provider effects now cross trusted typed capability boundaries,
while Code Mode and the workspace executor receive only frozen, scoped
capabilities. [spec-2](../architecture/security.md#trusted-egress) and
[spec-10](../architecture/integrations.md#capabilities-and-tools) are authoritative. **Superseded.**

### AD-010 — Policy Engine: layered configurability under three rules (2026-07-07)

Merchant-configurable policy up to merchant-written code, under three rules
(wording corrected same-day — the first draft's "nothing above L0 can widen"
would have made the trust ladder impossible, since L1 is exactly where rungs
are raised):

1. **Platform hard floors are not policy-editable** — the spec-8 signature
   requirement for high-stakes verbs, deny-by-default egress, budget-cap
   existence. The "autonomous" rung moves approval into _signer-side_ policy
   (Seams policy-bound signing within caps); the gate never drops.
2. **L1 structured rules are where grants live** — merchant admins raise or
   lower a capability's rung through versioned, compiled rules, bounded by
   the floors. Two-level inheritance: organisation baseline → surface override.
3. **Everything looser is restriction-only** — L3 policy-as-code and any LLM
   advisor may only tighten; L4 prompts enforce nothing. Merchant _code_ and
   anything probabilistic fail safe by construction.

**Supersedes** plan-1 "Policy Foundations" (four-level inheritance, resource
manifests, simulation APIs — deferred, not deleted).
[spec-6](../architecture/security.md#vault-policy-and-revocation). **Active.**

### AD-011 — SessionDO id embeds organisation_id (2026-07-07)

`idFromName(`${organisation_id}:${session_id}`)`, restoring plan-1's original shape.
The earlier spec-0/arch-system `idFromName(session_id)` violated the stated
isolation invariant ("every DO id embeds organisation_id") that arch-security T6
relies on. **Supersedes** the plain-ULID derivation. **Active.**

### AD-012 — OrganisationDO owns admission quotas; no RunnerDO (2026-07-07)

Organisation-level admission (concurrent sessions, warm slots, suspension — the
econ-storage plan tiers) is enforced by `OrganisationDO.admit()` before any
container claim ([spec-3](../architecture/runtime.md#agent-sessions)). Per-session budgets
stay in SessionDO (spec-8). There is **no RunnerDO**: SessionDO owns the
container binding directly. **Supersedes** plan-1's Runner Durable Object and
its Organisation DO section. AD-026 later preserves this ownership while replacing
immediate admission with reserve/commit/cancel. **Active.**

### AD-013 — plan-1-fork demoted to historical record (2026-07-07)

Plan 1 ceased to be design authority when its surviving decisions moved into
this log and the implementation specs. Its remaining experiment gates later
moved to Plans 9, 12, 13, 14, and 16. The obsolete source plan was deleted on
2026-08-03; immutable records and evidence retain their historical references.
**Complete.**

### AD-014 — Predicate = a JSON AST, not text CEL (2026-07-07)

The shared deterministic predicate engine (spec-6 L2 + spec-9 cue conditions)
is a small **JSON AST** — Rust-canonical serde enum, generated to TS, type in
the spec-0 appendix — evaluated by twin bounded interpreters (depth ≤ 16,
nodes ≤ 128, RE2-only regex, unknown-path-fails-closed) property-tested
against shared fixtures. **No text syntax in v1**: no text parser in the money
path; a console surface syntax may compile to the AST later. Chosen over a CEL
interpreter dependency for cross-language determinism and minimal attack
surface. [spec-6](../architecture/security.md#vault-policy-and-revocation) § predicate AST. **Active.**

### AD-015 — GraphQL providers are typed-only (2026-07-07)

GraphQL APIs (Shopify Admin) put everything on POST, so AD-009's mutating-verb
rule can't separate reads from mutations without parsing GraphQL on the raw
path — the forensic parsing AD-009 exists to kill. Therefore raw egress to
GraphQL endpoints is **denied entirely**: reads go through a typed low-stakes
query-only passthrough verb (validated in the trusted gateway); mutations are
typed high-stakes verbs. The raw path stays parsing-free.
[spec-10](../architecture/integrations.md#capabilities-and-tools). **Active.**

### AD-016 — Vault = envelope encryption over a Secrets Store root key (2026-07-07)

Cloudflare Secrets Store bindings are **one deploy-time named secret per
binding** (`secrets_store_secrets`, `env.BINDING.get()`) with no documented
dynamic read (verified against CF docs 2026-07-07) — they cannot serve
per-organisation merchant secrets created at runtime. The Vault is therefore
**envelope encryption**: root wrapping key(s) in Secrets Store (`VAULT_ROOT`);
per-organisation secret **ciphertexts** in D1; unwrap via WebCrypto only in the
trusted egress seam. `env.VAULT.resolve(handle)` is our abstraction, not a
platform call; plaintext never in D1/DO/container. Validation (limits,
injection-path latency): **E14**. **Supersedes** the earlier spec-0/6 implied
"Secrets Store holds each merchant secret, resolved by handle."
[spec-6](../architecture/security.md#vault-policy-and-revocation). **Active — pending E14 validation.**

### AD-017 — ActionRegistry with generated handlers and shims (2026-07-07)

One versioned registry (`ActionDef`, spec-0 appendix) defines every provider
action: schema, stakes class, canonicalization, `resourceKey` template,
idempotency support, credential scope, audit fields. Typed gateway handlers
**and** in-container CLI shims are **generated** from it — hand-written shims
drift; generated ones can't. Raw-path exceptions (low-stakes POSTs,
side-effectful GETs) are registry entries too: the registry covers reviewed
deviations from the method default, not every endpoint.
[spec-10](../architecture/integrations.md#capabilities-and-tools). **Active.**

### AD-018 — Action ledger + resource serialization before M7 (2026-07-07)

Idempotency stops the _same_ action twice; it does not stop two _different_
approved actions on the same resource (two refunds, one order — chat-2
unknown #4). `CanonicalAction` gains `resourceKey`; an organisation-scoped ledger in
`OrganisationDO` SQLite (async D1 projection) tracks
`proposed → approval_requested → signed → executing → confirmed | failed |
indeterminate | expired`, and the tool-gateway allows **one in-flight action
per resourceKey** (conflicts surfaced in the approval prompt). Ships with M7 —
not retrofittable after money moves.
[spec-8](../architecture/security.md#identity-approval-and-authorization). **Active.**

### AD-019 — Split credential scopes where providers allow (2026-07-07)

Connector onboarding provisions **two credentials** when the provider supports
scoped keys (e.g. Stripe restricted keys): a read-scoped key injected on the
raw path, a mutation-capable key held only by the tool-gateway. Raw-path blast
radius drops from "whatever the verb rule misses" to "whatever a read key can
see" — enforced by the provider, not by handler logic.
[spec-10](../architecture/integrations.md#capabilities-and-tools). **Active.**

### AD-020 — Greenfield: no live migration (2026-07-07)

Confirmed by the founder: there is no live Centaur deployment, no real users,
no production data — this is a new project. Spec-1's dual-write / shadow-read /
staged-cutover machinery is **deleted**; the fork is a clean start (migration
`0001` on an empty database; the first organisation is born via the install flow).
The deterministic `thread_key → organisation` backfill survives only as a one-shot
offline import utility for any future legacy dataset. Removes roughly a
milestone of throwaway scaffolding from M1.
[spec-1](../architecture/runtime.md#data-model-and-actor-persistence). **Active.**

### AD-021 — Conversation-risk guardrails (2026-07-07)

Four features adopted from the ElevenLabs Guardrails 2.0 review, all under the
AD-010 monotonicity rule (restrict, never grant): (1) **output screening** of
`agent.message` events at surface fan-out — generalizes spec-9's
private-channel check; (2) **suspicion escalation** — detected manipulation
tightens session posture (thresholds down, approvals up, admin flag) but is
never the containment mechanism (that stays structural, arch-security T2/T9);
(3) **per-rule violation actions** (`deny | deny+halt | deny+escalate |
deny+coach`), most-severe-wins composition; (4) **redaction at rest** on the
archive path (tokenized placeholders; shrinks the T11 erasure surface).
Explicitly rejected from the same source: natural-language guardrails as
enforcement, and LLM evaluation of actions — both violate the moat.
[spec-6](../architecture/security.md#vault-policy-and-revocation) § conversation-risk guardrails,
[spec-1](../architecture/runtime.md#data-model-and-actor-persistence) § redaction at rest. Placement: M4
(violation-action vocabulary), M6 (output screen + redaction), M7 (suspicion
escalation). **Active.**

### AD-022 — Production admission gates and placement cells (2026-07-10)

Production organisation traffic and durable customer data require all five gates
below to close with failure-injection or live-account evidence:

1. Session startup is a persisted, resumable saga. Every external effect has an
   idempotent resume or compensation path, and interrupted starts converge
   without leaked organisation slots, pool claims, containers, or gateway tokens.
2. Organisation placement is required, write-once domain state before first Durable
   Object access. Every stub is created through one placement-aware router.
   Regional pools are keyed by placement cell and harness Container class; the
   production path has no process-wide default pool.
3. Every state-bearing Durable Object is registered before its first mutation.
   A versioned export/import format plus restore drills covers organisation moves,
   offboarding, and disaster recovery.
4. Durable Object schema migrations are monotonic and non-destructive. Failed
   migrations leave the object recoverable or explicitly quarantined.
5. Production context retrieval requires a benchmarked, rebuildable search
   projection with a recent-tail merge, reconciliation, provenance and organisation
   filter checks, and measured quality, freshness, latency, failure behavior,
   and cost.

Cloudflare placement has two distinct guarantees. A Durable Object
`locationHint` on `get`/`getByName` influences first access on a best-effort
basis; existing objects remain in their original location. A jurisdictional
namespace constrains Durable Object compute and storage. Containers use
deploy-time region or jurisdiction constraints per Container class and may run
away from their managing Durable Object. Regional pool sharding therefore
selects a region-constrained Container class or deployment and verifies the
reported placement before hand-out. Exact DO/Container colocation is outside
the contract.

An end-to-end residency branch may ship only where every state and compute
substrate supports the same boundary. As of 2026-07-10, Durable Objects support
`eu`, `us`, and `fedramp`; Containers expose jurisdiction constraints for `eu`
and `fedramp`. A US-jurisdiction Durable Object alone is insufficient for a BYO
Container residency claim. Placement changes create a new placement epoch and
move state through the export/import gate; a later hint does not relocate an
object.

Platform references: [Durable Object data
location](https://developers.cloudflare.com/durable-objects/reference/data-location/),
[Durable Object namespace
API](https://developers.cloudflare.com/durable-objects/api/namespace/), and
[Container placement](https://developers.cloudflare.com/containers/platform-details/placement/).
Runtime execution progress is recorded in Plan 14, while the implementation
contracts live in specs 0, 1, and 3. **Active.**

### AD-023 — Production-gate execution and placement contract (2026-07-10)

AD-022 defines the production admission bar. This entry assigns each gate to
the phase that must construct the invariant and reserves Phase 15 for closure
evidence. It also makes placement epochs, fleet activation, runtime generations,
and residency capability explicit. Where the two entries differ, this entry
wins.

| Gate                                                   | Admission scope                                            | Constructed by                                                                                           | Required closure evidence                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PG-1 Session-start convergence**                     | Every production session                                   | Phase 3 / session lifecycle                                                                              | Deterministic interruption at every persisted transition, concurrent-resumer fencing, and a live-account start/recover/compensate run with zero leaked admissions, claims, containers, or gateway tokens                                                                                                         |
| **PG-2 Placement, fleet capacity, and regional pools** | Every production organisation                              | Placement types in Phase 2; router, AD-026 capacity governor, and pool enforcement in Phase 6/M6.7       | Type fixtures rejecting missing/default placement and invalid capacity allocations, pool/governor isolation tests, saturation plus fair-queue evidence, a live regional-constraint and rolling-deployment matrix, unexpected-placement quarantine, zero-leak reconciliation, and measured regional capacity/cost |
| **PG-3 Fleet registry and state mobility**             | Every state-bearing Durable Object                         | Registry activation and export format in Phase 3; organisation move/offboarding orchestration in Phase 6 | Ghost-reservation and orphan repair, versioned export/import equality, restore and relocation drills, and interruption at each cutover step                                                                                                                                                                      |
| **PG-4 Durable Object schema safety**                  | Every state-bearing Durable Object and every schema change | Migration framework in Phase 3; migration fixture added with each later schema version                   | Upgrade from every supported version, interruption at every migration step, idempotent resume or quarantine, and restore from a pre-upgrade export                                                                                                                                                               |
| **PG-5 Context retrieval quality**                     | Any deployment enabling production context retrieval       | Phase 10 / agent memory and context assembly                                                             | A production-shaped benchmark, dropped-projection recovery, recent-tail merge, provenance and organisation-filter denial tests, reconciliation, and explicit quality, freshness, latency, failure, and cost thresholds                                                                                           |

PG-1 through PG-4 are universal production gates. PG-5 is a feature-admission
gate: production may open with context retrieval disabled, and retrieval cannot
be enabled for production organisations until PG-5 closes. Evidence requirements are
cumulative. Failure injection proves convergence; live-account runs prove
Cloudflare placement, lifecycle, capacity, and latency behavior. Every gate row
in the implementation tracker must name an owner role, a numeric or binary
acceptance threshold, and a committed evidence artifact before it can close.

Organisation placement is immutable within one `placement_epoch`. The domain model
separates a best-effort **affinity cell** (Durable Object `locationHint` plus
Container region constraints) from a hard **residency cell** (jurisdictional
bindings across every participating substrate). An active-placement pointer
selects the epoch. Relocatable Durable Object physical names include the epoch,
for example
``idFromName(`${organisation_id}:${session_id}:p${placement_epoch}`)``, through the
jurisdiction-selected subnamespace. This **supersedes AD-011's exact physical
name formula** while preserving its organisation-ID isolation invariant.

A placement move reserves epoch `n + 1`, fences and freezes durable mutation on
epoch `n`, exports and verifies the target objects, atomically advances the
active-placement pointer, and retires the source objects. Every mutating call
carries the placement epoch and fence token; stale callers fail closed. Durable
state is never dual-written across placement epochs.

The fleet registry is a cross-store activation protocol rather than a final
inventory assertion. Its lifecycle is `reserved -> active -> exporting ->
retired | quarantined`. The placement router persists `reserved` before it
obtains a stub, makes an idempotent activation RPC the object's first request,
and exposes the reference to callers only after activation is durable. A crash
after either side of the D1/Durable Object boundary leaves a token-addressable
reservation that reconciliation can finish or retire. Direct namespace access
outside the router is rejected by static checks and tests.

A regional pool shard is identified by
`placement_cell_id x harness_class x runtime_revision`. `runtime_revision` is
an immutable fingerprint of the image digest, Worker deployment and binding
contract, and injected secret/config generation. A revision change closes the
old shard to new claims and drains or destroys its instances. The selected
Container class carries the deploy-time region or jurisdiction constraint;
`CLOUDFLARE_REGION` and `CLOUDFLARE_LOCATION` are checked before hand-out, and
an unexpected placement is quarantined and alerted.

Residency cells use a fail-closed capability matrix. The documented platform
contract as of 2026-07-10 is:

| Substrate                                     | Documented hard boundary                                                      | Admission consequence                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Durable Objects                               | `eu`, `us`, `fedramp`; location hints are affinity only                       | Select a jurisdictional subnamespace for residency state                                                                |
| Containers                                    | `eu`, `fedramp`; regional constraints are geographic placement                | ENAM/WNAM placement does not establish US residency                                                                     |
| D1                                            | `eu`, `fedramp`, fixed at database creation                                   | No D1-backed US residency cell                                                                                          |
| R2                                            | `eu`, `fedramp`, fixed at bucket creation                                     | Bind a jurisdiction-matched bucket; a location hint is insufficient                                                     |
| Workers ingress                               | Regional Services can constrain supported hostname processing                 | Queue, Cron, and subrequest paths require separate proof or exclusion                                                   |
| Queues and Vectorize/search                   | No per-resource jurisdiction guarantee documented in the cited product docs   | Residency-scoped customer data is denied until E15 proves support or the cell uses an approved regional alternative     |
| Secrets Store                                 | Secrets are documented as encrypted and stored across Cloudflare data centers | A strict residency cell requires an accepted contractual treatment or a regional key-management replacement             |
| Logs, traces, and analytics                   | Product-specific localization and export controls                             | Sensitive payloads stay out of telemetry; the cell requires a jurisdiction-approved sink and verified metadata boundary |
| External model, tool, and connector providers | Provider-specific                                                             | The cell requires a matching processing/storage contract and tested routing                                             |

No US end-to-end residency cell exists in the current Cloudflare-only BYO
design. EU and FedRAMP cells remain closed until E15 records an allowed path for
every row used by that cell. The live Phase-0 tracker expands to E1-E15, with
E15 owning the regional placement and residency matrix.

Platform references: [Durable Object data
location](https://developers.cloudflare.com/durable-objects/reference/data-location/),
[Container placement](https://developers.cloudflare.com/containers/platform-details/placement/),
[Container placement environment
variables](https://developers.cloudflare.com/containers/platform-details/environment-variables/),
[D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/),
[Workers regionalization](https://developers.cloudflare.com/data-localization/how-to/workers/),
[Queues](https://developers.cloudflare.com/queues/),
[Vectorize](https://developers.cloudflare.com/vectorize/), and
[Secrets Store](https://developers.cloudflare.com/secrets-store/). **Active.**

### AD-024 — Interactive latency and end-to-end response streaming (2026-07-10)

The interactive product objective is **provider latency plus a small Satyr
tax**, rather than a separate container-and-batch delay. On a warm path, Satyr
targets less than 500 ms p95 before the provider request and less than 500 ms
p95 from a provider token to the surface. A complete remote-model answer cannot
have a platform-guaranteed sub-second SLO; durable acceptance and visible
progress can, and first meaningful output should track provider time-to-first-
token plus at most 500 ms of Satyr overhead.

Six linked decisions establish that contract:

1. **Slack uses its native AI stream.** `ConnectorDO` owns a durable delivery
   lifecycle over `chat.startStream`, `chat.appendStream`, and
   `chat.stopStream`. `chat.postMessage`/`chat.update` remains the capability
   fallback and the path for discrete prompts, approvals, and terminal errors;
   it is no longer the primary agent-message stream after this decision lands.
2. **Interactive cold starts are configurable and excluded from the warm-path
   SLO.** Deployment config parses once into
   `WarmPoolPolicy = {kind:"disabled"} | {kind:"enabled", targetReady:number}`.
   `SATYR_WARM_POOL_MODE=disabled|enabled` selects the branch and
   `SATYR_WARM_POOL_TARGET` is required only when enabled. Development can turn
   it off to preserve scale-to-zero or on to exercise production latency.
   Production interactive profiles choose explicitly; there is no implicit
   production default.
3. **Harness pre-initialization is an independent setting.** Deployment config
   parses into `HarnessPreinitPolicy = {kind:"disabled"} |
{kind:"enabled"}` from `SATYR_HARNESS_PREINIT_MODE`. Enabled warm slots do
   not become claimable until the container, geo canary, `harness-server`, and
   pinned app-server protocol are healthy. Pre-initialization runs without
   organisation data, a workspace, or a session credential; claim performs the
   organisation/session binding. The four pool/preinit combinations are valid and
   tested so development can isolate each cost.
4. **The canonical event path streams end to end.** A sequenced turn envelope
   flows provider/harness -> embedded harness events -> `SessionDO` durable
   append -> `ConnectorDO` replay consumer -> incremental guardrail -> durable
   Slack delivery cursor -> Slack stream. Every event is persisted before
   fan-out. Reconnect resumes from
   the last durable sequence, duplicate envelopes are no-ops, cancellation and
   backpressure propagate upstream, and the production path does not collect a
   completed `AgentEvent[]` batch. The batch endpoint is deleted after the
   streaming replacement lands.
5. **Plain conversation has an explicit restricted route.** Core state carries
   `ExecutionRoute = {kind:"edge_conversation", capabilities:"text_only"} |
{kind:"sandbox_agent", harness:HarnessSpec}`. The edge route uses the same
   pinned model-route authority, policy snapshot, budget, audit, `AgentEvent`
   stream, and output screen. It has no tools, filesystem, merchant credentials, connector calls,
   approvals, or commerce actions. A request needing those capabilities stops
   the edge turn and restarts from the durable user input on the sandbox route;
   this promotion is safe because the edge route cannot perform external side
   effects. Diagnostics never select the route.
6. **Output screening is incremental.** In `stream` mode deterministic
   detectors keep per-turn candidate state across chunk boundaries and release
   only a confirmed-safe prefix. Partial email, card, and credential candidates
   remain buffered; an overlong or malformed candidate fails closed to hold.
   Deterministically held text is never released and therefore needs no
   best-effort retraction. `hold` mode still buffers the complete message. An
   optional later LLM screen may stop or retract a stream, and can never release
   text held by a deterministic detector.

Warm slots remain single-claim and single-organisation: a pristine slot may be
pre-initialized, but it is destroyed after its claimed session and is never
recycled across organisations. Pool shards remain keyed by AD-023's placement cell,
harness class, and runtime revision; the runtime revision includes stream
protocol and pre-initialization configuration, so incompatible generations
cannot mix.

Implementation ownership: Phase 3 owns sequenced streaming state, adapter
transport, the restricted edge route, and replay; Phase 6 owns configurable
warm/preinitialized regional pool shards; the Slack surface and incremental
guardrail land in the dedicated pre-commerce M6.6 milestone; Phase 15 reviews
measured p50/p95/p99 evidence and degraded cold-path behavior. This supersedes
AD-021's `stream` shorthand where it implied releasing content before a
deterministic decision, and supersedes the M5 batch transport as a production
shape.

Slack references: [`chat.startStream`](https://docs.slack.dev/reference/methods/chat.startStream/),
[`chat.appendStream`](https://docs.slack.dev/reference/methods/chat.appendStream/),
[`chat.stopStream`](https://docs.slack.dev/reference/methods/chat.stopStream/),
and [Developing an agent](https://docs.slack.dev/ai/developing-agents/).
[spec-3](../architecture/runtime.md#agent-sessions),
[spec-4](../architecture/runtime.md#harness-adapter),
[spec-5](../architecture/integrations.md#ingress-gateway), and
[spec-6](../architecture/security.md#vault-policy-and-revocation). **Active.**

### AD-025 — Resumable logical sessions and disposable runtime generations (2026-07-10)

Slack threads are long-lived logical conversations. A sandbox assignment is a
short-lived runtime generation owned by that conversation. Reclaiming idle
compute must preserve the logical session and its harness context.

The SessionDO lifecycle therefore separates conversation state from runtime
state:

```
starting -> running -> waiting_input -> hibernating -> hibernated
   ^                                                    |
   +---------------- reactivation generation ----------+

active state -> done   # explicit close only
active state -> error  # unrecoverable logical-session failure only
```

The state branches have strict invariants. `running`, `waiting_input`, and
`waiting_approval` require an assigned sandbox for BYO sessions. `hibernating`
retains that assignment while a durable checkpoint and cleanup saga converges.
`hibernated` requires no sandbox or organisation admission slot, has no `endedAt`, and
holds an authenticated checkpoint reference. `done` requires `endedAt` and is
reserved for explicit close, erasure, or retention expiry. An idle alarm never
writes `done`.

Each activation increments `runtimeGeneration`. The initial start and every
reactivation use the same fenced, persisted startup machinery, keyed by session
and generation. A reactivation loads the organisation's current policy before
admission, so policy is pinned for one runtime generation rather than forever
for a Slack thread. Revocation is therefore enforced before restored code can
run. Failed reactivation compensates the new sandbox and organisation slot, then
returns the logical session to `hibernated`; it does not destroy the last good
checkpoint or terminally poison the thread.

Idle hibernation is ordered as a recoverable saga:

1. prove there is no running turn or pending approval and persist
   `hibernating`;
2. request a harness-native checkpoint from the bound sandbox;
3. encrypt and authenticate it with an organisation/session/generation-bound key,
   durably write it to R2, and persist its key, digest, native thread id, and
   protocol/runtime revision;
4. revoke and destroy the claimed container, release the pool claim and organisation
   slot, clear the runtime binding, and persist `hibernated`;
5. let alarms resume any interrupted step idempotently. An orphan checkpoint is
   harmless and garbage-collected; a persisted checkpoint is never deleted
   before a replacement generation has restored successfully.

For reactivation, SessionDO claims a pristine runtime, verifies placement and
gateway binding, decrypts and restores the checkpoint, resumes the exact native
harness thread, and only then accepts the new user turn. A missing, corrupt,
wrong-organisation, incompatible-revision, or `resume:none` checkpoint fails visibly;
the system never starts a contextless replacement under the same logical
thread. Native checkpoint contents may contain unredacted conversation state,
so plaintext exists only in the live sandbox and Worker memory. R2 stores an
AEAD ciphertext. The checkpoint has an organisation erasure path and never enters
logs, D1, or Surface memory summaries.

This decision supersedes spec-3's prior `idle_timeout -> terminate -> done`
path. Explicit termination still archives the canonical redacted event stream,
destroys the runtime, releases admission, and writes `done`. Cloudflare
Containers restart with a fresh disk after sleep, so container identity alone
cannot implement conversation resume; Satyr owns checkpoint durability.

Implementation ownership: M6.6 adds the lifecycle branches, generation-fenced
sagas, Codex checkpoint boundary, encrypted R2 storage, restore-before-input,
and delayed same-thread live proof. M9 may add model-independent compaction and
cross-harness migration, while preserving AD-025's fail-closed native-resume
contract. [Cloudflare container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/),
[spec-1](../architecture/runtime.md#data-model-and-actor-persistence), [spec-3](../architecture/runtime.md#agent-sessions), and
[spec-6](../architecture/security.md#vault-policy-and-revocation). **Active.**

### AD-026 — Fleet capacity admission and rollout control (2026-07-11)

Organisation quotas and Cloudflare Container capacity are separate scarce resources.
`OrganisationDO` can prove that one organisation is within plan while many organisations together
exceed a Container class's `max_instances`, regional capacity, or account-level
memory/vCPU/disk budget. `PoolManagerDO` inventory is not a global capacity
reservation. Multi-organisation admission therefore requires an explicit fleet
capacity authority before a session can claim or cold-start a runtime.

Capacity authority is sharded by the scarce scheduling domain rather than held
in one worldwide hot object:

```
CapacityGovernorDO(`${container_class}:${placement_cell_id}`)
```

Every organisation using that Container class and placement cell shares the same
governor. A generated, versioned fleet manifest is the single source for
Container instance type, class-level `max_instances`, per-domain
`domain_limit`, warm target, rollout reserve, quarantine reserve, harness class,
placement cell, class emergency reserve, and active runtime revision.
The Wrangler Container config and Worker runtime binding are generated from the
same manifest. Deployment validation rejects drift between them. The manifest
compiler proves that allocations plus class-level reserve do not exceed the
class `max_instances`, and that all classes stay within configured account
memory, vCPU, disk, and image-storage budgets. Dynamic cross-domain borrowing
is deferred until measured demand justifies another coordinator.

The governor persists these disjoint lifecycle counts:

```
starting | warm_ready | claimed | draining | quarantined
```

and lease-backed reservations keyed by organisation, logical session, runtime
generation, and idempotency key. A capacity reservation is not proof that
Cloudflare can place the instance: start or placement failure compensates the
reservation and applies bounded backoff. Expired reservations and mismatches
between governor, pool, SessionDO, OrganisationDO, and actual Container health are
repairable reconciliation inputs, never inferred success.

Every running Container has one governor-issued `capacity_unit_id`. A session
reservation is a discriminated union:

```
warm_transfer { capacity_unit_id, sandbox_id, pool_shard }
cold_start    { capacity_unit_id, capacity_domain }
```

A warm transfer changes ownership of an already occupied unit from pool to
session and does not increment occupied capacity. A cold reservation holds one
currently free unit until Container start commits or the lease expires.
PoolManagerDO replenishment likewise obtains a cold capacity unit before it
starts a replacement warm Container. Pool inventory cannot create, duplicate,
or infer a capacity unit.

Session activation becomes one recoverable admission saga:

1. reserve the organisation's plan slot in `OrganisationDO`;
2. obtain a `warm_transfer` or `cold_start` reservation from the domain
   `CapacityGovernorDO`;
3. transfer the exact ready pool slot or create the exact reserved cold runtime;
4. bind and verify the sandbox, then commit both reservations;
5. compensate pool, fleet, and organisation state in reverse order after any failure.

Every transition is idempotent and fenced. A capacity denial never creates a
pool claim. It writes a durable queued state, returns a visible busy/status
event within a bounded deadline, and enters per-organisation fair scheduling. Queue
position is not a claim on capacity. Cancellation or timeout releases its
reservation. Organisation caps remain plan policy; the governor enforces shared
platform scarcity across organisations.

Usable capacity is calculated conservatively per domain:

```
usable = domain_limit - rollout_reserve - quarantine_reserve

starting + warm_ready + claimed <= usable

starting + warm_ready + claimed + draining + quarantined
  + unmaterialized_cold_reservations <= domain_limit
```

The deployment sizing review additionally proves:

```
domain_limit >= peak_active
             + current_warm_target
             + draining_revision_instances
             + replacement_and_canary_reserve

class_max_instances >= sum(domain_limits) + class_emergency_reserve
```

Fleet revisions have an explicit `reserved -> accepting -> draining -> retired
| quarantined` lifecycle. The immutable runtime revision is generated from the
image digest, harness/app-server protocol, Worker-to-container binding contract,
pre-initialization mode, and material config/secret generation. Activation
closes the prior revision to new claims before the new pointer is published.
Draining shards set warm target zero and cannot replenish. Claimed runtimes may
finish or checkpoint within the rollout deadline; after that deadline they
enter the same fenced runtime-loss recovery path as any failed container.

Cloudflare updates Worker code immediately while Container instances roll. A
compatible patch may use the same Container class with an active grace period.
A breaking runtime protocol uses a new class/binding or a versioned request
boundary that accepts only the active and draining revisions until drain
completes; the temporary boundary decoder is deleted with the retired revision.
The container handles `SIGTERM` by refusing new turns, reporting `draining`, and
finishing or checkpointing the active turn before exit. A forced stop cannot
silently acknowledge work.

`PoolManagerDO` owns physical warm inventory and consume/replenish behavior.
`CapacityGovernorDO` owns permission to consume shared capacity. `OrganisationDO`
owns plan quota. `SessionDO` owns the cross-object saga. None may substitute a
diagnostic count for another object's reservation. This supersedes AD-012's
immediate `OrganisationDO.admit` call shape with lease-backed reserve/commit/cancel,
while preserving OrganisationDO's exclusive ownership of organisation plan quota.

Implementation ownership: Phase 6 and M6.7 construct the governor, generated
manifest, admission saga, revision activation/drain, signal handling,
reconciliation, fair queue, and operator metrics. The completed admission,
warm-transfer, and runtime-identity fences support an isolated single-organisation
test-mode MVP. Remaining M6.7 rollout and reconciliation work blocks a second
organisation, live commerce credentials, multi-organisation beta, and production admission.
For delivery sequencing, the isolated single-organisation M6 path is a completed MVP
foundation. Capacity and rollout findings are tracked without interrupting the
M7A -> E12 -> M8A vertical slice unless they prevent that slice from running or
violate an MVP safety invariant. This execution rule changes milestone priority
and leaves every production gate intact.
Phase 15 reviews saturation, rollout, interruption, regional-capacity, and
leak-reconciliation evidence and introduces no new capacity invariant. This
supersedes spec-3's shorthand that a pool miss can always cold-start on demand.
[Cloudflare Container limits](https://developers.cloudflare.com/containers/platform-details/limits/),
[rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/),
[scaling and routing](https://developers.cloudflare.com/containers/platform-details/scaling-and-routing/),
[AD-023](#ad-023--production-gate-execution-and-placement-contract-2026-07-10),
and [spec-3](../architecture/runtime.md#agent-sessions). **Active.**

### AD-027 — Replaceable agent context and cue-workflow boundaries (2026-07-15)

Agent memory/context and proactive cues will evolve through independently
versioned contracts. Canonical conversation, file, task, person, connector, and
cue records remain the source of truth. Search indexes, summaries, embeddings,
retrieval strategies, and other memory aids are rebuildable projections. A
context assembler reads canonical records and approved projections through a
typed request and emits a bounded context bundle with item-level provenance,
visibility scope, ordering, freshness, and the versions of the policy and
assembly strategy that produced it.

`SessionDO`, `ThreadDO`, and the Cue Engine cannot depend on one vector store,
embedding model, summary format, or retrieval vendor. Recent canonical records
remain available when a projection is stale or unavailable. Cross-surface and
cross-organisation retrieval stays fail-closed. Production retrieval remains subject
to PG-5, including dropped-projection recovery, recent-tail merge, provenance,
organisation-filter denial, quality, freshness, latency, failure, and cost thresholds.

The Cue Engine consumes normalized `CueEvent` values and emits typed attention
or routing decisions. It owns attention provenance, deduplication, noise
control, and destination selection. Context assembly owns the evidence supplied
to a selected turn. Policy and approval gates own authorization. Commerce
capabilities register provider adapters, cue subscriptions, action handlers,
and workflow packs through typed registries; generic cue or memory code cannot
branch on Stripe, Shopify, or another product domain.

Evaluation preserves these boundaries. Semantic activation, cue attention,
context assembly, response quality, and workflow outcomes are independently
diagnosable and versioned. Runtime and eval runners call the same pure boundary
modules. Reports identify the scorer, context policy, prompt, model route, tool
catalog, workflow pack, and fixture versions so a memory, cue, or commerce
change can be compared without rewriting canonical persistence or session
lifecycle code.

Agent memory and context are governed by Plan 14 NF9 and Specs 3, 4, and 9. Ecommerce workflow
outcome suites can be added after the corresponding workflow contracts exist.
**Active.**

### AD-028 — Multi-account provider connections and integration accounts (2026-07-15)

Satyr models provider authorization and routable provider resources as two
different domain objects. A `provider_connection` is one organisation-scoped OAuth or
API authorization grant with a credential generation, granted scopes, and auth
lifecycle. An `integration_account` is one external resource discovered through
that connection, such as a Slack workspace, Stripe account, Shopify shop,
WhatsApp Business Account, phone number, TikTok shop, Instagram business
account, or Meta catalog.

Every provider event, webhook, cue, thread binding, projection, action,
idempotency key, and audit record carries `organisation_id` and
`integration_account_id`. One connection may expose many accounts, and one
organisation may hold multiple connections for the same provider. Provider resource
IDs are never treated as globally unique.

Specialized surface, commerce, catalog, and webhook records reference the
integration account. Existing `install` and one-row-per-provider `connector`
records migrate at the persistence boundary. Runtime code cuts over to the new
model in one revision; obsolete dual-read and compatibility paths are deleted
after migration verification. M10 owns the model and migration. **Active.**

### AD-029 — Shared Satyr provider applications for SMB onboarding (2026-07-15)

The self-service SMB path uses Satyr-owned provider applications for Slack,
Stripe, Shopify, Meta, TikTok, and later providers. OAuth callbacks bind a
single-use state to organisation, control identity, provider, and expiry. Credential
exchange, account discovery, and Vault storage occur server-side.

Per-organisation custom applications are deferred. The connection model reserves a
typed auth mode so a future enterprise flow can add a customer-owned
application without changing account identity, event routing, policy, or action
contracts. M10 establishes the shared-app connection framework; M11 and M12 add
provider implementations. **Active.**

### AD-030 — WhatsApp customer support is the first WhatsApp mode (revised 2026-08-25)

WhatsApp ships first as a governed customer-support surface under
[Plan 32](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-32-whatsapp-customer-support.md). Each phone-number integration
account requires an explicit customer audience, a disabled-by-default ingress
policy, temporary-content limits, Meta's customer-service-window enforcement,
exact reply approval, restricted agent tools, and human handoff. Cloud API
webhooks admit only new messages after enablement; Satyr does not provide
historical inbox access or durable message-content storage.

Internal owner/operator WhatsApp mode is deferred. V1 has one customer-support
mode and one account lifecycle, avoiding parallel mode and lifecycle branches.
Customer identity comes from Meta's `wa_id`; phone-number inference cannot
select identity, organisation, ownership, or policy. **Active.**

### AD-031 — Shopify authority for Shopify-backed social commerce (2026-07-15)

When a Shopify shop backs Instagram commerce or a Meta catalog, Shopify remains
the authority for product, inventory, price, and order records covered by that
link. Satyr persists explicit `catalog_link` records from the Shopify source
account to the Meta target account. Mutations execute against Shopify first and
then project the resulting provider revision to Meta.

Meta catalog state remains a projection with provider status, rejection
details, and synchronization provenance. Direct Meta mutations are available
only for records whose authority is explicitly Meta-owned. M12C owns the link,
projection, health cues, and typed mutation boundaries. **Active.**

### AD-032 — TikTok Shop retains commerce-record authority (2026-07-15)

TikTok Shop orders, cancellations, returns, fulfillments, refunds, and inventory
records remain provider-owned canonical commerce records. Satyr stores
normalized, rebuildable projections with source revision, provenance,
integration-account scope, and reconciliation status. Satyr does not create a
competing local order authority.

Typed actions execute through the Action Registry and Ledger, call the TikTok
provider with stable idempotency, and persist terminal provider receipts. Every
read and mutation names one TikTok shop account. M12A owns seller authorization,
signed ingestion, projections, cues, actions, and multi-shop acceptance.
**Active.**

### AD-033 — Approval authority is authentication-provider-neutral (revised 2026-08-05)

Satyr owns the stable control identity, organisation person, membership, approval
role, policy decision, action challenge, and approval receipt. Authentication
providers prove control of an eligible principal and confer no organisation authority
by themselves.

Ordinary merchant approvals use a recent Satyr control-session step-up. Google
OIDC is the initial provider and WebAuthn is the preferred future
phishing-resistant provider. Seams NEP-413 is an optional typed branch for
wallet-controlled or organisation-policy-selected high-value actions. Provider writes
do not require a Seams identity unless the active policy selects that branch.

Every approval ceremony binds the exact action digest, organisation, policy binding,
expiry, and nonce. The current commerce path records the explicit
`unversioned_default` binding; a versioned binding is required before an organisation
policy can select another authentication branch. The requesting agent cannot
approve its own gated action.
The action ledger consumes a provider-neutral approval receipt and never infers
authority from portal ownership, an OIDC claim, or a wallet signature alone.
**Active.**

### AD-034 — Customer conversations require audience and retention policy (2026-07-15)

Every customer-facing integration account and thread carries an explicit
audience policy and retention policy. Activation fails closed when either is
absent, incompatible with the provider mode, or inactive. The policies govern
identity aliases, context visibility, tool availability, transcript retention,
redaction, output screening, handoff, and deletion behavior.

Customer messages never grant action authority or broaden tool access. Internal
operator and customer-service surfaces use different typed states even when
they share one provider connection. M11C and M12B own the first customer-mode
implementations; later customer channels reuse the same boundary. **Active.**

### AD-035 — File-native commerce content is the product direction (2026-07-26)

Satyr is a file-native commerce content system that turns product truth, brand
knowledge, and source media into channel-specific content, advertisements,
listings, and agent-commerce projections. An owned storefront remains a
canonical destination and checkout rail. It is one compiled output alongside
TikTok, Meta, YouTube, marketplaces, email, Slack, and future agentic-commerce
channels.

The existing control plane, organisation isolation, provider connections, durable
runtime, policy, and commerce contracts remain foundations. Product delivery
now proceeds through grounded product and media files, governed creative
revisions, channel compilation, release controls, and performance feedback.
AD-041 deferred this direction. AD-048 retires its plans in favor of
feature-scoped collaborative authoring. **Superseded by AD-041 and AD-048.**

### AD-036 — Commerce authority and service boundaries (2026-07-27)

Satyr owns provider normalization, canonical projection identity, freshness,
reconciliation, operational areas, agent definitions, playbooks, approvals,
cues, and governed effect orchestration. Satyr does not own authoritative
checkout, inventory reservation, order, payment, refund, fulfillment, return,
attribution, or settlement state.

**Underclerk** is the only writer of private transactional commerce state for
Underclerk-backed stores. It owns the live catalog revision, checkout, orders,
inventory serialization, customer records, payment execution, fulfillment,
attribution, and settlement. Existing external
providers remain authoritative for the records they operate; Shopify-backed
authority under AD-031 and TikTok authority under AD-032 remain unchanged.
Satyr consumes their events as normalized, rebuildable projections.

The commerce module vocabulary is:

| Module     | Responsibility and current home                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| Contracts  | Shared commerce language and domain contracts in `packages/contracts`                                           |
| Urk        | Merchant-principal proposals, operating judgment, packaged heuristics, prompts, and evals                       |
| Blotter    | Rebuildable projections, queries, search, and operational history inside Satyr                                  |
| Scrutineer | Signed observations and media-evidence examination; its generic cue runtime remains a later product integration |
| Punter     | Independent buyer and cross-service acceptance harness                                                          |
| Seams      | Identity, signing, and key custody                                                                              |

Components integrate through authenticated versioned HTTP APIs and signed
events. Plan 9 owns the provider-neutral Commerce Kernel and provider adapters
inside Satyr. Underclerk owns its private commerce and administrative APIs.
Satyr uses those APIs for governed commands and rebuilds projections from
verified observations. AD-042 supersedes this decision's former dependency on
a file-native release chain while preserving its provider and service authority
boundaries. **Active as amended by AD-042.**

### AD-037 — Commerce modules and deployments are separate decisions (2026-07-27)

Underclerk, Urk, Scrutineer, and Punter have concrete directories under
`services/`. Lexicon names the shared contract responsibility implemented
in `packages/contracts`. Blotter names Satyr's projection, query, search, and
operational-history responsibility. Conceptual names remain stable even when
their implementation shares a process or package.

Repository proximity does not merge authority. Deployable runtimes keep
versioned APIs, independent persistence, migrations, secrets, rollback, and
focused tests. They communicate through authenticated HTTP and signed events.
Cross-runtime database access and private source imports are prohibited. A new
package or deployment requires measured authority, scaling, security, or
release-lifecycle pressure.

Satyr's provider-neutral Rust projection kernel remains in
`packages/contracts`. Underclerk owns its private API schema and generates the
Satyr client into `packages/underclerk-client`. Scrutineer retains a nested
TypeScript/Python workspace and lockfile inside `services/scrutineer`, keeping
its runtime extractable without coupling its package graph to Satyr's root
workspace.

The authoritative organization is documented in
[commerce-monorepo.md](../commerce-monorepo.md). **Active.**

### AD-038 — Canonical Actor lifecycle and harness boundary (2026-07-28)

[Plan 14](plan-14-actor-runtime-architecture.md) is the semantic authority for
durable ownership, session lifecycle, turn lifecycle, causal transitions, and
effect settlement. `AgentSessionActor` uses the closed lifecycle `Sleeping`,
`Activating`, `Processing`, `Checkpointing`, `Cancelling`, `Quarantined`, and
`Terminal`. An active turn carries its separate `TurnLifecycle`; disposable
executor work carries the `ExecutionLifecycle` defined by Plan 14.

Cloudflare process eviction and WebSocket hibernation are hosting events. They
do not create a session lifecycle state. A durable session without an active
turn or per-session runtime lease is `Sleeping`. Restoring a checkpoint and
acquiring a provider-neutral harness lease occurs in `Activating`. Explicit
close, retention expiry, and completed cancellation converge through
`Cancelling` to `Terminal`; uncertainty requiring operator or reconciliation
work converges to `Quarantined`.

Harness adapters emit validated boundary facts such as message fragments, tool
requests, approval requests, checkpoints, and turn outcomes. The receiving
`AgentSessionActor` assigns ordered Actor transitions and derives lifecycle.
Adapter events never carry authoritative session states. Provider effects use
the capability-correct settlement model in Plan 14: idempotent settlement,
reconciliation, or a durable `Indeterminate` outcome.

This decision supersedes AD-004's `AgentSession` adapter name and the lifecycle
labels and adapter-owned status events in AD-024 and AD-025. Their latency,
resumable-conversation, encrypted checkpoint, generation-fencing, and
disposable-runtime decisions remain
active. Existing persisted labels are migration inputs at the AR3 persistence
boundary and disappear after that migration. **Active.**

### AD-039 — Live Actor state uses bounded forward migrations (2026-07-28)

Satyr now operates live organisation, integration, thread, and session state. AD-020's
greenfield assumption is superseded. Actor persistence changes use a
versioned boundary parser, an explicit cohort and drain plan, registry-wide
reconciliation, and a named point of no return. Core reducers receive only the
current canonical state.

Plan 14 AR3 owns the first such cutover: all registered session Actors reconcile
to schema v22, then migrate atomically to the v23 journal shape. The rollout
uses no dual write or old-state fallback. Rollback is available before an Actor
commits v23; afterward that Actor recovers forward. Compatibility parsers and
retired tables are deleted after every live Actor and prior Worker revision has
drained. **Active.**

### AD-040 — Connector, Case, and AgentSession are the runtime ownership graph (2026-08-03)

`ConnectorActor` owns provider ingress deduplication, address normalization,
delivery attempts, and provider receipts. `CaseActor` owns canonical shared
context, assignments, accepted proposals, and the durable output outbox.
`AgentSessionActor` owns one independently restorable reasoning lineage and
submits typed proposals to its Case.

One Case may coordinate multiple sessions from the same Case revision. A
session can think, suspend, restore, cancel, or fail independently. The Case
alone decides which proposals become shared truth. This graph supports
coordinator, specialist, persistent-agent, and short-lived subagent loops
without coupling provider transport to reasoning state. Plan 15 is the
implementation authority. **Active.**

### AD-041 — Defer file-native commerce and file synchronization (2026-08-03)

Desktop applications, local SQLite projections, filesystem materialization,
external file synchronization, offline command transport, and advanced
file-native release workflows are deferred. The active product path is the
provider-backed commerce loop in Plans 9 and 16, running on the
Case/Connector/AgentSession runtime in Plans 14 and 15. Cloud-authored Markdown
instructions and playbooks are ordinary Plan 16 record content and do not
activate the deferred desktop layer.

Plan 14's immutable workspace revision remains an internal execution boundary
for heavy tasks. It is separate from the deferred file-native product and sync
model. Resuming the deferred track requires a new owner-approved plan covering
authority, synchronization, security, contracts, and migration.

### AD-042 — Provider-neutral kernel, cloud application, optional desktop (2026-08-03)

Plan 9 owns a provider-neutral Commerce Kernel. Provider wire schemas terminate
at versioned boundary parsers and remain separate from D1 table definitions.
Satyr canonical records carry organisation, provider revision, freshness,
reconciliation, policy, Case, action, and receipt state.

Plan 16 owns the cloud merchant application: integrations, commerce views,
operational areas, agent profiles, playbooks, governance, Cases, proposals,
approvals, and receipts. Its canonical records and APIs require no local
filesystem.

The deferred desktop layer may project authorized cloud records into local
SQLite and materialize agent source, playbooks, knowledge, drafts,
attachments, and artifacts as files. Commerce transactions, effective grants,
live Actor state, and receipts remain cloud-authoritative. Removing the desktop
or file adapter must leave the commerce backend, web console, and agent runtime
fully operational. **The cloud/desktop boundary remains active; AD-043
supersedes the kernel reference model.**

### AD-043 — Shopify-derived commerce spine and composed capabilities (2026-08-08)

Plan 9's canonical model uses Shopify's durable resource decomposition as its
primary reference while retaining provider-neutral Satyr semantics. The core
resources are Location, SalesChannel, Product, SellableVariant, InventoryItem,
Offer, InventoryPosition, CommerceOrder, Payment, Fulfillment, and Shipment.
Shopify IDs, statuses, Markets, publications, metafields, webhook shapes, and
historical API behavior terminate in the versioned Shopify adapter.

`Product`, `SellableVariant`, `InventoryItem`, and `Offer` remain separate. An
offer binds commercial terms to a variant and sales channel; an inventory
position binds a stockable item to a location. CommerceOrder uses strict origin
and buyer branches, immutable line and total snapshots, and a fulfillment
method independent of sale origin. Every projection carries exact source
authority, canonical revision, and provenance. Shopify, Underclerk, a POS, or
another connected commerce system remains authoritative; Satyr owns its
projections and governed effect receipts.

Online, POS, Food Service, Retail Operations, and Automation compose around the
same core records. Online store, cafe, konbini, and autonomous-konbini profiles
are setup presets. Runtime logic checks explicit capabilities and never a
profile label. POS remains present in the autonomous-konbini preset; Food
Service and Online are optional for that profile.

The current ecommerce-shaped contracts advance through one forward migration
with no dual write or retained domain compatibility path. Plan 9 owns the
replacement sequence; Plan 16 consumes only its composed merchant views.

`OrganisationActor` SQLite is the canonical Satyr authority for accepted commerce
deliveries, normalized observations, deterministic reducers, and current
per-organisation projections. D1 owns cross-Actor control and directory records plus
optional derived read indexes introduced for measured queries. Those indexes
remain rebuildable and cannot accept provider observations or issue commerce
projection revisions.

A provider delivery containing several resources becomes one typed
`CanonicalCommerceDelivery` with deterministic child observation identities.
`OrganisationActor` accepts the delivery receipt, all child observations, and all
projection transitions atomically. Exact replay is idempotent, conflicting
reuse of a delivery identity fails, and one invalid child rejects the complete
delivery. A child is emitted only when the provider payload supplies the
identity and relationship needed to validate it; adapters do not fabricate
missing InventoryItem, Location, SalesChannel, or Offer facts. The envelope
introduces no additional Actor or persistence authority. **The provider and
delivery mechanics remain active. AD-044 supersedes the domain model.**

### AD-044 — Merchant-native commerce aggregates and authoritative stock ledger (2026-08-11)

Satyr's canonical commerce domain is merchant-native. Shopify remains a
provider adapter and comparison implementation; its resource graph no longer
defines the core model. The authoritative target is
[Commerce Domain Architecture](../commerce-domain-architecture.md), and Plan 22
owns its replacement sequence.

Product content, sellable configuration, offers, inventory, checkout, orders,
payments, preparation, fulfillments, and shipments have separate aggregate
boundaries and lifecycles. An InventoryItem exists independently of a variant.
An explicit InventoryConsumptionPlan connects a sellable variant to direct
components or an immutable recipe revision. Fixed-precision movements,
allocations, and lots are authoritative stock facts; inventory positions are
transactionally derived balances. Checkout placement commits immediate
allocations and transfers later-consumption allocations to the Order.

A cart records mutable buyer intent. Checkout owns the exact quote,
allocations, protected delivery reference, and durable quote-bound payment
attempt. Placement attaches an authorized attempt and creates an immutable
commercial Order plus one or more method-specific Fulfillments in one local
transaction. Shipping, pickup, local delivery, immediate handoff, and
on-premise fulfillment are closed branches whose types expose only valid
states. Payment progress and fulfillment progress remain separate from Order
lifecycle. Recipe revisions are reusable definitions; PreparationTicket owns
order-specific work and ProductionBatch owns measured patisserie yield.

Underclerk stores authoritative records in normalized SQLite tables and emits
durable receipts plus signed observations from the same transaction. Generic
resource JSON and absolute inventory adjustment are removed from the
production command surface. Shopify maps only supported source facts and uses
an explicit provider-limited branch when accounted inventory is unavailable.
OrganisationActor continues to own merchant-safe, rebuildable projections rather
than private checkout or buyer records.

The replacement uses one forward path. Compatibility is allowed only at an
audited persisted-data or request boundary and is deleted after migration.
There is no dual-write model. **Active.**

### AD-045 — Pi is Satyr's strategic agent harness (2026-08-19)

Current routes, reconciled 2026-10-06:

- `organisation_subscription` + `openai` uses organisation-addressed Codex App Server with
  the organisation's ChatGPT OAuth profile.
- `organisation_byo` + `openai` uses Pi with a purpose-bound organisation OpenAI API key from Vault.
- `platform` + `openai-compatible` uses Pi with Satyr's `OPENROUTER_API_KEY`.

`AgentSessionActor` pins one route per session. Missing or exhausted authority
fails that route. Recovery never changes the funding authority. Picocodex is retired.

The migration reuses Actor-owned accepted history, canonical delivery,
`HarnessToolHost`, checkpoint metadata, lifecycle fencing, budgets, and the
trusted execution router. Pi-native messages and continuation data terminate
at the adapter boundary. They never become Satyr persistence or control-plane
contracts.

The cutover is forward-only. Legacy persisted Picocodex checkpoints may be
parsed only at the persistence boundary and are dispositioned to a fresh
lineage or quarantine; Satyr does not restore or translate them at runtime.
Codex and Pi continuation data terminate at their adapter boundaries and never
become Satyr persistence or control-plane contracts. **Active.**

### AD-046 — CafeOS bakery automation is the active product direction (2026-08-19)

Product scope reconciled 2026-10-06: Satyr Agents operates BakeryOS and CafeOS
across the bakery and café business. The operating loop includes demand,
purchasing, recipes, production, quality, packaging, inventory, sales,
distribution, and customer service. Portal and Slack provide shared operator
and agent surfaces. BakeryOS is the production orchestration workspace.

Fresh shop products and packaged gift assortments are business reference paths.
The accepted export scenario remains one commerce example. The bounded Plan 42
software and simulation scope is complete. Plan 60A equipment models are in
progress. Plans 61A–E remain draft. Physical robot dispatch remains planned.
The [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) preserves exact limits.

The existing commerce authority remains intact. Underclerk owns catalog,
selling, inventory, recipes, preparation, production batches, orders, payments,
fulfillments, and shipments. Satyr owns Cues, Cases, agent assignments, policy,
approvals, action receipts, projections, and Slack delivery. Plans 22 and 23
remain the completed Cafe/Patisserie and Japan-to-Singapore export foundations.

Robot fleet access is a separate operational control context. Every enrolled
robot, equipment gateway, operator, and agent has a stable identity. A machine
job receives narrow authority bound to an exact device, task, location, policy
revision, validity window, and operating limits. CafeOS records telemetry,
approval, dispatch, completion, revocation, and visibly indeterminate outcomes
without exposing raw device credentials to prompts, generated code, or
transcripts.

Certified machine controllers independently own emergency stops, collision
protection, interlocks, safe motion, thermal limits, and offline safety. CafeOS
cannot weaken or bypass those controls. Lost connectivity, expired authority,
or inconsistent state denies new work and leaves the equipment in its locally
defined safe condition.

Plan 24 owns the first measured path: one bakery, one export route, one product
family, one production batch, one robot-assisted step, one Slack approval, and
one reconciled shipment outcome. Owned robot hardware, generalized fleet
management, fully autonomous premises, and additional export routes remain
outside that path until measured evidence justifies them. **Active.**

### AD-047 — Provider integrations are statically compiled workflows (2026-08-29)

External provider connection lifecycles use one closed catalogue compiled into
the Satyr Worker. Every active provider supplies executable connect, observe,
and remove behavior. Adding an active provider without a complete catalogue
entry is a compile-time failure. Runtime plugin discovery, dynamic provider
code loading, installation manifests, and third-party executable extensions
are outside the architecture.

Provider lifecycle ownership has three layers. Shared lifecycle code owns
authorization attempts, mutation fences, Vault generations, D1 persistence,
cleanup retries, receipts, and audit evidence. A provider workflow owns the
provider-specific sequence for connection, observation, disablement, and
removal. A provider protocol module owns URLs, authentication, HTTP requests,
and response parsing. Raw provider responses terminate at the protocol
boundary; workflows receive normalized provider results; shared lifecycle code
does not branch on provider names.

The active catalogue contains Airtable, Gmail, Notion, Shopify, Slack, Stripe,
and WhatsApp. AI inference and Satyr Commerce remain first-party configuration
surfaces with their existing lifecycle owners. Reserved provider identities do
not become active integrations until their compiled workflow, protocol,
presentation, and conformance evidence land together. Rust continues to own
provider-neutral contracts and deterministic validation; TypeScript owns
provider networking beside Cloudflare bindings. [Refactor 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-2.md)
records the completed cutover and verification. **Active.**

### AD-048 — Feature-scoped collaborative authoring replaces file-native plans (2026-09-08)

[Plan 40](plan-40-product-description-drafting.md) and
[Plan 40B](plan-40B-collaborative-menu-editor.md) own collaborative
authoring. The file-native workspace and synchronization plans are deleted.
Shared application drafts are authoritative; agents materialize isolated
checkpoints and return validated, attributed changesets. Publication remains a
separate governed action. General desktop filesystem synchronization remains
deferred under AD-041. This decision selects the roadmap; Plans 40 and 40B
remain proposed until their acceptance paths are implemented. On 2026-10-29
the owner replaced the storefront builder in Plan 40B with the collaborative
menu editor; Satyr builds no merchant websites. **Active.**

## Open questions (undecided, tracked)

- **Retention and erasure** — owned by Plan 14 NF9.
- **Agent-commerce reliability** — owned by Plan 9 and the merchant-console
  work in Plan 16.
- **Vault envelope mechanics** — owned by Specs 6 and 8 plus Plans 12 and 13.
- **Placement, capacity, and residency cells** — owned by Plan 14; expand only
  from measured workloads.
- **Agent memory and context assembly** — bounded by AD-027, Plan 14 NF9, and
  Specs 3, 4, and 9. Operational observability is covered by Spec 13. The
  merchant administration surface is scoped by Plan 16.
- **Approval fatigue** — the security model's UX cost; measure in the lab
  stores (chat-2 unknown #3).
