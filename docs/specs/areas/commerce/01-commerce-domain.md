# COM-01 — Commerce domain

The commerce domain is the common language for commerce in Purin Pantry. It also says
who owns each commerce fact. Each Organisation selects one commerce system: Purin
Checkout, which runs on the built-in commerce engine, or Shopify. The selected system is
the only writer of products, stock, orders, payments and fulfillment. Pantry keeps a read
copy, and the deliveries of the selected system update it.
People and Sous Chef agents change commerce through governed actions, with approvals and
receipts. Two storefront configurations and the buyer client Punter prove the model
through the public API.

## What it does

### One commerce system for each Organisation

- The kinds are `builtin_commerce` (Purin Checkout) and `shopify`. Their records have
  the source `commerce` or `shopify`.
- The Integrations page of the Portal shows the selected system: "Products, stock and
  orders" for Purin Checkout, or the Shopify shop domain. With no system, an admin gets
  the choice. Each other person reads "Choose Purin Checkout or connect a Shopify
  store."
- An admin selects the system. The request gives the revision that the admin read. If
  the current revision is different, Pantry refuses the request.
- A selection is possible while the onboarding of the Organisation is `draft` or
  `configuring`. After that, Pantry refuses a different system with
  `commerce_system_switch_requires_migration`. No mode writes products, stock, orders,
  payments or fulfillment to two systems.
- For Purin Checkout, a merchant binding connects the Organisation to one merchant of
  the engine. An Organisation has at most one binding for each environment
  (`development`, `production`).
- A Shopify selection also uses an engine merchant, for the entity-plane commands (a
  list entry or a saved view, for example). If the Organisation has no binding, the
  selection asks the engine for the merchant
  `merchant_entity_plane_<organisation part>`. It installs the app `pantry` and writes
  the binding `commerce_binding_entity_plane_<organisation part>`.
- An admin can make a demonstration shop. Pantry asks the engine for the merchant
  `merchant_pantry_<organisation part>` with the profile `cafe_patisserie` or
  `pantry_ecommerce`. Pantry then binds the merchant, selects Purin Checkout and queues
  a read. The Portal sends `cafe_patisserie` only.
- The Portal has no request that selects Purin Checkout with an existing binding
  (`select_builtin_commerce`). Its choice of Purin Checkout calls the demonstration
  route. That route selects with the same rule, so a new selection is possible only
  while the onboarding is `draft` or `configuring`.
- The card shows a sync state. `syncing` ("Syncing") means that the read copy has no
  record. `delayed` ("Behind") means that the last sync is older than 15 minutes.
  Otherwise the state is `ready` ("Up to date"). An admin can select **Sync now** for
  Purin Checkout. For an admin, the page also starts a sync when the copy is behind.

### Who owns each fact

| Fact                                                                                                                        | Owner                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The catalog, the stock ledger, carts, checkouts, orders, payments, preparation, fulfillment and shipments of Purin Checkout | The commerce engine (`services/commerce`). One `CommerceMerchantDO` holds each merchant                                                                                                                                                            |
| The same facts of a Shopify shop                                                                                            | Shopify                                                                                                                                                                                                                                            |
| Payment, address, tax, duty, carrier rate, label and tracking effects of Purin Checkout                                     | The provider that the engine calls. The engine keeps an attempt record for a payment, an address check, a shipping quote with its carrier rate, tax and duty parts, a label rate and a label purchase. It checks the signature of a tracking event |
| The read copy (projections) and its queries                                                                                 | `OrganisationActor` in the Platform (COM-03)                                                                                                                                                                                                       |
| Cases, proposals, approvals, actions and their receipts                                                                     | `CaseActor` and the action ledger in the Platform                                                                                                                                                                                                  |
| The selected system, the merchant binding and the capability activations                                                    | Regional D1                                                                                                                                                                                                                                        |
| Buyer contact and address data of Purin Checkout                                                                            | The engine only                                                                                                                                                                                                                                    |

