# Plan 77 — Underclerk Modular Core and Plugins

Status (2026-10-26): closed. Every step is built and released, or deferred
by the owner with its reason:

| Step                                                   | State                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 0 Cloudflare APIs out of the core                      | Done, released                                                                       |
| 1 State machines                                       | Done, released                                                                       |
| 2 Payments module and checkout pipeline                | Done, released                                                                       |
| 3 Plugin contract and built-in plugins                 | Done, released (13 built-in plugins, settings, built tables)                         |
| 4 Merchant plugins: data, settings, checkout functions | Done, released                                                                       |
| 5 Event handlers and actions                           | Done, released (five commands per run, customer fields, one receipt per action call) |
| 6 Tables owned by each built-in plugin                 | Done, released                                                                       |
| 7 One type source                                      | Done as Plan 78 (TypeScript schemas, not Rust)                                       |
| 8 Runtime ties                                         | Done, released, with three items deferred (below)                                    |

Deferred: the old Square payment path's removal (it needs one real Square
payment, which waits for the café's business), GMO and the webhook queue.
Step 8 has the details.

Production since 2026-10-26: Underclerk `7fdb5083` (schema 79) from
`fed4f37c2`, and the Platform Workers from `703ac7bc9` (satyr-edge
`03522987`, released 04:27 UTC). Dev also holds commits of other sessions
that are not released (for example `9b5e2a540` and `8a82db8e1`). Each step's
section keeps its history and release records. On 2026-10-23 the owner
replaced feature manifests with a plugin system that agents can extend at
run time, kept step 5, and accepted the other defaults in Decisions.

## Goal

Make Underclerk a small core plus plugins. A plugin adds data, settings,
checkout rules, lifecycle rules, event handlers and actions. Built-in plugins
ship with Underclerk. A merchant plugin is a record in one merchant's
database: an AI agent writes it at run time from a merchant's requirement,
previews it on the merchant's recent records, and installs it with a receipt.
A merchant plugin needs no deploy. Merchants see no change in behavior until a
step says so.

The [Underclerk commerce spec](../../services/underclerk/docs/spec.md) states
the result of each step. This plan keeps the design and the reasons.

## Findings (2026-10-23)

| Area           | Today                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Payments       | Payment logic is in 22 files. Most is in `buyer-checkout.ts`, `after-sale-cancellation.ts`, `checkout-payment-planning.ts` and `commerce-authority.ts`. Many checks assume "one payment = the order total"; the gift card slice had to change about 10 of them.          |
| Checkout       | The planner calls discounts, markets and stored value directly. Discounts, markets and stored value work only for pickup checkouts, because each checkout kind has its own planner.                                                                                      |
| Composition    | `commerce-authority.ts` imports 54 modules and wires every feature by hand.                                                                                                                                                                                              |
| Central lists  | Each feature edits the route table, the command union in `ledger.ts`, the client's command and resource enums and the event map.                                                                                                                                         |
| Tables         | Every merchant gets one baseline of 45 tables. No feature owns its tables. Food-service data lives in a core table (`food_service_resource`).                                                                                                                            |
| Types          | Rust contracts generate 535 TypeScript type files, but `@underclerk/client` parses with 447 parsers written by hand (24,467 lines). 200 `V1` types exist only in TypeScript. Commerce types in Rust derive `Serialize` but not `Deserialize`.                            |
| State machines | `transitions.rs` applies observations and moves shipments. The order, checkout, payment and refund machines are not written down; each planner checks states in its own way.                                                                                             |
| Extensions     | Four fixed slots (food service, purchasing, production demand, regional shipping), each with its own interface. The same set runs for every merchant.                                                                                                                    |
| Run-time data  | The entity plane already lets an agent add custom entity types, fields on core records (12 value kinds), relationships and saved views at run time. Reads go through validated graph queries with a sensitivity limit. No code can be added at run time.                 |
| Sandbox        | Satyr's Code Mode runs agent-written JavaScript in QuickJS (`quickjs-wasi`, 288 KB compressed) with an instruction budget and a memory limit. A Worker cannot compile JavaScript or Wasm at run time, so an interpreter is the only way to run new code inside a Worker. |
| Runtime ties   | Other payment providers run through Satyr's `CafePaymentService` (the `PAYMENT_CAPTURE` binding). The merchant's alarm calls Satyr to read new events. Webhook posts run on the merchant's alarm.                                                                        |
| Host           | The core names Cloudflare runtime APIs in only 4 files, but every query uses a synchronous SQLite interface (475 calls). AWS is deferred (owner, 2026-10-23).                                                                                                            |

## Extensibility model

| System                     | How an extension is added                                                                                                                                                                                                         | Can an agent add one at run time?                                                                                  | Safety                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Shopify                    | Apps use the Admin API, metafields and metaobjects, webhooks and Flow. Functions (Wasm with a declared input query and typed output) change cart, discount, delivery and payment logic.                                           | Data and settings: yes. A Function ships with an app version (`shopify app deploy`), so it cannot be added by API. | Functions run in a sandbox with an instruction limit and no network.                                                          |
| Medusa                     | A plugin is an npm package with modules, data models, routes, workflows and subscribers, listed in `medusa-config.ts`.                                                                                                            | No. A plugin needs a build and a deploy, for one store for each deployment.                                        | Plugin code is trusted and has full access.                                                                                   |
| WooCommerce                | A PHP plugin adds actions and filters at hook points.                                                                                                                                                                             | An administrator installs a plugin at run time.                                                                    | Plugin code is trusted and has full database access.                                                                          |
| Chosen: Underclerk plugins | One plugin contract. Built-in plugins ship with Underclerk. A merchant plugin is a record that an agent writes through the API: data and settings (the entity plane), functions at typed hook points, event handlers and actions. | Yes, for each merchant, with a preview and a receipt.                                                              | Functions run in QuickJS with a budget and no network, clock or database. They return operations; only the core changes data. |

Reasons:

1. One deployment serves many merchants (one object for each merchant), so a
   merchant's plugins must be data in that merchant's database, not code in
   the deployment.
2. Agents operate Underclerk through governed actions. A plugin needs a typed
   definition, a preview that a person can approve, and a receipt.
3. A plugin must not weaken the ledger. A plugin cannot write data, so every
   change still goes through a core command with its checks and its receipt.
4. The run of a function must repeat exactly. The receipt keeps the input
   digest, the code digest and the output, so a replay or an audit gets the
   same result.

## Plugin model

### One contract, two kinds

|                   | Built-in plugin                                                   | Merchant plugin                                                                    |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Code              | TypeScript in `src/plugins/<plugin>/`, shipped with Underclerk    | JavaScript in the plugin record, run in QuickJS                                    |
| Written by        | Underclerk developers                                             | An agent or a developer, through the API, for one merchant                         |
| Can own           | SQL tables, routes, commands, events, pipeline steps and settings | Entity types, fields on core records, settings, functions, event handlers, actions |
| Turned on and off | For each merchant, through the plugin commands                    | Installed, paused and removed for each merchant, through the same commands         |
| Examples          | Discounts, markets, stored value, food service, purchasing, B2B   | "A whole cake needs 48 hours' notice", "Regulars get a code after 5 orders"        |

### A plugin definition

- **Identity.** An identifier, a version, a title and one sentence of
  purpose for the approval card. A version does not change after it is
  created.
- **Requirements.** What the plugin needs: the hook points that it uses, the
  data that each function reads (an entity plane graph query with its
  sensitivity limit), the commands that its handlers and actions can submit,
  and the entity types and plugins that it depends on. Underclerk computes
  the scopes from the requirements, so a plugin cannot declare less than it
  uses. An installation needs those scopes.
