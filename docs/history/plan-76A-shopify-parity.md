# Plan 76A — Rough Shopify Parity for Underclerk

Status (2026-10-25): proposed on 2026-10-19. Every step is built and in
production: steps 1–7 since the Underclerk release of 2026-10-20 16:12 UTC
(schema 63), and the step 4B follow-up (webhook restart, secret rotation and
delete) since 2026-10-23 12:22 UTC. Open items stay in each step's Status
block. The
[Underclerk commerce spec](../../services/underclerk/docs/spec.md) states the
result of each step; this plan keeps the design history.

## Goal

Give Underclerk the Shopify backend features that a merchant uses every day.
"Rough parity" means that a merchant can do the same work through the
Underclerk Admin and Storefront APIs as through Shopify's APIs, for the areas
below. It does not mean the same API shapes, the same limits or every option.

[Plan 76](plan-76-standalone-underclerk.md) owns the standalone boundary:
separation from Satyr, API keys, payments and the event feed. This plan owns
the commerce features. The two plans meet at webhooks and payments.

## Priority order

| Step | Feature                                         | Why at this place                                                                                             | Needs        | Size |
| ---- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------ | ---- |
| 1    | Product editing and catalog lifecycle           | A merchant cannot correct a title, a price or a variant today. Collections and discounts need product fields. | —            | M    |
| 2    | Draft orders, order edits, returns              | Staff cannot create, change or take back an order today.                                                      | Step 1       | XL   |
| 3    | Customer accounts                               | Merchants cannot send an order email, see a buyer's history or buy a real shipping label today.               | —            | L    |
| 4    | More than one currency, and webhooks            | Sales to other countries and other systems that react to orders.                                              | Steps 1–3    | L    |
| 5    | Archive of finished orders, receipts and events | Keeps each merchant DO small and under its 10 GB limit.                                                       | Steps 2–4    | M    |
| 6    | Collections                                     | Groups products for the storefront and for discount scope.                                                    | Step 1       | M    |
| 7    | Discounts                                       | Codes and automatic discounts in carts, checkouts, drafts and edits.                                          | Steps 1–3, 6 | L    |

Size is relative. M changes one area. L changes a contract that many paths
share. XL changes the order and payment rules that every after-sale path
checks (step 2.0).

Steps 1, 2, 3, 6 and 7 do not need the Plan 76 boundary work. Step 4 does:
webhooks are Plan 76 phase 4, and payments in a second currency change the
payment path that Plan 76 phase 3 moves out of Platform.

## Rules for every step

1. **Contracts first.** Define each new record, command and event in the
   Rust commerce contracts. Generate the TypeScript types and parsers from
   them. Do not write a second hand-made copy in the client.
2. **One writer.** The merchant DO is the only writer of each record. Every
   command carries an idempotency key and the expected revision of each
   record that it changes.
3. **Receipts and events.** Every command commits the domain change, its
   signed receipt and its signed event in one SQLite transaction, as today.
4. **No personal data in events or receipts.** Events carry record
   identifiers and non-personal fields. A reader with the right scope reads
   personal fields from the record.
5. **Accepted records do not change in place.** An order, a return or a
   payment keeps its accepted snapshot. A later change is a new record that
   points to the old one.
6. **Old data stays as it is.** A new feature applies to records made after
   it ships. Do not convert old orders, carts or checkouts. If an old record
   blocks a new path, refuse the operation with a clear error.
7. **One E2E journey for each step.** Use the disposable backend in
   `services/underclerk/tests/punter-acceptance.test.ts`: the real HTTP API
   and SQLite store, Punter as the buyer over HTTP, the admin client as the
   staff member, and the deterministic payment gateway as the only fake.
   Each journey writes a repeatable evidence file. Do not add unit tests.
8. **Satyr keeps working.** Platform's projection must accept each new event
   kind or skip it with a trace. Portal and Urk support for a feature is a
   separate item, listed in each step.

## Step 1 — Product editing and catalog lifecycle

**Status (2026-10-19, branch `plan-76a`).** Built and proven by
`services/underclerk/tests/catalog-editing-journey.test.ts`: the frozen
checkout snapshot (1.0), `update_product`, `update_variant`, `update_offer`,
the `new_variant` listing branch, product and variant status, the carried
shipping specification, menu entries that cite offers by id, and the new
buyer catalog fields.

**Media (2026-10-20).** Built and proven by
`services/underclerk/tests/media-journey.test.ts`. Schema 61 adds `media`,
`product_media` and `product_media_item`. Staff upload image bytes (JPEG,
PNG, WebP, AVIF or GIF, checked by their first bytes, up to 20 MB); R2 keeps
them under their SHA-256, so the same image is one object. A media record
has alt text; a product has an ordered media list, each image for every
variant or for some. The buyer catalog lists each variant's images first,
then its own image links, and the storefront shows the first one before its
built-in picture. The Worker serves an image without a session only while
that storefront's catalog shows it, with an ETag and a one-hour cache. An
image still on a product cannot be deleted; the last record of some bytes
removes them from R2. The archive and media share one R2 binding, `BUCKET`.
Still open for media: image sizes from Cloudflare Images (the storefront
gets the original), video and 3D models, bytes left in R2 when the delete
after the commit fails, Satyr and Portal screens, and a browser check of
the storefront with uploaded images.

Still open from this step:

- catalog command types in the Rust contracts (only the checkout line moved);
- product-level option records and `bulk_update_catalog`;
- product delete: built as `delete_product` for a product that was never sold
  (spec section 5); archive stays the end for a sold product;
- built-in product attributes in the entity-plane relations (needed by step 6);
- Satyr: projection fields and real status, which change the canonical
  product shared with Shopify; governed actions for Urk; Portal screens.

**Shopify reference.** Staff can change every product field: title,
description, handle, product type, vendor, tags, status (active, draft,
archived), SEO fields, options and option values, media, and each variant's
price, compare-at price, SKU, barcode, weight and shipping and tax flags.
Staff can add and remove variants, publish to channels and edit in bulk.

**Today.**

- `product` holds only a title and a description, with no status, handle,
  type, vendor, tags or media. `sellable_variant` holds a unique SKU, a
  title and `definition_json` with options and media. No barcode and no
  lifecycle. `offer` holds one price and currency for each variant and
  channel, with `prepared`, `listed` and `archived` states; no code sets
  `archived`.
