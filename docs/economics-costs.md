# Satyr Economics: Storage, Runtime, and Subscription Costs

Model last reviewed: 2026-08-23. Documentation scope reconciled: 2026-10-06.

The tables below retain the July/August 2026 planning model. Prices, workload
assumptions, and break-even estimates have not been revalidated. Do not use them
as current quotes, billing guarantees, or evidence for an infrastructure change.
Refresh provider prices and measured workload before making a spending decision.

[Plan 14](plan-14-actor-runtime-architecture.md) defines runtime ownership.
[Plan 55](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-55.md) owns current regional placement and latency work. Its
acceptance gates remain separate from this historical cost comparison.

## Bakery and café business costs

Measure contribution per saleable product and fulfilled order. Include ingredients,
packaging, paid labor, energy, rejects, waste, payment fees, and fulfillment costs.
Compare fresh counter products and packaged assortments by channel. Separate
measured costs from assumed capacity and recipe yields. These are product reporting
targets; this document does not establish an implemented margin report.

Platform inference and hosting costs are a separate part of that operating cost.
Raw media and large artifacts remain in their existing object-storage boundaries.

## Historical model summary

The historical model assumed many mostly idle organisations with bursty activity.
It favored Cloudflare under that workload and treated inference, containers,
and provider effects as larger costs than storage. Its break-even calculations
below depend on the recorded prices, write counts, and placement assumptions.

Current cost accounting distinguishes organisation ChatGPT allowance, organisation OpenAI
API usage, and Satyr-funded OpenRouter usage. Compare measured cost per successful
task before changing placement or subscription pricing.

## Historical pricing snapshot (2026-07; not revalidated)

|                   | Cloudflare (Workers Paid, $5/mo)                                                              | Supabase                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Base              | $5/mo; includes 25B rows read + 50M rows written/mo                                           | Pro $25/mo (includes $10 compute credit)                          |
| Compute           | None; usage-priced (requests $0.15/M, duration billed only while active, hibernation is free) | Provisioned 24/7: Micro $10, Small $15, Medium $60, Large $110/mo |
| Rows              | $0.001/M reads, $1.00/M writes past included; D1 and DO SQLite price identically              | Included in instance; no per-row cost                             |
| Storage           | ~$0.20/GB-mo (DO SQLite), $0.75/GB-mo (D1), 5GB included                                      | 8GB included, then ~$0.125/GB                                     |
| Streams path      | Queues $0.40/M operations (~3 ops per delivered message), R2 ~$0.015/GB-mo                    | n/a (rows)                                                        |
| Production extras | —                                                                                             | PITR backup add-on ~$100/mo, egress $0.09/GB past 250GB           |

A production-grade Supabase floor (Pro + Small-to-Medium compute + PITR) is
roughly $85–185/mo before serving a single request, and it accrues whether
organisations are active or not. The Cloudflare side has no idle floor beyond
$5/mo: a dormant organisation costs storage pennies because its Durable Objects
hibernate.

## Workload Model

Assumptions used throughout (tune these as real telemetry arrives):

- ~20 row writes per agent-handled message (session state, lifecycle,
  thin D1 index projections, including index write amplification).
- ~10 stream events per agent-handled message (audit, surface events, policy
  decisions, cues) routed through Queues -> R2 as batched JSONL, never as
  rows. This routing is the single most important cost control in the design.
- Activity profiles per merchant: light = 50 agent-handled messages/day,
  moderate = 150/day, heavy = 500/day, very heavy = 2,000/day.

## Worked Comparison

