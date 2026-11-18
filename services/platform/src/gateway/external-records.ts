import { runtimeFetch } from "../runtime-fetch";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  readIntegrationAccountIdField,
  readStringField,
  readOrganisationIdField,
} from "../boundary";
import {
  requireConnectionCredentialAuthority,
  resolveActiveProviderAccountContext,
} from "../data/integration-account";
import { resolveOrganisationProvisioningActor } from "../data/control-plane";
import type { Env } from "../env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from "../http";
import { newRequestId } from "../ids";
import { traceLog } from "../observability";
import {
  parseExternalRecordsRead,
  readExternalRecords,
  type ExternalRecordsProvider,
} from "../external-records/records";
import { resolveActiveProviderConnectionCredential } from "../credential-vault/provider-connection-resolution";
import { connectExternalRecordsIntegration } from "../external-records/connection";
import { resolveExternalRecordsAccessToken } from "../external-records/oauth";
import {
  fieldErrorResponse,
  isAuthorizedOrganisationAdminRequest,
  jsonBodyErrorResponse,
  readOrganisationEnvironment,
} from "./support";

export async function handleConfigureExternalRecordsCredential(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }
  const body = await readJsonObject(request);
  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }
  const organisationId = readOrganisationIdField(body.value);
  const provider = readStringField(body.value, "provider");
  const token = readStringField(body.value, "token");
  const airtableBaseId = readStringField(body.value, "airtableBaseId");
  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) {
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  }
  const scope = execution.value;
  if (
    !provider.ok ||
    (provider.value !== "airtable" && provider.value !== "notion")
  ) {
    return errorResponse(
      "invalid_field",
      "External records provider is invalid.",
      422,
    );
  }
  if (!token.ok || token.value.trim().length === 0) {
    return errorResponse(
      "invalid_field",
      "External records token is invalid.",
      422,
    );
  }
  if (
    provider.value === "airtable" &&
    (!airtableBaseId.ok ||
      !/^app[A-Za-z0-9]{8,32}$/u.test(airtableBaseId.value))
  ) {
    return errorResponse("invalid_field", "Airtable base ID is invalid.", 422);
  }
  const provisioningPrincipalId = await resolveOrganisationProvisioningActor({
    db: scope.database,
    organisationId: organisationId.value,
  });
  if (provisioningPrincipalId === null) {
    return errorResponse(
      "organisation_owner_missing",
      "Organisation owner identity is unavailable.",
      409,
    );
  }
  const connected = await connectExternalRecordsIntegration({
    env,
    scope,
    environment: await readOrganisationEnvironment(
      scope.database,
      organisationId.value,
    ),
    userId: provisioningPrincipalId,
    provider: provider.value,
    token: token.value.trim(),
    airtableBaseId:
      provider.value === "airtable" && airtableBaseId.ok
        ? airtableBaseId.value
        : null,
    now: Date.now(),
    fetcher: runtimeFetch,
  });
  if (!connected.ok) {
    return errorResponse(
      connected.error.code,
      "External records connection failed.",
      422,
    );
  }
  traceLog("external_records.credential_configured", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    provider: provider.value,
    integration_account_id: connected.value.account.integrationAccountId,
  });
  return jsonResponse({
    ok: true,
    organisationId: organisationId.value,
    integrationAccountId: connected.value.account.integrationAccountId,
    provider: provider.value,
    capabilities: connected.value.capabilities,
  });
}

export async function handleReadExternalRecords(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  if (!isAuthorizedOrganisationAdminRequest(request, env)) {
    return notFound();
  }
  const body = await readJsonObject(request);
  if (!body.ok) {
    return jsonBodyErrorResponse(body.error);
  }
  const organisationId = readOrganisationIdField(body.value);
  const integrationAccountId = readIntegrationAccountIdField(body.value);
  if (!organisationId.ok) {
    return fieldErrorResponse(organisationId.error);
  }
  if (!integrationAccountId.ok) {
    return fieldErrorResponse(integrationAccountId.error);
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "Organisation region unavailable.",
      503,
    );
  const scope = execution.value;
  const context = await resolveActiveProviderAccountContext({
    db: scope.database,
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
  });
  if (!context.ok) {
    return errorResponse(
      context.error.code,
      "External records account is unavailable.",
      409,
    );
  }
  const provider = externalRecordsProvider(context.value.account.provider);
  if (provider === null) {
    return errorResponse(
      "external_records_account_invalid",
      "External records account is invalid.",
      422,
    );
  }
  const parsed = parseExternalRecordsRead(provider, body.value.request);
  if (!parsed.ok) {
    return errorResponse(
      parsed.error.code,
      "External records request is invalid.",
      422,
    );
  }
  if (
    parsed.value.kind === "airtable_records" &&
    !context.value.account.capabilities.includes("airtable.api.read") &&
    !context.value.account.capabilities.includes("airtable.records.list") &&
    !context.value.account.capabilities.includes(
      `airtable.records.list:${parsed.value.baseId}`,
    )
  ) {
    return errorResponse(
      "external_records_access_denied",
      "Airtable base is outside this connection.",
      403,
    );
  }
  const credential = await resolveActiveProviderConnectionCredential({
    db: scope.database,
    keys: env,
    context: context.value,
    expectedProvider: provider,
  });
  if (!credential.ok) {
    return errorResponse(
      "external_records_credential_invalid",
      "External records credential is unavailable.",
      503,
    );
  }
  const accessToken =
    credential.value.kind === "bearer"
      ? ({ ok: true, value: credential.value.value } as const)
      : credential.value.kind === "oauth_tokens"
        ? await resolveExternalRecordsAccessToken({
            env,
            provider,
            scope,
            handle: requireConnectionCredentialAuthority(
              context.value.connection,
            ).credentialRef,
            tokens: credential.value,
            now: Date.now(),
            fetcher: runtimeFetch,
          })
        : ({
            ok: false,
            error: { code: "provider_oauth_response_invalid" },
          } as const);
  if (!accessToken.ok) {
    return errorResponse(
      "external_records_credential_invalid",
      "External records credential is unavailable.",
      503,
    );
  }
  const result = await readExternalRecords({
    credential: accessToken.value,
    request: parsed.value,
    fetcher: runtimeFetch,
  });
  if (!result.ok) {
    const status =
      result.error.code === "external_records_access_denied"
        ? 403
        : result.error.code === "external_records_rate_limited"
          ? 429
          : 502;
    return errorResponse(
      result.error.code,
      "External records read failed.",
      status,
    );
  }
  traceLog("external_records.read", {
    requestId: newRequestId(),
    organisation_id: organisationId.value,
    integration_account_id: integrationAccountId.value,
    provider,
  });
  return jsonResponse({ ok: true, result: result.value });
}

export function externalRecordsProvider(
  provider: string,
): ExternalRecordsProvider | null {
  return provider === "airtable" || provider === "notion" ? provider : null;
}
