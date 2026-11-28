import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import type { ModelRoute } from "@purin-labs/contracts";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseVaultHandle,
  type VaultHandle,
  type VaultResolveError,
  type VaultStoreError,
} from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle, storeVaultSecret } from "./service";
import type { OrganisationQuerySource } from "@purin-labs/tenancy/data/query-source";
import {
  prepareGuardedCredentialRefRevocation,
  prepareGuardedVaultSecretRevocation,
  prepareVaultSecretRevocation,
  type Guard,
} from "./secret-revocation";

/** The model providers whose API key an Organisation stores (spec FND-08). */
export type ModelKeyProvider = "openai" | "anthropic" | "google";

type ModelKeyProviderRow = {
  /** The one host that the key may reach. */
  readonly host: string;
  /** How the egress puts the key on a request, stored in `credential_ref`. */
  readonly injectAs: Readonly<Record<string, string>>;
  /** A prefix that each key of the provider has, or null. */
  readonly prefix: string | null;
};

const MODEL_KEY_PROVIDERS: Readonly<
  Record<ModelKeyProvider, ModelKeyProviderRow>
> = {
  openai: {
    host: "api.openai.com",
    injectAs: { kind: "header", header: "authorization", scheme: "Bearer" },
    prefix: null,
  },
  anthropic: {
    host: "api.anthropic.com",
    injectAs: { kind: "header", header: "x-api-key" },
    prefix: "sk-ant-",
  },
  google: {
    host: "generativelanguage.googleapis.com",
    injectAs: { kind: "header", header: "x-goog-api-key" },
    prefix: null,
  },
};
const MODEL_CREDENTIAL_NAME = "model";
const MODEL_API_KEY_MIN_LENGTH = 20;
const MODEL_API_KEY_MAX_LENGTH = 4_096;

const modelApiKeyBrand: unique symbol = Symbol("ModelApiKey");

export type ModelApiKey<P extends ModelKeyProvider> = string & {
  readonly [modelApiKeyBrand]: P;
};

export type OrganisationModelCredential<P extends ModelKeyProvider> = {
  readonly provider: P;
  readonly handle: VaultHandle;
  readonly apiKey: ModelApiKey<P>;
};

type CredentialCode<P extends ModelKeyProvider, S extends string> = {
  readonly code: `organisation_${P}_credential_${S}`;
};

export type OrganisationModelCredentialError<P extends ModelKeyProvider> =
  | VaultResolveError
  | CredentialCode<P, "unavailable">
  | CredentialCode<P, "scope_mismatch">
  | CredentialCode<P, "invalid">;

export type OrganisationModelCredentialStoreError<P extends ModelKeyProvider> =
  | VaultStoreError
  | CredentialCode<P, "invalid">
  | CredentialCode<P, "binding_failed">;

type CredentialRefRow = {
  readonly vaultHandle: unknown;
};

function credentialError<P extends ModelKeyProvider, S extends string>(
  provider: P,
  suffix: S,
): { readonly ok: false; readonly error: CredentialCode<P, S> } {
  return {
    ok: false,
    error: {
      code: `organisation_${provider}_credential_${suffix}` as `organisation_${P}_credential_${S}`,
    },
  };
}

export function parseModelApiKey<P extends ModelKeyProvider>(
  provider: P,
  raw: unknown,
): Result<ModelApiKey<P>, CredentialCode<P, "invalid">> {
  if (typeof raw !== "string") return credentialError(provider, "invalid");
  const value = raw.trim();
  const prefix = MODEL_KEY_PROVIDERS[provider].prefix;
  if (
    (prefix !== null && !value.startsWith(prefix)) ||
    value.length < MODEL_API_KEY_MIN_LENGTH ||
    value.length > MODEL_API_KEY_MAX_LENGTH
  ) {
    return credentialError(provider, "invalid");
  }
  return { ok: true, value: value as ModelApiKey<P> };
}

/** Stores a new key and revokes the one it replaces, in one batch. */
export async function storeOrganisationModelCredential<
  P extends ModelKeyProvider,
