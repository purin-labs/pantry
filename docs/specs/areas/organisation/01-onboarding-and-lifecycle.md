# ORG-01 — Onboarding and lifecycle

Purin Pantry makes each Organisation itself, with no outside account. A signed-in person
names the Organisation in the **Set up Purin Pantry** dialog and becomes its owner. The
Organisation then starts in the lifecycle `configuring`. A Slack install for an unknown
workspace also makes an Organisation, with no owner, in `active`. An admin connects
Slack and a commerce system, saves one setup, reads the readiness assessment and starts
the activation. The `OrganisationActor` runs the activation in six checkpointed steps,
and the Organisation becomes `active`. An admin can archive the Organisation and restore
it for 30 days. After that time, or after an owner deletes it, a scheduled run purges
it. Setup, activation, archive and restore each have a mutation receipt, audit rows and
typed events. Delete has a receipt and an audit row, and no event. The scheduled purge
moves have no receipt and no audit row. Support tools read this state, and they change
it only through the same domain functions.

## What it does

### Sign-up

Google sign-in makes the `app_user` row and a control session (FND-06). The
Organisations page shows a **Set up Purin Pantry** button to each person, also to a
person who has Organisations. A click opens the dialog. A saved setup record opens the
dialog with no click. The dialog has a segmented bar, a counter ("Step 2 of 4") and
`aria-current="step"` on the current segment:

1. **Organisation.** One field of at most 120 characters. An empty name sends nothing.
2. **Prepare.** `POST /v1/control/organisations` with `{ operationId, name }`. The route
   answers when the Organisation exists, so the Portal does not poll. The Portal then
   reads the session again. When the session lists the Organisation, the Portal removes
   its setup record.
3. **Jev.** The optional step of ORG-02. One choice turns on three switches, or the
   person selects **Skip**. A refusal of one switch does not block the setup. A reload
   in this step does not resume the setup.
4. **Done.** The person reaches this step after **Skip** or **Continue**.

The Portal keeps the request in `sessionStorage` under
`pantry:account-onboarding:<userId>`. While this record exists, a reload, a retry or a
new sign-in sends the same `operationId`, the idempotency key of the route. A repeat
answers with the first Organisation, also after the person reached the owner limit. A
refusal replaces the body of its step with a heading, a reason, an action and the error
code. Examples are `organisation_limit_reached`, `idempotency_key_conflict` ("Start
again" with a new operation id) and `authority_unavailable` ("Try again" with the same
operation id).

### Creation

`createOwnedOrganisation` (`organisation-access/creation.ts`) makes the Organisation:

- The owner must have the issuer `https://accounts.google.com` and a verified email.
- The environment is `production` when `PANTRY_DEPLOYMENT_PROFILE` is `production`, and
  `development` on every other deployment. A request with `purpose: "test"` makes a
  `development` Organisation on any deployment. Only an email on the Worker secret
  `PANTRY_TEST_ORGANISATION_OWNERS` may send it. The Portal has no control for it.
- The Organisation goes to the root cell of `PANTRY_ORGANISATION_PLACEMENT_PROFILE`
  (FND-01). A person cannot select a cell.
- A person owns at most 5 Organisations whose status is `active`, in all cells. An
  archived Organisation does not count. A test Organisation counts.

`bootstrapOrganisation` (`data/control-plane.ts`) first reserves the Organisation, its
placement and a receipt (status 202) in the global database. Then one regional batch
writes the `organisation` row (plan `beta`), the default workspace, the placement, the
owner `person` and `owner` grant, the Base Project, `organisation_onboarding`
(`configuring`, `read_and_propose`, configuration version 1), the access defaults, one
audit row and the events `organisation_created`, `onboarding_started` and
`onboarding_stage_completed`. A failed batch makes no Organisation. Last, the request
activates the global placement and publishes the receipt (status 201).

The Slack OAuth callback is a second path, and it needs no control session. With a valid
signed state, it makes an Organisation for a workspace that has no `slack_installation`
row for this app and environment (`slack-ingress/install.ts`, `data/organisation.ts`).
The id is `organisation_<teamId>`. The Organisation has no owner, the lifecycle `active`,
the environment `development` and the activation receipt id `system-install:<id>`.

### Setup

