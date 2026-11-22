# Plan 33 — Merchant-Configurable Production Checkout

Status: **implementation complete** · external GA certification pending
· local closure verified 2026-09-03

Update (2026-11-14): Plan 80 step 5 part B (released 2026-10-28) deleted Satyr's
café payment path and the certifications that the GA gate below names. Payments
run in Underclerk ([Plan 80](plan-80-underclerk-multi-tenant-backend.md), D17).
The new live-payment gate is an owner decision; production Stripe is in test mode.

Depends on:
[Plan 19 — Organisation Commerce System](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-19-organisation-commerce-system.md),
[Plan 22 — Satyr Commerce Domain and Storefront Proof](plan-22-commerce-capabilities-and-storefront-demos.md),
[Plan 23 — Flavored Export Catalog](plan-23-flavored-export-catalog.md),
[Plan 31-A — Commerce Entity Plane](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31A-commerce-entity-plane-lists-and-views.md),
[Plan 31-C — Ecommerce Operations Workbench](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31C-ecommerce-operations-workbench.md),
and [Refactor 2 — Statically Compiled Integration Adapters](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-2.md).

## Outcome

CafeOS merchants publish a versioned checkout profile and sell a one-time
order without writing code. A buyer can choose supported pickup or shipping,
review the complete quote, make one external payment, and recover the same
checkout or placed order after a reload or interrupted request.

Underclerk remains authoritative for Cart, Checkout, Payment, Order,
Fulfillment, and Shipment. Provider adapters execute external effects through
narrow provider-neutral bindings and return validated observations. An accepted
transaction keeps one normalized immutable aggregate: the Order origin pins the
Checkout and profile revision, the accepted Checkout keeps protected contact and
complete quote evidence, and the captured payment attempt keeps the exact
payment binding and provider facts. Their identities and digests must agree.

## General-availability promise

The first generally available checkout supports:

- merchant-configured one-time purchase profiles with immutable published
  revisions;
- guest contact and identified-customer contact where the configured account
  boundary supports it;
- multi-line carts and multi-line café pickup;
- supported domestic Japan shipping and Japan-to-Singapore export shipping;
- carrier, tax, and duty quote evidence shown before payment, including the
  package, customs, service, currency, and expiry facts used to calculate the
  total;
- exactly one external online payment through a provider-neutral binding, with
  no provider fallback;
- idempotent cart, quote, payment-session, reconciliation, cancellation,
  refund, and recovery operations;
- an immutable, normalized Order/Checkout/Payment commercial aggregate;
- pickup preparation and completion, shipping label and carrier tracking, and
  delivery status; and
- merchant-safe receipts, order recovery, audit evidence, monitoring, and
  security controls.

Cancellation and basic full or partial refund remain in this plan. Future
extensions are documented separately and remain outside the general-availability
gate. [Plan 33C — POS Systems](plan-33C-POS-systems.md) owns provider
connection, terminal pairing, card-present payment, verified payment
observations, and physical-device certification.

The 2026-09-05 [P33C review amendments](plan-33C-POS-systems.md) extend shared
commerce boundaries through an exact POS source and published configuration
branch. Online profile, storefront, contact, and buyer-session requirements
remain required in the online branch. POS Cart, quote, and placement resolve
their own pinned commercial configuration, including the existing cancellation
and refund policies, without requiring an online storefront. P33C initially
uses the existing pickup lifecycle with explicit operator handover; capture
transfers inventory allocations and pickup completion consumes them.

P33C owns implementation and verification of submission-unknown, late-capture,
and captured-but-unplaced recovery for the terminal path. Reuse shared Payment,
refund, persistence, and receipt machinery, including a governed refund of an
exact captured Payment when Order placement cannot complete. Deadline expiry
prevents new terminal collection; it cannot erase provider money movement or
release allocations while submitted collection can still capture. Plan 33C records the accepted
Sandbox implementation. [Plan 33D](plan-33D-square-release-acceptance.md)
retains the separate release gates. The
[completion record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-33BC-completion-record.md) preserves implementation evidence.

## Authoritative boundaries and invariants

### Merchant configuration

`CheckoutProfile` is a closed, typed configuration with one immutable
published revision at a time. It contains only supported data and references:

- buyer contact and optional identified-customer policy;
- cart line and quantity limits;
- pickup locations and supported shipping routes;
- pricing, tax, duty, carrier-rate, package, and quote-expiry policies;
- one online payment binding; and
- cancellation and refund governance plus presentation, terms, privacy, and
  support policy.

Draft, published, and retired profile-revision lifecycle branches are parsed at
the boundary. Storefront activation is a separate typed assignment because one
published revision may serve multiple storefronts. A storefront, buyer session,
Cart, Checkout, and Order origin carry the exact profile reference used to plan
the transaction. The payment attempt binds the exact Checkout revision and quote
digest. A new activation affects new sessions only.

### Quote and Order evidence

The quote is immutable once accepted for payment. It records every Cart line,
quantity, unit amount, subtotal, tax, duty, shipping amount, total, currency,
carrier service, package plan, customs facts, destination validation reference,
and expiry. Domestic routes omit duty evidence; export routes include the
declared value, origin, classification, duty terms, package, and carrier quote.

The accepted Checkout retains the quote evidence. The Order origin retains the
Checkout and profile reference, while the captured payment attempt retains the
payment binding and provider observation. Fulfillment and Shipment revisions may
advance lifecycle state while preserving this normalized aggregate. No later
profile activation or quote refresh can rewrite accepted commercial evidence.

### Payment and recovery

Each Checkout selects one merchant-authorized online `PaymentBinding` with an
exact provider, environment, currency, and capability revision. The adapter
port covers collection, provider confirmation, inquiry/reconciliation,
cancellation or refund, and verified observations. The core receives only the
closed provider-binding contract and validated observations, and never changes
to another binding after an error. The `in_person` contract seam remains for
the POS system owned by
[Plan 33C — POS Systems](plan-33C-POS-systems.md) and is not publishable
through Plan 33.

Payment commands bind the Checkout revision, quote digest, amount, currency,
merchant authority, and idempotency key. Replays return the original session,
attempt, Order, or provider outcome. An indeterminate provider result remains
recoverable through reconciliation; a retry never creates a second payment or
Order.

Cancellation is available before fulfillment where the merchant policy allows
it. Full and partial refunds use the original captured external payment and
record the exact amount, reason, provider reference, and idempotency identity.
Provider uncertainty, duplicate commands, and interrupted workers resolve to
one durable result.

### Privacy, authorization, and execution

Raw contact values, access tokens, postal addresses, and provider credentials
stop at their owning boundary. Core records retain protected references,
validation references, and digests. Merchant and organisation identity, profile
revision, Order identity, and payment authority must agree before any external
effect. Signed commands, receipts, webhook observations, audit records, and
replay checks protect every money-moving transition.

Checkout profiles contain no executable merchant code. Calculation and
provider behavior come from compiled contracts and registered adapters.

## Phase structure

### P33-0 — Scope and contract lock

Define the provider-neutral profile, Cart, Checkout, quote, Payment, Order,
Fulfillment, Shipment, cancellation, refund, and recovery contracts. Remove
fixed-checkout assumptions from the active path and establish boundary parsers,
typed lifecycle unions, idempotency identities, and protected evidence rules.

Exit gate: invalid profile, contact, fulfillment, quote, payment, and refund
states fail at compile time or at their single request/persistence boundary.

### P33-1 — Merchant profile publication and activation

Deliver the portal and control-plane lifecycle for draft, replacement,
publication, activation, and retirement. Persist immutable profile revisions,
require a published revision before activation, and pin the active revision
into new buyer sessions.

Exit gate: an activation cutover changes new sessions while an in-flight Cart,
Checkout, and Order continue to resolve their original profile revision.

### P33-2 — Buyer identity, Cart, and pickup checkout

Expose public session, catalog, Cart, pickup Checkout, quote refresh, payment
session, reconciliation, and Order recovery APIs. Accept guest contact and the
supported identified-customer branch, preserve multiple Cart lines, and expose
the complete pickup quote before payment.

Exit gate: the café Punter path creates a multi-line pickup Cart, refreshes it,
replays the payment operation, recovers the Order, and observes pickup
completion without duplicate effects.

### P33-3 — Domestic and export shipping

Implement supported Japan domestic and Japan-to-Singapore shipping route
bindings. Validate destinations, create deterministic package plans, obtain
carrier-rate, tax, and duty evidence, and bind those facts to the quote digest
and accepted Order. Keep unsupported destinations closed.

