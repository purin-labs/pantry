# Onboarding architecture

This document describes how an Organisation comes into existence in Pantry,
how its members configure it, and how it becomes active. It also covers the
evidence, diagnostics and reconciliation that keep onboarding state correct.
Provider authorization, credentials and webhooks are in
[Integration architecture: provider connections (was Spec 12)](./integrations.md#provider-connections).

| Replaces                                          | Section                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Spec 11 — Merchant Onboarding Control Plane       | [Onboarding control plane](#onboarding-control-plane)                               |
| Spec 13 — Onboarding Operations and Observability | [Onboarding operations and observability](#onboarding-operations-and-observability) |

Procedures are in the runbooks:
[onboarding operations](../runbooks/onboarding-operations.md),
[provider callback origins](../runbooks/provider-callback-origins.md),
[environment configuration](../runbooks/environment-configuration.md),
[harness erasure](../runbooks/harness-erasure.md) and
[integration OAuth configuration](../deployment/organisation-integration-oauth-configuration.md).

## Onboarding control plane

### Authority and ownership

The Portal is a client of canonical records. It does not infer lifecycle state
from button history, URL parameters, diagnostics or provider responses.
Diagnostics describe state. They never change it.

| State                             | Owner                                                                 |
| --------------------------------- | --------------------------------------------------------------------- |
| Portal identity and session       | Google OIDC sign-in, `app_user`, `control_session`                    |
| Organisation creation             | `POST /v1/control/organisations`, which calls `bootstrapOrganisation` |
| Invitations                       | `organisation_invitation` in the Organisation's regional D1           |
| Request eligibility               | `OrganisationAccess` (native reads, Plan 95)                          |
| Organisation lifecycle            | `organisation_onboarding` in the Organisation's regional D1           |
| Pantry service role of a member    | `service_role_grant`                                                  |
| Placement (home region and D1)    | `organisation_placement`, resolved by `OrganisationExecutionScope`    |
| Selected commerce system          | `organisation_commerce_system` (`builtin_commerce` or `shopify`)        |
| Provider accounts and credentials | `integration_account`, `provider_connection`, Vault (Spec 12)         |
| Operating policy and cue preset   | Immutable rows in `organisation_setup_snapshot`                       |
| Readiness                         | `organisation_readiness_assessment`                                   |
| Activation                        | `OrganisationActor`, `organisation_activation_attempt` and its steps  |

### Account setup and Organisation creation

Pantry owns Organisation creation ([Plan 95](../plan-95-pantry-own-accounts.md)).
No outside account takes part.

1. Google sign-in makes the `app_user` and the `control_session`. Sign-in
   makes no other request.
2. `POST /v1/control/organisations` with `{ operationId, name }` makes the
   Organisation. The person must sign in with a verified Google email, and
   becomes the owner. `createOwnedOrganisation` in
   [`creation.ts`](../../foundation/tenancy/organisation-access/creation.ts)
   places it in the root cell of `PANTRY_ORGANISATION_PLACEMENT_PROFILE`, or
   in the cell that the request names, and calls `bootstrapOrganisation`.
3. A person owns at most five active Organisations
   (`organisation_limit_reached`).

The Portal page
[`account-onboarding.tsx`](../../apps/portal/src/pages/account-onboarding.tsx)
keeps one request per user in session storage. A retry reuses its
`operationId`, which is the idempotency key of the route, so a lost response
cannot create a second Organisation. A repeat answers with the first
Organisation, also when the person has reached the limit since.

`bootstrapOrganisation` reserves the Organisation in the directory D1. Then
one regional D1 batch writes the `organisation` row, its default workspace,
its placement, the owner `person` and `owner` grant, and the default Project.
The same batch writes `organisation_onboarding` (`configuring`,
`read_and_propose`, configuration version 1), the access defaults, one audit
row and the `organisation_created` event. A failed batch creates no
Organisation.

### Organisation lifecycle

`organisation_onboarding.lifecycle` is `configuring`, `activating`, `active`
or `archived`
([`OrganisationOnboardingLifecycle`](../../packages/contracts/src/types/OrganisationOnboardingLifecycle.ts)).
A table CHECK enforces the fields of each value. There is no draft or
suspended lifecycle.

| Transition                          | Trigger                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| none → `configuring`                | `bootstrapOrganisation`                                     |
| `active` → `configuring`            | A setup save. The Organisation must activate again.         |
| `configuring` → `activating`        | `POST …/activate` starts an attempt                         |
| `activating` → `active`             | All activation steps complete                               |
| `activating` → `configuring`        | An activation step fails                                    |
| `configuring`/`active` → `archived` | `POST …/archive` (admin), or the automatic archive          |
| `archived` → `configuring`          | `POST …/restore` (admin) before `purge_after` and the purge |

Archive sets `purge_after` to 30 days later and `organisation.status` to
`deleted`. It disables every account, connection and webhook, writes
`organisation_archive_cleanup` and `organisation_archive_tombstone`, and holds
policy distribution in `POLICY_KV`. The tombstone records the authority. A
`support_admin` archive needs an active Organisation with no members, no
Commerce binding and no active default Shopify account.

Restore returns the Organisation to `configuring` with a new configuration
version. After the purge starts, restore returns `organisation_purge_started`.
`DELETE /v1/control/organisations/:id` (owner) applies only to an archived
Organisation. It sets `purge_after` to now and deletes every
`service_role_grant` and `project_member` row.

Reconciliation archives an Organisation with reason `automatic_inactivity`
when it is `configuring`, unchanged for 30 days, has no `provider_connection`,
and has no connection attempt in the last 30 days.

### Environment isolation

Each Organisation has one environment: `development` or `production`. The
creation route sets `production` in the production deployment and
`development` elsewhere, and no route changes it. Every provider,
readiness and activation row carries the environment.

- Shopify, Stripe and Square connections fail with
  `provider_environment_mismatch` when the provider mode differs.
- Readiness reports `environment_conflict` for a row in another environment.
- Activation refuses an assessment from another environment.

### Portal session and mutation safety

Pantry owns the control identity, membership, person link and roles. Google
OIDC proves identity but grants no Organisation authority. The session cookie
`pantry_session` lasts seven days. An Organisation route checks the session, reads the membership
under the regional placement fence, then checks the role rank and the Account
Platform access
([`control/authorization.ts`](../../foundation/control/worker/authorization.ts)).
A missing membership or a low role returns `404`, so a person cannot probe
other Organisations.

Every mutation needs an `Origin` equal to `PANTRY_PUBLIC_ORIGIN` and an
`x-pantry-csrf` header that matches the `pantry_csrf` cookie. Rename,
delete, member changes, setup, activate, archive and restore also need an
`idempotency-key` (8 to 128 characters) and the expected
`x-pantry-configuration-version`.

`control_mutation_receipt` keeps the request hash and the response for at
least 24 hours, keyed by user, Organisation, route, operation and key
([`control-mutation.ts`](../../foundation/tenancy/data/control-mutation.ts)).
The same key and body return the stored response. The same key with another
body returns `409 idempotency_key_conflict`. A stale version returns
`409 configuration_version_conflict` and changes nothing.

A provider-write approval needs a ten-minute step-up bound to the exact
action (`/auth/google/start?purpose=approval`). The policy binding is
`unversioned_default`. Readiness reports other selected branches in
`approval_authentication`, but they never block activation. See
[Security architecture: identity and approval (was Spec 8)](./security.md#identity-approval-and-authorization). OAuth callbacks use provider state
instead of CSRF tokens (Spec 12).

### HTTP contract

All routes are under `/v1/control`, mostly in
[`control/routes/onboarding.ts`](../../services/platform/src/control/routes/onboarding.ts).
Provider routes, the commerce system choice and Projects are in other areas.

| Route family                                                | Methods and minimum role                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------ |
| `/auth/google/start`, `/auth/google/callback`               | Sign-in and approval step-up                                 |
| `/session`, `/session/rotate`, `/logout`                    | Read, rotate or revoke the session                           |
| `/home-regions`, `/setup/catalog`                           | `GET` placement cells; `GET` templates and presets           |
| `/organisations`                                            | `GET` the memberships of the person; `POST` create one       |
| `/organisations/:id`                                        | `GET` projection (viewer), `PATCH`/`DELETE` (owner)          |
| `…/members`, `…/members/:userId`                            | `GET` (viewer); `PATCH` role, `DELETE` (admin)               |
| `…/invitations`, `…/invitations/:id/revoke`, `…/:id/accept` | `GET` (viewer); invite, revoke (admin); accept (any session) |
| `…/setup`                                                   | `PUT` one setup snapshot pair (admin)                        |
| `…/onboarding/stage-viewed`                                 | `POST` a presentation event (viewer)                         |
| `…/readiness`                                               | `GET` the current assessment (viewer)                        |
| `…/activate`, `…/archive`, `…/restore`                      | `POST` (admin)                                               |
| `…/support/:reference`                                      | `GET` merchant diagnostics (viewer)                          |
| `/operator/…`                                               | Support tools; see [Operator view](#operator-view)           |

### Onboarding projection

`GET /v1/control/organisations/:id` returns one
[`OnboardingProjectionV1`](../../packages/contracts/src/types/OnboardingProjectionV1.ts),
built in
[`onboarding-projection.ts`](../../services/platform/src/data/onboarding-projection.ts).
The browser does not join control-plane state. The projection holds the
revisions, Organisation, membership, steps, provider accounts, operating
profile, readiness, activation, `next_action`, `first_task` and
`support_reference`.

Steps, in order: `workspace`, `inference`, `commerce`, `conversations`,
`operating_profile`, `review_activation`. Each is `unavailable`, `available`,
`in_progress`, `action_required` or `complete` (with a receipt ID).

`next_action` is `perform`, `repair` (with a reason code), `wait` (with
`retry_after_ms`) or `done`. The server selects the presentation, `same_page`
or `popup`. Only `connect_slack` uses `popup`. An archived Organisation gets
`restore_organisation`.

The ETag is `"organisation:<id>:revision:<projection_revision>"`, and a match
returns `304`. During activation the Portal polls with `If-None-Match`. The
delay starts at 500 ms and grows by 1.5 times to 3 seconds. Polls stop when
the lifecycle leaves `activating`.

### Team and invitation lifecycle

Roles are `owner`, `admin`, `operator` and `viewer`, from high to low. A route
admits its role and every higher role.

- At least one active owner remains. Triggers on `service_role_grant`
  enforce it (`organisation_final_owner_required`).
- An invitation assigns `admin`, `operator` or `viewer`, never `owner`.
- Pantry issues, stores and expires invitations
  ([`invitations.ts`](../../foundation/tenancy/organisation-access/invitations.ts),
  `organisation_invitation`). An invitation keeps the SHA-256 of a random
  32-byte token, and expires after 7 days. A new invitation for the same email
  replaces the open one. Pantry sends no e-mail: the inviter copies the link.
- Acceptance posts the token. The person must sign in with a verified Google
  email equal to the invitation email. One regional batch writes the
  `person`, the `service_role_grant`, the default Project membership and the
  accepted state. A second accept by the same person answers the same
  membership, and a person who is already a member keeps the role they have.
- Removal (`revokeOrganisationMembership`) returns the person's private chats
  to the default Project in the same batch.
- A role change increments `configuration_version` and records
  `readiness_invalidated`.

### Operating setup

Creation applies the capability profile `read_and_propose`. Provider writes
stay off until their own authorization rules pass. `GET …/setup/catalog`
lists the policy template `commerce_operator` and the cue presets
`observe_commerce`, `commerce_operator` and `proactive_triage`.

`PUT …/setup` sends a policy template, a capability profile
(`read_and_propose` or `approved_provider_writes`), a cue preset and a Slack
workspace and channel ID. `selectSetupTemplates` in
[`data/onboarding.ts`](../../services/platform/src/data/onboarding.ts) writes
the policy and cue snapshot pair, the selection, the destination, the receipt
and the events in one batch. The channel ID must be accessible through a
connected Slack account. A save is refused while `activating` or `archived`.

### Readiness

An assessment is `blocked` or `ready`, with a `readiness_version`, a
`readiness_hash` and the `configuration_version` that it used
(`organisation_readiness_assessment`, event `readiness_assessed`). Activation
needs every check:

| Check                                                                    | Blocker                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| One active owner                                                         | `owner_missing`                                   |
| An active placement in the Organisation environment                      | `placement_missing`                               |
| A Slack account with an installed surface                                | `communication_connection_missing`                |
| The selected channel is accessible in the latest resource snapshot       | `communication_destination_missing`               |
| A ready commerce system, and its sync is not `syncing` (see below)       | `commerce_system_missing`                         |
| Each checked account has one active credential generation                | `credential_unresolved`                           |
| Each checked non-Slack account has a live webhook; manifests are healthy | `webhook_unhealthy`                               |
| No provider row in another environment                                   | `environment_conflict`                            |
| A policy snapshot and a cue snapshot                                     | `policy_snapshot_missing`, `cue_snapshot_missing` |
| The model route resolves                                                 | `runtime_admission_unavailable`                   |

A ready commerce system is Seams Checkout with a Commerce binding, or
Shopify with a live webhook and one Commerce binding. The checked accounts
are the Slack destination account and the selected Shopify account. Other
accounts do not block activation. The stored assessment is a cache. While the lifecycle is `configuring`, a read
collects the blockers again and stores a new version only when the set
changed. A live signal that reports `unknown` does not vote.

### Activation

`POST …/activate` sends `readinessVersion` and `readinessHash` with the
mutation headers. If no model route resolves, the route returns `409` with a
code such as `codex_subscription_required`. Then
`OrganisationActor.activateOnboarding` runs one serialized Organisation
command ([`data/activation.ts`](../../services/platform/src/data/activation.ts)).

An attempt is unique per Organisation and readiness hash, and holds a
five-minute lease. An activated hash returns its receipt again. A stale fence
returns `409 activation_readiness_stale` with a detail such as
`configuration_changed_since_assessment`.

| Step        | Phase                  | Work                                                 |
| ----------- | ---------------------- | ---------------------------------------------------- |
| `readiness` | `validating`           | Record the fenced readiness version and hash         |
| `placement` | `assigning_runtime`    | Make the `OrganisationActor` record active           |
| `policy`    | `publishing_policy`    | Compile, publish and activate policy in `POLICY_KV`  |
| `cues`      | `publishing_cues`      | Store the cue selection and compile the cue snapshot |
| `accounts`  | `enabling_connections` | Move `pending_activation` accounts to `active`       |
| `publish`   | `finalizing`           | Write the activation receipt and the first task      |

Each step writes an `organisation_activation_step` row, renews the lease and
emits `activation_phase_completed`. A retry skips completed steps.

- Success writes `organisation_activation_receipt`, sets the lifecycle to
  `active`, resolves open support references and emits
  `activation_succeeded` and `first_task_presented`.
- Failure marks the attempt `failed`, returns the lifecycle to `configuring`
  and creates a support reference. The response is `retryable_failure`
  (`503`) or `terminal_failure` (`422`). The receipt stores it, so a replay
  returns the same failure.

### First operational task

Success returns one
[`FirstOperationalTask`](../../packages/contracts/src/types/FirstOperationalTask.ts)
(`organisation_first_operational_task`). The only kind is
`observe_recent_commerce`, with the commerce system revision and destination
ID. It does not encode agent memory or cue engine details.

### Result and error contract

A successful mutation returns `{ kind: "success", projection, receipt }`.
Other refusals return `{ ok: false, error: <code> }`.

| Result                                                     | Status                    |
| ---------------------------------------------------------- | ------------------------- |
| Success                                                    | `200` (invitation: `201`) |
| No session or invalid session                              | `401`                     |
| Bad origin, bad CSRF, or an invitation for another email   | `403`                     |
| No membership or low role                                  | `404`                     |
| Version, idempotency, lifecycle or placement conflict      | `409`                     |
| Invalid input (`400` on account onboarding); terminal fail | `422`                     |
| Authority unavailable; retryable activation failure        | `503`                     |

Responses never contain provider bodies, secrets, OAuth codes, stack traces
or internal object names.

## Onboarding operations and observability

Telemetry and support tools have no lifecycle authority. They read canonical
state and act only through the domain services that merchant actions use.

### Event envelope

Each onboarding event is one `onboarding_event` row:

`event_id`, `schema_version` (1), `event_type`, `occurred_at`,
`organisation_id`, `environment`, `portal_subject_hash`, `correlation_id`,
`causation_id`, `projection_revision` and `attributes`.
`portal_subject_hash` is the SHA-256 of the issuer and the subject.
`attributes` is a typed branch per type (`OnboardingEventAttributes` in
`control-mutation.ts`) with IDs, stages, phases, reason codes and counts only.
Events never hold OAuth values, tokens, secrets, credential references,
customer or commerce content, form values, raw provider errors, cookies or
CSRF values. A lifecycle event is written in the same D1 batch as its state
change. The browser can report only `onboarding_stage_viewed`.

### Event catalog

The `onboarding_event` CHECK allows these types. Platform emits no invitation
type and its TypeScript event union omits them; the CHECK keeps them so that
deployed databases need no table rebuild.

| Group          | Event types                                                                               | Emitted by                                           |
| -------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Onboarding     | `onboarding_started`, `_resumed`, `_stage_viewed`, `_stage_completed`                     | Bootstrap, setup, activation                         |
| Organisation   | `organisation_created`, `organisation_archived`                                           | Bootstrap, `organisation-lifecycle.ts`               |
| Invitation     | `invitation_created`, `_accepted`, `_revoked`                                             | None yet (`organisation_invitation` keeps the state) |
| Provider       | `provider_attempt_started`, `_connected`, `_cancelled`, `_failed`, `_expired`             | `provider-attempt.ts`                                |
| Reconciliation | `provider_reconciliation_started`, `_completed`, `_failed`                                | `onboarding-reconciliation.ts`                       |
| Accounts       | `default_account_changed`                                                                 | `integration-account.ts`                             |
| Setup          | `setup_saved`, `readiness_assessed`, `readiness_invalidated`                              | Setup, readiness, account changes                    |
| Activation     | `activation_started`, `_phase_completed`, `_succeeded`, `_failed`, `first_task_presented` | `activation.ts`                                      |
| Support        | `support_reference_created`                                                               | `activation.ts`, `provider-attempt.ts`               |

### Audit evidence

Each accepted control mutation writes one `onboarding_audit_event` row: actor,
Organisation, environment, operation, target, old and new lifecycle, versions,
receipt, correlation and causation IDs, time and a stable reason code. It
records no credentials, provider content or customer data. No code updates or
deletes audit or event rows.

### Support references and merchant diagnostics

An activation, provider start or provider attempt failure creates one
`onboarding_support_reference` row with a random `PANTRY-<uuid>` reference. The
row links the correlation ID, actor, route, operation, lifecycle before and
after, provider, redacted provider status, receipts, last successful phase,
retry classification and occurrence times. The projection shows the newest
unresolved reference. A successful activation resolves all of them, and a
newly connected account resolves those of its provider.

`GET /v1/control/organisations/:id/support/:reference` returns the merchant
diagnostics: reference, provider and display account, reason code, time,
retry status, last successful phase, webhook health counts and projection
revision. The Portal shows them in a technical details disclosure.

### Operator view

Support access needs a `control_support_role` row with role `support_agent`
or `support_admin`. The routes are in
[`control/routes/operators.ts`](../../services/platform/src/control/routes/operators.ts)
and the reads in
[`data/onboarding-support.ts`](../../services/platform/src/data/onboarding-support.ts).

- `GET /v1/control/operator/onboarding` takes one of `supportReference`,
  `organisationId`, `providerAccount` or `correlationId`. Each case shows the
  lifecycle, versions, latest receipt, manifest versions, webhook health and
  one timeline of events and audit rows. Each lookup writes a hashed row to
  `onboarding_support_access_audit`.
- `POST /v1/control/operator/organisations/:id/reconcile` and `…/actions`
  need `support_admin`. The actions are `invalidate_attempt`,
  `disable_account`, `resume_activation` and
  `archive_ownerless_legacy_organisation`.

Operator actions use the same domain services and mutation receipts as
merchant actions. Direct D1 lifecycle updates are not allowed.

### Reconciliation

The `*/15 * * * *` cron (staging and production) calls
`runScheduledOnboardingReconciliation` in
[`onboarding-reconciliation-runner.ts`](../../services/platform/src/onboarding-reconciliation-runner.ts).
It first runs the automatic archive. Then, for each Organisation whose
runtime is Cloudflare-authoritative, it publishes the directory row,
reconciles policy publication, credential cutovers, account cleanup and
manifest observations, and runs the subjects below. Last, it resumes a running
activation whose lease expired, with the first owner's identity and the key
`activation-reconcile:<attemptId>`.

| Subject                 | Check and repair                                                             |
| ----------------------- | ---------------------------------------------------------------------------- |
| `open_attempts`         | Expire connection attempts past `expires_at`                                 |
| `credentials`           | Degrade an active account with no active credential generation               |
| `accounts`              | Degrade an active account whose connection is not active in its environment  |
| `webhooks`              | Degrade a default Shopify or Stripe account with no live webhook             |
| `default_accounts`      | Mark one active account as default per provider and environment              |
| `setup_snapshots`       | Drop readiness when a policy, cue, commerce or destination record is missing |
| `readiness`             | Refresh the assessment with unknown live signals                             |
| `archived_organisation` | Provider cleanup, then the purge after `purge_after`                         |

An account repair increments `configuration_version`, so readiness runs again.
A subject run that repairs something or fails is an
`onboarding_reconciliation_run` row with `provider_reconciliation_*` events.
A run that finds nothing to repair leaves no record: every Organisation runs
every subject each quarter of an hour. Reconciliation only expires, degrades or
marks records. It never broadens provider permissions. The archive cleanup
moves through `pending_provider_cleanup`, `pending_purge` and `purged` (or
`failed`). The purge keeps the tombstone, audit rows and events.

### Runbooks

The [onboarding operations runbook](../runbooks/onboarding-operations.md)
lists each incident with its signal, safe repair, manual action and closure
evidence.
