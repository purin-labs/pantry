# COM-02 — Commerce engine

The commerce engine is the headless commerce backend of Purin Checkout: the Worker
`pantry-commerce` in `services/commerce`. One SQLite Durable Object, `CommerceMerchantDO`,
holds the records of one merchant and is their only writer. Many operators can use one
deployment, because the URL and the credential name the merchant. The engine is a small
core and plugins. Built-in plugins ship with the engine. A merchant plugin is a record
that a Sous Chef agent or a developer writes at run time, and it runs in a sandbox with
no network. Pantry is one installed app, and the engine imports no Pantry package.
[The engine API contract](../../../../services/commerce/docs/spec.md) gives each route,
scope, event kind and state machine. This spec does not repeat it.

## What it does

### The core

- The core owns the merchant record, access, the ledger, the event feed, the archive,
  the catalog, inventory, checkout, orders, payments and fulfillment.
- A command commits the change, a signed receipt (`commerce.mutation-receipt.v2`) and a
  signed delivery (`commerce.commerce-delivery.v2`) in one transaction
  (`src/commerce-authority/ledger.ts`). Version 1 records stay as they were signed.
- Each lifecycle is data: 23 machines in `COMMERCE_MACHINES`
  (`packages/commerce-contracts/src/commerce-machines.ts`). A planner asks
  `commerceTransition`, and a forbidden move gets `invalid_transition`.
- The checkout pipeline has eight stages: `lines`, `market`, `discounts`, `tax`,
  `shipping`, `total`, `stored_value` and `amount_due`. Pickup and shipping checkouts
  run the same stages. COM-04 gives the payment and tender rules.
- After each request, the merchant object sends email, posts webhooks and runs due work
  (`runDueWork` in `src/http.ts`). Its alarm retries what is left and runs the daily
  archive. The Worker answers catalog reads, search and guest sessions from a snapshot
  in the Cache API.
- The due-work passes are plugin handlers, plugin failure reports, refunds due, terminal
  sales due, online payments due, lapsed checkouts, lot expiry and overdue invoices. A
  pass that fails runs again after at least one minute, and the other passes still run.
- After its first alarm, a merchant object with the R2 `BUCKET` keeps one alarm each day
  for the archive, also with no traffic. This is a recurring cost of each tenant.
- The merchant object also serves an MCP server (`src/mcp-server.ts`). Its tools call
  the same API, and it lists only the tools of the caller's scopes.
- `pnpm lint:commerce-spec` refuses a route, scope or event kind that the contract does
  not list, so a change updates the contract in the same commit.

### Built-in plugins

A built-in plugin keeps its code, routes, event kinds and tables in `src/plugins/<plugin>/`
behind an `index.ts`. `BUILT_IN_PLUGINS` (`commerce-contracts/src/commerce-plugins.ts`)
holds the definitions. The route table adds the plugin routes to the core routes.

| Plugin id                                      | Adds                                                                    | Needs       |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ----------- |
| `collections`, `media`, `markets`, `discounts` | Collections, product images in R2, market prices, discounts             | —           |
| `customers`                                    | Sealed profiles, sign-in with a six-digit email code, export, erasure   | —           |
| `draft_orders`                                 | Staff orders, invoice links, mark as paid                               | `customers` |
| `returns`                                      | Returns and exchanges; `returnWindowDays` (0 to 365, default 30)        | —           |
| `stored_value`                                 | Gift cards and store credit                                             | —           |
| `food_service`                                 | Stations, modifiers, recipes, menus, tickets, batches, the pickup queue | —           |
| `purchasing`, `production_demand`              | Entity-plane presets and the replenishment reconciler                   | —           |
| `companies`                                    | B2B prices (the `lines` step) and invoice terms                         | `customers` |
| `japan_export`                                 | The `shipping` step: routes from Japan, rates, tax, duty, labels        | —           |

- Each built-in plugin is active until the merchant pauses it. A pause closes its routes
  with 404 `plugin_paused` and skips its steps. Its data stays, and a resume restores it.
  A plugin that an active plugin needs cannot pause. A resume needs each plugin that it
  depends on to be active. A built-in plugin cannot be removed, only paused.
- The core reaches three plugins through `src/plugins/built-in-ports.ts`. The Worker
  passes `japan_export` in with its carrier key.

### Merchant plugins

A merchant plugin belongs to one merchant: a version record that never changes, and an
installation with settings. It needs at least one function, handler or action.

| Part                                                                | Runs                                                | Returns                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `checkout.validate`, `.lines`, `.discount`, `.tenders`, `.delivery` | In the checkout pipeline, inside the commit         | Refusals, lower line prices, amounts off, refused tenders, ready times |
| `machine.guard`                                                     | After a machine allows a staff move                 | Refusals (`transition_refused`)                                        |
| Event handler                                                       | After the commit, for each new event of its kinds   | Commands                                                               |
| Action                                                              | When a caller runs it by name (`run_plugin_action`) | Refusals or commands                                                   |