- The catalog has the policy template `commerce_operator` and the cue presets
  `observe_commerce`, `commerce_operator` and `proactive_triage`, each at version 1.
- `PUT …/setup` sends `policyTemplateId`, `capabilityProfile` (`read_and_propose` or
  `approved_provider_writes`), `cuePresetId` and `cueTarget` (`workspaceId`,
  `channelId`). The workspace needs an active Slack account with a Slack surface in the
  environment. The channel must be `accessible` in a resource snapshot of that account
  (`provider_resource_not_accessible`). The check takes the newest snapshot where the
  channel is `accessible`, so an old snapshot passes when a newer one says otherwise.
- `selectSetupTemplates` (`data/onboarding.ts`) writes one batch: the two
  `organisation_setup_snapshot` rows, the selection, the destination, the Slack channel
  row, the access defaults with a grant for the channel, the receipt, the audit row and
  the events `setup_saved`, `onboarding_stage_completed` and `readiness_invalidated`.
  The policy has `highStakesWrites` `approval_required` for `approved_provider_writes`.
- A save raises the configuration version. A save in `active` moves the Organisation
  back to `configuring`, so it must activate again. A save in any other lifecycle
  answers `organisation_lifecycle_conflict`. A save does not need a commerce system.

### Readiness

An assessment is `blocked` or `ready`. It has a `readiness_version`, a `readiness_hash`
and the `configuration_version` that it used. Each new assessment writes one
`organisation_readiness_assessment` row and the event `readiness_assessed`.

| Check                                                                                                                       | Blocker                                           |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| One active owner                                                                                                            | `owner_missing`                                   |
| An active placement in the environment of the Organisation                                                                  | `placement_missing`                               |
| An active Slack account with a Slack surface                                                                                | `communication_connection_missing`                |
| The destination channel is `accessible` at the saved revision in a resource snapshot of the account, of any age             | `communication_destination_missing`               |
| A ready commerce system, and its sync is not `syncing`                                                                      | `commerce_system_missing`                         |
| Each checked account has one active credential generation and a resolved credential reference                               | `credential_unresolved`                           |
| Each checked account that is not Slack has a live webhook. Each checked account has a newest manifest observation `healthy` | `webhook_unhealthy`                               |
| No provider connection, account, webhook or credential generation in another environment                                    | `environment_conflict`                            |
| A policy snapshot and a cue snapshot                                                                                        | `policy_snapshot_missing`, `cue_snapshot_missing` |
| The model route resolves (FND-04)                                                                                           | `runtime_admission_unavailable`                   |

- A ready commerce system is Purin Checkout (`builtin_commerce`) with a commerce binding
  in the environment, or Shopify with a live webhook and exactly one commerce binding.
- The checked accounts are the Slack account of the destination and the selected
  Shopify account. Other accounts do not block activation.
- The stored assessment is a cache. Only a `configuring` Organisation refreshes it. A
  read collects the blockers again. It stores a new version when the set of blockers
  changed, or when the current configuration version has no assessment. A signal that
  reports `unknown` does not vote. An assessment of an old configuration version reads
  as version 0 with the hash `unassessed`. An `active` Organisation reads the assessment
  of its activation receipt. The report `approval_authentication` never blocks
  activation.

### Activation

`POST …/activate` sends `readinessVersion` and `readinessHash`. The route resolves the
model route first. If no route resolves, it answers 409 with a code such as
`codex_subscription_required`. The route then refreshes readiness, with the runtime
admission `available`. Then
`OrganisationActor.activateOnboarding` (`actors/organisation/activation.ts`) runs one
serialized command of the Organisation.

- The assessment must have the sent version and hash, the current configuration
  version, the version of the request header and the current environment. The lifecycle
  must be `configuring` or `activating`. If not, the answer is 409
  `activation_readiness_stale` with a `detail`: `readiness_assessment_missing`,
  `configuration_changed_since_assessment`, `client_configuration_stale`,
  `assessment_environment_mismatch` or `organisation_lifecycle_incompatible`.
- An attempt is unique for each Organisation and readiness hash, and it holds a lease of
  5 minutes. During a live lease, a request gets 409 `activation_attempt_in_progress`,
  unless its causation id is the lease owner. The causation id is the valid
  `x-request-id` header of the request. So a second request with the same header and
  another idempotency key enters the live attempt. A hash that activated before answers
  its receipt.

