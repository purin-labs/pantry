# ORG-02 — Jev from Purin

Jev is a small AI model (`jev-1.13.0`) that TypeSafe runs. Three Purin Pantry features
call it: mail classification, related Cases and the screen relevance suggestion. An
Organisation needs no TypeSafe account: Pantry calls Jev with the Purin key
`TYPESAFE_API_KEY`. An Organisation can connect its own key instead. An admin turns each
feature on or off on Settings › Jev. Each Organisation gets $1.00 of free TypeSafe cost
on the Purin key in each UTC month. At that amount, Jev stops until the next month. Paid
use above the free use is closed, because Pantry has no billing of its own yet. Sous
Chef reads the settings and proposes a switch change on a card that an admin approves.

## What it does

### Who pays: the TypeSafe authority

- `currentTypeSafeAuthority` (`integrations/typesafe/authority.ts`) gives each new call
  its authority. If the Organisation connected its own key, the authority is
  `organisation_byo` with the connection revision. Otherwise it is `pantry_platform`.
- `resolveTypeSafeCredential` reads the Purin key from the Worker secret, or the
  Organisation's key from the Vault. It reads the Vault only for `organisation_byo`.
- Each call stores its authority in `typesafe_evaluation.funding`. If the authority
  changes while a call is in flight, the ledger marks the call `stale`, and its answer
  is not used.
- A connect or a disconnect of the Organisation's key moves the switches to the new
  authority. Each mailbox that was on stays on, and the related Cases policy gets the
  new route. The switches stay on.
- Integrations › TypeSafe stays for an Organisation that wants its own key. Pantry saves
  a key only after a probe passes, and allows one probe in each 30 s.
- If TypeSafe rejects the key in an own-key test (HTTP 401 or 403), Pantry disconnects
  the key. The authority then moves to the Purin key, and the switches that were on
  move with it. Later use counts toward the free use.

### Settings › Jev

The page is in the Settings group of the Portal (`apps/portal/src/features/jev-features/`).

| Switch              | What it turns on                                                                      | Record that it writes                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Mail classification | Jev sorts each new email against the mail rules                                       | One `mail_classification_eligibility` row for each active Gmail mailbox with the product `full_mailbox_pilot` |
| Related Cases       | Case context discovery, mode Suggestions (`metadata_only`) or Measure only (`shadow`) | The Case context discovery policy                                                                             |
| Screen relevance    | The suggestion of FND-09                                                              | `jev_screen_relevance_switch` (Organisation Actor)                                                            |

- Each switch is off until an admin turns it on. Each row states what goes to TypeSafe.
  On the Purin key, the row says that the use counts toward the allowance. On an own
  key, it says that TypeSafe bills that key.
- A switch writes only the record of its feature. Pantry keeps no second record of a
  switch.
- A switch turned off stops new calls at once. A call that started settles.
- To turn a switch on, a key for the current authority must resolve and have a valid
  format (`jev_key_unavailable`). This step sends no request to TypeSafe, so a revoked
  key with a valid format passes. Mail classification needs an active Gmail mailbox with
  the full mailbox product. Related Cases needs an active Gmail mailbox. Else the
  refusal is `jev_feature_source_unavailable`.
- Related Cases uses at most 20 active Gmail mailboxes as sources. A command with no mode
  keeps `shadow` if the policy was `shadow`, else it uses `metadata_only`. The page also
  shows the mode `party_context` ("Reply context"), but the switch cannot set it.
- Related Cases has a safety stop. If TypeSafe answers 401, 402 or 403 for the current
  authority, or a call measures more than its reservation, Pantry sets the policy to
  `disabled` (`system:case-context-collection-safety-stop`). The switch then reads off.
- The page shows who pays, the mailboxes that Jev sorts, and the free use of the month
  with its reset date. A member who is not an admin sees the switches and
  "Only an admin can change these switches."

### The free use and the stop

- On the Purin key, each reservation adds the cost of the UTC month across the three
  features. A settled call counts its measured cost. A call with no measure counts its
  reservation.
