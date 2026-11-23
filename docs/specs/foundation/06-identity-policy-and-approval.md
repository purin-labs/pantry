# FND-06 — Identity, policy and approval

Purin Pantry keeps its own accounts. A person signs in with Google, and a control
session proves that person on each Portal request. Each Organisation has members with
one of four roles, and an admin invites a member with a link. One access check answers
if a person or an automation may act now. A capability catalogue, a policy snapshot and
access grants decide what a Sous Chef turn may do. The action ledger holds the governed
commerce actions and the custom connector writes, and each one waits for an owner or an
admin. An approval in the Portal needs a new Google sign-in, and a Slack card approves
six kinds of action. One read lists the decisions that wait for a person, and one call
records each answer.

## What it does

### Sign-in and control sessions

- A person signs in through Google OIDC with a state, a nonce and a PKCE challenge.
  Pantry checks the signature, the issuer, the audience, the times and the nonce of the
  ID token, and accepts only a verified email.
- Pantry uses a state one time (`oidc_state_consumed`). The `pantry_oidc_state` cookie
  of the callback path must equal the `state` parameter. `returnTo` becomes a path on
  the same origin. A start on another host goes to the public origin first.
- The sign-in writes the `app_user` row and a new `control_session`. Pantry stores only
  a SHA-256 hash of the session token and of the CSRF token. The cookies are
  `pantry_session` (`HttpOnly`) and `pantry_csrf`, both `Secure` and `SameSite=Lax`.
- A session ends 7 days after its last extension and 30 days after its sign-in. Only
  `GET /v1/control/session` and `POST /session/rotate` extend it. The session read
  extends it at most one time an hour, so most reads write nothing.
- A mutation needs an `Origin` header equal to `PANTRY_PUBLIC_ORIGIN`. Its
  `x-pantry-csrf` header must equal the `pantry_csrf` cookie and the stored CSRF hash.
- `GET /v1/control/session` gives the identity, the support role and the memberships
  that pass a new access check. If a check has no answer, the list is `incomplete`.

### Organisations, members and invitations

- **Creation.** A signed-in person with a verified Google email sends
  `{ operationId, name }` and becomes the owner. The operation id is the idempotency
  key: a repeat answers with the first Organisation. A person owns at most 5 active
  Organisations (`organisation_limit_reached`). A new Organisation has the plan `beta`
  and goes to the root cell of the placement profile.
- **Members.** Each member has one `service_role_grant` row and one `person` row. An
  admin changes a role below `owner` or removes a member who is not an owner. Only an
  owner gives the role `owner`, takes it away, or removes an owner. An admin who tries
  gets `organisation_owner_required` (403). A removal revokes the grant, returns the
  private chats of the member to the default Project and removes the Project
  memberships, in one batch. Each change raises the configuration version of the
  Organisation, so a turn with the old version stops at its next authority check. The
  code and two D1 triggers keep one active owner (`organisation_final_owner_required`).
  A change with an old version answers `configuration_version_conflict`. A change to an
  `activating`, `archived`, `purging` or `purged` Organisation answers
  `organisation_lifecycle_conflict`.
- **Invitations.** An admin or an owner invites an email with the role `admin`,
  `operator` or `viewer`. Pantry answers one time with a random 32-byte token and keeps
  only its SHA-256 hash. The Portal shows a link, and the person who invites copies
  it. Pantry sends no email. A new invitation for the same email revokes the open one.
  An invitation ends after 7 days.
- **Accept.** The person signs in and sends the token. The verified Google email must
  equal the invitation email. A wrong token answers as a missing invitation. One batch
  writes the person, the role, the membership of the default Project and the state
  `accepted`. A second accept by the same person gives the same membership. A member
  keeps their role. An `activating` or `archived` Organisation takes no new member.

### Roles

| Role       | Rank | What it adds                                                                |
| ---------- | ---: | --------------------------------------------------------------------------- |
| `viewer`   |    1 | Reads. The access check admits only `disclose` and `replay`                 |
| `operator` |    2 | Starts work, and uses the daily pages of the shop (`roleMayOperate`)        |
| `admin`    |    3 | Configuration (`roleMayConfigure`): members, invitations, Access, approvals |
| `owner`    |    4 | The rename and the delete of the Organisation. At least one owner stays     |

