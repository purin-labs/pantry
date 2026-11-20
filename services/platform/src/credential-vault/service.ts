import type { OrganisationDatabase } from "../database-handles";
import type { OrganisationId } from "../ids";
import { isOrganisationExecutionActive } from "../actors/actor-execution-quiescence";
import {
  organisationPlacementPredicate,
  type OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import type { SessionExecutionAdmission } from "../actors/session-execution-admission";
import type { Result } from "../result";
import {
  activeVaultRoot,
  loadCredentialVaultKeyRing,
  vaultRootForVersion,
  type CredentialVaultBindings,
  type VaultKeyRingError,
  type VaultKeyVersion,
} from "./keyring";
import {
  isVaultOpaqueProfileFormat,
  type VaultHandle,
  type VaultOpaqueProfileFormat,
  type VaultResolveError,
  type VaultSecret,
  type VaultStoredSecret,
  type VaultStoreError,
} from "./domain";
import {
  decryptVaultPayload,
  encryptVaultPayload,
  type VaultCiphertext,
} from "./crypto";
import type { OrganisationQuerySource } from "../data/query-source";
import {
  prepareCredentialHandleAccountsRevocation,
  prepareCredentialHandleWebhooksRevocation,
} from "../data/integration-account-writes";
import { prepareCredentialHandleConnectionsRevocation } from "../data/provider-connection-writes";
import { prepareCredentialHandleGenerationsRevocation } from "../data/provider-credential-generation";
import { assertNever, isNonNegativeInteger, isRecord } from "@purin-labs/std";

type VaultAlgorithm = "AES-GCM-256";

export type VaultSecretRow = {
  vaultHandle: string;
  keyVersion: string;
  algorithm: string;
  nonceB64: string;
  ciphertextB64: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
};

type VaultPlaintextPayload =
  | { kind: "bearer"; value: string; header: null }
  | { kind: "expiring_bearer"; value: string; expiresAt: number }
  | { kind: "header"; value: string; header: string }
  | {
      kind: "opaque_profile";
      format: VaultOpaqueProfileFormat;
      value: string;
    }
  | {
      kind: "oauth_tokens";
      accessToken: string;
      refreshToken: string;
      expiryKind: "expires" | "provider_managed";
      expiresAt: number | null;
    }
  | {
      kind: "oauth_client_credentials";
      clientId: string;
      clientSecret: string;
    }
  | { kind: "website_login"; username: string; password: string };

type CredentialRevocationBase = {
  readonly revocationId: string;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly credentialGenerationCount: number;
  readonly providerConnectionCount: number;
  readonly integrationAccountCount: number;
  readonly providerWebhookCount: number;
  readonly credentialRefCount: number;
  readonly vaultSecretCount: number;
  readonly startedAt: number;
  readonly committedAt: number;
};

export type CredentialRevocationCommit = CredentialRevocationBase & {
  readonly state: "committed";
  readonly policyVersion?: never;
  readonly restrictionVersion?: never;
  readonly targetConsumerCount?: never;
  readonly acknowledgedConsumerCount?: never;
  readonly pendingConsumerCount?: never;
  readonly retryCount?: never;
  readonly restrictionLatencyMs?: never;
  readonly policyActivatedAt?: never;
};

export type CredentialRevocationPolicyActivation = CredentialRevocationBase & {
  readonly state: "policy_activated";
  readonly policyVersion: number;
  readonly restrictionVersion: number;
  readonly targetConsumerCount: number;
  readonly acknowledgedConsumerCount: number;
  readonly pendingConsumerCount: number;
  readonly retryCount: number;
  readonly restrictionLatencyMs: number;
  readonly policyActivatedAt: number;
};

export type CredentialRevocationReceipt =
  CredentialRevocationCommit | CredentialRevocationPolicyActivation;

type CredentialRevocationReceiptRow = {
  readonly revocationId: unknown;
  readonly state: unknown;
  readonly credentialGenerationCount: unknown;
  readonly providerConnectionCount: unknown;
  readonly integrationAccountCount: unknown;
  readonly providerWebhookCount: unknown;
  readonly credentialRefCount: unknown;
  readonly vaultSecretCount: unknown;
  readonly policyVersion: unknown;
  readonly restrictionVersion: unknown;
  readonly targetConsumerCount: unknown;
  readonly acknowledgedConsumerCount: unknown;
  readonly pendingConsumerCount: unknown;
  readonly retryCount: unknown;
  readonly restrictionLatencyMs: unknown;
  readonly startedAt: unknown;
  readonly committedAt: unknown;
  readonly policyActivatedAt: unknown;
};

const VAULT_ALGORITHM: VaultAlgorithm = "AES-GCM-256";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type VaultStoreInput = {
  db: OrganisationDatabase;
  keys: CredentialVaultBindings;
  organisationId: OrganisationId;
  handle: VaultHandle;
  secret: VaultSecret;
  now: number;
};

type PreparedVaultSecret = Readonly<{
  keyVersion: VaultKeyVersion;
  encrypted: VaultCiphertext;
}>;

export async function storeVaultSecret(
  input: VaultStoreInput,
): Promise<Result<VaultStoredSecret, VaultStoreError>> {
  const prepared = await prepareVaultSecret(input);
  if (!prepared.ok) return prepared;
  return writeVaultSecret(input, prepared.value, { sql: "1", bindings: [] });
}

export async function storeOrganisationExecutionVaultSecret(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    sql: SqlStorage;
    keys: CredentialVaultBindings;
    handle: VaultHandle;
    secret: VaultSecret;
    now: number;
  }>,
): Promise<
  Result<
    VaultStoredSecret,
    VaultStoreError | { readonly code: "organisation_placement_conflict" }
  >