- After `prepare_catalog_listing` or `place_channel_listing`, only the
  description (`update_product_description`) and a listed offer price
  (`adjust_offer_price`, capped by the price policy) can change. The generic
  batch upsert was removed on 2026-08-12 (`ef7bc3a25`); Plan 9 still
  describes it. Catalog command types exist only in TypeScript.
- Catalog tables keep only the latest row. Checkouts cite revisions that are
  not stored anywhere.
- **Bug that editing would expose:** order placement copies the SKU and
  title from the current variant, not from the checkout snapshot, and does
  not check that the cited revisions are current. An edit between quote and
  placement changes the order's title while its source cites the old
  revision.
- Weight lives in `variant_shipping_specification`, keyed by variant id and
  variant revision. A new variant revision without a new specification row
  makes the listing unavailable for shipping.
- Menu entries pin offer and consumption-plan revisions. Any price change
  removes the entry from sale until staff publish the menu again.
- Price policy changes write no receipt and no event.
- The storefront catalog returns no options and no media, in
  `resource_id` order.
- Platform's projection has a fixed list of kinds, a SQL check and exact-key
  shape checks, so each new field needs a Platform change in the same
  release. It sets product and variant lifecycle to `active` in code.

**Design:**

- **1.0 — Freeze the checkout snapshot first.** The checkout line snapshot
  keeps every field that the order needs: title, SKU, options, prices and
  revisions. Placement copies from the snapshot only. After this, a catalog
  edit cannot change an order. Payment of a quote whose offer revision is
  no longer current is refused with a refresh error.
- Move the catalog command types into the Rust contracts.
- `update_product`: title, description, handle (unique per merchant), product
  type, vendor, tags, SEO title and description. Each field is optional in
  the command; omitted fields stay as they are.
- Product status `draft`, `active` or `archived`. Only an active product
  appears in a storefront. Archive is the normal end. Delete is allowed only
  for a product that no cart line, checkout or order has used.
- Options become product records: up to three options, each with ordered
  values. Each variant picks one value for each option. Staff can rename an
  option or a value, add a value and reorder them.
- `add_variant`, `update_variant` (title, SKU, barcode, weight, requires
  shipping, taxable, inventory link) and `archive_variant`. A variant that
  was sold is archived, never deleted.
- The shipping specification is keyed by variant id with its own revision,
  so a variant edit does not remove the variant from sale.
- Menu entries cite offers by id. The checkout pins the offer revision at
  quote time, so a price change does not remove a menu entry from sale.
- Media becomes its own record: upload to R2, then attach to the product or
  to variants with an order and alt text. Image sizes come from Cloudflare
  Images at read time.
- Offers: price and compare-at price change through `update_offer`, which
  keeps the existing price policy cap for automated changes. Publish and
  unpublish change the offer lifecycle for each channel. Price policy
  changes write a receipt and an event.
- `bulk_update_catalog`: a list of the typed commands above in one
  transaction, with one receipt. It is not a return of the generic upsert.
- Storefront catalog: options, media, compare-at price, handle, and a sort
  order.
- Product type, vendor, tags, status and price become built-in attributes in
  the entity-plane relations, so saved views and the collection rules of
  step 6 can filter on them.
- Effect on open buyer work: a cart line keeps its variant and shows the new
  price at the next read. A quoted checkout keeps its quote until it
  expires or until its offer changes. An order never changes.
- Events: `product.updated`, `product.archived`, `product.deleted`,
  `variant.created`, `variant.updated`, `variant.archived`,
  `offer.updated`, `media.updated`.

**Exit journey.** Staff create a product with two options and four variants,
then rename it, add tags, change two prices and a compare-at price, add a
fifth variant and archive one. A buyer who had the archived variant in a
cart gets a clear "no longer sold" line. A buyer with a quoted checkout from
before the price change must refresh before payment and then pays the new
price. A rename between another buyer's quote and payment does not change
that order's title. An order placed before the edits still shows the old
title and price. A menu entry stays on sale after its price changes.
Deleting a sold product is refused; archiving it removes it from the
storefront.

**Satyr.** Projection kinds `product`, `variant` and `offer` gain the new
fields and the real lifecycle. Urk can edit products through governed
actions with revision checks.

## Step 2 — Draft orders, order edits and returns

**Today.**

- Only `place_paid_checkout` creates an order. Lines and totals live in
  `order_snapshot_json`, pinned to variant and offer revisions. After
  placement, only the lifecycle, the adjustments and `fulfilledQuantity`
  change. The order write is an upsert with no revision check.
- Cancellation, refund and pickup completion all check that the order lines
  and totals equal the accepted checkout quote, and that the one payment
  equals the order total. Any edit breaks these checks.
- An order has one payment, captured at placement. There is no
  authorization-only flow and no second payment. A payment attempt belongs
  to a checkout.
- An order has one fulfillment for all lines at full quantity. There is no
  partial fulfillment; `partially_fulfilled` is never written.
- Cancellation is for the whole order, before fulfillment, and is refused for
  prepared recipe lines.
- Refunds spread money over lines, tax, duty and shipping. They carry no
  quantities and no restock.
- Returns existed until 2026-08-31: `commerce_return` with states
  `requested`, `authorized`, `in_transit`, `received`, `inspected`, `closed`
  and `rejected`, and stock dispositions `restock`, `quarantine`, `damage`,
  `waste` and `lost`. Commits `5abb57391`, `880062eed` and `6c9adf9a1`
  removed them as "deferred".
- The nearest thing to a draft order is the admin `pickup-checkouts` route:
  pickup only, catalog and menu lines, no price override, and the quote
  expires.

### 2.0 — Order groundwork

**Status (2026-10-20).** Items 1 to 3 are built, with 2B, and proven by
`services/underclerk/tests/order-edit-journey.test.ts`. Schema 54 adds
`order_change`: one row for each edit and each later payment, and no two
rows can start from the same order revision. The order record is the
current order. Cancellation, refund and pickup completion compare it with
the last accepted change (the checkout quote, or the last edit), not with
the quote. Edits and balance payments write the order only at the expected
revision. An order holds its first payment and any balance payments; the
order changes read returns the balance (`outstanding` and `refundDue`). A
balance checkout is a normal checkout with one `order_balance` line; the
buyer opens it with the order link, pays through the existing payment
session, and placement adds the payment to the order. A refund may name a
line that an edit removed, up to the most that line has been. Cancellation
refunds every payment of the order. Item 4 is built for pickup orders with
exchanges (2C, 2026-10-20): an exchange makes a second pickup fulfillment,
and pickup ready and completion hand over one fulfillment of several. An
order with a handed-over fulfillment can no longer be edited. Shipping
orders still have one fulfillment. The order state machine in
`transitions.rs` is not written.