- If the reservation does not fit in $1.00, the call fails with `allowance_reached`
  before any TypeSafe request. A call on the Organisation's own key is not counted.
- Mail work that meets `allowance_reached` waits (`budget_paused`) until the first day of
  the next UTC month. Related Cases drops its check for that email. The relevance check
  drops.
- Each feature stops at its own reservation: Related Cases above $0.99 of use, mail
  above $0.997, and screen relevance above $0.9996.
- The view field `allowance.reached` uses the fixed mail reservation (3,000
  microdollars), so it is true above $0.997. The page then says that Jev features pause,
  but screen relevance can still run up to $0.9996.
- Cost is the input tokens × $0.042 per million. Output tokens cost nothing. $1.00 is
  about 23,809,523 input tokens.

### The fair share

The ledger refuses a sixth call on the Purin key in one second for one Organisation,
with `rate_limited`. Mail work then retries after 60 s, and becomes `blocked` after 5
attempts. Related Cases retries. The relevance check drops.

### Daily limits under the allowance

| Feature             | Constant                                                             | Calls a day        | Cost a day | Reservation | Timeout |
| ------------------- | -------------------------------------------------------------------- | ------------------ | ---------- | ----------- | ------- |
| Mail classification | `MAIL_USAGE_LIMITS` (`mail-inbox/evaluation.ts`)                     | 100                | $0.30      | $0.003      | 10 s    |
| Related Cases       | `JEV_RELATED_CASES_LIMITS` (`jev-features/limits.ts`)                | 200 (15 in effect) | $0.15      | $0.01       | 10 s    |
| Screen relevance    | `SCREEN_RELEVANCE_LIMITS` (`jev-features/screen-relevance-check.ts`) | 500                | $0.20      | $0.0004     | 5 s     |

A call above a daily limit fails with `budget_exhausted`. The same code covers the
concurrent calls (mail 4, Related Cases 2, screen relevance 4) and the daily input bytes,
input tokens and wall time. After this code, mail work waits until the next UTC day, also
when only the concurrent limit stopped it. Related Cases retries. The relevance check
drops. The day and the month are UTC.

The daily cost counts the larger of the reservation and the measured cost of each call.
Thus 15 Related Cases calls use the whole $0.15, and the ledger refuses the 16th call.
The byte and token limits of Related Cases alone stop it at 50 calls.

### Hourly records of use

- The Organisation Actor alarm seals each closed UTC hour of use on the Purin key, five
  minutes after the hour ends (`SEAL_GRACE_MS`). It writes one `jev_usage_hour` row for
  each feature, with the token total and the call count. Its `source_digest` column
  holds canonical JSON that names the calls of the hour. It is not a hash.
- A sealed hour has the state `not_billed`. It is the Organisation's own record of use.
  Pantry sends it to no meter. A repeated seal writes nothing
  (`ON CONFLICT DO NOTHING`, and the cursor `jev_usage_cursor`).
- Jev asks for an alarm only while an unsealed call on the Purin key exists. The seal
  step runs on each alarm of the Organisation Actor, also an alarm for other work. In
  a new closed hour, that step moves `jev_usage_cursor`, even with no Jev use.

### Paid use

- `jev_paid_use` keeps the paid-use switch and a monthly spending limit in cents. The
  default limit is 500 ($5.00). The owner can set 1 to 100,000 cents.
- `JEV_PAID_USE_OPEN` is `false`. A command that turns paid use on fails with
  `jev_paid_use_closed`. The owner can still turn it off and change the limit.
- The view field `paidUse.priced` is `false`. The Portal disables the switch and says:
  "Paid Jev use is not open yet. It opens when Purin Pantry billing starts."
- `paidUse.spentMinor` is the month's charge at 84 cents for each 10,000,000 input tokens
  above 23,809,523 free tokens, rounded up one time.
- The prompt: at 80 % of the free use, with paid use off, one line names the share and
  the reset date. If `allowance.reached` is true (above 99.7 %), the line says "all of"
  the free use. The owner gets "Turn on paid use", which scrolls to the Paid use section
  and calls `focus()` on its switch. Another member reads "Ask the owner to turn on paid
  use."