- **Contributions.** What the plugin adds: entity types and fields on core
  records (through the entity plane), a settings schema (with the entity
  plane's value kinds), functions, event handlers and actions.
- **Limits.** The instruction budget, the memory and the output size of each
  function, within the core's caps.

### Hook points

| Hook point          | Runs                                                     | A function returns                                                                   |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `checkout.validate` | In the checkout pipeline (step 2), inside the commit     | Refusals, each with a buyer message                                                  |
| `checkout.discount` | In the checkout pipeline                                 | Discount applications; the core checks the caps                                      |
| `checkout.delivery` | In the checkout pipeline                                 | Delivery and pickup options to hide, rename or reorder, and the earliest pickup time |
| `checkout.tenders`  | In the checkout pipeline                                 | Tenders to hide                                                                      |
| `checkout.lines`    | In the checkout pipeline                                 | Lines to add, merge or split, from existing variants at their offer prices           |
| `<machine>.guard`   | Before a transition of a state machine (step 1)          | A refusal with a reason, for example "the cake is in production"                     |
| Event handler       | After the commit, once for each event kind that it names | Commands                                                                             |
| Action              | When a caller runs the action by name, with typed input  | Commands, which the core applies together or not at all                              |

### Rules

1. A function reads only its input: the hook's input (for example, the quote
   so far), the plugin's settings, the results of its declared graph queries
   and the request time. It has no network, no clock, no random source and no
   database. The host replaces the clock and random calls of `quickjs-wasi`,
   and each run starts from a clean VM snapshot.
2. A function returns the operations of its hook's type. The Rust contracts
   validate them. Only the core changes data.
3. The quote or the receipt records each run: the plugin version, the code
   digest, the input digest and the output. The quote digest includes them.
4. If a function throws or goes past its budget, Underclerk skips it and
   writes a `plugin.function_failed` event. After three failures in a row,
   the plugin pauses. A merchant can mark a validation function as required;
   then a failure refuses the checkout.
5. A paused or removed plugin keeps its data. Its functions are skipped, and
   its handlers stop.

### Plugin commands for agents

- `GET …/plugins` lists every plugin of a merchant: kind, version, state,
  settings, requirements, contributions and spec section.
- `preview_plugin_change` checks a new version, an installation, an upgrade,
  a settings change, a pause or a removal. It returns the computed scopes. It
  runs each changed function over the merchant's last 200 checkouts and
  reports each outcome that changes. It changes nothing.
- `run_plugin_function` runs one function on a given input and returns the
  output and the instruction count. It changes nothing. An agent uses it to
  test a draft.
- `create_plugin_version`, `install_plugin`, `configure_plugin`,
  `pause_plugin`, `resume_plugin` and `remove_plugin` apply a change with an
  idempotency key and the expected revision. Each writes a receipt and an
  event.
- Satyr's Urk writes plugins through governed actions. The preview is the
  approval card, and the IFC check of a Satyr output applies to the
  definition.

## Steps

### Step 0 — Keep Cloudflare APIs out of the core

Status (2026-10-26): done and released.

- `pnpm lint:runtime-boundary` refuses a Cloudflare runtime API (Durable
  Objects, R2, KV, D1, Queues, the Cache API, `cloudflare:` modules) in
  Underclerk's source outside three adapter files: `worker.ts`,
  `durable-object-database.ts` and `catalog-snapshots.ts`.
- `PlatformPaymentGateway` now takes a small storage interface instead of
  `DurableObjectStorage`.
- Proof: the lint passes, and a Cloudflare type added to a core file makes it
  fail.

### Step 1 — State machines

Status (2026-10-26): done and released.

- Built: 16 machines in `src/commerce/machines.rs` (checkout profile,
  discount, checkout, payment attempt, payment, dispute, order, draft order,
  pickup and shipping fulfillment, shipment, refund attempt, return,
  customer, stored value account, webhook subscription), Rust state types for
  the six lifecycles that exist only in TypeScript, the generated tables,
  `commerceTransition`, the `invalid_transition` refusal and spec Appendix D.
- Proof: two conformance journeys, `state-machine-journey.test.ts` and
  `lifecycle-machine-journey.test.ts`, with the matrices in
  `docs/evidence/plan-77-step-1/` (152 cells probed; the rest named with the
  journey that drives them or the reason that none can). Checkout profiles,
  shipments, shipping fulfillments and webhook subscriptions are driven only
  by their existing journeys; their forbidden moves are not probed.
- Found on the way: a write that refused inside the commit transaction kept
  its earlier rows (an accepted checkout and an order with no receipt). The
  ledger now rolls the transaction back. No HTTP path reached it once the
  machines refuse placement of an expired checkout, so no journey proves it.
- Changed behavior: wrong-state refusals answer `invalid_transition` instead
  of `resource_relationship_invalid`, `checkout_quote_mismatch`,
  `invalid_command` (disputes) or `stale_resource_revision` (a label quote of
  a shipment that has a label). A carrier delivery cannot move a cancelled
  order. A discount or a gift card account is turned off once; a second
  request is refused. A buyer cannot refresh an expired checkout, and a
  balance is paid only while the order waits for fulfilment (both paths were
  unreachable).

Work:

- Write each lifecycle once in the Rust contracts as data: its states, its
  transitions (event, from, to) and named guards. Machines: checkout,
  payment attempt, refund attempt, order, pickup fulfillment, shipment,
  return, draft order, dispute, discount, stored-value account, webhook
  subscription, checkout profile revision and customer.
- A generator writes the TypeScript transition tables, and the state tables
  and Mermaid diagrams of the spec. The spec lint checks that the spec's
  tables equal the generated ones.
- Planners call one `transition(machine, from, event)`. A transition that the
  machine does not allow is refused with a typed `invalid_transition` error.
- Each guard is a hook point for plugins (step 4).

Exit journey: a conformance journey drives each machine through every allowed
transition over HTTP, and tries every forbidden transition that a caller can
ask for. The evidence is the transition matrix with each outcome.

Cost: about 1 week. Checkout, payment, refund and order come first, because
step 2 needs them.

### Step 2 — Payments module, tender model and checkout pipeline

Status (2026-10-26): done and released.

- Built: `src/payments/position.ts`. One tender position (amount, settled,
  reserved and refundable refunds, card or stored value) and the order
  balance replace the three earlier copies in the cancellation, refund and
  buyer view code. Every receipt and delivery that the suite writes (9,677
  rows) is the same before and after; three journeys with random gift card
  codes or tracking numbers match with those values masked.
- Built: the manual tender (schema 69, `src/payments/manual-tender.ts`).
  Staff mark a draft order as paid by cash or bank transfer
  (`POST …/draft-orders/:id/manual-payment`). The draft's checkout moves by
  the new `place_manually` event and records `manualPaymentId`; a refund or a
  cancellation of that payment resolves inside Underclerk. A checkout that
  the buyer is paying by card refuses the move, so a draft is never paid
  twice. Proof: `manual-tender-journey.test.ts`, evidence in
  `docs/evidence/plan-77-step-2/`; disabling the manual refund branch or the
  refundability check fails the journey. The capture comparison of every
  other test file is unchanged (two files match with random gift card codes
  and tracking numbers masked); the lifecycle journey gained the `mark_paid`
  cells.
- Built: the refund split (`src/payments/refund-split.ts`,
  `POST …/orders/:id/tender-refunds`). One refund runs over the order's
  payments: named tenders in the order given, or card and manual first and
  stored value last. Each part is an ordinary refund of one payment, so the
  existing reservation, provider call and replay hold for each part; the
  same request resumes after a refused part. Proof:
  `tender-refund-journey.test.ts` (evidence in
  `docs/evidence/plan-77-step-2/`); reversing the tender order or dropping
  the command's own parts from the plan fails it.
- Built, first slice of the checkout pipeline:
  `src/commerce-authority/checkout-pipeline.ts` holds the discount and
  stored-value stages. Pickup runs through them with the same bytes as
  before; shipping now runs them too. The discounted lines go to the
  shipping quote, so tax and duty are on what the buyer pays, and gift
  cards and store credit pay after shipping. A shipping quote that stored
  value covers is placed with its shipment through the stored-value route.
  The buyer's shipping command takes `discountCodes`, `giftCardCodes` and
  `storeCredit`; a refresh keeps what the quote holds. Proof:
  `shipping-tenders-journey.test.ts`; feeding the undiscounted lines to the
  shipping quote fails it. Every other test file writes the same receipts
  and deliveries (two noisy files match with random values masked).
