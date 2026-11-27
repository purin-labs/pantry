# Commerce — area guide

The Pantry side of commerce: the read layer, the governed actions, checkout profiles, payments
and payouts. Read [the root guide](../../AGENTS.md) first; this file adds only what is
particular to this area.

- **Specs:** [COM-01](../../docs/specs/areas/commerce/01-commerce-domain.md) (Commerce
  domain), [COM-02](../../docs/specs/areas/commerce/02-commerce-engine.md) (Commerce engine),
  [COM-03](../../docs/specs/areas/commerce/03-providers-and-the-read-layer.md) (Providers and
  the read layer), [COM-04](../../docs/specs/areas/commerce/04-checkout-and-payments.md)
  (Checkout and payments), [COM-05](../../docs/specs/areas/commerce/05-merchant-operations.md)
  (Merchant operations). A spec says what is built; change it in the same commit as the
  behavior.
- **Packages:** `@purin-labs/area-commerce` (`server/` for the Worker, `ui/` for the Portal) and
  `@purin-labs/area-commerce-contract` (`contract/`).
- **Agent tool families** (`server/agent-tools/`): `commerce`.
- **Portal features** (`ui/features/`): `api-keys`, `bank-payouts`, `checkout-profiles`,
  `commerce`, `governed-actions`, `orders`, `payment-accounts`, `payments`, `payouts`.
- **Files, tables and public files:** `node scripts/check-layers.mjs --areas commerce`, or
  [the layers page](../../docs/layers.md).

## Rules of the layers

- This area imports the foundation and the contract package of another area. It imports no
  surface and no file of another area. `pnpm lint:layers` refuses a new crossing.
- Another area or a surface reaches this area through `contract/`. A contract file imports no
  implementation file of this area as a value. Do not make an implementation file public to
  remove a crossing: write a port, and let the Worker wire it.
- Only the owner of a table writes it. A write to a table of another owner calls a function of
  that owner.
- `pnpm lint:layer-debts` counts the debts that stay. Its counts only go down.

## Particular to this area

- The commerce engine is `services/commerce`, with `packages/commerce-contracts` and
  `packages/commerce-client`. It imports no Pantry package (`pnpm lint:runtime-boundary`).
  [Its spec](../../services/commerce/docs/spec.md) changes in the same commit as its API
  (`pnpm lint:commerce-spec`).
- A file outside the two implementations does not branch on the commerce system kind: it calls
  the `CommerceProvider` port. Shopify is one implementation, in
  `areas/integrations/shopify/`.
- After a change to a commerce lifecycle, run `pnpm --filter @purin-labs/platform
test:commerce-lab`.
