# COM-03 — Providers and the read layer

This spec covers how commerce facts come into Purin Pantry and how people and Sous Chef
agents read them. A provider adapter turns the facts of one source into canonical
deliveries. The sources are the commerce engine of Purin Checkout, Shopify and the
commerce lab. `OrganisationActor` keeps the read copy (the projections) in its SQLite,
with receipts, tombstones and commerce cues. The graph reader answers queries: from the
engine for Purin Checkout, and from the read copy and the engine for Shopify. The
Products and Ingredients & supplies pages show one stock snapshot of the engine in two
views. The Shopify module has its own folder, so that a removal is one piece of work.
The commerce lab runs six deterministic scenarios with no provider credential.

## What it does

### The sources

| Source                               | `source` value | Path into the read copy                                                                                        |
| ------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------- |
| The commerce engine (Purin Checkout) | `commerce`     | The Platform reads the signed feed of the engine (COM-01) and applies each delivery                            |
| Shopify                              | `shopify`      | OAuth, signed webhooks, an initial snapshot and an order refresh, through `EVENT_Q`                            |
| The commerce lab                     | `lab`          | Signed scenario events through `EVENT_Q`, and governed lab actions                                             |
| Stripe                               | `stripe`       | None. The gateway refuses it (`commerce_delivery_provider_unsupported`). Stripe makes cue events only (COM-04) |

### The read copy

- COM-01 gives the delivery rules (`duplicate`, `out_of_order` and the conflicts).
- Each current record is one row in `commerce_projection`, with its kind, canonical id,
  revision, lifecycle and JSON. The 20 kinds are in `PROJECTION_KINDS`
  (`actors/commerce-projection/projection-kinds.ts`).
- The current revision of a record is the higher of its row and its tombstone. A
  `delete` removes the row and writes a tombstone at that revision. An older upsert is
  then `out_of_order`. A newer upsert removes the tombstone and makes the record again.
  "Same content" compares canonical JSON without `provenance.observedAt`.
- If a delivery applies a change, the actor builds the relation indexes of that
  integration account again. It also adds 1 to `accepted_projection_sequence` in
  `commerce_projection_watermark`. A query plan names this sequence.
- A feed drain that ends writes one row in `commerce_projection_sync`; it does not
  stamp each record. The `validatedAt` of a record is the later of the two times.
- Sync state: no record is `syncing`, a last sync older than 15 minutes is `delayed`,
  and otherwise `ready` (COM-01 shows it on the Integrations page).

### Commerce cues

- A delivery can carry cue facts: `payment_failed`, `inventory_shortage`,
  `order_unshipped`, `tracking_stalled`, `delivery_exception` and
  `cancellation_refund_proposed`. A delete delivery cannot carry them. The actor makes
  `inventory_low_stock` itself (COM-01 gives the rule).
- The actor writes each fact to `commerce_cue_outbox` as `pending`, one time for each
  native id. The caller sends it to `CUE_Q` and marks it `enqueued`.
- The five-minute feed read first refreshes the low-stock cue snapshot. A failure is a
  retry (`commerce_cue_snapshot_refresh_failed`). The read then takes at most 100 cues
  of the Organisation that are `pending`, or `enqueued` for more than 20 minutes
  (`COMMERCE_CUE_RESEND_AFTER_MS`). It sends again only the cues of the integration
  account of its feed message. A cue in `commerce_cue_settlement` does not go again.
- An engine feed delivery carries no cue facts. For Purin Checkout, only the low-stock
  rule of the actor makes cues. Only the lab deliveries carry cue facts. Each Shopify
  delivery carries none: the webhook sends its Shopify cue event (`orders/create`,
  `inventory_levels/update`) to `CUE_Q` directly, not through `commerce_cue_outbox`.

### Graph reads and queries

- The provider port gives a graph source. Purin Checkout is `commerce_engine`: the
  graph reader reads the engine only. Shopify is `provider_backed`: the reader reads the
  read copy (`BlotterSource`) and the engine. The engine gives the entity-plane records,
  for example lists and saved views.