| Step        | Phase                  | Work                                                                              |
| ----------- | ---------------------- | --------------------------------------------------------------------------------- |
| `readiness` | `validating`           | Record the readiness version and hash                                             |
| `placement` | `assigning_runtime`    | Write the record of the `OrganisationActor` (`active`, plan `beta`)               |
| `policy`    | `publishing_policy`    | Compile, publish and activate the policy in `POLICY_KV`                           |
| `cues`      | `publishing_cues`      | Write the cue subscriptions of the preset and compile the cue snapshot            |
| `accounts`  | `enabling_connections` | Move `pending_activation` accounts to `active` and mark the first default account |
| `publish`   | `finalizing`           | Mark the attempt ready to complete                                                |

Each step writes an `organisation_activation_step` row, renews the lease and emits
`activation_phase_completed`. A retry skips the completed steps. Each preset gets seven
commerce cues, for example `payment_failed` and `order_unshipped`. `commerce_operator`
adds `charge.failed` and `orders/create`. `proactive_triage` also adds
`invoice.payment_failed` and `inventory_levels/update`.

- **Success** writes `organisation_activation_receipt` and
  `organisation_first_operational_task` (kind `observe_recent_commerce`), sets
  `active`, resolves each open support reference and emits `activation_succeeded`,
  `first_task_presented` and `onboarding_stage_completed` (stage `review_activation`).
- **Failure** marks the attempt `failed`, returns to `configuring`, makes a support
  reference and emits `activation_failed` and `support_reference_created`. The codes
  are `activation_policy_failed`, `activation_cues_failed`, `activation_publish_failed`
  and, in a fault journey, `activation_interrupted`. The answer is 503
  `retryable_failure`. The receipt keeps it, so a replay gets the same answer.

During activation, the Portal reads the projection with `If-None-Match`, at delays from
500 ms that grow by 1.5 times up to 3 s. It stops when it has seen `activating` and then
another lifecycle, after the first failed read, or when the activate request settles.

The account routes of INT-01 also change the onboarding state. **Disable**
(`…/accounts/:id/disable`, admin) sets the account, its webhooks and, when no other
account uses it, its connection to `disabled`. It raises the configuration version and
emits `readiness_invalidated`. **Reconnect** (`…/reconnect`, admin) starts a new
provider attempt for an `active`, `disabled`, `degraded` or `reauth_required` account.
**Rotate** (`…/rotate`, admin) starts one for an `active` account.

### Archive, restore, delete and purge

| Transition                                  | Trigger                                               |
| ------------------------------------------- | ----------------------------------------------------- |
| none → `configuring`                        | `bootstrapOrganisation`                               |
| none → `active`                             | The Slack OAuth callback for an unknown workspace     |
| `configuring`, `active` → `configuring`     | `PUT …/setup`                                         |
| `configuring`, `activating` → `activating`  | `POST …/activate`, or the resume of a stalled attempt |
| `activating` → `active`, or → `configuring` | All steps complete, or a step fails                   |
| `configuring`, `active` → `archived`        | `POST …/archive`, or the automatic archive            |
| `archived` → `configuring`                  | `POST …/restore`, before `purge_after`                |
| `archived` → `purging` → `purged`           | The scheduled run, after `purge_after`                |

- **Archive** sets `archived_at`, `purge_after` (30 days later) and `organisation.status`
  `deleted`. In the same batch, it disables each account, connection and webhook. It
  clears `is_default_for_provider` on each account that it disables, and it writes
  `organisation_archive_cleanup` (`pending_provider_cleanup`) and
  `organisation_archive_tombstone`. The route then deletes the latest policy pointer in
  `POLICY_KV`. The archived Organisation stays eligible for reads until its purge
  (FND-06), so that its owner can see it and restore it.
- **Restore** returns the Organisation to `configuring` with a new configuration
  version and `organisation.status` `active`. It deletes the cleanup row and the
  tombstone. It does not enable the accounts and does not set their default flag again,
  so a former default account can be removed. Before the cleanup, an admin can
  reconnect a `disabled` account. After the cleanup, its connection is `revoked`:
  reconnect answers `provider_account_ineligible`, and a new connection of the same
  provider account fails. An admin removes the account, which frees its identity, and
  connects it again. A selected Shopify account refuses the removal
  (`integration_account_in_use`). After `purge_after`, after the cleanup reaches
  `purged`, or after the harness erasure starts, restore answers
  `organisation_purge_started`.
