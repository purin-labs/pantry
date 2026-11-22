# Plan 80 — Underclerk as a Multi-Tenant Headless Backend

Status (2026-10-27): accepted by the owner. Steps 1, 2 and 3 are released
(2026-10-27 04:29 UTC, from dev `b000d6371`, ref
`refs/backup/released-2026-10-27-plan-80-steps-1-3`): Underclerk `f4ce9899`
(schema 80), sandbox `79581965`, model exit `3570061b`, ChatGPT exit
`4cd5f69a`, 1Password store `af1f8170`, satyr-edge `de9d724f`, Slack ingress
`387f7fa5`. The release closed a mismatch: the Plan 60A upload of 2026-10-26
had shipped the step 1–2 Platform client without its Underclerk. Rehearsal:
48 schema 79 databases from the live source upgrade with every row, owner
and receipt kept. Both production merchants answer at schema 80; a
one-minute tail showed no exception.

Step 4 and step 5 part A are released (2026-10-27 07:17 UTC, from dev
`f98a781a1`, ref `refs/backup/released-2026-10-27-plan-80-step-4-5a`):
Underclerk `35d0bceb` (schema 81), then its production Square OAuth
secrets (`81c035dc`), sandbox `ef990a54`, model exit `2d751196`, ChatGPT exit
`d18bb571`, 1Password store `4dc57365`, satyr-edge `88397c44`, Slack ingress
`44bb4f5a`. Rehearsal: 50 schema 80 databases from the live source upgrade
to 81 with every row kept and every merchant snapshot readable. Both
production merchants answer at schema 81; a 90-second tail of both Workers
showed no exception. Satyr's Stripe Connect application and Underclerk's
`STRIPE_SECRET_KEY` belong to one Stripe platform (test mode): both keys
read the same platform account, and Satyr's production Connect webhook is
registered on it. Step 5 part B passed its gate, one production test-card payment
through Underclerk (2026-10-28 05:42 UTC), and is released (2026-10-28 06:40 UTC,
satyr-edge `eb891082`, Underclerk `9a9e30b9`, regional D1 patch applied).

## Goal

Underclerk is the headless commerce backend that Satyr exposes to many
ecommerce operators. Satyr stays the only front end: Portal, Slack and the
agents. Underclerk needs no dashboards or storefront of its own.

When Satyr onboards a second operator, Underclerk must:

- keep each operator's merchants apart, by credential and by key;
- take requests that carry no Satyr names and no fields that the URL or the
  credential already gives;
- decide time itself, so that no caller can move a business clock;
- record who made each change;
- let an operator manage its own API keys;
- hold each merchant's payment provider tokens itself, with no payment path
  through Satyr.

## Facts from the code (2026-10-27)

Write requests:

- About 70 command schemas repeat a write envelope: `schemaVersion`,
  `organisationId`, `merchantId`, `idempotencyKey`, `actionNonce` and
  `requestedAt`. No shared base schema exists; each contract module declares
  its own copy.
- `merchantId` in the body must equal the URL. `organisationId` must equal
  the merchant's stored organisation (`validateMerchant`, 60 calls).
- `idempotencyKey` is the replay key: `command_receipt` is keyed by
  (merchant, key). `actionNonce` only names effects and some ids, and its
  uniqueness is never checked.
- `requestedAt` is the business clock, with no check against the server
  clock. It sets commit times and decides return windows, quote expiry,
  stored-value expiry, draft expiry and ticket order. A caller can backdate
  a return.
- `schemaVersion` names one exact version per command (190 strings), and no
  command has two versions.
- The command digest hashes the whole body. Signed receipts and deliveries
  carry `organisationId` and `actionNonce`. Satyr checks both.
- Satyr builds these bodies by hand at about 36 sites.

Tenancy and access:

- Each merchant has its own Durable Object database. The Worker routes by
  merchant id only. A merchant id has no format rule, and R2 keys start
  with `merchants/<merchantId>/`.
- The operator token opens every route. API keys (`uck_`) and app tokens
  (`uca_`) open one merchant's routes of their scopes. Only the operator
  token can create, list or revoke them.
- A receipt does not record which credential or person made the change.
  The only principal is a plugin.
- One buyer session secret signs the buyer sessions, invoice tokens and
  customer access tokens of every merchant.