- Built on 2026-10-25: a manual payment of an order's balance
  (`src/payments/order-manual-payment.ts`, `POST
…/orders/:id/manual-payment`, `record_order_manual_payment`, event
  `order.paid`). Staff record cash or a bank transfer for exactly the
  outstanding amount at the order's revision: a captured payment, its
  manual tender and a payment change that names no checkout, in one commit.
  It is refused while the buyer's card payment of a balance is in progress,
  and a balance checkout from an earlier order revision can no longer start
  a payment (`checkout_refresh_required`), so the buyer cannot pay the same
  balance again by card. Proof: `order-manual-balance-journey.test.ts`
  (evidence in `docs/evidence/plan-77-step-2/`); removing either guard fails
  it. The capture comparison of the other test files was not run; the whole
  suite passes.
- Built on 2026-10-25: counter checkouts through the shared stages. A
  counter sale takes `discountCodes` and runs the lines hook, the discount
  stage and hook, tax on what is paid, the delivery hook and the checkout
  rules; it holds discount uses and records plugin runs as an online pickup
  does. A basket with no code and no plugin quotes byte for byte as before.
  Drafts already ran the stages through the pickup planner at staff
  prices. Proof: `counter-stages-journey.test.ts` (evidence in
  `docs/evidence/plan-77-step-2/`); dropping the counter's discount hold or
  its validation stage fails it. Kept out: stored value at the counter
  (the terminal collection would need `amountDue`), and the balance
  checkout, whose one `order_balance` line takes no discount.
- Built on 2026-10-25: markets at shipping checkouts. A shipping checkout
  takes a market with a converted rate; a price list is refused, because
  the carrier, tax and duty quote in yen. The pipeline and the shipping
  quote run in the shop currency; at the end each unit price, discount,
  tax, duty and shipping amount is converted on its own and the totals are
  summed. The buyer's quote names the market, and the client reader and
  its schema copy convert each quote and match it with its total (Plan 78
  confirmed that Rust's `require_fulfillment_totals` is not live; Rust is
  unchanged). Journey `market-shipping-journey.test.ts`: Mei pays in SGD at
  0.0091 with 5-cent rounding, her card pays the SGD total, the order
  ships, and a price-list market is refused. A planner that leaves the
  shipping in yen fails the journey at the buyer reader.
- Built on 2026-10-25: the provider port and the payments move. The port
  is `PaymentProvider` in `src/payments/provider.ts` (`createSession`,
  `reconcile`, `refund`; a refund reads the provider's refund of an earlier
  try first). Stripe moved to `src/payments/stripe/` (payments, webhook
  verification, disputes), and the refund attempt and dispute records to
  `src/payments/payment-records.ts`. Stored value and manual tenders stay
  same-transaction refunds in the refund engine, as the refund rule above
  says, not provider adapters. The refund engine itself stays in
  `commerce-authority/after-sale-cancellation.ts` with the cancellations
  that it serves. No behavior changes; the whole suite passes.
- Built on 2026-10-25: the exit journey, on a pickup order because
  Underclerk edits pickup orders only (`mixed-tender-journey.test.ts`,
  evidence in `docs/evidence/plan-77-step-2/`). A gift card and a card pay;
  an edit raises the total and a bank transfer pays the balance; a ¥600
  refund goes to the card first and the transfer next; the bank disputes
  the card payment; staff cancel, naming the transfer, and everything goes
  back. At each point the order's balance equals the sum of its payments
  and refunds. The journey found two faults, now fixed: a dispute could not
  be recorded once an order had a later payment (it looked for the only
  payment that is not stored value) or an edit (it compared the order's
  total with the checkout's). Step 2 is complete.

Work:

- `src/payments/` owns payment attempts, tenders, captures, refunds,
  disputes, settlements, the refund engine and the provider port. Payments
  stay in the core.
- **Tender model.** An order has a list of tenders: `card` (a provider
  payment attempt), `stored_value` (a gift card or store credit account),
  `manual` (cash or bank transfer, for B2B invoices) and `balance` (a later
  checkout). One function, `paymentPosition(order)`, returns for each tender
  what it paid, what was refunded and what can be refunded, and for the order
  its total, paid amount, outstanding amount and refund due. Placement,
  payment start, capture, cancellation, refund reservation, disputes, buyer
  views and order balances all use it, and nothing else computes these
  amounts.
- **Refund engine.** One planner splits a refund over the tenders (rule in
  Decisions). It reserves, asks the provider, and resolves. An internal
  tender (stored value, manual) resolves in the same transaction.
- **Provider port.** `PaymentProvider` with `createSession`, `reconcile`,
  `refund`, `readRefund` and `verifyWebhook`. Adapters: Stripe (moved here),
  stored value and manual. Square and GMO follow in step 8.
- **Checkout pipeline.** A fixed, ordered list of typed stages: lines and
  prices, market currency, discounts, tax, shipping and duty, total, stored
  value, amount due. Each stage returns its part of the quote and the holds
  that it takes. One pipeline runs for pickup, shipping, draft and balance
  checkouts, so a feature works in every checkout kind at once. This closes
  the "pickup only" gaps of discounts, markets and stored value. In step 3 a
  built-in plugin adds its steps to a stage; in step 4 the hook points of
  merchant plugins sit between the stages.

Rules:

1. No stored byte changes. An existing quote keeps its digest.
2. A stage cannot read another stage's private state; it reads the quote so
   far.

Exit journey: a mixed-tender shipping order. A gift card and a card pay at
checkout; an edit raises the total, and a bank transfer pays the balance; a
partial refund splits over the tenders; the bank disputes the card part;
staff cancel the order. At each point the payment position equals the sum of
the recorded entries. The capture comparison of the existing suite stays
byte-equal (Plan 76 phase 5 slice 4).

Cost: about 2 weeks.

### Step 3 — Plugin contract and built-in plugins

Status (2026-10-26): done and released.

- Built: the plugin contract in Rust (`src/commerce/plugins.rs`: identity,
  requirements, contributions, limits, states) with serde `Deserialize`, and
  `built_in_plugins` as the one list; `scripts/generate-plugins.mjs` checks
  the set and writes `src/commerce-plugins.ts`. Eleven built-in plugins own
  their routes and checkout steps. Schema 70 keeps each merchant's plugin
  state; the `plugin` machine (active, paused, removed) moves it.
  `GET …/plugins`, the preview, `pause_plugin` and `resume_plugin` work as
  this step describes: a paused plugin's routes answer 404, its checkout
  steps are skipped, its data stays, and dependencies are checked. Exit
  journey 2 passes (`plugin-journey.test.ts`), with a second merchant that
  still issues gift cards. Every other test file writes the same receipts
  and deliveries.
- Built on 2026-10-24: eight built-in plugins keep their code in
  `src/plugins/<plugin>/` behind an `index.ts`: collections, media,
  markets, discounts, customers, draft orders, returns and stored value.
  `pnpm lint:runtime-boundary` refuses an import of a plugin's file from
  outside its directory, also from a test. The move changes no behavior;
  the whole Underclerk suite passes.
- Built on 2026-10-24: the four slots of `src/extensions.ts` are gone.
  Food service, purchasing, production demand and Japan export shipping
  live in `src/plugins/<plugin>/` too. The core takes the first three
  through `src/plugins/built-in-ports.ts` and their `index.ts`; a paused
  plugin closes its routes. Japan export shipping holds a carrier key, so
  the Worker still passes it in as the `shipping` option. Two tests of a
  core without an extension were deleted with the slots.
- Built on 2026-10-25: a paused food service shows buyers no menu, and the
  checkout planner refuses a menu line, also on the refresh of a quote from
  before the pause (`food-service-pause-journey.test.ts`).
- Built on 2026-10-26, slice 1 of the built tables: the route table. Each
  built-in plugin defines its routes in `src/plugins/<plugin>/routes.ts`
  (its route union and definitions, with `routeFor` from
  `src/route-definitions.ts`) and exports them from its `index.ts`. The
  core's table is its own routes plus `PLUGIN_ROUTES`; the registry stops
  Underclerk at start when a plugin's definition names other routes than its
  `routes.ts` defines, and the spec check reads the plugin route files. No
  two routes match the same path, so the order decides nothing: every one of
  the 187 routes parses its sample path as before, and Appendix A only
  changed its order. The whole Underclerk suite passes.
- Built on 2026-10-26, slice 2: the access table. Each plugin's
  `routes.ts` also lists its buyer routes and the scope of each admin route;
  the core joins them with its own, the types require every route to have
  its access, and the spec check reads them. Appendix A did not change, so
  every route keeps its access.
- Built on 2026-10-26, slice 3: the event map. Each plugin's `events.ts`
  names the event kind of each of its commands; the feed joins them with the
  core's, and the spec check reads them. Appendix C did not change.
  `mark_invoice_overdue` (a system command of the companies plugin with no
  route) stays in the core's map for now.
- Built on 2026-10-26, slice 4: the command union and the client enums.
  Each plugin's `index.ts` names the commands it commits, and the ledger's
  union is the core's commands plus `BuiltInPluginCommand` from the
  registry. `BUILT_IN_PLUGIN_RECEIPT_KINDS` in `@underclerk/contracts` lists
  each plugin's receipt command and resource kinds; the receipt schema's
  enums are the core's kinds plus those, and `commerce-data:check` refuses a
  kind that two plugins claim. The whole Underclerk suite passes.
- Built on 2026-10-26, slice 5: built-in plugin settings. Schema 79 adds
  `settings_json` to the plugin state (a table rebuild, so that an upgraded
  database matches a new one). `configure_plugin`
  (`PUT …/plugins/:pluginId/settings`, `settings:write`,
  `plugin.configured`) sets all of a built-in plugin's settings with its
  revision; a left-out setting goes back to the default. Each plugin gives
  its defaults and its own check (`returns/settings.ts`); the registry stops
  Underclerk at start when the defaults do not match the definition's
  settings. The list shows the settings with the defaults filled in, and a
  pause or a resume keeps them.
  The first setting is the returns plugin's `returnWindowDays` (0 to 365,
  default 30). Exit journey `plugin-settings-journey.test.ts`: a window of 2
  days refuses a return that 30 days takes. The rehearsal from schema 75
  (79 databases) has no problem and keeps every plugin state row.
