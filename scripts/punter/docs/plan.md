# Punter

Last reviewed: 2026-08-31 · Status: implemented acceptance client

Punter is a synthetic buyer and external acceptance client. It proves that a
real buyer can discover a product through the supported storefront, complete
checkout, receive fulfillment state, and produce receipts that reconcile with
Underclerk.

## Boundary

Punter uses the same authenticated or public storefront APIs available to a
real client. It receives no database access, private service hooks, or Satyr
operator credentials.

## Implemented scenarios

```text
café catalog + menu
  -> two-line cookie and oat-latte pickup Cart
  -> refreshed quote
  -> one external test payment
  -> payment-session and reconciliation replay
  -> order recovery through preparation and pickup status
  -> completed pickup

Japan domestic cookie listing
  -> two-line domestic Japan shipping quote with duty not applicable
  -> one external test payment
  -> payment-session and reconciliation replay
  -> recovered carrier tracking
  -> delivered order

Japan-to-Singapore cookie listing
  -> two-line export shipping quote with package and customs evidence
  -> one external test payment
  -> payment-session and reconciliation replay
  -> label, tracking, and carrier status
  -> delivered order
```

## Checks

- Product, price, and availability agree with the authoritative revision.
- Checkout and payment are idempotent.
- Payment-session and reconciliation replays return the original payment and
  Order identity.
- The order records the expected origin, buyer branch, lines, totals, and
  fulfillment method.
- Pickup and shipping status remain monotonic through their terminal states.
- An order-scoped recovery capability reloads the same Order after the buyer
  session is no longer needed.
- Satyr observes the resulting state without becoming transaction authority.
- Routine runs use provider test mode. A real purchase requires explicit human
  invocation.

Punter remains an internal harness. The consumer product surface is the shared
browser storefront in `apps/storefront`; both clients exercise the same public
Underclerk contract.