- The reader plans each query with the TypeScript planner
  (`@purin-labs/commerce-contracts/query-planner`). The actor plans it again and refuses
  a plan that is different (`commerce_query_plan_invalid`). A plan with an old sequence
  is `commerce_query_plan_stale`.
- `@purin-labs/commerce-query-sqlite` compiles a plan to SQLite with bound values, over
  the views `commerce_entity`, `commerce_relationship_relation` and
  `commerce_entity_attribute_relation`.
- The compiler supports these predicates: all, entity, search, any, not, attribute
  (`is_empty`, `is_not_empty`, `equals`, `not_equals`) and relationship. It supports
  only the `count` aggregation. The order keys are `updated_at`, `display_name` and an
  attribute, with the last key `entity_id_ascending`; `created_at` is not an order key.
  A traversal step takes only the `all` predicate, and a list read or a list count
  refuses `search`. Another choice is `commerce_query_plan_unsupported`.
- The actor reads each row again and checks its revision and time. A difference is
  `commerce_query_relation_corrupt`. A cursor is `v1_` and hex text, at most 16 KiB.
- The result has the merchant revision, the entities, relationships, list entries,
  aggregations, the next cursor, a provenance and a freshness for each record. The
  freshness is `current`, `stale` (15 minutes after the later of `observedAt` and
  `validatedAt`) or `unavailable`.

### The inventory views

The Portal shows one engine stock snapshot (`readStockSnapshot`) in two pages.
`connectedStockOverview` (`services/platform/src/kitchen/contract/inventory-overview.ts`)
builds the rows. The read has no page and no cursor.

| Page                       | Path, group           | Rows                                                                   | Drawer actions                                                                                                                                              |
| -------------------------- | --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ingredients & supplies** | `/inventory`, Kitchen | `supply`: `ingredient`, `packaging`, `operating_supply`                | **Receive supplies**, **Count stock**, **Open purchasing**                                                                                                  |
| **Products**               | `/products`, Commerce | `product`, `unlinked_product`, and the untracked and archived products | **Count stock**, **Adjust stock**, **Request production** or **Link a recipe**, **Open product details**, **Open production requests**, **Open purchasing** |

- The item category of the record selects the page. A name never selects it.
- A `product` row is one finished-good position for each offered variant whose
  `direct` consumption plan at that location uses the item. If no offered variant
  makes a row, the position is `unlinked_product`, and the page shows **Product link
  missing**. That includes a finished good with a variant but with no offer or no
  direct plan. A position that only an archived variant consumes gets no row. An item
  with no position has one row, "No location recorded".
- An offered variant with no stock item shows **Stock tracking not configured**, or
  **Made to order** when it has an active `prepared` plan.
- The status is `uncounted`, `out`, `low`, `healthy` or `unconfigured`. `low` means
  that the available quantity is at or below the reorder point of the active
  `threshold` policy. `unconfigured` means no reorder point, or a unit of another
  dimension. The page shows `unconfigured` as "In stock".
- An `available_only` balance shows "—" in the table and "Not reported" in the drawer.
  The page shows "Reserved" for allocated finished goods.
- The available quantity comes from the usable stock of the engine. It leaves out
  expired and quarantined lots and subtracts the reservations.
- The drawer shows the lots, the 10 newest movements and the reservations (`held` or
  `allocated_to_order`). The Products page also shows price and unit margin from Costs
  & margins (KIT-04). The Products summary counts "Product shortages" (low and out).

The stock operations:

1. **Receive supplies** sends `commerce.receive-inventory.v3`. The receipt can name a
   replenishment entry of Purchasing at its revision. The engine checks the unit, the
   lot and expiry that the tracking needs, and a unique lot code. The position must be
   `accounted`.
2. **Count stock** and **Adjust stock** send `commerce.reconcile-inventory.v1`. A
   count gives the observed quantity. An adjustment is an increase (`correction`) or a
   decrease (`correction`, `waste`, `damage`) with an explanation of at most 1,000
   characters. The engine refuses each count and each adjustment on a position that
   is not `accounted`, for example an `available_only` position.