- No per-merchant rate limit exists.

Payments:

- Gateways chain Square, then Stripe, then `PlatformPaymentGateway`, which
  calls Satyr's `CafePaymentService` through the `PAYMENT_CAPTURE` binding.
- Underclerk owns a full Stripe Connect path (link an account, hosted
  onboarding, webhooks), and production has its Stripe keys. Satyr never
  calls it. Satyr's own Stripe Connect sign-in and adapter take every Stripe
  payment of a Satyr merchant through the fallback.
- Satyr signs merchants in to Square, refreshes every 15 minutes, and hands
  Underclerk only an access token. Satyr also reads locations and devices,
  pairs Terminals (`/v2/devices/codes`), runs Terminal checkouts on the
  fallback, and reconciles them from Square webhooks.
- No GMO code is live.

## Decisions

D1. **Attribution and merchant-managed keys instead of staff accounts.**
Satyr already has members, sign-in and roles. A second set of logins inside
Underclerk would repeat them. Instead, each receipt names the credential,
and an app may name the acting person. An operator manages its own keys
through a scope, from Portal or its own systems. Staff accounts with
passwords are not built.

D2. **The URL and the credential name the merchant.** A write body carries
only the command's own fields and, where the command has one, its expected
revision. The idempotency key moves to an `Idempotency-Key` header.
`schemaVersion`, `organisationId`, `merchantId`, `actionNonce` and
`requestedAt` leave every request body. The path prefix `/v1` stays,
because Satyr is the only caller and releases with Underclerk.

D3. **The server clock decides time.** Every command takes its time from
the merchant object's clock. Journeys move that clock in the fixture
Worker, as they already do for retries.

D4. **An external reference replaces the organisation.** Provisioning sets
`externalReference` on the merchant once. Only the operator reads it. App
installations match it. Buyer claims, entity-plane reads, receipts and
deliveries name only the merchant. Satyr maps merchants to organisations
in its own D1 table, as now.

D5. **Merchant ids follow one format** (`[a-z0-9][a-z0-9_-]{2,79}`), so
that no id holds a path under another. The Worker routes only such ids, and
provisioning refuses others. Existing ids already fit.

D6. **No per-merchant buyer keys** (changed on 2026-10-27). Each buyer
token signs its merchant and storefront, and the server checks both. Keys
derived from the one buyer session secret would add no isolation.

D10. **Buyer requests keep their shape** (2026-10-27). A buyer command
already carries only its version, its idempotency key and its own fields,
with no Satyr name and no field that the server gives. Moving its key to a
header would change the public storefront contract for no gain in
tenancy.

D11. **Payment authority sync stays on the operator token** (2026-10-27).
Step 5 deletes Satyr's payment authority sync and dispute forwarding, so
moving them to the app token first would be work that step 5 throws away.

D12. **Satyr widens its own installation** (2026-10-27). An installation
from before step 3 lacks `credentials:write`. When Underclerk answers
`missing_scope` to Satyr's app token, Satyr installs itself again with every
scope, as it does when no installation exists. A revoked installation stays
revoked.

D13. **Satyr keeps a delegation record, not a token** (2026-10-27).
Satyr's provider connections always point at a vault credential. For
Square that credential is now an opaque profile
(`underclerk_square_connection_v1`) that names the Underclerk merchant and
the Square seller, with no token. The account, cutover and cleanup machinery
stays as it is.

D14. **A connection from before step 4 is handed over once** (2026-10-27).
The production café connected Square before step 4, so Satyr's vault still
holds its tokens. The next provider check gives them to Underclerk as a
token grant of the same application and replaces them with the delegation
record. Nobody reconnects.

D15. **Underclerk keeps one connection for each merchant** (2026-10-27).
Schema 81 adds `square_connection` and drops the token columns from the
location rows. Location rows that held their own token are dropped; no
production merchant has one that takes payments, and Satyr links the
locations again after the hand-over. Satyr's Square webhook route and its
Terminal recovery are deleted: Underclerk's alarm reads waiting Terminal
checkouts itself.

D16. **Satyr links the Stripe account itself** (2026-10-27). The owner
does not run a script. When an owner connects Stripe, and at each provider
check, Satyr asks Underclerk to link the connected account under the
primary online binding. Underclerk reads the account with its own platform
key, so it links only an account of its own Stripe platform, and the
provider check keeps the account's state current. The café's existing
account is linked at the first provider check after the release.

