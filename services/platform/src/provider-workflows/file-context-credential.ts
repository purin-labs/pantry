import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { storeOrganisationPlacementVaultSecret } from "../credential-vault/service";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  parseVaultHandle,
  resolveProviderManifestCredential,
  type VaultHandle,
  type VaultOAuthTokens,
} from "../credential-vault";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { configuredValue } from "../provider-adapters/authorization";
import {
  readDropboxAccount,
  refreshDropboxAccessToken,
} from "../provider-adapters/dropbox";
import {
  GOOGLE_DRIVE_REQUIRED_SCOPES,
  readGoogleDriveIdentity,
  refreshGoogleDriveAccessToken,
} from "../provider-adapters/google-drive";
import type { Result } from "@purin-labs/kernel/result";
import type { VariantBy } from "@purin-labs/type-utils";
import type { FileContextProvider } from "@purin-labs/contracts";

type FileProvider = FileContextProvider;

export type FileProviderCredentialStore = (
  input: Readonly<{
    credentialRef: VaultHandle;
    tokens: VaultOAuthTokens;
    now: number;
  }>,
) => Promise<boolean>;

type ActiveFileConnectionBase = Readonly<{
  readonly providerAccountId: string;
  readonly environment: "development" | "production";
  readonly credentialRef: VaultHandle;
}>;

type ActiveFileConnection =
  | (ActiveFileConnectionBase & Readonly<{ readonly provider: "dropbox" }>)
  | (ActiveFileConnectionBase &
      Readonly<{ readonly provider: "google_drive" }>);

export type FileProviderAccess =
  | Readonly<{
      readonly kind: "dropbox";
      readonly accessToken: string;
      readonly homeNamespaceId: string;
    }>
  | Readonly<{
      readonly kind: "google_drive";
      readonly accessToken: string;
    }>;

export type FileProviderAccessError = Readonly<{
  readonly code: string;
  readonly retryable: boolean;
}>;

export async function resolveFileProviderAccess(
  input: Readonly<{
    readonly env: Env;
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly provider: FileProvider;
    readonly fetcher: typeof fetch;
    readonly storeCredential: FileProviderCredentialStore;
    readonly now: number;
  }>,
): Promise<Result<FileProviderAccess, FileProviderAccessError>> {
  const connection = await readActiveFileConnection(input);
  if (!connection.ok) {
    return connection;
  }
  const credential = await resolveProviderManifestCredential({
    db: input.db,
    keys: input.env,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    provider: connection.value.provider,
    environment: connection.value.environment,
    providerAccountId: connection.value.providerAccountId,
    credentialRef: connection.value.credentialRef,
  });
  if (!credential.ok || credential.value.kind !== "oauth_tokens") {
    return unavailable("file_provider_credential_unavailable", false);
  }
  switch (connection.value.provider) {
    case "dropbox":
      return refreshDropboxConnection(
        input,
        connection.value,
        credential.value,
      );
    case "google_drive":
      return refreshGoogleDriveConnection(
        input,
        connection.value,
        credential.value,
      );
  }
}

async function readActiveFileConnection(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly provider: FileProvider;
  }>,
): Promise<Result<ActiveFileConnection, FileProviderAccessError>> {
  const row = await input.db
    .prepare(
      `SELECT account.provider AS provider,
            account.provider_account_id AS providerAccountId,
            account.environment AS environment,
            connection.credential_ref AS credentialRef
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
        AND connection.provider = account.provider
        AND connection.environment = account.environment
        AND connection.lifecycle = 'active'
        AND connection.authority_kind = 'connection_credential'
      WHERE account.organisation_id = ?
        AND account.integration_account_id = ?
        AND account.provider = ?
        AND account.lifecycle = 'active'
      LIMIT 1`,
    )
    .bind(input.organisationId, input.integrationAccountId, input.provider)
    .first<{
      readonly provider: unknown;
      readonly providerAccountId: unknown;
      readonly environment: unknown;
      readonly credentialRef: unknown;
    }>();
  if (
    row === null ||
    (row.provider !== "dropbox" && row.provider !== "google_drive") ||
    typeof row.providerAccountId !== "string" ||
    row.providerAccountId.length === 0 ||
    (row.environment !== "development" && row.environment !== "production") ||
    typeof row.credentialRef !== "string"
  ) {
    return unavailable("file_provider_connection_inactive", false);
  }
  const credentialRef = parseVaultHandle(row.credentialRef);
  if (!credentialRef.ok) {
    return unavailable("file_provider_credential_reference_invalid", false);
  }
  return {
    ok: true,
    value: {
      provider: row.provider,
      providerAccountId: row.providerAccountId,
      environment: row.environment,
      credentialRef: credentialRef.value,
    },
  };
}