2A, 2B and 2C need the same four changes first:

1. **Order changes.** The order record keeps its accepted snapshot and a
   list of order changes (edits, returns, exchanges). The current order is
   the snapshot plus its changes. Deliveries carry the current order with a
   higher revision, so Platform's projection takes it as a newer revision.
   Every order write checks the expected revision.
2. **More than one payment.** An order keeps a list of payments. The balance
   is the current total minus captured payments plus refunds. After-sale
   checks compare with the current order and the balance, not with the
   checkout quote.
3. **Balance checkout.** To collect a balance, Underclerk creates a checkout
   bound to the order for the outstanding amount. It uses the existing
   payment session and capture path, so Platform's payment service needs no
   new call.
4. **More than one fulfillment.** An order can have several fulfillments,
   each with its lines and quantities. Exchanges need this. Routing between
   locations stays out of scope.

Also write the order state machine in `transitions.rs`; today only the
revision order is checked. The existing pickup and shipping journeys must
still pass after 2.0.

### 2A — Draft orders

**Status (2026-10-19).** Built and proven by
`services/underclerk/tests/draft-order-journey.test.ts`: create, update,
send invoice and cancel; staff prices with reasons on the quote line
(`CheckoutPriceOverride`); invoice links bound to one draft revision; a
fixed buyer session for each invoice; a new quote when catalog prices move;
refresh refused for drafted quotes. Since 2026-10-23 the draft keeps its
buyer as a sealed customer record, not as an email in clear; an erased buyer's
invoice does not open. Built in a different order than the plan
below: 2A and 2C come before the 2.0 groundwork, because both work with one
payment. Mark as paid is built with the tender model of Plan 77 step 2:
staff record cash or a bank transfer with its reference, the draft's checkout
becomes the order, a refund of that payment asks no provider, and a draft
that the buyer is paying by card is refused
(`services/underclerk/tests/manual-tender-journey.test.ts`). Pickup drafts
only, as before. Still open: stock holds, custom lines, in-person completion
(each needs a contract change), shipping drafts, a `draft_order`
observation for Satyr, and the order line does not show the override reason
(the quote and the draft do).

**Shopify reference.** Staff build an order for a buyer: variants or custom
lines, price changes, a shipping line, a note and tags. Staff send an
invoice link, take payment in person, or mark the order as paid. A draft can
hold stock until a date.

**Design:**

- A `draft_order` record that staff can change: lines (a variant, or a
  custom line with title, price and tax class), a price override for each
  line with a reason, buyer contact, fulfillment method (pickup or shipping)
  and address, note and tags.
- Optional stock hold with an end time. It uses the existing reservation
  path (held, then allocated or released).
- Quote planning accepts a staff price for a draft line. The quote keeps the
  offer price, the staff price and the reason.
- Three ways to complete:
  1. **Invoice link.** The draft becomes a checkout and a checkout token,
     sent to the buyer as a link. The buyer pays through the normal public
     payment path.
  2. **In person.** The draft becomes an in-person checkout and uses the
     existing Square Terminal collection.
  3. **Mark as paid.** Staff record a manual tender (cash or bank transfer)
     with a reference. This is a new payment kind with no provider call. A
     refund of a manual tender is a manual refund record.
- A completed draft keeps a link to the order it made and cannot change
  again.
- Until step 3, Underclerk returns the invoice link and staff send it. The
  draft keeps the buyer contact as a digest, as checkouts do today.
- Events: `draft_order.created`, `draft_order.updated`,
  `draft_order.completed`.

**Exit journey.** Staff build a pickup draft with one catalog line, one
custom line and one price override, hold stock, and send the invoice link.
Another buyer cannot buy the held stock. The first buyer opens the link and
pays; the order shows the override and its reason. A second draft held past
its end time releases the stock. A shipping draft is marked as paid with a
bank transfer reference, and a later partial refund of it is recorded with
no provider call.

### 2B — Order edits

**Status (2026-10-20).** Built for pickup orders and proven by
`services/underclerk/tests/order-edit-journey.test.ts`: change the quantity
of a stock line, remove it, or add a catalog line, until the pickup is
prepared or ready; stock allocations, the pickup lines and the tax change in
the same transaction; a higher total blocks `ready_for_pickup` until the
buyer pays the balance; a lower total shows as `refundDue`; an edit from a
stale order revision is refused; cancelling an edited order refunds both
payments. Built differently from the design below: one edit command with
the expected order revision, no begin, stage and commit; staff refund a
lower total with the existing refund command, so the edit itself starts no
refund. Still open: shipping orders (a new shipping quote and the label
gate), food service lines, custom lines, in-person balance collection, an
`order_edit` observation for Satyr, and Platform's order projection does not
read the payment list.

**Shopify reference.** Staff begin an edit, add a variant or a custom line,
change quantities, and commit. If the total rises, the buyer gets a payment
request for the balance. If it falls, the merchant refunds the difference.
Only quantities that are not fulfilled can change.

**Design:**

- An `order_edit` record: begin (checked against the order revision),
  staged changes, a new quote (tax, shipping), and commit or discard.
- A committed edit is an order change (2.0). Commit changes stock
  allocations and the fulfillment lines in the same transaction.
- Edits are allowed until fulfillment starts: before `ready_for_pickup` for
  pickup, and before label purchase for shipping. A prepared recipe line
  cannot change after its preparation starts. After that, use a return.
- A lower total starts a refund through the existing refund path. A higher
  total opens a balance checkout (2.0) with a payment link, or an in-person
  collection. Until the balance is paid, the order shows it and cannot move
  to `ready_for_pickup` or label purchase.
- Events: `order_edit.committed`, `order.updated`.

**Exit journey.** A buyer orders three items for pickup. Before the order is
ready, staff remove one item and add a new item of a higher price. The buyer
pays the balance through the link. Staff mark the order ready and complete
it; stock is committed for the edited lines only. On a second order, an edit
lowers the total and refunds the difference to the card. An edit after
`ready_for_pickup` is refused. Two edits that start from the same order
revision: the second commit is refused. Cancelling an edited order refunds
both payments.

### 2C — Returns and exchanges