3. A count or a decrease that puts the on-hand quantity below the reserved quantity is
   refused with `inventory_count_shortage`. The engine writes no movement and keeps
   the reservations. The Portal shows the shortage.
4. **Request production** makes an entry in the engine list `production_requests`. Its
   state is `requested`, `accepted` or `scheduled`. The engine requires an active
   finished good, a position at an active location and an active `stocked` recipe. The
   page **Production requests** (`/production-requests`, Kitchen) accepts and
   schedules.
5. A completed production batch can name an `accepted` or `scheduled` request at its
   revision, with the same item, recipe revision, location and unit. The engine checks
   that the total yield of the batches of the request is not more than the request. A
   request alone changes no stock.

- Each command names the merchant revision and the revision of the position, item, lot
  or entry. A different revision is `stale_resource_revision`. The same
  `Idempotency-Key` gives the stored receipt again, and the engine refuses a receipt
  line that it applied (`inventory_receipt_already_applied`).
- After a command, the Platform records the receipt and queues a feed read. If the
  send fails, the five-minute read catches up.
- After a feed delivery with a movement, a position or a stock policy, the Platform
  runs the replenishment check of Purchasing (`reconcilePurchasing` in the engine). A
  request becomes `received` when the received quantity reaches the required quantity,
  `partial` when some quantity is received, and otherwise `late` after its delivery
  date.

### The Shopify module

The Shopify module is in `services/platform/src/shopify/`.
[REMOVE.md](../../../../services/platform/src/shopify/REMOVE.md) lists the steps of a
removal. Some Shopify code is outside the folder: the order refresh consumer in
`gateway/support.ts`, the Shopify cue event types and their parsers in
`cues/engine.ts`, and the onboarding Shopify cue subscription in
`actors/organisation/activation.ts`. REMOVE.md does not list the last two files.

Connection:

1. An admin starts the connection with a shop domain that matches
   `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`. Pantry uses the authorization-code flow
   ("legacy install flow" at Shopify), with no PKCE. The state ends after 10 minutes.
2. The callback checks the `hmac` parameter with `SHOPIFY_CLIENT_SECRET`. Pantry then
   gets the token and reads the shop identity. A partner development shop is
   `development`. If the shop environment or the myshopify domain differs from the
   attempt, Pantry refuses it (`provider_environment_mismatch`). A reconnect must name
   the same account, environment and shop (`provider_account_ineligible`).
3. Pantry stores the token in the Vault of the Organisation as a bearer secret. It
   registers the webhooks, and then stores `SHOPIFY_CLIENT_SECRET` as the `header`
   secret of `x-shopify-hmac-sha256`. A reconnect marks the old credential generation
   `superseded` and adds the next generation.
4. Pantry reads the initial snapshot and ends the attempt as `connected`.

- The requested scopes are `read_inventory`, `read_orders`, `read_products`,
  `read_publications`, `write_inventory` and `write_orders` (`SHOPIFY_SCOPES`). A write
  scope also grants its read scope. A missing scope is `provider_scope_missing`.
- Pantry registers each topic of the table below except `app/uninstalled`
  (`SHOPIFY_WEBHOOK_TOPICS`). If Shopify refuses an order topic (no protected
  customer data), the topic is `unavailable`. Another refusal stops the connection.
- `x-shopify-hmac-sha256` signs each body. A REST number id becomes a GraphQL GID
  (`gid://shopify/<Type>/<n>`) at the boundary.