- Built on 2026-10-26, slice 6: Japan export shipping is the 13th built-in
  plugin (`japan_export`, the `shipping` pipeline step, no routes of its
  own). The Worker still passes it in with its carrier key; the core gives a
  merchant the regional shipping only while the plugin is active. A paused
  plugin closes each shipping storefront to buyers and refuses a shipping
  checkout, also for a cart filled before the pause; placed orders keep
  their shipments. Exit journey `japan-export-pause-journey.test.ts`.
  Step 3 is done.

Work:

- Define the plugin contract (identity, requirements, contributions, limits,
  states) in the Rust contracts, with serde `Deserialize` from the start, in
  the form of step 7.
- The core keeps the ledger, the merchant record, access, the event feed, the
  archive, catalog, inventory, checkout, orders and payments.
- Each optional feature moves into `src/plugins/<plugin>/` as a built-in
  plugin: discounts, markets, collections, media, customers, draft orders,
  returns, stored value, food service, purchasing, production demand and
  Japan export shipping. The four slots of `src/extensions.ts` go away.
- The route table, the ledger command union, the client's command and
  resource enums, the event map and the spec appendices are built from the
  core and the plugins. `scripts/check-underclerk-spec.mjs` reads them.
- A plugin reaches the core or another plugin only through its `index.ts`.
  The boundary lint refuses a deeper import.
- The plugin records and commands for built-in plugins: `GET …/plugins`,
  `preview_plugin_change`, `configure_plugin`, `pause_plugin` and
  `resume_plugin`. A paused built-in plugin answers 404 on its routes, its
  pipeline steps are skipped, and its events stop. A change that breaks a
  dependency is refused.

Exit journeys:

1. The whole Underclerk suite passes, and every receipt and delivery that it
   writes is the same before and after, byte for byte.
2. An agent client lists the plugins of a merchant, previews a pause of
   stored value, and pauses it. The preview names the open balances. After
   the pause the gift card routes answer 404 and checkout ignores codes; a
   second merchant still uses gift cards. The agent resumes the plugin, and
   the balances are as before.

Cost: about 2 weeks.

### Step 4 — Merchant plugins: data, settings and checkout functions

Status (2026-10-26): done and released. Guards on more state moves are
not built, because no user needs them.

- Built: merchant plugin versions and installations (schema 71) with
  settings; `install_merchant_plugin` and `remove_plugin`; QuickJS
  (`quickjs-wasi` 3.6.2) behind `QuickJsFunctionRuntime`, with VMs that a
  request prepares before the synchronous commit (an `AsyncLocalStorage`
  scope carries them to the planner), a fixed clock and random source, a
  memory cap and a budget in interrupt checks; the `checkout.validate` hook
  at pickup and shipping checkouts with `checkout_refused` and the buyer
  message; `pluginRuns` on the quote (Rust contract), covered by the quote
  digest; skip and count failures, pause after three in a row;
  `run_plugin_function` and the preview over recent checkouts.
- Exit journey (`merchant-plugin-journey.test.ts`): the preview names the
  earlier order with three limited boxes; after the install a third box and
  a whole cake inside 48 hours are refused with the plugin's messages; the
  placed order keeps the same run; a looping version is stopped by its
  budget, checkouts go on, and the plugin pauses after three failures; a
  second merchant has no merchant plugin. Removing the validation stage or
  the failure count fails the journey. Every other test file writes the
  same receipts and deliveries.
- Measured in Node over 280 runs of the journey's function: VM start p50
  0.24 ms, p99 1.1 ms; run p50 0.07 ms, p99 0.15 ms. The Worker gains
  `quickjs.wasm`, 637 KB (288 KB gzipped), next to a 2.7 MB `worker.js`
  and 4.8 MB of existing Wasm. Worker numbers are not measured yet.
- Built on 2026-10-24: a pickup time that the buyer chooses (`pickupAt`,
  at least the lead time and at most 60 days ahead; a refresh keeps it).
  The journey's whole cake 24 hours ahead is refused by the plugin, one
  before the lead time by the core, and one 48 hours ahead passes. Kept as
  it is: VMs start for every write request of a merchant with an active
  plugin. A list of the routes that plan a checkout could miss one, and the
  start costs under 1 ms.
- Built on 2026-10-24: the failure event. The checkout's transaction keeps
  each failure (schema 73, `plugin_failure`); a system commit after the
  request, or from the alarm, reports it (`plugin.function_failed`), and at
  the third failure in a row a second one pauses the plugin
  (`plugin.paused`). The plugin list names the last failure. The pause no
  longer runs inside the checkout's transaction.
- Built on 2026-10-24: the `checkout.lines`, `checkout.discount`,
  `checkout.tenders` and `checkout.delivery` hooks, each with a typed output
  that the core checks (`src/plugins/checkout-hooks.ts`), at pickup and
  shipping checkouts. Journey `checkout-hooks-journey.test.ts`: two boxes
  cost 10% less, ¥500 comes off an order of ¥5,000 or more, gift cards do
  not pay for a whole cake, and a whole cake moves to 48 hours' notice and
  keeps that rule through a refresh; a plugin that raises a price is
  skipped and reported. A buyer's chosen pickup time is now kept in
  `checkout_pickup_choice` (schema 73), so a refresh no longer guesses it.
  Kept out: a delivery hook that changes the carrier rate (the shipping
  quote is stored with its tax and duty), and prices above the catalog's.
- Built on 2026-10-24: the `machine.guard` hook on staff moves in a request
  (order cancellation and refund, return authorization and rejection),
  with the `transition_refused` refusal (`src/plugins/machine-guards.ts`).
  Journey `machine-guard-journey.test.ts`: a cake order cannot be cancelled
  or refunded, return authorizations pause while a rejection goes through,
  a throwing guard is skipped and reported, and a required one refuses.
  Failures now name their hook point and subject.
- Built on 2026-10-24: plugin fields on products and variants. The install
  names them; `set_plugin_field_values` sets values on one record at its
  revision; only the plugin's own functions read them, as `productFields`
  and `variantFields` on each line (schema 73 `merchant_plugin_field`,
  `merchant_plugin_field_values`). Journey `plugin-fields-journey.test.ts`:
  a `whole_cake` variant field and a `notice_hours` product field move a
  cake's pickup to 48 hours; wrong kinds, unknown fields and records and a
  stale revision are refused; another plugin does not see the fields.
  Kept out: fields on other records (custom entity types came later, see
  below).
