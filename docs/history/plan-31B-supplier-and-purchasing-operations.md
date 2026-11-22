# Plan 31-B — Supplier and Purchasing Operations

Status: complete · verified 2026-08-29 · Date: 2026-08-27

Depends on:
[Plan 31-A — Commerce Entity Plane, Lists, and Views](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31A-commerce-entity-plane-lists-and-views.md),
[Plan 22 — Satyr Commerce Domain and Storefront Proof](plan-22-commerce-capabilities-and-storefront-demos.md),
[Plan 24 — CafeOS Bakery Automation](../plan-24-cafeos-bakery-automation.md),
and [Plan 16 — Merchant Console Commerce Operations](plan-16-merchant-console-commerce-operations.md)

## Outcome

Help a café or bakery keep ingredients and packaging available without
manually tracking suppliers, replenishment needs, and expected deliveries in
separate spreadsheets and messages.

CafeOS presents a **Supplier** and a **Supplier detail page**. `TradePartner`
may remain the underlying entity-plane type; it is not merchant-facing product
language.

## MVP

- A Supplier detail page with contact information, supplied items, lead time,
  and minimum order.
- A replenishment queue derived from current low-stock requirements, with the
  required quantity and its supporting stock and demand evidence.
- One published low-stock recipe that creates exactly one owned replenishment
  item for each active requirement.
- An internal purchase request with supplier, requested items and quantities,
  owner, status, and expected delivery date.
- Expected, late, partial, and received delivery states linked to existing
  inventory receipts and lots.
- Automatic closure of the replenishment item when accepted inventory receipts
  satisfy its requested quantities.

## Walking slice

Packaging stock falls below its policy threshold. CafeOS identifies the
configured supplier and required quantity, opens a replenishment item, lets an
operator review and record the purchase request and expected delivery, flags a
missed or partial delivery, and closes the item when the existing
`receive_inventory` path records enough accepted stock.

The operational loop is:

```text
low-stock requirement
  -> required quantity and evidence
  -> supplier and purchase request
  -> expected delivery
  -> late or partial exception when applicable
  -> accepted inventory receipt
  -> replenishment item closed
```

## Boundaries

- Supplier records and purchasing context cannot change canonical inventory or
  production facts.
- Inventory changes only through existing typed inventory commands and
  receipts.
- Purchase and delivery state derives from explicit operator actions and
  accepted receipts; diagnostics cannot silently advance it.
- The MVP records purchasing work. Automated ordering and supplier messaging
  require a later authorized effect path.

## Implementation structure

- `TradePartner` remains the shared entity-plane identity behind the
  merchant-facing **Supplier** name.
- A Supplier Directory Commerce List owns contact, lead-time, minimum-order,
  and purchasing-note fields without creating a second supplier identity.
- A `supplier_inventory_item` relationship records exactly which inventory
  items each supplier provides.
- A Replenishment Queue Commerce List owns the purchasing lifecycle for one
  StockPolicy requirement. Its evidence records available, reorder-point,
  target, required, and accepted-receipt quantities in the stock unit.
- The queue entry is the MVP purchase request. Its lifecycle advances through
  review, requested, expected, partial, late, and received states.
- The low-stock recipe reconciles from canonical StockPolicy, inventory
  position, supplier relationship, and accepted receipt-movement facts. It
  uses deterministic requirement identities so retries cannot open duplicates.

## Implementation checklist

### 31-B.1 — Purchasing preset and evidence model

- [x] Publish the Supplier Directory and Replenishment Queue through ordinary
      entity-plane schema/list/view commands.
- [x] Publish the `supplier_inventory_item` relationship definition.
- [x] Keep export-coordination and purchasing preset evidence independently
      addressable while sharing the `TradePartner` identity.

### 31-B.2 — Replenishment recipe

- [x] Open exactly one requirement when an active threshold StockPolicy is low
      and has one configured supplier.
- [x] Persist required quantity and its stock-policy evidence on the entry.
- [x] Advance expected requirements to late when their delivery date passes.
- [x] Record accepted receipt quantities, mark partial deliveries, and close
      the requirement only when receipts satisfy the requested quantity.
