# Commerce

Monorepo component: `services/commerce`

**Commerce coordinates.** It is the merchant's private commerce runtime:
catalog, inventory, carts and checkout, orders, fulfillment, customer accounts
and the merchant entity plane. The back room no customer ever sees. Its
resident principal agent is Sous Chef, who runs the store; Commerce is the
machinery Sous Chef runs it on.

[`docs/spec.md`](docs/spec.md) is the contract for Commerce's behavior and
API. What the code does today:

- Customer account fields (profile, saved addresses and email) are sealed with
  AES-GCM under a key for each customer (Plan 76A step 3). Checkout keeps the
  buyer's email and phone only as salted hashes.
- Stripe and Square payments run inside Commerce for a merchant that
  connects an account (Plan 76 phase 3, Plan 80). No payment runs through
  Platform; any other provider is refused as unavailable.
- There is no referral attribution and no creator commission code.

Commerce owns commerce transactions. Its contracts live in
`packages/commerce-contracts` (`@seams/commerce-contracts`) and its typed client
in `packages/commerce-client` (`@seams/commerce-client`). Commerce
depends on no Pantry package, and `pnpm lint:runtime-boundary` refuses a new
crossing. Platform hosts Sous Chef and the Commerce Read Layer, and Punter runs
independent buyer acceptance journeys from `scripts/punter`.

Status: transactional commerce v1 and the merchant entity plane are implemented
as a Cloudflare Worker. One SQLite-backed `UnderclerkMerchantDO` owns each
merchant. The service owns merchant-scoped Location, SalesChannel, Product,
SellableVariant, InventoryItem, Offer, InventoryPosition, Order, Payment,
Fulfillment, and Shipment records. It also owns custom entity and relationship
schemas, system extension schemas, Commerce Lists, saved views, and their
merchant revisions.

Entity-plane mutations use exact typed authority and revision fences. Each
ordinary command atomically commits the domain change, merchant change record,
signed receipt, and signed observation delivery. Reads execute only validated
Contracts query plans against the normalized commerce relations; Commerce does
not plan queries or infer adapter-specific ordering. The `seed:cafe` script
includes five deterministic demo orders with varied payment and fulfillment
states. See [docs/plan.md](docs/plan.md).

## Layout

- `src/` — Worker, merchant Durable Object, commerce and entity-plane
  authorities, normalized query relations, and SQLite schema
- `tests/` — focused transaction, replay, conflict, receipt, and HTTP boundary
  coverage
- `tests/fixture-worker/` — the fixture Worker that client suites, such as
  Pantry Platform's, run as a built artifact
  (`pnpm --filter @seams/commerce-worker build:fixture-worker`): the production
  Worker with a deterministic payment gateway, an optional fixed clock and
  named seed scenarios
- `docs/` — plan
