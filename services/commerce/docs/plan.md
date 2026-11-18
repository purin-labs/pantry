# Commerce

Last reviewed: 2026-08-09 · Status: merchant Durable Object and transactional commerce v1 implemented locally

Commerce is the merchant's commerce system of record. It owns catalog
revisions, inventory, checkout, orders, customer records, payments,
fulfillment, attribution, and settlement for stores that select Commerce as
their transactional authority.

## Boundary with Pantry

- Pantry owns integrations, Cases, agent sessions, policy, approvals, governed
  actions, receipts, and rebuildable provider projections.
- Commerce owns private transactional commerce state.
- Pantry calls Commerce through an authenticated versioned API.
- Commerce emits signed commerce events for projection, cue, and
  reconciliation workflows.
- Sous Chef proposes merchant work through Pantry and receives no direct database or
  unrestricted commerce credential.

## Scope

- Catalog revisions and activation
- Locations, inventory, and reservation serialization
- Guest and identified checkout
- Orders, payments, refunds, and fulfillment
- Customer records with field-level protection
- Stripe payment execution and settlement receipts
- Attribution and commission ledger
- Transactional inbox, outbox, and idempotency
- Storefront and POS-facing commerce APIs as required by measured scenarios

## Architecture

```text
Pantry governed command
        |
        v
Commerce authenticated API
        |
        +--> merchant-named Durable Object
        +--> commerce SQLite transaction
        +--> provider execution when required
        +--> durable receipt
        +--> signed commerce event
                         |
                         v
                 Pantry projection and Case
```

Each merchant has one `UnderclerkMerchantDO` and one private SQLite database.
The Worker authenticates the v1 HTTP request, routes by merchant identity, and
keeps the HTTP boundary independent from Pantry's runtime. SQLite uses foreign
keys, strict tables, integer minor units, synchronous transactions, and unique
idempotency keys. Every authoritative transition has one writer.

## Implemented foundation

The undeployed catalog-activation experiment has been removed. The v1
authority lives in `src/commerce-authority.ts`; `src/schema.ts` owns its
forward-only SQLite schema. `src/worker.ts` and
`src/durable-object-database.ts` host it in Cloudflare, while `src/http.ts`
retains the authenticated v1 service boundary. Its versioned client lives in
`packages/commerce-client`.

The first transaction slice owns these merchant resources:

- Location and SalesChannel;
- Product and SellableVariant;
- InventoryItem and InventoryPosition; and
- Offer, including prepared, listed, and archived lifecycle.
- Order, Payment, Fulfillment, and Shipment demo projections used by the
  cafe seed; each carries provider-neutral lifecycle fields for Pantry's
  Orders and Operations views.

One authenticated batch command upserts explicitly supplied resources after
relationship, merchant-revision, and per-resource revision validation. Omitted
resources remain unchanged; deletion will use an explicit tombstone command.
Governed `publish_catalog_listing` binds exact Product, SellableVariant, Offer,
and SalesChannel revisions. `receive_inventory` binds one exact inventory item,
position revision, location, receipt line, quantity, and lot identity. Each
command records a deterministic idempotency receipt and a signed observation
delivery in the same SQLite transaction.

Pantry's adapter verifies each delivery signature before mapping its resources
to `CanonicalCommerceDelivery`. D1 binds the exact Pantry organisation, Commerce
merchant, and dedicated integration-account identity. The binding reads the
authenticated merchant snapshot and signer metadata; these identities are
never inferred from one another.

The local Worker proof covers authenticated idempotent provisioning, snapshot
reads, a transactional resource mutation, exact replay, signed receipts, and
the pending observation outbox through real `workerd` Durable Object storage.
Production secrets and deployment remain an explicit later operation.

For a local projection walkthrough, run `pnpm --filter @lowerarchy/commerce seed:cafe -- --organisation organisation_demo --merchant merchant_demo` against the local
Commerce Worker. The seed is deterministic and emits five cafe orders with
captured, failed, authorized, refunded, and partially refunded payments plus
requested, blocked, preparing, handed-off, and cancelled fulfillment states.

## Next milestones

| Milestone          | Exit criteria                                                                 |
| ------------------ | ----------------------------------------------------------------------------- |
| Transaction schema | Order, payment, and fulfillment invariants pass under replay and interruption |
| Merchant dashboard | Products, inventory, orders, and fulfillment work through the real API        |
| Agent action       | One Pantry Case executes and reconciles a governed Commerce command           |
| Live store         | One owner-operated store completes checkout and fulfillment                   |
| Settlement         | Capture, refund, hold, release, and reversal produce exact receipts           |

## Non-goals for the first store

- Multi-writer commerce state
- A general public interoperability protocol
- Public commerce graphs or discovery networks
- Custody outside the selected payment provider
- Shopify ecosystem parity