Exit gate: Punter places a domestic Japan shipment and a Japan-to-Singapore
export shipment, each with multiple Cart and Checkout lines, a refreshed
quantity and destination, exact quote evidence, and a stable recovered Order;
export evidence includes customs and duty while domestic evidence records duty
as not applicable.

### P33-4 — Provider-neutral online payment and interruption recovery

Certify each supported online payment binding with merchant-scoped authority.
Resolve provider success, decline, processing, and
indeterminate outcomes through one payment-attempt ledger and one
reconciliation path. Persist enough session and Order recovery state to resume
after browser, worker, or provider interruption.

Exit gate: a payment-session replay and a reconciliation replay return the same
attempt and Order; an uncertain provider response never authorizes a second
charge.

### P33-5 — Fulfillment, Shipment, and tracking

Advance pickup preparation/completion and shipping ready/label/in-transit/
delivered states through typed, authorized operations. Persist carrier and
tracking observations, preserve Order identity, and expose merchant-safe buyer
status and receipt views.

Exit gate: pickup completion and shipping delivery each settle exactly once,
and tracking replay cannot regress or fork the Shipment state.

### P33-6 — Cancellation and basic refunds

Add an order-scoped cancellation command and durable refund attempt. Support
full cancellation and full or partial refund amounts against the original
external payment, with exact authorization, provider idempotency, interruption
recovery, and terminal receipts.

Exit gate: one unfulfilled Order can be cancelled and fully refunded; one
captured Order can receive an exact partial refund; retries and provider
uncertainty preserve one refund result and release reserved inventory once.

### P33-7 — Operations, security, and certification

Retain correlation IDs and durable audit evidence across profile, quote,
payment, reconciliation, fulfillment, tracking, cancellation, refund, and
recovery operations. The focused payment readback reports authority and
certification state, payment lifecycle counts, overdue indeterminate attempts,
and expired collection sessions. Complete organisation isolation, secret handling,
signed ingress, webhook verification, least-privilege authorization, PII
minimization, and incident runbooks.

Certify every published binding in its supported sandbox and live environment
with merchant-scoped credentials. The matrix covers currency and region,
online or device flow, success and failure, interruption, duplicate delivery,
reconciliation, cancellation, refund, and receipt evidence. A binding is
publishable only after its declared matrix passes.

Exit gate: the complete acceptance matrix passes in a disposable environment,
the operational readback is reviewable, and each live binding has a recorded
certification packet.

## Implementation status

Verified implementation phase gates:

- [x] P33-0 — scope and contract lock
- [x] P33-1 — merchant profile publication and activation
- [x] P33-2 — buyer identity, Cart, and pickup checkout
- [x] P33-3 — domestic and export shipping
- [x] P33-4 — provider-neutral online payment and interruption recovery
- [x] P33-5 — Fulfillment, Shipment, and tracking
- [x] P33-6 — cancellation and basic refunds
- [x] P33-7 — operations, security, and certification infrastructure

The merchant and buyer operating path is now closed locally. Portal users can
create a new draft from a published profile, edit it, publish it, and activate
it. New buyer sessions receive the exact active profile configuration through
the strict `buyer-session.v4` boundary. Storefront contact requirements,
presentation, fulfillment fencing, and pre-payment shipping evidence come from
that pinned configuration. Accepted Checkouts retain protected contact and
quote evidence, captured payment attempts retain provider evidence, and the
Order origin binds both to the exact profile revision without duplicating the
aggregate.

P33-7 runtime enforcement is complete: the exact current payment binding must
have an immutable matrix packet before Platform mints payment authority or
publishes/activates its checkout profile. The authenticated operational
readback reports the candidate binding, certification state, payment lifecycle
counts, overdue indeterminate attempts, and expired collection sessions without
exposing credentials or capabilities. Follow
[`runbooks/cafe-payment-certification.md`](../runbooks/cafe-payment-certification.md).
Credentialed Stripe sandbox and production packets remain the external GA
release gate. They require deployed organisation access and merchant-scoped provider
credentials; they are operational evidence rather than unfinished code.

- [x] immutable certification persistence and exact capability-revision gate
- [x] certified-only profile publication and activation
- [x] organisation-scoped operational readback and incident procedure
- [x] signed authority, webhook, vault-purpose, cross-organisation, replay, mismatch,
      refund, and reconciliation security suites