Pantry does not become the system of record when it copies provider state. The engine
imports no Platform package. The Platform reaches the engine only through the packages
`commerce-contracts`, `commerce-client` and `commerce-query-sqlite`, and through the
Worker `pantry-commerce`. `pnpm lint:runtime-boundary` refuses another path.

A Shopify delivery has products, variants, stock items, locations, sales channels,
Offers, positions, orders, payments, shipping fulfillment and shipments. It has no
movement, lot, allocation, menu, recipe or stock policy. A Shopify position has the
balance `available_only`.

### The domain language

- A `Quantity` has an integer `amount`, a `scale` of 0 to 6 decimal places and a unit:
  `each`, `gram`, `kilogram`, `milliliter` or `liter`. An `each` quantity has scale 0.
- An `AvailableQuantity` can be negative. It is the quantity of an `available_only`
  balance. The Shopify normalizer makes that balance. The engine writes only `accounted`
  balances.
- `Money` has an integer `amountMinor` and a currency of three capital letters. A quote
  in a market currency keeps the rate that it used.
- A record of the read copy has a provenance. It names the Organisation, the integration
  account, the source, the resource type, the resource id and the revision. The source
  is `shopify`, `stripe`, `lab` or `commerce`.
- A provenance also has `occurredAt` and `observedAt`. The revision is not 0, and
  `observedAt` is not before `occurredAt`.

| Group        | Record                                              | States and branches                                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog      | `Location`                                          | Kind `store`, `warehouse`, `fulfillment_center`, `pickup_point`. `active`, `inactive`                                                                                                                                                               |
| Catalog      | `Product`, `SellableVariant`                        | A product has a title and a description. A variant has a `sku`, options and media (`image`, `video`, `model3d`)                                                                                                                                     |
| Sales        | `SalesChannel`                                      | Kind `online`, `point_of_sale`, `marketplace`, `agent`. `active`, `inactive`                                                                                                                                                                        |
| Sales        | `Storefront`                                        | Fulfillment `pickup` (location, lead time) or `shipping` (origin, shipping profile). Tax `percentage` (`added` or `included`) or `provider_quoted`. `active`, `inactive`                                                                            |
| Sales        | `Offer`                                             | One variant, one sales channel and one price. Availability `available`, `unavailable`, `backordered`. `prepared`, `listed`, `archived`                                                                                                              |
| Sales        | `Market`                                            | Countries, one currency and storefronts. Pricing `price_list` (a price for each variant) or `converted` (a rate and a rounding increment). `active`, `inactive`. A record of the engine (`src/records/api-markets.ts`); it is not a projection kind |
| Inventory    | `InventoryItem`                                     | Category `ingredient`, `packaging`, `finished_good`, `operating_supply`. `tracking` is `aggregate` or `lot_tracked` (expiry `required`, `optional`). `active`, `inactive`                                                                           |
| Inventory    | `InventoryConsumptionPlan`                          | Scope `organisation` or `location`. Mode `untracked`, `direct` (components, `commitOn`) or `prepared` (recipe revision). `active`, `inactive`                                                                                                       |
| Inventory    | `InventoryPosition`                                 | Balance `accounted` (`onHand`, `allocated`, `available`) or `available_only`                                                                                                                                                                        |
| Inventory    | `InventoryMovement`                                 | `increase`: `receipt`, `production`, `stock_count`, `correction`. `decrease`: `sale`, `preparation`, `production`, `stock_count`, `correction`, `waste`, `damage`                                                                                   |
| Inventory    | `InventoryAllocation`                               | `held`, `allocated_to_order`, `committed`, `released`, `expired`                                                                                                                                                                                    |
| Inventory    | `InventoryLot`                                      | Expiry `not_tracked` or `expires`. `available`, `depleted`, `quarantined`, `expired`                                                                                                                                                                |
| Inventory    | `StockPolicy`                                       | Replenishment `none` or `threshold` (reorder point, target quantity). `active`, `inactive`                                                                                                                                                          |
| Food service | `Menu`                                              | Scope `location` or `location_group`. Validity `always`, `window`, `schedule`. `draft`, `published`, `archived`. An entry names an Offer revision and a plan revision                                                                               |
| Food service | `ModifierGroupRevision`                             | Options with a price change and requirement changes (`add`, `reduce`). `draft`, `active`, `retired`                                                                                                                                                 |
| Food service | `RecipeRevision`                                    | Output `immediate` or `stocked` (item, yield). `draft`, `active`, `retired`                                                                                                                                                                         |
| Food service | `PreparationStation`, `PreparationTicket`           | Ticket: `queued`, `preparing`, `completed` (movement ids), `cancelled`                                                                                                                                                                              |
| Food service | `ProductionBatch`                                   | Planned and actual yield, input movements, one output movement, one output lot. Demand `stock`, `request`, `shipment`                                                                                                                               |
| Checkout     | `Cart`                                              | Lines `catalog` or `food_service`. `active`, `submitted`                                                                                                                                                                                            |
| Checkout     | `Checkout`                                          | Source `online` or `point_of_sale`. `quoted`, `payment_pending`, `accepted`, `expired`. Each state holds the quote                                                                                                                                  |
| Checkout     | `CheckoutPaymentAttempt`                            | `pending`, `processing`, `captured`, `declined`, `indeterminate`                                                                                                                                                                                    |
| Orders       | `CommerceOrder`                                     | Origin `online`, `point_of_sale`, `marketplace`, `agent`. Buyer `guest` or `identified`. `pending_confirmation`, `confirmed`, `fulfillment_pending`, `partially_fulfilled`, `fulfilled`, `cancelled`                                                |
| Orders       | `Payment`                                           | `pending`, `authorized`, `captured`, `failed`, `partially_refunded`, `refunded`                                                                                                                                                                     |
| Fulfillment  | `Fulfillment`                                       | `shipping`: `requested`, `preparing`, `blocked`, `handed_to_carrier`, `cancelled`. `pickup`: `requested`, `preparing`, `blocked`, `ready_for_pickup`, `completed`, `cancelled`. Also `local_delivery`, `immediate_handoff`, `on_premise`            |
| Fulfillment  | `Shipment`                                          | `first_party`: `ready`, `label_purchased`, `in_transit`, `delivered`. `external`: `label_created`, `in_transit`, `delivery_exception`, `delivered`, `returned`                                                                                      |
| Shipping     | `ShippingProfile`, `VariantShippingSpecification`   | Routes `domestic_japan`, `japan_to_singapore`, `international`. Eligibility `prohibited` or `physical`                                                                                                                                              |
| Shipping     | `ShipmentLabelRateSnapshot`, `ShipmentLabelAttempt` | Attempt: `requested`, `purchased`, `rejected`, `indeterminate`                                                                                                                                                                                      |