- Built on 2026-10-24: the flash sale with a plugin installed, in workerd.
  `flash-sale-journey.test.ts` runs the Plan 76 phase 7 sale twice: without
  a plugin, and with a `checkout.validate` plugin that allows at most two
  tins in one checkout. A cart of three tins is refused with the plugin's
  message, so merchant plugins run in workerd. In three runs of each, the
  outcomes are the same: 40 tins sold once each and 60 buyers refused at
  checkout. The plugin makes the merchant object slower under load: buyer
  p50 416–462 ms without it and 617–651 ms with it, p95 1,038–1,120 ms and
  1,242–1,563 ms. The cause is the VM that each write starts while about 100
  buyers wait in the merchant object's queue. Evidence:
  `docs/evidence/plan-77-step-4/flash-sale*.json`.
- Measured on 2026-10-24, in Node: a VM start takes 0.24 ms (p99 1.3 ms),
  and the tin function runs in 0.05 ms (p99 0.14 ms). The Worker is 4.1 MB
  of JavaScript and three Wasm modules, 2.2 MB compressed: `worker.js` 663 KB,
  the contracts Wasm 887 KB, the browser validator Wasm 344 KB and
  `quickjs.wasm` 288 KB. Plan 78 removes the two contract modules.
- Built on 2026-10-24, the Satyr part, first slice: the agent tool
  `commerce_propose_plugin` takes a plugin's title, purpose, settings and one
  `checkout.validate` function. Platform reads the plugin's current version
  and installation revision from Underclerk, runs the draft over the
  merchant's recent checkouts, and records the governed action
  `install_merchant_plugin` (verb `commerce.plugin.install`). The agent gets
  the preview counts, not the checkouts. The action path carries the whole
  definition, so the owner's approval signs the exact code and settings.
  Approval uses the existing step-up sign-in; execution installs the version
  in Underclerk with the action's idempotency key, and the receipt names the
  plugin (`projectionKind: "merchant_plugin"`). The Portal approval card
  shows the title, the purpose, each setting and the function source.
  Journey `services/platform/tests/e2e/pi-merchant-plugin.test.ts`: from a
  Slack mention, nothing reaches Underclerk before the approval, the
  installed plugin has exactly the approved function, a repeated execution
  replays the receipt, and version 2 is proposed against the installed
  revision in a later turn of the same thread and needs its own approval.
- Fixed on 2026-10-24: an agent commerce proposal in a later turn of a
  Slack thread was refused, because an assignment keeps its first start
  across the turns of a thread. The proposal now names its own turn for the
  flow-binding check and rests on the Case revision that the turn reads. The
  journey proposes version 2 in a later turn of the same thread.
- Built on 2026-10-24: the approval link. Every agent commerce proposal
  returns `approval.portalUrl`, which opens the action's approval card on
  the Portal's Operations page (`?commerceAction=<nonce>`), with an
  instruction to give the person that link. Urk's reply carries it into the
  Slack thread through the reply's own information-flow check. The approval
  stays in the Portal, because it needs the step-up sign-in.
- Built on 2026-10-24: guards on more staff moves. An order's edit,
  exchange and pickup readiness now run `machine.guard`, and the order that
  a guard reads holds its fulfillment's `expectedBy`. The machine guard
  journey adds: a whole cake for the day after tomorrow is not made ready
  ("at most 4 hours before its pickup") and not edited, and the order does
  not change. The exchange guard has no journey step, because the journey's
  only return is rejected.
- Built on 2026-10-24: entity types from a plugin
  (`src/plugins/plugin-entity-types.ts`, schema 74
  `merchant_plugin_entity_type`). The install names one type in
  `contributions.entityTypes` and describes it in `entityTypes` (up to 20
  attributes of five simple kinds). The installation publishes the type in
  the entity plane in its own commit, records the plugin as the owner and
  writes the type to the entity plane's change feed. Staff add records
  through the entity plane; the plugin's functions, handlers and actions
  read the active ones as `records`. A version with other attributes
  publishes the type's next revision, and records keep their own revision.
  A type that the merchant or another plugin made is refused. The type and
  its records stay when the plugin is removed. Journey
  `plugin-entity-types-journey.test.ts` (evidence
  `docs/evidence/plan-77-step-4/plugin-entity-types.json`): a closure day
  that staff add refuses a pickup with its reason, an action reads the
  same closure, archiving it reopens the day, and version 2 keeps the
  revision-1 closure. Removing the records input, the ownership check or
  the unchanged-type check fails the journey.
- Built on 2026-10-25: up to eight entity types for each plugin, each with
  a different type id. Schema 76 removes the one-change-per-revision rule
  from the entity plane's change feed (the table is rebuilt and keeps its
  rows), and a page of the feed always holds whole revisions. The journey
  now installs a closure day and a pickup notice in one version and reads
  both changes in a page with a limit of one; a page that splits a revision
  fails it. Urk's tool, the action path and the Portal card take a list
  `entityTypes`. The upgrade from schema 74 to 76 was rehearsed on the 34
  live merchant databases: each upgraded and kept its change rows.
- Built on 2026-10-25: a fixed Slack approval notice. When an agent's
  commerce proposal waits for approval, the Case adds a second output in
  the same revision as the wait (source `commerce_approval_notice`, a new
  variant in the TypeBox schema `caseContributionSourceSchema` of
  `packages/contracts/src/case-output.ts`; Rust is unchanged). The proposal
  path posts it at once through `deliverCommerceCaseOutput`, the delivery
  that commerce outcomes now share: the request's live authority and the
  conversation flow check of the proposal's binding come first. Only a
  Slack thread gets one. The text names the change (for a plugin, its title
  and version) and the approval card's link, or "under Operations in the
  Portal" without Portal handles. A notice that cannot be posted is logged
  and the proposal stands. Journey `pi-merchant-plugin.test.ts` checks one
  notice for each proposal with its action's link; without the notice it
  fails. Not added: a denied-flow journey for the notice (it uses the same
  check as outcomes, which has none either).
- Built on 2026-10-25: a live preview on the Portal approval card. When an
  owner or admin opens the card of a plugin that waits for a decision, the
  Portal reads `GET …/commerce/actions/:nonce/plugin-preview`. Platform runs
  the proposed checkout functions, from the action path, over the shop's
  recent checkouts as they stand now, and the card lists each refusal
  message with the number of checkouts that it would refuse, and each
  failure. It shows no checkout ids. A plugin with no checkout function
  shows nothing. Journey `pi-merchant-plugin.test.ts` now opens the cafe
  demo shop with one pickup checkout of a cookie (15 minutes' notice): the
  card of version 1 refuses it with the 48-hour message and the card of
  version 2 with the 72-hour message. A route that drops a refusal fails
  the journey. The card was not checked in a browser.
- Built on 2026-10-25: Urk's proposal tool takes the whole plugin (see step
  5): event handlers, actions, the commands they may submit, and one entity
  types, with the checkout function optional.

Work:

- Keep plugin versions and installations in core tables of each merchant's
  database.
- Run functions in QuickJS (`quickjs-wasi`) inside the merchant object,
  synchronously, behind a `FunctionRuntime` port. The port keeps a separate
  sandbox Worker possible (Decisions).
- Check the requirements, compute the scopes, and create the entity types,
  fields and settings that a plugin adds.
- Connect the hook points of the checkout pipeline and the guards of the
  state machines.
- Add `preview_plugin_change` over recent checkouts, `run_plugin_function`,
  and the commands that create, install, upgrade and remove a merchant
  plugin.
- Satyr part: an Urk governed action prepares a plugin from a merchant's
  requirement and shows its preview as the approval card in Portal and
  Slack.

Exit journey: the merchant's requirement is "A whole cake needs 48 hours'
notice for pickup, and a buyer can buy at most two boxes of a limited
edition." An agent client writes one merchant plugin: a `whole_cake` field
on products, a setting for the notice hours, and one `checkout.validate`
function.

- The preview over recent checkouts names the checkouts that the plugin
  would refuse.
- After the installation, a pickup in 24 hours is refused with the plugin's
  message, a pickup in 48 hours passes, and a third box is refused.
- A new version with an endless loop is stopped by its budget. The checkout
  goes on, the failure event is written, and the plugin pauses after three
  failures.
