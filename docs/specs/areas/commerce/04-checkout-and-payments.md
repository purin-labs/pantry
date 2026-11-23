# COM-04 — Checkout and payments

Checkout and payments is how a buyer pays for an order of Purin Checkout. A merchant
publishes a checkout profile without code, and activates one revision on each storefront.
The profile names one payment binding. The commerce engine collects the payment through
Stripe or Square, records each attempt, and places the order only after the provider
confirms the capture. At a counter, the engine sends the exact amount to a Square
Terminal that Pantry assigned to the location. Pantry connects the payment accounts,
assigns the terminals and shows the payments, but no Stripe or Square payment runs
outside the engine. A `gmo_stera` collection runs through the Platform `DeviceFleetActor`
(Plan 90). A retry never makes a second charge or a second order.

## What it does

### Checkout profiles

- A checkout profile is a closed set of policies, with no merchant code:

  | Policy               | Values                                                                                                                                                                              |
  | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `currencyPolicy`     | `fixed`, with one currency                                                                                                                                                          |
  | `buyerPolicy`        | `guest`, or `guest_or_account` with a saved-address policy (`disabled`, `enabled`). Required contact: `email_required`, `email_required_phone_optional`, `email_and_phone_required` |
  | `cartPolicy`         | `single_fulfillment`, with `minimumLines`, `maximumLines` and `maximumTotalQuantity`                                                                                                |
  | `pricingPolicy`      | `published_offers` of one sales channel                                                                                                                                             |
  | `fulfillmentPolicy`  | `pickup_only`, `shipping_only` or `buyer_choice`, each with policy ids                                                                                                              |
  | `taxPolicy`          | `merchant_inclusive` or `provider_quoted`                                                                                                                                           |
  | `paymentPolicy`      | `external_provider`, with one `paymentProviderBindingId`                                                                                                                            |
  | `afterSalePolicy`    | A cancellation policy, a refund policy, and refund governance: `approval_required` or `automatic_up_to` a threshold                                                                 |
  | `presentationPolicy` | Locale, merchant display name, terms and privacy policy ids, support contact                                                                                                        |

- The parser (`parseCheckoutProfileConfiguration`) refuses an unknown key and a cart
  policy where `maximumLines` or `maximumTotalQuantity` is below `minimumLines`.
- A profile is `draft`, `published` or `retired` (machine `checkout_profile`). A draft
  replacement makes a new revision. A published revision never changes. A storefront
  activates one published revision. A retired profile cannot be activated again.
- The engine refuses to retire a revision that a storefront has active
  (`profile_active`). An activation of the revision that is already active returns the
  current activation and writes nothing.
- A buyer session (`commerce.buyer-session.v4`) pins the storefront revision, the
  profile reference and its whole configuration. A new activation changes new sessions
  only. A session made before a storefront change is refused.
- The **Checkout** page of the Portal lists the versions. An admin creates a draft from
  the settings of a published revision, edits it, and publishes and activates it after
  a review panel. Pantry publishes or activates a profile only when its payment binding
  is an `active` payment account of the merchant. Otherwise the answer is
  `checkout_payment_binding_uncertified` (409).

### Online checkout and payment

1. The buyer opens a session, fills a cart and makes a checkout. The checkout is
   `quoted` and holds stock, discount uses and stored value until the quote expires.
2. A refresh makes a new quote revision. A shipping quote keeps the carrier rate, the
   tax, the duty and the address check of each quote attempt. COM-02 owns the stages.
3. The buyer starts a payment session. The payment attempt binds the checkout revision,
   the quote digest, the amount due, the binding and an idempotency key. The checkout
   is `payment_pending`. Stripe charges in the buyer's currency. Square and GMO take only
   the account currency, so a quote in another currency does not match their binding.
4. The buyer's browser pays on the provider page: Stripe embedded tokenization, or the
   Square Web Payments SDK. The buyer then asks the engine to reconcile.
5. The engine reads the payment from the provider. Only a confirmed capture places the
   order. A decline expires the checkout and releases its holds.
6. The buyer reads the order with an order recovery token after a reload.

| Record             | States                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `checkout`         | `quoted`, `payment_pending`, `accepted`, `expired`                                                                           |
| `payment_attempt`  | `pending`, `processing`, `indeterminate`, `captured`, `declined`                                                             |
| `payment`          | `captured`, `partially_refunded`, `refunded` (and `pending`, `authorized`, `failed` for payments read from another platform) |
| `refund_attempt`   | `requested`, `processing`, `indeterminate`, `succeeded`, `failed`                                                            |
| `unplaced_capture` | `capture_unplaced`, `resolved`                                                                                               |