A route names its lowest role, and `authorizeOrganisationControl` compares the ranks of
`CONTROL_ROLE_RANK`. Slack asks the same functions as the Portal. A person with no
membership, or with a role that is too low, gets 404. An admin gives the roles `admin`,
`operator` and `viewer`. Only an owner gives `owner` or changes an owner
(`changeOrganisationServiceRole`, `revokeOrganisationMembership`).

### Request eligibility

`OrganisationAccess` (`organisation-access/access.ts`) answers one question: may this
person or automation take this action now? Each call reads the current records. The
actions are `execute`, `disclose`, `restore` and `replay`. A control read asks for
`disclose`. A mutation asks for `execute`, unless its route names another action.

| Check                           | Rule                                                                                                             | Refusal                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Organisation                    | The placement fence of the request is current                                                                    | `authority_unavailable` |
| Organisation                    | The status is `active` or `deleted`, and the lifecycle is not `purging` or `purged`                              | `instance_ineligible`   |
| Person                          | An active `service_role_grant`. An `authenticated_session` is the live session of that person                    | `membership_ineligible` |
| Person                          | An `accepted_execution` is an accepted turn that acts for a person. It needs the active role and no live session | `membership_ineligible` |
| Person                          | A `viewer` asks only for `disclose` or `replay`                                                                  | `membership_ineligible` |
| Person                          | A `disclosure_recipient` asks only for `disclose`. An `authenticated_provider_event` asks only for `execute`     | `scope_forbidden`       |
| Workflow                        | An enabled `cue_subscription` or `schedule_binding` at the revision of the request                               | `membership_ineligible` |
| Mailbox agent, WhatsApp support | The current revision of the binding, with an active integration account                                          | `membership_ineligible` |

An archived Organisation (status `deleted`) stays eligible until its purge, so that its
owner can read and restore it. A D1 fault answers `authority_unavailable`.

### Capabilities, policy and grants

- **Catalogue.** `CAPABILITY_CATALOGUE` has 71 capabilities, each at version 1. A
  capability has a label, a description, a category, a risk (`read`, `propose` or
  `external_effect`), a target kind, a provider dependency and its policy modes.
- **Policy mode.** Each Organisation has one `organisation_capability_policy` row for
  each capability: `enabled`, `approval_required` or `disabled`. The catalogue gives the
  modes that a capability accepts (`capability_policy_mode_unsupported`). 46
  capabilities accept `enabled` or `disabled`, 18 accept `approval_required` or
  `disabled`, and 7 accept each mode.
- **Access defaults.** `…/defaults/apply` adds the missing rows of the baseline
  `read_and_propose` version 1: one policy row for each capability (8 `enabled`, the
  others `disabled`) and four grants for the owner role and the admin role. It changes
  no policy row and no grant that exists.
- **Policy snapshot.** `policy-snapshot.ts` compiles one versioned snapshot: the egress
  rules, the rules `allowedTools`, `deniedTools`, `approvalRequired` and `maxBudget`,
  and the output check mode (`hold` or `stream`). An `enabled` capability goes to
  `allowedTools`. An `approval_required` capability goes to `allowedTools` and to
  `approvalRequired`. A `disabled` capability goes to `deniedTools`. D1
  `policy_snapshot` is the authority, and KV holds the copy that turns read.
  `OrganisationActor.activatePolicy` refuses an older version (`policy_version_stale`)
  and a different body at the same version (`policy_version_conflict`). If the load
  fails, `loadOrganisationPolicyOrDefaultDeny` gives a policy with no tool and no host.
- **Access grants.** An `access_grant` row gives one subject one target, and is
  `active` or `revoked`. A subject is a role, a person, a conversation, a workflow, a
  mailbox agent or a WhatsApp support binding. A target is a `platform_capability`, a
  `provider_resource`, a `file_resource`, a `custom_connector_operation`, a
  `commerce_read` or a `commerce_command`. A `provider_resource` grant with the scope
  `*` admits each resource of its integration account, in a capability claim and in a
  ledger proposal.