- A second merchant has no plugin and sees no change.
- A replay of a placed order's receipt gets the same function output.
- The flash-sale journey of Plan 76 phase 7 keeps its numbers with the
  plugin installed.

Measure: the VM start time, the function run time at p50 and p99, and the
Worker size.

Cost: about 2.5 weeks, plus 2 to 3 days for the Satyr part.

### Step 5 — Merchant plugins: event handlers and actions

Status (2026-10-26): done and released. The first slice was in production since 2026-10-24
07:03 UTC (Underclerk `65990534`).

- Built: handlers and actions that the install names (schema 73
  `merchant_plugin_handler` with a cursor, `merchant_plugin_action`);
  handler passes after each request and from the alarm, at most 50 runs,
  that read the event and its order with the buyer's `placedOrders`; the
  `run_plugin_action` route with typed inputs and `action_refused`; the
  commands `create_discount` and `set_plugin_field_values` (the plugin's
  own values, at the current revision), applied through the staff path inside a
  principal scope, so its receipt names the plugin (`principal`); a command
  outside the requirements is a `refused` failure; the installer and the
  caller of an action need each command's scope. A handler skips the
  events of handler commands, so no chain starts.
- Journey `plugin-handlers-journey.test.ts`: a signed-in buyer's fifth
  order gives one 10% one-use code (guest and later orders do not, nor a
  pass after a lost cursor); the code takes ¥120 off the next order once;
  a ¥500 apology code names the action as its principal and a retry gets
  the same receipt; above the ¥1,000 cap, an unknown order, a wrong kind or
  an unknown input change nothing; a version without `create_discount` in
  its requirements has both commands refused and reported; a key without
  `discounts:write` cannot install or run the action.
- Journey `plugin-limited-edition-journey.test.ts`: a `remaining` variant
  field that staff set to 3; the plugin's checkout function refuses more,
  and its handler counts each order down (2, then 1, then sold out). A pass
  after a lost cursor answers with the first count; staff restock and the
  next buyer gets one; a key without `catalog:write` cannot install it.
  The count is not a stock hold: the handler runs after the commit.
- Built on 2026-10-25: up to five commands in one run, all or none. The
  core applies them inside one outer transaction; each command still
  commits through the ledger with its own receipt and event, as a
  savepoint (workerd's `transactionSync` nests; the Node test database now
  nests with `SAVEPOINT` too). The first command keeps the run's key and
  later ones add `_2`, `_3`, so the receipts of single-command runs keep
  their keys. A refused command undoes the ones before it; an action then
  answers `action_refused` with `Command 2 (create_discount): …`, and a run
  of one command keeps the core's own refusal. Journey
  `plugin-run-commands-journey.test.ts`, in workerd (evidence in
  `docs/evidence/plan-77-step-5/`): `make_amends` gives
  ¥300 of store credit and a 10% code in one call, a retry replays, and a
  call whose code is taken gives the second customer no credit. Without the
  outer transaction the journey fails. Not built: one receipt for the whole
  action run (the call answers with the last command's result).
- Built on 2026-10-26: plugin fields on customers (schema 78 rebuilds the
  two field tables with `customer` in their CHECK; every row is kept). A
  customer field is an integer or a boolean. A plugin names the customer by
  an order and reads the values as the order's `customerFields`, so it
  never holds a customer id, and an erasure deletes them. Journey
  `plugin-regulars-journey.test.ts` is the exit journey's regular: Mio's
  fifth order marks her as a regular and gives one 10% code in one run, an
  action reads the mark from any of her orders and not from a guest's, a
  text field on customers is refused, and her erasure removes the mark.
  Without the erasure hook, or without the customer read, the journey
  fails. The 75→78 upgrade was rehearsed on the 79 databases of the
  75→77 rehearsal. Customer fields at checkout functions: built on
  2026-10-26. A plugin with fields reads its values on the signed-in buyer
  as `checkout.customerFields` (`{}` for a guest); it never reads the
  customer id. The regulars journey's rule sells the large tin to regulars
  only: Mio cannot buy it before her fifth order, can after it, and a guest
  never can. A draft's preview gives each checkout empty customer fields.
- Built on 2026-10-26: Urk proposes fields. `commerce_propose_plugin` takes
  `fields` (up to 20, on products, variants or customers; a customer field
  is an integer or a boolean), the approval card lists them, and the
  approved installation sends them. A draft that breaks a rule now tells
  the agent which part to correct (`commerce_action_invalid` with the part)
  instead of the generic "data unavailable" text. The third turn of
  `pi-merchant-plugin.test.ts` proposes a text note on customers, gets the
  refusal, and then proposes a `regular` mark that Underclerk installs.
- Built on 2026-10-25: the `credit_store_credit` command and dry runs of
  draft handlers and actions. The command credits an order's customer in
  the order's currency, so a plugin cannot credit an arbitrary customer;
  the installer needs `stored_value:write`. `run_plugin_function` also takes
  draft `handlers` and `actions`, runs the one named, and lists each
  command that it would submit with `accepted` and the reason; nothing is
  applied. Journey `plugin-loyalty-journey.test.ts` (evidence in
  `docs/evidence/plan-77-step-5/`): the dry run shows the credit and two
  refusals; the handler credits ¥300 at every third order, a lost-cursor
  pass credits nothing new, the buyer pays with the credit, and a goodwill
  action credits an order's customer (also a guest's email customer).
  Removing the requirements check from the dry run fails it.
- Built on 2026-10-25, the Satyr part: `commerce_propose_plugin` takes
  `functionSource` (or null), `commands`, `handlers`, `actions` and an
  `entityTypes` (up to eight; an empty list adds none). The action path carries the whole definition, so
  the approval signs every part; a plugin with only a checkout function
  keeps the earlier path bytes. The installation sends the handlers,
  actions and entity types with the definition, and the checkout preview
  runs only when there is a checkout function. The Portal card shows each
  entity type, the commands, each handler's events and code and each
  action's inputs and code. Journey `pi-merchant-plugin.test.ts` adds a
  third turn: a loyalty plugin with an `order.created` handler and
  `credit_store_credit`, installed after its own approval. The card was not
  checked in a browser (no harness renders it).
- Built on 2026-10-25: the eviction case, in workerd
  (`plugin-eviction-journey.test.ts`). A handler gives a code for each
  order; the merchant object is evicted right after the third order and
  starts again from its storage, and each order has exactly one code. The
  workerd harness can now keep a merchant's storage across a restart.
- Built on 2026-10-26: one receipt for a whole action run. An action call
  that applies its commands commits one more receipt in the same
  transaction, under the caller's key (`run_plugin_action`, event
  `plugin.action_run`, the action as its principal), and answers with it;
  a retry answers with it and runs nothing. A refused run leaves no receipt
  at all. The handlers and run-commands journeys check the call's receipt.
- Not built: more commands, and the queue of step 8 (deferred).
- Released 2026-10-24 07:03 UTC: Underclerk `65990534` from dev
  `da7c28af9`, schema 72 to 73, the Platform Workers unchanged (ref
  `refs/backup/released-2026-10-24-underclerk-schema-73`). Before it, the 28
  schema-72 databases that the live source's journeys write were opened with
  the new code: each upgraded to 73, matched a fresh schema-73 database, read
  its orders, drafts, events and catalogs, and ran its alarm work. After it,
  the three merchant objects upgraded on their first request and listed
  their plugins; health 200 and 90 s tails of both Workers with no
  exception. A rollback is not possible after an upgrade: the old code
  refuses schema 73.

Work:

- An event handler runs after the commit, from the merchant's alarm (and
  from the queue of step 8), once for each event. Its idempotency key comes
  from the event and the plugin version. Its commands name the plugin as the
  principal in their receipts.
- An action has a typed input schema and returns commands. The core applies
  them in one transaction, with a receipt for each command and one for the
  action, or refuses them all.
- A command outside the plugin's requirements is refused.

Exit journey: a merchant plugin marks a buyer as a regular after the fifth
order and creates a one-use 10% discount code for that buyer. An action
`apology_discount` creates a code for an order's buyer, capped by a setting.

- The code is created once, also after a retry and an eviction of the
  merchant object.
- An action above the cap is refused, with no partial change.
- A handler that submits a command outside its requirements is refused.