| Topic                                | Result                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders/create`, `orders/updated`    | Queues `shopify.commerce_refresh.v1` with the Order GID. The consumer reads the full order and maps it with the snapshot mapper. `orders/create` also makes a cue event |
| `products/create`, `products/update` | Product, SellableVariant and InventoryItem observations. A variant with no SKU is left out                                                                              |
| `products/delete`                    | A canonical Product `delete`                                                                                                                                            |
| `inventory_levels/update`            | An `inventory_position` with an `available_only` balance, and a cue event                                                                                               |
| `app/uninstalled`                    | Revokes the account when the shop domains agree                                                                                                                         |

Initial snapshot:

- Pantry reads the catalog, the stock, the locations, the publications and the orders,
  in that order, in pages of 100 records and at most 100 pages.
- The locations need `read_locations` or `read_markets_home`, and the publications
  need `read_publications`. Without the scope, the read is `skipped_scope`.
- A failure logs `shopify.initial_sync_failed` with the resource and a reason code:
  `shopify_initial_sync_transport_failed`, `_http_failed` or `_response_invalid`.
- An order line with no SKU, an order with no line, or a fulfillment with no line
  stops the whole snapshot.

Mapping:

- A Publication GID is a `SalesChannel` of kind `online`. Pantry keeps only a
  publication that supports future publishing and has exactly one channel.
- An Offer id is `shopify:offer:<variantGid>:<publicationGid>`. Its price is the
  default variant price of the shop. It is `listed` when published, else `prepared`.
- A Fulfillment needs its GID, a Location GID, an estimated delivery time, lines and a
  state that maps. A Shipment needs exactly one tracking entry and a full event history
  that maps. Its id is `<fulfillmentId>/shipment/<encoded tracking number>`. Pantry
  makes no placeholder record when a fact is missing.
- A Shopify location goes to `shopify_location_observation` with the classification
  `pending` (`provider_location_kind_unmapped`). Only an `assigned` classification, with
  a `LocationKind`, makes a canonical `Location`. The canonical mapper refuses
  `pending` with `location_classification_required`.

Actions and health:

- Shopify executes only `cancel_order` (GraphQL `orderCancel`). Each other action kind
  is `commerce_action_provider_unsupported`. Its reconciliation is `settled` only when
  the order is cancelled with the same reason.
- A health check registers the webhooks again. It is degraded when `orders/create` is
  unavailable. The health view reads only the webhooks of the current credential
  generation.

### The commerce lab

- The lab runs only for an Organisation whose onboarding environment is `development`.
  Each other Organisation gets `commerce_lab_development_only`.
- **Seed** writes the lab marker and applies the catalog: 10 products and 14 variants
  (`COMMERCE_LAB_CATALOG_VERSION` `2026-08-09.1`). **Reset** deletes each row of a
  lab run (`lab_run_id`) and its cues, and keeps the seed rows.
- **Scenario** records a run in D1 and returns its events. The script signs and posts
  each event, and the queue applies it. The same idempotency key gives the same events.
- **Verify** completes each run that has all its receipts, projections and expected
  proposal cues. It reports the duplicate counts. `unauthorizedEffectCount` is always 0.
  The queue does not apply an event of a run that is not `running`.

| Scenario              | Result                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| `product-listing`     | A product listed at revision 2, and a stock position of 12                    |
| `happy-order`         | An order to `fulfilled`, a captured payment and a delivered shipment          |
| `payment-failed`      | A failed payment (`card_declined`) and a `payment_failed` proposal cue        |
| `inventory-shortage`  | An order of 20 against 12 available, and an `inventory_shortage` proposal cue |
| `shipment-delayed`    | A shipment in `delivery_exception`, and a proposal cue                        |
| `cancellation-refund` | A `cancellation_refund_proposed` proposal cue                                 |

A governed action on a `lab` record needs no credential. `publish_catalog_listing`,
`attach_tracking` and `cancel_order` work. Each other kind is
`commerce_action_path_invalid`. The lab makes the next revision from the current
projection and applies it at once, as the delivery `commerce_action_<nonce>`.

### Agents

The tools are in `services/platform/src/agent-tools/commerce/`. A turn offers a tool when
it holds the capability.

| Tool                            | Capability                      | Effect   | What it does                                                                                                                                                                            |
| ------------------------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce_entity_context`       | `commerce.entity_plane.context` | Read     | A graph query, depth at most 4 and at most 100 results                                                                                                                                  |
| `commerce_merchant_report`      | `commerce.entity_plane.context` | Read     | `open_orders`, `low_stock_exposure`, `payment_failures`, `fulfillment_exceptions`, `product_sales`. `low_stock_exposure` uses the rows of the inventory views                           |
| `commerce_propose_stock_action` | `commerce.action.propose`       | Proposal | `receive_stock`, `count_stock`, `adjust_stock`, `request_production`, `advance_production_request`, `update_purchase_request`. It runs the same engine commands after approval (COM-05) |