- An Organisation on its own key has no allowance and no Paid use section.

### Settings › Billing

Settings › Billing (`areas/organisation/ui/features/billing/route.tsx`) reads the same view.
It shows the Jev use of the month against the free use, paid use, the charge of the
month, the spending limit and the prompt. Its "Turn on paid use" opens Settings › Jev at
`#jev-paid-use`. It keeps no copy of a balance.

### The setup step

The setup dialog has a step Jev between Prepare and Done
(`areas/organisation/ui/pages/account-onboarding-jev.tsx`). It names TypeSafe as the processor
and links to Settings › Jev. "Turn on Jev" turns on the three switches through the
jev-features route. A switch that cannot turn on shows its reason, and the setup
continues. Skip leaves every switch off. A new Organisation has no Gmail mailbox, so
only Screen relevance turns on there. ORG-01 owns the rest of the setup.

### Agents

The tools are in `services/platform/src/agent-tools/jev/`, the family `jev`.

| Tool                  | Capability            | Effect   | What it does                                                                                                                                                 |
| --------------------- | --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `jev_features_read`   | `jev.features.read`   | Read     | The view of Settings › Jev, from `readJevFeatures`: who pays, the key state, each switch, the mailboxes, the free use and paid use. Every member may read it |
| `jev_features_manage` | `jev.features.manage` | Proposal | Takes `{ feature, enabled, mode }` and stages a `jev_feature` configuration draft. It changes nothing                                                        |

- Only an owner or admin can stage the card (`roleMayConfigure`). Only the person who
  asked can confirm it (`operator_draft_actor_mismatch`), and that person must still be
  an owner or admin.
- The approval calls `manageJevFeature` as the person who asked. A switch that cannot
  turn on settles the card with the page's reason: `jev_key_unavailable`,
  `jev_feature_source_unavailable` or `jev_feature_unavailable`.
- The card names the change and the data that goes to TypeSafe
  (`presentJevDraftCommand`). A card that turns a switch on always says that the use
  counts toward the Jev allowance, also for an Organisation on its own key. The receipt
  scope is `jev.<feature>.on` or `jev.<feature>.off`.
- The agent has no tool for paid use, a credit purchase or the spending limit.

## Contracts

- Organisation Actor SQLite:
  - `typesafe_connection` and `typesafe_credential_cleanup`
    (`integrations/typesafe/connection.ts`): the pointer to the Organisation's Vault key
    and its revision.
  - `typesafe_evaluation` (`integrations/typesafe/usage-store.ts`): one row for each Jev
    call. It holds `purpose`, `funding`, `connection_revision`, the reservation, and the
    measured tokens and cost. Its `state` is `reserved`, `evaluated`, `failed` or
    `stale`. Its `settlement_state` is `pending` or `settled`.
  - `jev_screen_relevance_switch` and `jev_screen_relevance_record`
    (`jev-features/screen-relevance.ts`).
  - `jev_usage_hour` and `jev_usage_cursor` (`jev-features/usage-records.ts`).
  - `jev_paid_use` (`jev-features/paid-use.ts`).
- Regional D1 (`services/platform/migrations-regional/0001_current_schema.sql`):
  `mail_classification_eligibility`, with `funding` and `connection_revision`. The Purin
  key pins revision 0. The model is `jev-1.13.0`, the recipient `typesafe`, and the
  review ends 10 years after the switch (`SWITCH_REVIEW_MS`).
- The ledger (`integrations/typesafe/evaluation-ledger.ts`): `reserveTypeSafeEvaluation`
  and `settleTypeSafeEvaluation`, `JEV_MONTHLY_ALLOWANCE_MICROUSD` (1,000,000) and
  `JEV_REQUESTS_PER_SECOND` (5). Errors: `revision_conflict`, `command_conflict`,
  `inactive`, `budget_exhausted`, `allowance_reached`, `rate_limited`, `store_invalid`.
- The transport (`integrations/typesafe/system-one-client.ts`) posts to
  `https://api.typesafe.ai/v1/systemone`. A request is at most 24,576 bytes and a response
  32,768 bytes. HTTP 401 and 403 give `jev_credential_rejected`, 402 gives
  `jev_budget_exhausted`, and other errors give `jev_unavailable`.