- A repeated payment session or reconciliation with the same idempotency key returns
  the same attempt and the same order. A lost provider answer leaves the attempt
  `indeterminate`. The engine reads it again after its `reconcileAfter`.
- The merchant's alarm runs a `payment_due` pass. It reads each due payment from the
  provider after the quote expires, at most 20 in one pass. A card check that waits one
  hour after the quote expired is declined as `payment_authentication_abandoned`.
- The alarm's `lapsed_checkouts` pass expires each `quoted` online checkout whose quote
  lapsed, 20 at a time, and releases its stock holds.
- The Stripe Connect webhook (`POST /v1/providers/stripe/webhooks`) is only a prompt.
  The Worker checks the signature and finds the attempt in the PaymentIntent metadata.
  The merchant's object then reads the payment from Stripe. `charge.dispute.*` events
  record disputes.
- The provider can take the money when the engine places no order. Then the engine opens
  an `unplaced_capture` item. The item keeps the amount, the provider reference and the
  reason. The engine does not refund by itself. Staff resolve the item as `refunded` or `placed_by_hand`.
- A checkout can end (declined or expired) before the provider reports a capture. If
  the provider later reports the capture, the item has the reason `checkout_expired`.

### Cancellation and refunds

- A cancellation is for the whole order, before fulfillment. It refunds each payment and
  releases the stock. A refund goes through one payment, or through all payments of an
  order as a split refund (`tender-refunds`). COM-02 owns these rules.
- A refund first reserves its `refund_attempt`, then asks the provider. A gateway reads
  the refund of an earlier try (`earlierTry`) before it asks for a new one, so a lost
  answer gives one refund. A Square refund names its attempt id in the reason.
- The alarm's `refunds_due` pass reads each `processing` or `indeterminate` refund
  attempt again after its `reconcileAfter`, 20 at a time. It replays the cancel or
  refund command that reserved the attempt, so it gets the receipt of a retry.
- The governed cancellation (`cancel_order`) of Pantry reads the profile that the order
  pinned. If the profile has `automatic_up_to` and the order total is at most the
  threshold in the same currency, the action is `automatic_eligible`. Otherwise it is
  `approval_required`. COM-05 owns the action flow.

### Payment accounts

| Provider | How it connects                                                                                                                                                                                                    | Account states                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Stripe   | Stripe Connect through the Integrations page, or Stripe hosted onboarding (Accounts v2) through the engine. The engine links the account under `payment_binding_primary_online`                                    | `onboarding`, `active` (charges enabled), `restricted` (details sent, no charges) |
| Square   | Square OAuth through the Integrations page. The engine exchanges the code with its Square application secret and keeps the tokens. Pantry links each location that takes card payments under `square_<locationId>` | A linked location is `active`                                                     |

- The engine stores no Stripe merchant secret. It makes the PaymentIntent on the
  connected account with the platform key. A Stripe account is usable only in the mode
  of the engine's key.
- Pantry keeps no Square token. Its Vault credential is a delegation record: the
  merchant id and the Square account id (FND-08).
- The Square connection is `connected`, `scope_missing`, `refresh_failed` or `revoked`
  (machine `square_connection`). A new connection, or a refresh with every scope in use
  (or with no scope list from Square), moves it back to `connected`. A revoked
  connection is never refreshed, so only a new connection ends `revoked`. The engine
  sends no call with a revoked token. It refreshes a token in its last day, one refresh
  at a time for each merchant.
- When an admin reads the payment accounts, Pantry reads each Stripe account that is not
  `active` again. An active Stripe account closes an open Stripe support reference.
- The provider check of a Square connection confirms that the engine holds the
  connection for the same Square account. The check then links the card locations again
  and lists the devices.

### Counter payments on a Square Terminal

- A counter checkout has the source `point_of_sale`: the Pantry location, the point of
  sale configuration revision, the operator, the terminal assignment revision (or
  `null`) and the buyer (`anonymous` or `identified_customer`). The branches share no
  field, so an online checkout cannot carry a terminal, and a counter sale needs no
  storefront, profile or buyer session. A `point_of_sale` checkout makes a
  `point_of_sale` order.
