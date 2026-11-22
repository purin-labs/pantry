# Plan 23 — Flavored Export Catalog

Status: **Complete — accepted on lab and production, closed 2026-08-18**
· Date: 2026-08-17 · Owners: Underclerk,
the buyer storefront application, and Punter · Depends on: Plans 20, 21,
and 22

## Goal

Replace the single assorted export product with a four-product flavored
export catalog — Sesame, Ginger, Taro, and Matcha packaged boxes — on the
existing Japan-to-Singapore shipping storefront, and prove it through one
public browser-level shipping journey.

This is a launch-enabling slice for the café and online store. The café
configuration already sells the four flavor families (sesame, ginger, taro,
and matcha drinks, cookies, and financiers) for pickup, while the online
store still lists exactly one "Six-cookie box" of assorted cookies. Launch
requires the online catalog to present the same flavor identity as the café:
a buyer chooses a flavor, and the package and customs facts for that exact
product travel with the order.

One catalog also serves both surfaces. A product or variant is
channel-neutral in the accepted domain model: it surfaces wherever an
active Offer places it on a SalesChannel, and Offer resolution is
deterministic per variant, channel, country, and location
(`docs/commerce-domain-architecture.md`, Offer). Plan 23 therefore
delivers surfacing as channel placement: one placement command marks a
product for the café channel, the export channel, or both, and each
surface adds only its own presentation requirement — a published menu
entry for the café, a physical shipping specification for export.

Plan 22 is complete and closed. Plan 23 reopens none of it; it extends the
accepted commerce authority, storefront shell, and frozen Japan-to-Singapore
route with new configuration and presentation only.

## Current state

Every phase below starts from this observed behavior:

- The shipping storefront is configured by one create-only command.
  `underclerk.configure-shipping-storefront.v1` carries exactly one
  `product`, `variant`, `offer`, `consumptionPlan`, and
  `shippingSpecification`, and rejects with `resource_already_exists` when
  the storefront already exists
  (`packages/bakery-model/src/index.ts`,
  `services/underclerk/src/commerce-authority.ts`
  `configureShippingStorefront`). There is currently no command that adds a
  further listing plus shipping specification to an existing shipping
  storefront: `underclerk.prepare-catalog-listing.v1` adds a
  product/variant/offer/consumption-plan to a sales channel but carries no
  shipping specification and rejects every already-existing catalog
  resource (`firstExistingCatalogResource`), so it can neither target a
  shipping storefront nor place an existing product onto a second channel.