- **AI budget.** `workspace_ai_budget` limits one run: 64,000 tokens, 180 s of active
  time and 20 tool calls. An admin can raise it to 1,000,000 tokens, 600 s and 200
  calls. A change publishes a new policy snapshot.
- **Prompt in place.** A Portal action outside the grants of a person answers 403
  `…_permission_required`, with the capability and the `person` grant that it needs.

### Agent authority

- Each turn carries one `RequestAuthority`: `direct_conversation`,
  `shared_conversation`, `workflow` (also cues and schedules), `agent_mailbox`,
  `whatsapp_support` or `control`.
- `validateLiveRequestAuthority` asks the access check and reads the live records. For
  a person, the grant must have the same role and the same configuration version.
- `compileTurnAuthority` selects the active grants that apply to the authority
  (`selectActiveGrants`). A direct conversation and a Portal chat use the grants of the
  role and of the person. A shared conversation uses the grants of the role and of the
  conversation. An automation uses the grants of its own binding.
- The result is an `AuthorityPartition`: its key, the digest of the selected grants,
  the capability keys and the policy version, under one SHA-256 digest.
- `authorizeCapabilityUse` checks each capability claim again. It fails with
  `capability_not_granted`, `selected_grants_superseded` or
  `organisation_policy_superseded`. A policy activation notifies no Session
  (`consumers: 0`). The next message compiles the authority at the current policy
  version. A role change and a removal signal the open chat pages (`signalChat`), and
  each page reads again.
- **Permission request.** With the tool `request_permission`, an agent asks an owner or
  an admin for access. It can name the 23 capabilities of `PERMISSION_REQUESTABLE` and
  the 11 record reads of `REQUESTABLE_ENTITY_TYPE_READS`. The list has no `stripe.*`
  capability, no supplier payout capability and no order cancellation capability. Six
  of the reads are refused in a shared channel. Allow succeeds only when the access is
  there: the Portal first enables the capabilities and adds the grants
  (`permission_missing`). An owner or an admin reads each request that waits. Another
  member reads only their own requests.

### Action classes

The catalogue gives each capability one risk. The code has no other list of action
classes.

| Risk              | Capabilities | Policy modes that the catalogue accepts                                                            |
| ----------------- | -----------: | -------------------------------------------------------------------------------------------------- |
| `read`            |           21 | `enabled` or `disabled`                                                                            |
| `propose`         |            9 | `enabled` or `disabled`                                                                            |
| `external_effect` |           41 | 16 accept `enabled` or `disabled`. 18 accept `approval_required` or `disabled`. 7 accept each mode |

The action ledger holds only commerce actions and custom connector writes. With the
mode `enabled`, an `external_effect` capability such as `airtable.api.write` or
`whatsapp.support.reply.send` runs with no ledger entry.

### The action ledger

`OrganisationActor` keeps the ledger in its SQLite storage. An entry is a commerce
action (host `pantry.commerce`) or a custom connector write. It binds the Case, the
Session, the proposal, the `RequestAuthority`, the `AuthorityPartition`, the flow
binding, the `ActionAuthority`, the resource key and the idempotency key.

```text
proposed -> approval_requested -> signed -> executing
  -> confirmed | failed | indeterminate          (also: rejected, expired)
```

- A proposal needs a partition that holds the capability key of the action, and a flow
  binding of the same Organisation, Session and partition. The same proposal id gives
  the same entry. A different body fails with `action_replay`.
- An entry in `proposed`, `approval_requested` or `signed` becomes `expired` at its
  expiry, when a call next uses the ledger. A read of the ledger is such a call. Each
  proposer sets 15 minutes. The supplier payout proposer sets the earlier of 15 minutes
  and the execution deadline of the payout plan.
- Execution starts only from `signed`, under a lease of 5 minutes. The Actor alarm, or
  the next ledger call, moves an entry with an ended lease to `indeterminate`.
- A second action on the same account and resource key waits while the first is
  `signed`, `executing` or `indeterminate` (`resource_busy`).
- The same receipt settles an entry again with no change. A different receipt fails
  with `action_receipt_conflict`.
- A retry from `indeterminate` needs evidence: `provider_idempotency_absent`,
  `provider_idempotent_replay` or `local_effect_absent`. A custom connector write
  retries only on a replay, if its definition declares provider idempotency.

