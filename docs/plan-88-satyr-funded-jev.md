# Plan 88 — Jev from Satyr, billed in the subscription

Status: Phases 1–4 RELEASED to production on 7 November 2026 (satyr-edge `b1d91f5c`, Slack
ingress `a8d1642c`, release tree `cbfe7b8ec`), with Plan 87 phase 1B. seams-monorepo `main`
`80a418ba` runs on the production-mainnet Console with the Jev meter, the $10 self-serve
credit limit and the customer price. The owner approved the Jev price (D9) on 7 November 2026.

Change on 21 November 2026 ([Plan 95](plan-95-pantry-own-accounts.md) step 3, on `dev`, not
released): Pantry no longer bills through the Console. Free use and the hourly records stay
local. Paid use is closed, so a call above the free use stops, until Plan 95 step 6 bills paid
use through Pantry's own Stripe account. The sections below on the Account Platform meter,
the holds and the credit limit describe the released state before that change.

## Outcome and scope

An Organisation uses the Jev features with no TypeSafe account and no API key. Satyr
calls Jev with its own TypeSafe key. An admin turns each Jev feature on or off in one
place and sees the use of the month. Each Organisation gets $1.00 of free Jev use each
month. When the free use runs out, Jev stops until the next month. Satyr then asks a
person who manages billing if the Organisation wants paid use. With paid use on, Jev
keeps running, and the use goes on the monthly invoice, as on Cloudflare Workers.

In scope:

- A Satyr TypeSafe authority beside the Organisation's own key.
- One switch for each Jev feature: mail classification, related Cases (Case context
  discovery) and the screen relevance suggestion
  ([Plan 87](plan-87-screen-context.md) section 3A).
- A monthly allowance and a hard stop for each Organisation.
- Paid use above the free use: one opt-in, billed on the monthly invoice of the
  Account Platform, up to a monthly spending limit.
- A prompt to the people who manage billing when the free use is nearly used and when
  it is used.
- A Billing page in the Portal with the use, the paid-use switch and the invoices.
- The use of the month on the settings page, and usage records on the shared Account
  Platform meter.
- An onboarding step that turns the Jev features on.
- Chat agent access to the switches and to the use.

Out of scope:

- The price of the Satyr subscription. The owner approves it apart from this plan.
- Raw Jev access for operators, their code or their plugins (D5).
- A new Jev feature. Plan 87 section 3A owns the screen relevance suggestion.
- A model change from `jev-1.13.0`.

## Facts from the code and the terms

### The TypeSafe connection today

- Each Organisation connects its own key on Integrations › TypeSafe
  (`apps/portal/src/features/integrations/typesafe-connection.tsx`). The route is
  `/v1/control/organisations/:id/integrations/typesafe`, for admins only
  (`control/routes/typesafe.ts`).
- The key is encrypted in the Vault (`vault_secret`). The pointer and its revision live
  in the Organisation Actor (`typesafe_connection`, `integrations/typesafe/connection.ts`).
  A key is saved only after a probe passes, at most one probe each 30 s.
- Two features call Jev: Case context discovery (`case-context-discovery/jev.ts`) and
  mail classification (`mail-inbox/jev.ts`). The Inbox assistant does not call Jev.
- Case context discovery is on when its policy row has a mode other than `disabled`.
  The policy pins `funding: "organisation_byo"` and `credentialRef:
"organisation_typesafe"` (`case-context-discovery/policy.ts`). No Portal control
  publishes the policy.
- Mail classification needs a row in `mail_classification_eligibility`. Only tests and
  scripts write that row; no product code writes it.
- [Plan 46](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-46-case-context-discovery.md) says: "Platform inference credentials never
  fund CaseContextCollection discovery." This plan replaces that rule (D6).

### Usage and budgets today

- Each call reserves and settles a row in `typesafe_evaluation`, in the Organisation
  Actor (`integrations/typesafe/usage-store.ts`, `evaluation-ledger.ts`). A reservation
  checks one UTC day of use against `TypeSafeUsageLimits` and fails with
  `budget_exhausted`.