**Status (2026-10-19).** Returns are built and proven by
`services/underclerk/tests/return-journey.test.ts`: buyer request with the
order recovery token, staff request, authorization by line, receipt with a
disposition by line, restock in the same transaction, and close with the
refund that settled the return (a refund settles one return only). States
are `requested`, `authorized`, `rejected`, `received` and `closed`; the
removed `in_transit` and `inspected` states are not used. A restocked unit is
a stock receipt that names the return, because a new stock movement kind
needs a ledger table rebuild. Food made to order is not returnable by rule,
but the journey does not cover that rule.

**Exchanges (2026-10-20).** Built for pickup orders and proven by
`services/underclerk/tests/exchange-journey.test.ts`. Schema 62 rebuilds
`order_change` so its kind check allows `exchange`. Staff exchange the
received units of a return for new catalog lines on a handed-over order.
The units leave their lines, the new lines join the order with stock held
for them, a new pickup fulfillment waits for them, and the return closes
with the exchange instead of a refund. The order balance decides the rest:
the buyer pays the difference with the order link, or staff refund it
against the line that left the order. Still open: exchanges on shipping
orders (need shipping order edits, 2B), an exchange chosen by the buyer,
exchange lines in the return request, return labels, refund lines with
quantities, lot-tracked restock, and an `order_return` observation for
Satyr.

**Shopify reference.** A buyer requests a return, or staff create one, for
fulfilled lines with a reason. Staff approve or decline, may add a return
label, receive the items, choose restock or not for each line, refund
(with an optional restocking fee and the shipping amount), and can add
exchange lines.

**Design:**

- Start from the removed return model, in the Rust contracts first: states
  `requested`, `authorized`, `in_transit`, `received`, `inspected`,
  `closed`, `rejected`; for each line a quantity and a reason.
- Return policy: a return window that starts when the order is fulfilled
  (pickup completed or shipment delivered), and a `returnable` flag for each
  variant. Fresh food is not returnable by default. The checkout profile's
  refund policy decides if a refund needs staff approval.
- Inspection: for each line, staff choose a disposition: `restock` (a new
  `return_disposition` stock movement into a chosen location),
  `quarantine`, `damage`, `waste` or `lost`.
- Refund: the existing refund path. Refund lines gain quantities, so a
  refund can name returned units. A restocking fee and the shipping amount
  are optional.
- Exchange: exchange lines are an order change (2.0) with their own new
  fulfillment. The balance decides a refund or a balance checkout.
- Buyer route: a buyer with an order recovery token or a customer session
  can request a return within the window. Until step 3, a recovery token
  stops working when the storefront configuration changes.
- Events: `return.requested`, `return.authorized`, `return.rejected`,
  `return.received`, `return.closed`.

**Exit journey.** A buyer receives a shipped order of three lines and
requests a return of two lines. Staff authorize one line and reject the
other. Staff receive and inspect the authorized line, restock it, charge a
restocking fee and refund the rest. Stock rises by one at the chosen
location. A second return exchanges one line for a variant of a higher
price; the buyer pays the difference, and the new variant ships in a second
fulfillment. A request after the window, or for a fresh food line, is
refused.

**Satyr.** Projection kinds `draft_order`, `order_edit` and `return`, and the
order's payment list. Platform's `cafe-operations.ts` read `lineItems` and
`fulfilledQuantity`, so it had to read the current order (Plan 92 removed
that module on 2026-11-19). Urk can prepare
drafts and returns as governed actions; staff approval stays in Satyr.

## Step 3 — Customer accounts

**Status (2026-10-20).** Built and proven by
`services/underclerk/tests/customer-account-journey.test.ts`. Schema 55
adds `customer`, `customer_key`, `customer_link`, `customer_sign_in` and
`notification_outbox`. Each customer's email, name, phone, note and
addresses are sealed with AES-GCM under that customer's own key; the key is
wrapped by a merchant key derived with HKDF from a root key that each
merchant object makes on first use and keeps in its own storage, so no
Worker secret is needed. Erasure deletes the customer's own key, so the root
does not have to be secret from the object's storage for erasure to hold;
a copy of the object's storage alone can open customer data that is not
erased, as it can open every other merchant record. Lookup by email uses HMAC with a merchant
lookup key. A guest checkout with an email finds or makes the merchant's
customer for that email, so a buyer who signs in later sees their guest
orders. Sign-in is a six-digit email code (ten minutes, five tries, one
use); it returns a 30-day customer access token, which the existing
buyer-account gateway turns into a signed-in buyer session. Staff can
create, update (name, phone, note, tags, email and SMS consent), export and
erase a customer. Erasure deletes the key, the lookup value and the sealed
profile, and drops queued email; the journey checks every table row and the
raw database files for the buyer's data. Order confirmation, ready for
pickup and sign-in emails go through a `NotificationGateway` from the
outbox after the commit; the Worker sends after each response and from its
alarm. The Cloudflare Email Service adapter is written but not run against
the real service, and production has no binding, so email stays off there
until it is set. Built differently from the design: the root key lives in
the merchant object, not in a Worker secret, and the merchant key is
derived from it, not stored wrapped. Saved addresses reach shipping
checkout (2026-10-20, `services/underclerk/tests/saved-address-journey.test.ts`):
a signed-in buyer names a saved address, and Underclerk passes it through
the same address validation as a typed address, scoped to the buyer
session; one that needs a correction, that it cannot ship to, or whose
customer was erased is refused. Shipped and refund emails go out too
(schema 63): one per order when the carrier takes it, with the tracking
number, and one per succeeded refund, with the amount. Still open: merge,
session refresh,
order recovery tokens that survive storefront changes, the label call with
the decrypted address,
and the Satyr `customer` projection.

**Shopify reference.** A customer record with name, email, phone,
addresses, tags, note, marketing consent and tax exemption. Buyers sign in
with a one-time email code. Orders link to the customer. Guest orders link
when the email matches. Merchants can export or erase a customer's data.
Order confirmation and shipping emails go to the buyer.

**Today.** There is no customer record.

- The buyer-account gateway (`buyer-account.ts`) has no implementation, so a
  storefront with the `guest_or_account` profile option refuses every
  signed-in buyer with HTTP 401.
- Email and phone become `sha256(merchant, session, field, value)` at once.
  The session is part of the input, so the same email gives a different
  value in each session and cannot find a customer.
- No cleartext address is kept anywhere. The label purchase call receives no
  address; the Japan carrier gateway is a stub. Real label purchase needs
  the encrypted address of this step.
- Buyer sessions last 30 minutes. Order recovery tokens last 90 days and
  stop working when the storefront configuration changes.
- Platform has a `customerId` in contact and Case records, but nothing backs
  it.

**Design:**

