---
title: Vault API reference
description: The Purin Vault public API, handle format, external import boundary, and credential migration procedure.
---

# Vault API reference

Purin Vault is the organisation credential store for the Cloudflare runtime. It
encrypts credential values with AES-256-GCM, stores ciphertext and lifecycle
metadata in D1, and loads versioned root keys from Cloudflare Secrets Store.
Ciphertext is bound to the organisation, the handle, and the key version.

The Vault supports bearer tokens, named header values, OAuth client
credentials, and website logins. Handles have the form `vault:<name>` and are
scoped by organisation.

A Vault item (Plan 79) is a website login or a contact profile that people
manage on Settings → Vault. Its record lives in `vault_item`. A login's
username and password are one `website_login` secret with a new handle for
each generation, for example `vault:website_login:<item>:generation_2`.
A new credential generation receives a new handle, for example
`vault:stripe:merchant_42:generation_7`.

Operator procedures live in [Vault operations](/operate/vault) and the
repository runbook `docs/runbooks/vault-operations.md`.

## Public API

The public exports live in `foundation/authority/credential-vault/index.ts`.

| Operation                             | API                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| Validate a handle                     | `parseVaultHandle`                                                                    |
| Store encrypted material              | `storeVaultSecret`                                                                    |
| Verify a write                        | `verifyStoredVaultSecret`                                                             |
| Authorize a provider action           | `authorizeProviderActionResolution`                                                   |
| Resolve an authorized provider action | `resolveProviderActionCredential`                                                     |
| Resolve other purposes                | webhook, delivery, installation, connection, and account-removal resolvers            |
| Revoke a credential lifecycle         | `revokeCredential`                                                                    |
| Import from an external vault         | `importExternalVaultSecret`                                                           |
| Create a 1Password importer           | `createOnePasswordAdapter`                                                            |
| List, add, change, or remove items    | `listVaultItems`, `createVaultItem`, `commandVaultItem`                               |
| Rotate encryption roots               | `startVaultRootRotation`, `runVaultRootRotationStep`, `vaultRootVersionRemovalStatus` |

There is no public generic resolve function. Runtime consumers use the
resolver for their exact purpose.

All recoverable operations return a discriminated result:

```ts [Protocol sketch]
type Result<Value, Error> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Error };
```

## Store

Parse raw identifiers at the request boundary, then pass branded values to the
Vault:

```ts [Partial example]
const parsedHandle = parseVaultHandle("vault:stripe:merchant_42:generation_7");

if (!parsedHandle.ok) {
  return parsedHandle;
}

const stored = await storeVaultSecret({
  db: env.DB,
  keys: env,
  organisationId,
  handle: parsedHandle.value,
  secret: { kind: "bearer", value: providerToken },
  now: Date.now(),
});

if (!stored.ok) {
  return stored;
}

const verified = await verifyStoredVaultSecret({
  db: env.DB,
  keys: env,
  stored: stored.value,
  expected: { kind: "bearer", value: providerToken },
});
```

## Resolve

A provider action must already be in the executing state. Authorization binds
the action to its organisation, account, provider, environment, active generation,
and Vault handle. Resolution rechecks that the generation remains active:

```ts [Partial example]
const authorization = await authorizeProviderActionResolution({
  db: env.DB,
  action: executingAction,
  expectedProvider: "stripe",
});

if (!authorization.ok) {
  return authorization;
}

const credential = await resolveProviderActionCredential({
  db: env.DB,
  keys: env,
  authorization: authorization.value,
});

if (!credential.ok) {
  return credential;
}

await performApprovedStripeAction(credential.value);
```

Use the harness resolver for an authorized harness capability. Organisation
ChatGPT sign-in profiles are resolved by the organisation ChatGPT connection boundary. Webhook,
delivery, installation, connection, and account-removal operations use their
corresponding purpose-specific resolvers.

## Revoke

Use `revokeCredential` for an active credential. It revokes the Vault row and
the linked provider generations, connections, accounts, webhooks, and
credential references. `revokeVaultSecret` is reserved for cleanup after the
surrounding domain lifecycle is already authoritative.

Resolution of a revoked row returns `vault_secret_revoked`.

```ts [Partial example]
const receipt = await revokeCredential({
  db: env.DB,
  organisationId,
  handle: previousHandle,
  now: Date.now(),
});
```

The full rotation, revocation, and root-key rotation procedures are in
`docs/runbooks/vault-operations.md`.

## 1Password as the item store

An Organisation can keep its Vault items in one 1Password vault instead of
Purin Vault (Plan 79). An owner or admin connects a 1Password service account
on Settings → Vault; Pantry stores the token as a `bearer` row and nothing else
from 1Password. The Platform sends each item operation to the 1Password store
Worker through the `VAULT_ONEPASSWORD` binding, and the Worker runs it with the
1Password SDK. `listVaultStoreItems`, `createVaultStoreItem`,
`commandVaultStoreItem`, `connectOnePassword`, `disconnectOnePassword` and
`moveVaultItems` choose the store; callers do not.

## Import from 1Password

1Password Connect is a trusted import boundary. The adapter reads one field,
validates it, stores it in Purin Vault, and records a metadata receipt.

```ts [Partial example]
const adapter = createOnePasswordAdapter({
  config: {
    origin: onePasswordConnectOrigin,
    token: onePasswordConnectToken,
  },
  locator: {
    vaultId,
    itemId,
    fieldId,
  },
  fetcher: fetch,
});

const imported = await importExternalVaultSecret({
  db: env.DB,
  keys: env,
  organisationId,
  handle,
  adapter,
  validate: validateWithSafeProviderRead,
  now: Date.now(),
});
```

The same source revision is idempotent. A changed revision requires a new
generation handle. An authenticated archived item revokes its imported Vault
row. Provider requests continue to use Purin Vault after import. An
interrupted import is recovered by retrying the same source revision.

Other vault products can implement the small `ExternalVaultAdapter` interface:

```ts [Protocol sketch]
type ExternalVaultAdapter = {
  readonly source: ExternalVaultSource;
  read(): Promise<Result<ExternalVaultRead, ExternalVaultReadError>>;
};
```

## Credential migration

For each active organisation credential:

1. Record organisation, provider account, environment, purpose, source, destination
   handle, consumer, and a safe verification operation.
2. Allocate a unique generation handle.
3. Read the source once inside the trusted import boundary.
4. Normalize and validate the credential.
5. Store and verify it in Purin Vault.
6. Activate the new provider generation and policy.
7. Perform one safe provider read through its purpose resolver.
8. Revoke the old Vault generation and source credential.
9. Retain a metadata-only migration receipt.