>(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly provider: P;
  readonly apiKey: ModelApiKey<P>;
  readonly now: number;
}): Promise<Result<VaultHandle, OrganisationModelCredentialStoreError<P>>> {
  const row = MODEL_KEY_PROVIDERS[input.provider];
  const session = input.db.withSession("first-primary");
  const previousRow = await session
    .prepare(
      `SELECT vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND provider = ? AND name = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, input.provider, MODEL_CREDENTIAL_NAME)
    .first<CredentialRefRow>();
  const previousHandle =
    previousRow === null
      ? null
      : typeof previousRow.vaultHandle === "string"
        ? parseVaultHandle(previousRow.vaultHandle)
        : {
            ok: false as const,
            error: { code: "invalid_vault_handle" as const },
          };
  if (previousHandle !== null && !previousHandle.ok) {
    return credentialError(input.provider, "binding_failed");
  }
  const handle = newOrganisationModelCredentialHandle(
    input.organisationId,
    input.provider,
  );
  const stored = await storeVaultSecret({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle,
    secret: { kind: "bearer", value: input.apiKey },
    now: input.now,
  });
  if (!stored.ok) return stored;

  const statements = [
    session
      .prepare(
        `INSERT INTO credential_ref (
       organisation_id, provider, name, vault_handle, host_pattern,
       inject_as, created_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (organisation_id, provider, name) DO UPDATE SET
       vault_handle = excluded.vault_handle,
       host_pattern = excluded.host_pattern,
       inject_as = excluded.inject_as,
       created_at = excluded.created_at,
       revoked_at = NULL`,
      )
      .bind(
        input.organisationId,
        input.provider,
        MODEL_CREDENTIAL_NAME,
        handle,
        row.host,
        JSON.stringify(row.injectAs),
        input.now,
      ),
  ];
  if (previousHandle !== null && previousHandle.ok) {
    statements.push(
      prepareVaultSecretRevocation(session, {
        organisationId: input.organisationId,
        handle: previousHandle.value,
        now: input.now,
      }),
    );
  }
  const results = await session.batch(statements);
  return results[0]?.meta.changes === 1
    ? { ok: true, value: handle }
    : credentialError(input.provider, "binding_failed");
}

/**
 * The statements that remove each stored model key apart from the key of
 * `keep`: for each one, the revocation of its secret and of its reference,
 * while the guard holds. The list is empty when no such key is stored, so a
 * caller with nothing to remove writes no row.
 */
export async function prepareOtherModelCredentialsRevocation(input: {
  readonly db: OrganisationDatabaseSession;
  readonly organisationId: OrganisationId;
  /** The provider of the selected key source, or null for another source. */
  readonly keep: ModelKeyProvider | null;
  readonly now: number;
  readonly guard: Guard;
}): Promise<readonly D1PreparedStatement[]> {
  const stored = await input.db
    .prepare(
      `SELECT provider, vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND name = ? AND revoked_at IS NULL`,
    )
    .bind(input.organisationId, MODEL_CREDENTIAL_NAME)
    .all<CredentialRefRow & { readonly provider: unknown }>();
  const statements: D1PreparedStatement[] = [];
  for (const row of stored.results) {
    if (
      typeof row.provider !== "string" ||
      !Object.hasOwn(MODEL_KEY_PROVIDERS, row.provider) ||
      row.provider === input.keep ||
      typeof row.vaultHandle !== "string"
    )
      continue;
    const revocation = {
      now: input.now,
      organisationId: input.organisationId,
      handle: row.vaultHandle,
      guard: input.guard,
    };
    statements.push(
      prepareGuardedVaultSecretRevocation(input.db, revocation),
      prepareGuardedCredentialRefRevocation(input.db, revocation),
    );
  }
  return statements;
}

export async function resolveCurrentOrganisationModelCredential<
  P extends ModelKeyProvider,
>(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly provider: P;
}): Promise<
  Result<OrganisationModelCredential<P>, OrganisationModelCredentialError<P>>
> {
  const handle = await readCurrentOrganisationModelCredentialHandle(input);
  if (!handle.ok) return handle;
  return resolveBoundOrganisationModelCredential({
    ...input,
    handle: handle.value,
  });
}

/** The key of a pinned route, only while it is still the current key. */
export async function resolveOrganisationModelCredentialForRoute<
  P extends ModelKeyProvider,
>(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly provider: P;
  readonly route: ModelRoute;
}): Promise<
  Result<OrganisationModelCredential<P>, OrganisationModelCredentialError<P>>
> {
  if (
    input.route.keySource !== "organisation_byo" ||
    input.route.provider !== input.provider
  ) {
    return credentialError(input.provider, "scope_mismatch");
  }
  const routeHandle = parseVaultHandle(input.route.byoKeyRef);
  if (!routeHandle.ok) return credentialError(input.provider, "scope_mismatch");
  const currentHandle =
    await readCurrentOrganisationModelCredentialHandle(input);
  if (!currentHandle.ok) return currentHandle;
  if (currentHandle.value !== routeHandle.value) {
    return credentialError(input.provider, "scope_mismatch");
  }
  return resolveBoundOrganisationModelCredential({
    ...input,
    handle: routeHandle.value,
  });
}

async function readCurrentOrganisationModelCredentialHandle<
  P extends ModelKeyProvider,
>(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
  readonly provider: P;
}): Promise<Result<VaultHandle, OrganisationModelCredentialError<P>>> {
  const row = await input.db
    .prepare(
      `SELECT vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND provider = ? AND name = ?
       AND host_pattern = ? AND revoked_at IS NULL
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.provider,
      MODEL_CREDENTIAL_NAME,
      MODEL_KEY_PROVIDERS[input.provider].host,
    )
    .first<CredentialRefRow>();
  if (row === null || typeof row.vaultHandle !== "string") {
    return credentialError(input.provider, "unavailable");
  }
  const parsed = parseVaultHandle(row.vaultHandle);
  return parsed.ok ? parsed : credentialError(input.provider, "invalid");
}

async function resolveBoundOrganisationModelCredential<
  P extends ModelKeyProvider,
>(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly provider: P;
  readonly handle: VaultHandle;
}): Promise<
  Result<OrganisationModelCredential<P>, OrganisationModelCredentialError<P>>
> {
  const secret = await resolveVaultHandle(input);
  if (!secret.ok) return secret;
  if (secret.value.kind !== "bearer") {
    return credentialError(input.provider, "invalid");
  }
  const apiKey = parseModelApiKey(input.provider, secret.value.value);
  return apiKey.ok
    ? {
        ok: true,
        value: {
          provider: input.provider,
          handle: input.handle,
          apiKey: apiKey.value,
        },
      }
    : apiKey;
}

function newOrganisationModelCredentialHandle(
  organisationId: OrganisationId,
  provider: ModelKeyProvider,
): VaultHandle {
  const parsed = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:${provider}:model:${crypto.randomUUID().toLowerCase()}`,
  );
  if (!parsed.ok)
    throw new Error(
      `generated organisation ${provider} credential handle is invalid`,
    );
  return parsed.value;
}