- The point of sale configuration of a location (`point_of_sale_configuration`) is
  `draft`, `published` or `retired`. One revision is published for each location. It
  holds the items, the quote time, the tax, the pickup lead time, the after-sale policy
  and the presentation policy.
- A terminal assignment binds one Pantry location to one terminal target at one Square
  location. It is `active` or `retired` (`replaced`, `revoked`, `connection_removed`).
  One location has at most one active assignment. A new assignment retires the old one
  in the same batch. A Square payment attempt keeps its own binding, so it stays
  recoverable after a retirement. The record of a `gmo_stera` capture or decline on the
  sale reads the active assignment, so an operator cannot retire a `lan_gateway_device`
  counter while its last collection is unresolved: the terminal still collects, its
  result is unknown, or the sale does not record the result yet. An admin cannot
  replace it with a Square target either (the Sandbox, pairing and Point of Sale app
  paths): the new assignment would retire it. `counterCollectionRefusal`
  (`areas/cafe/server/terminal-retirement.ts`) holds the rule for each path. The
  refusal (`terminal_collection_unresolved`, 409) tells the operator to finish or
  cancel the collection first. When Pantry cannot read the collection, the refusal is
  `terminal_collection_unverifiable` (503).

| Target               | Environment   | How Pantry makes it                                                                                                                                                                                                                                      |
| -------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox_simulated`  | `development` | An admin selects one of three Square Sandbox test devices: successful payment, buyer cancels, checkout times out                                                                                                                                         |
| `paired_physical`    | `production`  | An admin asks Square for a device code. Square names the device after the pairing. Pantry keeps no copy of the code. A code is `open`, `paired` or `expired`                                                                                             |
| `square_pos_app`     | `production`  | An admin selects the Square Point of Sale app for a counter and a Square location. The transport is `client_app_handoff`. The engine keeps the app's handoff result from the browser, then reads the payment from Square. Plan 90 owns the Register flow |
| `lan_gateway_device` | See Plan 90   | Plan 90 owns it                                                                                                                                                                                                                                          |

- Pantry, not the request, resolves the binding from the active assignment of the
  location. A collection binds the checkout revision, the quote digest, the amount and
  the binding.
- The engine sends one Terminal checkout with no tip, no partial authorization and
  `autocomplete`. A repeated request under the same Square idempotency key reads the
  same checkout. The request sends no deadline, so Square applies its default deadline.
  The collection session records the quote expiry as its `expiresAt`.
- The engine reads the checkout, then its first payment. It records a capture only for a
  `COMPLETED` payment at the binding's location. The amount and the currency must be
  exact, the tip must be zero, and the tender must be the one that the counter asked
  for. A mismatch leaves the attempt `indeterminate`. A `CANCELED` checkout declines the attempt.
- The merchant's alarm reads a waiting Terminal checkout every 5 s for 10 minutes, then
  every 60 s, until it is one hour old. A read that finds the checkout still waiting
  writes nothing.
- The **Counters & payments** page shows each counter, its Square location, its target,
  its assignment revision, the credential health and the webhook state.

### Receipts and payment reads

- For each paid online order of a feed delivery, Pantry posts one Slack receipt to the
  operations channel (`paid_receipt`): the payment, the order, the total, the lines and
  the fulfillment. A receipt is `pending`, `sent`, `failed` or `abandoned`. The
  `paid_receipts` pass tries a due receipt again from 1 minute, doubled up to
  15 minutes, for one day. The Connector key gives Slack one message.
- The **Payments** page lists the card payments of a window, paid and declined. A try
  after a decline joins its run. The **Payouts** page lists the bank payouts of Stripe
  and Square. Neither names a buyer.

### Agents

| Tool                      | Capability                      | Effect   | What it does                                                                                                                                                                    |
| ------------------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments_read`           | `commerce.entity_plane.context` | Read     | The payments of a window of at most 32 days, with a count of runs: paid first try, recovered after a decline, not recovered. The person who asked must be an operator or higher |
| `commerce_propose_refund` | `commerce.action.propose`       | Proposal | Stages a refund of a whole order or of named lines. An owner or an admin approves the exact amount on its card, with a step-up                                                  |

No agent tool reads or changes a checkout profile, a payment account or a terminal
assignment. No agent tool starts a collection.

## Contracts

