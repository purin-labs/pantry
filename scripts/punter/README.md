# Punter

Monorepo component: `scripts/punter`

**Punter buys.** The synthetic buyer: an ordinary paying customer, simulated
— sent through the whole system to see if it holds. Punter discovers products
through the supported storefront, checks out through Commerce in Stripe test
mode, and verifies orders, fulfillment, settlement, and receipts. It is the
stack's end-to-end test harness and reference independent client.

Punter is a scripted shopping agent and reference public-API client. Sous Chef is
the merchant agent running inside Platform. Contracts live in shared packages;
Punter has no private commerce database or runtime access.

Status: café pickup and Japan-to-Singapore export shipping acceptance paths
are implemented; the shared shipping runner also exposes the domestic Japan
scenario. See [docs/plan.md](docs/plan.md).

## Layout

- `src/` — public storefront acceptance scenarios and harness CLI
- `tests/` — controlled public-API buyer journeys
- `docs/` — plan

## Standing rules

- Supported storefront APIs only. A private database hook fails the test.
- No real money without explicit human invocation; routine runs use Stripe
  test mode and test-marked records.

## Pickup acceptance

Run the first public buyer scenario against an already seeded Commerce
storefront:

```bash
PUNTER_COMMERCE_BASE_URL=https://commerce.example \
PUNTER_MERCHANT_ID=merchant_cafe \
PUNTER_STOREFRONT_ID=storefront_cafe \
PUNTER_RUN_ID=acceptance_001 \
pnpm --filter @purin-labs/punter scenario:pickup
```

The command uses only signed buyer sessions and public catalog, checkout, quote
refresh, configured test-payment, and order-status APIs. It adds oat milk by
refreshing the same checkout before payment. Placement returns an order-scoped
recovery capability. It replays the payment-session and reconciliation
commands before using that capability for every status read through pickup
completion. The command prints one structured evidence record and exits
unsuccessfully if any boundary fails.

## Online cookie shipping

Run the Japan-to-Singapore buyer scenario against the online cookie storefront:

```bash
PUNTER_COMMERCE_BASE_URL=https://commerce.example \
PUNTER_MERCHANT_ID=merchant_plan22_demo \
PUNTER_STOREFRONT_ID=storefront_cookie_online \
PUNTER_RUN_ID=shipping_acceptance_001 \
pnpm --filter @purin-labs/punter scenario:shipping
```

This runner uses only the public session, catalog, shipping-checkout, quote
refresh, payment, and order-recovery APIs. It first quotes one box, then edits
the quantity and address by refreshing the same checkout revision chain before
paying the replacement quote. Set `PUNTER_SHIPPING_SCENARIO=domestic_japan` for
the supported domestic route. It replays payment-session and reconciliation,
then uses the order-scoped capability after the buyer session is no longer
needed. Label purchase and carrier tracking remain staff-side operations in the
Commerce test harness.

## Real-backend acceptance

`services/commerce/tests/punter-acceptance.test.ts` runs both CLIs against a
disposable Commerce backend: the real HTTP API and SQLite store with the
deterministic payment gateway and Japan carrier stub, seeded by
`seed-local-commerce.ts` at 2026-08-14T10:00Z. Merchant staff bake the sesame
cookies, prepare and hand over the pickup, and buy the label and record carrier
events as Punter polls. `PUNTER_PICKUP_SCENARIO=local_cafe` and
`PUNTER_SHIPPING_SCENARIO=local_online_cookie` select expectations pinned to
that backend and its run IDs. The other scenarios describe controlled API
responses and do not match a real backend.

```bash
PUNTER_ACCEPTANCE_ARTIFACT_DIR="$PWD/output/acceptance/refactor-7/punter-real-backend" pnpm --filter @purin-labs/commerce-worker exec vitest run tests/punter-acceptance.test.ts
```

Each run writes Punter's evidence, the staff actions with their mutation
receipts, the resulting Commerce records and the tested commit. The evidence,
staff actions and records reproduce byte for byte.