### Approval and the step-up sign-in

`ApprovalEvidence` (`approval-authentication.ts`) keeps the principal apart from the
ceremony. The principal is an `app_user` with the role `owner` or `admin`. Each ceremony
binds the Organisation, the action nonce, the action digest, the policy binding
`unversioned_default`, an issue time and an expiry. The digest covers each field of the
action, also its amount, its expiry and its resource key. A changed action needs a new
decision.

1. The Portal opens `GET /v1/control/auth/google/start?purpose=approval` with the
   Organisation and the action. The person must be an admin, and the action must wait.
2. Pantry stores the challenge with the OIDC state. Its expiry is the earlier of the
   action expiry and 10 minutes. Google must show its sign-in (`prompt=login`,
   `max_age=0`).
3. The callback makes a new control session and the cookie `pantry_approval`. The
   cookie holds the user and the challenge. Pantry signs it with HMAC-SHA-256, and the
   key is the Google client secret.
4. `POST …/approval` needs an admin, a session of 10 minutes or less, and a grant for
   this user, Organisation and action with the same digest. It uses the ceremony one
   time, then the ledger entry is `signed`. The Case wait reads the ledger, and Pantry
   stores a mutation receipt.
5. The Portal calls `POST …/execute`.

- **Reject.** An owner or an admin sends `{ "reason": "merchant_declined" }`. A
  rejection needs no step-up sign-in, because it changes nothing outside Pantry.
- **Supplier payout.** The approver cannot be the person who proposed the destination
  (`supplier_payout_approver_forbidden`). A changed payout answers
  `supplier_payout_approval_stale`.
- **Slack.** A button decides only for an owner or an admin whose Slack user has a
  verified link. The ceremony `slack_verified_link` lasts 60 s. Approve and Decline
  work only for the six kinds of `SLACK_APPROVABLE_ACTION_KINDS`: a catalogue listing,
  a product description, tracking, an offer price, a menu price and a plugin install.
  Approve signs the action and runs it in the same click, with no `/execute` call. The
  same person can Deny a permission request on its Slack card.
- Each approval needs the session or the verified Slack link of a person. An agent
  has neither.

### The decisions that wait for a person

| Kind                 | Store                                                                                                     | Who decides                                                 | Life                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `governed_action`    | `action_ledger` in `OrganisationActor` SQLite                                                             | Owner or admin                                              | 15 minutes, or less for a supplier payout |
| `held_output`        | `held_output_request` in regional D1 (FND-07)                                                             | A member who may see the content, by the reason of the hold | 7 days                                    |
| `permission_request` | `agent_permission_request` in regional D1                                                                 | Owner or admin                                              | 7 days                                    |
| `email_review`       | The Case. Its projections are `email_reply_proposal` and `email_operational_proposal_projection` (INB-01) | Owner or admin                                              | 72 hours                                  |

- **Held output.** The decider must see the content and pass the access check for
  `execute`, so a viewer cannot decide. For the reason `private_source`, that member
  decides. For `outside_written`, only the person who asked decides. For each other
  reason, an owner, an admin or the person who asked decides.
- **Email review.** A Gmail reply is in `email_reply_proposal`. An operational email
  (`operational_new_message`) is in `email_operational_proposal_projection`.
- **The one read.** `GET …/decisions` gives the reader a `PendingDecisionList`, newest
  first. `listPendingDecisions` reads each store one time and copies no record. The
  ledger read first ends the entries that are due, as each ledger call does. The other
  three reads write nothing. Each store applies the check of its own page. A custom
  connector write shows only to an owner or an admin. A Case approval wait is the same
  decision as its ledger entry, so it gives no second item. If the ledger does not
  answer, the read answers 503 `pending_decisions_unavailable`.
- **The one decide call.** `decidePendingDecision` takes a `PendingDecisionCall`: the
  kind, the id of the entry and the answer `allow` or `refuse`. Ten decide routes call
  it. The request is the proof of the person. Each store keeps its role check, its
  step-up grant, its mutation boundary, its receipt and its effect.