async function refreshDropboxConnection(
  input: Readonly<{
    readonly env: Env;
    readonly organisationId: OrganisationId;
    readonly fetcher: typeof fetch;
    readonly storeCredential: FileProviderCredentialStore;
    readonly now: number;
  }>,
  connection: VariantBy<ActiveFileConnection, "provider", "dropbox">,
  tokens: VaultOAuthTokens,
): Promise<Result<FileProviderAccess, FileProviderAccessError>> {
  const clientId = configuredValue(input.env.DROPBOX_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(input.env.DROPBOX_OAUTH_CLIENT_SECRET);
  if (clientId === null || clientSecret === null) {
    return unavailable("file_provider_configuration_missing", false);
  }
  const refreshed = await refreshDropboxAccessToken({
    configuration: { clientId, clientSecret },
    refreshToken: tokens.refreshToken,
    accountId: connection.providerAccountId,
    fetcher: input.fetcher,
  });
  if (!refreshed.ok) {
    return unavailable(refreshed.error.code, refreshed.error.retryable);
  }
  const identity = await readDropboxAccount({
    accessToken: refreshed.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok) {
    return unavailable(identity.error.code, identity.error.retryable);
  }
  if (identity.value.accountId !== connection.providerAccountId) {
    return unavailable("file_provider_identity_mismatch", false);
  }
  const stored = await input.storeCredential({
    credentialRef: connection.credentialRef,
    tokens: {
      kind: "oauth_tokens",
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
      expiry: {
        kind: "expires",
        expiresAt: input.now + refreshed.value.expiresInSeconds * 1_000,
      },
    },
    now: input.now,
  });
  if (!stored) {
    return unavailable("file_provider_credential_store_failed", true);
  }
  return {
    ok: true,
    value: {
      kind: "dropbox",
      accessToken: refreshed.value.accessToken,
      homeNamespaceId: identity.value.homeNamespaceId,
    },
  };
}

async function refreshGoogleDriveConnection(
  input: Readonly<{
    readonly env: Env;
    readonly organisationId: OrganisationId;
    readonly fetcher: typeof fetch;
    readonly storeCredential: FileProviderCredentialStore;
    readonly now: number;
  }>,
  connection: VariantBy<ActiveFileConnection, "provider", "google_drive">,
  tokens: VaultOAuthTokens,
): Promise<Result<FileProviderAccess, FileProviderAccessError>> {
  const clientId = configuredValue(input.env.GDRIVE_OAUTH_CLIENT_ID);
  const clientSecret = configuredValue(input.env.GDRIVE_OAUTH_CLIENT_SECRET);
  if (clientId === null || clientSecret === null) {
    return unavailable("file_provider_configuration_missing", false);
  }
  const refreshed = await refreshGoogleDriveAccessToken({
    configuration: { clientId, clientSecret },
    refreshToken: tokens.refreshToken,
    scopes: GOOGLE_DRIVE_REQUIRED_SCOPES,
    fetcher: input.fetcher,
  });
  if (!refreshed.ok) {
    return unavailable(refreshed.error.code, refreshed.error.retryable);
  }
  const identity = await readGoogleDriveIdentity({
    accessToken: refreshed.value.accessToken,
    fetcher: input.fetcher,
  });
  if (!identity.ok) {
    return unavailable(identity.error.code, identity.error.retryable);
  }
  if (identity.value.permissionId !== connection.providerAccountId) {
    return unavailable("file_provider_identity_mismatch", false);
  }
  const stored = await input.storeCredential({
    credentialRef: connection.credentialRef,
    tokens: {
      kind: "oauth_tokens",
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
      expiry: {
        kind: "expires",
        expiresAt: input.now + refreshed.value.expiresInSeconds * 1_000,
      },
    },
    now: input.now,
  });
  if (!stored) {
    return unavailable("file_provider_credential_store_failed", true);
  }
  return {
    ok: true,
    value: { kind: "google_drive", accessToken: refreshed.value.accessToken },
  };
}

function unavailable(
  code: string,
  retryable: boolean,
): Result<never, FileProviderAccessError> {
  return { ok: false, error: { code, retryable } };
}

export async function storeFilePlacementCredential(
  env: Env,
  scope: OrganisationExecutionScope,
  input: Parameters<FileProviderCredentialStore>[0],
): Promise<boolean> {
  const stored = await storeOrganisationPlacementVaultSecret({
    scope,
    keys: env,
    handle: input.credentialRef,
    secret: input.tokens,
    now: input.now,
  });
  return stored.ok;
}