The contracts and the engine keep these rules:

- A stock item exists without a variant. A consumption plan connects a variant to stock.
- An accounted balance has one unit and one scale. `available` is `onHand` minus
  `allocated`, and `allocated` is not more than `onHand`.
- A cart line and a checkout line have a positive count of `each`.
- In a quote, a line total is the unit price times the quantity, minus the discount. The
  subtotal is the sum of the line totals. The total is the subtotal plus tax, duty and
  shipping. If the prices include the tax, the total does not add it.
- A shipping quote divides the carrier rate, the tax and the duty across the package
  lines. Each part names one line, and each line has one part. The parts of an amount
  add up to that amount.
- A `held` allocation belongs to a checkout line and ends with the quote. Its use comes
  after the order: `fulfillment_started`, `fulfillment_completed` or
  `preparation_completed`.
- The engine accepts a `direct` plan only with `commitOn: fulfillment_completed`. A
  `prepared` plan names an active recipe revision with `immediate` output. Only a
  `stocked` recipe makes a production batch.
- The engine takes stock from the lot with the earliest expiry first. It uses only
  `available` lots that are not expired.
- An accepted checkout names one payment: a payment attempt, a manual payment, or stored
  value that leaves no amount due.
- An order line has snapshots: the variant, Offer and plan revisions, the modifiers and
  the stock requirements.