COM-04 and COM-05 own the other commerce read tools (`order_queue_read`,
`payments_read`, `sold_out_read`, `counter_sale_read` and the description draft).

## Contracts

- `OrganisationActor` SQLite (`actors/commerce-schema-baseline.ts`, frozen at projection
  version 16 and query version 5; `actors/commerce-projection.ts` adds version 17):
  - `commerce_projection`, `commerce_projection_tombstone`, `commerce_event_receipt`,
    `commerce_delivery_receipt`, `commerce_projection_watermark` and
    `commerce_projection_relation_text`;
  - `commerce_projection_sync` and `commerce_cue_settlement` (version 17);
  - `commerce_cue_outbox` and `commerce_lab_state`;
  - `commerce_relationship_relation_index` and `commerce_entity_attribute_relation_index`,
    with the views `commerce_entity`, `commerce_relationship_relation` and
    `commerce_entity_attribute_relation` (`actors/commerce-query-schema.ts`);
  - `shopify_location_observation` (`shopify/location-observation.ts`).
- Regional D1 (`migrations-regional/0001_current_schema.sql`): `commerce_lab_organisation`
  (the marker) and `commerce_lab_run` (`running`, `completed`, `failed`). The Shopify
  account, its credential generations and its webhook rows are integration records
  (INT-01).
- Queue messages on `EVENT_Q`: `commerce.delivery.v1` (with `labRunId` for the lab),
  `commerce.outbox_reconcile.v1` and `shopify.commerce_refresh.v1`.
- Ports: `CommerceProvider` (`commerce/contract/commerce-provider.ts`) with `kind`,
  `wire`, `graphSource`, `resolveActionCredential`, `executeAction` and
  `reconcileAction`; `commerceDeliveryIntake` (`commerce/contract/delivery-intake.ts`);
  `providerModules` (`integrations/contract/provider-modules.ts`). `worker-ports.ts`
  registers `shopifyCommerceProvider` and `SHOPIFY_PROVIDER_MODULE`.
- Packages: `@purin-labs/commerce-contracts` (`shopify-normalizer.ts`,
  `lab-normalizer.ts`, `inventory-overview.ts`, the query plan, cursor and result
  schemas), `@purin-labs/commerce-query-sqlite` and `@purin-labs/commerce-client`.
- Main files: `actors/commerce-projection.ts` and its folder,
  `actors/organisation/commerce-query.ts` and `organisation-commerce.ts`,
  `commerce/entity-plane/graph-reader.ts` and `blotter-source.ts`,
  `commerce/outbox-worker.ts`, `commerce-lab/`, `scripts/lab/run-commerce-lab.mjs` and
  `apps/portal/src/features/commerce/inventory*.tsx`.

The control routes are under `/v1/control/organisations/:id/`:

| Route                                                                | Role                             | Purpose                                                   |
| -------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `POST commerce/graph`                                                | Viewer                           | Up to 8 graph queries (`COMMERCE_GRAPH_QUERIES_TOGETHER`) |
| `GET commerce/graph/changes`, `POST commerce/graph/activity`         | Viewer                           | Engine changes, and the history of a record               |
| `GET commerce/inventory`                                             | Viewer                           | The rows of the two inventory views                       |
| `GET commerce/inventory/receipts`, `/reconciliations`, `/deliveries` | Viewer                           | The context of a receipt or a count, and the deliveries   |
| `POST commerce/inventory/receipts`, `/reconciliations`               | Operator                         | Receive, count or adjust stock                            |
| `GET commerce/inventory/production-requests`                         | Viewer                           | The requests, 100 for each page                           |
| `POST commerce/inventory/production-requests`                        | Operator; `setup` needs an admin | `setup`, `create`, `accept`, `schedule`, `link_recipe`    |
| `POST providers/shopify/start`                                       | Admin                            | Start the Shopify connection                              |