- [x] deployed acceptance harness binds recovered Order and Payment identities
      to validated merchant-safe Slack receipt evidence
- [ ] merchant-scoped Stripe sandbox matrix packet
- [ ] merchant-scoped Stripe production matrix packet

Local closure verification completed on 2026-09-03:

- Punter typecheck and 5 scenario tests passed;
- Storefront typecheck, production build, and 27 tests passed;
- Underclerk typecheck and 132 tests passed;
- Platform production and test typechecks passed;
- 37 focused profile, payment, adapter, observation, and authority tests passed;
- 77 commerce-lab and queue-recovery tests passed;
- Portal production build and both acceptance-script tests passed; and
- `git diff --check` passed.

## Acceptance matrix

The focused external-buyer evidence is owned by Punter:

1. **Café pickup** — guest checkout with two Cart lines, quote refresh, one
   external payment, payment replay, Order recovery, preparation, and pickup
   completion.
2. **Japan domestic shipping** — supported domestic route with multiple Cart
   and Checkout lines, quantity and destination refresh, carrier and tax quote
   evidence, duty-not-applicable evidence, payment, and recovered tracking
   through delivery.
3. **Japan-to-Singapore export** — supported export route with multiple Cart and
   Checkout lines, quantity and destination refresh, package and customs
   evidence, tax and duty quote evidence, payment, carrier tracking, and
   delivery.
4. **Interrupted order recovery** — payment-session and reconciliation replay,
   browser/session reload, provider-indeterminate recovery, and exact
   identity, amount, quote, and Order preservation.

The Underclerk and Platform suites additionally prove profile lifecycle,
boundary parsing, provider certification, authorization, cancellation, full
refund, partial refund, inventory release, webhook verification, monitoring,
and audit evidence.

## Implementation surface

The focused Punter harness consists of:

- [`scripts/punter/src/pickup-scenario.ts`](../../scripts/punter/src/pickup-scenario.ts)
  for café pickup (its journey runs in
  `services/underclerk/tests/punter-acceptance.test.ts`);
- [`scripts/punter/src/shipping-scenario.ts`](../../scripts/punter/src/shipping-scenario.ts)
  and [`scripts/punter/tests/shipping-scenario.test.ts`](../../scripts/punter/tests/shipping-scenario.test.ts)
  for domestic and export shipping; and
- [`scripts/punter/src/payment.ts`](../../scripts/punter/src/payment.ts) for
  shared payment-session, reconciliation, and replay behavior.

The authoritative contracts and runtime remain in Contracts, Underclerk, Urk,
the Commerce Read Layer, Scrutineer, Punter, and Platform according to the
repository boundaries in the root developer guide. This plan changes no public
origin, OAuth callback, or Worker name.

## Scope owned by follow-on plans

- [Plan 33C — POS Systems](plan-33C-POS-systems.md) owns POS provider
  connection, live in-person terminal payment, verified payment observations,
  and device certification. Provider-owned catalog, order, and inventory
  synchronization, cash-drawer control, and offline Satyr order entry remain
  outside that plan.
- Marketplace payments and multi-merchant carts.
- Arbitrary worldwide routes, currencies, and FX.
- Retail returns/RMA.

## GA exit gate

Plan 33 is complete when a merchant can publish and activate a checkout profile
without code; a buyer can complete the café pickup, domestic shipping, and
Japan-to-Singapore export paths with one external payment; quote, tax, duty,
carrier, payment, Order, fulfillment, and tracking evidence is immutable and
recoverable; cancellation and full/partial refunds settle exactly once; and
monitoring, security, authorization, privacy, audit, and provider
certification evidence is reviewable.

## Checks

Run the narrowest checks first:

```bash
pnpm --filter @lowerarchy/punter check:types
pnpm --filter @lowerarchy/punter test
pnpm --filter satyr-edge exec vitest run tests/cafe-payment-live.acceptance.test.ts
git diff --check
```

For the full commerce change, also run the Underclerk, Platform, portal, and
commerce-lab checks listed in the repository developer guide. Run
`pnpm cafe:accept` only with the complete disposable Stripe, Slack, fault, and
organisation credential set described in the certification runbook.