- **Delete** (`DELETE /v1/control/organisations/:id`, owner) accepts only an `archived`
  Organisation. It sets `purge_after` to now, renames the Organisation to "Deleted
  organisation" and deletes each `service_role_grant` and Project member row. The
  Portal sends an archive first when the Organisation is not archived.
- **Automatic archive.** Each scheduled run archives, with the reason
  `automatic_inactivity`, an Organisation that is `configuring`, unchanged for 30 days,
  with no `provider_connection` and no connection attempt in the last 30 days.
- **Cleanup.** When no provider account cleanup waits, the run removes the voice Mac
  names. It revokes the Slack connections, the credential generations, the connections,
  the Vault secrets, the voice Macs and the devices (DEV-01). The cleanup row becomes
  `pending_purge`.
- **Purge.** After `purge_after`, the run moves the lifecycle to `purging`. It erases
  the Session Actors and their objects (`organisation_harness_erasure`), each R2
  object of the Organisation (`PURGE_R2_PREFIXES`: attachments, Kitchen runs and
  artifacts, workflow documents, snapshots and exports), the device fleets and the
  WhatsApp Connectors. An export that a relocation or restore journal still names
  stays. It closes the commerce
  merchant and moves shared Slack credentials to an Organisation that still uses the
  workspace. Then one batch moves to `purged` and runs `PURGE_CATALOGUE`
  (`data/purge-catalogue.ts`). Last, the run publishes the directory row and deletes the
  Slack DM selections and thread pins of the Organisation in the global database. The
  handle, the Google accounts and the Slack workspaces are then free for a new
  Organisation.
- **Relocation.** A cleanup or a purge that the `OrganisationActor` admitted before a
  relocation can finish on the `frozen` placement. The regional copy moves the
  lifecycle, event and audit rows to the new cell (FND-01).

### Support and diagnostics

- An activation failure or a provider start or attempt failure makes one
  `onboarding_support_reference` row (`PANTRY-<uuid>`). The projection shows the newest
  open one. A new connected account resolves the references of its provider.
  `GET …/support/:reference` gives the provider, reason, retry state, last phase and
  webhook health of one reference.
- A `control_support_role` (`support_agent` or `support_admin`) looks up cases by
  `supportReference`, `organisationId`, `providerAccount` or `correlationId`. Each
  lookup writes a hashed row to `onboarding_support_access_audit`.
- A `support_admin` runs a reconcile and the actions `invalidate_attempt`,
  `disable_account`, `resume_activation` and `archive_ownerless_legacy_organisation`.
  The last one needs an `active` Organisation with no active member, no commerce
  binding and no active default Shopify account. A `support_admin` also reads the
  harness history and the erasure receipts of an Organisation.

### Scheduled reconciliation

The `*/15 * * * *` cron of the production Worker calls
`runScheduledOnboardingReconciliation` (`onboarding-reconciliation-runner.ts`). It runs
the automatic archive in each cell first. Then, for each Organisation that is not
purged, it publishes a stopped initial placement and the directory row (FND-01). It
reconciles the policy of an `active` Organisation, the credential cutovers, the account
cleanup and the manifests. It releases the held permission decisions and the held
outputs, and it runs the subjects below. It resumes a `running` attempt whose lease
ended, as the first active owner, with the key `activation-reconcile:<attemptId>`. Then
it reconciles the email watches. After the last Organisation, it sweeps the Vault alerts.

| Subject                 | Repair                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `open_attempts`         | Expire connection attempts after `expires_at`                                                 |
| `credentials`           | Degrade an active account with no active credential generation                                |
| `accounts`              | Degrade an active account whose connection is not active in its environment                   |
| `webhooks`              | Degrade a default Shopify or Stripe account with no live webhook                              |
| `default_accounts`      | Mark one active default account for each provider and environment                             |
| `setup_snapshots`       | Delete the assessments when a saved setup lacks a policy, cue, commerce or destination record |
| `readiness`             | Refresh the assessment of a `configuring` Organisation with `unknown` signals                 |
| `archived_organisation` | The cleanup, then the purge, through `OrganisationActor.reconcileArchiveCleanup`              |