- A `customer` record in the merchant DO. Name, email, phone and addresses
  are encrypted with a key for each customer. That key is encrypted with a
  merchant key, and the merchant key with a Worker secret. Erasure deletes
  the customer key, so the data in SQLite, R2 archives and backups becomes
  unreadable.
- Lookup by email or phone uses a keyed hash (HMAC with a merchant lookup
  key), not a salted hash per session. One email gives one lookup value for
  the merchant.
- Sign-in: the buyer asks for a one-time code; Underclerk sends it by email
  through a `NotificationGateway`; the buyer enters it and gets a customer
  session. The existing `BuyerSessionAuthority` issues it with a customer
  claim. No passwords.
- The existing checkout profile option `guest_or_account` and its saved
  address policy use this sign-in. Implement the existing buyer-account
  gateway interface inside Underclerk. A signed-in buyer's checkout links to
  the customer and can use a saved address.
- Customer sessions last longer than buyer sessions and can be refreshed.
  Order recovery tokens stay valid when the storefront configuration
  changes.
- Key handling follows Platform's `DATA_ENCRYPTION_ROOT` pattern: HKDF keys
  and AES-GCM with associated data (merchant, customer, field, key version).
  Underclerk gets its own root secret.
- The shipping label call receives the decrypted address only for the length
  of the call.
- New guest orders keep an encrypted contact. A guest who later signs in
  with the same email sees those orders. Old orders keep their digests only.
- Marketing consent: email and SMS, each with state, time and source.
- Staff commands: create, update, tag, add a note, merge two customers,
  export, erase.
- Notifications: order confirmation, ready for pickup, shipped with
  tracking, refunded. Each send writes a receipt. The send happens after the
  command commits, from the outbox, so a failed email never rolls back an
  order.
- Events: `customer.created`, `customer.updated`, `customer.erased`. They
  carry the customer identifier only.

**Exit journey.** A guest buys and receives a confirmation email at the
email gateway fake. The same buyer signs in with a code, sees the guest
order, saves an address and buys again with it. Staff erase the customer.
Then the Admin API returns no personal fields, the database holds no
readable personal data, a new sign-in with the same email starts a new
customer, and order totals and reports are unchanged.

**Satyr.** Projection kind `customer` with no personal fields. Inbox can
link a sender to a customer later, through a scoped read.

## Step 4A — More than one currency

**Status (2026-10-20).** Built for pickup checkouts and proven by
`services/underclerk/tests/market-journey.test.ts`. Schema 60 adds
`market`. A market has countries, a currency, its storefronts and a price
mode: a fixed price list, or the shop price times a merchant-set rate (kept
with its time and source) rounded half up to an increment. Staff create,
update and list markets; the event feed shows `market.created` and
`market.updated`. A buyer checkout names its market. The quote is in the
market currency, and the quote and the order keep the market revision, the
rate and the shop subtotal. An open checkout keeps the rate it quoted; a
new or refreshed checkout uses the current rate. Refunds are in the order
currency. Stripe charges in the market currency and settles in the account
currency; Square refuses a checkout whose currency is not the account's
before any payment. One minor-unit table (`CURRENCY_MINOR_UNITS`) serves
the conversion, the Platform Stripe adapter and the storefront's `money()`.
Built differently from the design: offers do not change; a price list lives
in the market record. The table is in `@satyr/bakery-model`, not in the
Rust contracts, and `money.rs` keeps its own table for Shopify imports.
Step 4A came before Plan 76 phase 3 because Platform needed only two
currency checks, not new currency work in `CafePaymentService`. Still open:
shipping checkouts, draft orders, order edits and balances in a market,
inclusive tax display, choosing the market from the buyer's country, reports
in shop currency, fixed-amount discounts in a market currency (a yen amount
does not apply in SGD), and a real Stripe test-mode charge in SGD (the
journey uses the deterministic gateway).

**Shopify reference.** Markets group countries. Each market has a currency,
and prices come either from a fixed price list or from a conversion of the
shop price with a rounding rule. The buyer pays in the market currency.
The order keeps both the buyer's currency and the shop currency.

**Today.** One currency everywhere.

- `CheckoutCurrencyPolicy` has only `Fixed`. Contracts refuse mixed
  currencies in checkouts, order totals, lines and refunds; this rule stays.
- An offer has one price for each variant and channel, so one channel
  cannot sell in two currencies.
- JPY is written into the carrier, tax and duty providers, charge parsing,
  line allocation, Japan shipping and the test Stripe binding.
- `CurrencyCode` accepts any three capital letters. The minor-unit table in
  `money.rs` is used only for Shopify imports. The storefront's `money()`
  knows only JPY, KRW and VND as zero-decimal and shows three-decimal
  currencies wrongly.
- Platform's Stripe and Square adapters refuse an amount whose currency
  differs from the account currency.
- No money conversion type exists. Supplier payouts have a `DecimalRate`.

**Design:**

- A `market` record: countries, currency, price mode, rounding rule, tax
  display (inclusive or exclusive), and the storefronts that serve it.
- Price mode `price_list`: a fixed price for each variant in the market
  currency. Price mode `converted`: the shop price times a merchant-set
  exchange rate, then the rounding rule (for example, whole yen or .00).
- Currency rules: an ISO 4217 list with each minor unit (JPY 0, SGD 2,
  USD 2, KWD 3) in the contracts. The storefront and every provider use
  that one table. All arithmetic stays in integer minor units. A conversion
  always uses a stored rate with its time and source.
- An offer price belongs to a market, not only to a channel. The unique key
  becomes variant, channel and market. Existing offers belong to the shop's
  home market.
- A cart and a checkout have one currency, from the buyer's market. The
  checkout snapshots the rate. The order stores buyer-currency amounts,
  shop-currency amounts and the rate. Refunds use the buyer currency.
- Tax, duty and carrier providers receive the checkout currency. A provider
  that cannot quote that currency returns a typed refusal, not a converted
  guess.
- Payments: the payment request carries the buyer currency. Stripe accepts
  it. Square online and Square Terminal accept only the location's
  currency, so a market with another currency cannot use them.
- Reports show shop-currency totals from the stored amounts.

**Exit journey.** A shop in JPY adds a Singapore market in SGD with a price
list and a United States market in USD with a converted price. A Singapore
buyer pays in SGD; the order shows SGD and JPY with the rate. The merchant
changes the USD rate; an open USD checkout keeps its quoted rate until it
expires, and a new checkout uses the new rate. A partial refund of the SGD
order returns SGD. A Square Terminal sale in a USD market is refused before
any payment.