D17. **Underclerk's payment accounts replace Satyr's certifications**
(2026-10-27). With no payment through Satyr, its certification packets
certify nothing. A checkout profile is published or activated only when
Underclerk lists an active payment account for the profile's binding: a
Stripe account or a linked Square location. The terminal page shows
whether Underclerk has linked the counter's Square location, in place of
"certified". Satyr's terminal collection lock goes too: Underclerk follows
each waiting Terminal checkout by its payment attempt, so a re-pair or a
retirement in Satyr cannot lose one.

D7. **Underclerk alone holds Square tokens.** Satyr keeps the registered
OAuth callback and hands the authorization code to Underclerk, which
exchanges it, refreshes and revokes. Satyr reads locations and devices and
pairs Terminals through Underclerk routes. Satyr stores no Square token.

D8. **Underclerk alone runs Stripe.** Satyr onboarding links or opens the
merchant's Stripe account through Underclerk. Satyr's Stripe payment
adapter retires.

D9. **The fallback goes, and the old Square path with it.** The owner
asked for this on 2026-10-27. The new Square path has never run a real
payment, because the café's Square location cannot take payments yet. No
live sale depends on the old path. Satyr's Stripe payment path is deleted
only after one production payment with a Stripe test card passes through
Underclerk.

## Steps

### Step 1 — One request shape (about 1.5 weeks)

Slice 1, built on local dev (2026-10-27): the 83 admin routes that take a
command. Each route definition names its command version. The server reads
the merchant and the other path fields, the `Idempotency-Key` header and its
own clock, and refuses a body that names them. The client's command methods
take `UnderclerkCommandInput<Command>`, and `underclerkCommandInput` serves a
caller that checks a whole command first. The replay digest leaves out the
request time and uses canonical JSON. Appendix A shows each route's command.
Tests that moved time through the request now move the server's clock.
Proof: `tests/request-shape-journey.test.ts` (break-checked: the field-order
digest, the path-field check and the server clock, the last through
`return-journey`), the full Underclerk suite (74 files), and 10 Satyr
journeys that write to Underclerk. Satyr's unit failures are the same as on
dev. Moved to step 2: receipts and deliveries without `actionNonce` and
`organisationId`, and the internal command shape, because the external
reference changes the same signed records. Buyer routes stay (D10).

Work:

- One shared write base in the contracts. Each command schema keeps only
  its own fields and its expected revision.
- The client sends `Idempotency-Key`. Its write methods take the payload
  and a key, so callers build no envelope.
- The server reads the key from the header and the merchant from the URL.
  It takes time from the merchant object's clock. Effect ids and the ids
  that came from `actionNonce` come from the idempotency key.
- The digest covers the command body. Receipts carry the idempotency key in
  place of `actionNonce`, and neither receipts nor deliveries carry
  `organisationId`. Stored receipts from before the release are read
  through one projection that drops the old fields.
- Satyr's 36 call sites use the client methods. Satyr checks a receipt by
  merchant and idempotency key.
- The spec, its lint and Appendix A follow.

Proof: the full Underclerk suite and the Satyr commerce journeys pass on the
new shape. One journey shows the replay rules that an operator sees: the
same key and body give the same receipt, the same key with another body is
refused, and two merchants may use the same key.

Release: Underclerk and Platform together. Before it, check that Satyr's
outbox holds no command built in the old shape, or rebuild such commands
from their stored intent.

### Step 2 — Tenant isolation (about 0.5 week)

Built on local dev (2026-10-27):

- Schema 80 renames `merchant.organisation_id` to `external_reference`.
  Provisioning (`provision-merchant.v2`, `provision-demo.v2`) takes
  `externalReference`; snapshots (`commerce-snapshot.v2`,
  `food-service-snapshot.v2`) name the merchant only. Satyr checks a
  snapshot by its merchant.
- Commands lose `organisationId` and `actionNonce`; effect ids and ids
  that came from the nonce come from the idempotency key. Internal commands
  keep `requestedAt`, which the server sets at admission.
- Receipts and deliveries are version 2 without the owner and the nonce;
  version 1 stays readable and verifiable. Delivery acknowledgements are
  version 2.