Monthly platform bill for the persistence layer (excludes containers,
provider-effect spend, and Satyr-funded Pi model usage; organisation Codex usage
consumes the organisation's allowance):

| Scale                   | Row writes/mo | Cloudflare                                 | Supabase equivalent                              |
| ----------------------- | ------------- | ------------------------------------------ | ------------------------------------------------ |
| 10 merchants, light     | ~0.3M         | ~$5 (all included)                         | ~$85+ floor                                      |
| 100 merchants, moderate | ~9M           | ~$15–25 ($5 base + Queues + R2)            | ~$185 floor                                      |
| 100 merchants, heavy    | ~30M          | ~$30–40 (still inside 50M included writes) | ~$185 floor                                      |
| 500 merchants, heavy    | ~150M         | ~$200 (write overage + Queues)             | ~$185–300 (larger compute) + DO costs still owed |

Note the last row: even where the raw numbers converge, the Supabase column
is understated, because coordination Durable Objects (requests + duration)
are still running and billing on top of the Postgres instance, and every
query from a Worker to Supabase pays a Hyperdrive round trip (10–50ms to a
single-region instance) instead of sub-millisecond DO-local SQLite.

## Cloudflare Cost Drivers And Sharp Edges

- Row writes at $1.00/M are the one sharp edge. Every SQLite index multiplies
  writes: an insert into a table with three indexes bills as ~4 row writes.
  Keep indexes minimal on DO SQLite tables and treat new indexes as a cost
  decision, not a free optimization.
- Misrouting append-heavy streams (audit, events, cues, decisions) into D1 or
  DO rows would multiply write volume by roughly 10x. The Queues -> R2 stream
  path in the persistence model is what keeps row writes low; regressions
  against it are cost regressions.
- Durable Object duration billing applies only while objects are active.
  Sessions holding WebSockets must use hibernation APIs so idle open
  connections do not accrue duration.
- D1 storage ($0.75/GB-mo) is ~4x DO storage; another reason large payloads
  and streams belong in R2 ($0.015/GB-mo).

## Supabase Cost Drivers

- The instance is on 24/7. Cost scales with provisioned capacity, not usage,
  which is exactly wrong for a fleet of mostly-dormant organisations.
- Production readiness is not the sticker price: PITR (~$100/mo), egress
  ($0.09/GB past 250GB), and eventually read replicas.
- Operational ownership: upgrades, vacuum, index bloat, connection limits
  from Workers (Hyperdrive mitigates but adds a hop), and single-region
  write latency for a globally distributed Worker fleet.
- Architectural cost: reintroduces the external Postgres control plane the
  fork plan explicitly removes, and replaces physical per-organisation partitioning
  (DO SQLite) with shared tables where organisation isolation is a query-discipline
  problem again.

## Historical conditions for comparing Supabase

Merchant count is a poor proxy on its own. Using the workload model, the
Cloudflare bill reaches the ~$185–200/mo Supabase floor at roughly 235M row
writes/month (~390k agent-handled messages/day). In merchant terms:

| Activity profile            | Merchants at break-even |
| --------------------------- | ----------------------- |
| Light (50 msgs/day)         | ~7,800                  |
| Moderate (150 msgs/day)     | ~2,600                  |
| Heavy (500 msgs/day)        | ~780                    |
| Very heavy (2,000 msgs/day) | ~195                    |

So "+100 merchants" flips the economics only if the average merchant is very
heavily active (thousands of agent-handled messages per merchant per day) or
if write amplification is unmanaged. At +100 moderately active merchants,
Cloudflare remains an order of magnitude cheaper than the Supabase floor.

Non-cost triggers matter more than the thresholds above. Move to (or add)
Postgres when any of these hold:

1. **The Workflows spike fails.** If the Phase 0 limits spike forces the
   Absurd/Postgres workflow backend, Postgres enters the stack regardless.
   At that point the instance's marginal cost is already paid, and
   consolidating the control plane and high-volume state onto it is a
   legitimate follow-up decision rather than a second database.
2. **Sustained row-write volume crosses ~200–300M/mo** with the stream
   routing and index discipline already in place — i.e., the writes are
   genuinely irreducible, not an artifact of misrouted streams or index
   amplification. Check routing and indexes before migrating.
3. **Cross-organisation analytics outgrow the index/stream model.** If operators
   need rich ad-hoc SQL across organisations (BI joins, cohort queries) and
   Analytics Engine plus R2 stream indexes prove insufficient, a Postgres
   read model fed from the streams is the right tool — as a projection,
   not as the system of record.
4. **Enterprise dedicated deployments demand it.** A regulated merchant that
   requires Postgres, their own VPC, or their own backup regime gets it in
   the dedicated-deployment tier without changing the pooled platform.
5. **Operator economics invert.** If debugging and repair time on DO-sharded
   state measurably exceeds the cost delta (psql, pg_dump, and mature
   Postgres tooling are real advantages), that operational drag is a valid
   reason — but weigh it against re-owning organisation isolation in shared tables.

The likely long-term shape is hybrid, not migration: D1 + DO SQLite remain
the system of record for the pooled platform; Postgres appears first as the
workflow backend fallback (trigger 1) or an analytics projection (trigger 3),
and only becomes primary storage if trigger 2 sustains.

## Historical subscription and merchant-cap assumptions

Historical pricing hypothesis (2026-07-03), retained from the retired desktop
workspace proposal: these tiers cover two motions. Starter/Growth ($20/$50) serve the
self-serve micro-team segment (2–4 person merchants) under hard conditions:
defaults-only onboarding, docs/community support only, hard agent-task
caps, and near-zero CAC distribution. Professional ($175) is the mid-market
entry, priced per-seat-plus-usage upward (target ACV $2–10k/yr). These
tiers originate in the Seams Technologies KK filed plan (¥3,100 / ¥7,750 /
¥27,125 per month plus overage, ~¥47.5/MAU assumption; Year 1–3 customer
counts 100/25/5/1 → 400/200/100/6, Year 1 revenue ¥10M), so tier mechanics
should stay reconciled with that filing — the filed Year 1 depends on
Starter-tier volume, which is what the self-serve micro-team segment
supplies. The cap/enforcement mechanics below remain valid; tier allowances
still need rework against this ladder.

Every merchant is capped by a subscription plan with metered overage. Plans
exist for two reasons: they bound the platform's variable-cost exposure per
organisation (platform-funded Pi model usage, container runtime, and provider effects
dominate; see margins note below), and they give the Organisation Durable Object
concrete quota numbers to enforce.

|                            | Starter $20/mo            | Growth $50/mo                               | Professional $175/mo                                                                 |
| -------------------------- | ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| Agent tasks included       | 60                        | 200                                         | 800                                                                                  |
| Overage per agent task     | $0.35                     | $0.30                                       | $0.25                                                                                |
| Concurrent active sessions | 1                         | 3                                           | 10                                                                                   |
| Warm containers            | 0                         | 1                                           | 3                                                                                    |
| Enabled work surfaces      | 3                         | 10                                          | Unlimited (fair use)                                                                 |
| Initiative (Cue Engine)    | Tier 1 subscriptions only | Tiers 1–2 (subscriptions + task follow-ups) | Tiers 1–2, Tier 3 ambient scoring opt-in when available, cross-surface memory grants |
| Raw DB access              | No                        | No                                          | Yes (readonly default, JIT approval)                                                 |
| Artifact storage (R2)      | 5GB                       | 25GB                                        | 100GB                                                                                |
| Data tier                  | Pooled                    | Pooled                                      | Pooled, dedicated-data add-on available                                              |

An "agent task" is one metered unit of agent execution (one session run),
the same unit the Session Durable Object already tracks as an execution.
Task allowances and overage prices are calibration targets, not final
pricing: they assume a variable cost of roughly $0.10–0.30 per task. A
organisation-funded Codex turn contributes container, provider-effect, and operations
cost. A platform-funded Pi turn also contributes OpenRouter model cost.
Persistence-layer costs (rows, Queues, R2) remain under 2% of task cost in the
model. Recalibrate from AgentSession route usage, provider-reported Codex
allowance, and OpenRouter usage telemetry once Phase 1 carries real traffic,
sizing for a 55–70% gross margin at the expected task mix.

Enforcement maps onto mechanisms the fork plan already defines:

- `organisations.plan` seeds `organisation_quotas` rows at provisioning; changing plan
  rewrites the quota rows and bumps the policy snapshot version.
- The Organisation Durable Object enforces admission-time caps: concurrent
  sessions, warm containers, active raw DB leases, and the monthly task
  counter.
- `AgentSessionActor` reserves the turn token budget against the pinned model
  route. Organisation-subscription Codex checks the provider-reported allowance.
  Platform-funded Pi uses `OPENROUTER_API_KEY` and settles usage against the
  Satyr-funded budget.
- The Policy Engine gates plan-tier features (Cue Engine mode, raw DB
  access, surface count) as ordinary policy rules, so plan changes are
  policy snapshot changes rather than special-cased code.
- Usage events flow into the existing Queues -> R2 billing/audit streams;
  monthly overage invoicing aggregates from the streams, so billing reads
  the same records operators audit.

Overage is soft-capped by default: tasks beyond the allowance bill at the
overage rate, and each merchant has a configurable hard spend cap at which
the Organisation Durable Object suspends new task admission (existing sessions
finish). Overage prices must stay above the marginal platform cost per task
with buffer, or heavy overage merchants become loss-making. Recheck against
route mix, OpenRouter model usage, container runtime, provider effects, and
support cost as telemetry changes.

## Revisit Cadence

- Re-run this analysis when real telemetry replaces the workload model
  (Phase 3, once durable sessions carry production-shaped traffic), and at
  every 10x growth in monthly row writes.
- Add per-organisation row-write and Queues-operation counters to the cost
  accounting work in the production-hardening phase so break-even tracking
  is observed, not estimated.

## Sources

- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Queues pricing: https://developers.cloudflare.com/queues/platform/pricing/
- R2 pricing: https://developers.cloudflare.com/r2/pricing/
- DO SQLite index write amplification measurement: https://medium.com/cloudflare-durable-objects-design-patterns/every-index-costs-you-1-per-million-rows-measuring-do-sqlite-write-costs-8f16489ef4dc
- Supabase pricing: https://supabase.com/pricing

## Runtime economics

Inference has three explicit cost profiles:

- `organisation_subscription` + `openai` sends an Actor-leased turn to the
  organisation-addressed `CodexHarnessContainer`. Codex App Server consumes the
  organisation's ChatGPT allowance while Satyr pays container time, Worker requests,
  Durable Object duration, storage, and provider effects.
- `organisation_byo` + `openai` runs Pi with the organisation's purpose-bound OpenAI API key
  from Vault. The organisation funds model usage. Satyr still incurs Platform runtime
  and storage costs.
- `platform` + `openai-compatible` runs Pi in the Worker with
  `OPENROUTER_API_KEY`. Satyr pays the OpenRouter model usage, Worker and Durable
  Object runtime, storage, and provider effects.

The session contract pins the route. An expired OAuth profile, exhausted
allowance, missing platform key, or model transport failure stays on that route
and fails closed. Cost accounting therefore records the selected funding class
for every turn. Pi never serves as a repair path for Codex.

Heavy workspace, browser, bulk-catalog, or native-media work crosses the
on-demand workspace-executor boundary. Its cost is measured per execution by
CPU time, memory time, disk, wall time, artifact bytes, and retry count. Keep
that executor optional and allocate it only when the task requires capabilities
outside the selected harness boundary.

The dominant platform-variable costs depend on route mix. Organisation Codex makes
model usage an external allowance and capacity constraint. Platform Pi makes
model tokens a direct Satyr expense. Storage and coordination are the platform
floor. Measure the following dimensions per Case assignment and AgentSession
turn before changing placement or adding a new compute tier:

- pinned funding class, harness, model, and input/output tokens for each turn;
- provider-reported Codex allowance, organisation OpenAI usage, or Satyr OpenRouter usage;
- Worker requests and Durable Object active duration;
- queue operations, journal bytes, and R2 artifact bytes;
- workspace-executor CPU, memory, disk, wall time, and retries; and
- provider calls, effect receipts, and failed or replayed attempts.

## Subscription and quota economics

Subscription plans bound variable-cost exposure and map to admission policy.
Plan quotas remain calibration targets until production-shaped telemetry is
available. The control plane should enforce caps at the narrowest owner:

| Resource                                           | Owning boundary                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Concurrent Case assignments and AgentSession turns | Organisation/Case admission                                            |
| Model token budget and funding-class quota         | AgentSession and the pinned organisation or platform funding authority |
| Heavy execution concurrency and wall time          | Workspace executor admission                                           |
| Provider action allowance and spend                | Policy and typed action gateway                                        |
| Artifact storage                                   | Organisation storage quota and R2 policy                               |
| Usage and overage records                          | Durable outbox to Queues/R2 billing stream                             |

Overage can remain soft-capped until an organisation reaches its configured hard
spend cap. At the hard cap, new work is refused while already accepted work
settles. Usage records must be idempotent and tied to the exact Case,
assignment, turn, provider effect, and receipt identities.

## Economics decision triggers

Keep D1, Durable Object SQLite, Queues, and R2 as the pooled platform
foundation. Add a Postgres projection or dedicated deployment only when an
observed requirement justifies it:

1. irreducible D1 write volume exceeds a newly measured and repriced break-even range after
   stream routing and index amplification are optimized;
2. cross-organisation analytics outgrow the stream and index projections;
3. a dedicated merchant requires its own database, backup, network, or
   residency boundary; or
4. operational repair time on the pooled stores materially exceeds the cost of
   an additional projection.

Postgres begins as a read or workflow projection. It does not become a second
transactional authority for Cases, AgentSessions, or merchant commerce state
without a separate architecture decision.

## Revisit cadence

Re-run this model when production telemetry replaces the current workload
assumptions and at every tenfold increase in monthly row writes, active turns,
or heavy-executor hours. Reconcile subscription caps with the observed Codex/Pi
route mix, OpenRouter model spend, Codex container time, provider effects, and
support costs before changing plan pricing.