**Satyr.** Projection fields for buyer currency and rate. This step changes
`CafePaymentService` unless Plan 76 phase 3 has moved payments first.

## Step 4B — Webhooks and the event feed

This is [Plan 76](plan-76-standalone-underclerk.md) phase 4.

**Status (2026-10-20).** Built and proven by
`services/underclerk/tests/webhook-journey.test.ts`. `GET .../events` reads
the outbox in merchant revision order with a client-held cursor; reading
changes nothing. Each event has a named kind taken from the command receipt
that made it (`order.created`, `order.edited`, `order.paid`,
`refund.succeeded`, `return.received`, `customer.erased` and others); a
delivery with no receipt, such as a refund reservation, is
`<resource>.updated`. Schema 56 adds `webhook_subscription` and
`webhook_delivery`. A subscription names topics (`order.*` or exact kinds)
and a public HTTPS address; private, loopback and local addresses are
refused. Each subscription reads the feed with its own cursor. A post
carries identifiers only, with `x-underclerk-signature: v1=` HMAC-SHA256
over the timestamp and the canonical JSON body. Failed posts retry after 1,
5, 15 and 30 minutes, then 1 to 12 hours; an event still failing 48 hours
after its first post is dead, and the subscription becomes `failing` and
gets no more posts. Built differently from the design: the merchant DO
posts from its alarm and after each response, not through a Queue and a
delivery Worker, and the feed does not change the existing Ed25519 delivery
signatures. Still open: Platform still reads `GET deliveries` with global
acknowledgements, not the feed; events for refund and payment attempts that
make no delivery; the posts are not tested against a real HTTPS endpoint.

**Restart, rotation and delete (2026-10-23).** Built and proven by
`services/underclerk/tests/webhook-lifecycle-journey.test.ts`, with evidence
in `docs/evidence/plan-76-phase-4/webhook-lifecycle.json`. Staff restart a
`failing` subscription: each event that it did not deliver gets a new
48-hour window, and the events of the failing hours follow from its cursor.
Staff rotate a secret with up to 24 hours of overlap, in which each post
carries a signature with the new and with the previous secret (schema 72
keeps the previous secret). Staff delete a subscription with its
deliveries; the same id can be used again and starts after the newest
event. Each of the three commands names the subscription's revision, and
each makes an event (`webhook_subscription.restarted`, `.secret_rotated`,
`.deleted`). In production since 2026-10-23 12:22 UTC (Underclerk
`a1b6cb4e`).

**Shopify reference.** Apps subscribe to topics such as order created,
order paid, refund created or product updated. Each delivery is an HTTPS
POST with an HMAC signature. Shopify retries failed deliveries and removes a
subscription after repeated failures. Order is not guaranteed.

**Today.**

- The outbox holds signed resource snapshots, not named events such as
  "order created". Delivered rows are never deleted.
- `GET deliveries` returns every pending row with no limit or cursor. An
  acknowledgement changes the row for everybody, so only one consumer
  (Platform) can read.
- The signature covers `JSON.stringify` output, which depends on key order.
- The entity-plane change log already has a client-held cursor
  (`after`, `limit`), but it holds only references and has no signature.
- No outbound webhooks exist anywhere in the repository. Platform has
  inbound signature checks, a retry table pattern and outbound request
  protection against internal addresses (`custom-connector-egress.ts`).

**Design:**

- An event feed: `GET /v1/admin/merchants/:m/events?after=<cursor>&limit=`
  returns events in merchant revision order, like the change log. Each
  consumer keeps its own cursor. Reading does not change events. Satyr moves
  from global acknowledgements to this feed.
- Each event gets a named kind (for example `order.created`) next to its
  resource snapshots, so topics do not have to be guessed from snapshots.
- New signatures cover canonical JSON from `@satyr/std`. Existing events
  keep their current signatures.
- A `webhook_subscription` record: topics, HTTPS address, a secret, state
  and failure count.
- Delivery: the merchant DO sends each new event to a Queue. A delivery
  Worker checks the address against internal networks, as
  `custom-connector-egress.ts` does. It posts the event to each matching
  subscription with an HMAC-SHA256 header and the existing Ed25519 merchant
  signature. Retries back off for up to 48 hours. After the last retry, the
  event goes to a dead-letter record and the subscription becomes
  `failing`. A consumer fills gaps from the feed.
- Topics come from the event kinds of steps 1–4A: products, collections,
  inventory, orders, draft orders, order edits, returns, refunds,
  fulfillments, customers. Refund attempts and payment attempts emit no
  delivery today; add events for them.
- Payloads carry identifiers and non-personal fields, as rule 4 says. A
  subscriber with a customer scope reads personal fields through the Admin
  API.
- Until Plan 76 phase 2 adds API keys, the merchant's service token manages
  subscriptions.

**Exit journey.** Subscribe two endpoints to order topics. One endpoint
fails for an hour, then recovers. Place, edit and refund orders in that
hour. The healthy endpoint gets every event once, with valid signatures. The
failing endpoint gets every event after it recovers, through retries and its
feed cursor, with no event lost. An endpoint that fails for 48 hours
becomes `failing` and gets no more posts.

## Step 5 — Archive of finished orders, receipts and events

**Status (2026-10-20).** Orders and events are built and proven by
`services/underclerk/tests/archive-journey.test.ts`. Schema 57 adds
`archive_file` and `archive_entry`. An order moves when it is cancelled or
fulfilled, has no open refund attempt, dispute or return, and its last
change is older than 180 days; the record keeps the raw rows of every order
table (order, payments, fulfillments, shipments, label rates and attempts,
refund attempts, disputes, returns and order changes). Events move as the
oldest run of the outbox that Platform acknowledged, that is older than 90
days, and that no webhook still needs. Files follow the planned key pattern;
each record is its own gzip member, with a JSON index of offsets, lengths
and SHA-256 digests. The write order is the planned one: an interrupted run
finds its file in R2 with the same digest and does not write it again, and
the commit deletes source rows only if they still match the file.
`GET .../orders/:orderId` returns an order from either place and says which;
the event feed reads the archive first and then the live outbox. The Worker
runs the archive once a day from its alarm when it has the `BUCKET` R2
binding (shared with product media). Production binds bucket
`underclerk-apac` (APAC hint, created 2026-10-20); no release has used it yet. Still open: command receipts
(replay by idempotency key needs an async path first), compaction, the Cache
API in front of range reads, the history of public signing keys, refunds
and disputes on an archived order, customer order history from the archive,
and a draft order whose order is archived.