- Buyer tokens no longer hold the owner (session and order recovery
  version 4, draft invoice and customer access version 2): earlier tokens
  stop once. Address validations and shipping quote attempts no longer
  store it; one made before the release cannot be read after it.
- Food-service provenance keeps `organisationId` as data, filled from the
  external reference. Entity-plane routes and the payment authority routes
  are Satyr's integration routes and keep it (spec §3).

Proof: `request-shape-journey` (version 2 receipt and raw feed delivery
without owner fields, break-checked), the full Underclerk suite, and the
upgrade rehearsal: 90 databases at schemas 75 and 77, upgraded to 80 with
every owner kept, the schema equal to a fresh one, 12,795 version 1
receipts parsed and 12,514 version 1 deliveries verified.

Work:

- `externalReference` on the merchant (D4), with the schema step and a
  rehearsal on copies of live databases.
- Version 2 of the signed receipt and delivery: no `organisationId` and no
  `actionNonce`. Version 1 records stay readable as they are. Satyr checks
  a receipt by merchant and idempotency key.
- Internal commands lose `organisationId`, `actionNonce` and `requestedAt`;
  the authority takes the time from its clock.
- The merchant id format (D5): built on local dev, proved in
  `request-shape-journey`.

Proof: a journey with two merchants of two operators. A buyer session,
customer token, API key and app token of one merchant open nothing of the
other, also with a forged claim.

### Step 3 — Attribution and merchant-managed keys (about 1 week)

Built on local dev (2026-10-27):

- A version 2 receipt may carry `actor`: the operator, an API key by its
  credential id, or an app with an optional person reference. Only an app
  token may send `Underclerk-Actor` (1–200 characters); another credential
  that sends it gets 400.
- The scope `credentials:write` opens the key routes (issue, list,
  revoke). A key gets only scopes that its creator holds, and never
  `payments:record` or `credentials:write`. The operator may still give any
  other scope.
- Satyr sends the acting member's person id on every Portal change and on
  every approved agent action. Satyr widens an old installation (D12).
- Portal has an API keys page under Settings: one list and a side drawer
  to create, view and revoke a key. The secret shows once, in the answer to
  the create request; a retry of that request answers without it.

Proof: `merchant-keys-journey` in Underclerk (an app issues a key; the key,
the app for a person and the operator each change a plugin setting, and each
receipt names its actor; seven refusals; revoke stops the key) and
`commerce-api-keys` in Satyr (an old installation, a key created in Portal,
a stock count corrected by the key and one by the owner in Portal, each
receipt naming its actor; the key opens nothing of a second operator's
merchant; no payments scope; a viewer gets 404; revoke stops the key). Both
are break-checked. The payment authority sync stays on the operator token
(D11).

### Step 4 — Square inside Underclerk (about 1 week)

Built on local dev (2026-10-27):

- Underclerk holds one Square connection for each merchant (schema 81,
  D15): `PUT …/square/connection` exchanges an authorization code with the
  application's secret, or keeps tokens of the same application; `GET`
  reads it; `POST …/connection/revocation` revokes at Square and forgets the
  connection and its locations. It lists locations and devices and creates
  and reads Terminal device codes. A token in its last day is refreshed
  before use, one refresh at a time for each merchant.
- A location of the connection takes payments under a binding id; the
  location row holds no token.
- The merchant's alarm reads a waiting Terminal checkout every five seconds
  for ten minutes, then once a minute for an hour, and places the order
  when the card is paid. Reads that find it still waiting write nothing.
- Satyr's Square sign-in hands the code to Underclerk; its vault keeps only
  the delegation record (D13). The provider check, the resource refresh,
  Terminal pairing and account removal go through Underclerk. A connection
  from before step 4 is handed over once (D14).
- Satyr's own Square payment adapters, its Square webhook route and
  Terminal recovery, its direct Square calls and the Portal's webhook setup
  are deleted.

Proof: `square-connection-journey` in Underclerk (code exchange, refused
code, locations, pairing, a Terminal sale that the alarm completes with one
event, one refresh for two reads at once, revoke on disconnect; fake
Square), the live `square-journey` on the Square sandbox (online and
Terminal), and `square-in-underclerk` in Satyr (a production café connects,
pairs, sells a cookie at the counter and refunds it; old tokens are handed
over; no Square token in any row of Satyr's database; removal revokes
through Underclerk). Each is break-checked.

