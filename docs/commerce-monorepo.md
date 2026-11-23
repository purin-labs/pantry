# Commerce Module, Authority, and Runtime Boundaries

Last reviewed: 2026-08-09 · Status: **authoritative**

This document defines three separate concerns: the human-facing module
vocabulary, code ownership, and runtime deployment. A named module can map to a
package, an internal subsystem, an independent process, or an acceptance
harness. Plans 9 and 16 own the active provider-backed product.
[Plan 40](history/plan-40-product-description-drafting.md) and
[Plan 40B](history/plan-40B-collaborative-menu-editor.md) own proposed
collaborative authoring. General desktop filesystem synchronization is deferred.

## Module vocabulary

| Module                  | Human meaning                                                     | Current implementation home                                                                                 | Current runtime                       |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Commerce**          | Transactional commerce authority                                  | `services/commerce`                                                                                       | Independent service and database      |
| **Contracts**           | Shared commerce language and domain contracts                     | `packages/contracts`                                                                                        | Compiled into Pantry and its consumers |
| **Urk**                 | Merchant-agent behavior and operating judgment                    | `surfaces/slack/server/data/urk-skills.ts` and Pantry agent configuration                                    | Pantry runtime                         |
| **Commerce Read Layer** | Rebuildable projections, queries, search, and operational history | `services/platform` OrganisationActor projections, normalized commerce relations, and `CommerceGraphReader` | Pantry runtime                         |
| **Punter**              | Independent buyer and acceptance scenarios                        | `scripts/punter`                                                                                            | CLI and CI harness                    |

These names make ownership understandable. They do not create a package,
database, network API, or deployment by themselves.

Pantry hosts the organisation control plane, Cases, agent sessions, integrations,
governed actions, merchant console, Urk behavior, and the Commerce Read Layer.
Seams supplies key custody and signing. Stripe and Shopify remain external
providers.

## Authority

| State                                                                | System of record                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| Products, inventory, orders, and fulfillment                         | The organisation's selected Seams Checkout or Shopify system |
| Provider-normalized read projections                                 | Pantry; rebuildable from provider observations                |
| Shared commerce vocabulary and contract definitions                  | Contracts role in `packages/contracts`                       |
| Commerce queries and operational history                             | Commerce Read Layer role in Pantry                            |
| Cases, sessions, proposals, approvals, policies, and action receipts | Pantry                                                        |
| Payment execution                                                    | Stripe or the selected payment provider                      |
| Merchant-agent instructions and skills                               | Urk, installed by Platform                                   |
| Event processing                                                     | Acceptance results                                                   | Punter                                                       |
| Keys and signing authority                                           | Seams                                                        |

Each organisation and environment has one transaction authority for a given resource.
Pantry never becomes the commerce system of record merely by projecting provider
state for agents or the portal.

## Integration boundary

The active integration surface is deliberately small:

1. Pantry calls a provider's versioned authenticated API.
2. The provider returns a typed response and durable execution receipt.
3. Signed or authenticated provider events report authoritative state changes.
4. Pantry validates those events once and updates rebuildable projections.
5. Gaps reconcile through verified provider reads.

Commerce owns its private admin and commerce APIs. Pantry is the initial caller
authorized to submit governed merchant mutations. Urk proposes work through
Pantry and receives no direct commerce write credential.

Shared TypeScript contract schemas describe the provider-neutral commerce domain. They
do not prescribe another service's database or public wire format. Provider
payloads terminate inside their adapter.

## Identity mapping

| Identity                    | Scope                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `organisationId`            | Pantry workspace, membership, provider, policy, and approval boundary |
| `merchantId`                | Commerce boundary                                         |
| `integrationAccountId`      | One provider connection inside a Pantry organisation                  |
| Pantry person and membership | Human authority inside the organisation                              |
| Verified external identity  | Slack or another surface identity linked to a Pantry person           |
| Seams key and policy ID     | Authorized signatures for commands, events, and receipts             |

An organisation has at most one active Commerce merchant binding per environment.
Private order, checkout, customer, and payment identifiers stay inside
authenticated service boundaries.

## Command and event semantics

Pantry submits a typed governed action carrying:

- the exact resource identity and revision;
- normalized parameters;
- the policy decision and approval when required;
- action and idempotency identities; and
- the authenticated organisation and merchant binding.

Commerce authenticates the caller, validates the command, executes or
reconciles once, and returns a durable receipt. Events are ordered per merchant
stream, replayable, and delivered at least once. Pantry deduplicates by event ID
and reconciles gaps with provider reads. Reusing an idempotency key with
different content is a conflict.

## Shopify and Commerce authority

Authority changes per organisation and environment. There is no dual-write mode.

```text
shopify | commerce
```

1. Pantry normalizes Shopify into provider-neutral read projections while
   Shopify is authoritative.
2. Commerce proves the same commerce scenarios in a shadow environment.
3. An explicit cutover selects Commerce as transactional authority.
4. Shopify may remain a channel adapter or historical source after cutover.
5. Shopify-specific compatibility code is deleted after the final dependent
   organisation migrates.

## Commerce Kernel

Plan 9's Commerce Kernel remains in Pantry. It owns:

- provider-neutral domain contract schemas;
- provider adapters and deterministic normalization;
- rebuildable merchant projections;
- lifecycle and replay scenarios; and
- governed action and receipt semantics.

Move an authoritative transition to Commerce only after Commerce accepts a
real Pantry action, returns a durable receipt, emits an observation that rebuilds
the same Pantry projection, and passes the relevant replay and interruption
scenario. Pantry keeps one projection path and no synthetic second writer.

## Monorepo layout

```text
pantry/
├── apps/
│   └── portal/                 # Merchant and agent operations UI
├── services/
│   ├── platform/               # Control plane, integrations and Urk
│   ├── workspace-executor/     # Heavy execution boundary
│   └── commerce/             # Commerce authority
├── packages/
│   ├── contracts/              # Provider-neutral contract schemas
│   ├── control-api/            # Portal ↔ platform request/response shapes
│   ├── std/                    # Shared runtime helpers (guards, encoding, digests)
│   ├── type-utils/             # Shared TypeScript type helpers
│   └── bakery-model/           # Kitchen model: recipes, procedures, physics
├── crates/
│   └── workspace-executor/
└── scripts/
    └── punter/                 # External acceptance
```

Runtime boundaries communicate through authenticated versioned APIs and signed
events. Code modules follow explicit ownership and never import another
runtime's database or private source. A conceptual module becomes a separate
deployment only when its authority, scaling, security, or release lifecycle
requires one.

For a contract change:

1. Change the owning schema or API definition and its parser in one commit.
2. Update the owning service and direct consumers.
3. Run the focused invariant and boundary scenario.
4. Deploy in dependency order.

Planning directories do not receive placeholder packages.