- The engine has one Offer for each variant and sales channel.
- Only `shipping` has `handed_to_carrier`. Only `pickup` has `ready_for_pickup`.

### Deliveries and the read copy

- A canonical delivery has `schemaVersion: 1`, a provider delivery id and one or more
  observations. An observation id occurs one time in a delivery.
- An observation is `upsert` (one projection) or `delete` (the provenance of the
  record). The 20 projection kinds are the kinds of `CommerceProjectionKind`.
- For Purin Checkout, the engine signs each delivery with its Ed25519 key. The Platform
  checks the signature with the public key of the merchant binding.
- An engine delivery has entity-plane observations or canonical observations. The
  Platform refuses a delivery that has the two
  (`commerce_delivery_mixed_observation_categories`). Only a canonical delivery goes to
  the read copy.
- The engine posts each event to `POST /hook/commerce/:organisationId`. A post with a
  correct signature queues one read of the engine feed. A post carries no change.
- A post has the headers `x-commerce-timestamp` and `x-commerce-signature`
  (`v1=<hex>`). The signature is HMAC-SHA-256 over `<timestamp>.<body>`, with the
  secret of the subscription. The `merchantId` of the body must be the merchant of the
  binding.
- The Platform also reads the feed of each selected merchant every five minutes. This
  read finds a post that was lost. The same run keeps the webhook subscription `pantry`
  of the merchant, with the topic `*`. It deletes a subscription with an old address,
  takes a new secret when Pantry cannot open the kept one, and restarts a `failing`
  subscription.
- One feed read starts after the cursor of the consumer `pantry`. It takes at most 10
  pages of 100 events. The Platform settles each delivery: it moves the cursor past
  the delivery. It first marks a delivery that can never apply as rejected at the
  engine, with the reason. The deliveries after it continue.
- `OrganisationActor` applies one delivery in one SQLite transaction. The system kind,
  the system revision and the integration account must be those of the selected system.
- A repeated delivery with the same content is a `duplicate`. The same delivery id with
  other content is refused (`commerce_delivery_conflict`).
- An observation with a lower revision is `out_of_order`. The same revision with other
  content is refused (`commerce_revision_conflict`). A shipment that is `delivered` or
  `returned` does not change to another state.
- A decrease can take the available stock from above the reorder point to the point or
  below. An active `threshold` stock policy then makes one `inventory_low_stock` cue
  fact. The fact names the policy revision and the movement. No second fact follows
  until the stock recovers.

### Capability activation

- The capabilities are `core` and `online_commerce`, at the Organisation scope. A
  feature that asks for another capability or a location scope adds it to the type, the
  control route and the CHECK of `commerce_capability_activation`.
- An activation is `configured`, `active` or `inactive`. It records the system kind, the
  integration account, the system revision and a contract revision. An `inactive`
  activation has a reason.
- An activation is in effect only while the Organisation is active and the selected
  system is the recorded system, at the recorded revision.
- `core` and `online_commerce` are implicit: with no activation row, the admission
  passes. An activation row that is not in effect stops the admission.
- A governed action asks for one capability at the Organisation scope.
  `publish_catalog_listing` and `attach_tracking` ask for `online_commerce`. The two
  supplier payout actions ask for none. Each other action asks for `core`.

### Governed actions

A person or an agent proposes a change. The policy decides if a person must approve it.
The selected system then executes it and returns a receipt. The two supplier payout
kinds are different: the payout provider of the payout executes them, not the commerce
system. An action names the exact record and its revision. COM-05 gives the flow of each
kind. The action kinds are:

- Catalog and price: `publish_catalog_listing`, `update_product_description`,
  `adjust_offer_price`, `publish_cafe_menu`, `change_menu_price`.
- Orders: `cancel_order`, `refund_order`, `attach_tracking`.
- Stock and plugins: `stock_operation`, `install_merchant_plugin`.
- Supplier payouts: `submit_supplier_payout`, `resume_supplier_payout_funding`.

### Storefronts and Punter

- `apps/storefront` is one buyer application for each storefront configuration. It
  calls the public storefront API of the engine on its own origin.