Release: Underclerk needs `SQUARE_OAUTH_CLIENT_ID` and
`SQUARE_OAUTH_CLIENT_SECRET` (the values Satyr already holds) as production
secrets before the release, and Underclerk and Platform release together.

### Step 5 — Stripe through Underclerk, and no fallback (about 0.5–1 week)

Part A is released (2026-10-27 07:17 UTC):

- Satyr links the connected Stripe account in Underclerk when the owner
  connects Stripe and at each provider check (D16).
- `GET /v1/control/organisations/:id/commerce/payment-accounts` shows the
  merchant's payment accounts to an owner or an admin.
  `POST …/payment-accounts/stripe/onboarding` opens Stripe's hosted
  onboarding through Underclerk, with return and refresh addresses on the
  Portal page that asked. Underclerk makes the account once; each request
  gets a new link.
- The Portal's Stripe tile shows the shop's Stripe account and its state,
  and offers "Create a Stripe account" or "Finish Stripe setup".

Proof: `stripe-in-underclerk` in Satyr (onboarding makes one account and
two links, a return address outside the Portal is refused, a connected
account is linked as restricted and becomes active at the next provider
check; fake Stripe). It is break-checked.

Release: Satyr's Stripe Connect application and Underclerk's
`STRIPE_SECRET_KEY` must belong to one Stripe platform. If they do not,
Underclerk refuses each link and the café stays on `PAYMENT_CAPTURE`.

Work:

- Satyr onboarding links an existing Stripe account, or opens hosted
  onboarding, through Underclerk.
- The café's existing Stripe account links itself at the first provider
  check after the release (D16).
- Production proof: one payment with a Stripe test card through Underclerk.
- Then delete `PlatformPaymentGateway`, the `PAYMENT_CAPTURE` binding,
  `CafePaymentService`, Satyr's Stripe payment adapter and the café payment
  tables, with a patch script for the regional databases.
- A GMO binding is refused as unavailable until a GMO plan exists.

Part B was prepared on the `plan-80` branch (2026-10-27) and landed on dev
after the production payment passed (2026-10-28):

- Underclerk ends its gateway chain with `UnavailablePaymentGateway`.
  `PlatformPaymentGateway`, the `PAYMENT_CAPTURE` binding, the two payment
  authority routes and their contracts and client methods are deleted. A
  binding with no Stripe account or Square location, GMO included, gets no
  payment session.
- Satyr deletes `CafePaymentService`, its payment adapters, the payment
  authority sync at each provider change, Stripe payment and dispute
  forwarding from its webhooks, and the certification admin route.
  Activation follows D17.
- The regional databases drop five tables with
  `services/platform/scripts/plan-80-cafe-payment-tables-d1-patch.sql`:
  `cafe_payment_attempt`, `cafe_payment_observation`,
  `cafe_terminal_collection_ownership`, `square_terminal_delivery` and
  `cafe_payment_binding_certification`. The old baseline plus the patch
  equals the new baseline.

Proof: Underclerk's `stripe-after-sale` journey shows that a buyer of a
shop with no linked account gets no session and that nothing reaches
Stripe (break-checked), and `square-connection` shows that a counter sale
after a disconnect cannot start. The full Underclerk suite and the Satyr
Stripe, Square, provider and API-key journeys pass. A payment that
`CafePaymentService` started before the release can no longer be refunded
through Underclerk. Before the release, count the rows of
`cafe_payment_attempt` in production; the patch deletes them.

## Cost

About 4.5 to 5 weeks in total, more than the first estimate of 3 weeks. The
first estimate did not count Satyr's Square reads and pairing, which must
move with the tokens, or the receipt format change.

## Not in this plan

- Staff accounts with passwords (D1).
- A merchant directory inside Underclerk. Satyr keeps the map.
- Per-merchant rate limits and quotas. Each merchant already has its own
  Durable Object; limits wait for the first operator with real traffic.
- A signing key for each merchant. Every merchant object signs with one
  Underclerk key, and receipts name the merchant.
- An app token secret apart from the operator token.
- Tax, bundles, subscriptions and CSV import (spec §22).