- `packages/commerce-contracts`: `src/records/checkout-profile.ts` and
  `src/checkout-profile.ts` (the profile and its parser),
  `src/records/payment-bindings.ts` (the bindings), `src/records/terminal.ts` and
  `src/terminal-assignment.ts` (targets, assignments, pairing and health),
  `src/records/point-of-sale-configuration.ts`, and `checkoutSourceSchema` and
  `orderOriginSchema` in `src/records/commerce-records.ts`.
- Bindings: online `stripe_online` (`embedded_tokenization`, `hosted_redirect`),
  `square_online` and `gmo_pg_online`. In person: `square_terminal` with `transport`
  `server_terminal` (a `deviceId`) or `client_app_handoff`, and `gmo_stera`
  (`lan_gateway`).
- The engine (`services/commerce`): `checkout-profile-service.ts`,
  `checkout-profile-persistence.ts`, `point-of-sale-configuration-service.ts`,
  `commerce-authority/buyer-checkout/payment-stage.ts`,
  `commerce-authority/families/payments.ts`, `payments/provider.ts` (the port
  `PaymentProvider` and `InPersonCollectionGateway`), `payments/stripe/` and
  `payments/square/`. `UnavailablePaymentGateway` ends the chain and refuses every other
  binding.
- Tables of the merchant object (`services/commerce/src/schema.ts`):
  `checkout_profile_revision`, `storefront_checkout_profile_activation`,
  `point_of_sale_configuration`, `checkout_payment_attempt`, `payment`, `refund_attempt`,
  `checkout_capture_unplaced`, `payment_provider_account` (Stripe), `stripe_payment_intent`,
  `square_connection`, `square_payment_account`, `square_payment` and
  `square_terminal_checkout`.
- Engine routes: [the API contract](../../../../services/commerce/docs/spec.md), sections
  4, 11, 12 and 15. Profiles and accounts need `settings:read` or `settings:write`.
  Payments need `orders:read` or `orders:write`. `payments:record` records results of an
  app that runs its own provider. An API key may not hold it. An app installation can
  hold it, and the engine's operator token passes every scope check.
- Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`):
  `cafe_terminal_assignment` (module `areas/cafe` in `scripts/layers.json`) and
  `paid_receipt`.
- Agent tools: `areas/commerce/server/agent-tools/commerce/payments.ts` and
  `proposals.ts`.

The control routes are under `/v1/control/organisations/:id/commerce`:

| Route                                                                                                            | Role          | Purpose                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| `GET`, `POST /checkout-profiles`; `GET /checkout-profiles/:id/revisions/:revision`                               | Viewer, admin | List the profiles and the activations, create a draft, read a revision                              |
| `PUT /checkout-profiles/:id/draft`, `POST …/publication`, `POST …/retirement`                                    | Admin         | Replace a draft, publish, retire, each with `expectedRevision`                                      |
| `PUT /storefronts/:storefrontId/checkout-profile-activation`                                                     | Admin         | Activate a published revision                                                                       |
| `GET /payment-accounts`, `POST /payment-accounts/stripe/onboarding`                                              | Admin         | Read the Stripe and Square accounts. Open Stripe onboarding with a country and a Portal return path |
| `GET /terminal-operations`                                                                                       | Viewer        | The counters, the Square accounts and locations, and the Sandbox test devices                       |
| `POST /terminal-operations`                                                                                      | Admin         | Assign a Sandbox test device (development only)                                                     |
| `POST /terminal-operations/pairings`, `GET …/pairings/:deviceCodeId`, `POST …/pairings/:deviceCodeId/activation` | Admin         | Start, read and complete a Terminal pairing (production only)                                       |
| `POST /terminal-operations/square-pos-app`                                                                       | Admin         | Assign the Square Point of Sale app (production only)                                               |
| `POST /terminal-operations/:pantryLocationId/retirement`                                                         | Operator      | Retire the assignment of a counter, after its last LAN collection is resolved                       |
| `GET /payments`, `GET /failed-payments`, `GET /bank-payouts`                                                     | Operator      | The payment reads                                                                                   |

Each profile and terminal mutation has an `Idempotency-Key`, and its receipt is in the
Organisation's database (`recordCommerceMutationReceipt`). Stripe onboarding records no
receipt: a repeated request reuses the merchant's account and opens a new link. The main
Platform files are
`control/routes/checkout-profiles.ts`, `commerce-payment-accounts.ts`,
`terminal-operations.ts`, `provider-workflows/square-connection.ts`,
`provider-workflows/stripe-connection.ts`, `commerce/contract/square-link.ts`,
`commerce/contract/stripe-link.ts`, `data/terminal-assignment-store.ts`,
`data/terminal-operations-readback.ts`, `commerce/paid-receipt.ts` and
`commerce/payments-read.ts`. The Portal features are `checkout-profiles/`,
`payment-accounts/`, `payments/`, `bank-payouts/` and `terminals/`.

## Rules and limits

| Action                                                                 | Viewer | Operator | Admin and owner     | Agent                                    |
| ---------------------------------------------------------------------- | ------ | -------- | ------------------- | ---------------------------------------- |
| Read checkout profiles and activations                                 | Yes    | Yes      | Yes                 | No tool                                  |
| Create, edit, publish, retire or activate a profile                    | No     | No       | Yes                 | No                                       |
| Read payment accounts, open Stripe onboarding                          | No     | No       | Yes                 | No                                       |
| Read the counters and their terminals                                  | Yes    | Yes      | Yes                 | No tool                                  |
| Assign a Sandbox device, pair a Terminal, assign the Point of Sale app | No     | No       | Yes                 | No                                       |
| Retire a counter's assignment                                          | No     | Yes      | Yes                 | No                                       |
| Read payments, failed payments and payouts                             | No     | Yes      | Yes                 | `payments_read`                          |
| Approve a refund that an agent proposed                                | No     | No       | Yes, with a step-up | `commerce_propose_refund`, proposal only |

| Limit                                            | Value                                           | Constant                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Buyer session                                    | 30 minutes                                      | `SESSION_LIFETIME_MS` (`buyer-session.ts`)                                                                          |
| Order recovery token                             | 90 days                                         | `ORDER_RECOVERY_LIFETIME_MS`                                                                                        |
| Card check after quote expiry                    | 1 hour                                          | `AUTHENTICATION_ABANDONED_MS` (`payment-stage.ts`)                                                                  |
| Due payments settled in one alarm pass           | 20                                              | `DUE_PAYMENTS_PER_PASS` (`payment-stage.ts`)                                                                        |
| Stripe and Square read again after a lost answer | 60 s                                            | `RETRY_SECONDS`                                                                                                     |
| Terminal read: fast, then slow, then end         | 5 s for 10 minutes, then 60 s, until 60 minutes | `TERMINAL_POLL_SECONDS`, `TERMINAL_FAST_POLL_SECONDS`, `TERMINAL_SLOW_POLL_SECONDS`, `TERMINAL_POLL_WINDOW_SECONDS` |
| Stripe webhook signature age                     | 300 s                                           | `TOLERANCE_SECONDS` (`stripe-webhooks.ts`)                                                                          |
| Square token refresh                             | In the last day                                 | `REFRESH_BEFORE_MS`                                                                                                 |
| Square refund reason                             | 192 characters                                  | `REASON_LIMIT`                                                                                                      |
| Payments window                                  | 32 days                                         | `MAX_WINDOW_MS` (`payments-read.ts`)                                                                                |
| Slack receipt retries                            | 1 to 15 minutes, for 1 day                      | `PAID_RECEIPT_PASS`                                                                                                 |
| Slack receipt pass                               | 20 receipts a page, 60 s lease                  | `PAID_RECEIPT_PASS` (`paid-receipt.ts`)                                                                             |

- **Scopes.** Pantry asks Square for `DEVICE_CREDENTIAL_MANAGEMENT`, `DEVICES_READ`,
  `MERCHANT_PROFILE_READ`, `PAYMENTS_READ`, `PAYMENTS_WRITE` and `PAYOUTS_READ`. It
  asks for no Orders, Catalog, Inventory or Customers scope. A connection without a
  scope that the engine uses is `scope_missing`.
- **One authority.** The engine owns the quote, the order, the stock and the receipt. A
  provider only moves money. No error moves a payment to another binding, device or
  provider.
- **Pinned evidence.** An online order names its profile revision
  (`configuration.kind: "checkout_profile"`). A counter order names its location, its
  checkout and its terminal. A later activation or refresh does not change them.
- **Buyer data.** The checkout keeps the contact only as protected digests. The engine
  keeps addresses. A payment read and a receipt name no buyer.
- **Information flow.** `payments_read` enters the turn through
  `admitCommerceReadObservation`, as COM-01 describes. FND-07 owns the rules.
- **Idle cost.** The `paid_receipts` pass of the every-minute schedule reads only the
  Organisations that have a due receipt, and writes nothing when none is due. The
  Terminal alarm runs only while a Terminal checkout waits, and it ends after one hour.
- **Out of scope:** marketplace payments and carts of more than one merchant, retail
  returns with a return authorization, tipping, split tender on one card, partial
  authorization and manual card entry.

Neighbours:

- **COM-01** owns the domain records and their states. **COM-02** owns the engine:
  its stages, shipping (`japan_export`), fulfillment, returns, stored value and gift
  cards. **COM-05** owns the governed cancel and refund flows and the failed-payment
  brief in Slack.
- **INT-01** owns the shared provider lifecycle (OAuth start, callback, provider check).
  **FND-08** owns the Vault. **DEV-01** owns `DeviceFleetActor`.
- [Plan 90](../../../plan-90-cafe-pos-checkout.md) stays a plan. It owns the Register,
  counter menu lines, cash, the FeliCa and QR tenders, the Square Point of Sale app, GMO
  `stera`, the receipt printer and the counter routes under `/commerce/counter-sales`.
  Its hardware phases are not built.

## Open work

- The Square Terminal path has no lock for one collection on one physical device
  (`terminal_busy`). Only a `gmo_stera` terminal has one (Plan 90).
- The engine has no call to cancel a pending Terminal checkout. The Platform cancel of a
  Square counter collection only reconciles.
- Square payment notifications are not built. No code registers or writes the Square
  `terminal_events` webhook, so the page shows it as unconfigured.
- Terminal health, pairing attempts and payment observations have parsers
  (`records/terminal.ts`), but no production code stores or reads them.
- After its one-hour alarm window, a Terminal checkout is read only on request. The
  30-day Square retention limit and a manual-investigation state are not built.
- `gmo_pg_online` is a binding with no gateway: it is refused as unavailable.
- Pantry has no route or page for the engine's unplaced captures. The alarm does not
  read a refund attempt that stays `requested` again. Only the counter refund
  reconciliation reads it, on request.
- The certification of a payment binding was removed. The publish check now asks only
  for an `active` account, but its error keeps the name
  `checkout_payment_binding_uncertified`.
- Live certification is not done: Stripe live payments, the distinct-seller Square check
  and the physical Terminal (Plan 33D, Plan 90 Phase 3C). The carriers are test
  fixtures.

## Sources

- [Plan 33](../../../history/plan-33-merchant-configurable-production-checkout.md),
  [Plan 33C](../../../history/plan-33C-POS-systems.md) and
  [Plan 33D](../../../history/plan-33D-square-release-acceptance.md). Background:
  [Plan 90](../../../plan-90-cafe-pos-checkout.md) and
  [its hardware runbook](../../../runbooks/plan-90-hardware-acceptance.md). Where they
  differ from the code, this spec follows the code.
- Evidence in the archive:
  [P33B/P33C completion record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-33BC-completion-record.md),
  [exact-binding evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-exact-binding-20260908.json),
  [exact-binding packet](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-exact-binding-packet-20260908.json),
  [adapter matrix](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-terminal-sandbox-20260906-jp-3.json),
  [Portal canary](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-portal-counter-sale-20260908.json),
  [recovery fixtures](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-recovery-gaps-20260908.md)
  and
  [runtime evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-post-refresh-readiness-20260908.md).
- E2E journeys in `workers/platform/tests/e2e/`: `square-in-commerce.test.ts`,
  `stripe-in-commerce.test.ts` and `paid-receipt-outbox.test.ts`.
- Journeys in `services/commerce/tests/`: `plan33-core-acceptance.test.ts`,
  `punter-acceptance.test.ts`, `checkout-profile-http.test.ts`,
  `online-payment-due-journey.test.ts`, `stripe-journey.test.ts` (real Stripe test
  mode), `stripe-after-sale-journey.test.ts`, `square-connection-journey.test.ts`,
  `square-connection-state-journey.test.ts`, `square-journey.test.ts` (real Square
  Sandbox), `tender-refund-journey.test.ts`, `failed-payments-journey.test.ts` and
  `bank-payouts-journey.test.ts`. The two real-provider journeys skip without keys.
- Punter: `scripts/punter/src/pickup-scenario.ts`, `shipping-scenario.ts` and
  `payment.ts`.