- The café configuration is `storefront_cafe` ("Nuki Café"), with pickup. The shipping
  configuration is `storefront_cookie_store_sg` ("Nuki Cookie Post") at
  `/store/shipping`. Both demonstrations name the merchant `merchant_nuki_cafe_demo`.
- A build for one shop (`VITE_SHOP_MERCHANT_ID`) opens the café storefront of that shop.
  The path `/shops/<merchantId>` opens the published menu of a shop.
- The Worker `purin-shop` serves the application at `shop.purin.io`. It sends `/v1/*`
  and `/health` to the engine through a service binding.
- Punter (`scripts/punter`) is a buyer with no admin credential. `scenario:pickup` buys
  a sesame cookie and a sesame latte with oat milk: subtotal JPY 1,250, tax JPY 125,
  total JPY 1,375. `scenario:shipping` buys cookie boxes from Japan to Singapore with
  duty paid (`ddp`). It changes the quantity and the address before payment.
- Each Punter run prints one JSON evidence record. A failure gives exit code 1.

## Contracts

| Package or folder                                                | Content                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/commerce-contracts` (`@purin-labs/commerce-contracts`) | TypeBox schemas and parsers. `src/records/commerce-records.ts` has the records of this spec. `src/commerce-domain.ts` has their strict types. `src/commerce-canonical.ts` has the constructors with their checks. `src/records/api-markets.ts` has the Market. `src/shopify-normalizer.ts` and `src/lab-normalizer.ts` make canonical deliveries |
| `packages/contracts/src/commerce-system.ts`                      | `CommerceSystemKind` and the source of each kind                                                                                                                                                                                                                                                                                                 |
| `packages/commerce-client` (`@purin-labs/commerce-client`)       | `CommerceAdminClient`, `CommerceStorefrontClient` and `CommerceEntityPlaneClient`                                                                                                                                                                                                                                                                |
| `services/commerce`                                              | The engine Worker `pantry-commerce`. `docs/spec.md` is the contract of its API                                                                                                                                                                                                                                                                   |
| `apps/storefront`, `scripts/punter`                              | The buyer application and the buyer acceptance client                                                                                                                                                                                                                                                                                            |
| `areas/commerce/server/contract/`                                | The public files of the area in the Platform: the provider port, the delivery intake, the engine client, the queue messages                                                                                                                                                                                                                      |

- Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`):
  `organisation_commerce_system` has one row for each Organisation, with `system_kind`
  and `revision`. `commerce_merchant_binding` has the merchant id, the environment, and
  the id and the public key of the delivery key. `commerce_capability_activation` has
  the activations. `commerce_webhook_subscription` has the sealed secret of the webhook.
  In `scripts/layers.json`, the first two tables belong to `foundation/connections`.
- `OrganisationActor` SQLite (`actors/commerce-schema-baseline.ts` in the Platform):
  `commerce_projection`, `commerce_projection_tombstone`, `commerce_delivery_receipt`,
  `commerce_event_receipt` and `commerce_cue_outbox`. This spec gives the delivery
  rules. COM-03 gives the tables and the queries.
- Queue messages on `EVENT_Q` (`commerce/contract/queue-messages.ts`):
  `commerce.delivery.v1` and `commerce.outbox_reconcile.v1`. Appendix C of the engine
  API contract lists the event kinds of the engine (COM-02).
- The provider port (`commerce/contract/commerce-provider.ts`): each system kind gives
  one `CommerceProvider`. `commerce/commerce-providers.ts` holds the one list. The port
  has five methods: `wire`, `graphSource`, `resolveActionCredential`, `executeAction`
  and `reconcileAction`. Other code still branches on the system kind or its source,
  for example the sync route, the feed reader, the operations workbench and the
  integration discovery.
- The Platform calls the engine as the installed app `pantry`, with one installation
  token for each merchant (`commerce/contract/client.ts`). The token comes from the
  operator token and the Organisation. The Platform uses the operator token itself for
  these steps: it makes a merchant or a demonstration shop, installs the app `pantry`,
  reads the token of the active installation after a refusal, and closes each merchant
  at the purge. The key that seals the webhook secret (AES-GCM) also comes from the
  operator token.