Cost: about 1.5 weeks.

### Step 6 — Tables owned by each built-in plugin

Status (2026-10-26): done and released, including the entity plane's food
service types.

- Built: eight built-in plugins declare their tables in
  `src/plugins/<plugin>/schema.ts` (collections, media, markets, discounts,
  customers, draft orders, returns, stored value), and `src/schema.ts`
  builds the baseline from the core and those blocks in the same fixed
  order. A fresh database has the same `sqlite_master` rows, byte for byte,
  as before the move. The buyer email outbox stays in the core. `pnpm
lint:runtime-boundary` refuses SQL in any other file that names a
  plugin's table; the one crossing (stored value read the customer table)
  now goes through `customerIsActive` in the customers plugin.
- Built: the food-service plugin owns `food_service_resource` (declared in
  its `schema.ts`, built right after the merchant tables) and the code that
  reads and writes it (`plugins/food-service/food-service-store.ts`, the
  former `commerce-authority/food-service.ts`). Purchasing and production
  requests read it through the plugin's `index.ts`. The fresh database is
  still identical. The rows stay where they are, so no merchant's data
  moves: a split into one table for each kind would move the real café's
  rows and gives no product gain while the entity plane's system types
  (menus, recipes, tickets) come from the core. The entity plane's eight
  reads of the table are listed crossings in the boundary lint with exact
  counts, so no new one can appear.
- Built on 2026-10-25: the entity plane's food service types are a
  contribution of the food-service plugin
  (`src/plugins/food-service/entity-plane.ts`, through its `index.ts`): the
  type list, the row shape, the latest-revision SQL, the shipment-to-batch
  read and the latest resource read. The entity plane names no plugin table,
  and the boundary lint allows no crossing. The journey
  `food-service-entity-plane-journey.test.ts` (evidence in
  `docs/evidence/plan-77-step-6/`) reads a latte's preparation ticket after
  each step of the bar at its latest revision and lifecycle, and a stock
  policy over the stock as low stock. It found that the lifecycle attribute
  of a food-service entity read a random revision (a ticket stayed `queued`
  after it started); the read now takes the latest one.

Work:

- Each built-in plugin declares its tables and its schema steps. The schema
  baseline is built from the core and the plugins in a fixed order.
- A lint checks that a plugin's SQL names only its own tables. A plugin
  reads another plugin's data only through that plugin's `index.ts`.
- Food-service data moves out of the core table `food_service_resource` into
  the food-service plugin's tables, through one schema step.
- Merchant plugins own entity plane types, not SQL tables.

Exit journey: a database built from the core and the plugins equals the
schema 68 baseline in every column, index, foreign key, check, trigger and
view (the comparison tool of Plan 76 phase 5). The food-service move keeps
every row: a merchant upgraded from the old table reads the same menus,
recipes and tickets.

Cost: about 1 week.

### Step 7 — One type source

Status (2026-10-26): done as
[Plan 78](plan-78-contracts-in-typescript.md). The one type source is
TypeBox 1.x schemas in TypeScript, not Rust, and no contract remains in
Rust. The plan below is the original Rust plan and is kept as history.

Work:

- Define every record and command type once, in Rust, with serde
  `Deserialize` and validation through a raw form (`try_from`),
  `deny_unknown_fields`, and the same field paths in errors as today.
- The contracts' Wasm module exports one parse function for each type. A
  generator writes the TypeScript wrapper `parseX(value): X` around it; the
  type itself comes from ts-rs, as today. The entity plane already works this
  way (`entity-plane/lexicon.ts` validates through Rust in Wasm), so the
  Worker already loads the module.
- Move the 200 types that exist only in TypeScript into Rust.
- Go area by area: payments and checkout first (with step 2), then orders,
  catalog, customers and the rest. Each area deletes its hand-written
  parsers. The plugin contract is already in this form (step 3).

Proof: every request body and stored record that the suite writes parses to
the same value with the old and the new parser, and every refusal in the
journeys gets the same error. Only then is the old parser deleted.

Measure before the first area lands: the Wasm call time on a catalog read and
on a checkout, and the client size for the storefront.

Cost: about 3 to 4 weeks, in parts.

### Step 8 — Remove the runtime ties

Status (2026-10-26): items 1 and 2 done and released, and the wake-up call
is removed. Items 1 and 2 were first released in the whole-dev release of
2026-10-25 (Underclerk `5c6c8d48`, `satyr-edge` `c163c873`). Deferred: the
old Square payment path's removal (it needs one real Square payment, which
waits for the café's business), GMO (the owner, 2026-10-25) and item 3.

- Item 1, Square online: `src/payments/square/square-payments.ts` implements
  `PaymentProvider` in front of the Stripe gateway and Platform. A partner
  connects a Square location with its tokens
  (`PUT …/payment-accounts/square`); Underclerk reads the location first and
  seals the tokens with the customer vault's merchant key (schema 75:
  `square_payment_account`, `square_payment`). A token near its expiry is
  refreshed with `SQUARE_OAUTH_CLIENT_ID` and `SQUARE_OAUTH_CLIENT_SECRET`.
  The payment uses the buyer's one-time source token, which Underclerk keeps
  until Square answers, so a lost answer is asked again under the same
  idempotency key. The journey `square-journey.test.ts` runs on the real
  Square sandbox with Platform stopped: a token that cannot see the location
  is refused, a lost first answer leaves one Square payment and the retry
  places the order, a partial refund settles on Square and in Underclerk,
  and a declined card places nothing. The sandbox account is Australian, so
  the journey sells through an AUD market. The CafePaymentService path
  stays until one production payment passes here.
- Item 1, token hand-off: Platform keeps the Square OAuth refresh (Square
  issued the refresh token to Platform's application, and two refreshers
  would race). After the first connection and after each refresh in the
  15-minute provider check, `src/underclerk-square-link.ts` links each
  location that takes card payments to the Satyr commerce merchant in
  Underclerk with the access token and its expiry (binding id
  `square_<location>`). Underclerk uses a token that it cannot refresh
  until it expires. Journey `tests/e2e/underclerk-square-link.test.ts`
  connects Square through Platform's OAuth routes against a fake Square:
  Underclerk holds the location and reads it with the first token, then
  with the refreshed one.
- Item 1, Square Terminal: `SquareTerminalGateway` sends a counter
  payment to the location's Terminal (`square_terminal_checkout` keeps the
  checkout), and the Square gateway reads the checkout and then verifies the
  payment behind it: a completed card payment at that location, for the
  exact amount, with no tip. The second case in `square-journey.test.ts`
  rings up an AUD tin at the counter, pays on Square's sandbox test device,
  places the point-of-sale order and refunds part of it on Square.