Confirmed by the owner on 2026-10-19. Today nothing deletes delivered
events, command receipts or change records, and in local data these logs are
the largest tables. Finished orders stay in the DO for ever.

**What moves to R2:**

- An order that is finished: cancelled, or fulfilled and refunded as far as
  it will be, with no open return, dispute, refund or payment attempt, and
  no change for the archive delay (180 days by default). The order moves with
  its lines, payments, refunds, fulfillments, shipments and returns.
- Delivered events, command receipts and change records older than the
  event retention window (90 days by default), when no webhook delivery for
  them is still pending. The event feed reads archived events too, so a
  slow consumer loses nothing.

**Files.** Each archive run writes new files that never change:
`merchants/<merchant>/<kind>/<yyyy-mm>/<sequence>.ndjson.gz`, with an index
file of record identifiers, byte offsets, lengths and SHA-256 digests. Kinds
are `orders`, `receipts`, `events` and `changes`. The month is the month of
the record's last change. A later compaction may merge small files of one
month into one new file and then delete the small files.

**Write order, safe after a crash:**

1. The DO alarm selects one batch and builds the file and its index. The
   content is deterministic for the same batch.
2. The DO writes both objects to R2 and checks the stored digests.
3. In one SQLite transaction, the DO inserts one `archive_entry` row for each
   record (identifier, file key, offset, length, digest) and deletes the
   source rows.
4. If the DO stops between 2 and 3, the next run builds the same batch again
   and finds the same objects. Nothing is lost and nothing is repeated.

**Reads.** A read of an archived order uses its `archive_entry` row, one R2
range read and the Cache API. Archived records do not come back into SQLite.
The Admin API marks each result as live or archived. Customer order history
and the event feed read both places.

**Rules:**

- Receipts and events keep their signatures and key identifiers. The merchant
  keeps a history of public signing keys, so a reader can verify an archived
  file without the DO.
- Archived files contain no personal data in clear text. Customer fields stay
  encrypted with the customer key from step 3. Erasure deletes that key.
- Archived records never come back into SQLite. A late dispute or refund on
  an archived order is a new live record that points to the archive entry.
  The refundable amount is the archived snapshot minus the live refunds that
  point to it. The 180-day delay is longer than most card dispute windows,
  so this case is rare.
- The R2 bucket uses the APAC location hint, like the rest of production.

**Exit journey.** Seed a merchant with orders across 14 months at a fixed
clock. Run the archive. Then check: the DO row counts fall; each archived
order reads the same as before through the Admin API; every archived receipt
verifies with the published key; the event feed returns the same events in
the same order; a dispute and a partial refund on an archived order succeed
as new live records, and a refund above the remaining amount is refused; a
second archive run after a forced stop between steps 2 and 3 writes no new
file.

**Satyr.** Platform's projection already holds its own copy. It needs no
change unless it reads an order detail that is archived.

## Step 6 — Collections

**Status (2026-10-20).** Built and proven by
`services/underclerk/tests/collection-journey.test.ts`. Schema 58 adds
`collection` and `collection_member`. A collection has a handle, title,
description, one sales channel, a sort order (manual, title, price up or
down, newest) and a status. A manual collection keeps a staff order; an
automated one keeps a rule that matches all or any of tag, product type,
vendor, title text and price on the collection's channel. Members are
stored. Every command that writes products, variants or offers recomputes
automated members in its own transaction, so the edit and the member change
share one receipt. Buyers list a storefront's collections and read one in
pages, with tag, price and availability filters; a product that is not
active or not on sale stays a member but is not shown. Built differently
from the design: the rule is a small typed rule of its own, not the
entity-plane `Filter` contract, because that contract has no AND node and
products expose no filter attributes to it yet. Still open: images, more
than one channel, the `collection.membership_changed` event, a Satyr
projection, and the cost of recomputing every automated collection on each
catalog write for large catalogs.

**Shopify reference.** Manual collections (a chosen, ordered list of
products) and automated collections (rules on product fields, match all or
any). Each has a title, handle, description, image, sort order and channel
publication. The storefront lists the products of a collection with filters
and pages.

**Today.** No collection record exists.

- Food-service menus group offers into sections, but only for pickup
  storefronts.
- Commerce Lists in the entity plane can list product entities, but entries
  have no position (default order is the last update) and the storefront
  does not read them.
- Saved views use the entity-plane `Filter` contract: `entity`, `any`,
  `not`, `attribute` comparisons, `relationship` and `search`. There is no
  AND node; it needs `not(any(not …))`.
- Products expose no built-in filter attributes today, only their title as
  search text. Merchant extension attributes can be read, but no command
  writes them.

**Design:**

- A `collection` record with title, handle, description, image, sort order
  (manual, title, price, newest, best selling), status and channel
  publication.
- Manual collections keep an ordered membership list.
- Automated collections keep a rule written in the entity-plane `Filter`
  contract, over the built-in product attributes of step 1: product type,
  vendor, tag, status, title text, price range, availability. Add an `every`
  (AND) node to the contract, so "match all" is direct.
- Commerce Lists stay as staff and agent work lists. A collection is a
  storefront record with its own ordered membership.
- Membership is stored, not computed at read time. A product command
  updates the membership of every automated collection in the same
  transaction. The storefront reads a collection with one indexed query.
- Storefront reads: list collections; read one collection with its products,
  pages and simple filters (availability, price range, tag).
- Events: `collection.created`, `collection.updated`, `collection.deleted`,
  `collection.membership_changed`.