- **One look.** The Portal shows a decision with `DecisionButtons` or with
  `PermissionRequestDialog`. In Slack, `decisionCardBlocks` builds each card.

## Contracts

- **Global D1** (`services/platform/migrations-global/0001_current_schema.sql`):
  `app_user`, `control_session`, `control_oidc_state` and `control_support_role`.
  `control_mutation_receipt` is in both baselines.
- **Regional D1** (`services/platform/migrations-regional/0001_current_schema.sql`):
  `person`, `service_role_grant`, `organisation_invitation`, `access_grant`,
  `organisation_capability_policy`, `policy_snapshot`, `workspace_ai_budget`,
  `agent_permission_request`, `person_authz_role` and `person_authz_audit`.
- **Actor SQLite:** `action_ledger` (`actors/action-ledger.ts`) and
  `organisation_policy_head` in `OrganisationActor`.
- **Contracts:** `RequestAuthority`, `OrganisationAdmissionAction`,
  `OrganisationUserAuthority`, `CapabilityDefinition` and the grant types in
  `packages/contracts/src/` (`types/RequestAuthority.ts`, `organisation-access.ts`,
  `access-control.ts`). `PendingDecision` and `readOrganisationCreationRequest` are in
  `packages/control-api/src/` (`pending-decisions.ts`, `organisations.ts`).
- **Capabilities:** `foundation/authority/authorization/capability-catalogue.ts`. A
  new capability needs `node scripts/capability-policy-backfill-sql.mjs`, which adds a
  `disabled` row for each Organisation that lacks one.
- **Agent tool:** `request_permission` (`agent-tools/catalog/permission.ts`). A Slack
  thread turn and a Portal chat turn get it, with the capabilities that the turn lacks.
- **Receipts and audit.** A mutation with a receipt carries an `Idempotency-Key`
  header, and a member change also `x-pantry-configuration-version`.
  `control_mutation_receipt` keeps the answer for a replay. A role change and a removal
  write an `onboarding_audit_event`.

The control routes are under `/v1/control`. `…` is `/v1/control/organisations/:id`.

| Route                                                                                           | Role                                  | Purpose                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| `GET /auth/google/start`, `GET /auth/google/callback`                                           | None. Admin for `purpose=approval`    | Sign-in and step-up sign-in                         |
| `GET /session`, `POST /session/rotate`, `POST /logout`                                          | A session                             | Read, rotate and end the session                    |
| `GET`, `POST /organisations`                                                                    | A session                             | The memberships of the person; make an Organisation |
| `GET …/members`                                                                                 | Viewer                                | The members                                         |
| `PATCH`, `DELETE …/members/:userId`                                                             | Admin                                 | Change a role, remove a member                      |
| `GET`, `POST …/invitations`                                                                     | Viewer, admin                         | List the open invitations, invite                   |
| `POST …/invitations/:id/revoke`                                                                 | Admin                                 | Close an invitation                                 |
| `POST …/invitations/:id/accept`                                                                 | A session, no role                    | Accept with the token                               |
| `GET …/access-control`, `GET …/access-control/options`, `POST …/access-control/explain`         | Viewer                                | The Access page and the reason of a decision        |
| `POST …/access-control/grants`, `…/grants/:id/revoke`, `…/capabilities/:id`, `…/defaults/apply` | Admin                                 | Change grants and policy modes                      |
| `GET`, `POST …/access-control/ai-budget`                                                        | Viewer, admin                         | Read or change the AI budget                        |
| `GET …/access-control/permission-requests`, `GET …/access-control/permission-requests/:id`      | Viewer                                | Permission requests and held outputs                |
| `POST …/access-control/permission-requests/:id/decision`                                        | Admin                                 | Allow or deny a permission request                  |
| `GET …/decisions`                                                                               | Viewer                                | The one read of the decisions                       |
| `POST …/commerce/actions/:nonce/approval`, `/rejection`, `/execute`                             | Admin                                 | Decide and run a commerce action                    |
| `POST …/custom-connectors/:c/actions/:nonce/approval`, `/rejection`                             | Admin                                 | Decide a custom connector write                     |
| `GET`, `POST /v1/admin/person-roles`                                                            | The bearer `ORGANISATION_ADMIN_TOKEN` | Give or remove the `approve` role of a person       |