- Item 1, production proof (2026-10-26): the old payment path can go only
  after one real Square payment in production. Production takes Square only
  at the counter (Platform's online authority binds Stripe alone), so the
  proof is a Square Terminal payment. Its one missing piece was pairing a
  physical Terminal: Portal could bind only Sandbox test devices. Built:
  `POST …/terminal-operations/pairings` asks Square's Devices API for a
  code at one of the account's locations, `GET …/pairings/:id` reads it,
  and `POST …/pairings/:id/activation` gives the counter the device once
  Square pairs it (a `paired_physical` assignment) and syncs the in-person
  authority. Square's device code is the record; a code past its deadline is
  expired. Production organisations see the pairing form in Portal (code,
  instructions, a check every five seconds); development keeps the Sandbox
  form. The terminal authority needs no certification record and no
  webhook (Underclerk reads the Terminal checkout itself), so neither blocks
  the proof. Journey `tests/e2e/square-terminal-pairing.test.ts` (a
  production café against a fake of Square's production API): the Sandbox
  form is refused, an unpaired code and an expired code change nothing, and
  a paired code gives the counter its device. Left for the proof: a
  production Square application in Platform, the café's Square account
  connected in Portal, the Terminal paired, and one counter sale paid with a
  real card.
- Released 2026-10-26 04:27 UTC (Platform only, `703ac7bc9` = `fed4f37c2` +
  the pairing; ref `refs/backup/released-2026-10-26-plan-77-terminal-pairing`;
  satyr-edge `03522987`). The production Square application
  (`sq0idp-fSopNCBddEljh8H4sHnXEQ`) is installed and Seams Japan is connected
  as the default Square account of `organisation_b43a32c5…`. Square still
  reports card payments disabled for location `L9BVG44PX4PNE`, so Underclerk
  links no location yet, and no Terminal is registered.
- Deferred by the owner on 2026-10-26: the real Square payment waits until
  the café's Japanese business is set up (Square approves card payments only
  for a verified business). Until then the old Square payment path stays.

- Item 2: the one-minute reconcile makes each Satyr commerce merchant post
  every event (topic `*`) to `/hook/underclerk/:organisationId`. Satyr keeps
  the secret in `underclerk_webhook_subscription`, sealed with a key derived
  from the operator token. A post with a valid signature queues the same
  feed read as the wake-up call; a post that Satyr cannot verify is refused
  and starts no read. When Satyr cannot open its secret (after an operator
  token rotation), the next run takes a new one; a `failing` subscription is
  restarted; an address from an earlier origin is replaced. Underclerk gets
  `global_fetch_strictly_public`, because a Worker cannot fetch a
  `workers.dev` address of its own account without it. The production
  proof passed on 2026-10-26 01:40 UTC: a staff change was posted at once
  (delivered 1 to 2) and Satyr read it 11 s later. The wake-up call is
  then removed (2026-10-26): the merchant's alarm runs only its own queued
  work, `CafePaymentService.enqueueUnderclerkOutboxReconciliation` and its
  contract types are gone, and revoking the payment authority no longer
  deletes the alarm that webhooks and due work need. The one-minute read
  stays as the backstop. The CafeOS acceptance fault now fails the webhook
  receiver's queue step (a 503, so Underclerk posts again); step 6 of the
  catch-up journey shows that the one-minute read still catches up.
  A burst of posts queues one feed read: the post marks the subscription
  (`read_queued_at`), and the reader clears the mark before it reads. The
  journey found that Underclerk posted one event several times when
  requests ended at once (40 posts for 5 events), because every request
  starts a webhook pass; the merchant's object now runs one pass at a time.
  That bug is in the released Underclerk too. With both fixes, five staff
  changes give five posts and one or two reads (56 reads before).
  The journey `tests/e2e/underclerk-webhook-catch-up.test.ts` runs with no
  wake-up call: two staff changes reach Satyr by post alone, a stranger's
  post is refused, and a lost secret is replaced. A deployed database needs
  `scripts/plan-77-underclerk-webhook-d1-patch.sql` before the release.
- Item 3 is deferred (owner, 2026-10-25). The alarm already posts with
  retries and keeps each subscription's cursor, which is what a queue would
  add. Build the queue when an endpoint's slow answers delay a merchant's
  alarm, or when a merchant has more subscriptions than one alarm can post.

Work:

1. **Payment providers.** Move Square online, Square Terminal and GMO PG into
   the payments module as provider adapters. Square needs each merchant's
   OAuth token; keep it sealed in the merchant's database, as customer fields
   are (Plan 76A step 3). Keep the `CafePaymentService` path until one real
   production payment passes on each new adapter. Then remove
   `PlatformPaymentGateway` and the `PAYMENT_CAPTURE` binding.
2. **The call that wakes Satyr.** The alarm calls Satyr
   (`enqueueUnderclerkOutboxReconciliation`) to read new events. Make Satyr a
   webhook subscriber of each of its merchants instead, and keep its
   one-minute feed read as the backstop. Then remove the call.
3. **Webhook posts.** Move delivery from the merchant's alarm to Cloudflare
   Queues behind a `DeliveryQueue` port. The merchant's object enqueues event
   references after the commit; a consumer Worker posts, retries with
   back-off and keeps a dead-letter record. Each subscription's cursor stays
   in the merchant's database as the truth, so a lost message is found again
   from the feed. The port keeps another host possible. Plugin event
   handlers can use the same queue.

Exit journeys: a Square sandbox payment and refund with Platform stopped (it
needs Square sandbox credentials from the owner); Satyr catches up through
webhook posts with the wake-up call removed; an endpoint that is down for one
hour gets every event once through the queue.

Cost: Square about 1.5 weeks, GMO about 1 week, the wake-up call 1 to 2 days,
Queues about 3 days.

## Order

| Step | Needs                     | Cost                               |
| ---- | ------------------------- | ---------------------------------- |
| 0    | none                      | built                              |
| 1    | none                      | about 1 week                       |
| 2    | step 1                    | about 2 weeks                      |
| 3    | step 2                    | about 2 weeks                      |
| 4    | steps 1 and 3             | about 3 weeks, with the Satyr part |
| 5    | step 4                    | about 1.5 weeks                    |
| 6    | step 3                    | about 1 week                       |
| 7    | step 2 for the first area | 3 to 4 weeks                       |
| 8    | step 2                    | about 3 weeks                      |

The B2B slice of [Plan 76](plan-76-standalone-underclerk.md) phase 8 is a
built-in plugin: the `manual` tender, a pipeline step for company prices and
settings that agents configure. It needs steps 2 and 3. Decisions says if it
comes before or after step 4.

## Decisions

| Decision                      | Recommendation                                                                                                                                                                | Cost                                                                              | Default if no answer |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------- |
| Extensibility model           | One plugin contract: built-in plugins in code, and merchant plugins as records that agents write at run time. It replaces feature manifests (owner, 2026-10-23).              | A sandbox in the merchant object, and plugin records in each merchant database.   | Plugins              |
| Plugin language               | JavaScript in QuickJS (`quickjs-wasi`, as in Code Mode). A Worker cannot compile uploaded Wasm, so Shopify-style Wasm uploads would need a second interpreter.                | 288 KB compressed in the Underclerk Worker; the start time is measured in step 4. | JavaScript           |
| Where functions run           | In the merchant object, inside the commit, with a budget. A separate sandbox Worker isolates better, but its call is asynchronous, so the commit must check the inputs again. | A function's time holds the merchant's other requests; the budget caps it.        | Merchant object      |
| Function failure              | Skip the function, write an event, and pause the plugin after three failures in a row. A merchant can mark a validation function as required.                                 | An optional rule that fails lets a checkout through.                              | Skip and record      |
| Plugin reach                  | One merchant. A library that copies a definition to other merchants comes later.                                                                                              | An agent writes the same plugin again for each merchant.                          | One merchant         |
| B2B and merchant plugins      | Step 4 before the B2B slice, because the owner needs merchant plugins first.                                                                                                  | B2B starts after about 8 weeks instead of about 5.                                | Step 4 first         |
| Event handlers and actions    | Keep step 5 (owner, 2026-10-23), so that one plugin holds its data, functions, handlers and actions, also for a merchant that does not use Satyr.                             | About 1.5 weeks.                                                                  | Keep                 |
| AWS                           | Deferred by the owner on 2026-10-23. Step 0 keeps the core free of Cloudflare APIs.                                                                                           | An AWS deployment waits; an actor host is about 2 weeks when it is needed.        | Deferred             |
| Type source                   | TypeScript (TypeBox) schemas and their parsers (Plan 78). The Rust contracts were deleted on 2026-10-25.                                                                      | None.                                                                             | TypeScript schemas   |
| Refund split over tenders     | The refund command names its tenders. With none named, the card tenders come first, then stored value; store credit only when staff choose it.                                | A buyer gets card money back before gift card value.                              | Card first           |
| Built-in plugin tables        | Create every built-in plugin's tables for every merchant; a paused plugin leaves its tables unchanged.                                                                        | Empty tables in each merchant database cost nothing in DO SQLite.                 | Always create        |
| Plugins of existing merchants | Every built-in plugin that exists today stays on for every existing merchant.                                                                                                 | None.                                                                             | All on               |
| Webhook delivery              | The merchant's alarm posts, as today. Cloudflare Queues behind a `DeliveryQueue` port wait for slow endpoints or many subscriptions (owner, 2026-10-25).                      | None now; one queue and one consumer Worker later.                                | Alarm                |

## Non-goals

- An AWS deployment (deferred).
- Plugins that write to the database, open a network connection or hold a
  secret.
- A public plugin marketplace or an app store.
- Plugins shared across merchants (later).
- A change to stored data, except the food-service move of step 6.