- The one configured export product is `product_cookie_box` ("Six-cookie
  box", "Six assorted cookies shipped from Japan."), variant
  `variant_cookie_box_6` (SKU `COOKIE-BOX-6-SG`), offer
  `offer_cookie_box_sg` at JPY 3,600 on `channel_cookie_store_sg`, consumed
  as one `inventory_cookie_box_6` (lot-tracked, expiry required) plus one
  `inventory_shipping_carton` per box, with a physical shipping
  specification of 1,200 g, 280×220×100 mm, origin JP, HS code 190531,
  customs description "Six baked cookies in one retail box"
  (`services/underclerk/scripts/configure-plan22-phase4-shipping.ts`).
- The shipping checkout is already variant-keyed. The checkout plan resolves
  the commanded `variantId` against the storefront's sales channel, reads
  that variant's `VariantShippingSpecification`, and quotes through
  `quoteJapanToSingapore`, which derives the package weight, dimensions, and
  the single customs line from the specification
  (`services/underclerk/src/commerce-authority.ts` shipping checkout plan,
  `services/underclerk/src/japan-singapore-shipping.ts`). Adding correctly
  bound flavored variants therefore needs no quote-engine change.
- The shipping checkout is single-line: `BuyerShippingCheckoutCommand`
  carries one `cartLineId`, `checkoutLineId`, `variantId`, and `quantity`
  (`services/underclerk/src/commerce-authority.ts`). One order carries one
  product at a chosen quantity.
- The storefront presentation is hard-bound to the assorted box.
  `ShippingConfiguration` fixes `variantId: "variant_cookie_box_6"`,
  `shippingSelection` requires exactly one catalog listing with that
  variant, and `renderShippingCatalog` renders one product article with
  fixed copy and images plus the Singapore address form
  (`apps/storefront/src/storefront.tsx`). The buyer catalog read already
  returns a `listings` array, so the read side supports multiple listings
  today.
- The local seed and acceptance fixtures assert the single product.
  `services/underclerk/scripts/seed-local-commerce.ts` requires the
  `variant_cookie_box_6` listing, and the Punter shipping scenario asserts
  one variant, expected totals, and one customs line
  (`scripts/punter/src/shipping-scenario.ts`; the expectations moved to
  `scripts/punter/src/scenario-fixtures.ts` on 2026-09-28).

## Non-goals

Plan 23 excludes:

- reopening Plan 22 or altering any accepted Plan 22 record, invariant, or
  evidence;
- point-of-sale, marketplace, or agent-created Orders;
- inventory receipt redesign; flavored stock enters through the existing
  `receive_inventory` command exactly as the assorted box does today;
- new shipping routes, carriers, package splitting, or production tax,
  duty, address, payment, or carrier certification — the frozen
  Japan-to-Singapore route and test carrier stack remain as accepted;
- multi-line shipping carts or mixed-flavor boxes — one flavor per order
  remains the accepted checkout shape for this slice;
- returns, refunds, promotions, subscriptions, loyalty, and gift cards; and
- café storefront, menu, recipe, or production changes — both-surface
  placement is proven at the authority level in FX1; putting flavored
  boxes on the published café menu is deferred follow-up work.

## Dependencies

- Plan 22 (complete): the Underclerk commerce authority, typed inventory
  and shipping commands, the shipping storefront shell, the frozen
  Japan-to-Singapore quote and label stack, and the accepted production
  cohort (`merchant_nuki_cafe_demo`).
- Plan 21 (accepted foundations): storefront page, accessibility, and
  interaction conventions the catalog presentation must preserve.
- Plan 20 (active, untouched): `receive_inventory` remains the only stock
  entry path; Plan 23 only issues opening-stock receipts through it.

## Walking scenario

One machine-checkable scenario owns the stable identities, quantities,
prices, and expected terminal records. Phases extend this fixture rather
than creating a parallel test model.

1. The merchant configures four flavored export products — Sesame, Ginger,
   Taro, and Matcha boxes — on the existing
   `storefront_cookie_store_sg`, each with its own variant, offer,
   consumption plan, lot-tracked finished-good inventory item, and physical
   shipping specification bound to `shipping_profile_jp_sg`.
2. Opening stock for each flavored box and the shared shipping carton is
   received at `location_tokyo_fulfillment`.
3. A guest loads the public shipping storefront and sees all four flavored
   boxes with name, description, price, and availability.
4. The guest selects one flavor, sets a quantity, and enters a Singapore
   address.
5. Checkout snapshots the selected variant's offer, consumption plan,
   package plan, and customs facts; the customs line carries that flavor's
   declared description, weight, HS code, and declared value.
6. One Stripe test payment attempt authorizes the quote and placement
   creates one immutable Order with one shipping Fulfillment.
7. Label purchase, handoff, and signed tracking advance the Shipment to
   delivered, exactly as the Plan 22 route does today.
8. Retry and replay converge; the other three flavors remain listed and
   available throughout.

## Implementation sequence

### FX1 — Flavored export products and stock

Implement:

- one additive channel-placement command,
  `underclerk.place-channel-listing.v1`, that marks a product as surfaced
  on a sales channel: it accepts a new or an existing product and variant,
  requires an offer for the target channel, requires a consumption plan
  only when the product is new, and requires a physical
  `VariantShippingSpecification` bound to the storefront's active shipping
  profile whenever the target channel's storefront fulfills by shipping
  (the existing `configure-shipping-storefront.v1` and
  `prepare-catalog-listing.v1` stay unchanged);
- four flavored products and variants (working identities:
  `product_sesame_box` / `variant_sesame_box_6`, and likewise for ginger,
  taro, and matcha), each with an offer on `channel_cookie_store_sg` —
  Sesame and Ginger at JPY 3,600 matching the accepted assorted box, Taro
  at JPY 3,800, and Matcha at JPY 4,200, so per-flavor totals stay
  distinguishable in every downstream assertion;
- four lot-tracked, expiry-required finished-good inventory items with
  positions at `location_tokyo_fulfillment`, consuming one box plus one
  existing `inventory_shipping_carton` per unit with
  `commitOn: "fulfillment_completed"`, mirroring the accepted assorted-box
  consumption plan; and
- opening-stock receipts through the existing `receive_inventory` command,
  plus a configuration script following the
  `configure-plan22-phase4-shipping.ts` conventions (idempotency keys,
  expected-revision stepping, readback verification) and a
  `seed-local-commerce.ts` update that seeds and asserts all four listings.

Exit gate: the merchant snapshot lists four flavored variants with
available offers and accounted stock; replaying the configuration script
creates no duplicate resource; placing an already-listed variant onto a
second channel converges without duplicating catalog resources; existing
assorted-box records are untouched.

- [x] Channel-placement command is typed, validated, idempotent, and
      covered by authority tests for new and existing products.
- [x] Authority tests prove one variant can hold active offers on the
      café and export channels simultaneously, each resolving
      deterministically on its own channel.
- [x] Four flavored products, variants, offers, consumption plans,
      inventory items, positions, and opening lots exist and read back.
- [x] Local seed publishes and asserts all four flavored listings.
- [x] Replay of every configuration command converges without duplicates.

### FX2 — Package and customs bindings per product

Implement:

- one physical shipping specification per flavored variant bound to
  `shipping_profile_jp_sg`, each carrying its own measured weight,
  dimensions, country of origin, HS code, and a flavor-specific customs
  description (for example "Six black sesame cookies in one retail box");
  and
- authority test coverage proving that a shipping checkout for each
  flavored variant quotes from that variant's specification: the package
  plan weight scales from the flavor's unit weight and the single customs
  line carries the flavor's description, HS code, and declared value.

No quote-engine change is expected: the checkout plan already resolves the
specification by variant, and `quoteJapanToSingapore` already derives the
package and customs snapshot from the specification it is handed.

Exit gate: for each of the four flavors, a checkout quote snapshot binds
that flavor's exact package and customs facts, and a variant without a
specification is rejected with the existing
`checkout.shippingEligibility` outcome.

- [x] Four variant shipping specifications are stored and read back at the
      exact variant and profile revisions.
- [x] Per-flavor quote tests assert package weight and customs
      description, HS code, and declared value.
- [x] A misbound or missing specification still rejects deterministically
      (the placement command makes a missing binding unrepresentable
      through supported commands; the `checkout.shippingEligibility`
      guard remains as defense in depth).

### FX3 — Storefront catalog presentation

Implement:

- a catalog view on `/store/shipping` that renders every available listing
  from the buyer catalog read — name, description, price, availability,
  and image — replacing the hard-bound single-product article;
- flavor selection that carries the chosen variant into the existing
  single-line basket, quantity stepper, and Singapore address form without
  changing the checkout, quote, payment, or order views; and
- sold-out presentation for an unavailable flavor that leaves the other
  flavors purchasable.

The storefront keeps the accepted Plan 21/22 interaction contract:
responsive one-column reflow, keyboard and focus behavior, labeled native
controls, and recovery-oriented errors.

Exit gate: with the four flavored offers published, the public page shows
four products; selecting each flavor produces a quote whose line, package,
and customs facts match that flavor; an unavailable flavor renders as sold
out without blocking the rest.

- [x] `ShippingConfiguration` no longer hard-codes one variant; selection
      is data-driven from the catalog read.
- [x] All four flavored listings render with price and availability
      (verified in the browser beside the assorted box).
- [x] Sold-out and empty-catalog states render and recover (fixture-driven
      browser journeys: disabled sold-out control beside purchasable
      boxes, stale-selection fallback, and empty-catalog recovery through
      Check again — `pnpm frontend:journeys`).
- [x] Responsive, keyboard, loading, validation, and focus checks pass on
      the updated page (keyboard selection, first-invalid-field focus,
      and desktop plus mobile viewport fit in the same journeys).

### FX4 — Public shipping journey acceptance

Implement:

- one Punter scenario extension (or parallel fixture) that walks a
  flavored box — proposed: the Matcha box — from catalog read through
  quote, payment, placement, label purchase, handoff, and signed tracking
  to delivered, asserting the flavor's exact totals and customs line; and
- one browser-level public journey over the same flavored product on the
  built storefront, following the Plan 22 storefront browser acceptance
  procedure — accepted on the local lab stack first, then on the accepted
  production cohort (`merchant_nuki_cafe_demo`), matching the Plan 22
  production acceptance precedent.

Exit gate: the flavored Order reaches delivered through the public
storefront and Punter; quote refresh, label-rate refresh, duplicate
placement, tracking retry, and replay converge; the remaining three
flavors stay listed and available after the journey.

- [x] Punter flavored-box scenario passes with exact expected totals and
      customs facts (lab run `plan23_fx4_local_001`; production run
      `plan23_fx4_production_001`).
- [x] Browser journey completes catalog → flavor selection → address →
      quote → test payment → placement → delivered (lab and the
      deployed production storefront, order reference V-98).
- [x] Convergence checks (refresh, retry, replay, duplicate placement)
      pass unchanged.
- [x] Evidence document is recorded (see below).

## Evidence

Following `docs/evidence/` conventions
(`plan-22-storefront-browser-acceptance-2026-08-12.md`,
`plan-22-production-acceptance-2026-08-12.md`), Plan 23 closure records:

- `docs/evidence/plan-23-flavored-catalog-acceptance-<date>.md` — the
  configured identities and revisions, per-flavor offer prices, the
  browser journey's exact quote (item subtotal, shipping, duty, tax,
  total), checkout, order, shipment, and tracking identities, terminal
  states, and the verification command list; and
