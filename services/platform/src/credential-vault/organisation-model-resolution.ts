import type { OrganisationDatabase } from "../database-handles";
import type { ModelRoute } from "@purin-labs/contracts";

import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import {
  parseVaultHandle,
  type VaultHandle,
  type VaultResolveError,
  type VaultStoreError,
} from "./domain";
import type { CredentialVaultBindings } from "./keyring";
import { resolveVaultHandle, storeVaultSecret } from "./service";
import type { OrganisationQuerySource } from "../data/query-source";
import { prepareVaultSecretRevocation } from "./secret-revocation";

const openAiApiKeyBrand: unique symbol = Symbol("OpenAiApiKey");
const anthropicApiKeyBrand: unique symbol = Symbol("AnthropicApiKey");
const OPENAI_MODEL_CREDENTIAL_NAME = "model";
const OPENAI_API_HOST = "api.openai.com";
const OPENAI_API_KEY_MAX_LENGTH = 4_096;
const ANTHROPIC_MODEL_CREDENTIAL_NAME = "model";
const ANTHROPIC_API_HOST = "api.anthropic.com";
const ANTHROPIC_API_KEY_MAX_LENGTH = 4_096;

export type OpenAiApiKey = string & {
  readonly [openAiApiKeyBrand]: "OpenAiApiKey";
};

export type AnthropicApiKey = string & {
  readonly [anthropicApiKeyBrand]: "AnthropicApiKey";
};

export type OrganisationOpenAiModelCredential = {
  readonly provider: "openai";
  readonly handle: VaultHandle;
  readonly apiKey: OpenAiApiKey;
};

export type OrganisationOpenAiModelCredentialError =
  | VaultResolveError
  | { readonly code: "organisation_openai_credential_unavailable" }
  | { readonly code: "organisation_openai_credential_scope_mismatch" }
  | { readonly code: "organisation_openai_credential_invalid" };

export type OrganisationOpenAiModelCredentialStoreError =
  | VaultStoreError
  | { readonly code: "organisation_openai_credential_invalid" }
  | { readonly code: "organisation_openai_credential_binding_failed" };

export type OrganisationAnthropicModelCredential = {
  readonly provider: "anthropic";
  readonly handle: VaultHandle;
  readonly apiKey: AnthropicApiKey;
};

export type OrganisationAnthropicModelCredentialError =
  | VaultResolveError
  | { readonly code: "organisation_anthropic_credential_unavailable" }
  | { readonly code: "organisation_anthropic_credential_scope_mismatch" }
  | { readonly code: "organisation_anthropic_credential_invalid" };

export type OrganisationAnthropicModelCredentialStoreError =
  | VaultStoreError
  | { readonly code: "organisation_anthropic_credential_invalid" }
  | { readonly code: "organisation_anthropic_credential_binding_failed" };

type CredentialRefRow = {
  readonly vaultHandle: unknown;
};

export function parseOpenAiApiKey(
  raw: unknown,
): Result<
  OpenAiApiKey,
  { readonly code: "organisation_openai_credential_invalid" }
> {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_invalid" },
    };
  }
  const value = raw.trim();
  if (value.length < 20 || value.length > OPENAI_API_KEY_MAX_LENGTH) {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_invalid" },
    };
  }
  return { ok: true, value: value as OpenAiApiKey };
}

export function parseAnthropicApiKey(
  raw: unknown,
): Result<
  AnthropicApiKey,
  { readonly code: "organisation_anthropic_credential_invalid" }
> {
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_invalid" },
    };
  }
  const value = raw.trim();
  if (
    !value.startsWith("sk-ant-") ||
    value.length < 20 ||
    value.length > ANTHROPIC_API_KEY_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_invalid" },
    };
  }
  return { ok: true, value: value as AnthropicApiKey };
}

export async function storeOrganisationOpenAiModelCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly apiKey: OpenAiApiKey;
  readonly now: number;
}): Promise<Result<VaultHandle, OrganisationOpenAiModelCredentialStoreError>> {
  const session = input.db.withSession("first-primary");
  const previousRow = await session
    .prepare(
      `SELECT vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND provider = 'openai' AND name = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, OPENAI_MODEL_CREDENTIAL_NAME)
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
    return {
      ok: false,
      error: { code: "organisation_openai_credential_binding_failed" },
    };
  }
  const handle = newOrganisationOpenAiModelCredentialHandle(
    input.organisationId,
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
     ) VALUES (?, 'openai', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (organisation_id, provider, name) DO UPDATE SET
       vault_handle = excluded.vault_handle,
       host_pattern = excluded.host_pattern,
       inject_as = excluded.inject_as,
       created_at = excluded.created_at,
       revoked_at = NULL`,
      )
      .bind(
        input.organisationId,
        OPENAI_MODEL_CREDENTIAL_NAME,
        handle,
        OPENAI_API_HOST,
        JSON.stringify({
          kind: "header",
          header: "authorization",
          scheme: "Bearer",
        }),
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
    : {
        ok: false,
        error: { code: "organisation_openai_credential_binding_failed" },
      };
}

export async function resolveCurrentOrganisationOpenAiModelCredential(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<
    OrganisationOpenAiModelCredential,
    OrganisationOpenAiModelCredentialError
  >
> {
  const handle =
    await readCurrentOrganisationOpenAiModelCredentialHandle(input);
  if (!handle.ok) return handle;
  return resolveBoundOrganisationOpenAiModelCredential({
    ...input,
    handle: handle.value,
  });
}

export async function resolveOrganisationOpenAiModelCredentialForRoute(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly route: ModelRoute;
}): Promise<
  Result<
    OrganisationOpenAiModelCredential,
    OrganisationOpenAiModelCredentialError
  >
> {
  if (
    input.route.keySource !== "organisation_byo" ||
    input.route.provider !== "openai"
  ) {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_scope_mismatch" },
    };
  }
  const routeHandle = parseVaultHandle(input.route.byoKeyRef);
  if (!routeHandle.ok) {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_scope_mismatch" },
    };
  }
  const currentHandle =
    await readCurrentOrganisationOpenAiModelCredentialHandle(input);
  if (!currentHandle.ok) return currentHandle;
  if (currentHandle.value !== routeHandle.value) {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_scope_mismatch" },
    };
  }
  return resolveBoundOrganisationOpenAiModelCredential({
    ...input,
    handle: routeHandle.value,
  });
}

async function readCurrentOrganisationOpenAiModelCredentialHandle(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<Result<VaultHandle, OrganisationOpenAiModelCredentialError>> {
  const row = await input.db
    .prepare(
      `SELECT vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND provider = 'openai' AND name = ?
       AND host_pattern = ? AND revoked_at IS NULL
     LIMIT 1`,
    )
    .bind(input.organisationId, OPENAI_MODEL_CREDENTIAL_NAME, OPENAI_API_HOST)
    .first<CredentialRefRow>();
  if (row === null || typeof row.vaultHandle !== "string") {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_unavailable" },
    };
  }
  const parsed = parseVaultHandle(row.vaultHandle);
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "organisation_openai_credential_invalid" } };
}

async function resolveBoundOrganisationOpenAiModelCredential(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
}): Promise<
  Result<
    OrganisationOpenAiModelCredential,
    OrganisationOpenAiModelCredentialError
  >
> {
  const secret = await resolveVaultHandle(input);
  if (!secret.ok) return secret;
  if (secret.value.kind !== "bearer") {
    return {
      ok: false,
      error: { code: "organisation_openai_credential_invalid" },
    };
  }
  const apiKey = parseOpenAiApiKey(secret.value.value);
  return apiKey.ok
    ? {
        ok: true,
        value: {
          provider: "openai",
          handle: input.handle,
          apiKey: apiKey.value,
        },
      }
    : apiKey;
}