An account repair raises the configuration version, so readiness runs again. Only a
subject that repairs something or fails writes an `onboarding_reconciliation_run` row
and `provider_reconciliation_*` events. Most subjects expire, degrade or mark records.
`setup_snapshots` deletes assessments. `archived_organisation` revokes credentials,
connections and Vault secrets, and it purges the Organisation.

## Contracts

- Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`). This
  module owns `organisation_onboarding_selection`, `organisation_setup_snapshot`,
  `organisation_communication_destination`, `organisation_slack_channel`,
  `organisation_readiness_assessment`, `organisation_activation_attempt`,
  `organisation_activation_step`, `organisation_activation_receipt`,
  `organisation_first_operational_task`, `onboarding_support_reference`,
  `onboarding_reconciliation_run`, `organisation_harness_erasure`,
  `organisation_harness_erasure_session`, `organisation_harness_erasure_object`,
  `provider_manifest` and `provider_account_tombstone`. FND-01 (`foundation/tenancy`)
  owns `organisation`, `organisation_onboarding`, `organisation_archive_cleanup`,
  `organisation_archive_tombstone` and `organisation_invitation`. The events and audit
  are `onboarding_event` and `onboarding_audit_event`. Global D1 has
  `control_support_role` and `onboarding_support_access_audit`.
- `organisation_onboarding.lifecycle` is `configuring`, `activating`, `active`,
  `archived`, `purging` or `purged`, and a table CHECK sets the fields of each value.
  `ORGANISATION_LIFECYCLE_MACHINE` (`data/organisation-lifecycle.machine.ts`) is the
  machine, and `data/organisation-lifecycle-moves.ts` writes each move under the fence.
  `organisation_archive_cleanup.status` is `pending_provider_cleanup`, `pending_purge`,
  `purged` or `failed`.
- `packages/contracts/src/types/` holds `OnboardingProjectionV1`,
  `OrganisationOnboardingLifecycle`, `FirstOperationalTask` and the other `Onboarding*`
  types. `packages/control-api/src/organisations.ts` holds
  `readOrganisationCreationRequest` and the one name rule of creation and rename
  (`readOrganisationName`, `ORGANISATION_NAME_MIN`, `ORGANISATION_NAME_MAX`).

`GET …` returns one `OnboardingProjectionV1` (`data/onboarding-projection.ts`): the
revisions, the Organisation, the membership, the steps, the provider accounts, the
operating profile, readiness, activation, `next_action`, `first_task` and
`support_reference`. The steps are `workspace`, `inference`, `commerce`,
`conversations`, `operating_profile` and `review_activation`, each `unavailable`,
`available`, `in_progress`, `action_required` or `complete`. `next_action` is
`perform`, `repair`, `wait` (`retry_after_ms` 1,000) or `done`. Only `connect_slack`
opens a `popup`. The ETag is `"organisation:<id>:revision:<projection_revision>"`, and
a match answers 304.

The routes are in `control/routes/onboarding.ts` and `control/routes/operators.ts`.
`…` is `/v1/control/organisations/:id`. FND-06 has the member and invitation routes.

| Route                                                                  | Role            | Purpose                                                       |
| ---------------------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| `GET /home-regions`, `GET /setup/catalog`                              | A session       | The placement cells; the templates and presets                |
| `GET`, `POST /organisations`                                           | A session       | The memberships; make an Organisation                         |
| `GET …`                                                                | Viewer          | The projection, after a readiness refresh                     |
| `PATCH …`, `DELETE …`                                                  | Owner           | Rename (2 to 120 characters); delete an archived Organisation |
| `PUT …/setup`                                                          | Admin           | Save the setup                                                |
| `POST …/onboarding/stage-viewed`                                       | Viewer          | Record `onboarding_stage_viewed`                              |
| `GET …/readiness`                                                      | Viewer          | The current assessment, after a manifest check                |
| `POST …/activate`, `…/archive`, `…/restore`                            | Admin           | Activate, archive, restore                                    |
| `GET …/support/:reference`                                             | Viewer          | Diagnostics of one support reference                          |
| `GET /operator/onboarding`                                             | `support_agent` | Look up onboarding cases                                      |
| `POST /operator/organisations/:id/reconcile`, `…/actions`              | `support_admin` | Reconcile now; one support action                             |
| `GET /operator/organisations/:id/harness-history`, `…/harness-erasure` | `support_admin` | The harness history; the erasure receipts                     |

- Rename, delete, setup, activate, archive and restore need the `Origin`, the CSRF
  header (FND-06), an `idempotency-key` of 8 to 128 characters and
  `x-pantry-configuration-version`. The same key and body return the stored answer. The
  same key with another body answers 409 `idempotency_key_conflict`. A stale version
  answers 409 `configuration_version_conflict` and changes nothing.
- Of these six, a success answers `{ kind: "success", projection, receipt }`, and delete
  answers the receipt alone. `POST /organisations` answers `{ ok: true, organisation }`,
  and `stage-viewed` answers `{ kind: "success" }`. A failed activation answers the
  `kind` `retryable_failure` with `reason_code`, `correlation_id`, `support_reference`
  and `projection`. Another refusal answers `{ ok: false, error }`. Invalid input
  answers 422, a missing membership or a low role 404, and a version, idempotency,
  lifecycle or placement conflict 409.
- Each event is one `onboarding_event` row with a subject, correlation ids and typed
  `attributes` (`OnboardingEventAttributes` in `data/control-mutation.ts`). The subject
  is a hash, and a readiness event has the literal value `system:readiness`. A lifecycle
  event goes in the batch of its state change.
- Agent tools: none. No tool under `agent-tools/` changes the lifecycle.
- Other files: `data/organisation-lifecycle.ts`, `data/organisation-purge.ts`,
  `data/onboarding-support.ts`, and `portal.tsx` and `portal-reads.ts` in the Portal.

## Rules and limits

| Action                                         | Viewer                                             | Operator | Admin | Owner | Support                                | Agent |
| ---------------------------------------------- | -------------------------------------------------- | -------- | ----- | ----- | -------------------------------------- | ----- |
| Make an Organisation                           | Each signed-in person with a verified Google email |          |       |       |                                        | No    |
| Read the projection, readiness and diagnostics | Yes                                                | Yes      | Yes   | Yes   | Lookup with a support role             | No    |
| Save the setup, activate, archive, restore     | No                                                 | No       | Yes   | Yes   | `resume_activation`, ownerless archive | No    |
| Rename, delete an archived Organisation        | No                                                 | No       | No    | Yes   | No                                     | No    |
| Disable, reconnect or rotate an account        | No                                                 | No       | Yes   | Yes   | `disable_account`                      | No    |

| Limit                                          | Value               | Constant                                         |
| ---------------------------------------------- | ------------------- | ------------------------------------------------ |
| Active Organisations of one owner              | 5                   | `ORGANISATION_OWNER_LIMIT`                       |
| Organisation name, at creation and at a rename | 2 to 120 characters | `ORGANISATION_NAME_MIN`, `ORGANISATION_NAME_MAX` |
| Activation lease                               | 5 minutes           | `ACTIVATION_LEASE_MS`                            |
| Time from archive to purge                     | 30 days             | `ARCHIVE_PURGE_DELAY_MS`                         |
| Idle time before the automatic archive         | 30 days             | `AUTOMATIC_ARCHIVE_IDLE_MS`                      |
| Mutation receipt                               | At least 24 hours   | `MUTATION_RECEIPT_TTL_MS`                        |

- **Lifecycle authority.** `data/organisation-lifecycle-moves.ts` writes each move of
  the lifecycle. A relocation copy and `restoreOrganisationDataArchive` insert the
  `organisation_onboarding` row with its lifecycle in the target cell. The cleanup of an
  inactive cell deletes that row. Support actions use the same domain functions as
  merchant actions.
- **Retention.** No code updates `onboarding_event` or `onboarding_audit_event` rows.
  Only `deleteInactiveRegionalOrganisationData` deletes them, in the retired or
  abandoned cell of a relocation. The purge keeps them, the tombstone, the cleanup row,
  the reconciliation runs and the erasure ledger (`keep` in `PURGE_CATALOGUE`). It
  pseudonymizes the `organisation` row and the provider records.
- **Information flow.** `OnboardingEventAttributes` limits an event to ids, labels (such
  as a stage, a phase or a provider), reason codes, versions and counts. An audit row
  has ids, the operation, the lifecycle values, versions and a reason code. A support
  reference also keeps the HTTP status or the WhatsApp error code of a provider failure,
  and the provider request id.
- **Idle cost.** A run that finds nothing to repair writes no row. A readiness refresh
  writes only when the set of blockers changed or the current configuration version has
  no assessment. "Open work" names one exception.
- **Out of scope:** a suspended lifecycle (`suspension_reason_code` and `suspended_at`
  stay NULL), a choice of cell, an email for an invitation, and billing.
- **Boundaries.** FND-01 owns the placement, the execution scope, the directory row and
  `control_mutation_receipt`. FND-06 owns sign-in, sessions, members, invitations,
  roles and request eligibility. FND-04 owns the model routes that readiness checks.
  FND-08 owns the Vault secrets that the cleanup revokes. INT-01 owns provider
  connections, credentials, webhooks and the account routes. The commerce specs own the
  commerce binding and the merchant that the purge closes. DEV-01 owns the device
  revoke at archive. ORG-02 owns the Jev step. PRT-01 owns the Portal shell.

## Open work

- **Activation does not check the blockers.** The route and `activationStaleDetail`
  (`data/activation.ts`) check the version, the hash, the configuration, the
  environment and the lifecycle. A `blocked` assessment with both snapshots can
  activate. Only the projection hides the action. The check accepts any assessment of
  the current configuration version, so a newer `blocked` assessment does not stop an
  older one.
- **A restore after the cleanup.** Reconnect refuses a `revoked` connection, and
  `createConnectedIntegration` throws for its `disabled` account.
- **Repeated writes.** While a saved setup has no commerce system, `setup_snapshots`
  deletes the assessments and writes a run row each 15 minutes. `readiness` then writes
  a new assessment.
- **The stage route.** `POST …/onboarding/stage-viewed` has no Origin or CSRF check.
- **No terminal failure.** Each activation failure is 503. The 422 answer has no
  producer. No code writes `organisation_archive_cleanup.status = 'failed'`.
- **Labels that differ.** The tombstone names the first active owner, also when an admin
  archives. `OrganisationOnboardingLifecycle` has no `purging` or `purged`.
- **Billing** (Plan 95 step 6) is not built, and the plan is always `beta`.

## Sources

- [Onboarding architecture](../../../architecture/onboarding.md) and
  [Organisation setup flow](../../../organisation-setup-flow.md). Where they differ
  from the code, this spec follows the code. These two documents and Plan 95 name no
  evidence link in the archive, so this spec has none.
- Background: [Plan 95](../../../plan-95-pantry-own-accounts.md). The procedures are in
  the [onboarding operations runbook](../../../runbooks/onboarding-operations.md) and
  the [harness erasure runbook](../../../runbooks/harness-erasure.md). The neighbour
  specs: [FND-01](../../foundation/01-tenancy-and-placement.md),
  [FND-06](../../foundation/06-identity-policy-and-approval.md) and
  [DEV-01](../devices/01-devices.md).
- E2E journeys in `workers/platform/tests/e2e/`: `organisation-setup.test.ts`,
  `regional-onboarding.test.ts`, `new-organisation-first-chat.test.ts`,
  `organisation-archive-access.test.ts`, `organisation-lifecycle-placement.test.ts`,
  `slack-answer-before-archive.test.ts`, `purged-organisation-reclaim.test.ts`,
  `purged-organisation-commerce.test.ts`, `slack-channel-after-deletion.test.ts`,
  `gmail-after-deletion.test.ts`, `whatsapp-erasure.test.ts`,
  `kitchen-files-erasure.test.ts`, `device-fleet-end.test.ts` and
  `idle-tenant-cost.test.ts`. The closure suite is
  `pnpm --filter @purin-labs/platform test:onboarding-closure`.
- Browser journey: `scripts/frontend-foundation/portal-account-setup-journey.mjs`, and
  the preview `apps/portal/organisations-preview.html?setup=live`.