- Cost is input tokens × $0.042 per million. Output tokens are free. Measured calls in
  `docs/evidence/plan-48-*` cost $0.000022 to $0.000024 each.
- Mail limits are fixed in code (`MAIL_USAGE_LIMITS`, at most $0.30 a day). Discovery
  limits come from its policy. No page shows Jev spend.

### Billing today

- Satyr bills through the shared Account Platform (`account-platform/`, the
  `ACCOUNT_PLATFORM` binding). The Account Platform has monthly postpaid billing with
  Stripe invoices, credit limits, reservations, meters and fixed price versions
  (seams-monorepo `docs/feat-3-platform-billing.md`, deployed with v0.37.0).
- Satyr's fees are still unpriced. Satyr turns report usage with the fee policy
  `customer_unpriced`, which records use and charges nothing
  (`account-platform/execution-billing.ts`).
- The shared Console billing page has a top-up. A person who may manage billing buys a
  $10, $25 or $50 credit pack through Stripe Checkout (seams-monorepo
  `apps/wallet-console/src/core/dashboard/routes/billing/BillingAccountView.tsx`,
  `packages/console-server-ts/src/billing/creditPacks.ts`). The packs fund prepaid
  accounts. A postpaid account pays on its monthly invoice instead.
- Signing already spends account credit through grants. The Account Platform gives a
  runtime a grant at a pinned price that expires within one hour, and the runtime spends
  it locally (`packages/console-server-ts/src/billing/signingCredit.ts`).
- The Satyr Portal has no billing page. Its Pricing menu points to `/pricing/`, which
  does not exist (`apps/portal/src/features/ecommerce/navigation.tsx`).
- Satyr's own provider keys are Wrangler secrets, for example `OPENROUTER_API_KEY` in
  `env.production.secrets.required` (`services/platform/wrangler.jsonc`) and
  `services/platform/src/env.ts`.

### TypeSafe terms