- A plugin can add settings, fields on products, variants and customers, and entity
  types. A function runs in QuickJS (`quickjs-wasi` 3.6.2) in a clean VM inside the merchant
  object. The clock is the request time and the random source is fixed. It has no
  network and no database. It returns operations, and only the core changes data.
- The quote records each run (`pluginRuns`), and the quote digest covers them.
- A function that fails is skipped and kept as a `plugin_failure` row. A required
  validation function refuses the checkout. A system commit reports each failure
  (`plugin.function_failed`). After three failures in a row, it pauses the plugin.
- Handlers and actions submit `create_discount`, `set_plugin_field_values` and
  `credit_store_credit`. The commands of one run apply together or not at all. Each
  receipt names the plugin as its `principal`. A handler does not run on the events of
  handler commands. A dry run and a preview over recent checkouts change nothing.
- In Pantry, the agent tool `commerce_propose_plugin` stages the governed action
  `install_merchant_plugin` (capability `commerce.plugin.install`). The approval signs
  the exact code. COM-05 owns that flow.

### Tenancy

- The merchant is the tenant. A merchant id matches `[a-z0-9][a-z0-9_-]{2,79}`
  (`src/merchant-id.ts`), and the Worker routes no other id.
- The operator sets `externalReference` one time at provisioning. Pantry puts the
  Organisation id there and keeps its own map (COM-01). The signed snapshot
  (`commerce.commerce-snapshot.v2`), receipts, deliveries and buyer tokens name only the
  merchant. The catalog snapshot (`commerce.catalog-snapshot.v1`) carries the
  `externalReference` as `organisationId`.
- The credentials are the operator token (`COMMERCE_SERVICE_TOKEN`), an API key
  (`uck_<id>_<secret>`) and an app installation token (`uca_<id>_<secret>`). The
  operator token is a Worker secret, and it opens the admin routes of every merchant.
- The merchant object checks each API key and app installation in its own SQLite, so a
  credential of one merchant never opens another. An API key secret is a SHA-256 hash,
  compared in constant time. An app token is an HMAC-SHA256 of the operator token, which
  the object computes again and compares in constant time. So a new operator token
  stops each earlier app token.
- A new API key gets only scopes that its creator holds. It never holds
  `payments:record` or `credentials:write`. It can have an `expiresAt`, after which it
  is refused.
- Each receipt names its `actor`. An app can name a person in the `Commerce-Actor`
  header. Pantry sends the member's person id on Portal changes
  (`commerce/contract/merchant-control.ts`) and approved agent actions.
  `commandRequest` (`src/http/admission.ts`) puts the merchant object's clock in each
  command as `requestedAt`, and it refuses a body that names it. The offer price policy
  routes take `occurredAt` from the caller.
- Merchant closure (`POST …/closure`) revokes each credential, webhook subscription and
  provider link. Pantry calls it when it purges an Organisation (COM-01). A closed
  merchant refuses each new credential, webhook subscription and provider link, and a
  repeated close answers with the first result.

## Contracts