- the configuration script output (merchant revision before and after,
  listing and position readbacks) for the environment the slice is
  accepted on.

No buyer PII, protected address, raw provider response, or credential
enters the evidence, matching the Plan 22 records.

## Final acceptance

Run the walking scenario against the accepted configuration. Required
repository checks:

```bash
pnpm underclerk:check
pnpm underclerk:test
pnpm --filter @lowerarchy/punter test
pnpm storefront:build
git diff --check
```

Plan 23 is complete when all four flavored listings are configured with
per-product package and customs bindings, the public catalog presents them,
one flavored public shipping journey reaches delivered with converging
retries and replay, and the evidence document records the exercised
identities and revisions.

- [x] FX1 accepted
- [x] FX2 accepted
- [x] FX3 accepted
- [x] FX4 accepted (lab and production cohort journeys delivered)
- [x] Evidence recorded and linked from this plan:
      [plan-23-flavored-catalog-acceptance-2026-08-17](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-23-flavored-catalog-acceptance-2026-08-17.md),
      [plan-23-production-acceptance-2026-08-17](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-23-production-acceptance-2026-08-17.md)

## Resolved defaults (2026-08-17)

The six review questions closed with these defaults:

1. **Assorted box stays.** `variant_cookie_box_6` remains listed beside
   the four flavors; none of its records change.
2. **Command shape.** A dedicated additive placement command,
   `underclerk.place-channel-listing.v1`, as specified in FX1. Because it
   accepts existing products, it is also the mechanism that marks one
   product as surfaced on the café channel, the export channel, or both.
3. **Pricing.** Sesame JPY 3,600 and Ginger JPY 3,600 (matching the
   accepted assorted box), Taro JPY 3,800, Matcha JPY 4,200. The premiums
   reflect ingredient cost, and distinct per-flavor totals keep the
   acceptance assertions sensitive to cross-flavor binding mistakes.
4. **One flavor per order ships.** The single-line checkout stays;
   mixed-flavor orders remain a non-goal for this slice.
5. **Acceptance.** The Matcha box walks FX4 on the local lab stack first,
   then on the accepted production cohort (`merchant_nuki_cafe_demo`),
   matching the Plan 22 precedent.
6. **Imagery.** Launch reuses the existing gift-box and cookie
   photography with flavor-specific copy and alt text; per-flavor box
   photography is follow-up content work and gates nothing.