> {
  const store = {
    db: input.scope.database,
    keys: input.keys,
    organisationId: input.scope.organisationId,
    handle: input.handle,
    secret: input.secret,
    now: input.now,
  };
  const prepared = await prepareVaultSecret(store);
  if (!prepared.ok) return prepared;
  if (!(await isOrganisationExecutionActive(input.sql, input.scope)))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const stored = await writeVaultSecret(
    store,
    prepared.value,
    organisationPlacementPredicate(input.scope),
  );
  if (!stored.ok && !(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  return stored;
}

export async function storeOrganisationPlacementVaultSecret(
  input: Readonly<{
    scope: OrganisationExecutionScope;
    keys: CredentialVaultBindings;
    handle: VaultHandle;
    secret: VaultSecret;
    now: number;
  }>,
): Promise<Result<VaultStoredSecret, VaultStoreError>> {
  const store = {
    db: input.scope.database,
    keys: input.keys,
    organisationId: input.scope.organisationId,
    handle: input.handle,
    secret: input.secret,
    now: input.now,
  };
  const prepared = await prepareVaultSecret(store);
  if (!prepared.ok) return prepared;
  return writeVaultSecret(
    store,
    prepared.value,
    organisationPlacementPredicate(input.scope),
  );
}

export async function storeSessionExecutionVaultSecret(
  input: Readonly<{
    admission: SessionExecutionAdmission;
    lease: HarnessTurnLease;
    keys: CredentialVaultBindings;
    handle: VaultHandle;
    secret: VaultSecret;
    now: number;
  }>,
): Promise<Result<VaultStoredSecret, VaultStoreError>> {
  await input.admission.requireTurn(input.lease);
  const scope = input.admission.scope;
  const store = {
    db: scope.database,
    organisationId: scope.organisationId,
    keys: input.keys,
    handle: input.handle,
    secret: input.secret,
    now: input.now,
  };
  const prepared = await prepareVaultSecret(store);
  if (!prepared.ok) return prepared;
  await input.admission.requireTurn(input.lease);
  return writeVaultSecret(
    store,
    prepared.value,
    organisationPlacementPredicate(scope),
  );
}

async function prepareVaultSecret(
  input: Pick<VaultStoreInput, "keys" | "organisationId" | "handle" | "secret">,
): Promise<Result<PreparedVaultSecret, VaultStoreError>> {
  const keyRing = await loadCredentialVaultKeyRing(input.keys);

  if (!keyRing.ok) {
    return vaultKeyRingStoreError(keyRing.error);
  }

  const activeRoot = activeVaultRoot(keyRing.value);
  const plaintext = serializeVaultSecret(input.secret);
  const encrypted = await encryptVaultPayload({
    key: activeRoot.key,
    organisationId: input.organisationId,
    handle: input.handle,
    keyVersion: activeRoot.version,
    plaintext,
  });

  const verified = await verifyVaultCandidate({
    key: activeRoot.key,
    organisationId: input.organisationId,
    handle: input.handle,
    keyVersion: activeRoot.version,
    encrypted,
    expected: input.secret,
  });

  if (!verified) {
    return { ok: false, error: { code: "vault_candidate_unverifiable" } };
  }

  return { ok: true, value: { keyVersion: activeRoot.version, encrypted } };
}

async function writeVaultSecret(
  input: Pick<VaultStoreInput, "db" | "organisationId" | "handle" | "now">,
  prepared: PreparedVaultSecret,
  predicate: Readonly<{ sql: string; bindings: readonly (string | number)[] }>,
): Promise<Result<VaultStoredSecret, VaultStoreError>> {
  const result = await input.db
    .prepare(
      `INSERT INTO vault_secret (
         organisation_id,
         vault_handle,
         key_version,
         algorithm,
         nonce_b64,
         ciphertext_b64,
         created_at,
         rotated_at,
         revoked_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL WHERE ${predicate.sql}
       ON CONFLICT (organisation_id, vault_handle) DO UPDATE SET
         key_version = excluded.key_version,
         algorithm = excluded.algorithm,
         nonce_b64 = excluded.nonce_b64,
         ciphertext_b64 = excluded.ciphertext_b64,
         rotated_at = excluded.created_at,
         revoked_at = NULL
       WHERE vault_secret.revoked_at IS NULL`,
    )
    .bind(
      input.organisationId,
      input.handle,
      prepared.keyVersion,
      VAULT_ALGORITHM,
      prepared.encrypted.nonceB64,
      prepared.encrypted.ciphertextB64,
      input.now,
      ...predicate.bindings,
    )
    .run();

  if (result.meta.changes !== 1) {
    return { ok: false, error: { code: "vault_secret_revoked" } };
  }

  return {
    ok: true,
    value: {
      organisationId: input.organisationId,
      handle: input.handle,
      keyVersion: prepared.keyVersion,
      createdAt: input.now,
    },
  };
}

export async function resolveVaultHandle(input: {
  db: OrganisationQuerySource;
  keys: CredentialVaultBindings;
  organisationId: OrganisationId;
  handle: VaultHandle;
}): Promise<Result<VaultSecret, VaultResolveError>> {
  const row = await readVaultSecretRow(
    input.db,
    input.organisationId,
    input.handle,
  );

  if (row === null) {
    return {
      ok: false,
      error: { code: "vault_handle_unknown", handle: input.handle },
    };
  }

  return resolveVaultSecretRow({
    keys: input.keys,
    organisationId: input.organisationId,
    handle: input.handle,
    row,
  });
}

export async function resolveVaultSecretRow(input: {
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly row: VaultSecretRow;
}): Promise<Result<VaultSecret, VaultResolveError>> {
  const row = input.row;

  if (row.revokedAt !== null) {
    return {
      ok: false,
      error: { code: "vault_secret_revoked", handle: input.handle },
    };
  }

  if (row.algorithm !== VAULT_ALGORITHM) {
    return {
      ok: false,
      error: { code: "vault_ciphertext_invalid", handle: input.handle },
    };
  }

  const keyRing = await loadCredentialVaultKeyRing(input.keys);

  if (!keyRing.ok) {
    return vaultKeyRingResolveError(keyRing.error);
  }

  const selectedRoot = vaultRootForVersion(keyRing.value, row.keyVersion);

  if (!selectedRoot.ok) {
    return vaultRootSelectionResolveError(selectedRoot.error, input.handle);
  }

  const decrypted = await decryptVaultPayload({
    key: selectedRoot.value.key,
    organisationId: input.organisationId,
    handle: input.handle,
    keyVersion: selectedRoot.value.version,
    nonceB64: row.nonceB64,
    ciphertextB64: row.ciphertextB64,
  });

  if (!decrypted.ok) {
    return {
      ok: false,
      error: { code: "vault_ciphertext_invalid", handle: input.handle },
    };
  }

  const parsed = parseVaultPlaintext(decrypted.value, input.handle);

  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, value: parsed.value };
}

async function verifyVaultCandidate(input: {
  readonly key: CryptoKey;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
  readonly keyVersion: VaultKeyVersion;
  readonly encrypted: {
    readonly nonceB64: string;
    readonly ciphertextB64: string;
  };
  readonly expected: VaultSecret;
}): Promise<boolean> {
  const decrypted = await decryptVaultPayload({
    key: input.key,
    organisationId: input.organisationId,
    handle: input.handle,
    keyVersion: input.keyVersion,
    nonceB64: input.encrypted.nonceB64,
    ciphertextB64: input.encrypted.ciphertextB64,
  });

  if (!decrypted.ok) {
    return false;
  }

  const parsed = parseVaultPlaintext(decrypted.value, input.handle);

  return parsed.ok && vaultSecretsEqual(parsed.value, input.expected);
}

export async function verifyStoredVaultSecret(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly stored: VaultStoredSecret;
  readonly expected: VaultSecret;
}): Promise<Result<true, VaultResolveError>> {
  const resolved = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.stored.organisationId,
    handle: input.stored.handle,
  });

  if (!resolved.ok) {
    return resolved;
  }

  return vaultSecretsEqual(resolved.value, input.expected)
    ? { ok: true, value: true }
    : {
        ok: false,
        error: {
          code: "vault_plaintext_invalid",
          handle: input.stored.handle,
        },
      };
}

