---
title: Commerce operations
description: The accepted café, patisserie, packaged-goods, and flavored export operating paths.
---

# Commerce operations

Purin Pantry supports two connected configurations: a café and patisserie operation,
and an online packaged-goods storefront. Plan 23 extends the storefront with
flavored products and Japan-to-Singapore export facts.

## Café and patisserie

The prepared-food path combines:

- locations with inventory, preparation, pickup, or fulfillment roles;
- products and sellable variants;
- menus, modifiers, and published offers;
- recipes, preparation tickets, and production batches;
- stock receipts, counts, waste, allocations, and movements;
- carts, checkout, payment, orders, and pickup fulfillment; and
- governed operator actions with exact revisions and receipts.

## Packaged-goods storefront

The online path adds:

- a first-party storefront and sales channel;
- market- and location-aware offers;
- one-package international shipping;
- destination customs facts;
- carrier rate, tax, and duty quotes;
- label purchase and tracking; and
- fulfillment and payment reconciliation.

## Operating invariants

| Invariant           | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| One authority       | One selected commerce system is authoritative for an organisation and environment.       |
| One writer          | Each accepted transition has one named transactional writer.                             |
| Immutable agreement | Checkout produces an order snapshot; mutable cart intent does not leak into order state. |
| Stock ledger        | Movements and allocations are authoritative; balances are derived.                       |
| Explicit capability | Provider gaps remain typed and visible in readiness, action, and projection paths.       |
| Replayable evidence | Provider observations, action receipts, and Case events can rebuild the read path.       |

## Provider boundary

Pantry normalizes provider responses into merchant-native contracts. A provider
never writes the platform projection directly. Accepted actions carry the
organisation, authority revision, resource revision, policy decision, approval, and
idempotency identity required to reconcile a receipt.

See [Commerce domain](/concepts/commerce-domain) for the aggregate model and
[Testing and evidence](/operate/testing-and-evidence) for the commerce lab
path.
