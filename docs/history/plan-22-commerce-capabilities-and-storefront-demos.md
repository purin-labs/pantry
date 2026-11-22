# Plan 22 — Satyr Commerce Domain and Storefront Proof

Status: **complete** · Date: 2026-08-13 · Owners: Lexicon, Underclerk,
Satyr platform, and the buyer storefront application · Depends on: Plans 9,
19, 20, and 21

## Goal

Replace the Shopify-derived core commerce records with the merchant-native
domain in [Commerce Domain Architecture](../commerce-domain-architecture.md), then
prove it through two Satyr Commerce configurations:

1. a Cafe / Patisserie model; and
2. an ecommerce storefront for the same merchant, selling packaged products
   such as boxes of cookies online.

Both configurations use one buyer application and one Underclerk commerce
authority. Existing Shopify support receives only the boundary changes required
by the contract replacement. Plan 22 adds no Shopify storefront, parity report,
or provider capability.

Required organisation data moves through an audited migration. Synthetic demo data
may be reset after classification. Core code accepts only the replacement
domain types after boundary parsing.

## Implemented scope

Plan 22 implements only behavior exercised by the two configurations:

- products, variants, locations, one online sales channel, storefronts,
  deterministic Offers, and inventory consumption plans;
- ingredients, packaging, finished goods, lots, measured quantities,
  allocations, movements, stock policies, and derived balances;
- one Plan 20 goods receipt posted through `receive_inventory`;
- menus, modifier revisions, immediate recipes, preparation tickets, stocked
  recipes, production batches, and actual yield;
- first-party carts, exact checkout quotes, one quote-bound Stripe test payment
  attempt, immutable Orders, and allocation commit or transfer;
- pickup for the cafe configuration;
- one Japan-to-Singapore shipping route, one configured address, tax, duty, and
  carrier stack, one package, customs facts, label purchase, tracking, and
  delivery for ecommerce; and
- receipts, signed observations, projections, replay, interruption recovery,
  and one low-stock Case.

The following work remains outside Plan 22:

- Shopify storefront and parity demonstrations;
- additional routes, carriers, package splitting, and production tax, duty,
  address, payment, or carrier certification beyond the frozen route;
- local delivery, immediate handoff, and on-premise fulfillment;
- point-of-sale, marketplace, and agent-created Orders;
- returns, refunds, multiple tenders, subscriptions, promotions, loyalty, and
  gift cards;
- generalized count, waste, transfer, warehouse, replenishment, and demand
  planning workflows; and
- CafeOS pages beyond the controls required by the two scenarios.

## Required invariants

1. Underclerk is the sole commerce writer for the demonstration organisation.
   OrganisationActor remains a rebuildable projection.
2. Quantities are fixed precision, non-negative where accounted, and unit
   checked.
3. Accounted availability equals on-hand minus active allocations and remains
   non-negative.
4. A movement or allocation changes a position exactly once.
5. An accepted Order retains no Checkout-owned allocation.
6. A CheckoutPaymentAttempt binds one checkout revision, quote digest, amount,
   currency, provider request, and idempotency identity.
7. Accepted Order, modifier, recipe, inventory-requirement, carrier-rate,
   shipping, tax, duty, package, customs, and label facts are immutable
   snapshots.
8. Buyer identity, address data, raw payment, tax, duty, rate, label, and
   tracking responses, and payment secrets remain inside Underclerk.
9. Authoritative state, command receipt, and signed observation outbox entries
   commit atomically.
10. Duplicate delivery, retry, interruption, and replay converge to one
    authoritative outcome.

## Walking scenarios

Two machine-readable manifests own every stable identity, quantity, price,
currency, location, command, idempotency key, and expected terminal record.
Each implementation phase extends those fixtures instead of creating a parallel
test model.

### Scenario 1 — Cafe / Patisserie

1. A Plan 20 receipt adds lot-tracked oat milk to the cafe inventory.
2. A production batch consumes measured ingredients and creates one expiring
   lot of cookies with its actual yield.
3. The cafe publishes a menu containing one cookie and a latte.
4. A guest orders both, chooses a large latte, substitutes oat milk, and selects
   pickup.
5. Checkout snapshots the MenuEntry, Offers, modifier revisions, recipe
   revisions, measured requirements, price, tax, pickup promise, and exact
   allocations.
6. One Stripe test payment attempt authorizes the quote and placement creates
   one immutable Order.
7. Completing the PreparationTicket consumes espresso and oat milk once.
8. Pickup commits the cookie allocation and completes the Fulfillment.
9. Oat milk crosses its StockPolicy threshold and creates one Case.
10. Retry and replay create no duplicate lot, movement, allocation, payment,
    Order, cue, or Case.

### Scenario 2 — Online cookie store

1. The merchant publishes a box of six cookies in the ecommerce storefront.
2. The Offer resolves to six cookies from the produced lot plus one package.
3. A guest adds one box, enters a Singapore shipping address, and accepts the
   exact item, carrier rate, tax, duty, and total quoted for the
   Japan-to-Singapore route.
4. Checkout snapshots the package plan and customs facts for the six-cookie
   box.
