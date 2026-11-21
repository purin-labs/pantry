# Seams Vault Operations

Status: Active operator runbook
Last reviewed: 2026-08-03

Seams Vault stores organisation provider credentials and organisation-owned model keys as
encrypted D1 records. Cloudflare Secrets Store holds the versioned root keys.
Trusted platform code resolves a credential only after checking its exact
organisation, provider account, environment, generation, purpose, and current policy
authority.

The security contract lives in
[Security architecture: Vault and policy (was Spec 6)](../architecture/security.md#vault-policy-and-revocation). [Plan 12](../plan-12-policy-governed-harness-secrets-vault.md)
records the implementation architecture and remaining lifecycle work. This
runbook covers the operating procedures supported by the current platform.

The Plan 13 migration from inherited credential sources and its one-time
closure audit are complete. Their dated evidence remains under `docs/evidence/`.
They are not routine Vault operations.

## Key separation

| Binding                          | Authority                | Purpose                                                                      |
| -------------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `DB`                             | D1                       | Vault ciphertext, credential generations, rotation jobs, and policy metadata |
| `VAULT_ROOT_V1`                  | Cloudflare Secrets Store | Readable Vault root version `v1`                                             |
| `VAULT_ROOT_V2`                  | Cloudflare Secrets Store | Readable Vault root version `v2`                                             |
| `PANTRY_VAULT_ACTIVE_KEY_VERSION` | Worker variable          | Selects `v1` or `v2` for new Vault writes                                    |
| `DATA_ENCRYPTION_ROOT`           | Cloudflare Secrets Store | Protects Actor archives, checkpoints, and other encrypted platform state     |

Every root is an independently generated 32-byte value stored as base64.
Vault roots and `DATA_ENCRYPTION_ROOT` must remain distinct. Secret values must
never enter Wrangler configuration, `.dev.vars`, shell history, D1, logs,
traces, support output, evidence, or source control.

The checked-in Wrangler configuration names the production bindings. Changes
to store IDs, secret names, database IDs, or the active Vault version are
deployment changes and require review.

## Deployment and provisioning

Apply production D1 migrations explicitly before deploying a Worker that
depends on them:

```bash
pnpm --filter @purin-labs/platform exec wrangler d1 migrations apply pantry --remote
pnpm --filter @purin-labs/platform run deploy
```

Local development uses the repository command:

```bash
pnpm --filter @purin-labs/platform d1:migrate:local
```

The Vault boundary rejects an unknown active version, a missing active binding,
an unavailable Secrets Store value, invalid base64, and decoded key material
whose length is not 32 bytes.

### Provisioning check

1. Confirm D1 migrations are current in the target environment.
2. Confirm every configured Secrets Store binding resolves.
3. Create a disposable provider credential and organisation generation through the
   normal control plane.
4. Confirm its metadata records `PANTRY_VAULT_ACTIVE_KEY_VERSION`.
5. Perform one non-mutating provider read through its purpose-specific
   resolver.
6. Revoke the disposable credential through the credential lifecycle.
7. Confirm subsequent resolution fails with `vault_secret_revoked`.
8. Revoke or delete the disposable credential at the provider.

Never verify the Vault through a route that returns plaintext.

## Organisation credential lifecycle

Use the portal and its authenticated control plane for provider connection
setup, reconnect, rotation, disable, and revocation. A replacement credential
always creates a new generation and encrypted Vault payload.

### Inspect the credential inventory

`GET /v1/control/organisations/{organisation_id}/credentials` returns the metadata-only
inventory: every integration account with its connection lifecycle, every
credential generation with lifecycle timestamps and failure codes, the Vault
row status and key version, webhook verification recency, rotation receipts,
and revocation receipts. No response field ever carries ciphertext, nonces,
or key material.

### Rotate a credential

For Stripe and Shopify api-key connections, one typed command performs the
validated rotation:

```text
POST /v1/control/organisations/{organisation_id}/accounts/{integration_account_id}/credential-rotations
{"replacementSecret":"<replacement credential>"}
```

The command records a durable `credential_rotation` state
(`pending_verification -> verified -> committed`, or `failed` with a typed
reason), validates the replacement with a non-mutating provider read
(Stripe account fetch, Shopify shop query) against the connected identity
and environment, stores it as a new staged generation, supersedes and
repoints atomically, then activates the replacement policy. An interrupted
rotation is finished by the scheduled reconciler. A failed rotation is
terminal evidence; retry with a new idempotency key after correcting the
replacement. OAuth-mode connections rotate through the existing reconnect
flow instead.

The equivalent manual procedure, for providers without the typed command:

1. Create the replacement credential at the provider.
2. Validate it with a provider read that cannot mutate merchant state.
3. Store it as a new generation through the provider connection lifecycle.
4. Activate the replacement generation and its organisation policy.
5. Perform one safe request through the active resolver.
6. Revoke the superseded Vault generation.
7. Revoke the superseded credential at the provider.

Stop if the provider integration does not expose a typed replacement lifecycle
or cannot validate the replacement before activation. Do not insert ciphertext
or modify generation rows manually.

### Revoke a credential

```text
POST /v1/control/organisations/{organisation_id}/accounts/{integration_account_id}/revoke-credential
{"replacementIntegrationAccountId":"<required when revoking the active primary>"}
```

The command derives the Vault handle server-side, refuses to leave a
provider without a usable primary account (final-owner protection mirrors
account disable), commits the one-batch teardown across the generation,
connection, account, webhooks, credential reference, and Vault row, then
activates the restricted policy and finalizes the
`credential_revocation_operation` receipt with restriction evidence. The
response carries metadata only. Afterward revoke the credential at the
provider itself.

### Operational alert signals

The scheduled reconciler sweeps Vault alert signals every run and emits
`vault.alert.*` traces for: active rows under an unreadable key version,
superseded generations older than one hour, rotations stuck before commit,
failed rotations, revocations committed but not policy-activated within the
5-second alert threshold, and restriction-latency breaches. Denied
resolutions write metadata-only `credential_access_denial` receipts and
`vault.resolution_denied` traces. The delivery-path budget is explicit in
code: 3 seconds p95 target, 5 seconds alert.

### Respond to suspected credential compromise

Revoke first. The authoritative credential revocation closes the Vault row,
provider generation, connection, account, webhook bindings, credential
references, and stale policy grants. Create and validate a clean provider
credential afterward.

`revokeVaultSecret` marks one ciphertext row revoked. It is an internal cleanup
primitive and does not replace the surrounding provider credential lifecycle.

## Vault root-key rotation

Root rotation rewraps existing Vault ciphertext. It does not rotate provider
credentials or `DATA_ENCRYPTION_ROOT`.

The current keyring supports `v1` and `v2`. The procedure below describes a
`v1` to `v2` rotation. A future version beyond `v2` requires a keyring contract
change before an operator begins rotation.

### Prepare the target root

1. Generate 32 random bytes for `vault-root-v2` and store their base64 value in
   Cloudflare Secrets Store.
2. Deploy with `VAULT_ROOT_V1` and `VAULT_ROOT_V2` readable while
   `PANTRY_VAULT_ACTIVE_KEY_VERSION` remains `v1`.
3. Resolve existing credentials and confirm a newly stored canary generation
   records `key_version = 'v1'`.
4. Change `PANTRY_VAULT_ACTIVE_KEY_VERSION` to `v2` and deploy.
5. Confirm a new canary records `v2` and both canaries resolve.

The target must be active before the root-rotation job starts. Do not remove
the source binding during rewrap.

### Start the rotation

The root-rotation control routes require an authenticated `support_admin`
portal session. Mutations also require the normal Origin and CSRF checks.

```text
POST /v1/control/operator/vault/root-rotations
{"sourceVersion":"v1"}
```

Only one `pending`, `running`, or `paused` job may exist. The response contains
metadata only: rotation ID, source and target versions, lifecycle, cursor,
counts, and timestamps.

### Run bounded steps

```text
POST /v1/control/operator/vault/root-rotations/{rotation_id}/step
{"limit":50}
```

The limit must be an integer from 1 through 100. Each row is decrypted with its
recorded source version, encrypted under the active target with a fresh AES-GCM
nonce, decrypted again for verification, and updated only when its key version,
nonce, and ciphertext still match the values read.

A concurrent credential update that already uses the target version is
preserved and counted as skipped. Replaying a completed batch does not rewrite
target-version ciphertext.

### Pause, resume, and inspect

```text
POST /v1/control/operator/vault/root-rotations/{rotation_id}/pause
{}

POST /v1/control/operator/vault/root-rotations/{rotation_id}/resume
{}

GET /v1/control/operator/vault/root-rotations/{rotation_id}
```

The cursor and counts are durable in D1. Continue the same job after a Worker
restart. A failed job remains immutable evidence; correct its cause and start a
new rotation.

| Failure code                 | Operator response                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `active_key_version_changed` | Restore the intended active target version before creating another job.                               |
| `source_root_unavailable`    | Restore the exact source binding and key material.                                                    |
| `target_root_unavailable`    | Restore the target binding and verify its material.                                                   |
| `ciphertext_invalid`         | Stop and investigate the relevant D1 backup interval. Never replace the row with an empty credential. |
| `verification_failed`        | Stop and investigate the WebCrypto/runtime boundary.                                                  |
| `persistence_conflict`       | Inspect concurrent writers and persisted job state.                                                   |

### Verify and remove the source root

1. Require the completed job to report
   `processedCount = sourceRowCount`.
2. Inspect `GET /v1/admin/vault-root-closure` through the authenticated admin
   boundary and require zero rows dependent on `v1`.
3. Resolve safe provider reads with a deployment exposing only
   `VAULT_ROOT_V2`.
4. Confirm no plaintext appears in logs, traces, D1, archives, Actor history,
   or operator responses.
5. Remove `VAULT_ROOT_V1` from the Worker configuration and deploy.
6. Repeat the safe provider reads and retained-root inspection.

Do not remove the source root when any dependent row remains or the retained
root inspection cannot complete.

## Recovery

### Secrets Store binding unavailable

Restore the binding and exact key material for each row's recorded key version.
Reads fail closed while a required root is unavailable. Do not change the
active version or overwrite ciphertext to conceal the outage.

### Incorrect or corrupt root material

Stop writes using the affected version. Restore the known root and verify
canary resolution. If it cannot be recovered, rotate every dependent provider
credential, store the replacements as new generations, and revoke the
unrecoverable rows through the credential lifecycle.

### D1 loss or ciphertext corruption

Restore D1 from the approved backup point and restore every root version
required by those rows. Inspect retained root dependencies and perform one safe
read for each active credential class before returning traffic. Rotate
credentials whose state after the recovery point cannot be reconciled.

Never replace corrupt ciphertext with an empty value or mark an unverified
generation active.

### Interrupted root rotation

Resume a `paused` or `running` job using its existing rotation ID. A failed job
cannot resume; correct the typed failure and start a new job. Keep both root
bindings readable until retained-root inspection reports that the source is no
longer required.

## Root compromise

A ciphertext rewrap cannot invalidate provider credentials that may have been
exposed.

1. Disable affected policy rules and credential generations.
2. Revoke or rotate provider credentials.
3. Provision a clean target root and make it active.
4. Run bounded rewrap steps for recoverable rows.
5. Replace credentials whose ciphertext cannot be recovered.
6. Remove the compromised root only after every dependent row is gone.
7. Preserve metadata-only incident and rotation receipts.

## Completion checklist

- Existing and new canary generations resolve before rewrap.
- New writes use the active target root.
- Rewrap survives pause, resume, retry, and Worker restart.
- Concurrent credential changes remain intact.
- Corrupt ciphertext fails closed.
- Every retained row resolves with only the target binding.
- The source root is absent only after dependency count reaches zero.
- Credential revocation denies sessions holding an older policy snapshot.
- No plaintext secret appears in durable or untrusted surfaces.