export async function verifyRevokedVaultSecret(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly stored: VaultStoredSecret;
}): Promise<
  Result<
    true,
    | VaultResolveError
    | {
        readonly code: "vault_secret_not_revoked";
      }
  >
> {
  const resolved = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.stored.organisationId,
    handle: input.stored.handle,
  });

  if (!resolved.ok) {
    return resolved.error.code === "vault_secret_revoked"
      ? { ok: true, value: true }
      : resolved;
  }

  return { ok: false, error: { code: "vault_secret_not_revoked" } };
}

export async function revokeVaultSecret(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  handle: VaultHandle;
  now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE vault_secret
       SET revoked_at = ?
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(input.now, input.organisationId, input.handle)
    .run();
}

export async function revokeCredential(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  handle: VaultHandle;
  now: number;
}): Promise<CredentialRevocationReceipt> {
  const session = input.db.withSession("first-primary");
  const revocationId = credentialRevocationId(
    input.organisationId,
    input.handle,
  );
  const revoked = {
    now: input.now,
    organisationId: input.organisationId,
    handle: input.handle,
  };

  await session.batch([
    prepareCredentialHandleGenerationsRevocation(session, revoked),
    prepareCredentialHandleWebhooksRevocation(session, revoked),
    prepareCredentialHandleAccountsRevocation(session, revoked),
    prepareCredentialHandleConnectionsRevocation(session, revoked),
    session
      .prepare(
        `UPDATE credential_ref
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE organisation_id = ? AND vault_handle = ?`,
      )
      .bind(input.now, input.organisationId, input.handle),
    session
      .prepare(
        `UPDATE vault_secret
         SET revoked_at = COALESCE(revoked_at, ?)
         WHERE organisation_id = ? AND vault_handle = ?`,
      )
      .bind(input.now, input.organisationId, input.handle),
    session
      .prepare(
        `INSERT INTO credential_revocation_operation (
           revocation_id, organisation_id, vault_handle, state,
           credential_generation_count, provider_connection_count,
           integration_account_count, provider_webhook_count,
           credential_ref_count, vault_secret_count,
           policy_version, restriction_version, target_consumer_count,
           acknowledged_consumer_count, pending_consumer_count,
           retry_count, restriction_latency_ms,
           started_at, committed_at, policy_activated_at
         )
         SELECT ?, ?, ?, 'committed',
           (
             SELECT COUNT(*) FROM provider_credential_generation
             WHERE organisation_id = ? AND credential_ref = ? AND lifecycle = 'revoked'
           ),
           (
             SELECT COUNT(*) FROM provider_connection
             WHERE organisation_id = ? AND credential_ref = ? AND lifecycle = 'revoked'
           ),
           (
             SELECT COUNT(*) FROM integration_account
             WHERE organisation_id = ? AND lifecycle = 'revoked'
               AND provider_connection_id IN (
                 SELECT provider_connection_id FROM provider_connection
                 WHERE organisation_id = ? AND credential_ref = ?
               )
           ),
           (
             SELECT COUNT(*) FROM provider_webhook
             WHERE organisation_id = ? AND lifecycle = 'revoked'
               AND (
                 signing_secret_ref = ? OR
                 integration_account_id IN (
                   SELECT account.integration_account_id
                   FROM integration_account AS account
                   JOIN provider_connection AS connection
                     ON connection.provider_connection_id = account.provider_connection_id
                    AND connection.organisation_id = account.organisation_id
                   WHERE account.organisation_id = ? AND connection.credential_ref = ?
                 )
               )
           ),
           (
             SELECT COUNT(*) FROM credential_ref
             WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NOT NULL
           ),
           (
             SELECT COUNT(*) FROM vault_secret
             WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NOT NULL
           ),
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
         ON CONFLICT (organisation_id, vault_handle) DO NOTHING`,
      )
      .bind(
        revocationId,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.handle,
        input.organisationId,
        input.handle,
        input.now,
        input.now,
      ),
  ]);

  const row = await readCredentialRevocationReceipt(
    session,
    input.organisationId,
    input.handle,
  );

  return parseCredentialRevocationReceipt(
    row,
    input.organisationId,
    input.handle,
  );
}