function newOrganisationOpenAiModelCredentialHandle(
  organisationId: OrganisationId,
): VaultHandle {
  const parsed = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:openai:model:${crypto.randomUUID().toLowerCase()}`,
  );
  if (!parsed.ok)
    throw new Error(
      "generated organisation OpenAI credential handle is invalid",
    );
  return parsed.value;
}

export async function storeOrganisationAnthropicModelCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly apiKey: AnthropicApiKey;
  readonly now: number;
}): Promise<
  Result<VaultHandle, OrganisationAnthropicModelCredentialStoreError>
> {
  const session = input.db.withSession("first-primary");
  const previousRow = await session
    .prepare(
      `SELECT vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND provider = 'anthropic' AND name = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, ANTHROPIC_MODEL_CREDENTIAL_NAME)
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
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_binding_failed" },
    };
  }
  const handle = newOrganisationAnthropicModelCredentialHandle(
    input.organisationId,
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
     ) VALUES (?, 'anthropic', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (organisation_id, provider, name) DO UPDATE SET
       vault_handle = excluded.vault_handle,
       host_pattern = excluded.host_pattern,
       inject_as = excluded.inject_as,
       created_at = excluded.created_at,
       revoked_at = NULL`,
      )
      .bind(
        input.organisationId,
        ANTHROPIC_MODEL_CREDENTIAL_NAME,
        handle,
        ANTHROPIC_API_HOST,
        JSON.stringify({ kind: "header", header: "x-api-key" }),
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
    : {
        ok: false,
        error: { code: "organisation_anthropic_credential_binding_failed" },
      };
}

export async function resolveCurrentOrganisationAnthropicModelCredential(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<
    OrganisationAnthropicModelCredential,
    OrganisationAnthropicModelCredentialError
  >
> {
  const handle =
    await readCurrentOrganisationAnthropicModelCredentialHandle(input);
  if (!handle.ok) return handle;
  return resolveBoundOrganisationAnthropicModelCredential({
    ...input,
    handle: handle.value,
  });
}

export async function resolveOrganisationAnthropicModelCredentialForRoute(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly route: ModelRoute;
}): Promise<
  Result<
    OrganisationAnthropicModelCredential,
    OrganisationAnthropicModelCredentialError
  >
> {
  if (
    input.route.keySource !== "organisation_byo" ||
    input.route.provider !== "anthropic"
  ) {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_scope_mismatch" },
    };
  }
  const routeHandle = parseVaultHandle(input.route.byoKeyRef);
  if (!routeHandle.ok) {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_scope_mismatch" },
    };
  }
  const currentHandle =
    await readCurrentOrganisationAnthropicModelCredentialHandle(input);
  if (!currentHandle.ok) return currentHandle;
  if (currentHandle.value !== routeHandle.value) {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_scope_mismatch" },
    };
  }
  return resolveBoundOrganisationAnthropicModelCredential({
    ...input,
    handle: routeHandle.value,
  });
}

async function readCurrentOrganisationAnthropicModelCredentialHandle(input: {
  readonly db: OrganisationQuerySource;
  readonly organisationId: OrganisationId;
}): Promise<Result<VaultHandle, OrganisationAnthropicModelCredentialError>> {
  const row = await input.db
    .prepare(
      `SELECT vault_handle AS vaultHandle
     FROM credential_ref
     WHERE organisation_id = ? AND provider = 'anthropic' AND name = ?
       AND host_pattern = ? AND revoked_at IS NULL
     LIMIT 1`,
    )
    .bind(
      input.organisationId,
      ANTHROPIC_MODEL_CREDENTIAL_NAME,
      ANTHROPIC_API_HOST,
    )
    .first<CredentialRefRow>();
  if (row === null || typeof row.vaultHandle !== "string") {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_unavailable" },
    };
  }
  const parsed = parseVaultHandle(row.vaultHandle);
  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: { code: "organisation_anthropic_credential_invalid" },
      };
}

async function resolveBoundOrganisationAnthropicModelCredential(input: {
  readonly db: OrganisationQuerySource;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly handle: VaultHandle;
}): Promise<
  Result<
    OrganisationAnthropicModelCredential,
    OrganisationAnthropicModelCredentialError
  >
> {
  const secret = await resolveVaultHandle(input);
  if (!secret.ok) return secret;
  if (secret.value.kind !== "bearer") {
    return {
      ok: false,
      error: { code: "organisation_anthropic_credential_invalid" },
    };
  }
  const apiKey = parseAnthropicApiKey(secret.value.value);
  return apiKey.ok
    ? {
        ok: true,
        value: {
          provider: "anthropic",
          handle: input.handle,
          apiKey: apiKey.value,
        },
      }
    : apiKey;
}

function newOrganisationAnthropicModelCredentialHandle(
  organisationId: OrganisationId,
): VaultHandle {
  const parsed = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:anthropic:model:${crypto.randomUUID().toLowerCase()}`,
  );
  if (!parsed.ok)
    throw new Error(
      "generated organisation Anthropic credential handle is invalid",
    );
  return parsed.value;
}
