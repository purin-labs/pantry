# Plan 76 — Underclerk as a Standalone Commerce Backend

Status (2026-10-28): proposed on 2026-10-19. Phases 1–7 and two slices of
phase 8 (gift cards and store credit; B2B companies with price lists and
invoice terms) are built and in production, with Phase 3's dispute and
pending-refund gaps closed. Underclerk `81c035dc` (schema 81) and the
Platform Worker `88397c44` run dev `f98a781a1`, released together with
Plan 80 step 4 and step 5 part A on 2026-10-27 07:17 UTC. Not
built: bulk CSV import and export, and subscriptions. Open items stay in each phase's status. Square
moved into Underclerk with Plan 80 step 4 (2026-10-27), and webhook delivery
through Queues is deferred ([Plan 77](plan-77-underclerk-modular-core.md)). Further gift card work is
deferred (owner, 2026-10-23). [Plan 77](plan-77-underclerk-modular-core.md)
restructures the core before the B2B slice. The
[Underclerk commerce spec](../services/underclerk/docs/spec.md) states what
the phases built. See
[Phase 1](#phase-1-status), [2](#phase-2-status), [3](#phase-3-status),
[4](#phase-4-status), [5](#phase-5-status), [7](#phase-7-status) and
[8](#phase-8-status).

## Goal

Make Underclerk a commerce backend that runs on Cloudflare by itself. Any
client can use it: a storefront, a POS, an agent or Satyr. It covers the core
of Shopify's backend: catalog, inventory, carts and checkout, payments,
orders, fulfillment, customers, discounts, and events for other systems.

Satyr becomes one installed client ("app") of Underclerk. Satyr keeps Cases,
policy, approvals, Urk and the Commerce Read Layer.

This plan changes one earlier decision. The
[Underclerk plan](../services/underclerk/docs/plan.md) lists "Shopify ecosystem
parity" as a non-goal, and
[Commerce Domain Architecture](commerce-domain-architecture.md) replaced the
Shopify-derived records with merchant-native records. This plan keeps the
merchant-native domain. It targets Shopify's backend features. It does not
copy Shopify's API shapes, themes or app store.

## Review of the current state

Facts on dev `8611df2eb`:

- 62,000 lines of source, 28,000 lines of tests, about 85 HTTP routes and 70
  SQLite tables at schema version 50.
- One Worker routes each request to one `UnderclerkMerchantDO`. That Durable
  Object (DO) owns one private SQLite database for one merchant.
- Each command commits the domain change, a change record, a signed receipt
  and a signed outbox event in one transaction. Idempotency keys and revision
  fences make replay exact.
- Money uses integer minor units. Quantities use exact integer scales.
  Inventory is a movement ledger with lots and allocations.

These foundations are correct for a commerce system of record. Keep them.

### Findings

1. **Payments run in Platform, not in Underclerk.** Underclerk calls the
   `satyr-edge` entrypoint `CafePaymentService` (about 2,000 lines) through
   the `PAYMENT_CAPTURE` service binding. Platform holds the provider
   credentials. Underclerk cannot take a payment without Satyr.
2. **Events reach Satyr only.** The outbox alarm asks Platform to pull
   (`enqueueUnderclerkOutboxReconciliation`). There are no webhook
   subscriptions and no public event feed.
3. **One shared token opens every merchant.** All admin and internal routes
   accept the same `UNDERCLERK_SERVICE_TOKEN`. There are no per-merchant API
   keys, scopes, staff identities or app installs. The comparison is a plain
   string compare, not a constant-time compare.
4. **Satyr identity is inside the core.** The `merchant` row stores
   `organisation_id`, and authority commands check it.
5. **Business-specific code is inside the core.** Japan and Singapore
   shipping (about 1,100 lines), deterministic Japan tax, duty and carrier
   providers, food service (menus, modifiers, recipes, preparation tickets),
   production batches, purchasing presets, demo profiles and the Plan 22/23
   seed scripts all live in the core service.
6. **Shared packages carry Satyr code.** `@satyr/bakery-model` holds
   about 12,000 lines of BakeryOS simulation types (`bakery-*.ts`).
   `@satyr/contracts` holds actor, goal, chat, message and file-context types
   next to the commerce contracts.
7. **Large modules.** `commerce-authority.ts` (5,262 lines, 158 methods),
   `buyer-checkout.ts` (3,530) and `schema.ts` (4,488 lines with 50 forward
   steps and copied legacy tables such as `shipment_v19` and
   `buyer_cart_line_v32`).
8. **The logs grow without a limit.** No code deletes delivered outbox
   events, command receipts or change records. In local data these two logs
   are the largest tables, at about 3 KB for each command. A DO has a 10 GB
   limit.
9. **Storefront reads hit the merchant DO.** Catalog, cart and checkout reads
   all queue on the one single-threaded object that also takes the writes.
10. **The admin capture route trusts its caller.** `captures` records the
    caller's `providerPaymentReference` without a provider check. This is
    safe only while Platform is the one trusted caller. Third-party API keys
    must not reach it.

### Coupling to Satyr

The runtime boundary is already a network boundary. No production code
outside the service imports Underclerk source. These links remain:

| Link              | Today                                                                                                                                                                                     | Standalone target                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Payments          | Platform mints an HMAC capability, pushes it to the DO, and runs Stripe Connect and Square (`payment-adapters/*`) with vault credentials.                                                 | Underclerk payment adapters and provider webhooks.                |
| Event delivery    | The DO alarm asks Platform to enqueue; Platform's queue and a one-minute cron pull `pendingDeliveries`, project them and acknowledge.                                                     | Event feed with a cursor plus signed webhooks. Satyr subscribes.  |
| Receipts          | Platform verifies delivery signatures against the key in `underclerk_merchant_binding`. Mutation receipts are only shape-checked.                                                         | Clients verify both with the merchant's published signing key.    |
| Provisioning      | Platform creates merchants (`provisionDemo`, entity-plane merchants for Shopify organisations with a placeholder key).                                                                    | Directory API: create merchant, issue key, install app.           |
| Auth              | Platform authenticates the operator, then calls with the one shared token.                                                                                                                | Satyr calls with its app token for that merchant only.            |
| Shared packages   | `@satyr/bakery-model` (with BakeryOS modules and a `workflow-canvas-crdt` dependency) and `@satyr/contracts` (Wasm loaded by a relative path into `packages/contracts/wasm-pkg`).    | `@underclerk/client` and a commerce-only contracts crate.         |
| Tests and scripts | Platform tests and E2E fixtures run Underclerk source in-process and reach into `../../underclerk/src/*`. Scripts share one token and deploy Underclerk from Platform's `deploy:staging`. | Platform tests run the built Underclerk Worker as a binding only. |
| Storefront        | `apps/storefront` is Underclerk's asset bundle with `MERCHANT_ID` hard-coded.                                                                                                             | A reference storefront that reads the merchant from its domain.   |

Platform keeps a rebuildable copy of Underclerk aggregates in the
Organisation DO (`commerce_projection`). That copy is correct: it is Satyr's
read layer and stays on Satyr's side.

## Scope against Shopify

Underclerk today is single-currency, mostly create-only commerce for one
café and cookie shop in Japan. Its depth is in the inventory ledger, food
service, checkout profiles and the entity plane.

| Shopify backend area                  | Underclerk today                                                                                                                    | Target              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Products and variants                 | Create only. One call makes one product, variant and offer. Only the description can change. No archive or delete.                  | Phase 6             |
| Options, media, handles, SEO          | Options and media sit inside the variant record. No handles or SEO fields.                                                          | Phase 6             |
| Collections, tags, types, vendors     | None                                                                                                                                | Phase 6             |
| Metafields and metaobjects            | Yes: entity-plane system extensions and custom entities (12 value kinds). Also used by Shopify organisations.                       | Keep                |
| Prices                                | One price for each variant and channel. Capped automatic price changes. No compare-at price.                                        | Phase 6             |
| Discounts, codes, automatic discounts | None. Checkout always sets the discount to zero. Promotion tables were deleted in schema step 42.                                   | Phase 6             |
| Gift cards, store credit              | None                                                                                                                                | Phase 8             |
| Markets and currencies                | One fixed currency for each checkout profile                                                                                        | Plan 76A step 4A    |
| Locations and inventory               | Strong: movement ledger, lots with expiry, reservations, recipes. No transfers between locations.                                   | Keep, add transfers |
| Carts and checkout                    | Yes: carts, pickup and shipping checkouts, checkout profiles, buyer sessions, order recovery                                        | Keep                |
| Customer accounts                     | Interface only. No gateway is wired, so identified buyers get HTTP 401. No customer record.                                         | Phase 6             |
| Buyer contact data                    | Email and phone are kept only as salted hashes. No field is encrypted. A merchant cannot send an order email.                       | Phase 6             |
| Tax                                   | Fixed JPY rates for Japan and Singapore                                                                                             | Phase 6 adapter     |
| Shipping rates and zones              | Fixed JPY rates. Routes are only `DomesticJapan` and `JapanToSingapore`. Address checks accept JP and SG only.                      | Phase 6             |
| Payments                              | Stripe, Square online, Square Terminal, GMO PG binding, all run by Platform                                                         | Phase 3             |
| Orders                                | Created only from a paid checkout. No draft orders, edits, notes or tags.                                                           | Phase 6             |
| Cancellation and refunds              | Whole-order cancellation before fulfillment. Partial refunds across lines, tax, duty and shipping. Disputes recorded.               | Keep                |
| Returns and exchanges                 | Removed in an earlier schema step                                                                                                   | Phase 6             |
| Fulfillment                           | Five kinds with their own state machines. Labels and tracking through test carriers only. No fulfillment orders or split shipments. | Phase 6             |
| POS                                   | Yes: configuration for each location, counter sales, Square Terminal                                                                | Keep                |
| Webhooks and event feed               | Signed outbox that only Platform reads                                                                                              | Phase 4             |
| API keys, apps, staff, scopes         | One shared token                                                                                                                    | Phase 2             |
| Search                                | Entity-plane text filter only                                                                                                       | Phase 7             |
| Reports                               | Product sales, capped at 1,000 orders                                                                                               | Phase 4 (R2 tables) |
| Bulk operations, imports              | None                                                                                                                                | Phase 8             |

[Plan 76A](plan-76A-shopify-parity.md) sets the order, design and test
journey of each feature in this table.

Two README claims do not match the code. There is no PII encryption, and
there is no referral attribution or creator commission code. Correct the
README in phase 1.

## Target architecture

```text
            storefronts, POS, agents, Satyr (an installed app)
                               |
                 HTTPS + API key / app token / buyer session
                               v
   +------------------- underclerk Worker (gateway) --------------------+
   | auth, scopes, rate limits, API version, route by merchant         |
   +----+--------------------+-------------------+----------------------+
        |                    |                   |
        v                    v                   v
  MerchantDO (SQLite)   CartDO (per cart)   catalog snapshots
  system of record      mutable buyer        (Cache API / KV)
  catalog, stock,       intent; calls        public storefront
  orders, payments,     MerchantDO at        reads, rebuilt
  customers, outbox     checkout             from events
        |
        +--> Queue --> webhook delivery Worker --> subscribers (Satyr, others)
        +--> R2: event and receipt archive, media, exports, bulk results
        +--> payment, tax and carrier adapters (Stripe, Square, carriers)

  D1 directory (Tokyo): merchants, API keys (hashed), apps, installs,
  webhook subscriptions, domains. No commerce records.
```

### Tenancy and authentication

- A merchant is the tenant. The directory stores an optional external
  reference (Satyr's organisation id) instead of a Satyr column in the core.
- Three caller types: an admin API key or app token with scopes, a staff
  member (a later step), and a buyer session (exists today).
- Satyr installs as an app with the scopes it needs. Its governed actions
  keep their idempotency keys and revision fences.
- Compare all secrets in constant time. Store only hashes of API keys.

### API

- Keep typed JSON commands and reads with versioned schemas. Generate an
  OpenAPI document and the TypeScript client from the contracts.
- Keep the Storefront API (public, buyer session) separate from the Admin
  API (API key or app token).
- Add an event feed with a cursor and signed webhooks. Satyr reads the same
  feed as any other subscriber.
- GraphQL is not in the first scope. Agents and typed clients work well with
  typed commands.

### Payments

Move provider execution from `CafePaymentService` into Underclerk payment
adapters. Each merchant connects its own Stripe or Square account (Stripe
Connect for platform fees). Provider webhooks go to Underclerk. Credentials
stay encrypted in Underclerk and never reach a client. Satyr keeps only the
approval and the receipt view.

### Extensions

The core keeps generic catalog, stock, checkout, order and fulfillment
records. These move behind extension boundaries:

- **Food service and production** (menus, modifiers, recipes, preparation
  tickets, batches): a CafeOS extension that uses core stock movements and
  order lines.
- **Regional providers** (Japan and Singapore shipping, Japan tax and duty):
  provider adapters behind the existing `ShippingGateway`,
  `CarrierRateQuoteProvider` and `CheckoutChargeQuoteProvider` interfaces.
- **Purchasing and entity plane presets**: extension presets, not core
  tables.

### Storage tiers

Underclerk stores data in DO SQLite, not in D1. Prices on 2026-10-19
(Workers Paid, after the included amounts):

| Store         | Storage per GB-month | Write price            | Note                               |
| ------------- | -------------------- | ---------------------- | ---------------------------------- |
| DO SQLite     | $0.20                | $1.00 per million rows | 10 GB limit for each object        |
| D1            | $0.75                | $1.00 per million rows | 10 GB limit for each database      |
| R2 Standard   | $0.015               | $4.50 per million PUTs | No egress fee, APAC location hint  |
| R2 Infrequent | $0.01                | $9.00 per million PUTs | $0.01/GB retrieval, 30-day minimum |

Cost model for a busy shop. Assumptions: 300 orders a day, about 20 KB for
each order with its logs, logs are 70% of the bytes, and no included amount.
The result is 2.2 GB each year.

| Year | All in DO SQLite | Logs in R2, rest in DO | Saving per month |
| ---- | ---------------- | ---------------------- | ---------------- |
| 1    | $0.44/month      | $0.15/month            | $0.28            |
| 3    | $1.31/month      | $0.46/month            | $0.85            |
| 5    | $2.19/month      | $0.77/month            | $1.42            |

Rows written cost about $0.55 a month for the same shop at 60 rows for each
order. Storage is a small part of the cost per merchant.

Rules:

1. **Do not hydrate whole databases from object storage.** A restore writes
   every row again at $1.00 per million. At 500 bytes a row, one GB costs
   $2–4 to restore, and it saves $0.185 each month in R2. A merchant must
   stay cold for 11–22 months to cover one restore. A restore also adds
   seconds to the first request.
2. **Keep the working set in the DO.** Current catalog, stock positions,
   open carts, open orders and recent history stay in SQLite.
3. **Move the append-only logs and finished orders to R2.** Delivered outbox
   events, command receipts and change records older than a retention
   window, and finished orders, become files that never change, one set for
   each month (see Plan 76A step 5). They are already signed, so a reader can
   verify them without the DO. Reads of old records go directly to R2
   through the Cache API. They do not come back into SQLite.
4. **Freeze idle merchants only after a long idle period.** After 12 months
   with no activity, export a snapshot to R2 and clear the DO. A thaw is an
   explicit, slow operation.
5. **Send analytics to R2 tables.** The event feed can fill Iceberg tables in
   R2 for reports. Then reports do not run on the merchant DO.

The main reason for rule 3 is the 10 GB limit, not the price. The busy shop
reaches 10 GB in about 4.6 years with no retention.

## Phases

Each phase ends with one medium-to-hard E2E journey and a repeatable
artifact. Phases 1–5 change no product behavior for Satyr's merchants.

| Phase                     | Work                                                                                                                                                                                                                                                                     | Exit journey                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 1. Boundary               | Platform tests use the built Worker only. Split commerce contracts and the commerce client from Satyr packages. A lint check refuses new crossings.                                                                                                                      | Underclerk builds and its journeys pass with no Satyr package in its dependency graph.                           |
| 2. Tenancy and auth       | D1 directory, hashed API keys with scopes, Satyr as an installed app, constant-time compare, external reference instead of `organisation_id`.                                                                                                                            | A key for merchant A is refused on merchant B. Satyr completes one governed command through its app token.       |
| 3. Payments               | Stripe and Square adapters inside Underclerk, provider webhooks, merchant connection flow. Keep `CafePaymentService` until one production payment passes.                                                                                                                | A Stripe test-mode checkout, capture and partial refund pass with Platform not running.                          |
| 4. Events                 | Event feed with a cursor, signed webhooks through Queues (Plan 76A step 4B), and the R2 archive (Plan 76A step 5). Satyr moves to the feed.                                                                                                                              | Stop Satyr, place orders, start Satyr. Satyr catches up from its cursor with no lost and no repeated event.      |
| 5. Core and extensions    | Move food service, production, purchasing and Japan providers behind extension boundaries. Split `CommerceAuthority` by aggregate. One schema baseline.                                                                                                                  | The core builds without extension code. The café pickup and shipping journeys pass with the CafeOS extension on. |
| 6. Core commerce features | [Plan 76A](plan-76A-shopify-parity.md) steps 1–3, 6 and 7: product editing, draft orders, order edits, returns, customer accounts, collections, discounts. Tax and shipping zones need their own plan.                                                                   | One journey for each Plan 76A step.                                                                              |
| 7. Read path and scale    | Catalog snapshots in the Cache API, guest sessions at the Worker, catalog search over the snapshot, expiry of lapsed checkout holds. No `CartDO` and no FTS5 (see [Phase 7 status](#phase-7-status)).                                                                    | A flash sale on one merchant: many buyers, one limited item, no oversell, storefront reads stay fast.            |
| 8. Wider features         | More than one currency (Plan 76A step 4A), then in this order: gift cards and store credit (slice 1 built), B2B price lists with invoice terms, bulk CSV import and export, subscriptions. Further gift card work is deferred. A Shopify import tool is a separate plan. | One journey for each slice; see [Phase 8 status](#phase-8-status).                                               |

### Phase 1 status

Status (2026-10-21): on origin dev and in production (see the status line
above).

Built:

- `packages/underclerk-contracts` holds the crate `underclerk-contracts` and
  the package `@underclerk/contracts`: the commerce and food-service Rust
  types, their 532 generated bindings, a commerce-only Wasm build and the
  commerce browser validators. `satyr-contracts` depends on this crate and
  re-exports it, so Satyr's Rust paths, its Wasm exports and its
  `@satyr/contracts` imports do not change.
- `packages/underclerk-commerce-client` holds `@underclerk/client`. The
  BakeryOS modules stay in `@satyr/bakery-model`, which re-exports
  `@underclerk/client` from its root.
- `@lowerarchy/std` and `@lowerarchy/type-utils` are the neutral helper
  packages. `@satyr/std` and `@satyr/type-utils` re-export them, so Satyr
  imports do not change.
- Underclerk packages have `@underclerk/*` names: `@underclerk/worker`,
  `@underclerk/storefront`, `@underclerk/contracts`, `@underclerk/client` and
  `@underclerk/commerce-query-sqlite`. Punter uses `@underclerk/client`.
- Satyr's browser validator core keeps the access-control validators and links
  Underclerk's commerce validators. The Portal resolves both module names to
  that one core, so it loads no second copy.
- `pnpm lint:runtime-boundary` runs in `pnpm lint` and in CI. It refuses a new
  crossing in either direction, in sources, manifests and the crate's path
  dependencies.
- The exit journey `pnpm underclerk:verify-standalone` passes. It writes
  [standalone-underclerk.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-1/standalone-underclerk.json):
  the graph of the Worker and the storefront holds 225 packages and no Satyr
  package, every one of the 150 files in the Worker bundle comes from
  Underclerk or a neutral package, the check refuses a planted `@satyr/std`
  import, and the Underclerk suite passes.
- The Underclerk README no longer claims encrypted PII for every field,
  referral attribution or creator commissions.
- Platform's tests reach Underclerk only over HTTP, through the built fixture
  Worker in `services/underclerk/tests/fixture-worker`. It is the production
  Worker with a deterministic payment gateway, an optional fixed clock and
  named seed scenarios. `pnpm --filter @underclerk/worker build:fixture-worker`
  builds it. Platform's unit tests start it in Miniflare, and the E2E pool
  binds it as `UNDERCLERK`. Platform no longer depends on `@underclerk/worker`.
- Checks that read Underclerk's own tables moved to the Underclerk suite:
  Durable Object restart, relation schema upgrade, rollback after a failed
  write and the normalized query conformance cases. The conformance corpus is
  `@underclerk/commerce-query-sqlite/normalized-conformance`; Underclerk's
  relations and Satyr's commerce projection both run it.
- The 29 E2E journeys that reach `UNDERCLERK` give the same result for each
  test before and after the move: 97 pass, 32 fail and 4 are pending
  ([e2e-built-fixture-worker.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-1/e2e-built-fixture-worker.json)).
  Each failure occurs on both sides for the same reason, so the move adds no
  failure. One of them is a stale test: `inventory-operations` expects
  Underclerk schema version 50, and the schema is at 63.
- The oven authoring server starts the built Worker.

Open:

- The Plan 50 evaluation scripts start the fixture Worker too, and read
  Underclerk's records through its `merchant_records` scenario. No crossing
  is allowed any more. These scripts do not build on dev for other reasons:
  they import exports that Pi 1.3.0 and later Platform changes removed. So
  their Underclerk part is not proved by a run.
- Done in phase 2: Underclerk has its own staging release, and Platform's
  `deploy:staging` no longer deploys it.

### Phase 2 status

Status (2026-10-21): in production since 04:06 UTC. Platform's scheduled
reads of a merchant's deliveries pass on Satyr's app token.

Built:

- API keys (`uck_…`) and app installations (`uca_…`) for one merchant,
  with scopes from `UNDERCLERK_API_SCOPES` in `@underclerk/client`. Every
  admin route names the scope it needs, or `operator` (provisioning, keys,
  installs, archive runs, the migration inventory). An API key cannot hold
  `payments:record`, so payment results that Underclerk does not check
  with the provider stay closed to third parties (finding 10).
- The credentials live in each merchant's own SQLite (schema 64), not in a
  D1 directory. The path names the merchant, so the merchant's object checks
  the credential in its own database: another merchant's object never finds
  it, and no request waits for a D1 read. Secrets are kept only as SHA-256
  hashes, and every secret compare runs in constant time.
- The operator token (`UNDERCLERK_SERVICE_TOKEN`) stays the deployment
  operator's credential. It opens every route.
- Satyr is an installed app. Each Platform client names the organisation it
  acts for and sends Satyr's installation token for the request's merchant.
  The token is derived from the operator token and the organisation, so a
  Satyr client that names the wrong organisation is refused, and Platform
  stores no token. Platform installs Satyr when it provisions a merchant; an
  older merchant gets the install on Satyr's first request. Underclerk
  refuses an install whose external reference is not the merchant's
  organisation. Provisioning, the payment authorities and the Stripe
  dispute webhooks keep the operator token.
- Underclerk has its own staging release (`pnpm --filter @underclerk/worker
deploy:staging`). Platform's `deploy:staging` no longer deploys it.
- Exit journeys:
  [api-access.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-2/api-access.json) (Underclerk:
  a partner key sets up a product through its scopes and is refused on a
  second merchant, on operator routes and on payment records; revocation,
  uninstall and a tampered key are refused) and
  `tests/e2e/underclerk-app-access.test.ts` (Platform: Satyr's command runs
  on its installation, a client of another organisation is refused, an
  uninstalled Satyr stays out until the operator installs it again).
  [e2e-app-access.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-2/e2e-app-access.json)
  records the 30 E2E files that reach Underclerk: each gives the phase 1
  result or better.

Open:

- The D1 directory is not built. Nothing needs a lookup across merchants
  yet; domains for the reference storefront (phase 7) are the first need.
- Commands still carry `organisationId`, and the `merchant` row keeps
  `organisation_id` as the external reference. The rename touches about
  1,100 lines in the contracts, the client and Platform, with no change in
  behavior.
- A merchant cannot manage its own keys yet; only the operator can. Staff
  identities are not built.
- An app token cannot be rotated alone. Since 2026-10-21 08:11 UTC
  (production), Underclerk checks an app token against the token that the
  current operator token derives, not against the hash stored at install. A
  new operator token stops every earlier app token at once, and Satyr goes
  on with no new install; an uninstalled app stays refused
  (`tests/api-access-journey.test.ts`, evidence `rotation`).

### Phase 3 status

Status (2026-10-21): in production since 04:06 UTC, Stripe only; Square is
not started. Underclerk has `STRIPE_SECRET_KEY` (the platform's test-mode
Connect key) and `STRIPE_WEBHOOK_SECRET` of the Connect endpoint
`we_1USs8ZQ1O5Xa8EicVEQHW06X` (test mode, `payment_intent.*`). Every
Underclerk production secret that has a local copy is in the git-ignored
`.env.local.production`; the operator token was rotated on 2026-10-21 05:32
UTC on both Workers, and Satyr was installed again on both merchants. A real Stripe
event reached it with no pending delivery, and a forged one got 400.
`STRIPE_PUBLISHABLE_KEY` (test mode) is set since 04:11 UTC (Underclerk
`7940a88f`), so a merchant that connects a Stripe account takes its online
payments through Underclerk; every other merchant stays on Platform. On
2026-10-21 05:4x UTC a scratch production merchant (`merchant_nuki_cafe_demo`,
seeded by `scripts/seed-local-commerce.ts`, no Satyr organisation) connected
the test account and took one payment: Underclerk made the session with the
publishable key, the browser-style confirmation succeeded, Stripe's webhook
placed the order 3 seconds later, the buyer's reconcile read the same order,
and a ¥100 refund succeeded on Stripe. No Satyr merchant has connected an
account yet. The scratch merchant stays in production.

Built:

- A merchant, or a key with `settings:write`, connects a Stripe account
  that is connected to the platform (`PUT …/payment-accounts/stripe`).
  Underclerk reads the account from Stripe first and refuses an account
  that is not the platform's. A shop with no account gets Stripe's hosted
  onboarding (`POST …/payment-accounts/stripe/onboarding`) through Accounts
  v2, because Stripe refuses v1 account creation for a new Connect
  platform.
- Underclerk makes the PaymentIntent on the connected account with the
  platform key and the `Stripe-Account` header, reads each payment's state
  from Stripe, and refunds on Stripe. No merchant secret is stored.
- Stripe's Connect webhook (`POST /v1/providers/stripe/webhooks`) is only a
  prompt. The Worker checks the signature and finds the merchant and the
  payment attempt in the PaymentIntent's metadata; the merchant's object
  reads the payment from Stripe and places the order when the buyer does
  not come back. The buyer's later reconcile reads the same order.
- Payments that started on Platform, and merchants with no connected
  account, keep `CafePaymentService`. Schema 65 adds the account,
  PaymentIntent and settlement tables.
- Settings, all optional: `STRIPE_SECRET_KEY` (secret, the platform's
  Connect key), `STRIPE_PUBLISHABLE_KEY` (variable) and
  `STRIPE_WEBHOOK_SECRET` (secret, from a Connect webhook endpoint that
  points at Underclerk). The secret key alone lets merchants connect
  accounts; payments also need the publishable key. Without both keys every
  payment goes to Platform.
- Exit journey on real Stripe test mode with Platform stopped:
  [stripe-payments.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-3/stripe-payments.json).
  It needs `UNDERCLERK_STRIPE_TEST_SECRET_KEY`,
  `UNDERCLERK_STRIPE_TEST_PUBLISHABLE_KEY` and
  `UNDERCLERK_STRIPE_TEST_ACCOUNT`, and it skips without them. The buyer's
  confirmation uses only what the session gives the browser: the publishable
  key, the client secret and the connected account.

Open:

- Square online and Square Terminal. Square has no `Stripe-Account`
  equivalent, so Underclerk first needs an encrypted store for each
  merchant's OAuth token.
- Closed on 2026-10-22 and released 2026-10-23: Underclerk's webhook route
  takes `charge.dispute.*`. The Worker reads the dispute's PaymentIntent on
  the connected account; its metadata names the merchant and the payment
  attempt, and the merchant's object records the dispute with Stripe's event
  id as its key. A PaymentIntent without Underclerk metadata (a payment that
  Platform ran) is left to Platform's endpoint. Released 2026-10-23 12:22
  UTC; the Connect endpoint `we_1USs8ZQ1O5Xa8EicVEQHW06X` (test mode) sends
  `charge.dispute.created`, `.updated` and `.closed` since then.
- Closed on 2026-10-22 and released 2026-10-23 12:22 UTC: a refund that
  Stripe reports
  as pending, or whose answer was lost, is read again by the merchant
  object's alarm after `reconcileAfter`. The alarm replays the command that
  reserved the refund (kept in `refund_command`, schema 67), so the receipt is
  the one that the caller's own retry gets. The Stripe gateway reads the
  pending refund by its id, and finds a refund with a lost answer by the
  attempt id in its metadata, before it would ask for a new one. Journey
  `tests/stripe-after-sale-journey.test.ts` runs on a fake Stripe that only
  answers and records calls; evidence
  [stripe-after-sale.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-3/stripe-after-sale.json).
  The step from schema 66 to 67 equals a fresh database
  ([schema-67-step.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-5/schema-67-step.json)).
- A refund attempt that stays `requested` (the object stopped between the
  reservation and the Stripe call) is not read again.
- Shipping checkouts are not in the exit journey; pickup is.
- Fixed on 2026-10-21: Platform's own Stripe adapter pinned API version
  `2026-08-27.basil`, which Stripe refuses, so its first Stripe call failed.
  Platform and Underclerk now both pin `2026-03-25.dahlia`, the platform
  account's default. The Stripe certification name changed with it, so a
  Stripe binding must be certified again before Platform publishes it.

### Phase 4 status

Status (2026-10-21): in production since 08:12 UTC, a whole-dev release of
`3e812d145`. Underclerk (schema 66, `0c8f8d95`) deployed first, then
Platform (`satyr-edge` `f9ea98fa`), sandbox `3b828bde`, model exit
`5ec0ea4a`, ChatGPT exit `213b593f` and Slack ingress `77e4ca01`. After the
release, Satyr read its cursor and the feed of each bound merchant each
minute on its app token, every read 200, with no exception in 90 s of
tails. Each cursor stands at the newest event, so no production cursor has
moved yet; the first commerce change after the release moves one.

Built:

- Each feed consumer keeps its cursor in the merchant's database
  (`GET`/`PUT …/feed-consumers/:consumerId`, scope `events:read`). A first
  read starts at the oldest delivery that nobody acknowledged. Deliveries up
  to the slowest consumer's cursor count as delivered, so the archive and the
  wake-up alarm work unchanged.
- Satyr reads the feed after its cursor, up to ten pages for each run,
  applies each event as before, and moves the cursor past it. A delivery
  that can never apply is still marked rejected first. Two runs may overlap:
  a move to an event already passed changes nothing and counts as a replay,
  as does a delivery that the projection already holds.
- When the signing repair reopens a delivery that a consumer passed, the
  consumer's cursor moves back to read it again.
- The feed sends each delivery as it was stored and signed, so a reader can
  check the signature of a delivery that an older version wrote. An
  entity-plane receipt no longer breaks a feed page (that broke the feed on
  dev for any merchant with a production request). A full page of 100 events
  no longer fails: the receipt lookup binds at most 50 ids at a time, because
  Durable Object SQLite binds at most 100 variables in one statement.
- Exit journey `tests/e2e/underclerk-feed-catch-up.test.ts`: a café is set up
  while Satyr's reader is stopped; the first run loses its fourth cursor
  move; more changes arrive; the next run starts from the cursor, applies
  every event, and counts the one event read twice as a replay; a third run
  finds nothing, and every delivery is delivered.
- Behavior change in `underclerk-format-skew`: Satyr's first feed read
  includes a delivery that an older receiver rejected, and it now verifies,
  so Satyr knows that product before the signing repair.

Open:

- Webhook delivery through Queues, and Satyr as a webhook subscriber. The
  Durable Object alarm still wakes Platform through `PAYMENT_CAPTURE`.
- The `GET …/deliveries` read route is removed, in production since
  2026-10-21 15:26 UTC (it answers 404). The acknowledgement route stays:
  Satyr marks a delivery that can never apply as rejected through it.

### Phase 5 status

Status (2026-10-22): slice 4 (schema baseline and `CommerceAuthority`
split) in production since 03:42 UTC: Underclerk `6fc2479b` from
`e81586fcc`, released alone because no Platform Worker changed. The Platform Workers
followed at 05:22 UTC from `9207632f2` (`satyr-edge` `08851340`). All three
production merchants opened at schema 66 with no invariant failure, and a
90 s tail showed no exception. Slices 1–3 in production since
2026-10-21 15:32 UTC, a whole-dev release of `368104b18`: Underclerk
`d3b1038b` (schema 66, unchanged) first, then `satyr-edge` `b2a896ce`, sandbox `61db7e99`, model
exit `dd0a9367`, ChatGPT exit `245b8c45` and Slack ingress `2ef2c31c`.
Health 200 and no exception in 90 s of tails after the release. Slices 1
and 3 change no behavior for a merchant on the Worker. Slice 2 adds
shipping to Australia, the United States and the European Union; no
production merchant has an export route yet.

Built (slice 1, purchasing and the production demand preset):

- `src/extensions.ts` names the extension slots of the core. The Worker
  passes `CAFE_EXTENSIONS` (`src/extensions/index.ts`) to `CommerceAuthority`
  and `EntityPlaneService`. The purchasing preset, the replenishment
  reconciler, the receipt purchase check and the production demand preset
  moved to `src/extensions/purchasing/` and `src/extensions/production-demand/`.
- A core with no extensions answers 404 on the purchasing and production
  demand routes, and refuses a stock receipt that names a purchase request
  (`resource_relationship_invalid` on `purchase.entryId`).
  `tests/purchasing-replenishment.test.ts` runs the same requests with and
  without the extensions.
- `pnpm lint:runtime-boundary` refuses a core import of `src/extensions/`;
  only `src/worker.ts` and the extensions themselves import it.

Built (slice 2, shipping from Japan, and three new zones the owner asked
for on 2026-10-21):

- `src/regional-shipping.ts` is the shipping contract of the core: the
  quote request and result, the published services and the slot
  `RegionalShipping` (gateway, carrier rate and charge providers, the route
  for a country, the published services and the quote). The core plans the
  checkout, keeps quote attempts durable and records the quote.
- `src/extensions/japan-export/` holds Yamato within Japan and Japan Post to
  Singapore and to three zones, with their test rates, tax and duty rules,
  labels and tracking. The Worker passes it through `cafeExtensions(key)`.
- The contract `ShippingRouteBinding` has a third kind, `international`,
  that lists the destination countries of one zone. The stored
  `domestic_japan` and `japan_to_singapore` routes keep their form, so no
  stored record changes and no migration runs.
- Zones from Tokyo, all test fixtures with no carrier or tax service call:
  Australia (GST 10% on goods and postage, no duty up to AUD 1,000), the
  United States (no consumption tax, 15% duty on the goods after the end
  of de minimis) and the 27 EU countries (each country's standard VAT under
  the import one-stop shop, no duty up to EUR 150). Each zone has EMS and
  Air Parcel test rates.
- Buyers enter an Australian, US or EU address. Australia and the United
  States need the state; each country keeps its own postal code form. The
  storefront offers every country with a published service and shows
  delivery dates in the destination's time zone.
- Exit journey in `tests/plan33-core-acceptance.test.ts`: exact quotes for
  Australia, the United States, Germany and France; a US order through
  payment, label and `JP-US` tracking; Canada and a malformed ZIP code
  refused over raw HTTP; and the same store in a core with no shipping
  extension is not offered (404). Checked in a browser on a local Worker:
  a US quote of ¥3,600 + ¥3,900 EMS + ¥540 duty = ¥8,040.

Open (slice 2): the EU rates use the standard VAT, not the reduced food
rates, and the EU plan for a duty on parcels under EUR 150 is not modelled.
Food import rules (Australian biosecurity, US prior notice) are not
checked.

Built (slice 3, food service and production, in four steps):

- Kitchen commands: preparation stations, modifier groups, recipes, stock
  policies, menus, preparation tickets and production batches move to
  `src/extensions/food-service/`. The core lends them a context and commits
  each mutation through one port (`ExtensionMutation`) that signs the
  delivery and receipt and writes in one transaction. Without the extension
  their routes answer 404.
- Menus: a menu line's modifiers, recipe, preparation and price, and the
  menus a buyer sees, move to `menus.ts`. Without the extension a menu line
  is refused and a pickup catalog shows no menus.
- Stock movements of preparation tickets and production batches move to
  `movements.ts`.
- The café demo (`cafe_patisserie`) moves to `cafe-scenario.ts`; without the
  extension the demo is refused. The e-commerce demo stays in the core.
- Exit journey in `tests/checkout-persistence.test.ts`: the same café data,
  read through a core with and without the extension, gives menus, a quoted
  menu line, a kitchen route and the café demo with it, and no menus, a
  refused line, 404 and a refused demo without it.

Open (slice 3): the core keeps the read model of `food_service_resource`
(`commerce-authority/food-service.ts`), the entity-plane projection of
food resources, `production-requests.ts`, and the handling of order lines
whose stored source is `food_service`: those are stored records and
contract variants, which change only with a migration.

Built (slice 4, schema baseline, on the owner's word of 2026-10-22 to keep
all production merchant data):

- `src/schema.ts` creates schema 66 in one step on a new merchant
  database and accepts a database at 66 unchanged. Any other stored version
  is refused with `Unsupported Underclerk schema version`. The 65 upgrade
  steps, the legacy inventory approval and their tests are removed.
- All three production merchants were at 66 on 2026-10-22, so no stored row
  changes. A database born at each schema from 50 to 65 and upgraded by the
  removed steps equals the baseline in every column, index, foreign key,
  CHECK expression, trigger, view and row count, except 53, which only ran
  on dev. A database born at 47 already failed to upgrade.
  Evidence: [schema-baseline.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-5/schema-baseline.json).
- Each later schema change adds one step from 66; schema 67 is the first.
  `scripts/plan47/underclerk-upgrade-rehearsal` rehearses such a step in
  the Workers runtime.

Built (slice 4, `CommerceAuthority` split):

- `src/commerce-authority/ledger.ts` is the one commit port of the core
  and of every extension. It signs the delivery and the receipt, writes the
  change, moves the merchant revision and records both in one transaction.
  A refund reservation holds its revision and delivery with no receipt.
- Each aggregate builds its mutations in its own module: `catalog-`,
  `inventory-`, `checkout-`, `fulfillment-`, `order-`, `merchant-` and
  `after-sale-mutations.ts`. `commerce-authority.ts` keeps the routing of
  commands to their aggregates: 2,941 lines, from 6,467.
- The split changes no stored byte. Every receipt and delivery that the
  Underclerk suite writes (7,841 rows) is the same before and after the
  split. Three tests use random tracking numbers; their rows match with
  those numbers masked.

Fixed after slice 4 (2026-10-22): the payment attempt steps (begin,
capture, dispute) and a checkout release that moved no stock signed a
delivery but did not store it. No feed reader needs contiguous revisions, but
their webhooks (`checkout.payment_started`, `payment.captured`,
`dispute.updated`) never fired. Every commit now stores its delivery, and an
event with no observation names the resource of its receipt. Satyr
acknowledges a delivery with no observation as delivered; before, it logged
`commerce_event_invalid` and rejected it (drafts, media, customers, markets).
Journeys: `webhook-journey.test.ts` (an endpoint for `payment.captured` gets
each capture with its payment attempt) and Satyr's
`underclerk-feed-catch-up.test.ts` (a market is delivered, none rejected).
In production since 2026-10-22: Platform 10:39 UTC from `92a8b8df6` (the
live `38f1978a0` and the Satyr part of `9c572b4b1`; `satyr-edge`
`ce50f837`), then Underclerk 10:44 UTC from `9c572b4b1` (`e5655a71`). Health
200 and 90 s tails of both with no exception.

Underclerk release of 2026-10-23 12:22 UTC: `a1b6cb4e` from dev
`4e9256ceb`, schema 66 to 72, the Platform Workers unchanged (ref
`refs/backup/released-2026-10-23-underclerk-schema-72`). Before it, the 16
schema-66 databases that the live source's journeys write were opened with
the new code: each upgraded to 72 and read its orders, drafts, events and
catalogs, and ran its alarm work. After it, the three merchant objects
upgraded on their first request; health 200 and a 90 s tail of Underclerk
with no exception.

### Phase 7 status

Status (2026-10-23): built and in production since 2026-10-23 12:22 UTC
(Underclerk `a1b6cb4e`). No schema change. The production read speed is not
measured yet.

Built:

- **Catalog snapshots.** The merchant object builds a snapshot of a
  storefront: its revision, the active checkout profile and the buyer
  catalog (`GET /v1/internal/merchants/:m/storefronts/:s/catalog-snapshot`,
  operator only). The Worker keeps it in the Cache API for 5 s
  (`src/catalog-snapshots.ts`) and answers catalog reads and catalog
  searches from it. The Worker checks the buyer session token itself. A
  token that the snapshot cannot confirm goes to the merchant object, which
  decides as before: a signed-in customer's session, a token for another
  storefront revision, an expired or forged token.
- **Guest sessions at the Worker.** A guest session is a signed token made
  from the storefront revision and the checkout profile, so the Worker
  issues it from the snapshot. It is issued at the snapshot's build time,
  so a guest session lives up to 5 s less. Customer sessions still go to
  the object.
- **Stale stock is safe.** A snapshot can show an item as available for up
  to 5 s after it sold out. The cart or the checkout still refuses it, so a
  snapshot can never oversell.
- **Catalog search.** `GET .../storefronts/:s/catalog/search?q=&limit=`
  (default 20, maximum 50) in `src/catalog-search.ts`, and
  `searchCatalog` in `@underclerk/client`. Every term must match. A term
  in the title counts most, then the variant, the SKU, handle and options,
  then the description; available listings come first. Text is compared in
  NFKC form, in lower case, with katakana as hiragana, so `センチャ` finds
  `せんちゃ` and `ＳＥＮＣＨＡ` finds `sencha`.
- **Lapsed checkout holds.** Before phase 7 a quoted checkout held its
  stock until a person sent `expireCheckout`: an abandoned checkout kept an
  item sold out. The object's alarm now expires each online checkout whose
  quote has lapsed and that has no payment under way, writes
  `checkout.expired`, and wakes again at the next quote expiry.
- **Worker route guard.** The Worker now takes the buyer routes from the
  route table. Its hand-written pattern refused four buyer routes with 401:
  collections, media, customer sign-ins and balance checkouts. Those Plan
  76A features did not work through the production Worker before this fix.

Not built, with the reasons:

- **`CartDO`.** See the decision below. The numbers do not justify a second
  Durable Object class.
- **SQLite FTS5.** FTS5's `unicode61` tokenizer does not split Japanese
  text into words, and its `trigram` tokenizer needs three characters, so
  `煎茶` (two characters) finds nothing. A scan of the snapshot also keeps
  search off the merchant object. Measured scan time for a two-term query
  in Node: 0.18 ms for 100 listings, 1.7 ms for 1,000 and 8.6 ms for 5,000.
  If a storefront grows past about 1,000 listings, store the normalized
  text in the snapshot.

Exit journey: `tests/flash-sale-journey.test.ts` in workerd, with the built
fixture Worker and its Durable Object (`tests/workerd-backend.ts`). 300
buyers want one of 40 tea tins at the same time, and 10 readers read the
catalog during the sale. Each tin sells once, every other buyer is refused
at the cart or at checkout, no stock goes negative, and 40 orders exist.
No catalog read and no guest session reaches the merchant object; a forged
token gets 401; 6 s after the sale a new buyer sees the tea as sold out in
the catalog and in search, both from the Worker. Evidence:
[flash-sale.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-7/flash-sale.json)
(`FLASH_SALE_BUYERS=300 FLASH_SALE_ARTIFACT_DIR=... pnpm exec vitest run
tests/flash-sale-journey.test.ts`). Other journeys:
`catalog-search-journey.test.ts` and `lapsed-hold-journey.test.ts`. With
the expiry loop broken, the lapsed-hold journey fails.

Requests that reached the merchant object in the 300-buyer sale:

| Request                     | Before phase 7 | Phase 7 |
| --------------------------- | -------------- | ------- |
| Guest sessions              | 310            | 0       |
| Catalog reads               | 57             | 0       |
| Carts                       | 300            | 300     |
| Checkouts                   | 164            | 189     |
| Payment sessions, reconcile | 80             | 80      |
| Total                       | 911            | 569     |

The "before" column comes from the outcomes of the same journey on the
code before phase 7, where every session and catalog read went to the
object. The sale took 1.7 s in one workerd thread, so the object spent at
most 3 ms on each request. A real storefront reads the catalog several times for
each buyer; all of those reads now stay at the Worker.

Limit: local latency does not show the gain. In local workerd the Worker
and the object share one thread, so a read at the Worker waits for the same
CPU. Catalog reads took p50 173 ms and p95 450 ms with 100 buyers (before:
182 and 763 ms), and p50 447 ms and p95 570 ms with 300 buyers (before: 298
and 780 ms). In production the Worker runs apart from the object. A cache
hit took about 1 ms and a snapshot build about 3 ms without load. A
production measurement needs a release.

### Phase 8 status

Status (2026-10-23): the scope is decided and slice 1 is built and in
production since 2026-10-23 12:22 UTC (Underclerk `a1b6cb4e`). Schema 68
adds two tables; a database at 66 or 67
upgrades in one step. The owner deferred further gift card work on
2026-10-23: selling gift cards online and the open items of slice 1 wait.
The B2B slice (companies, their price lists and invoice terms, schema 77)
is in production since 2026-10-25 15:51 UTC (Underclerk `c7c8f0ac`).

Order of the slices, for a premium gift pâtisserie in Japan:

1. **Gift cards and store credit** (built). A shop already sells vouchers
   at the counter and refunds broken goods. A refund as store credit keeps
   the money in the shop, and Stripe does not return its fee on a refunded
   card payment. Nothing else in Underclerk covers it.
2. **Selling gift cards online** (deferred). A buyer buys a card as a
   product and the recipient gets the code by email. It needs the email
   binding that production does not have yet.
3. **B2B price lists with invoice terms.** Corporate gift orders are large,
   and bank transfer avoids the card fee: about ¥14,400 at 3.6% on a
   ¥400,000 order. Draft orders with staff prices already cover a part of
   this, so it waits behind gift cards.
4. **Bulk CSV import and export** of products, prices and stock. It helps a
   new merchant start; a shop with about 50 products gains little.
5. **Subscriptions** (a monthly box). They need saved cards and payments
   with the buyer away (Stripe off-session), the largest build of the five.

A Shopify import tool stays a separate plan (see Non-goals).

Built (slice 1, gift cards and store credit):

- **Accounts and entries** (`src/commerce-authority/stored-value.ts`). A
  gift card or a customer's store credit is an account in one currency.
  Its balance is the sum of its entries: credits and refunds add, a
  checkout's hold and an order's redemption take away. The one writer of
  the merchant object keeps every balance at zero or more.
- **Codes.** The merchant's own system makes the code
  (`generateGiftCardCode` in `@underclerk/client`: 16 characters, 80
  bits) and sends it with the issue command. Underclerk keeps only a
  SHA-256 digest and the last four characters. Codes match in any case,
  with or without hyphens, and in full-width form.
- **Staff commands**: issue a gift card with an optional expiry, credit a
  customer's store credit, disable an account, list accounts. API scopes
  `stored_value:read` and `stored_value:write`.
- **Buyer routes**: read a gift card's balance (the code goes in the body,
  never the URL); enter gift card codes and choose store credit at a pickup
  checkout. Gift cards pay in the order entered, then store credit, after
  tax: they are a way to pay, not a discount.
- **Checkout.** The quote's `storedValue` names each tender and the amount
  `due`. The card pays only what is due. A quote that stored value pays in
  full is placed through `.../checkouts/:id/stored-value-placement`, with no
  payment provider, and a payment session for it is refused. A refreshed
  checkout keeps its cards; an expired one gives the held value back.
- **Orders and refunds.** Each tender becomes a captured payment of the
  order. Cancellation refunds the card on the provider and returns each
  stored-value payment to its account, in the refund's own transaction. A
  refund of a card payment can go to the customer's store credit
  (`destination: "store_credit"`) with no provider refund.
- **Unused balance report.** `GET .../stored-value-liability?at=` gives the
  unused gift card and store credit balances at a moment. Japan's Payment
  Services Act asks an issuer of prepaid instruments for this on each 31
  March and 30 September. A gift card that has expired by then counts
  nothing.
- Events: `gift_card.created`, `store_credit.credited`,
  `stored_value_account.disabled`, and `order.created` for a placement
  with no payment provider.

Exit journey: `tests/gift-card-journey.test.ts`, with Underclerk's own
Stripe payments on the fake Stripe. A ¥5,000 card pays a whole order with
no Stripe call, then part of a second order while Stripe charges only the
rest (¥2,260). An empty card and an unknown code are refused. A card held
by an abandoned quote is refused to another buyer until the alarm expires
that quote. Cancellation refunds ¥2,260 on Stripe and returns ¥3,680 to the
card. A card payment refunded as store credit makes no Stripe refund, and
the customer spends the credit after signing in. The unused balance at a
base date equals the card balances, and an expired card drops out. No byte
of the database files holds a gift card code. With the expiry release, the
stored-value refund or the store-credit destination removed, the journey
fails. Evidence:
[gift-card.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-8/gift-card.json), repeated byte
for byte.

Open (slice 1, deferred with the gift card work):

- Counter sales do not take stored value yet. Shipping checkouts take it
  since Plan 77 step 2 (2026-10-23).
- The buyer's order view shows the refund status of the payment that the
  checkout named; the refunds of other stored-value payments show only on
  the order and the accounts.
- Satyr has no gift card screens. Its app installation needs the two new
  scopes before it calls these routes; it installs again only on
  `app_not_installed`.
- Legal: whether store credit from a refund is a prepaid payment
  instrument under the Payment Services Act is a question for a lawyer.
  The report shows it apart from gift cards.

Built (slice 3, part 1, B2B price lists; 2026-10-25, released 2026-10-25
15:51 UTC):

- **Companies** (`src/plugins/companies/`, the `companies` built-in
  plugin, which needs `customers`). A company has a name, its buyers
  (customers, each in at most one company) and a price list in one
  currency. Staff create, update and list companies; each command names
  the company's revision. Schema 77 adds `company` and `company_member`.
  The records are TypeBox schemas only (`records/api-companies.ts`), as
  Plan 78 asks for a new type; the plugin row is in the TypeScript and the
  Rust tables, which the data check still compares.
- **Prices at checkout.** A signed-in member of an active company pays
  the company's unit price of each listed catalog line, at pickup and
  shipping checkouts in the company's currency. It comes before the
  merchant plugins' `checkout.lines` hook and before discounts. Markets,
  draft prices, counter sales and guests are unchanged.
- Exit journey `tests/company-price-journey.test.ts`: Ana pays ¥900 in
  place of ¥1,200 for the small sencha, and a 10% code takes ¥90 off the
  company price; the large sencha, Bo and a guest keep the shop price.
  Cookies shipped to Singapore get the company's ¥300 as well. A customer
  in two companies, an unknown customer or variant, a zero price, a second
  company with the same id and a stale revision are refused. An inactive
  company, a member who leaves and a paused plugin give the shop price; Bo
  joins and gets the company price. Evidence:
  [company-prices.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-8/company-prices.json).

Built (slice 3, part 2, invoice terms; 2026-10-25, released 2026-10-25
15:51 UTC):

- A company can have `paymentTerms` (net days). Staff place a pickup draft
  order for its buyer on those terms (`place_draft_order_on_terms`): the
  order holds a captured payment of the amount due, as a paid draft does,
  so preparation and handover need no change, and a `company_invoice`
  (schema 77) is due after the net days. The invoice, not the payment,
  says whether the company paid.
- Staff record the bank transfer with its reference
  (`record_invoice_payment`, `invoice.paid`); the payment then gets a
  bank-transfer tender, so a later refund is resolved by Underclerk as a
  manual one. Until then a cancellation or a refund is refused
  (`invoice.unpaid`). The alarm marks a due open invoice overdue in a
  system commit (`invoice.overdue`).
- Exit journey `tests/invoice-terms-journey.test.ts`: ten tins placed on
  30 days' terms for the office's buyer, with the invoice due on day 30; a
  buyer without terms is refused; the order is prepared and handed over
  unpaid, while a cancellation and a refund are refused; on day 31 the
  invoice is overdue, once; a stale or unknown invoice and a second payment
  are refused; after the transfer a refund goes back as a bank transfer.
  Evidence:
  [invoice-terms.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-8/invoice-terms.json).

Release of 2026-10-25 15:51 UTC: Underclerk `c7c8f0ac` from dev
`fa6030d12`, schema 75 to 77, the Platform Workers unchanged (ref
`refs/backup/released-2026-10-25-underclerk-schema-77`). Before it, the 45
schema-75 databases that the journeys of dev `1c8b7b1b3` write were opened
with the new code: each upgraded to 77, matched a fresh schema-77 database,
and read its orders, drafts, events and catalogs. After it, the three
merchant objects upgraded on their first request (schema 77, 12 plugins,
the companies route answers); health 200 and 90 s tails of both Workers
with no exception. The live Platform client reads one entity type for each
merchant plugin and no `roundingIncrement` on a market order; neither
exists in production yet, and a Platform release removes the limit.

Open (slice 3):

- Terms at a buyer's own checkout (only staff place orders on terms), and
  shipping drafts on terms (draft orders are pickup only).
- Partial payments of an invoice, reminders to the company, and an
  invoice document (PDF).
- The order record does not name the company, and the company does not
  have locations or its own tax settings.
- Satyr has no company screens.

## Decisions

| Decision        | Recommendation                                                                                                                                                                                                                                                                                                                                                            | Cost                                                                                                                         | Default if no answer  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Repository      | Stay in this monorepo under `@underclerk/*` names, with a lint boundary. Move to its own repository after phase 5 if wanted.                                                                                                                                                                                                                                              | A separate repository now needs published `std`, `type-utils` and contracts packages and cross-repository E2E runs.          | Monorepo              |
| Order of work   | Plan 76A steps 1–3 first: the owner put them first, and they need no boundary work. Then phases 1–3. Then Plan 76A step 4.                                                                                                                                                                                                                                                | The separation waits. Each feature adds a few files to the 393 that import the shared client.                                | Plan 76A step 1 first |
| Payment model   | Stripe Connect with one connected account for each merchant, reusing the existing `STRIPE_CONNECT_*` setup. Square stays for in-person.                                                                                                                                                                                                                                   | Connect onboarding for each merchant; an application fee is possible.                                                        | Built in phase 3      |
| Schema baseline | Keep the production merchant data; one baseline equal to schema 66 (owner, 2026-10-22).                                                                                                                                                                                                                                                                                   | Merchants at another version are refused.                                                                                    | Built in phase 5      |
| Storage tiers   | Adopted by the owner on 2026-10-19. Use the five storage rules above. [Plan 76A](plan-76A-shopify-parity.md) step 5 builds the R2 archive.                                                                                                                                                                                                                                | One archive writer and one archive reader.                                                                                   | Adopted               |
| Cart storage    | No `CartDO`. Carts stay in the merchant object (storage rule 2). In the 300-buyer sale carts were 300 of 569 object requests at most 3 ms each, so one object serves at least 160 buyers a second. If a production sale keeps the object busy more than half the time, add a buy-now checkout with its lines inline first: one request instead of two, with no new class. | A `CartDO` costs a new class and migration, one more hop at checkout, a clean-up alarm for each cart and a change to rule 2. | No `CartDO`           |
| Catalog search  | Scan the snapshot at the Worker. Store normalized text in the snapshot past about 1,000 listings.                                                                                                                                                                                                                                                                         | 1.7 ms of Worker CPU for each search at 1,000 listings.                                                                      | Snapshot scan         |
| Phase 8 order   | Gift cards and store credit first (built), then B2B price lists with invoice terms, bulk CSV, subscriptions. Further gift card work deferred (owner, 2026-10-23).                                                                                                                                                                                                         | Each later slice waits; B2B buyers keep using draft orders with staff prices.                                                | This order            |
| AWS             | Deferred by the owner on 2026-10-23. Plan 77 step 0 keeps the core free of Cloudflare APIs, so another host stays possible.                                                                                                                                                                                                                                               | An AWS deployment waits; an actor host is about 2 weeks when it is needed.                                                   | Deferred              |

## Non-goals

- Themes, an online store editor, blogs and pages. Underclerk is headless.
- An app store or a public extension marketplace.
- Holding buyer funds. The payment provider holds funds.
- Shopify API compatibility. A Shopify import tool is a separate later plan.
- Multi-writer commerce state. Each merchant keeps one writer.