Other routes: `/v1/control/providers/shopify/callback` (the OAuth callback) and
`POST /hook/shopify/:organisationId` (the webhooks). The lab routes are
`POST /v1/admin/commerce-lab/:id/reset`, `/seed`, `/scenarios/:scenarioId`, `GET
/v1/admin/commerce-lab/:id/verify` and `POST /v1/hooks/commerce-lab/:id/events`. The
operator routes `/v1/admin/shopify-credential`, `shopify-connector`, `shopify-cues` and
`shopify-test-order` need `ORGANISATION_ADMIN_TOKEN`.

## Rules and limits

| Action                                                               | Viewer                         | Operator             | Admin and owner      | Agent         |
| -------------------------------------------------------------------- | ------------------------------ | -------------------- | -------------------- | ------------- |
| Read the graph                                                       | Yes, to sensitivity `internal` | Yes, to `restricted` | Yes, to `restricted` | Read tools    |
| Read the inventory views (no sensitivity level)                      | Yes                            | Yes                  | Yes                  | Read tools    |
| Receive, count or adjust stock; create, accept or schedule a request | No                             | Yes                  | Yes                  | Proposal only |
| Set up the production request list                                   | No                             | No                   | Yes                  | No            |
| Connect Shopify                                                      | No                             | No                   | Yes                  | No            |

An insufficient role on an inventory route gives 404. The one exception is a
production request `setup` from an operator: it gives 403 `forbidden`. Only a caller
with `ORGANISATION_ADMIN_TOKEN` runs the lab, and only on a `development`
Organisation.

| Limit                              | Value                   | Constant                                                                    |
| ---------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| Read copy is stale                 | 15 minutes              | `COMMERCE_PROJECTION_STALE_AFTER_MS`                                        |
| Cue resend                         | 20 minutes              | `COMMERCE_CUE_RESEND_AFTER_MS` (`CUE_CLAIM_ABANDONED_AFTER_MS` + 5 minutes) |
| Query page, traversal depth, seeds | 1 to 500, 0 to 8, 64    | `commerceQueryLimitSchema`, `query-limits.ts`, `graph-query-schema.ts`      |
| Cursor length                      | 16 KiB                  | `MAX_COMMERCE_CURSOR_LENGTH`                                                |
| Control read authority             | 60 s                    | A literal in `control/commerce-graph.ts`                                    |
| Expiring soon                      | 7 days                  | A literal in `inventory.tsx`                                                |
| Shopify OAuth state                | 10 minutes              | `SHORT_PROVIDER_STATE_TTL_MS`                                               |
| Shopify snapshot                   | 100 records, 100 pages  | `SHOPIFY_INITIAL_SYNC_PAGE_SIZE`, `SHOPIFY_INITIAL_SYNC_MAX_PAGES`          |
| Shopify Admin API version          | `2026-07`               | `SHOPIFY_ADMIN_API_VERSION`                                                 |
| Lab signature age                  | 300 s                   | `ingress.ts` of the lab                                                     |
| Lab scenario settles               | 90 s, read every 250 ms | `SCENARIO_SETTLEMENT_TIMEOUT_MS`                                            |

The read copy has no retention limit. A newer delivery changes or deletes a record.

- **Provider facts stay provider facts.** An adapter makes a record only from facts
  that the source gives. The read copy does not make Pantry the system of record.
- **Information flow.** An agent read enters the turn through
  `admitCommerceReadObservation` as an `integration_resource` observation (FND-07).
- **Lab signature.** A scenario event has `x-pantry-lab-timestamp` and
  `x-pantry-lab-signature`: HMAC-SHA-256 over `v1:<timestamp>:<body>` with
  `COMMERCE_LAB_SIGNING_SECRET`. A lab admin route answers 404 without the token.
