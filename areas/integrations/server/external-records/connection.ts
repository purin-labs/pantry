import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import {
  createActiveConnectedIntegration,
  type ActiveIntegrationAccount,
} from "@purin-labs/connections/data/integration-account";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/index";
import { storeVaultSecret } from "@purin-labs/authority/credential-vault/index";
import {
  validateAirtableBaseAccess,
  validateExternalProviderToken,
  type ExternalRecordsError,
  type ExternalRecordsProvider,
} from "@purin-labs/connections/external-records/records";
import type { Result } from "@purin-labs/kernel/result";

type ExternalRecordsConnectionInput = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  environment: OrganisationEnvironment;
  userId: UserId;
  provider: ExternalRecordsProvider;
  token: string;
  airtableBaseId: string | null;
  now: number;
  fetcher: typeof fetch;
}>;

type ExternalRecordsConnection = Readonly<{
  account: ActiveIntegrationAccount;
  capabilities: readonly string[];
}>;

type ExternalRecordsConnectionError =
  | ExternalRecordsError
  | { readonly code: "external_records_base_required" }
  | { readonly code: "external_records_vault_handle_invalid" }
  | { readonly code: "external_records_secret_store_failed" };

export async function connectExternalRecordsIntegration(
  input: ExternalRecordsConnectionInput,
): Promise<Result<ExternalRecordsConnection, ExternalRecordsConnectionError>> {
  const token = input.token.trim();
  const validated = await validateExternalProviderToken({
    provider: input.provider,
    token,
    fetcher: input.fetcher,
  });
  if (!validated.ok) return validated;
  if (input.provider === "airtable") {
    if (input.airtableBaseId === null) {
      return { ok: false, error: { code: "external_records_base_required" } };
    }
    const baseAccess = await validateAirtableBaseAccess({
      token,
      baseId: input.airtableBaseId,
      fetcher: input.fetcher,
    });
    if (!baseAccess.ok) return baseAccess;
  }
  const handle = externalRecordsVaultHandle(
    input.provider,
    input.scope.organisationId,
    validated.value.providerAccountId,
  );
  if (handle === null) {
    return {
      ok: false,
      error: { code: "external_records_vault_handle_invalid" },
    };
  }
  const stored = await storeVaultSecret({
    db: input.scope.database,
    keys: input.env,
    organisationId: input.scope.organisationId,
    handle,
    secret: { kind: "bearer", value: token },
    now: input.now,
  });
  if (!stored.ok) {
    return {
      ok: false,
      error: { code: "external_records_secret_store_failed" },
    };
  }
  const capabilities = externalRecordsCapabilities(
    input.provider,
    input.airtableBaseId,
  );
  const connected = await createActiveConnectedIntegration(
    input.scope.database,
    {
      organisationId: input.scope.organisationId,
      createdByUserId: input.userId,
      providerSubjectId: validated.value.providerAccountId,
      environment: input.environment,
      now: input.now,
      provider: input.provider,
      authMode: "api_key",
      authority: { kind: "connection_credential", credentialRef: handle },
      grantedScopes: validated.value.grantedScopes,
      providerAccountId: validated.value.providerAccountId,
      accountKind: "resource",
      displayName: validated.value.displayName,
      capabilities,
      audiencePolicy: { kind: "operator" },
      retentionPolicy: { kind: "organisation_default" },
    },
  );
  return { ok: true, value: { account: connected.account, capabilities } };
}

function externalRecordsVaultHandle(
  provider: ExternalRecordsProvider,
  organisationId: OrganisationId,
  providerAccountId: string,
) {
  const accountSlug = providerAccountId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/gu, "-");
  const parsed = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:${provider}:${accountSlug}`,
  );
  return parsed.ok ? parsed.value : null;
}

function externalRecordsCapabilities(
  provider: ExternalRecordsProvider,
  airtableBaseId: string | null,
): readonly string[] {
  switch (provider) {
    case "airtable":
      if (airtableBaseId === null)
        throw new Error("airtable base ID is required");
      return [`airtable.records.list:${airtableBaseId}`];
    case "notion":
      return ["notion.search"];
  }
}