The main files, under `services/platform/src/`:

| Topic                        | Files                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in, sessions            | `control/oidc.ts`, `control/routes/sessions.ts`, `control/authorization.ts`, `data/control-plane.ts`                                                                                                                                                                                                                                                                                     |
| Accounts                     | `organisation-access/access.ts`, `organisation-access/creation.ts`, `organisation-access/invitations.ts`, `control/routes/onboarding.ts`                                                                                                                                                                                                                                                 |
| Capabilities, grants, policy | `authorization/capability-catalogue.ts`, `authorization/requestable-capabilities.ts`, `authorization/access-grants/compiler.ts`, `authorization/access-grants/turn-authority.ts`, `request-authority/index.ts`, `policy-snapshot.ts`, `actors/organisation/organisation-policy.ts`, `data/capability-policy.ts`, `access-control/capability-mutations.ts`, `data/workspace-ai-budget.ts` |
| Ledger, approval             | `actors/action-ledger.ts`, `approval-authentication.ts`, `control/routes/commerce/actions.ts`, `control/routes/custom-connectors/write-actions.ts`, `slack/commerce-approval.ts`                                                                                                                                                                                                         |
| Decisions                    | `control/pending-decisions.ts`, `control/decide-pending-decision.ts`, `control/pending-decision-parts.ts`, `control/routes/pending-decisions.ts`, `control/routes/agent-permission-requests.ts`, `control/routes/held-output-requests.ts`, `slack/decision-card.ts`, `slack/permission-request-deny.ts`                                                                                  |

The Portal files are `areas/organisation/ui/features/access/` (the Access page and the
prompts), `features/integrations/workspace.tsx` (members and invitations),
`pages/account-invitation.tsx` and `ui/decision-buttons.tsx`.

`scripts/layers.json` gives the module of each file:

| Module                                 | Files                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundation/tenancy`                   | `organisation-access/`, `data/control-plane.ts`, `data/workspace-ai-budget.ts`                                                                                        |
| `foundation/authority`                 | `authorization/`, `access-control/`, `request-authority/`, `policy-snapshot.ts`, `data/capability-policy.ts`, `actors/action-ledger.ts`, `approval-authentication.ts` |
| `foundation/control`                   | `control/oidc.ts`, `control/authorization.ts`, `control/pending-decisions.ts`, `control/decide-pending-decision.ts`, `control/routes/pending-decisions.ts`            |
| `foundation/agent`                     | `control/routes/sessions.ts`, `actors/organisation/organisation-policy.ts`                                                                                            |
| `foundation/conversation`              | `control/routes/agent-permission-requests.ts`, `control/routes/held-output-requests.ts`                                                                               |
| `areas/organisation`                   | `control/routes/onboarding.ts`                                                                                                                                        |
| `areas/commerce`, `areas/integrations` | `control/routes/commerce/actions.ts`, `control/routes/custom-connectors/write-actions.ts`                                                                             |
| `surfaces/slack`                       | `slack/commerce-approval.ts`, `slack/decision-card.ts`, `slack/permission-request-deny.ts`                                                                            |
| `workers/platform`                     | `control/pending-decision-parts.ts`                                                                                                                                   |

## Rules and limits

| Action                                                       | Viewer                                             | Operator                  | Admin                                            | Owner                                            | Agent                           |
| ------------------------------------------------------------ | -------------------------------------------------- | ------------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------- |
| Read members, invitations, Access and the AI budget          | Yes                                                | Yes                       | Yes                                              | Yes                                              | No tool                         |
| Pass the access check for `execute`                          | No                                                 | Yes                       | Yes                                              | Yes                                              | Under the authority of its turn |
| Invite, revoke an invitation, change a role, remove a member | No                                                 | No                        | Yes                                              | Yes                                              | No                              |
| Change a grant, a policy mode or the AI budget               | No                                                 | No                        | Yes                                              | Yes                                              | Asks with `request_permission`  |
| Allow or deny a permission request                           | No                                                 | No                        | Yes                                              | Yes                                              | No                              |
| Approve a governed action                                    | No                                                 | No                        | With a step-up, or on a Slack card for six kinds | With a step-up, or on a Slack card for six kinds | No. It proposes                 |
| Decide a held output                                         | No                                                 | By the reason of the hold | By the reason of the hold                        | By the reason of the hold                        | No                              |
| Reject a governed action                                     | No                                                 | No                        | Yes                                              | Yes                                              | No                              |
| Rename or delete the Organisation                            | No                                                 | No                        | No                                               | Yes                                              | No                              |
| Make an Organisation                                         | Each signed-in person with a verified Google email |                           |                                                  |                                                  | No                              |

| Limit                                                                   | Value                                                                               | Constant                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Session: from its last extension, from its sign-in, renewal step        | 7 days, 30 days, 1 hour                                                             | `CONTROL_SESSION_TTL_MS`, `CONTROL_SESSION_MAX_AGE_MS`, `CONTROL_SESSION_RENEWAL_STEP_MS` |
| OIDC state; clock difference of an ID token                             | 10 minutes; 60 s                                                                    | `OIDC_STATE_TTL_MS`, `CLOCK_SKEW_SECONDS`                                                 |
| Step-up sign-in and its challenge; Slack approval                       | 10 minutes; 60 s                                                                    | `APPROVAL_STEP_UP_MAX_AGE_MS`, `SLACK_APPROVAL_WINDOW_MS`                                 |
| Action expiry                                                           | 15 minutes. A supplier payout: the earlier of 15 minutes and its execution deadline | No constant: each proposer writes `15 * 60_000`, and the payout proposer adds `Math.min`  |
| Execution lease                                                         | 5 minutes                                                                           | `ACTION_EXECUTION_LEASE_DURATION_MS`                                                      |
| Invitation                                                              | 7 days                                                                              | `INVITATION_TTL_MS`                                                                       |
| Active Organisations of one owner; name length at creation; at a rename | 5; 1 to 120 characters; 2 to 80 characters                                          | `ORGANISATION_OWNER_LIMIT`, `ORGANISATION_NAME_MAX`; no constant for the rename           |
| Answer that one read can use again                                      | 5 s                                                                                 | `READ_ANSWER_MS`                                                                          |
| Permission request; held output                                         | 7 days; 7 days                                                                      | `AGENT_PERMISSION_REQUEST_LIFETIME_MS`, `HELD_OUTPUT_REQUEST_LIFETIME_MS`                 |
| Mutation receipt                                                        | 24 hours                                                                            | `MUTATION_RECEIPT_TTL_MS`                                                                 |
| AI budget, highest values                                               | 1,000,000 tokens, 600 s, 200 calls                                                  | `WORKSPACE_AI_BUDGET_MAXIMUM`                                                             |
| Entries that the one read looks at                                      | 50 ledger entries, 100 email proposals                                              | `ACTION_READ_LIMIT`, `EMAIL_REVIEW_READ_LIMIT`                                            |

- **Three legs.** An operation needs a principal that permits it, and a policy and
  grants that permit the capability. It also needs a state that permits this exact
  transition. If one leg fails, Pantry denies the operation.
- **No authority from input.** A display name, a provider alias, a browser value, a
  prompt or a tool name gives no authority. The tool identity comes from the accepted
  catalogue. An approval binds one action digest and cannot approve a later change.
- **Accounts are for people.** Only `control/routes/onboarding.ts` calls the functions
  that make an Organisation, issue, revoke or accept an invitation, change a role or
  remove a member. No file under `agent-tools/` calls them. Each of these changes who
  can act.
- **Audit records.** `onboarding_audit_event` and `person_authz_audit` have columns for
  identities, operations, versions and reason codes, and no column for a credential.
  `control_mutation_receipt` keeps the answer body of a mutation. A route that answers
  with a secret gives the receipt a body without it, as
  `control/routes/commerce-api-keys.ts` does. No general check enforces this. Platform
  code logs through `traceLog` and `traceWarn`.
- **Information flow.** The ledger stores the flow binding of each action. A permission
  request stores capability ids and record types, with no record content. FND-07 owns
  the labels, the exit check, the `approval_required` check and the held outputs.
- **End of an Organisation.** The purge erases the roles, the invitations, the grants,
  the policy rows, the snapshots and the permission requests
  (`data/purge-catalogue.ts`).
- **Out of scope:** passwords and other sign-in providers; an email for an invitation;
  roles for one location; prepaid credit.

The boundaries:

- FND-01 owns the placement, the execution scope and `control_mutation_receipt`. FND-02
  owns the Actor runtime. FND-03 owns the Case approval wait and the Case outbox.
- FND-04 owns the model routes and the run budget of a Session. FND-07 owns information
  flow and held outputs. FND-08 owns Purin Vault, the credential resolvers and
  revocation. FND-09 owns the tool catalogue and its effects.
- ORG-01 owns the setup, the activation, the archive, the restore and the purge of an
  Organisation, and the support roles. ORG-02 owns Jev from Purin and its paid use.
- The commerce specs (COM-01, COM-05) own the commerce actions of the ledger. INT-01
  owns the custom connector writes. INB-01 owns the email proposals.
- [Plan 95](../../plan-95-pantry-own-accounts.md) stays a plan for its step 6.

## Open work

- **Billing (Plan 95 step 6).** The code has no plan catalogue, no
  `organisation_billing_account`, no Stripe Checkout and no billing webhook. It has no
  `billing.account.*` capability and no agent read tool for billing. Paid use of Jev
  is closed (`JEV_PAID_USE_OPEN` is false). The plan is always `beta`.
- **Other ceremonies.** `webauthn_step_up` and `seams_nep413` parse, but no route makes
  them. `/v1/admin/person-roles` writes the `approve` role, and no approval reads it.
  The policy binding of an approval is always `unversioned_default`.
- **The one read and the one decide call.** No Portal page and no agent tool calls
  `GET …/decisions`. Each page reads the list of its own store. The Slack buttons of a
  commerce action and the Deny of a permission request call their stores directly. Each
  store answers with a `Response`, not a `Result`.
- **Other decisions** are not in the one read. Examples are configuration drafts, side
  Case proposals, memory candidates, Slack message drafts and WhatsApp replies. Each
  keeps its own store, route and card.
- **Invitations.** Issue, revoke and accept write no mutation receipt and no audit
  event. The row keeps the person who invited, but not the person who revoked.
- **Retention.** No job deletes ended `control_session` rows, used `control_oidc_state`
  rows or ended ledger entries. A person cannot select the cell of a new Organisation.

## Sources

- [Security architecture](../../architecture/security.md), the sections "Identity,
  approval and authorization" and "Policy snapshot and session pinning". It gives no
  evidence link.
- Background: [Plan 95](../../plan-95-pantry-own-accounts.md) (Pantry's own accounts)
  and [Refactor 17](../../refactor-17.md), the entries "A2.1 — One decision API" and
  "A2.1: the decisions", and Appendix E. They give no archive link for this subsystem.
- Where a source differs from the code, this spec follows the code. E2E journeys in
  `services/platform/tests/e2e/`. Accounts:
  `organisation-setup.test.ts`, `organisation-invitation.test.ts`,
  `member-removal-access.test.ts`, `organisation-archive-access.test.ts`,
  `slack-viewer-refusal.test.ts` and `bakery-agent-canvas.test.ts`. Grants and policy:
  `grant-placement.test.ts`, `grant-writers-placement.test.ts`,
  `policy-publication-placement.test.ts`, `commerce-propose-permission.test.ts`,
  `commerce-write-permission.test.ts` and `slack-follow-up-authority.test.ts`.
  Permission requests: `slack-permission-request.test.ts`,
  `chat-permission-request.test.ts`, `chat-agent-permission-request.test.ts` and
  `slack-proposal-permission.test.ts`. Approval and decisions:
  `slack-commerce-approval.test.ts`, `pi-commerce-actions.test.ts`,
  `portal-chat-approval-wait.test.ts`, `slack-offer-price-change.test.ts`,
  `remote-mcp.test.ts`, `mail-reply-shared-draft.test.ts`, `slack-held-output.test.ts`
  and `slack-held-effect.test.ts`.
- Browser journeys: `scripts/frontend-foundation/portal-account-setup-journey.mjs` and
  `scripts/plan21/browser-acceptance.mjs`.