- The main Platform files: `data/organisation-commerce-system.ts`,
  `data/commerce-merchant-binding.ts`, `data/commerce-capability-activation.ts`,
  `commerce/action-model.ts`, `commerce/provider-execution.ts`,
  `commerce/outbox-worker.ts`, `commerce/webhooks.ts` and
  `actors/commerce-projection.ts`.

The control routes (`areas/commerce/server/control/routes/commerce/system.ts`) are under
`/v1/control/organisations/:id`:

| Route                                                                    | Role   | Purpose                                                                                                                                                    |
| ------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /commerce-system`                                                   | Viewer | The selected system and its sync state                                                                                                                     |
| `PUT /commerce-system`                                                   | Admin  | Select Purin Checkout (`select_builtin_commerce`, `commerce_binding_id`) or Shopify (`select_shopify`, `integration_account_id`), with `expected_revision` |
| `POST /commerce-system/sync`                                             | Admin  | Queue a read of the engine feed. For Shopify, the answer is `commerce_system_sync_managed_by_shopify`                                                      |
| `POST /commerce-system/builtin-commerce/demo`                            | Admin  | Make and select the demonstration shop                                                                                                                     |
| `GET /commerce-capabilities`, `GET /commerce-capabilities/:activationId` | Viewer | Read the activations                                                                                                                                       |
| `POST /commerce-capabilities`                                            | Admin  | Configure an activation                                                                                                                                    |
| `POST /commerce-capabilities/:activationId/activate`, `/inactivate`      | Admin  | Change the state, with `expectedRevision`                                                                                                                  |

- Each `PUT` and `POST` is a control mutation with an `Idempotency-Key`. The same key
  with the same body gives the first answer again. The same key with another body gives
  `idempotency_key_conflict`.
- The action routes (`control/routes/commerce/actions.ts`) are `POST /commerce/actions`,
  `GET /commerce/actions/:nonce` (viewer), `POST /commerce/actions/:nonce/approval`,
  `/rejection` and `/execute`, and `GET /commerce/actions/:nonce/plugin-preview`.
- Agent tools (`areas/commerce/server/agent-tools/commerce/`): `commerce_entity_context`
  reads commerce records with the capability `commerce.entity_plane.context`.
  `commerce_propose_action` stages a governed action with `commerce.action.propose`. It
  writes to no provider. COM-03 and COM-05 give the other tools.
- The tool `integration_list` (capability `integration.discovery.read`) lists Purin
  Checkout as an account only when it is the selected system. It marks commerce data as
  readable only for the selected system. No tool gives the revision or the sync state.
- The capabilities are in `foundation/authority/authorization/capability-catalogue.ts`.
  A capability with the target `commerce_read`, `provider_resource` or
  `commerce_command` names what it needs: one of the two commerce systems,
  `builtin_commerce` only, or the Shopify provider. A `commerce.*` capability with the
  target `platform` can name no dependency, for example `commerce.menu_draft.edit` and
  `commerce.production_plan.edit`.

## Rules and limits

| Action                                                       | Viewer | Operator | Admin and owner                       | Agent                                                                      |
| ------------------------------------------------------------ | ------ | -------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Read the selected system and its sync state                  | Yes    | Yes      | Yes                                   | `integration_list` shows the selected system. No tool gives the sync state |
| Select the system, queue a sync, make the demonstration shop | No     | No       | Yes                                   | No                                                                         |
| Read the capability activations                              | Yes    | Yes      | Yes                                   | No tool                                                                    |
| Configure, activate or inactivate a capability               | No     | No       | Yes                                   | No                                                                         |
| Read one governed action in the Portal                       | Yes    | Yes      | Yes                                   | —                                                                          |
| Propose a governed action through the Portal route           | No     | No       | Yes                                   | `commerce_propose_action`, proposal only                                   |
| Approve, reject or execute a governed action in the Portal   | No     | No       | Yes. An approval also needs a step-up | No                                                                         |

| Limit                                | Value                                              | Constant                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quantity scale and amount            | 6 places, 9,007,199,254,740,991                    | A literal and `MAX_QUANTITY` in `quantity` (`commerce-canonical.ts`)                                                                                   |
| The read copy is `delayed`           | 15 minutes with no sync                            | `COMMERCE_PROJECTION_STALE_AFTER_MS`                                                                                                                   |
| Scheduled feed read                  | Every 5 minutes                                    | The cron `*/5 * * * *`, `runScheduledCommerceOutboxReconciliation`                                                                                     |
| Age of a webhook signature           | 5 minutes                                          | `SIGNATURE_TOLERANCE_MS`                                                                                                                               |
| Size of a webhook body               | 64 KiB                                             | `MAXIMUM_BODY_BYTES`                                                                                                                                   |
| One queued read includes later posts | 60 s                                               | `QUEUED_READ_MS`                                                                                                                                       |
| One feed read                        | 10 pages of 100 events                             | `FEED_PAGES_PER_RUN`, `FEED_PAGE` (`commerce/outbox-worker.ts`)                                                                                        |
| Age of the session for an approval   | 10 minutes                                         | `APPROVAL_STEP_UP_MAX_AGE_MS`                                                                                                                          |
| Quote of a demonstration storefront  | 600 s (café), 900 s (shipping)                     | `quoteTtlSeconds` in `services/commerce/src/plugins/food-service/cafe-scenario.ts` and `services/commerce/scripts/configure-plan22-phase4-shipping.ts` |
| Punter order poll                    | 30 times (pickup) or 60 times (shipping), each 2 s | `orderPolling` in `cli.ts` and `shipping-cli.ts`                                                                                                       |

The records of this spec have no retention limit. The selection, the binding and the
activations stay until the purge of the Organisation erases them.

- **Buyer data stays in the engine.** An order of the read copy has the buyer as `guest`
  or as a customer reference. A checkout has the contact only as SHA-256 digests. A
  shipping quote has the address as a protected reference, the destination country and
  a digest.
- **Private records.** A cart, a checkout, a payment attempt, a label attempt and an
  allocation are not projection kinds. They do not go to the read copy.
- **Information flow.** An agent read enters the turn through
  `admitCommerceReadObservation`, as an `integration_resource` observation. Its resource
  scope is `commerce_read:` and the scope of the grant. The canonical records of this
  spec have no sensitivity. An entity-plane value has one: `public`, `internal`,
  `confidential` or `restricted`. FND-07 owns the rules. `commerce.catalog.publish` and
  `commerce.catalog.update_description` show content outside the Organisation.
- **Approval step-up.** An approval in the Portal needs a control session that is not
  older than 10 minutes. It also needs a Google approval grant for the same user, the
  same Organisation and the same action. Without them, the answer is
  `approval_step_up_required`.
- **Money.** Eight commerce capabilities are never a standing permission: their modes
  are only approval required and disabled (`approval_required_disabled`). They are
  `commerce.offer.adjust_price`, `commerce.plugin.install`, `commerce.catalog.publish`,
  `commerce.catalog.update_description`, `commerce.order.cancel`,
  `commerce.fulfillment.attach_tracking`, `commerce.supplier_payout.submit` and
  `commerce.supplier_destination.activate`. The buyer payments of Purin Checkout run
  inside the engine. COM-04 gives the payment providers and the tender kinds.
- **End of an Organisation.** The purge closes each merchant of the Organisation in the
  engine before it erases the binding (`commerce/contract/merchant-closure.ts`).
- **Out of scope.** An Organisation does not use two commerce systems at the same time.
  Pantry does not move data from one system to the other. Purin builds no merchant web
  site: an operator builds the site on the engine API.

Neighbours:

- **COM-02** owns the engine: its API, its 23 state machines
  (`commerce-machines.ts`), its plugins, its tenants and
  [its API contract](../../../../services/commerce/docs/spec.md).
- **COM-03** owns the provider adapters, the read copy, its queries, the facts that
  make commerce cues and the commerce lab (`scripts/lab/`). **COM-04** owns checkout
  profiles and payments.
- **COM-05** owns the merchant operations: the governed action flows, the export
  catalog, suppliers and purchase requests, and the merchant brief.
- **CAFE-01** owns menus, boards, the order queue and the QR order pages.
  [Plan 90](../../../plan-90-cafe-pos-checkout.md) owns the Register and the
  `point_of_sale` checkout.
- **KIT-03** and **KIT-04** own recipe workflows and costs. Kitchen owns the execution
  of a procedure. The selected commerce system owns stock, lots, orders and fulfillment.
  [Plan 24](../../../plan-24-cafeos-bakery-automation.md) owns the cobot bake path.
- **FND-06** owns roles, approvals and the action ledger. **FND-11** owns the contract
  tools (`@purin-labs/contract-schema`).

## Open work

- The contracts have `local_delivery`, `immediate_handoff` and `on_premise` fulfillment
  and `marketplace` and `agent` order origins. The engine makes only `shipping` and
  `pickup` fulfillment, and `online` and `point_of_sale` orders.
- An Offer has no location scope and no validity time, and it names no Market. A Market
  gives the country prices. The source documents give an Offer for each country and
  location, with one rule that selects it.
- The source documents say that Pantry can build the read copy again. No code does
  this: a feed read starts after the cursor of the consumer `pantry`.
- Code outside the provider modules still branches on the system kind or its source.
  Step A2.5 of [Refactor 17](../../../refactor-17.md) owns these branches.
- The contracts have no unit conversion (`QuantityConversion`). Backorders in Purin
  Checkout are not built: an allocation cannot be more than the available stock.
- Planned and in-progress production batches are not built. A batch records a completed
  production only. A preparation ticket has no `blocked` state.
- A Plan 24 bake run increases the counter stock with a stock count change
  (`count_stock`). It makes no production batch and no lot.
- The Portal has no page for capability activations.
- A change of the commerce system after onboarding has no migration path.
- The Portal makes only the `cafe_patisserie` demonstration.
- `apps/storefront/wrangler.jsonc` says that the domain of the QR order pages is not
  chosen. No route sends an order page host to the Worker.

## Sources

- [Commerce domain architecture](../../../commerce-domain-architecture.md),
  [Commerce module, authority and runtime boundaries](../../../commerce-monorepo.md) and
  [Plan 22](../../../history/plan-22-commerce-capabilities-and-storefront-demos.md). Where they
  differ from the code, this spec follows the code. The evidence of Plan 22 in the
  archive:
  [production acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-22-production-acceptance-2026-08-12.md).
- E2E journeys in `workers/platform/tests/e2e/`: `commerce-feed-catch-up.test.ts`,
  `commerce-webhook-catch-up.test.ts`, `commerce-lab.test.ts`,
  `inventory-operations.test.ts` and `purged-organisation-commerce.test.ts`.
- Journeys in `services/commerce/tests/`: `punter-acceptance.test.ts` (the two Punter
  scenarios on a real engine with test providers), `commerce-authority.test.ts` (the
  typed commands), `lapsed-hold-journey.test.ts` and `expired-lot-journey.test.ts`. In
  `apps/storefront/tests/`: `storefront-cart-recovery.test.tsx`.
- Other tests in `workers/platform/tests/`: `organisation-commerce-system.test.ts`,
  `commerce-capability-activation.test.ts` and `pantry-commerce-demo-route.test.ts`.
  No file in `workers/platform/tests/e2e/` calls the selection route or the capability
  routes. The E2E fixtures write the selection row directly.
- Scripts: `pnpm --filter @purin-labs/punter scenario:pickup` and `scenario:shipping`,
  `scripts/patisserie/run-storefront-journey.py`, and in `services/commerce/scripts/`
  `rebuild-plan22-phase3-cafe.ts`, `configure-plan22-phase4-shipping.ts` and
  `seed-local-commerce.ts`. The commerce lab sequence (COM-03) is `pnpm lab:reset`,
  `lab:seed`, `lab:scenario` and `lab:verify`.
