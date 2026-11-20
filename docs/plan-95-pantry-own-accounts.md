# Plan 95 — Pantry owns its accounts

Status: in progress, 21 November 2026. The owner decided the five decisions
on 20 November 2026 (see "Decisions"). Steps 1 to 4 are done (see their
"results" sections). Step 5 needs the owner for its gate. Step 6 is open.

- The owner decided on 20 November 2026: the Seams Wallet and its Console are
  one product, apart from Purin. Pantry and the Wallet stop sharing
  organisation accounts.
- [Refactor 260](https://github.com/purin-labs/monorepo/blob/dev/docs/refactor-260-console-split.md)
  in `purin-labs/monorepo` splits the Console into `seams-tech/seams-console`.
  This plan is its step 3. Its step 5 (remove the Pantry service from the
  Console) waits for this plan.

Owner: the Platform accounts, the Portal setup and Pantry billing.
Touches: [Plan 88 — Jev](plan-88-satyr-funded-jev.md) (paid use),
[Plan 93 — clean cutover](plan-93-clean-cutover.md) (the new stack),
[onboarding architecture](architecture/onboarding.md),
[organisation setup flow](organisation-setup-flow.md), and the AGENTS.md
sections "Current request flow" and "Testing".

## Goal

Pantry owns organisations, members, invitations, request eligibility, plans
and billing. After this plan, no Pantry request calls the Seams Console.
The `ACCOUNT_PLATFORM` binding, the vendored Console contract and the CI
checkout of the monorepo go. Then the monorepo retires the old Console
Workers and their databases. This plan does not do that.

Rules, as in Plan 93:

- No data moves. The existing account records are test data.
- No second mechanism. Pantry's own tables already hold most of the state.
  The plan removes the Console layer over them.
- No code that accepts a Console value after the change.

## Why

1. A Cloudflare service binding cannot cross accounts. Refactor 200 moves
   the Console to the `seamsadmin` account and Pantry to the Purin account.
   The public Console answers 404 for `/account-platform/*`, so no HTTPS
   path exists either.
2. The Console is a second authority over records that Pantry already
   keeps. Each protected request asks it. The measurement of 28 October 2026
   counted 7 Console calls before the first model request of a new thread.

## Facts (origin/dev `e3c8d0a`, 20 November 2026)

Each fact was read from the code. Pantry paths are in this repository.
Console paths are in `purin-labs/monorepo`, read and not changed.

### The connection

- The binding: `services/platform/wrangler.jsonc` lines 122–126 (local,
  Worker `seams-sdk-d1-local`) and lines 354–358 (production, Worker
  `seams-sdk-d1-console`), entry point `SatyrAccountPlatform`.
- Pantry has no staging binding. Plan 93 step 1 deleted Pantry staging on
  19 November 2026, so Pantry does not use `seams-sdk-d1-console-staging`.
- The entry point has only a `fetch()` handler that routes by path
  (`packages/wallet-console-server-ts/src/router/cloudflare/satyrAccountPlatform.ts`
  line 28). It is not an RPC interface.
- Ten values: `services/platform/src/env.ts` lines 33–43, the local vars
  (`wrangler.jsonc` lines 100–106), the production vars (lines 339–345) and
  three production secrets (lines 381–383): `ACCOUNT_PLATFORM_DEPLOYMENT_ID`,
  `ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID`,
  `ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U`,
  `ACCOUNT_PLATFORM_ASSERTION_ISSUER`, `ACCOUNT_PLATFORM_ASSERTION_AUDIENCE`,
  `ACCOUNT_PLATFORM_PROVISION_TOKEN`, `ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK`,
  `ACCOUNT_PLATFORM_PROVISION_ASSERTION_KEY_ID`,
  `ACCOUNT_PLATFORM_PROVISION_ASSERTION_ISSUER` and
  `ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE`.
- The contract: `@seams-internal/console-shared` 0.1.3, vendored as
  `vendor/seams/seams-internal-console-shared-0.1.3-ebed186cf39a.tgz`. Two
  package files pin it (`services/platform/package.json`,
  `packages/control-api/package.json`). Eight source files, one test type
  fixture and one rename script name it.
- CI: `.github/workflows/pantry.yml` lines 61–75 check out
  `purin-labs/monorepo` at `3a05ce4` and build the fixture account Worker.
  `PANTRY_ACCOUNT_WORKER_ARTIFACT` gives its path to the unit and E2E suites
  (`services/platform/vitest.e2e.config.ts` lines 322–370).

### Inventory of Pantry uses

`services/platform/src/account-platform/` (15 files, 4,557 lines) holds all
code that calls the Console. 64 source files outside it import it; two Jev
files use its client directly.

| Use                                                                      | Console route                                                                                                             | Pantry module and tables                                                                                                            | Callers                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eligibility of a person                                                  | `eligibility/current`                                                                                                     | `access.ts` (`createAccountPlatformAccess`), `client.ts` (`checkUser`)                                                              | `organisation-execution-scope.ts` makes the access object at lines 142, 194 and 269. 51 files call it (list below)                                                                          |
| Eligibility of an automation (workflow, agent mailbox, WhatsApp support) | `eligibility/current`                                                                                                     | `access.ts` (`checkAutomation`), `identity.ts`, `account_automation_link`                                                           | The same 51 files                                                                                                                                                                           |
| Access revision fence                                                    | Part of the eligibility answer                                                                                            | `access-revision.ts`, `account_service_access_revision`                                                                             | `access.ts`                                                                                                                                                                                 |
| Identity link at sign-in                                                 | `onboarding/identity`, `identity/link`, `identity/resolve`                                                                | `identity.ts`, `account_identity_link`                                                                                              | `control/routes/sessions.ts` lines 39–42 and 320–375                                                                                                                                        |
| Organisation creation                                                    | `onboarding/options`, `onboarding/start`. The Console then posts `/account-platform/v1/provision` and `/status` to Pantry | `onboarding.ts`, `provisioning.ts`, `provisioning-boundary.ts`, `routes.ts`, `account_service_binding`, `account_provision_receipt` | `control/routes/onboarding.ts` line 220, `integration-gateway.ts` line 200                                                                                                                  |
| Members and invitations                                                  | `memberships/list`, `memberships/invite`, `memberships/revoke`, `invitations/accept`, `invitations/revoke`                | `service-membership.ts`, `client.ts`, `account_service_invitation_role`                                                             | `control/routes/onboarding.ts` lines 583–823, `data/control-plane.ts` line 1550, `control-router.ts` line 391                                                                               |
| Automation grants                                                        | `automation-grants/set`                                                                                                   | `automation.ts`                                                                                                                     | `control/routes/access-control-mutations.ts` line 434                                                                                                                                       |
| Fee policy                                                               | `fee-policy`                                                                                                              | `binding.ts` (`resolvePantryAccountBinding`)                                                                                        | `actors/organisation/organisation-policy.ts` line 321, `control/routes/sessions.ts` line 335, `jev-features/paid-use.ts` line 262, `jev-features/usage-records.ts` line 183                 |
| Turn billing                                                             | `funds/reserve`, `funds/indeterminate`, `funds/settle`, `funds/release`, `funds/reconcile`, `funds/status`, `usage`       | `execution-billing.ts` (1,207 lines)                                                                                                | `actors/agent-session.ts`, `actors/actor-journal/transactions.ts`, and `session-checkpoints.ts`, `session-harness-turns.ts`, `session-turn-recovery.ts` and `types.ts` in `actors/session/` |
| Jev paid use                                                             | `funds/reserve` (a 5-cent hold for each feature-hour), `usage` (the hourly record on the meter `satyr.jev_input_tokens`)  | `jev-features/paid-use.ts`, `jev-features/usage-records.ts`                                                                         | The Organisation Actor                                                                                                                                                                      |
| Instance release                                                         | `satyr/instance-release`                                                                                                  | `instance-release.ts`                                                                                                               | The cron pass in `integration-gateway.ts` line 183                                                                                                                                          |

The 51 files that call eligibility through the `AccountPlatformAccess` port
(paths under `services/platform/src/`):

- `access-control/integration-discovery.ts`, `authorization/access-grants/turn-authority.ts`,
  `case-execution/access.ts`, `case-execution/timeline.ts`, `context/turn-context.ts`,
  `custom-connectors/execution.ts`, `data/control-plane.ts`, `evals/access.ts`,
  `memory/access.ts`, `organisation-execution-scope.ts`, `projects/context.ts`,
  `request-authority/index.ts`.
- `actors/`: `case-direct-processing.ts`, `email-case-processing.ts`,
  `eval-task-processing.ts`, `harness-commerce-proposal.ts`, `harness-follow-up.ts`,
  `harness-memory-proposal.ts`, `harness-side-case-proposal.ts`,
  `socket-session-access.ts`, `whatsapp-case-processing.ts`, and in `session/`:
  `capability-claims.ts`, `harness-source.ts`, `session-checkpoints.ts`,
  `session-harness-turns.ts`, `session-proposal-staging.ts`.
- `agent-tools/`: `bakery/handlers.ts`, `channels/handlers.ts`,
  `costs/view-handler.ts`, `devices/handlers.ts`, `drafts/handlers.ts`,
  `integrations/handlers.ts`, `session-support.ts`.
- `chat/`: `conversation-disclosure.ts`, `forks.ts`, `information-flow.ts`,
  `side-cases.ts`, `turn-access.ts`.
- `commerce/`: `case-commerce-delivery.ts`, `entity-plane/execution.ts`,
  `provider-execution.ts`.
- `control/routes/`: `agents/email-reply.ts`, `brain.ts`, `case-execution.ts`,
  `custom-connectors/write-actions.ts`, `evals.ts`, `held-output-requests.ts`,
  `memories.ts`.
- `slack/`: `case-processing.ts`, `ingress-admission.ts`,
  `supplier-payout-reply.ts`.

Portal and contracts:

- `apps/portal/src/pages/account-onboarding.tsx` (1,764 lines): the five-step
  setup dialog over Console organisations and projects.
- `apps/portal/src/pages/account-invitation.tsx`: the page of an invitation
  link.
- `apps/portal/src/features/integrations/settings-transport.ts` line 826: the
  invitation request. The link carries the Console token.
- `apps/portal/src/features/billing/route.tsx` and
  `features/jev-features/paid-use.tsx`: Settings › Billing and the Jev paid-use
  section. "Payment method, credit and invoices" is text with no link.
- `packages/control-api/src/account-onboarding.ts` and
  `packages/control-api/src/portal/errors.ts`.

Scripts and tests:

- Scripts that bind `ACCOUNT_PLATFORM`: `scripts/init-local-commerce-env.mjs`
  (`pnpm local:init`), `scripts/worker-environment.mjs` and its test,
  `scripts/lib/fixture-worker.mjs`, `scripts/plan-42J/`, `scripts/plan-50/`,
  `scripts/plan-74/`, `scripts/plan-81/`,
  `scripts/production-simulation/archive-wrangler.jsonc`,
  `scripts/shop-gateway/wrangler.jsonc` and `scripts/shop-voice/wrangler.jsonc`.
- 64 test files use `tests/e2e/shared-account-platform-fixture.ts`
  (1,547 lines) or `tests/real-account-platform-fixture.ts` (335 lines). Most
  call `attachSharedAccountNativeOrganisation`.

### What the Console decides today

- **Eligibility** (`packages/console-server-ts/src/accountPlatform/serviceAccess.ts`
  lines 634–739) is one SQL query:
  - The Console organisation and project are active, the Pantry instance is
    active and enabled, and a `satyr_service_bindings` row exists.
  - A person has a verified Google identity, an active membership and
    instance access `allowed`. The role is OWNER or ADMIN, or the project
    access is `editor`. A project `viewer` passes only `disclose` and
    `replay`.
  - An automation has an allowed row in `platform_automation_grants`.
  - It checks no plan, credit or payment.
- **Roles.** Pantry maps its roles to Console roles when it invites
  (`control/routes/onboarding.ts` lines 698–712): `viewer` gets project
  access `viewer`; `admin` and `operator` get `editor`. So a Pantry viewer
  cannot send an `execute` request today. The native rule keeps this.
- **Creation.** The Console sends only the owner: no members, roles or plan.
  Pantry's own `bootstrapOrganisation` makes the organisation
  (`account-platform/provisioning.ts` lines 204–389).
- **Change of membership.** Pantry pulls. The Console pushes no event.
- **Billing.** Production turns have the fee policy `customer_unpriced`: no
  charge and no reservation. Only accounts in `billing_isolated_test_accounts`
  pay 1 cent for each turn. Jev costs 84 cents for each 10 million input
  tokens above 23,809,523 free tokens in each UTC month. The postpaid route
  `POST /console/billing/satyr-paid-use/postpaid` has no caller in the
  Console frontend, and the Portal has no link to the Console. So no Pantry
  organisation can pay today.

### Corrections to Refactor 260

1. Pantry has an invitation table, `account_service_invitation_role`
   (regional baseline line 4471). It keeps only the Pantry role of a Console
   invitation. The Console keeps the invitation, its token and its expiry.
2. `organisation.plan` exists (`TEXT NOT NULL DEFAULT 'beta'`, global and
   regional baselines), with the type `OrganisationPlan = "beta"`
   (`actors/organisation/types.ts` line 52). Pantry has no plan catalog, no
   subscription and no billing account.
3. Pantry needs only `seams-sdk-d1-console`. It stopped its use of
   `seams-sdk-d1-console-staging` on 19 November 2026.
4. 64 files import the account module, and 51 of them only for eligibility.

## Target design

One authority for each record. The plan adds only what Pantry lacks: an
invitation record, a plan catalog and a billing account.

### Ownership

This table replaces the first rows of "Authority and ownership" in
[the onboarding architecture](architecture/onboarding.md).

| State                          | Owner                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Identity and session           | Google OIDC, `app_user`, `control_session` (no change)                                                       |
| Organisation creation          | `POST /v1/control/organisations`, which calls `bootstrapOrganisation`                                        |
| Membership and role            | `service_role_grant`                                                                                         |
| Invitations                    | `organisation_invitation` (new, regional)                                                                    |
| Request eligibility            | `OrganisationAccess` (native reads)                                                                          |
| Automation authority           | The native rows: `cue_subscription`, `schedule_binding`, `agent_mailbox_binding`, `whatsapp_support_binding` |
| Plan                           | `organisation.plan` and the plan catalog in code                                                             |
| Billing account and payment    | `organisation_billing_account` (new, regional) and Stripe                                                    |
| Jev use and paid-use admission | The Organisation Actor (`jev_usage_hour`, `jev_paid_use`, `jev_paid_hold`)                                   |

### Organisation creation

- `POST /v1/control/organisations` with `{ operationId, name }`. A signed-in
  person with a verified Google email becomes the owner. The route calls
  `bootstrapOrganisation`, the same call that provisioning makes today.
- The Portal keeps the `operationId` in session storage, as today. The route
  uses it as the idempotency key, so a retry returns the same organisation.
- Placement: the cell of `PANTRY_ORGANISATION_PLACEMENT_PROFILE`. If the
  profile has more than one cell, the person selects one. Production has one
  cell, `production-apac`.
- A person can own at most 5 active organisations. A sixth request answers
  `organisation_limit_reached`. The number is one constant.
- A new organisation has the plan `beta`.
- The Portal setup dialog has three steps: Organisation (the name), Prepare
  and Done. The Project and Billing steps go, because they were Console
  records.

### Members and invitations

- `organisation_invitation` (regional): `organisation_id`, `invitation_id`,
  `email` (lower case), `role` (`admin`, `operator` or `viewer`),
  `token_hash` (SHA-256 of a random 32-byte token), `invited_by_user_id`,
  `created_at`, `expires_at` (7 days later), `state` (`pending`, `accepted`
  or `revoked`), `accepted_user_id`, `accepted_at` and `revoked_at`. One
  pending invitation for each email in an organisation. It replaces
  `account_service_invitation_role`.
- The routes keep their paths: `GET` and `POST` on
  `/v1/control/organisations/:id/invitations`, accept and revoke. An admin or
  the owner invites, as today. `POST` returns the link, and the Portal shows
  it to copy, as today. Pantry sends no e-mail and has no mail provider
  (decision 5).
- To accept, the signed-in person must have a verified Google email equal to
  the invitation email. The token must match, and the invitation must be
  pending and not expired. One regional batch writes the `person`, the
  `service_role_grant` and the new state. A second accept answers the same
  membership.
- Removal uses `revokeOrganisationMembership` (`data/control-plane.ts`). It
  returns private chats to the default project and removes project
  memberships in the same batch. Step 1 removed the Console receipt.
- The final-owner trigger stays.

### Request eligibility

- Keep the port `AccountPlatformAccess` with its three methods, and rename
  it `OrganisationAccess` (`organisation-access/access.ts`). The 51 callers
  keep their calls. Only import paths and type names change.
- The new implementation only reads: one regional D1 statement, and one
  global read for a session.
  - The organisation: the placement fence is current. If not:
    `authority_unavailable`. `organisation.status` is `active` or `deleted`
    (archived), and the lifecycle is not `purging` or `purged`. If not:
    `instance_ineligible`. An archive writes the lifecycle, so an
    organisation with no lifecycle row was never archived and is eligible.
    An archived organisation stays
    eligible until its purge, as the Console instance did, so that its owner
    can read it and restore it. The lifecycle checks of the routes and
    Actors refuse its other work, as today.
  - A person: an active `service_role_grant`. For `authenticated_session`,
    the live `control_session` of that person (`nativeSession`, no change).
    `disclosure_recipient` admits only `disclose`, and
    `authenticated_provider_event` admits only `execute` (the rules of
    `client.ts` lines 380–394). A `viewer` admits only `disclose` and
    `replay`. If not: `membership_ineligible`. The role checks of most routes
    and of Slack ingress refuse a viewer first. A POST that only reads asks
    for `disclose`: `authorizeOrganisationRequest` takes the action as its
    sixth argument.
  - An automation: its native row is active at the requested revision: an
    enabled `cue_subscription` or `schedule_binding`, or the current
    revision of an agent mailbox or WhatsApp support binding with an active
    integration account. If not: `membership_ineligible`. Pantry's own
    access grants (`authorization/access-grants/`) keep their checks.
  - A D1 fault answers `authority_unavailable`. Access fails closed, as
    today.
- The answer carries no `authorityRevision`. No caller outside the module
  reads it.
- The access revision fence goes. Pantry changes a membership only in its
  own transaction, so no outside change can arrive.
- The types `ServiceAdmissionActionV1` and `PlatformUserAuthorityV1` move from
  the vendored Console package into `@purin-labs/contracts`, as TypeBox
  schemas ([Plan 78](plan-78-contracts-in-typescript.md)).
- The module is in the layer `foundation/tenancy` (`scripts/layers.json`).

### Plans

- A plan catalog in code, in `foundation/tenancy`. `beta` has the free Jev
  use of Plan 88 ($1.00 of TypeSafe cost in each UTC month), a default
  spending limit of $5 and a highest spending limit of $10.
- `organisation.plan` stays the record. A new plan needs a catalog entry and
  a D1 patch, not a table.
- This plan adds no paid base plan. A base price is one more Stripe price
  later.

### Billing

- One Purin Stripe account bills Pantry organisations (decision 3). Step 6
  builds and tests in Stripe test mode. Paid use stays off in production
  until the live account exists. Pantry keeps no card data: Stripe Checkout
  and the Stripe Customer Portal show each card form.
- Postpaid metered use is the only payment model (decision 2). There are no
  prepaid credit packs and no balance ledger.
- `organisation_billing_account` (regional): `organisation_id`,
  `stripe_customer_id`, `stripe_subscription_id`, `payment_state` (`none`,
  `active`, `past_due` or `canceled`), `last_stripe_event_created` and
  `updated_at`. Pantry makes the row and the Stripe customer only when the
  owner starts payment setup. An organisation with no paid use has no row and
  no Stripe object.
- Payment setup: Stripe Checkout in subscription mode, with one metered price
  on a Stripe meter for Jev input tokens. The owner then returns to
  Settings › Billing.
- Use: the hourly Jev record (`jev-features/usage-records.ts`) exists. For a
  paid hour, it sends one Stripe meter event with the tokens above the free
  use. The identifier is the record's event id, so a retry charges nothing.
  Stripe prices the month and collects the invoice.
- Admission stays in the Organisation Actor: paid use is on, the
  `payment_state` is `active`, and the month's charge plus the 5-cent hold is
  inside the spending limit. The hold becomes a local row in
  `jev_paid_hold`, with no outside call.
- Webhook: `POST /webhooks/stripe-billing`, with its own signing secret, for
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.paid` and
  `invoice.payment_failed`. Pantry compares the event with the row and
  writes only on a change. `past_due` stops new paid use. Free use continues.
- Settings › Billing shows the plan, the payment state, the free and paid use
  of the month, the spending limit, "Set up payment" (Checkout) and "Manage
  payment" (the Customer Portal, for the card and the invoices). This closes
  the gap that Plan 88 phase 4 recorded.
- Turns stay unpriced, as in production today. Step 3 deletes the turn
  billing record (decision 4). A later turn price uses the path of step 6.
- Credit risk: at most the spending limit, and never more than $10, for each
  organisation in each month.
- Capabilities: `billing.account.manage` (owner) for payment setup and the
  limit, and `billing.account.read` (owner and admin), in the form of
  `jev.features.manage`. Add both to
  `authorization/capability-catalogue.ts`, and run
  `node scripts/capability-policy-backfill-sql.mjs`.

### Agent access

- The chat agent gets one read tool for the plan, the payment state, the use
  and the spending limit: one `defineTool` value in an agent tool family and
  one line in its `registry.ts`.
- The agent does not create an organisation, invite, accept, remove a member,
  start payment setup or change the limit. Each of these changes who can act
  or what the organisation pays, so the person does it (Plan 88 D11).

### Cost for an idle organisation

- Eligibility only reads. The upsert of the access revision goes.
- The instance release pass of the cron goes.
- Stripe adds no cron and no poll, only webhooks, and only for organisations
  with paid use.
- The plan adds no alarm. The hourly Jev record runs only after Jev use.
- So an idle organisation gets no new row, queue message, KV write or R2
  write in 30 days. `tests/e2e/idle-tenant-cost.test.ts` must pass with its
  current budget.

## Steps

Each step lands on `dev` alone, with its checks. Steps 1 to 4 go to
production in one release (step 5). Step 6 does not block the Console split.

Step 3 landed before step 2. Each turn read the Console binding for its
billing, so nearly every turn journey needed the Console attach of the test
fixture until the billing went. After step 3, the attach serves only the
sign-in link and the invitations, which step 2 replaces. The order has no
effect on production, because steps 1 to 4 ship in one release.

### 0. Decisions (no code)

Done on 20 November 2026. The owner took all five recommendations (see
"Decisions").

### 1. Native request eligibility

- Build `OrganisationAccess` as in the design. Delete the Console calls in
  `access.ts`, `access-revision.ts`, `identity.ts` (the automation part) and
  `client.ts` (`checkUser`, `checkAutomation`).
- Delete `ensurePantryAccountAutomationGrant` (`automation.ts`) and its call
  in `control/routes/access-control-mutations.ts` line 434.
- Move the admission types into `@purin-labs/contracts`.
- In this step, the E2E fixture still attaches through the fixture account
  Worker. The attach also writes the native grants, so the suite runs.
- Journeys:
  - J1 viewer: a viewer reads a chat and is refused a new turn. An operator
    sends the same turn, and it runs.
  - J2 archive: after an archive, a Portal read of the owner, a Slack turn
    and a mailbox agent turn are each refused. After the restore, all three
    work.
  - J3 removal: an admin removes an operator during an open chat. The next
    message answers `membership_ineligible`, and the private chats of that
    person are in the default project.
- Checks: `check:types`, the Platform E2E suite, `pnpm lint:layers`.

#### Step 1 results

Done on 20 November 2026. What changed, and where the work differs from the
list above:

- `OrganisationAccess` (`services/platform/src/organisation-access/access.ts`)
  reads Pantry's own records. The module moved in this step, so step 4 only
  deletes. `access.ts`, `access-revision.ts` and `automation.ts` of
  `account-platform/` are deleted, with the Console calls `checkUser`,
  `checkAutomation` and `setAutomationGrant` of `client.ts`.
- The types are `OrganisationAdmissionAction` and `OrganisationUserAuthority`
  in `@purin-labs/contracts` (`organisation-access.ts`).
- An archived organisation stays eligible (see "Request eligibility"). The
  first rule refused it, and that rule blocked the owner's read and the
  restore route.
- The viewer rule stays. Seven routes admit the role `viewer` on a POST:
  the canvas chat, the sender links, board presence, a held-output
  decision, the Slack DM choice, the mail assistant and the mail inbox. The
  Console refused a viewer's POST on them when Pantry had invited that
  person as a viewer, so production behaviour does not change. The first
  two POSTs only read, and now ask for `disclose`.
- Test fixtures made states that only the Console could hold: a Pantry
  admin whom the Console refused (the `finance` slot) and a Console editor
  with the Pantry role `viewer`. The outsider of `memory-support.ts` is now
  a signed-in person with no role. `memory-access`, `eval-commands` and
  `mailbox-sender-supplier-link` expect `organisation_membership_missing`
  for that outsider.
- Removal is native in this step. The members route calls
  `revokeOrganisationMembership` and no longer asks the Console. The Console
  membership no longer gives access, so its removal is not needed. Steps 1 to
  4 go to production in one release, so no release has the Console
  membership without the native one.
- Invitation acceptance stays on the Console until step 2. It no longer
  writes `account_service_access_revision`. A membership change in the
  Console dashboard no longer reaches Pantry.
- The mailbox setup check reads the Pantry access grant only. The script
  fixtures of Plans 42J and 50 lost their Console automation grant.
- Deleted journeys, whose outcomes only the Console had:
  `shared-account-platform.test.ts` (Console eligibility outage, Console
  member removal, Console service disable and turn billing; step 3 deletes
  the billing), `shared-account-automation.test.ts` (Console automation
  grants) and `account-access-one-read.test.ts` (a count of Console
  requests). `account-session-isolation.test.ts` lost its Console
  eligibility faults; its sign-in and invitation checks stay for step 2.
- The fixture `shared-account-platform-fixture.ts` lost the helpers of those
  journeys (1,547 to 735 lines).
- Journeys:
  - J1 has no new journey. `bakery-agent-canvas.test.ts` already has it: a
    viewer opens and reads the chat of a canvas, and the viewer's message is
    refused. `slack-viewer-refusal.test.ts` refuses a viewer in Slack. No
    journey sends a viewer's POST to the five routes that act.
  - J2 is `organisation-archive-access.test.ts`: a mention during the archive
    starts no turn, and the owner reads the archived organisation and
    restores it through the routes. It has no mailbox turn.
  - J3 is `member-removal-access.test.ts`. The removed person is an admin,
    because the Portal chat needs the role `admin`. The next message and the
    next read answer 404 `organisation_membership_missing`: the membership
    read refuses before the access check. The private chat moves from the
    person's project to the default project, and the person keeps no
    project membership.

### 2. Organisation creation and invitations

- `POST /v1/control/organisations` and the three-step setup dialog.
- `organisation_invitation`, its routes, and the invitation page with the
  Pantry token. A D1 patch adds the table.
- Sign-in stops its Console calls (`control/routes/sessions.ts`
  lines 320–375).
- A native fixture, `attachNativeOrganisation`, with the shape of
  `attachSharedAccountNativeOrganisation` (owner, and members by slot). It
  makes the organisation through the new route and adds each member through
  invite and accept, so the seed goes through the production authorities.
  Port the test files; most change one import. Each test whose outcome is
  only a Console outcome gets a decision, not a repair
  (`account-session-isolation.test.ts`, `pantry-onboarding.test.ts`; step 1
  deleted three others).
- Update `organisation-setup-flow.md` and the sections "Account setup and
  Organisation creation" and "Team and invitation lifecycle" of
  `architecture/onboarding.md`.
- Journeys:
  - J4 setup: a signed-in person makes an organisation. A repeat with the
    same operation id makes no second organisation. A sixth organisation is
    refused. A person with no verified email is refused.
  - J5 invitation: the owner invites `a@` as operator. `b@` opens the link
    and is refused. `a@` accepts and runs a chat turn. A second accept
    changes nothing. An expired invitation and a revoked invitation are
    refused.
- Checks: the Platform E2E suite, `pnpm portal:build`, and a Playwright
  journey of the dialog and the invitation page, with a saved artifact.

#### Step 2 results

Done on 21 November 2026, after step 3 (see "Steps"). What changed, and
where the work differs from the list above:

- `POST /v1/control/organisations` makes the Organisation
  (`organisation-access/creation.ts`). The operation id is the idempotency
  key, so a repeat answers with the first Organisation, also after the person
  reached the limit of five. The Organisation goes to the root cell of the
  placement profile, which the placement module names the onboarding
  default; the plan said that the person selects a cell, but production has
  one cell and the Portal had no cell choice. An Organisation of the
  production deployment has the environment `production`. The request check
  is `readOrganisationCreationRequest` of `@purin-labs/control-api`, which the
  Portal and the route share.
- `organisation_invitation` (regional, patch script
  `plan-95-invitations-d1-patch.sql`) and `organisation-access/invitations.ts`
  replace the Console invitations. A wrong token answers as a missing
  invitation. A person who is already a member keeps their role when they
  accept. `account_service_invitation_role` has no reader or writer now;
  step 4 drops it.
- Sign-in makes no Console request. The OIDC result no longer carries the
  Google ID token, which only the Console link used.
- Deleted: `/v1/control/account-onboarding`, and `onboarding.ts`,
  `service-membership.ts`, `identity.ts` and `binding.ts` of
  `account-platform/`, and `data/service-invitation-role.ts`. What remains of
  `account-platform/` is the provisioning route, the instance release and
  their client and types; step 4 deletes them.
- Fixtures: the tests already gave each member a native role, and the
  Console attach added only Console state. So the port deletes the attach
  calls, and `tests/e2e/organisation-fixture.ts` replaces the shared Console
  fixture. Its `addOrganisationMember` goes through the invitation and accept
  routes, as the plan asks. The unit tests lost the real account Worker
  fixture, and the script fixtures of Plans 42J and 50 lost their attach.
- Decisions on the tests with Console outcomes: `pantry-onboarding.test.ts`
  (Console projects) and `account-session-isolation.test.ts` (Console
  sign-in links and invitation denials) are deleted. J4 and J5 cover the
  native outcomes.
- A member who accepts an invitation joins the Base Project, as in
  production. Three journeys relied on the old seed, which left members out
  of it: the two mail reply journeys added the administrator again by hand,
  and the production plan journey shared a private chat into a Base Project
  that now has a viewer who may not read the chat. The first two lost that
  step; the third shares the chat into a Project of the owner.
- Journeys: J4 is `organisation-setup.test.ts`. J5 is
  `organisation-invitation.test.ts`; the invited person is an admin, because
  the Portal chat needs the role `admin`, and the expired invitation is a
  seeded row of eight days ago.
- Portal: the setup dialog has four steps, Organisation (one name field),
  Prepare, Jev and Done; the plan named three, and the optional Jev step of
  Plan 88 stays. The Project and Billing steps and the polling are gone, and
  the file went from 1,764 to 1,029 lines. The invitation page has no "link
  failed" state, and each accept refusal has its own message.
  `packages/control-api/src/account-onboarding.ts` and the Console pin of
  `@purin-labs/control-api` are gone.
- Playwright: `scripts/frontend-foundation/portal-account-setup-journey.mjs`
  runs on the real Portal (`browser-journeys.mjs --account-setup`) and passed
  with 19 checks; its report and screenshots are in the git-ignored
  `output/playwright/account-setup/`.

### 3. Billing state off the Console

- Delete `execution-billing.ts` and the billing calls of its six callers.
  Turns stay unpriced (decision 4).
- Jev: free use and its hourly records stay local. Paid use reports
  `priced: false` until step 6, so "Turn on paid use" is disabled.
  `usage-records.ts` stops its send. The hour rows stay as the record of use.
- `organisation-policy.ts` line 321 reads `priced` from the plan catalog and
  the billing account, not from the Console.
- Checks: the Plan 88 journeys of free use pass. The journeys of Console paid
  use are deleted. Step 6 brings paid use back on Stripe.

#### Step 3 results

Done on 21 November 2026, before step 2 (see "Steps"). What changed, and
where the work differs from the list above:

- `execution-billing.ts` is deleted, with its calls in the Session: the
  admission read of the binding and the fee policy, the dispatch mark, the
  uncertainty mark, the three journal hooks and the four reconcile calls. A
  turn no longer reads the Console before its model request.
- The Session outbox schema has a version 3. It deletes the rows of the old
  turn billing (`account_execution:*`) once, when a Session wakes. A turn of a
  Console test account could leave such a row open, and an open row kept a
  Session from its end and from a relocation. The relocation check and the
  end of a quarantined Session no longer skip those rows.
- Jev paid use is closed: `JEV_PAID_USE_OPEN` is false in
  `jev-features/paid-use.ts`, and the view reports `priced: false`. There is
  no plan catalog and no billing account yet; step 6 adds both. The server
  refuses to turn paid use on (`jev_paid_use_closed`), and the Portal
  disables the switch. A call above the free use stops as at the end of the
  free use (`allowance_reached`). The feature-hour holds, the refusal codes
  `spending_limit_reached` and `paid_use_unfunded`, and the Console price
  versions are deleted. `priced` is now a boolean.
- A sealed Jev hour is `not_billed`, with the outcome `unpriced` or
  `no_measured_tokens`. A sealed hour no longer arms the Organisation alarm.
  An hour that waited for the Console meter becomes `not_billed` at the next
  seal.
- The Console client lost its funds and usage calls.
- Journeys: `plan-88-jev-features.test.ts` keeps J1, J2, J3 and J6 without
  the Console attach. J4 now checks the local hour records. The two J7
  journeys of Console paid use are one journey: above the free use a call
  stops, and neither an admin nor the owner can turn paid use on.

### 4. Remove the Console connection

- Delete the rest of `account-platform/`: `client.ts`, `config.ts`,
  `binding.ts`, `provisioning.ts`, `provisioning-boundary.ts`, `routes.ts`,
  `onboarding.ts`, `instance-release.ts`, `identity.ts`, `types.ts` and the
  Console parts of `service-membership.ts`. Delete the `/account-platform/v1/*` handling
  (`integration-gateway.ts` line 200), the release pass (line 183),
  `handlePantryOnboarding` and `/v1/control/account-onboarding`.
- Delete the binding from `services/platform/wrangler.jsonc` (local and
  production) and from the Wrangler files of the scripts. Delete the ten
  values from `env.ts`, the vars and the secret list, and the account lines
  of `pnpm local:init`.
- Delete `vendor/seams/`, the two pins, `packages/control-api/src/account-onboarding.ts`
  and the remaining `@seams-internal/console-shared` imports.
- D1 patch: drop `account_service_binding`, `account_provision_receipt`,
  `account_identity_link` and `account_automation_link` (global),
  `account_service_invitation_role` and `account_service_access_revision`
  (regional), and the `service_role_grant` columns `platform_membership_id`,
  `account_access_revision` and `account_acceptance_receipt_id`. Step 5
  applies it.
- CI: delete lines 61–75 of `.github/workflows/pantry.yml` and the artifact
  note of the step "Unit suites".
- Docs: AGENTS.md ("Current request flow": the Console sentence; "Checks":
  `PANTRY_ACCOUNT_WORKER_ARTIFACT`), the ownership table of
  `architecture/onboarding.md`, `architecture/security.md`, `README.md`, and
  Plan 93 (see "Effect on other plans").
- Checks: every check in AGENTS.md "Checks"; the idle tenant journey;
  `pnpm lint:unused`, `pnpm lint:layers` and `pnpm lint:d1-patch`; and
  `git grep -n -e ACCOUNT_PLATFORM -e console-shared -e SatyrAccountPlatform`
  finds nothing outside plans and evidence.

#### Step 4 results

Done on 21 November 2026. What changed, and where the work differs from the
list above:

- `services/platform/src/account-platform/` is deleted, with the
  `/account-platform/v1/*` route, its `run_worker_first` entry and the
  instance release pass of the cron.
- The binding, the ten values and the three secrets are gone from
  `wrangler.jsonc` (local and production) and `env.ts`. `vendor/seams/` and
  the last pin are gone, and the lockfile names no Console package.
- The D1 patch is two scripts, because the two databases differ:
  `plan-95-console-removal-global-d1-patch.sql` and
  `plan-95-console-removal-regional-d1-patch.sql`. The three old patch scripts
  that made the Console tables are deleted, so nobody can make them again.
- The E2E suite no longer loads the account Worker. The script harnesses of
  Plans 40B, 42J, 50, 74, 81 and 84, the production simulation, the shop
  gateway, the shop voice journeys and `pnpm local:init` no longer start it
  or write its values. CI no longer checks out `purin-labs/monorepo`.
- The grep of the check finds nothing outside plans and evidence, except the
  past rename codemods in `scripts/rename/`, whose maps name old packages as
  data.
- The Plan 50 trial `recovery_schema_upgrade` fails with
  `schema_version_retired:session_hot_schema:32:33`. It stages Session schema
  32, which Plan 92 retired, so the failure is older than this step.
- Idle cost: lower. The instance release pass no longer runs in the cron.

### 5. Release and production proof

- Deploy `satyr-edge` (the source account, as now) with steps 1 to 4, before
  the Plan 93 cutover (decision 1), by the
  [production deploy runbook](runbooks/platform-production-deploy.md).
- Gate before the D1 patch, on production:
  - The owner makes an organisation in the Portal.
  - The owner invites a second Google account, and it accepts.
  - One Portal chat turn and one Slack turn of the invited person pass.
  - One mailbox agent turn passes, if a mailbox is connected. If not, say
    so.
- Rollback until the patch: deploy the previous `satyr-edge` version. It
  binds the old Console Worker again, which still runs.
- After the gate, apply the D1 patch to `satyr-global-tokyo` and
  `satyr-organisation-apac`. Then tell the Refactor 260 session that Pantry no
  longer binds the Console.
- The test organisations keep their native grants, so their members keep
  access. Their pending Console invitations are lost; they are test data.

### 6. Stripe billing

- The plan catalog, `organisation_billing_account`, Checkout, the Customer
  Portal, meter events, the webhook, local admission, the Billing page, the
  two capabilities and the agent read tool, as in the design.
- The owner makes the Purin Stripe account (decision 3). Its test-mode keys
  are enough for this step.
- Secrets: `PANTRY_STRIPE_BILLING_SECRET_KEY` and
  `PANTRY_STRIPE_BILLING_WEBHOOK_SECRET`; the price id is a var. Save each
  secret in `.env.local.production`.
- Journeys:
  - J6 paid use, with a Stripe fake that only records and answers. The owner
    turns on paid use. Pantry sends a meter event only for tokens above the
    free use. At the spending limit, the next mail call answers
    `spending_limit_reached`. After `invoice.payment_failed`, paid use stops
    and free use continues. A replayed webhook writes nothing. An admin
    cannot open Checkout. The agent reads the state and has no tool to
    change it.
  - J7 live, before the release: in Stripe test mode, one Checkout with a
    test card, one meter event, and the upcoming invoice shows the charge.
- Production: paid use stays off (`priced: false`) until the live Purin
  Stripe account exists (decision 3). The switch to live keys is one
  secret change and one live J7 run.

## Order with Plan 93 and Refactor 200

- Plan 93 builds the new `pantry-*` stack. Refactor 200 puts Pantry in the
  Purin account, where no binding to the Console can work. So the new stack
  must start after step 4, with no `ACCOUNT_PLATFORM`.
- Step 5 goes to the current `satyr-edge`, before the Plan 93 cutover
  (decision 1). So the Console split and the retirement of the old Console
  Worker do not wait for the brand cutover.

## Console-side changes (for Refactor 260)

Pantry needs no Console change for steps 1 to 6. It adds no Console route,
contract or value.

After step 5:

1. Refactor 260 step 5 removes the Pantry service from the Console: the
   service id `satyr` (`packages/console-shared-ts/src/accountPlatform/scope.ts`
   line 12), `satyr_service_bindings`, the meters `satyr.completed_turn.test`
   and `satyr.jev_input_tokens` with their price rows (migrations 0020 and
   0021), the Pantry rows of `billing_isolated_test_accounts`,
   `POST /console/billing/satyr-paid-use/postpaid`, `satyrProvisioning*`,
   `satyrRelease`, the `SatyrAccountPlatform` entry point, the 14 `PANTRY_*`
   and `ACCOUNT_PROVISION_*` values (`scripts/deployment-targets.mjs`
   lines 74–90), the dashboard labels and the Pantry tests.
2. Refactor 200 Phase 7 retires `seams-sdk-d1-console` and its database in
   the old account. The Console records of the Pantry test organisations go
   with them.
3. The Console's provisioning retry (`resumeSatyrProvisioning`, every
   60 seconds) gets 404 from Pantry after step 4, and an open Pantry
   provision then fails. This is harmless. Item 1 removes it.

Now, before step 5:

4. Pantry does not need `seams-sdk-d1-console-staging` (fact 3 of
   "Corrections"). Refactor 260 order step 2 can drop it from the list that
   waits for Pantry.

## Risks

| Risk                                                                      | Control                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A viewer gets `execute`, because the Console role rule was the only guard | J1. The rule is in one function                                                                   |
| The fixture port changes what a journey proves                            | The helper keeps its shape. A test with only a Console outcome gets a decision                    |
| A fault after the D1 patch has no way back                                | The patch runs only after the gate. Before it, the old Worker version still binds the old Console |
| A Stripe meter event is lost                                              | The hourly record keeps its state, and a retry uses the same identifier                           |
| One person makes many organisations                                       | The limit of 5 for each person                                                                    |
| Another session changes `account-platform/` during the work               | Announce step 1 to the open sessions. One step at a time on `dev`                                 |

## Decisions

All five are decided. On 20 November 2026, the session "Seams console
repository separation" asked the owner "Take the five Plan 95
recommendations?". The owner answered "Take all five".

1. **Release order. Decided:** ship steps 1 to 5 to the current
   `satyr-edge`, before the Plan 93 cutover. Cost: one more production
   release, about half a day with the gate.
2. **Billing model. Decided:** postpaid metered use on Stripe only. This
   drops the prepaid credit packs of Plan 88 D13. A shop with no card cannot
   pay first, and the credit risk is at most $10 for each organisation in
   each month.
3. **Stripe account. Decided:** one Purin Stripe account for Pantry billing.
   Build and test in test mode now. Paid use stays off in production until
   the live account exists. The owner makes the account and gives its
   business details.
4. **Turn price. Decided:** delete the turn billing record. Turns stay
   unpriced, as in production today. A later turn price uses the path of
   step 6.
5. **Invitation e-mail. Decided:** keep the link that the inviter copies, as
   today, with no mail provider. Mail through Resend from `info@purin.io`
   stays possible later, as a separate change.

## Cost

- Step 1: 1 day. Step 2: 2 to 3 days (the route, the dialog, invitations and
  the port of 64 test files). Step 3: half a day. Step 4: 1 day. Step 5: half
  a day, and 15 minutes of the owner's time for the gate. Step 6: 2 to 3 days.
- Recurring: lower than today. No Console calls, no release pass, and Stripe
  fees only for organisations that pay.

## Effect on other plans

- **Plan 88.** D12 (the Console grants a $10 credit limit at payment setup)
  becomes the highest spending limit of the plan catalog. D13 (prepaid or
  postpaid) becomes postpaid only (decision 2), so the prepaid credit packs
  go. "Billing today" becomes history. Step 6 updates the plan.
- **Plan 93.** The new stack has no `ACCOUNT_PLATFORM`. The step 3 check "a
  sign-up makes a new organisation through the Console" becomes "through
  Pantry". The `ACCOUNT_PLATFORM_*` values leave "Who uses the old
  addresses". "The Console records of the old organisations" in step 5
  becomes Refactor 260 work. Step 4 of this plan makes these edits.
- **Refactor 17.** Each new table needs a line in the `tables` map of
  `scripts/layers.json`. The dropped tables leave it.
- **Plan 81.** The agent gets the billing read tool. The list of refused
  account actions is in "Agent access".