- The sink `TypeSafeInferenceSink` (`policy/information-flow/types.ts`) names the
  purpose, the `funding` and the model of each call.
- The domain functions (`jev-features/organisation-settings.ts`):
  `readJevFeaturesForOrganisation`, `manageJevFeatureForOrganisation` and
  `manageJevPaidUseForOrganisation`, called through `OrganisationJevRpc` on the
  Organisation Actor.
- The contract (`packages/control-api/src/portal/jev-features.ts`): `JevFeaturesView`,
  `JevAllowance`, `JevPaidUse`, `JevFeatureCommand` and `JevPaidUseCommand`, with their
  parsers.
- The draft family `jev_feature` (`integrations/contract/jev-draft.ts`) in
  `data/operator-configuration-draft.ts`.
- The Worker secret `TYPESAFE_API_KEY` is in `env.production.secrets.required` of
  `services/platform/wrangler.jsonc` and in `foundation/kernel/env.ts`.
- `services/platform/scripts/plan-88-mail-eligibility-funding-d1-patch.sql` is a record
  of the old stack. The new databases loaded the baseline with the column.

The control routes (`services/platform/src/control/routes/`):

| Route                                                             | Role   | Purpose                                                      |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| `GET /v1/control/organisations/:id/jev-features`                  | Viewer | The view                                                     |
| `POST /v1/control/organisations/:id/jev-features`                 | Admin  | One `JevFeatureCommand`                                      |
| `POST /v1/control/organisations/:id/jev-features/paid-use`        | Owner  | `{ enabled, spendingLimitMinor }`                            |
| `GET`, `POST /v1/control/organisations/:id/integrations/typesafe` | Admin  | Read, connect, test or disconnect the Organisation's own key |

A role below the route's role gets 404. On the jev-features routes, a body over 4,096
bytes, a body that is not JSON and a body that is not an object give 400
(`jev_feature_invalid`). An `_invalid` code from the Actor, such as a command that the
parser refuses, gives 422. Another refusal gives 409, and a failure of the Actor gives
503 (`jev_features_unavailable`).

## Rules and limits

| Action                                       | Viewer and operator | Admin | Owner                            | Agent                                  |
| -------------------------------------------- | ------------------- | ----- | -------------------------------- | -------------------------------------- |
| See the switches, the free use and paid use  | Yes                 | Yes   | Yes                              | `jev_features_read`                    |
| Turn a switch on or off                      | No                  | Yes   | Yes                              | Proposal; the admin who asked approves |
| Connect or remove the Organisation's own key | No                  | Yes   | Yes                              | No                                     |
| Change paid use or the spending limit        | No                  | No    | Yes, but paid use cannot turn on | No                                     |

| Limit                     | Value                                  | Constant                                 |
| ------------------------- | -------------------------------------- | ---------------------------------------- |
| Free use on the Purin key | $1.00 each UTC month                   | `JEV_MONTHLY_ALLOWANCE_MICROUSD`         |
| Fair share                | 5 calls a second for each Organisation | `JEV_REQUESTS_PER_SECOND`                |
| Seal of an hour           | 5 minutes after the hour ends          | `SEAL_GRACE_MS`                          |
| Default spending limit    | 500 cents                              | `JEV_DEFAULT_SPENDING_LIMIT_MINOR`       |
| Paid use                  | Closed                                 | `JEV_PAID_USE_OPEN`                      |
| Own-key probe             | 1 each 30 s                            | In `integrations/typesafe/connection.ts` |

- **Information flow.** Each feature request passes `TypeSafeDisclosure` with its
  purpose and a source authority: `control` for mail classification and screen
  relevance, and `agent_mailbox` for Related Cases. The own-key probe sends fixed text
  and does not pass `TypeSafeDisclosure`. The agent read enters the turn under the
  source label `jev_settings`, which every member may read. The read tells the agent to
  quote a mailbox name as data.
