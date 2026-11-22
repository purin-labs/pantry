# Plan 12 — Policy-Governed Harness Secrets Vault

Status: implementation complete. Vault lifecycle, recovery, erasure, backup,
and restore are implemented. Future root rotation and disaster recovery follow
the operator runbook instead of remaining plan milestones.
Date: 2026-07-26 · Updated: 2026-08-24
Depends on: [Security architecture: trusted egress (was Spec 2)](../architecture/security.md#trusted-egress),
[Security architecture: Vault and policy (was Spec 6)](../architecture/security.md#vault-policy-and-revocation),
[Security architecture: identity and approval (was Spec 8)](../architecture/security.md#identity-approval-and-authorization),
[Integration architecture: capabilities and tools (was Spec 10)](../architecture/integrations.md#capabilities-and-tools),
[Integration architecture: provider connections (was Spec 12)](../architecture/integrations.md#provider-connections), and
[Vault Operations Runbook](../runbooks/vault-operations.md)

## Goal

Finish Satyr's organisation-scoped secrets vault as the only merchant-credential
source for policy-governed harness traffic.

The harness receives placeholders, scoped tool contracts, and policy-derived
capabilities. Trusted Worker code resolves a credential only after it has
authenticated the session, matched an active organisation policy rule, and confirmed
that the credential generation remains active. Plaintext exists only for the
single trusted operation that needs it.

The implementation closes the security-critical gaps around the Vault
foundation delivered in M4: root-key rotation, exact account and environment
scoping, trusted resolution, revocation, recovery, and erasure. Live rotation
and recovery are event-driven operator procedures owned by the
[Vault Operations Runbook](../runbooks/vault-operations.md). Legacy-source
migration, traffic transition, inherited-runtime removal, and naming cleanup
were completed by [Plan 13](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-13-cloudflare-cutover.md).

## Implementation Scope

Scope narrowed 2026-07-27. The implemented Satyr Vault consists of:

- encrypted organisation-secret storage in D1;
- versioned root-key selection and resumable root rotation;
- policy-, organisation-, account-, environment-, generation-, and purpose-bound
  credential resolution;
- trusted one-request credential injection for harness egress, typed provider
  actions, organisation BYO model routes, and webhook verification;
- authoritative revocation that immediately closes stale grants.

V1 through V3 are implemented apart from the explicitly open deployment
measurements. V4 and V6 remain lifecycle and recovery work and are prerequisites
for the applicable Plan 13 organisation cohorts. V5 execution moved to Plan 13.

The two open V3 measurement items also remain deployment work. They do not
change the fail-closed revocation boundary.

## Ownership and Naming

The product capability is **Satyr Vault**. Its internal bounded context is the
**Credential Vault**, located in `services/platform/src/credential-vault/`. The
trusted component that resolves an opaque credential reference for one
authorized outbound operation is the **Secret Broker**.

Satyr owns the deployable Vault, encrypted persistence, organisation policy,
credential lifecycle, and trusted resolution boundary. A future shared package
may extract backend-neutral envelope or capability primitives after a second
real consumer exists. The Vault remains in this repository and does not expose
private credential records through Lexicon.

## Current Baseline

The repository already contains the core Vault:

- `services/platform/src/credential-vault/` owns the Credential Vault domain,
  keyring, encrypted persistence, resolution, rotation, revocation, backup,
  and alert paths.
- `services/platform/migrations/0001_current_schema.sql` stores ciphertext,
  nonce, key version, and lifecycle timestamps in `vault_secret`, together
  with the `credential_access_denial` receipt table.
- `VAULT_ROOT_V1` and `VAULT_ROOT_V2` supply versioned wrapping keys through
  Cloudflare Secrets Store; `SATYR_VAULT_ACTIVE_KEY_VERSION` selects writes.
- `services/platform/src/policy-snapshot.ts` compiles active credential references
  into versioned organisation egress policy.
- typed provider-action execution (`stripe-action-execution.ts`,
  `shopify-action-execution.ts`) rechecks the exact active rule, account,
  environment, and generation before resolving and injecting a credential.
  The former raw-egress `container.ts` boundary was removed with Plan 13.
  Its unused pinned-capability resolver `harness-resolution.ts` was removed
  on 2026-10-27. A future raw-egress consumer starts from the type model below.
- provider connections already record credential generations and revoke
  superseded generations.
- the M4 live probe proved encrypted store, resolve, revocation, and denial
  against a session pinned to an older policy version.

Future changes extend these paths. They must not introduce a second vault, a
harness-side secret cache, or another credential-policy model.

## Security Invariants

Every phase must preserve these properties:

1. A harness, sandbox process, generated program, tool CLI, Durable Object, and
   session archive can never observe plaintext merchant credentials.
2. D1 contains ciphertext and metadata. A D1-only compromise cannot decrypt a
   organisation secret.
3. Every lookup is organisation-scoped. A caller cannot supply an organisation ID, account
   ID, environment, credential handle, or policy rule that was not derived from
   its authenticated session or trusted provider route.
4. Credential resolution follows authorization. High-stakes actions complete
   typed policy and approval checks before the Vault decrypts anything.
5. Raw harness egress remains deny-by-default. Merchant mutations use typed Tool
   Gateway actions.
6. The injection boundary rechecks authoritative credential state. A pinned
   policy snapshot cannot keep a revoked or replaced rule active.
7. Missing keys, unknown key versions, corrupt ciphertext, stale rule identity,
   policy-load failure, and ambiguous account selection all fail closed.
8. Logs, traces, metrics, receipts, errors, fixtures, and operator responses
   carry identifiers and reason codes only.
9. Rotation and migration are resumable and idempotent. A retry cannot restore
   an obsolete credential generation.
10. Compatibility code may exist only at an import or persistence boundary and
    must carry a deletion condition.

## Target Flow

```text
authenticated organisation session
  -> pinned policy capability
  -> outbound or typed gateway request
  -> active rule/account/environment recheck in D1
  -> revocation and credential-generation check
  -> Vault decrypts with the row's key version
  -> inject into one trusted fetch
  -> discard plaintext
  -> write metadata-only audit receipt
```

Webhook verification uses the same Vault storage with its own narrow trusted
resolver. It derives the organisation, provider account, environment, and active
signing-secret generation from the verified route before decrypting.

## Domain Contracts

Boundary parsers should produce precise internal states before core Vault code
runs:

```ts
type VaultKeyRing = {
  active: VaultRootBinding;
  readable: readonly [VaultRootBinding, ...VaultRootBinding[]];
};

type VaultSecretState =
  | {
      kind: "active";
      organisationId: OrganisationId;
      handle: VaultHandle;
      keyVersion: VaultKeyVersion;
      credentialGeneration: CredentialGeneration;
    }
  | {
      kind: "revoked";
      organisationId: OrganisationId;
      handle: VaultHandle;
      revokedAt: Timestamp;
    };

type HarnessCredentialResolution =
  | {
      kind: "permitted";
      organisationId: OrganisationId;
      sessionId: SessionId;
      integrationAccountId: IntegrationAccountId;
      environment: OrganisationEnvironment;
      ruleId: PolicyRuleId;
      handle: VaultHandle;
    }
  | {
      kind: "denied";
      reason:
        | "policy_denied"
        | "credential_rule_inactive"
        | "credential_generation_inactive"
        | "account_scope_mismatch"
        | "environment_mismatch"
        | "credential_revoked";
    };
```

The final types should use validated branded identities, required fields, and
exhaustive switches. Raw D1 rows, route bodies, environment strings, and
provider payloads stay at their boundaries.

## Phase V0 — Preserve the Completed Foundation

- [x] Store per-organisation ciphertext in D1 with AES-GCM, a random 12-byte nonce,
      and organisation/handle/key-version additional authenticated data.
- [x] Keep the root wrapping key in Cloudflare Secrets Store.
- [x] Reject invalid and stub Vault handles at the production boundary.
- [x] Compile active `credential_ref` rows into versioned policy snapshots.
- [x] Pin policy at session start and recheck the exact active rule before
      injection.
- [x] Revoke both the credential reference and encrypted Vault row.
- [x] Track provider credential generations and revoke superseded generations.
- [x] Prove a mid-session revocation denies the old pinned rule and emits a
      metadata-only denied audit row.

Exit criteria: the existing M4 acceptance evidence stays green throughout all
later phases.

## Phase V1 — Implement Root-Key Rotation

Implemented 2026-07-26:
`services/platform/src/credential-vault/keyring.ts` defines an opaque, validated
`v1 | v2` keyring and exact root-selection failures. The implementation lives
behind the `credential-vault` module boundary, with branded domain inputs
separated from encrypted storage and durable root rotation. Vault encryption
and decryption select their key version through this keyring.

- [x] Replace the single hard-coded `v1` root with a boundary-parsed
      `VaultKeyRing` containing one active write key and a bounded set of
      readable keys.
- [x] Add explicit `VAULT_ROOT_V1` and `VAULT_ROOT_V2` bindings for the first
      rotation plus one required `SATYR_VAULT_ACTIVE_KEY_VERSION` value. Reject
      duplicate versions, a missing active version, empty key material, and
      keys that are not 256 bits.
- [x] Make writes use the active key version and reads select the key from
      `vault_secret.key_version`.
- [x] Add a D1-backed root-rotation job with exhaustive
      `pending | running | paused | completed | failed` state, a stable cursor,
      counts, timestamps, and a typed failure code.
- [x] Add one operator-only bounded rewrap operation. Each step must decrypt
      with the recorded version, encrypt with the active version, verify a
      decrypt, and update the row only if its key version still matches the
      version read.
- [x] Make rewrap retries idempotent. Rows already using the active version
      should advance progress without rewriting ciphertext.
- [x] Expose rotation status as metadata only: job identity, versions, cursor,
      counts, timestamps, and failure reason.
- [x] Update the runbook with start, pause, resume, verify, compromise, and old
      binding removal procedures.
- [x] Add focused tests for mixed-version reads, concurrent organisation-secret
      rotation, interrupted rewrap, corrupt ciphertext, unknown version, and
      removal of an old key while rows still depend on it.
- [x] Run a local full-table rewrap, restart midway, resume it, and verify every
      row resolves under the new active root.

Exit criteria: a `v1 -> v2` rotation completes without downtime or plaintext
output; the old binding cannot be removed while any `v1` row remains.

Evidence 2026-07-26: `credential-vault-root-rotation.test.ts` runs a complete
local SQLite/D1 `v1 -> v2` sweep, pauses and resumes it, reconstructs the D1
client mid-job to simulate a Worker restart, resolves every row with only the
`v2` binding, preserves a concurrent organisation credential update, and exercises
corrupt-ciphertext and active-version failure paths. The operator routes use
the existing authenticated `support_admin` control boundary.

## Phase V2 — Bind Resolution to Policy, Account, and Environment

- [x] Inventory every `resolveVaultHandle` call and classify it as raw egress,
      typed action, model gateway, webhook verification, connector lifecycle,
      or account removal.
- [x] Keep the generic decrypt primitive private to the Vault module. Export
      narrow resolvers whose inputs require the valid state for their use case.
- [x] Compile harness injection rules from the active provider credential
      generation and integration account rather than a loose handle alone.
- [x] Require organisation, integration-account, provider, environment, credential
      generation, handle, and stable rule identity to agree before harness
      injection.
- [x] Require an authenticated session and pinned capability for raw low-stakes
      reads.
- [x] Require an authorized typed action, exact provider account, and approved
      environment before high-stakes Tool Gateway resolution.
- [x] Require an authenticated model route and explicit
      `platform | organisation_byo` key source before model credential resolution.
      Platform model keys remain Worker secrets.
- [x] Require a canonical active webhook binding before resolving a webhook
      verification secret.
- [x] Reject cross-environment reuse, including Stripe test/live and Shopify
      development/production mismatches.
- [x] Add type fixtures that reject missing identity, optional account scope,
      mixed lifecycle branches, broad object spreads, and direct construction
      of permitted resolution state.
- [x] Add behavioral tests for cross-organisation handles, cross-account handles,
      cross-environment rules, forged rule IDs, stale generations, and a
      malicious harness attempting direct Vault access.

Exit criteria: every plaintext materialization starts from a narrow trusted
state; a handle by itself grants no access.

### V2 resolution inventory

| Purpose               | Current entry points                                                                     | Required authority before decrypt                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Raw harness egress    | `container.ts`                                                                           | Authenticated session, pinned rule, stable rule ID, active account/environment/generation                      |
| Typed provider action | `stripe-action-execution.ts`, `shopify-action-execution.ts`                              | Authoritative executing action-ledger entry, exact account, provider, environment, active generation           |
| Provider lifecycle    | `provider-onboarding.ts`, Stripe connector setup                                         | Authenticated control mutation, expected account/environment, staged or active generation                      |
| Webhook verification  | `stripe-connector.ts`, `shopify-connector.ts`, `thread-file-ingress.ts`, Discord ingress | Canonical live webhook/watch/install route and its recorded secret generation                                  |
| Surface delivery      | `surface-binding.ts`, `do/surface.ts`, Slack attachment/status delivery                  | Active canonical installation or thread binding owned by the organisation                                      |
| Account removal       | `data/account-removal.ts`                                                                | Authorized removal lifecycle state and the exact superseded credential set                                     |
| Acceptance probes     | protected M4/E6 routes in `integration-gateway.ts`                                       | Local/fault-injection or organisation-admin probe authorization; delete with the final legacy-source migration |

Platform model credentials remain Worker secrets and do not call Satyr Vault.

Implemented 2026-07-26: typed Stripe and Shopify mutations now derive an opaque
provider-action resolution after a signed or indeterminate action-ledger entry
has entered its authoritative executing state.
The Vault verifies organisation, account, provider, environment, handle, and exact
active credential generation before decrypt and repeats the authoritative
generation check immediately before materialization. Raw harness injection
derives a separate opaque resolution from the unexpired bound session and its
pinned injection rule. Rule identity now includes the active integration
account, provider connection, environment, generation, handle, host, and
injection mode. Policy compilation omits inactive generations, raw merchant
mutations remain denied, and the former raw Stripe write injection rule was
removed. Focused tests cover provider mismatch, cross-organisation account use,
environment drift, forged rules, expired session capability, and generation
changes between authorization and decrypt.

Purpose-specific resolvers now cover provider webhooks, Discord verification,
file-watch verification, surface installations, thread delivery, active
provider connections, and account-removal cleanup. Runtime resolvers and
policy compilation require an active organisation and active onboarding lifecycle;
cleanup remains a separate explicit exception. The public Vault barrel no
longer exposes handle-only plaintext resolution. Focused tests cover stale
generations, forged provider accounts, forged workspaces and guilds, expired
watches, disabled bindings, suspended onboarding and organisations, and cleanup-set
containment.

Typed actions enter the action ledger's authoritative `executing` state before
credential resolution or Shopify token exchange. Raw egress rejects ambiguous
host matches instead of selecting an arbitrary account, and active-rule
authorization compares the canonical injection mode before using the pinned
rule. The sandbox boundary now binds the authenticated session identity,
pinned policy version, and exact injection rule into an opaque capability
before authorization. Behavioral coverage rejects ambiguous account rules and
forged injection modes.

Model gateway session tokens are now v2 and sign the pinned policy version,
model provider, model name, and explicit `platform | organisation_byo` key source.
Platform routes resolve only Worker secrets. Organisation BYO routes resolve only
the signed organisation Vault handle through the narrow model resolver, enforce
provider-specific secret types, and never fall back to platform credentials.
The gateway rejects provider and request-model drift before materialization.
The obsolete `byo` model-route discriminant was replaced by `organisation_byo`
through the canonical Rust contract and regenerated TypeScript binding.
Focused coverage proves OpenAI and Anthropic routing, model/provider mismatch
denial, immediate revocation, missing-handle denial with platform keys present,
and signed-token tamper rejection.

## Phase V3 — Close Revocation and Policy-Propagation Evidence

Implemented 2026-07-26: credential revocation now commits the provider
generation, connection, account, webhooks, credential reference, and Vault row
through one first-primary D1 batch. A durable, metadata-only operation receipt
then advances from `committed` to `policy_activated`. Retries resume the
unfinished state and cannot change its original timestamps or activation
evidence. Restrictions are not pushed to consumers, so activation records zero
consumers; the D1 recheck on every capability claim enforces them. The
3-second target and 5-second alert threshold are explicit in the delivery path.

- [x] Make credential revocation one idempotent lifecycle operation covering
      the active provider generation, `credential_ref`, `vault_secret`, policy
      version, restriction delivery, and audit receipt.
- [x] Preserve the authoritative D1 rule check on every injection so accepted
      stale egress remains zero after revocation commit.
- Multi-PoP timing for benign additive-policy propagation is optional
  observability rather than a Vault completion gate. Authoritative D1 checks
  deny stale restrictions before credential materialization; delayed additive
  policy affects availability only.
- [x] Enforce live restrictions without a Durable Object push. A running
      session's authority partition pins its policy version; every capability
      claim rechecks the current D1 snapshot and fails
      `organisation_policy_superseded` after any newer activation. The next message
      lands on a fresh partition-scoped session.
- [x] Record restriction version, target consumer count, acknowledged count,
      retry count, and latency without recording secret material.
- [x] Adopt a restriction target of 3 seconds p95 with an alert threshold of
      5 seconds. (Adopted 2026-08-18 as
      `RESTRICTION_LATENCY_TARGET_MS`/`RESTRICTION_LATENCY_ALERT_MS` in
      `credential-vault/alerts.ts`; the scheduled sweep alerts on breaches
      and on revocations committed past the threshold.)
- [x] Exercise revoke, host removal, injection-mode change, tool disable, and
      account disable against sessions pinned to an older policy version.
- [x] Add failure tests for D1 unavailability, KV divergence, missed push,
      duplicated delivery, reordered restriction versions, and policy
      corruption. (The push-delivery tests retired with the push;
      `tests/session-policy-supersession.test.ts` covers supersession.)

Exit criteria: every stale grant is denied at the authoritative boundary and
restriction delivery remains observable against the accepted latency budget.

## Phase V4 — Complete the Credential Operator Lifecycle

- [x] Expose metadata-only inventory for provider accounts and credential
      generations: provider, environment, scopes, status, creation, last
      verification, rotation, and revocation timestamps.
      (`GET /v1/control/organisations/:t/credentials`, `data/credential-lifecycle.ts`.)
- [x] Implement create/import, reconnect, rotate, disable, revoke, and delete as
      explicit lifecycle commands. Do not add reveal, copy, download, or export
      operations for plaintext. (Create/import and reconnect via provider
      OAuth; rotate additionally via the supplied-credential
      `credential-rotations` command; revoke via `revoke-credential`, the
      first production caller of the V3 one-batch operation; disable and
      account removal pre-existing. No plaintext read operation exists.)
- [x] Validate a replacement credential with a safe provider read before
      activation. (Stripe account fetch / Shopify shop query through the
      `credential_rotation` `pending_verification -> verified` states.)
- [x] Activate the replacement generation and policy atomically from the
      operator's perspective, then revoke the superseded provider credential.
      (One commit batch supersedes and repoints; `activateProviderCredentialCutover`
      activates policy and revokes superseded rows; interruptions land on the
      scheduled reconciler.)
- [x] Reconcile interrupted rotations so exactly one generation is active and
      every superseded Vault row is revoked.
- [x] Require final-owner protection and the existing control identity for
      destructive credential operations. (Revoking the active primary
      requires a validated replacement account, mirroring disable; all
      lifecycle commands run behind the authenticated admin control-mutation
      boundary with idempotent receipts.)
- [x] Add stable audit receipts for store, validation, activation, rotation,
      revocation, deletion, denied resolution, and root rewrap.
      (`external_vault_import` and OAuth receipts for store;
      `credential_rotation` states for validation/activation/rotation;
      `credential_revocation_operation` plus `provider.credential.*`
      onboarding audit events; account tombstones for deletion;
      `credential_access_denial` for denied resolution;
      `vault_root_rotation_job` for rewrap.)
- [x] Add dashboard and alert signals for resolve failures, corrupt rows,
      unknown key versions, stale generations, delayed restrictions, failed
      rotations, and unexpected secret-access purposes.
      (`sweepVaultAlertSignals` on the reconciliation cron emits
      `vault.alert.*`; denials emit `vault.resolution_denied` with a purpose
      label. Signals surface through Workers Logs; corrupt-row detection
      remains covered by the retained-root closure inspection.)
- [x] Update the portal onboarding and connection-repair projections to show
      lifecycle state and recovery actions without accepting secret values in
      ordinary page rendering. (The integrations page renders the
      generation-level credential lifecycle disclosure with rotate and
      revoke recovery actions; the rotate form is a dedicated
      secret-accepting command that clears its value before the request
      departs and bypasses the sessionStorage idempotency fingerprint.)

Exit criteria: an operator can manage the full credential lifecycle through
typed controls, every interruption has one deterministic recovery path, and no
operator response reveals secret material.

## Phase V5 — Legacy-Source Cutover

Production cutover moved to
[Plan 13](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-13-cloudflare-cutover.md#direct-operating-path).
Plan 13 owns preparation, activation, rollback, the production canary, and the
one-time closure audit. This plan remains authoritative for Vault lifecycle and
resolution invariants.

## Phase V6 — Recovery, Erasure, and Closure

- [x] Include encrypted Vault rows and rotation-job metadata in backup and
      restore coverage while keeping root keys outside D1 and R2 archives.
      (`credential-vault/backup.ts`: digest-sealed envelope over
      `vault_secret`, `vault_root_rotation_job`, `credential_ref`, and
      `credential_revocation_operation`; the export path cannot read key
      bindings.)
- [x] Make restore fail closed when any referenced key version is unavailable.
      (Import rejects before writing anything; covered alongside the
      resolution-layer fail-closed tests.)
- [x] Define organisation erasure ordering: disable policy, revoke provider
      credentials, stop sessions and webhooks, delete Vault rows and references,
      then remove retained organisation data according to the erasure policy.
      (Archive deletes the latest policy pointer and disables accounts and
      webhooks; provider cleanup revokes generations, connections, and Vault
      rows; the purge batch deletes Vault rows and references before
      retained data while durable receipts survive — the archived-organisation
      purge test in `tests/onboarding-reconciliation.test.ts` pins the
      contract.)
- [x] Run a malicious-harness acceptance probe that searches process env,
      files, responses, tool output, errors, logs, and session archives for
      seeded canary secrets. (Local acceptance: `vault-canary-probe.test.ts`
      sweeps results, console output, every durable row, error paths, and
      process env across all fourteen vault entry points.)
- [x] Run cross-organisation and cross-account isolation probes with concurrent
      live sessions. (Local acceptance: thirty-two interleaved concurrent
      resolutions across two organisations with every forgery denied.)
- [x] Confirm metrics and audit receipts contain identifiers, versions, status,
      and timing only. (Canary probes assert store receipts, denial results,
      and durable rows are secret-free; the inventory route test asserts no
      ciphertext or nonce material in responses; alert traces carry counts
      and codes only.)

Production rotation and disaster recovery do not create standing Plan 12 work.
Before the first live root rewrap or clean-account restore, rehearse the exact
runbook once in an isolated Cloudflare environment with a disposable credential:
restore the required roots, rewrap the canary row, revoke it during an active
session, perform one safe read, and verify that no plaintext entered durable or
operator-visible surfaces. Root removal remains conditional on the runbook's
zero-dependent-row check.

Exit criteria: the implemented lifecycle fails closed, preserves organisation and
account isolation, and exposes only metadata through operator surfaces. These
criteria are covered by the focused behavioral tests and the runbook-owned
canary used when a live rotation or restore is actually required.

## Operating rule

Use the [Vault Operations Runbook](../runbooks/vault-operations.md) for credential
compromise, root rotation, or recovery. Plan 12 has no standing rollout,
measurement, evidence-packet, or compatibility-cleanup backlog.