export async function activateCredentialRevocationPolicy(input: {
  db: OrganisationDatabase;
  commit: CredentialRevocationCommit;
  policyVersion: number;
  restrictionVersion: number;
  targetConsumerCount: number;
  acknowledgedConsumerCount: number;
  pendingConsumerCount: number;
  activatedAt: number;
}): Promise<CredentialRevocationPolicyActivation> {
  const session = input.db.withSession("first-primary");

  await session
    .prepare(
      `UPDATE credential_revocation_operation
       SET state = 'policy_activated',
           policy_version = ?,
           restriction_version = ?,
           target_consumer_count = ?,
           acknowledged_consumer_count = ?,
           pending_consumer_count = ?,
           retry_count = 0,
           restriction_latency_ms = ?,
           policy_activated_at = ?
       WHERE revocation_id = ? AND organisation_id = ? AND vault_handle = ?
         AND state = 'committed'`,
    )
    .bind(
      input.policyVersion,
      input.restrictionVersion,
      input.targetConsumerCount,
      input.acknowledgedConsumerCount,
      input.pendingConsumerCount,
      Math.max(0, input.activatedAt - input.commit.committedAt),
      input.activatedAt,
      input.commit.revocationId,
      input.commit.organisationId,
      input.commit.handle,
    )
    .run();

  const row = await readCredentialRevocationReceipt(
    session,
    input.commit.organisationId,
    input.commit.handle,
  );
  const receipt = parseCredentialRevocationReceipt(
    row,
    input.commit.organisationId,
    input.commit.handle,
  );

  if (receipt.state !== "policy_activated") {
    throw new Error("credential_revocation_policy_activation_failed");
  }

  return receipt;
}