**Exit journey.** Create one manual and one automated collection ("tag is
gift, price under 3,000"). Add tags to three products and change one price
above the limit. The buyer sees the right products in the right order, in
pages. An archived product leaves both collections. A product edit and the
membership change share one receipt.

**Satyr.** Projection kind `collection`. Urk can file products into
collections through governed actions.

## Step 7 — Discounts

**Status (2026-10-20).** Built for pickup checkouts and proven by
`services/underclerk/tests/discount-journey.test.ts`. Schema 59 adds
`discount`, `discount_code` and `discount_redemption`. A discount is
published as created and can only be turned off. It takes a percentage or a
fixed amount off chosen products or off the order, by code (case does not
matter) or automatically, with a minimum subtotal, a validity window, a
total use limit and one use per customer. The checkout contract gains a line
`discount` (the line total is net of it) and a totals `discount`. One
evaluator applies product discounts first and order discounts on what is
left, spreads each over its lines in whole yen with remainders in a fixed
order, and tax is computed on the discounted subtotal. A checkout holds its
uses until it is paid or its quote expires; placement redeems them and
records the customer. Order lines keep their discounts, so a refund is
capped at the discounted line; cancellation no longer refuses a discounted
order. Built differently from the design: the evaluator is TypeScript inside
Underclerk, not Rust compiled to Wasm, because every caller is in
Underclerk. Still open: `buy_x_get_y` and `free_shipping`, shipping
checkouts, draft orders and order edits through the evaluator, collection
and customer scopes, combination classes (every eligible discount applies
now), counter sales, and tax per rate. A pickup checkout refresh keeps the
code discounts it holds and drops the holds it no longer uses (step 4A).

**Shopify reference.** Amount off products, amount off the order, buy X get
Y, and free shipping. Each is a code or automatic. Conditions: minimum
amount or quantity, eligible products or collections, eligible customers,
start and end dates, total and per-customer use limits, and which discount
classes combine. Discounts are spread over the order lines, and tax is
computed after discounts.

**Today.** No discount is possible.

- The order line `discount` and the order total `discount` exist but are
  always zero. Cancellation refuses an order with a non-zero discount, fee,
  tip or rounding.
- `CheckoutTotals` has no discount field, and a checkout line total must
  equal unit price times quantity, so a checkout cannot carry a discount.
- Tax is added on top of the line amounts. Refunds cap each line at its line
  total and have no discount allocation.
- A promotion model existed until 2026-08-31: `promotion_revision` with
  `automatic` or `code` eligibility, a `percentage` or `fixed_amount`
  benefit, unlimited use, line allocations and a code digest. Published
  revisions could not change.
- Food-service modifier price deltas can already be negative.

**Design:**

- Start from the removed promotion model, in the Rust contracts first. A
  `discount` record has revisions, and a published revision cannot change.
  It has one typed rule: `amount_off_products`, `amount_off_order`,
  `buy_x_get_y` or `free_shipping`. The value is a fixed amount in one
  currency or a percentage in basis points.
- Checkout contract change: each checkout line keeps its gross amount, its
  discount and a line total equal to gross minus discount. `CheckoutTotals`
  gains a discount field.
- Method: `code` (one or more codes, case-insensitive, unique per merchant)
  or `automatic`.
- Conditions: minimum subtotal or quantity, product and collection scope,
  customer scope (all, signed-in customers, chosen customers), validity
  window, total use limit, one use per customer, combination classes.
- One evaluator in the Rust contracts, compiled to Wasm. Carts, checkout
  quotes, draft orders and order edits all call the same evaluator, so a
  buyer never sees one total in the cart and another at payment.
- The evaluator returns a discount allocation for each line in integer minor
  units. Remainders go to lines in a fixed order, so results repeat exactly.
- Tax is computed on the discounted line amounts.
- A code use is held at checkout and counted when the order is placed. A
  checkout that expires releases the hold. Two buyers cannot pass a total
  use limit at the same time, because the merchant DO is the one writer.
- The order keeps the allocations. An order line total is already net of
  its discount, so the existing refund cap gives back the discounted amount,
  not the list price. Remove the cancellation rule that refuses a non-zero
  discount.
- Events: `discount.created`, `discount.updated`, `discount.redeemed`.

**Exit journey.** Create a code "WELCOME10" (10% off, one use per customer,
limit 2 in total) and an automatic "free shipping over 5,000". A signed-in
buyer uses the code with a mixed-tax cart and gets free shipping too. The
same buyer cannot use the code again. A second buyer uses the last use, and
a third buyer is refused. A partial refund of one line gives back the
discounted amount. Totals, tax per rate and allocations repeat exactly on a
second run.

**Satyr.** Projection kind `discount`. Urk proposes discounts as governed
actions; a discount above a threshold needs approval.

## Not in this plan

These areas are also needed for full parity. Each needs its own plan.

- **Tax.** A real tax adapter.
  - Japan has a 10% standard rate and an 8% reduced rate for food, and a
    café sale can be either, so eat-in and takeaway must differ.
  - Under Japan's qualified invoice rules, tax rounds once for each rate on
    each invoice, not once for each line.
  - The tax policy named `merchant_inclusive` adds tax on top of the price.
  - Other countries need a tax provider.
- **Shipping.** Zones and rates for any country, and real carrier adapters.
  Today only Japan and Singapore test carriers exist.
- **Fulfillment orders.** Routing between locations and split shipments.
- **Stock transfers** between locations.
- **Gift cards and store credit, B2B price lists, subscriptions, bundles.**
- **Search, bulk import and export, and a Shopify import tool.**
- **Staff accounts, API keys and app scopes** (Plan 76 phase 2).
- **Portal and Urk support** for each feature, beyond the projection fields
  that each step names.

## Decisions

| Decision                       | Recommendation                                                                                                    | Cost                                                                                                                                | Default if no answer     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Email sender (step 3)          | Cloudflare Email Service through its `send_email` Worker binding, behind a `NotificationGateway` interface.       | It is in beta, and new accounts start with a low daily limit. A second adapter (for example Amazon SES in Tokyo) is one small file. | Cloudflare Email Service |
| Customer sign-in (step 3)      | One-time email code, no passwords.                                                                                | Each sign-in sends one email.                                                                                                       | Email code               |
| Exchange rates (step 4A)       | Merchant-set rates for each market. Fixed price lists where the merchant wants exact prices.                      | Rates go stale unless staff update them. A rate feed can come later.                                                                | Merchant-set rates       |
| Archive delay (step 5)         | 180 days after an order's last change; 90 days for delivered events and receipts.                                 | Finished orders stay in the DO for six months.                                                                                      | 180 and 90 days          |
| Collections (step 6)           | A storefront `collection` record with its own ordered membership. Rules reuse the entity-plane `Filter` contract. | Two list concepts: collections for buyers, Commerce Lists for staff.                                                                | Collection record        |
| Price overrides (steps 2A, 2B) | Allowed for staff. Each override records a reason in the receipt. Satyr asks for approval above its policy limit. | None in Underclerk; the approval rule lives in Satyr.                                                                               | Allowed with a reason    |
| Steps 4A and Plan 76 phase 3   | Decided 2026-10-20: step 4A first. Platform needed only two currency checks, so nothing is done twice.            | Phase 3 stays a separate decision; it needs a Stripe secret on the Underclerk Worker.                                               | Step 4A done             |