- **No raw Jev access.** Jev runs only inside the three Pantry features and the own-key
  probe. The probe sends one fixed synthetic request on a connect or a test, and the
  ledger does not record it. No tool, Code Mode capability, plugin or API sends an
  operator's own question to Jev.
- **Capabilities.** `jev.features.read` and `jev.features.manage` are in
  `authorization/capability-catalogue.ts` and in `requestable-capabilities.ts`, so an agent
  can ask for each in the permission prompt. Each needs
  `node scripts/capability-policy-backfill-sql.mjs`.
- **Idle cost.** A read of the view writes nothing. With no Jev use and no other alarm,
  Jev writes nothing. Another alarm can cause one cursor write for each closed hour.
- **Neighbours.**
  - FND-09 owns the screen relevance suggestion, its check and its records. This spec
    owns only its switch and its allowance.
  - INB-01 owns the mail rules and mail classification. This spec owns the eligibility
    rows that the switch writes.
  - Case context discovery (Plan 46, in the archive) owns related Cases. This spec writes
    its policy, its route `pantry_typesafe` or `organisation_typesafe`, and its limits.
  - FND-08 owns the Vault that keeps the Organisation's key. FND-06 owns roles and
    billing access. COM-05 describes the store `operator_configuration_draft`.
  - ORG-01 owns the setup dialog. [Plan 95](../../../plan-95-pantry-own-accounts.md) owns
    Pantry's own billing, which paid use waits for.
- **Out of scope:** a new Jev feature, a model other than `jev-1.13.0`, and the price of
  the Pantry subscription.

## Open work

- Paid use is closed until Pantry bills through its own Stripe account (Plan 95 step 6).
  No hold, no admission above the free use and no meter delivery exist.
  `spending_limit_reached` and `paid_use_unfunded` are not built.
- Settings › Billing shows no subscription, payment model, credit, card or invoice. Its
  line "Payment method, credit and invoices" names a Console that Pantry no longer uses.
- The Paid use section on Settings › Jev still describes billed use: prepaid credit, a
  monthly invoice, a $10 credit limit and "the Seams account". Paid use is closed, and
  Pantry no longer bills through the Console.
- Pantry has no Portal notification at 80 % or 100 % of the free use. No chat sentence
  tells a person that a Jev feature stopped.
- A TypeSafe HTTP 429 gives `jev_unavailable`, and the mail work ends `blocked`. Pantry
  does not read `retry-after`. No journey covers the fair share.
- A mailbox connected after the switch was turned on is not on until an admin turns the
  switch off and on. A Gmail reconnect gives a new source pin, with the same effect.
- If the move of the mail switch to a new authority fails, Pantry logs a warning
  (`organisation.jev_mail_repin_failed`) and does not retry. Those mailboxes then read
  as not on, until an admin turns the switch off and on.
- A person who loses the admin role keeps a pending card. Its approval is refused.
- `jev_screen_relevance_record` has no view that reads it (FND-09).
- The seal step writes `jev_usage_cursor` when a closed hour has no Jev use. This breaks
  the rule that a run with no change writes nothing.

## Sources

- [Plan 88](../../../history/plan-88-satyr-funded-jev.md). Where it differs from the code, this
  spec follows the code. Its evidence in the archive:
  [Phase 3 journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-88-phase-3-journey.md).
  The change to paid use: [Plan 95](../../../plan-95-pantry-own-accounts.md) step 3.
  The boundary: [Plan 87](../../../history/plan-87-screen-context.md) section 3A.
- E2E journeys in `services/platform/tests/e2e/`: `plan-88-jev-features.test.ts` (J1,
  J2, J3, J4, J6 and J7) and `plan-88-jev-agent.test.ts` (J5). Neighbour journeys:
  `chat-screen-relevance.test.ts`, `mail-inbox.test.ts` and
  `organisation-case-context-collection-placement.test.ts`.
- The Portal preview `apps/portal/jev-features-preview.html` has the cases `pantry`,
  `own`, `missing`, `viewer`, `near`, `used`, `used-viewer`, `paid` and `unpriced`, and
  `?page=billing`.