export async function recordCredentialRestrictionDeliveryProgress(input: {
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  restrictionVersion: number;
  latencyMs: number;
  outcome: "acknowledged" | "retry_scheduled";
}): Promise<void> {
  const acknowledgedIncrement = input.outcome === "acknowledged" ? 1 : 0;

  await input.db
    .prepare(
      `UPDATE credential_revocation_operation
       SET retry_count = retry_count + 1,
           restriction_latency_ms = MAX(restriction_latency_ms, ?),
           acknowledged_consumer_count = MIN(
             target_consumer_count,
             acknowledged_consumer_count + ?
           ),
           pending_consumer_count = MAX(0, pending_consumer_count - ?)
       WHERE organisation_id = ? AND state = 'policy_activated'
         AND restriction_version = ?`,
    )
    .bind(
      Math.max(0, input.latencyMs),
      acknowledgedIncrement,
      acknowledgedIncrement,
      input.organisationId,
      input.restrictionVersion,
    )
    .run();
}

function credentialRevocationId(
  organisationId: OrganisationId,
  handle: VaultHandle,
): string {
  return `credential-revocation:${organisationId}:${handle}`;
}

async function readCredentialRevocationReceipt(
  source: OrganisationQuerySource,
  organisationId: OrganisationId,
  handle: VaultHandle,
): Promise<CredentialRevocationReceiptRow | null> {
  return source
    .prepare(
      `SELECT
         revocation_id AS revocationId,
         state AS state,
         credential_generation_count AS credentialGenerationCount,
         provider_connection_count AS providerConnectionCount,
         integration_account_count AS integrationAccountCount,
         provider_webhook_count AS providerWebhookCount,
         credential_ref_count AS credentialRefCount,
         vault_secret_count AS vaultSecretCount,
         policy_version AS policyVersion,
         restriction_version AS restrictionVersion,
         target_consumer_count AS targetConsumerCount,
         acknowledged_consumer_count AS acknowledgedConsumerCount,
         pending_consumer_count AS pendingConsumerCount,
         retry_count AS retryCount,
         restriction_latency_ms AS restrictionLatencyMs,
         started_at AS startedAt,
         committed_at AS committedAt,
         policy_activated_at AS policyActivatedAt
       FROM credential_revocation_operation
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(organisationId, handle)
    .first<CredentialRevocationReceiptRow>();
}

function parseCredentialRevocationReceipt(
  row: CredentialRevocationReceiptRow | null,
  organisationId: OrganisationId,
  handle: VaultHandle,
): CredentialRevocationReceipt {
  if (
    row === null ||
    typeof row.revocationId !== "string" ||
    !isNonNegativeInteger(row.credentialGenerationCount) ||
    !isNonNegativeInteger(row.providerConnectionCount) ||
    !isNonNegativeInteger(row.integrationAccountCount) ||
    !isNonNegativeInteger(row.providerWebhookCount) ||
    !isNonNegativeInteger(row.credentialRefCount) ||
    !isNonNegativeInteger(row.vaultSecretCount) ||
    !isNonNegativeInteger(row.startedAt) ||
    !isNonNegativeInteger(row.committedAt)
  ) {
    throw new Error("credential_revocation_receipt_invalid");
  }

  const base: CredentialRevocationBase = {
    revocationId: row.revocationId,
    organisationId,
    handle,
    credentialGenerationCount: row.credentialGenerationCount,
    providerConnectionCount: row.providerConnectionCount,
    integrationAccountCount: row.integrationAccountCount,
    providerWebhookCount: row.providerWebhookCount,
    credentialRefCount: row.credentialRefCount,
    vaultSecretCount: row.vaultSecretCount,
    startedAt: row.startedAt,
    committedAt: row.committedAt,
  };

  switch (row.state) {
    case "committed":
      if (
        row.policyVersion !== null ||
        row.restrictionVersion !== null ||
        row.targetConsumerCount !== null ||
        row.acknowledgedConsumerCount !== null ||
        row.pendingConsumerCount !== null ||
        row.retryCount !== null ||
        row.restrictionLatencyMs !== null ||
        row.policyActivatedAt !== null
      ) {
        throw new Error("credential_revocation_receipt_invalid");
      }

      return { ...base, state: "committed" };
    case "policy_activated":
      if (
        !isNonNegativeInteger(row.policyVersion) ||
        !isNonNegativeInteger(row.restrictionVersion) ||
        !isNonNegativeInteger(row.targetConsumerCount) ||
        !isNonNegativeInteger(row.acknowledgedConsumerCount) ||
        !isNonNegativeInteger(row.pendingConsumerCount) ||
        !isNonNegativeInteger(row.retryCount) ||
        !isNonNegativeInteger(row.restrictionLatencyMs) ||
        !isNonNegativeInteger(row.policyActivatedAt)
      ) {
        throw new Error("credential_revocation_receipt_invalid");
      }

      return {
        ...base,
        state: "policy_activated",
        policyVersion: row.policyVersion,
        restrictionVersion: row.restrictionVersion,
        targetConsumerCount: row.targetConsumerCount,
        acknowledgedConsumerCount: row.acknowledgedConsumerCount,
        pendingConsumerCount: row.pendingConsumerCount,
        retryCount: row.retryCount,
        restrictionLatencyMs: row.restrictionLatencyMs,
        policyActivatedAt: row.policyActivatedAt,
      };
    default:
      throw new Error("credential_revocation_receipt_invalid");
  }
}

async function readVaultSecretRow(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  handle: VaultHandle,
): Promise<VaultSecretRow | null> {
  const row = await db
    .prepare(
      `SELECT
         vault_handle AS vaultHandle,
         key_version AS keyVersion,
         algorithm AS algorithm,
         nonce_b64 AS nonceB64,
         ciphertext_b64 AS ciphertextB64,
         created_at AS createdAt,
         rotated_at AS rotatedAt,
         revoked_at AS revokedAt
       FROM vault_secret
       WHERE organisation_id = ? AND vault_handle = ?`,
    )
    .bind(organisationId, handle)
    .first<VaultSecretRow>();

  return row;
}

function serializeVaultSecret(secret: VaultSecret): Uint8Array {
  switch (secret.kind) {
    case "bearer":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          value: secret.value,
          header: null,
        }),
      );
    case "expiring_bearer":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          value: secret.value,
          expiresAt: secret.expiresAt,
        }),
      );
    case "header":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          value: secret.value,
          header: secret.header,
        }),
      );
    case "opaque_profile":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          format: secret.format,
          value: secret.value,
        }),
      );
    case "oauth_tokens":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          accessToken: secret.accessToken,
          refreshToken: secret.refreshToken,
          expiryKind: secret.expiry.kind,
          expiresAt:
            secret.expiry.kind === "expires" ? secret.expiry.expiresAt : null,
        }),
      );
    case "oauth_client_credentials":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          clientId: secret.clientId,
          clientSecret: secret.clientSecret,
        }),
      );
    case "website_login":
      return textEncoder.encode(
        JSON.stringify({
          kind: secret.kind,
          username: secret.username,
          password: secret.password,
        }),
      );
    default:
      return assertNever(secret, "Unhandled vault secret");
  }
}

function vaultSecretsEqual(left: VaultSecret, right: VaultSecret): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "bearer":
      return right.kind === "bearer" && left.value === right.value;
    case "expiring_bearer":
      return (
        right.kind === "expiring_bearer" &&
        left.value === right.value &&
        left.expiresAt === right.expiresAt
      );
    case "header":
      return (
        right.kind === "header" &&
        left.header === right.header &&
        left.value === right.value
      );
    case "opaque_profile":
      return (
        right.kind === "opaque_profile" &&
        left.format === right.format &&
        left.value === right.value
      );
    case "oauth_tokens":
      return (
        right.kind === "oauth_tokens" &&
        left.accessToken === right.accessToken &&
        left.refreshToken === right.refreshToken &&
        left.expiry.kind === right.expiry.kind &&
        (left.expiry.kind === "provider_managed" ||
          (right.expiry.kind === "expires" &&
            left.expiry.expiresAt === right.expiry.expiresAt))
      );
    case "oauth_client_credentials":
      return (
        right.kind === "oauth_client_credentials" &&
        left.clientId === right.clientId &&
        left.clientSecret === right.clientSecret
      );
    case "website_login":
      return (
        right.kind === "website_login" &&
        left.username === right.username &&
        left.password === right.password
      );
    default:
      return assertNever(left, "Unhandled vault secret");
  }
}

function parseVaultPlaintext(
  plaintext: Uint8Array,
  handle: VaultHandle,
): Result<VaultSecret, { code: "vault_plaintext_invalid"; handle: string }> {
  const decoded = decodeUtf8Json(plaintext);

  if (!decoded.ok) {
    return { ok: false, error: { code: "vault_plaintext_invalid", handle } };
  }

  const payload = parseVaultPlaintextPayload(decoded.value);

  if (!payload.ok) {
    return { ok: false, error: { code: "vault_plaintext_invalid", handle } };
  }

  switch (payload.value.kind) {
    case "bearer":
      return {
        ok: true,
        value: { kind: "bearer", value: payload.value.value },
      };
    case "expiring_bearer":
      return {
        ok: true,
        value: {
          kind: "expiring_bearer",
          value: payload.value.value,
          expiresAt: payload.value.expiresAt,
        },
      };
    case "header":
      return {
        ok: true,
        value: {
          kind: "header",
          header: payload.value.header,
          value: payload.value.value,
        },
      };
    case "opaque_profile":
      return {
        ok: true,
        value: {
          kind: payload.value.kind,
          format: payload.value.format,
          value: payload.value.value,
        },
      };
    case "oauth_tokens":
      return {
        ok: true,
        value: {
          kind: "oauth_tokens",
          accessToken: payload.value.accessToken,
          refreshToken: payload.value.refreshToken,
          expiry:
            payload.value.expiryKind === "expires"
              ? {
                  kind: "expires",
                  expiresAt: requireOAuthExpiry(payload.value.expiresAt),
                }
              : { kind: "provider_managed" },
        },
      };
    case "oauth_client_credentials":
      return {
        ok: true,
        value: {
          kind: payload.value.kind,
          clientId: payload.value.clientId,
          clientSecret: payload.value.clientSecret,
        },
      };
    case "website_login":
      return {
        ok: true,
        value: {
          kind: payload.value.kind,
          username: payload.value.username,
          password: payload.value.password,
        },
      };
    default:
      return assertNever(payload.value, "Unhandled vault payload");
  }
}

export function validateVaultPlaintext(
  plaintext: Uint8Array,
  handle: VaultHandle,
): Result<
  true,
  { readonly code: "vault_plaintext_invalid"; readonly handle: string }
> {
  const parsed = parseVaultPlaintext(plaintext, handle);
  return parsed.ok ? { ok: true, value: true } : parsed;
}

function parseVaultPlaintextPayload(
  raw: unknown,
): Result<VaultPlaintextPayload, { code: "invalid_payload" }> {
  if (!isRecord(raw)) {
    return { ok: false, error: { code: "invalid_payload" } };
  }

  const kind = raw.kind;

  if (
    kind === "opaque_profile" &&
    isVaultOpaqueProfileFormat(raw.format) &&
    typeof raw.value === "string" &&
    raw.value.length > 0
  ) {
    return {
      ok: true,
      value: { kind, format: raw.format, value: raw.value },
    };
  }

  if (
    kind === "expiring_bearer" &&
    typeof raw.value === "string" &&
    raw.value.length > 0 &&
    typeof raw.expiresAt === "number" &&
    Number.isFinite(raw.expiresAt) &&
    raw.expiresAt > 0
  ) {
    return {
      ok: true,
      value: { kind, value: raw.value, expiresAt: raw.expiresAt },
    };
  }

  if (
    kind === "oauth_tokens" &&
    typeof raw.accessToken === "string" &&
    raw.accessToken.length > 0 &&
    typeof raw.refreshToken === "string" &&
    raw.refreshToken.length > 0 &&
    ((raw.expiryKind === "expires" &&
      typeof raw.expiresAt === "number" &&
      Number.isFinite(raw.expiresAt)) ||
      (raw.expiryKind === "provider_managed" && raw.expiresAt === null))
  ) {
    return {
      ok: true,
      value: {
        kind,
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiryKind: raw.expiryKind,
        expiresAt: raw.expiresAt,
      },
    };
  }

  if (
    kind === "oauth_client_credentials" &&
    typeof raw.clientId === "string" &&
    raw.clientId.length > 0 &&
    typeof raw.clientSecret === "string" &&
    raw.clientSecret.length > 0
  ) {
    return {
      ok: true,
      value: { kind, clientId: raw.clientId, clientSecret: raw.clientSecret },
    };
  }

  if (
    kind === "website_login" &&
    typeof raw.username === "string" &&
    raw.username.length > 0 &&
    typeof raw.password === "string" &&
    raw.password.length > 0
  ) {
    return {
      ok: true,
      value: { kind, username: raw.username, password: raw.password },
    };
  }

  const value = raw.value;
  const header = raw.header;

  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: { code: "invalid_payload" } };
  }

  if (kind === "bearer" && header === null) {
    return { ok: true, value: { kind, value, header } };
  }

  if (kind === "header" && typeof header === "string" && header.length > 0) {
    return { ok: true, value: { kind, value, header } };
  }

  return { ok: false, error: { code: "invalid_payload" } };
}

function requireOAuthExpiry(value: number | null): number {
  if (value === null) throw new Error("OAuth expiry is missing");
  return value;
}

function decodeUtf8Json(
  value: Uint8Array,
): Result<unknown, { code: "invalid_json" }> {
  try {
    return { ok: true, value: JSON.parse(textDecoder.decode(value)) };
  } catch {
    return { ok: false, error: { code: "invalid_json" } };
  }
}

function vaultKeyRingStoreError(
  error: VaultKeyRingError,
): Result<never, VaultStoreError> {
  switch (error.code) {
    case "vault_root_unavailable":
      return { ok: false, error: { code: "vault_root_unavailable" } };
    case "vault_active_key_version_invalid":
    case "vault_root_key_version_invalid":
    case "vault_root_binding_invalid":
    case "vault_root_version_duplicate":
    case "vault_active_root_unavailable":
    case "vault_root_invalid":
      return { ok: false, error: { code: "vault_root_invalid" } };
    default:
      return assertNever(error, "Unhandled Vault keyring error");
  }
}

function vaultKeyRingResolveError(
  error: VaultKeyRingError,
): Result<never, VaultResolveError> {
  switch (error.code) {
    case "vault_root_unavailable":
      return { ok: false, error: { code: "vault_root_unavailable" } };
    case "vault_active_key_version_invalid":
    case "vault_root_key_version_invalid":
    case "vault_root_binding_invalid":
    case "vault_root_version_duplicate":
    case "vault_active_root_unavailable":
    case "vault_root_invalid":
      return { ok: false, error: { code: "vault_root_invalid" } };
    default:
      return assertNever(error, "Unhandled Vault keyring error");
  }
}

function vaultRootSelectionResolveError(
  error:
    | { readonly code: "vault_key_version_invalid" }
    | {
        readonly code: "vault_root_version_unavailable";
        readonly version: VaultKeyVersion;
      },
  handle: VaultHandle,
): Result<never, VaultResolveError> {
  switch (error.code) {
    case "vault_key_version_invalid":
      return { ok: false, error: { code: "vault_ciphertext_invalid", handle } };
    case "vault_root_version_unavailable":
      return { ok: false, error: { code: "vault_root_unavailable" } };
    default:
      return assertNever(error, "Unhandled Vault root-selection error");
  }
}