- [x] Emit normal entity-plane changes, observations, signed receipts, and
      outbox deliveries for every recipe mutation.

### 31-B.3 — Operator boundary

- [x] Add the Underclerk client and Platform routes for preset activation,
      supplier creation, requirement reconciliation, and purchase-request
      updates.
- [x] Enforce organisation, merchant, role, revision, authority, idempotency, and
      published-resource checks at the existing boundaries.

### 31-B.4 — CafeOS page

- [x] Add **Suppliers** to the Commerce navigation.
- [x] Show the Supplier Directory, Supplier detail, supplied inventory items,
      and the Replenishment Queue using the entity-plane reader.
- [x] Let an operator create a Supplier and move a requirement through the MVP
      purchase and delivery states.

### 31-B.5 — Acceptance

- [x] Prove the complete walking slice with one focused parity/acceptance test.
- [x] Pass contract, Underclerk, Platform, portal, commerce-lab, and diff
      verification gates.
- [x] Run the reset, seed, scenario, and verify field exercise against the
      configured remote commerce-lab organisation after explicit remote-mutation
      authorization.

## Progress notes

- **2026-08-29:** Implementation authorized. Chose Commerce Lists for Supplier
  profile and purchase-request context so canonical inventory remains unchanged
  and all purchasing work uses the existing entity-plane revision, receipt,
  observation, and query paths. `TradePartner` remains the sole supplier
  identity; no parallel supplier record or compatibility path will be added.
- **2026-08-29:** Implemented the purchasing preset, supplier creation through
  exact entity/list/relationship commands, evidence-backed replenishment
  reconciliation, accepted-receipt closure, late and partial states, durable
  projection-triggered reconciliation, scoped Platform control routes, and the
  CafeOS Suppliers page. Public purchasing resource IDs live once in the
  Underclerk client boundary and are reused across services and the browser.
- **2026-08-29:** Local acceptance passed: 896 Satyr contract tests, 73
  Underclerk tests, 1,298 Platform tests, 76 commerce-lab tests, Platform source
  and test type checks, the Portal production build, and `git diff --check`.
  The reset/seed/scenario/verify CLI initially stopped before mutation because
  the active target is remote and requires `--remote-yes`.
- **2026-08-29:** Remote mutation was authorized and the CLI reached the
  configured Worker. Reset returned `404 organisation_not_found`. A read-only remote
  D1 check confirmed the configured organisation has no organisation or onboarding record,
  and the database currently has no development organisation. The production organisation
  remained untouched. This established that the field exercise needed a new
  disposable development organisation.
- **2026-08-29:** Created disposable organisation
  `organisation_092dd397-716c-4cf3-a706-99add739565f` through the ordinary Portal
  bootstrap, classified only that new organisation as `development`, and completed
  the authorized remote reset, seed, `happy-order`, and verify sequence. Run
  `commerce_lab_run_happy-order_lab_happy_order_v1` settled ten signed provider
  events: Order revision 3 `fulfilled`, Fulfillment revision 2
  `handed_to_carrier`, Payment revision 1 `captured`, and Shipment revision 3
  `delivered`. Duplicate and unauthorized effect counts were both zero. The
  existing production organisation was not changed.

## Deferred

Supplier scoring, bidding, contract management, invoice matching, automatic
purchase orders, multi-supplier optimization, and a general procurement suite.

## Activation and acceptance

Activate after an organisation demonstrates repeated stock replenishment work across
at least one ingredient or packaging category. Accept when an operator can
move one real low-stock requirement from supplier selection through received
inventory without maintaining a parallel spreadsheet, and when the item closes
from receipt evidence rather than a manual completion flag.

## Portfolio sequence

1. [Plan 31-C — Ecommerce Operations Workbench](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31C-ecommerce-operations-workbench.md)

[Plan 29-C — Customer and Supplier Communications](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29C-customer-and-supplier-communications.md)
remains deferred in the Plan 29 mailbox family. Its direct operational email
path requires a later activation decision after Plans 33–35. The deleted
automation, reporting, canvas-authoring, and commerce-research proposals are no
longer part of the Plan 31 portfolio.