- **Out of scope:** a desktop or file workspace; a rebuild of the read copy from the
  receipts; Shopify markets and contextual prices.

Neighbours:

- **COM-01** owns the domain records, the system selection and the delivery rules.
  **COM-02** owns the engine: its feed, its stock and production commands, its lists.
- **COM-04** owns payments, Stripe and Square. **COM-05** owns the governed action
  flows, Purchasing and the merchant brief. **KIT-03** owns recipes, **KIT-04** costs.
- **INT-01** owns the provider lifecycle, the connection attempts and the integration
  accounts. **FND-08** owns the Vault. **ORG-01** owns onboarding.

## Open work

- No route, tool or page assigns a Shopify location classification. Pantry never
  requests `read_locations`, so the location read is always `skipped_scope`. No
  canonical Shopify `Location` exists.
- Location updates, non-Online publications and market prices from Shopify are not
  built. Payments, fulfillment and shipments change only through the order refresh.
- The Shopify provider module lists capabilities for publish, tracking and list
  changes, but Shopify executes only `cancel_order`.
- No code builds the read copy again from the receipts. No Stripe delivery reaches the
  read copy. The provider-neutral actions
  `publish_offer`, `receive_inventory`, `purchase_shipping_label` and
  `advance_fulfillment` of Plan 9, and the `ProductView`, `InventoryView` and
  `OrderView` reads, are not built in the Platform.
- The lab has no provider state of its own. A lab action makes its observation from
  the current projection, with no signature.
- `pnpm lab:scenario` always runs `happy-order`. Another scenario needs
  `node scripts/lab/run-commerce-lab.mjs scenario <id>`.
- The inventory views have no reorder dialog (only a Purchasing link) and no pages.

## Sources

- [Plan 9](../../../history/plan-9-commerce-lifecycle-lab.md),
  [Plan 47](../../../history/plan-47-connected-inventory-views.md) and the
  [Shopify integration runbook](../../../integrations/shopify.md). Where they differ from
  the code, this spec follows the code. The Shopify failure codes are in
  [onboarding operations](../../../runbooks/onboarding-operations.md).
- The evidence of Plan 9 in the archive:
  [local loop](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-16-local-commerce-loop-2026-08-04.md),
  [NF9, MC0 and CK4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-14-nf9-mc0-ck4-local-2026-08-06.md),
  [Shopify production acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-ck4-shopify-production-acceptance-2026-08-08.md),
  [fixture manifest](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-9-16-ck0r-fixture-manifest-2026-08-08.json).
- The evidence of Plan 47 in the archive:
  [operations](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-47-inventory-operations-2026-10-01.md),
  [recovery](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-47-recovery-2026-10-02.md),
  [settlement](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-47-settlement-2026-10-02.md),
  [purchasing and query](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-47-purchasing-query-2026-10-02.md),
  [production recovery](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-47-production-recovery-2026-10-02.md),
  [schema 49 upgrade](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-47-schema-49-upgrade-2026-10-10.json).
- E2E journeys in `services/platform/tests/e2e/`: `commerce-lab.test.ts`,
  `commerce-feed-catch-up.test.ts`, `commerce-webhook-catch-up.test.ts`,
  `inventory-operations.test.ts`, `chat-agent-stock-report.test.ts`,
  `pi-stock-actions.test.ts`, `chat-agent-order-read.test.ts`,
  `chat-agent-order-lifecycle.test.ts`, `providers-connection.test.ts`,
  `providers-webhooks.test.ts` and `provider-removed-access.test.ts`.
- Journeys in `services/commerce/tests/`: `expired-lot-journey.test.ts`,
  `purchasing-replenishment.test.ts` and `food-service-entity-plane-journey.test.ts`.
- Scripts: `pnpm --filter @purin-labs/platform test:commerce-lab`, and `pnpm lab:reset`,
  `lab:seed`, `lab:scenario` and `lab:verify` (`scripts/lab/run-commerce-lab.mjs`).
