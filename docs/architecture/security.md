# Security architecture

This document describes how Pantry keeps credentials, network egress and
external actions under trusted control. It states the current invariants, the
owners and the modules that enforce them. Module paths are relative to
[`workers/platform/src/`](../../workers/platform/src/).

| Replaces                                              | Section                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Spec 2 — Trusted Egress and Credential Injection      | [Trusted egress](#trusted-egress)                                            |
| Spec 6 — Seams Vault, Policy, and Revocation          | [Vault, policy and revocation](#vault-policy-and-revocation)                 |
| Spec 8 — Identity, Approval, and Action Authorization | [Identity, approval and authorization](#identity-approval-and-authorization) |

The [IFC integration guide](../../foundation/authority/policy/information-flow/README.md)
owns information-flow labels, flow bindings and destination checks. The
[Vault runbook](../runbooks/vault-operations.md) owns key provisioning and
operator procedures. This document does not repeat them.

## Trusted egress

Plaintext credentials exist only inside trusted Platform code, for one
authorized operation. They never enter Actor session state, prompts, private
history, Case context, generated code, executor storage, tool output, Queue
bodies, logs or receipts. Agents get no raw network access.

| Path               | Credential                         | Rule and module                                                                                       |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Model transport    | pinned route, resolved per request | `AgentSessionActor` model route lease to Pi; see [Model routes](#model-routes-and-exit-workers)       |
| Typed capability   | purpose-bound Vault resolution     | Harness Tool Host, accepted catalog, bounded output (`actors/embedded-harness-tool-host.ts`)          |
| Provider mutation  | provider action resolver           | needs an action ledger entry in state `executing`; see [Action ledger](#action-ledger)                |
| Connector delivery | installation credential            | immutable Case outbox address; exact account, environment and generation                              |
| Custom connector   | connector account credential       | fetch container; DoH lookup refuses an address that is not public (`custom-connector-egress.ts`)      |
| Public link fetch  | none                               | link fetch container; DoH lookup refuses an address that is not public (`message-link-reader.ts`)     |
| Generated code     | none                               | `CodeModeSandbox` Worker has no binding; the Actor admits each call (`actors/code-mode-admission.ts`) |
| Heavy execution    | none                               | `WorkspaceExecutorContainer`, `enableInternet = false`; trusted code accepts its changeset            |

A credentialed request authenticates the caller and Organisation, validates
lifecycle state, resolves the exact account and environment, and matches the
current policy and active generation. It reserves budget or action authority
before it resolves the one credential for its purpose. It sends one bounded
request, discards the plaintext and settles a metadata-only result. A handle,
hostname, prompt, program or diagnostics object cannot supply authority.

### Model routes and exit Workers

Each session pins one `ModelRoute`
([contract](../../packages/contracts/src/model-route.ts), `model-route.ts`).
Every route runs Pi.

| `keySource`                 | `provider`          | Credential                                                      |
| --------------------------- | ------------------- | --------------------------------------------------------------- |
| `platform`                  | `openai-compatible` | Pantry's `OPENROUTER_API_KEY` Worker secret                      |
| `organisation_byo`          | `openai`            | Organisation OpenAI API key in the Vault                        |
| `organisation_byo`          | `anthropic`         | Organisation Anthropic API key in the Vault                     |
| `organisation_oauth`        | `anthropic`         | Claude account sign-in in the Vault                             |
| `organisation_subscription` | `openai`            | ChatGPT sign-in in the Vault, pinned by revision and generation |

`createEmbeddedHarnessModelRouteLease` (`actors/agent-session.ts`) resolves
the key only when Pi sends a request, and only while the Organisation
execution scope is active. Missing or exhausted authority fails the pinned
route. No route falls back to another funding authority. The Session
refreshes the rotating ChatGPT sign-in under the `refresh_lease` of
`organisation_codex_connection`.

Direct model-provider requests use `modelProviderFetch(env)`
(`model-exit/provider-fetch.ts`). Never patch `globalThis.fetch`. The
OpenRouter route stays direct. `pantry-model-exit` (`model-exit/worker.ts`)
runs at `aws:ap-northeast-1`. It forwards HTTPS only to `auth.openai.com`,
`api.openai.com`, `api.anthropic.com` and `platform.claude.com`, with manual
redirects. `pantry-chatgpt-exit` (`chatgpt-exit/worker.ts`) hands
`chatgpt.com` requests to one shared container at location hint `apac-ne`.
Both exits refuse other hosts, hold no credential, keep no state, do not retry
and never log a header, body or token.

### Delivery, execution and responses

The session checkpoint binds the tool catalog digest, model route digest and
policy revision (`actors/embedded-harness.ts`). Connector retries keep the
provider idempotency identity, and the provider receipt settles the exact Case
outbox entry. Code Mode and the executor never get Vault handles, raw provider
clients, control-plane tokens, unrestricted D1 or R2 access, or authority to
settle their own effects.

Each adapter pins its origins, redirects, sizes, timeouts and retries. The
boundary parses untrusted provider bodies once into versioned results. Raw
headers, tokens, stack traces and provider bodies never enter model-visible or
operator-visible errors.

## Vault, policy and revocation

Seams Vault (`credential-vault/`) owns encrypted Organisation credentials and
their lifecycle. Cloudflare Secrets Store owns the Vault roots. Provider
systems own the provider-side credential. Policy and grants decide which
operation may resolve a credential. A Vault handle (`vault:...`) grants no
authority by itself.

| Secret                                        | Storage                                           |
| --------------------------------------------- | ------------------------------------------------- |
| Organisation provider token or webhook secret | Vault ciphertext in D1 `vault_secret`             |
| Organisation model key or model sign-in       | Vault ciphertext in D1 `vault_secret`             |
| Website login of a Vault item                 | Vault ciphertext, or the Organisation's 1Password |
| 1Password service account token               | Vault ciphertext, `vault_store.token_handle`      |
| Platform OAuth secrets, `OPENROUTER_API_KEY`  | Worker secrets in `wrangler.jsonc`                |
| Vault roots                                   | Secrets Store `VAULT_ROOT_V1`, `VAULT_ROOT_V2`    |
| Actor archive and checkpoint root             | Secrets Store `DATA_ENCRYPTION_ROOT`              |

### Vault record, keyring and root rotation

A `vault_secret` row stores the handle, key version, `AES-GCM-256` nonce and
ciphertext. The additional authenticated data binds Organisation, handle and
key version (`credential-vault/crypto.ts`). `provider_credential_generation`
binds a connection to a generation, environment and lifecycle (`staged`,
`active`, `superseded`, `revoked`, `failed`), with one active generation.

The keyring (`credential-vault/keyring.ts`) writes with the root that
`PANTRY_VAULT_ACTIVE_KEY_VERSION` selects, and reads with the exact version on
the row. It refuses an unknown version, a missing binding and key material
that is not 32 bytes.

Root rotation is one durable job in `vault_root_rotation_job`
(`credential-vault/root-rotation.ts`): `pending`, `running`, `paused`,
`completed` or `failed`. Operators run it through
`/v1/control/operator/vault/root-rotations`. Each step decrypts with the
source root, encrypts with the target root and verifies a decrypt. The update
applies only if the stored nonce and ciphertext still match. The source root
stays until no row depends on it (`credential-vault/root-closure.ts`).

### Policy snapshot and session pinning

`policy-snapshot.ts` compiles one versioned `OrganisationPolicySnapshot` into
D1 `policy_snapshot`: egress rules from `credential_ref`, authorization rules
and conversation risk settings. `OrganisationActor.activatePolicy` refuses an
older version, and a different body at the same version. Diagnostics explain
a decision and never become authority for it.

A session pins the policy version in its authority partition. Each capability
claim compares the pin with the current D1 snapshot. After any new version,
restrictive or not, the claim fails with `organisation_policy_superseded`.
Nothing is pushed to a running session. The next message compiles authority
at the current version.

### Purpose-bound resolution

Only the resolvers in `credential-vault/` decrypt. Each one requires the valid
lifecycle state for its purpose and first rechecks Organisation, account,
environment, generation, handle and policy. A denial writes a
`credential_access_denial` row with purpose and reason code (`alerts.ts`).
The purposes are model route, provider action (an `executing` ledger entry),
webhook verification, provider connection and onboarding, Connector delivery
and account removal: `organisation-model-resolution.ts`,
`provider-action-resolution.ts`, `webhook-resolution.ts`,
`provider-connection-resolution.ts`, `surface-installation-resolution.ts` and
`account-removal-resolution.ts`.

### Credential rotation and revocation

A rotation (`integrations/contract/credential-lifecycle.ts`) moves `credential_rotation`
through `pending_verification`, `verified` and `committed`, or to `failed`. A
non-mutating provider call verifies the replacement. The commit supersedes the
old generation and activates a new one. `provider-credential-cutover.ts` then
activates the new policy and repairs an interrupted cutover.

`revokeCredential` (`credential-vault/service.ts`) closes the `vault_secret`
row and every dependent generation, connection, integration account, webhook
and `credential_ref`. `activateCredentialRevocationPolicy` then publishes the
restricted policy. `credential_revocation_operation` is unique per handle, so
retries converge on one receipt. Later resolution fails with
`vault_secret_revoked`, also for a running session.

### Vault items and stores

`vault_item` holds `website_login` and `contact_profile` items
(`credential-vault/items.ts`). An Organisation keeps them in Seams Vault or in
1Password (`credential-vault/stores.ts`). The `pantry-vault-onepassword` Worker
runs 1Password SDK calls behind the `VAULT_ONEPASSWORD` binding. It keeps only
SDK clients in memory and never logs a request, token or item.

Open (Plan 79 phases 3, 5 and 6): agent browser fill and secure notes. Payment
cards are not planned: the owner removed them from the plans on 2026-11-28.

### Output screening

`redaction.ts` detects emails, card numbers, credentials and model protocol
markers in untrusted output. `incremental-output-screen.ts` screens a streamed
Slack answer with the released context, so a split value is still found, and
holds the stream after a hit. `screenTextForSurface` screens the final text.
The policy sets `outputScreeningMode` to `hold` or `stream`.

### Failure behavior

| Failure                                                   | Result                                         |
| --------------------------------------------------------- | ---------------------------------------------- |
| Missing or revoked credential                             | deny before network access                     |
| Organisation, account, environment or generation mismatch | deny before decrypt                            |
| Missing root or invalid key material                      | `vault_root_unavailable`, `vault_root_invalid` |
| Policy missing, invalid or superseded                     | deny; `organisation_policy_superseded`         |
| Missing action authority                                  | typed denial with no effect                    |
| Provider timeout before a known commit                    | retry only under the capability's rule         |
| Unknown provider outcome                                  | `indeterminate`; reconcile by stable identity  |
| Interrupted root rotation                                 | resume, or start a new job after `failed`      |

## Identity, approval and authorization

| Identity class         | Record                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Portal user            | `app_user` with a `control_session`, signed in through Google OIDC (`control-oidc.ts`)   |
| Support operator       | `control_support_role`: `support_agent` or `support_admin`                               |
| Organisation member    | `service_role_grant`: `owner`, `admin`, `operator` or `viewer`; Pantry owns it (Plan 95) |
| Provider person        | a person bound to a provider account, such as a Slack user                               |
| Automation principal   | a workflow, agent mailbox or WhatsApp support binding                                    |
| Cryptographic approver | a Seams identity with the `person_authz_role` `approve`                                  |

Display names and provider aliases never replace a canonical identity.
Authorization needs three legs. If one leg fails, the operation is denied:

1. Principal: a role, membership, provider or automation binding permits it.
2. Policy: the current snapshot and active grants permit the capability,
   resource, environment, risk and budget.
3. State: the Case, session, connection, action, approval and generation
   permit this exact transition.

### Agent authority

Each turn carries a `RequestAuthority`
([contract](../../packages/contracts/src/types/RequestAuthority.ts)):
`direct_conversation`, `shared_conversation`, `workflow` (also cues),
`agent_mailbox`, `whatsapp_support` or `control`.
`validateLiveRequestAuthority` (`request-authority/index.ts`) checks it
against live membership. `compileTurnAuthority`
(`authorization/access-grants/turn-authority.ts`) selects the active
`AccessGrant` rows for its grant subjects and digests the effective
capabilities into an `AuthorityPartition`. `authorizeCapabilityUse` rechecks
each claim and fails with `capability_not_granted`,
`selected_grants_superseded` or `organisation_policy_superseded`.

Agents may read authorized projections, use accepted tools, submit proposals
and request child work through the Case. Agents cannot widen their authority,
accept shared truth, approve their own action, choose credentials, or bypass
the Case outbox and action ledger. An agent may ask an owner or admin to allow
a capability from `PERMISSION_REQUESTABLE`
(`authorization/requestable-capabilities.ts`). None of these moves money or
writes to a provider.

### Action classes

| Class                 | Examples                                                     | Required path                     |
| --------------------- | ------------------------------------------------------------ | --------------------------------- |
| Read                  | product, order, inventory, integration health                | granted typed capability          |
| Proposal              | draft reply, catalog correction, refund recommendation       | Case proposal acceptance          |
| Notification or draft | operator notice, communication draft                         | Case outbox and Connector receipt |
| Governed effect       | listing, cancellation, price, payout, custom connector write | action ledger and approval        |
| Destructive control   | removal, erasure, root rotation                              | authenticated operator route      |

The notification lane never creates a provider mutation.
`CommerceActionRequest` (`commerce-actions.ts`) binds exact resource
identities and revisions. A changed revision or parameter needs a new action
and a new decision.

### Action ledger

`OrganisationActor` keeps the ledger in its SQLite storage
(`actors/action-ledger.ts`). An entry binds the Case, session, proposal,
`RequestAuthority`, `AuthorityPartition`, IFC flow binding, `ActionAuthority`,
resource key and idempotency key:

```text
proposed -> approval_requested -> signed -> executing
  -> confirmed | failed | indeterminate          (also: rejected, expired)
```

- Execution starts only from `signed`, under a five-minute execution lease.
- The resource key stops conflicting actions on one resource (`resource_busy`).
- A retry keeps the effect identity and returns a known receipt. A different
  receipt fails with `action_receipt_conflict`.
- An unknown outcome stays `indeterminate` until reconciliation. A retry from
  it needs evidence: no provider idempotency record, or an idempotent replay.

### Approval

`ApprovalEvidence` (`approval-authentication.ts`) keeps the principal apart
from the authentication ceremony:

```text
app_user(userId, personId, "owner" | "admin";
         google_oidc_step_up | webauthn_step_up)
| seams_identity(seamsIdentityId, personId, "approve"; seams_nep413)
```

Each ceremony binds Organisation, action nonce, action digest, policy binding
(`unversioned_default`), issue time and expiry. The union is closed. A new
provider needs a reviewed parser and verifier.

Merchant approval uses `google_oidc_step_up` (`control/routes/commerce.ts`),
an owner or admin membership and a sign-in of at most ten minutes. The
ceremony is consumed once. The requesting agent cannot approve. A supplier
payout approver cannot be the proposer of the destination. Rejection
(`merchant_declined`) is a separate terminal branch.

Open: `webauthn_step_up` and `seams_nep413` parse, but no route produces them.

### Budgets and confused-deputy rules

`actors/agent-session-budget.ts` counts tokens, active wall time and capability
calls per run, and claims each capability call before it executes. Code Mode
and executor runs reserve cost first (`actors/code-mode-budget.ts`). A retry
cannot reset or double-spend usage. Cue and scheduled work uses the same
budgets, grants and approvals as work that a person starts.

- Browser and model input cannot supply Organisation or provider authority.
- Provider account and environment come from canonical connection state.
- Tool identity comes from the accepted catalog, not from the call name.
- Credentials resolve only after action and policy authority.
- Approval binds the action digest and cannot authorize a later mutation.

### Audit records

Audit records such as `credential_access_denial`, `person_authz_audit`,
`vault_item_event` and `control_mutation_receipt` hold identities, versions,
decisions, lifecycle, timing, usage and reason codes. They never hold
credentials, ciphertext, nonces, root material, authorization headers,
unrestricted provider bodies, private harness history or sensitive customer
data. Platform code logs through `traceLog` and `traceWarn`
(`observability.ts`).