5. One Stripe test payment attempt authorizes the quote and placement creates
   one immutable Order with one shipping Fulfillment.
6. Staff pack the package, obtain one fresh package-bound carrier label rate,
   purchase the label, and hand the package to the carrier.
7. Signed carrier tracking reaches delivered.
8. Satyr projects merchant-safe Order, Payment, Fulfillment, Shipment, and
   inventory facts without buyer PII.
9. Buyer-quote refresh, label-rate refresh, label purchase, handoff, tracking
   retry, and replay change no terminal result.

## Delivery rule

Each phase finishes one working path:

1. implement the authoritative state and command;
2. emit the receipt and signed observations;
3. project and expose the merchant-safe result;
4. prove the path through a public or operator API;
5. migrate or reset the affected cohort;
6. activate the replacement readers and writers; and
7. delete the superseded path, parser, fixture, and test.

There is no dual-write interval and no final omnibus migration. The final gate
runs the combined acceptance matrix over already accepted slices.

## Implementation sequence

### Gate — Close migration input and fixtures

Expose and run a read-only Underclerk migration dry run for every selected
merchant. The result contains storage and contract revisions, a deterministic
migration digest, counts by migrate/reset/reject classification, unresolved
identity or ledger mappings, invariant failure codes, and pending command,
lease, receipt, and outbox counts. It excludes record payloads, buyer data,
credentials, and signing material.

Join that result with the existing D1 and OrganisationActor inventory. Record one
reset-or-migrate decision per store. Create the two exact scenario manifests.

Exit gate: every retained store passes the dry run, every rejected field or
identity has an explicit treatment, no pending effect can be lost, and the
inventory-receipt fixture is executable.

### Phase 1 — Inventory and receiving

Implement:

- final Quantity, InventoryItem, InventoryPosition, InventoryMovement, and
  InventoryLot contracts;
- normalized Underclerk item, position, movement, and lot storage;
- typed `create_inventory_item`, `open_inventory_position`, and
  `receive_inventory` commands;
- atomic position, lot, movement, receipt, and signed outbox writes;
- OrganisationActor inventory migration, reducers, freshness, reconciliation, and
  merchant-safe queries; and
- Plan 20 receipt-effect dispatch and replay.

InventoryPosition carries `allocated = 0` until Phase 2. The migration dry run
rejects a retained position whose source facts cannot justify that value.

After the path passes, cut over the inventory cohort. Delete inventory use of
`upsert_resources`, `adjust_inventory`, obsolete inventory JSON, receipt-only
movement shapes, and tests that protect those paths.

Exit gate: an ingredient and a finished good reach Satyr views through typed
commands; the oat-milk receipt produces one lot, movement, position revision,
receipt, and observation cohort; replay converges; the accepted cohort has one
inventory write path.

### Phase 2 — Catalog, checkout, payment, and pickup

Implement:

- Location, Product, SellableVariant, SalesChannel, Storefront, Offer, and
  InventoryConsumptionPlan behavior required for one cookie;
- deterministic Offer and consumption-plan resolution;
- signed buyer session, Cart, Checkout, quote refresh, and availability APIs;
- InventoryAllocation hold, expiry, release, transfer, and commit;
- one quote-bound Stripe test payment attempt with decline and indeterminate
  reconciliation;
- immutable online Order and Payment records; and
- pickup Fulfillment.

Placement commits Order state, allocation ownership, payment attachment,
receipt, and signed observations in one local transaction. Punter uses only the
public buyer APIs.

After the path passes, cut over catalog, checkout, Order, Payment, and pickup
records. Delete the remaining `upsert_resources` command and the legacy
order-wide fulfillment shape.

Exit gate: a buyer discovers one cookie, pays, places one Order, and completes
pickup; stale quotes, allocation expiry, payment mismatch, duplicate placement,
and interrupted authorization reach deterministic typed outcomes; Satyr views
contain no buyer PII.

### Phase 3 — Cafe and patisserie operations

Implement:

- Menu, MenuSection, MenuEntry, modifier revision, immediate RecipeRevision,
  PreparationStation, and PreparationTicket;
- one large latte with oat-milk substitution;
- StockPolicy threshold crossing and one deduplicated low-stock Case;
- one stocked cookie RecipeRevision and ProductionBatch;
- one atomic production command that records actual yield, consumes inputs,
  creates the output movement, and creates one expiring output lot; and
- pickup of the prepared latte and produced cookie.

Add only the CafeOS controls required to receive stock, publish the menu, run
preparation and production, inspect linked receipts, and complete pickup. Reuse
Plan 21 page and accessibility foundations.

After Scenario 1 passes, cut over food-service observations, projections, and
readers. Delete the separate legacy Food Service observation stream and
obsolete recipe or preparation identities.

Exit gate: staff complete Scenario 1 through CafeOS and the buyer completes it
through the public storefront; production, preparation, movement, lot,
allocation, receipt, cue, and Case identities are traceable and replay safe.

### Phase 4 — Online cookie storefront

Extend the accepted model with:

- a second Storefront configuration over the same buyer application;
- an Offer for a box of six cookies and its packaging requirement;
- one Japan-to-Singapore shipping profile and physical shipping specification;
- protected address validation;
- one buyer shipping quote bound to the exact address and package inputs;
- exact tax, duty, package, and customs snapshots;
- one fresh carrier label rate bound to the Shipment revision and package-plan
  digest;
- typed, idempotent `purchase_shipping_label` through that label rate;
- shipping Fulfillment handoff; and
- signed carrier tracking through delivered.

Build the cafe configuration first, then extract the shared buyer shell and add
the ecommerce configuration. Both configurations use the same public Satyr
Commerce APIs.

After Scenario 2 passes, cut over shipping projections and readers.

Exit gate: the online cookie Order reaches delivered through the public
storefront and Punter; payment authorization, placement, buyer-quote refresh,
label-rate refresh, label purchase, handoff, tracking, and replay converge;
private addresses and raw provider responses remain inside Underclerk;
responsive, keyboard, loading, validation, and recovery checks pass for both
storefront configurations.

## Final acceptance

Run both scenarios against the accepted contract and deployed cohorts. Confirm
that every superseded authority path, compatibility parser, fixture, and legacy
test has been deleted.

Required repository checks:

```bash
pnpm --filter satyr-edge check:types
pnpm --filter satyr-edge check:test-types
pnpm --filter satyr-edge test
pnpm --filter satyr-edge test:commerce-lab
pnpm portal:build
cargo test --workspace
pnpm lab:reset
pnpm lab:seed
pnpm lab:scenario
pnpm lab:verify
git diff --check
```

Plan 22 is complete when both storefront configurations pass, both scenarios
converge under retry and replay, required organisation data is current, and release
evidence records the exact contract, authority, projection, command,
storefront, and migration revisions exercised.

## Completion evidence

Plan 22 completed all four implementation phases and the migration gate. The
accepted production cohort is organisation
`organisation_73db0a88-045d-4fce-a950-4a0c5b642a1b`, merchant
`merchant_nuki_cafe_demo`, at Underclerk schema 22. The audited cutover,
projection drain, Commerce Lab acceptance, public Punter runs, and exact
authority evidence are recorded in
[Plan 22 production acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-22-production-acceptance-2026-08-12.md).

The shared Underclerk Worker and both storefront configurations were deployed
at `https://underclerk.n6378056.workers.dev`. Storefront asset deployment
`4da75b6f-5766-47bd-99f8-120461ba88d8` served
`index-DntvjPaS.css` and `index-Mnb8DPxF.js`. Production carrier credentials
were rotated through Worker secret version
`84cfe91e-0d8a-4808-9d59-486f8af1f6c1`; no credential entered the repository
or acceptance output.

### Final browser run — Cafe / Patisserie

- Storefront path: `/store/cafe`
- Basket: one cookie and one large latte with oat milk
- Subtotal: JPY 1,250
- Tax: JPY 125
- Total: JPY 1,375
- Checkout: `checkout_640cfba33a3d389b533ca2901f563cb1c57d721606e9ce8dccd953226fb44e1a`
- Order: `order_fa62955662bb9554b568b85b8f5726bd5550bd423c096df54df5d50609b4c699`
- Preparation ticket: `preparation_ticket_browser_d50609b4c699`
- Terminal state: Order `fulfilled`, Fulfillment `completed`

The live buyer page displayed `Picked up` and Paid JPY 1,375. Staff used typed
PreparationTicket and pickup commands; the public storefront retained only its
buyer-safe session, quote, payment, and order views.

### Final browser run — Online cookie store

- Storefront path: `/store/shipping`
- Route: Japan to Singapore
- Item subtotal: JPY 3,600
- Shipping: JPY 2,200
- Duty: JPY 180
- Tax: JPY 522
- Total: JPY 6,502
- Checkout: `checkout_22e4823fb5f8351a0c9b7c13ff79640bf01a93ca6e862eafe2f2bc2f21d34ef2`
- Order: `order_6691f19c03216e0bb749067b1f4e1156557761fc15dd3a592ef82a786b7d99db`
- Shipment: `shipment_6691f19c03216e0bb749067b1f4e1156557761fc15dd3a592ef82a786b7d99db`
- Tracking: `JP-SG-F0DC5EBA0782`
- Terminal state: Shipment `delivered`, Order `fulfilled`

The live buyer page completed catalog discovery, the protected-address quote,
Stripe test payment, placement, and label-purchased polling. The matching
signed carrier handoff and delivery events advanced the same production order
to its terminal state at merchant revision 85. Protected address, label,
provider, and signing data remained inside Underclerk.

### Final release gates

The 2026-08-13 closure reran the storefront build, Underclerk client and
authority type checks, all 31 Underclerk tests, both Punter scenario tests,
platform production and test type gates, Portal build, workspace Rust check,
and `git diff --check`. All passed. The optimized Wasm build emitted the
existing missing-LICENSE advisory, and the Portal build emitted its existing
large-chunk advisory; neither gate failed.

Plan 22 is complete. Further commerce work belongs to a new plan and must stay
within the deferred scope listed above.