From the [Master Customer Agreement](https://typesafe.ai/legal/mca):

- §2.2 lets a customer put the API inside its own applications for its end users.
- §2.1 and §2.3(a) forbid a sublicence, and forbid offering the service on its own.
  So Jev may run inside Satyr features, but Satyr may not sell Jev access.
- §5 and §13.2(d) make Satyr responsible for what its end users do, and Satyr
  indemnifies TypeSafe for claims from end users.
- §4.1(c) lets TypeSafe keep customer data for telemetry, fraud checks and legal
  needs. TypeSafe offers zero data retention (ZDR) to enterprise customers.
- §8 bills in US dollars, due 30 days after the invoice, taxes excluded.
- Rate limits apply to each TypeSafe organisation. With one Satyr key, all Satyr
  Organisations share one limit.

## 1. The TypeSafe authority

One resolver gives each call its authority:

```ts
type TypeSafeAuthority =
  | { kind: "satyr_platform" } // TYPESAFE_API_KEY
  | { kind: "organisation_byo"; connectionRevision: number }; // the Vault key
```

- An Organisation with its own key keeps it. Every other Organisation uses Satyr's key.
- The sink records the authority: `TypeSafeInferenceSink` gets `funding`, and each
  `typesafe_evaluation` row stores it.
- A feature policy pins the authority. A change of authority fences the evaluations in
  flight, as a change of connection revision does now.
- The key is the Wrangler secret `TYPESAFE_API_KEY`, in the production list, the env
  type and `.dev.vars.local`. E2E tests use a fake TypeSafe that only records and
  answers.
- The disclosure check does not change. Each request still passes `TypeSafeDisclosure`
  with its purpose and the person's request authority.

## 2. Feature switches

A new section **Settings › AI features › Jev** holds one switch for each feature:

| Switch              | What it turns on                                         | Today                           |
| ------------------- | -------------------------------------------------------- | ------------------------------- |
| Mail classification | Jev sorts each new email against the mail rules          | A test-only eligibility row     |
| Related Cases       | Case context discovery, in the mode that the admin picks | A policy with no Portal control |
| Screen relevance    | The suggestion of Plan 87 section 3A                     | Built in Plan 87 phase 1B       |

- Each switch is off until an admin turns it on. A switch states what goes to TypeSafe,
  and that the use counts toward the allowance.
- A switch writes the feature's existing record: the eligibility row for mail and the
  policy for related Cases. There is no second source of truth.
- A switch turned off stops new calls at once. Accepted calls settle.
- The page shows the use of the month for each feature, the allowance and the date of
  the next reset.
- Integrations › TypeSafe stays, for an Organisation that wants its own key (D1).

## 3. Allowance, limits and records

- **Allowance.** Each Organisation gets $1.00 of TypeSafe cost each UTC month, about
  24 million input tokens (D3). The Organisation Actor checks the month to date before
  each reservation. At the allowance, Jev continues only with paid use (section 4). Without
  paid use, new calls fail with `allowance_reached` before any TypeSafe request, and the
  page says "Jev features pause until 1 December". "It runs out" is the default: Satyr
  never charges an Organisation that did not turn paid use on.
- **Daily limits.** The feature limits of today stay under the monthly allowance.
- **Fair share.** One Satyr key means one shared TypeSafe rate limit. The Organisation
  Actor allows at most 5 Jev requests a second for each Organisation. On a 429 answer,
  the relevance suggestion drops its check, and mail classification retries after
  `retry-after` (D8).
- **Records.** Each hour, the Organisation Actor sends one usage record for each feature
  to the Account Platform meter `satyr_jev_input_tokens`. The record holds the token
  total, the price version and the hour. A replayed record adds nothing. Until Satyr's
  prices are approved, the meter is unpriced (D4).

### Cost for a reference shop

| Feature             | Calls a month | Cost a call | Cost a month |
| ------------------- | ------------- | ----------- | ------------ |
| Mail classification | 1,500         | $0.000022   | $0.033       |
| Screen relevance    | 3,000         | $0.000021   | $0.063       |
| Related Cases       | 600           | $0.00007    | $0.042       |
| **Total**           | 5,100         |             | **$0.14**    |

The allowance is about 7 times this total. If every Organisation used all of it, 100
Organisations would cost Satyr $100 a month. At the reference use, they cost about $14.

## 4. Paid use and the prompt

A free monthly amount, and above it paid use. An account pays in one of two ways,
the two payment models of the Account Platform: prepaid credit that a person buys
first, or postpaid use on the monthly invoice up to a credit limit of $10 (D13).

- **Free use.** $1.00 of TypeSafe cost each UTC month (D3). No card is needed. At the
  free amount, Jev stops (section 3).
- **The prompt.** At 80 % and at 100 % of the free use, Satyr tells the people who may
  manage billing: a line on the Jev page and the Billing page, one Portal notification,
  and one sentence from the chat agent when a Jev feature stops in a chat. The text names
  the reset date and offers "Turn on paid use". A person who may not manage billing sees
  only the pause and the reset date.
- **Paid use.** "Turn on paid use" asks for a monthly spending limit (default $5, D10)
  and for one of two ways to pay:
  - **Pay after use (postpaid).** The person adds a card in the payment setup of the
    Account Platform. The account gets a credit limit of $10 at once (D12). Satyr sends
    the hourly usage records of section 3 to the meter `satyr_jev_input_tokens`. The
    Account Platform prices them, puts the month on the account's one consolidated
    invoice with the subscription, and Stripe collects it after the month. A larger
    credit limit stays with Platform support.
  - **Pay first (prepaid).** The person buys a credit pack of the shared Console ($10,
    $25 or $50) through Stripe Checkout and returns to the page. Jev spends the credit.
    With no credit left, Jev stops, and the prompt offers another pack.
    After that, Jev keeps running above the free use at the Jev price version (D9).
- **One model for each account.** The Account Platform keeps one active payment model
  for each account. A prepaid account with credit left stays prepaid; a move to postpaid
  waits until its credit is used. This rule belongs to the Account Platform. The shared
  Console account of a person who already uses Seams keeps its model.
- **Admission.** Each Jev call above the free use passes the atomic admission of the
  Account Platform: against the credit limit for postpaid, against the balance for
  prepaid. The Organisation Actor reserves a bound for a batch of calls (5 cents, at most
  one hour), as signing does, and settles the actual use. A replayed call charges
  nothing.
- **Spending limit.** At the spending limit, Jev stops until the next month or until the
  admin raises the limit. A failed payment blocks new paid use after the grace period of
  the Account Platform; the free use of the next month still works.
- **Turning paid use off.** New calls above the free use stop at once. Accepted calls
  settle, and the month's use stays on the invoice.
- **Billing page.** Settings › Billing shows the subscription, the Jev use of the month
  against the free use, the paid use so far, the spending limit, the payment model, and
  the credit left (prepaid) or the credit limit and the unpaid use (postpaid), with the
  invoices and the credit packs bought. It reads these values from the Account Platform
  and keeps no copy of a balance.
- **Agent.** The chat agent reads the use, the limit, the credit and the invoices. It
  cannot turn paid use on, buy credit or raise the limit (D11): each of those adds cost,
  so the person does it.

At $0.084 per million input tokens, a call of 520 tokens costs about $0.00004 above the
free use. $5 pays for about 115,000 calls, and a $10 pack about 230,000. At the
reference use of section 3, a shop spends about $0.14 a month and never pays.

The Account Platform today requires Platform support to approve each postpaid credit
limit; a saved card alone grants no credit (seams-monorepo
`docs/feat-3-platform-billing.md`). The $10 limit at payment setup is one change there
(D12). Prepaid credit packs work today.

## 5. Onboarding

Onboarding gets one step: "Use Jev for mail sorting, related Cases and screen
suggestions". One choice turns on all three switches. The step names TypeSafe as the
processor and links to the settings page.

## 6. Chat agent access

- The agent reads the switches and the use of the month with `jev_features_read`.
- The agent changes a switch with `jev_features_manage`, for admins only, through an
  approval card. Turning a switch on sends new data to TypeSafe, so the person approves
  each change.
- Both are `defineTool` values in a family module under `agent-tools/`. The two
  capabilities go into `authorization/capability-catalogue.ts`, and the release runs
  `node scripts/capability-policy-backfill-sql.mjs`.

## 7. Terms and data

- Jev runs only inside Satyr features. No tool, Code Mode capability, plugin or API
  sends an operator's own question to Jev (D5).
- Satyr's terms and privacy notice name TypeSafe as a processor.
- Satyr asks TypeSafe for ZDR and for higher rate limits before the release (D7).

## 8. Phases, costs and acceptance

Times are estimates in agent days.

| Phase                           | Result for the person                                                                                                                                      | Agent days | Gate         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| 1. Satyr authority and switches | Jev features work with no key; the settings page with three switches; the Plan 46 rule changes                                                             | 3–4        | J1, J2, J6   |
| 2. Allowance and records        | The month to date, the allowance and the stop; the hourly meter records                                                                                    | 3–4        | J3, J4       |
| 3. Onboarding and agent         | The onboarding step and the two agent tools                                                                                                                | 1–2        | J5           |
| 4. Paid use and the prompt      | The Jev price version on the postpaid meter, the prompt at 80 % and 100 %, the paid-use switch with payment setup and the spending limit, the Billing page | 3–4        | J4 again, J7 |

The total is 10–14 agent days. Phase 1 is useful alone. Phase 4 waits for the price of
the subscription and the Jev price version.

### Phase 1 as built

- `integrations/typesafe/authority.ts` resolves `TypeSafeAuthority`. The current
  authority is the Organisation's key when one is connected, else Satyr's key
  (`TYPESAFE_API_KEY`). `TypeSafeInferenceSink.funding`, the `typesafe_evaluation`
  column `funding`, the discovery route (`funding: "satyr_platform"`, credential
  `satyr_typesafe`) and the `mail_classification_eligibility` column `funding`
  name it. Satyr's key pins revision 0 in the eligibility row.
- The mail head no longer pins a key revision. Each mail call uses the current
  authority, checks the eligibility row of that authority, and the ledger fences
  a call whose authority changes in flight.
- A connect or a disconnect of the Organisation's key re-pins the discovery policy
  and the mail eligibility rows to the new authority. The switches stay on.
- `GET`/`POST /v1/control/organisations/:id/jev-features`: every member reads,
  only an admin changes (a lower role gets 404, as every admin route). Turning a
  switch on needs a key for the current authority (`jev_key_unavailable`) and a
  Gmail mailbox (`jev_feature_source_unavailable`). Related Cases uses the Gmail
  mailboxes as sources, mode Suggestions (`metadata_only`) by default, and the
  daily limits in `jev-features/limits.ts` ($0.15 a day).
- The Screen relevance switch is the Organisation Actor table
  `jev_screen_relevance_switch`. Plan 87 phase 1B reads it for each check.
- The Portal page is Settings › Jev (`apps/portal/src/features/jev-features/`).
- D1 patch: `services/platform/scripts/plan-88-mail-eligibility-funding-d1-patch.sql`
  for each regional database, before the release.
- A release needs `TYPESAFE_API_KEY` first: Wrangler refuses a deploy when a
  required secret is missing.
- Limits of phase 1: a mailbox connected after the switch was turned on is "Not
  on" until an admin turns the switch off and on. A Gmail reconnect gives a new
  source pin, with the same effect. No allowance or meter yet (phase 2).

### Phase 2 as built

- Each reservation on Satyr's key checks the TypeSafe cost of the UTC month across
  every Jev feature (`readMonthlySatyrTypeSafeCost`). A settled call counts its
  measured cost; a call with no measure counts its reservation. If the reservation
  does not fit in $1.00, the call fails with `allowance_reached` before any TypeSafe
  request. The Organisation's own key is not counted.
- Mail work that meets `allowance_reached` waits until the first day of the next UTC
  month. Related Cases drops its check for that email.
- More than 5 Satyr-funded requests in one second fail with `rate_limited`; mail and
  related Cases retry. No journey covers the fair share yet.
- The Jev view has `allowance` (used, limit, reset date, reached), and the Jev page
  shows "Free use this month" and the pause.
- **Hourly records (J4).** The Organisation Actor table `jev_usage_hour` holds one row
  for each feature and UTC hour of use on Satyr's key. The alarm seals an hour five
  minutes after it ends, from the ledger, and delivers it to the meter
  `satyr.jev_input_tokens` with a fixed event id, so a repeated delivery adds nothing.
  A call on the Organisation's own key is not in the record.
  - Every account sends its hours (D9). The Account Platform prices them with the
    account's Jev price version: `satyr-jev-input-tokens-v1` for an isolated test
    account, `satyr-jev-input-tokens-customer-v1` for every other account. Inside the
    free use a record charges nothing. (Before D9, a `customer_unpriced` account kept
    its hours and sent nothing.)
  - Inside the free use no record raises the month's charge, so the record names no
    reservation. Paid use (phase 4) reserves each feature-hour first
    (`satyrJevExecutionIdV1`).
  - A refused record (`price_unavailable`, `event_conflict`, …) is kept as `refused`;
    a failed request retries with a backoff up to one hour.
- **seams-monorepo** `dev` `ea9805b4` (local, not pushed or deployed) has the meter,
  its price and the self-serve credit limit:
  - The meter `satyr.jev_input_tokens`: unit `input_token`. Price
    `satyr-jev-input-tokens-v1` (kind `block_measured`): 84 minor per 10,000,000 tokens
    after 23,809,523 free tokens each UTC month, rounded up once for the month, for
    isolated test accounts. The customer version `satyr-jev-input-tokens-customer-v1`
    has the same terms (D9, seams branch `plan-88-jev-customer-price`).
  - `POST /console/billing/satyr-paid-use/postpaid` (`billing.manage`): an eligible
    prepaid account with a verified card and no prepaid balance becomes postpaid with
    a 1000-minor limit, audited as `system:satyr-self-serve-paid-use`. A limit that
    support set never changes.
  - Migrations 0020 (core) and 0116 (wallet) rebuild three billing tables.
  - The test Worker's primary account uses the Enterprise fixed resource contract,
    because Wallet bills Free, Growth and Pro accounts by MAU since 31 October 2026.
- Satyr vendors `@seams-internal/console-shared` 0.1.2 (`vendor/seams/`).
- The Satyr journeys need an account Worker built from seams `dev` `ea9805b4` or
  later. The shared build at `~/Dev/rust/seams-monorepo/.artifacts/` is from
  27 October and has no Jev meter; rebuild it before J4 runs there.

### Phase 3 as built

- The agent tools are in `agent-tools/jev/`. `jev_features_read` returns the
  view of Settings › Jev, from `readJevFeatures`. A field that a later phase adds
  to the view reaches the agent too. Every member may use it. The read enters
  the turn through the information-flow source `jev_settings`, which every
  member may read.
- `jev_features_manage` takes `{ feature, enabled, mode }`. It stages an
  approval card (draft family `jev_feature`) and changes nothing. Only an owner
  or admin can stage the card and approve it. The approval runs
  `manageJevFeature` with the user id of the person who asked. A switch that
  cannot turn on settles the card with the page's reason, for example
  `jev_feature_source_unavailable`.
- The capabilities are `jev.features.read` and `jev.features.manage`. An agent
  can ask for each one with the Allow prompt. The release runs
  `node scripts/capability-policy-backfill-sql.mjs` for each regional database.
- The setup dialog has a new step, Jev, between Prepare and Done. It names
  TypeSafe as the processor and links to Settings › Jev. "Turn on Jev" turns
  on the three switches through the jev-features route. A switch that cannot
  turn on shows its reason, and the setup continues. Skip leaves every switch
  off. A new organisation has no Gmail mailbox, so only Screen relevance turns
  on there.
- Journey J5 is `tests/e2e/plan-88-jev-agent.test.ts`. The evidence is
  `docs/evidence/plan-88-phase-3-journey.md`.
- The read carries the free use of the month (`allowance`, phase 2).
- Limit of phase 3: a person who loses the admin role keeps a pending card, but its
  approval is refused.

### Phase 4 backend as built

- Paid use is the Organisation Actor table `jev_paid_use` (on or off, spending limit in
  cents, default 500). `POST /v1/control/organisations/:id/jev-features/paid-use` with
  `{ enabled, spendingLimitMinor }` changes it; only the owner may (another role gets
  404). The chat agent has no tool for it (D11).
- Above the free use, before a mail or related Cases call, the Organisation Actor holds
  5 cents on the Account Platform for that feature-hour (`jev_paid_hold`, execution id
  `satyrJevExecutionIdV1`), with the account's Jev price version (test or customer).
- The ledger then admits the call only with paid use on, a hold for the hour, the
  hour's tokens inside the hold, and the month's charge with this call's reservation
  inside the spending limit. Refusals: `allowance_reached` (paid use off),
  `spending_limit_reached` (mail waits for the next month), `paid_use_unfunded` (no
  hold: no credit, or the price is not open; mail waits a day).
- The hourly record names the hold, and the Account Platform settles it for the rise of
  the month's charge, or releases it. A held hour with no calls sends a zero-token
  record, so no hold stays open.
- The Jev view has `paidUse` (`enabled`, `spendingLimitMinor`, `spentMinor`, `priced`).
- Not built: the Seams Console link (the Portal has no Console origin), a Portal
  notification (no notification surface), and the chat sentence (no Jev feature runs
  in chat yet).

### Phase 4 Portal as built

- Settings › Jev has a Paid use section under the free-use line
  (`features/jev-features/paid-use.tsx`). It names the two ways to pay, the $10
  credit limit and the price. The owner has the switch and the monthly spending limit
  in dollars with Save; the switch saves at once with the limit in the field. Other
  members see the state and "Only the owner can turn on paid use." With paid use on,
  the section shows "This month: $x.xx of $y.yy" and the stop at the limit.
  `priced: false` says that paid Jev use is not open yet and disables turning it on;
  `priced: null` says that Satyr could not read the Seams account. An Organisation on
  its own key has no Paid use section.
- The prompt: at 80 % of the free use, or when it is used, with paid use off, one line
  names the share and the reset date. The owner gets "Turn on paid use", which focuses
  the switch; another member is told to ask the owner.
- Settings › Billing (`features/billing/route.tsx`) reads the same jev-features view:
  the free use of the month, paid use, the month's paid charge, the spending limit and
  the prompt. Its "Turn on paid use" opens Settings › Jev at `#jev-paid-use`.
- Limits: the Portal has no Seams Console origin or billing route, so "Payment method,
  credit and invoices" is text with no link. The Portal has no notification surface, so
  the one Portal notification of section 4 needs backend work and is not built. The
  Billing page does not show the subscription, the payment model or the credit yet;
  the view does not carry them. The chat agent keeps D11: it does not change paid use.
- The preview `jev-features-preview.html` has the cases `near`, `used-viewer`, `paid`
  and `unpriced`, and `?page=billing`.

### E2E acceptance journeys

Each journey writes a repeatable artifact in `docs/evidence/plan-88-*`. The fake
TypeSafe only records and answers. Product code produces each asserted outcome.

- **J1 — No key.** An Organisation with no TypeSafe key turns on mail classification. A
  new email is sorted. The fake TypeSafe received Satyr's key, and no Vault key was read.
- **J2 — Switch off.** The admin turns off related Cases. A new Case starts no Jev
  request, and mail classification still works. A member who is not an admin cannot
  change a switch.
- **J3 — Allowance.** The Organisation reaches its allowance. The next Jev call fails
  before any TypeSafe request, and the page names the reset date. A call accepted
  before the stop settles.
- **J4 — Records.** The hour's use reaches the Account Platform meter once, with the
  exact token total. A replayed record adds nothing.
- **J5 — Agent.** The chat agent answers "How much Jev did we use this month?". It turns
  off screen relevance after the admin approves the card. For a viewer, the agent's
  change is refused.
- **J6 — Own key.** An Organisation with its own key uses it. No use goes to Satyr's
  meter.
- **J7 — Paid use.** The Organisation has used its free use. The next Jev call fails
  before any TypeSafe request, and a person who manages billing gets the prompt. A fake
  Stripe only records and answers.
  - Postpaid: that person adds a test card and sets a spending limit of 1 cent. The
    account gets a $10 credit limit. The next Jev call runs, and the hour's record puts
    the exact price of its tokens on the account's month. At 1 cent, Jev stops again.
  - Prepaid, in a second Organisation: that person buys a $10 pack. The next Jev call
    runs, and the hour's record lowers the credit by the exact price of its tokens.
  - A member who may not manage billing sees no "Turn on paid use" and cannot turn it on
    or buy a pack. The chat agent cannot do either. An Organisation that never turned
    paid use on is charged nothing.

One real journey runs before a release: one call for each feature with the production
`TYPESAFE_API_KEY`, and the meter record of that hour. For phase 4 it also buys one $10
pack in Stripe test mode and spends part of it on Jev.

### Risks

- **Terms.** §2.3(a) forbids selling Jev access. D5 keeps Jev inside Satyr features.
- **Shared rate limit.** One busy Organisation can slow the others. The fair share of
  section 3 and a higher TypeSafe limit bound it.
- **Satyr pays for misuse.** The allowance stops each Organisation at $1.00 a month.
- **Data.** Satyr becomes the TypeSafe customer for its Organisations' data. The
  switches, the terms and ZDR cover this.
- **Price change.** Each price version pins the model and its token price. A new
  TypeSafe price needs a new price version.
- **Unpaid invoices.** Satyr pays TypeSafe before the customer pays Satyr. The spending
  limit and the credit limit of the Account Platform bound the loss for each account.
- **Small invoices.** A card charge for a few cents loses money to the card fee. Jev use
  goes on the one consolidated monthly invoice with the subscription, never on a charge
  of its own.

## Decisions

The cost column states what the recommendation costs beyond the phase, or what it gives
up.

| ID  | Decision                                 | Recommendation                                                                                                                                                        | Cost                                                                                                         | Default                                                                                                    |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| D1  | Default authority                        | Satyr's key; an Organisation's own key stays as an option                                                                                                             | Two authorities to keep                                                                                      | Recommendation                                                                                             |
| D2  | Default switch state                     | Off until an admin turns it on; one onboarding step turns on all three                                                                                                | One onboarding step                                                                                          | Recommendation                                                                                             |
| D3  | Allowance                                | $1.00 of free TypeSafe cost a month for each Organisation; when it runs out, Jev stops unless paid use is on                                                          | At most $1.00 a month for each Organisation; about $0.14 at the reference use                                | Accepted by the owner, 6 and 7 November 2026                                                               |
| D4  | Before Satyr's prices exist              | An unpriced meter; Satyr pays, bounded by D3                                                                                                                          | About $14 a month for 100 Organisations at the reference use                                                 | Replaced by D9 on 7 November 2026: every account's hours go to the meter, and the free use charges nothing |
| D5  | Raw Jev access                           | None; Jev only inside Satyr features                                                                                                                                  | Operator plugins cannot use Jev                                                                              | Recommendation                                                                                             |
| D6  | Plan 46 funding rule                     | Satyr may fund discovery under the switch and the allowance                                                                                                           | One edit to Plan 46                                                                                          | Recommendation                                                                                             |
| D7  | ZDR and rate limits                      | Ask TypeSafe before the release                                                                                                                                       | Unknown price; one request from the owner                                                                    | Ask before phase 2                                                                                         |
| D8  | Fair share                               | 5 requests a second for each Organisation; checks drop on 429, mail retries                                                                                           | A busy Organisation can wait                                                                                 | Recommendation                                                                                             |
| D9  | Jev price above the free use             | $0.084 per million input tokens, two times the TypeSafe cost; no base fee                                                                                             | $5 pays for about 115,000 calls                                                                              | Accepted by the owner, 7 November 2026                                                                     |
| D10 | Monthly spending limit on paid use       | $5 by default; the admin can change it                                                                                                                                | Jev stops at the limit until the admin raises it                                                             | Recommendation                                                                                             |
| D11 | Agent and paid use                       | The agent reads the use and the limit; it cannot turn paid use on or raise the limit                                                                                  | The person opens payment setup                                                                               | Recommendation                                                                                             |
| D12 | Credit limit for self-serve postpaid use | The Account Platform grants a $10 credit limit when a person who manages billing completes payment setup for Satyr paid use; larger limits stay with Platform support | One change in the shared Account Platform (seams-monorepo); Satyr's loss on an unpaid account is at most $10 | Accepted by the owner, 7 November 2026                                                                     |
| D13 | Billing model                            | Free use, then prepaid credit packs or postpaid use on the monthly invoice up to the credit limit; one model for each account                                         | Two paths in J7; the Account Platform already has both models                                                | Accepted by the owner, 7 November 2026                                                                     |

## Actions for the owner

1. Open Satyr's TypeSafe account under the entity that bills Satyr customers. Accept the
   MCA and the DPA, and create a production API key.
2. Set the key yourself, so that it never goes into the repository:
   `pnpm --filter satyr-edge exec wrangler secret put TYPESAFE_API_KEY --env production`.
3. Ask TypeSafe for ZDR and a higher rate limit
   ([support form](https://support.typesafe.ai/forms/support-request)).
4. Add TypeSafe as a processor to Satyr's terms and privacy notice.
5. Approve the price of the Satyr subscription, with the Jev allowance inside it, and the
   Jev price above the free use (D9). Platform support then publishes the Jev price
   version on the Account Platform.
6. Approve the change in seams-monorepo for D12: a $10 credit limit at payment setup.

## Effect on other plans

- **Plan 46:** the funding rule changes (D6). Policies can pin `satyr_platform`.
- **Plan 87:** section 3A uses the authority of section 1 and the Screen relevance
  switch.
- **Plan 29F (mail classification):** the switch writes the eligibility row.
- **Plan 50:** a new funding kind for TypeSafe. Model routes do not change.
- **Plan 42J:** each evaluation record names its authority.
- **Shared Account Platform:** a new meter and its price version, prepaid and postpaid
  admission for Jev above the free use, and a $10 credit limit at payment setup (D12).
  The Satyr Billing page uses its payment setup, credit packs and invoices.
- **`docs/economics-costs.md`:** a Jev line in the variable cost.