| Package or folder                | Content                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/commerce`              | The Worker `pantry-commerce` on `commerce.pantry.purin.io`                                                                                  |
| `packages/commerce-contracts`    | TypeBox schemas, `COMMERCE_MACHINES`, `BUILT_IN_PLUGINS`, `COMMERCE_API_SCOPES` (FND-11)                                                    |
| `packages/commerce-client`       | `CommerceAdminClient`, `CommerceStorefrontClient`, `CommerceEntityPlaneClient`                                                              |
| `packages/commerce-query-sqlite` | The SQLite compiler of commerce query plans and the conformance corpus (`./normalized-conformance`) that the engine and the read copy share |

- Durable Objects `CommerceMerchantDO` and `CommerceShopNameDO` (CAFE-01). R2 `BUCKET`
  (`pantry-commerce-apac`) holds archive files and media.
- `src/schema.ts` builds the merchant SQLite from the core and each plugin, in a fixed
  order. `SCHEMA_VERSION` is 92, and a database at 66 or later upgrades in steps. The
  core keeps `plugin_state`, seven `merchant_plugin_*` tables and `plugin_failure`.
- Main files: `src/worker.ts`, `src/http-routes.ts`, `src/http/admission.ts`,
  `src/api-access.ts`, and `registry.ts` and `merchant-plugins.ts` in `src/plugins/`.
- Secrets: `COMMERCE_SERVICE_TOKEN`, `COMMERCE_BUYER_SESSION_SECRET`,
  `COMMERCE_SIGNING_PRIVATE_KEY_PKCS8_B64` (one Ed25519 key, `key_commerce_v1`, for all
  merchants) and `JAPAN_CARRIER_SIGNING_KEY`. Pantry's key routes are in
  `services/platform/src/control/routes/commerce-api-keys.ts`.

## Rules and limits

| Action                                                       | Engine access                             | Pantry role or agent                                               |
| ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------ |
| Provision, install an app, run the archive, close a merchant | `operator` (`src/api-access.ts`)          | Pantry only                                                        |
| Issue, list and revoke API keys                              | `credentials:write`                       | Owner or admin                                                     |
| Record provider results                                      | `payments:record`; never an API key       | Pantry only                                                        |
| Pause, resume or configure a built-in plugin                 | `settings:write`                          | No page, no tool                                                   |
| Install a merchant plugin                                    | `settings:write` and each command's scope | Agent proposal; an owner or admin approves, also from a Slack card |
| Run a plugin action                                          | `settings:read` and each command's scope  | —                                                                  |

| Limit                                                   | Value                                                    | Constant                                              |
| ------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Idempotency key, `Commerce-Actor`                       | 1 to 255, 1 to 200 characters                            | `src/http/admission.ts`                               |
| Function caps                                           | 1,000 interrupt checks, 16 MiB, 64 KiB output and source | `FUNCTION_CAPS`                                       |
| Failures before a pause                                 | 3 in a row                                               | `FAILURES_BEFORE_PAUSE`                               |
| Preview runs, handler runs in a pass, commands in a run | 200, 50, 5                                               | `PREVIEW_RUNS`, `HANDLER_RUNS`, `PLUGIN_RUN_COMMANDS` |
| Handlers, actions, fields, entity types                 | 10, 10, 20, 8                                            | The list schemas in `records/api-plugins.ts`          |
| Catalog snapshot                                        | 2 s                                                      | `CATALOG_SNAPSHOT_SECONDS`                            |
| Archive                                                 | Daily; orders after 180 days, events after 90            | `ARCHIVE_INTERVAL_MS`, `DEFAULT_ARCHIVE_OPTIONS`      |

- **Boundary.** `pnpm lint:runtime-boundary` refuses an engine import of a Pantry
  package, any other path to the engine than `commerce-contracts`, `commerce-client`,
  `commerce-query-sqlite` or the built Worker, a deep import of a plugin, SQL that
  names another plugin's table, and a Cloudflare API outside `worker.ts`,
  `durable-object-database.ts` and `catalog-snapshots.ts`.
- **Personal data.** Events, receipts and webhook posts carry identifiers. A plugin's
  customer field holds only an integer or a boolean, never text (`records/api-plugins.ts`).
- **Information flow.** An agent's plugin definition is Pantry output, so its check and
  its approval are in Pantry (FND-07, FND-06).
- **Out of scope.** Staff accounts with passwords, a merchant directory, a signing key or
  a rate limit for each merchant, themes, an app store, shared plugins, plugins that
  write data or open a network connection, and more than one writer.
- **Neighbours.** COM-01 owns the domain and the read copy rules, COM-03 the read layer,
  COM-04 payments and tenders, COM-05 the action flows, CAFE-01 menus and shop names.
  [Plan 90](../../../plan-90-cafe-pos-checkout.md) owns the Register and GMO `stera`.

## Open work

- Webhook posts through Queues are deferred. The merchant object posts after each command
  and retries from its alarm.
- A merchant plugin cannot read entity-plane queries: `requirements.reads` is refused.
- Not built: more plugin commands, a carrier-rate hook, prices above the catalog, plugin
  fields on orders, guards on more moves, and plugins copied to other merchants.
- The archive moves no command receipts, and it has no compaction and no key history.
- Not built: CSV import and export, subscriptions, a tax adapter, fulfillment orders,
  stock transfers and bundles. Gift card sales online and an AWS host are deferred.

## Sources

- [Plan 76](../../../history/plan-76-standalone-underclerk.md),
  [Plan 76A](../../../history/plan-76A-shopify-parity.md),
  [Plan 77](../../../history/plan-77-underclerk-modular-core.md) and
  [Plan 80](../../../history/plan-80-underclerk-multi-tenant-backend.md). Where they differ from
  the code, this spec follows the code. Plan 77 names `docs/evidence/plan-77-step-*` in
  the archive. Archive evidence of Plan 76:
  [standalone](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-1/standalone-underclerk.json),
  [API access](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-2/api-access.json),
  [app access](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-2/e2e-app-access.json),
  [schema baseline](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-5/schema-baseline.json),
  [flash sale](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-7/flash-sale.json),
  [gift cards](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-8/gift-card.json),
  [company prices](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-8/company-prices.json),
  [invoice terms](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-76-phase-8/invoice-terms.json).
- Journeys in `services/commerce/tests/` (`.test.ts`): `plugin-journey`,
  `merchant-plugin-journey`, `checkout-hooks-journey`, `plugin-handlers-journey`,
  `plugin-eviction-journey`, `state-machine-journey`, `request-shape-journey`,
  `merchant-keys-journey`, `credential-lifecycle-journey` and `flash-sale-journey`.
  The contract names the other journeys.
- E2E journeys in `services/platform/tests/e2e/`: `pi-merchant-plugin.test.ts`,
  `commerce-api-keys.test.ts`, `commerce-app-access.test.ts`,
  `commerce-feed-catch-up.test.ts`, `commerce-webhook-catch-up.test.ts` and
  `purged-organisation-commerce.test.ts`.
- Scripts: `pnpm commerce:verify-standalone` and
  `services/commerce/scripts/schema-upgrade-rehearsal.ts`.
