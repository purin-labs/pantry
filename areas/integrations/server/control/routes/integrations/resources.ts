import { resolveCommerceMerchant } from "../../../../../../services/platform/src/commerce/contract/square-link";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import {
  fetchWithOrganisationPlacement,
  OrganisationExecutionScope,
} from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { resolveActiveSlackOrganisationCredential } from "@purin-labs/authority/credential-vault/index";
import {
  resolveActiveProviderAccountContext,
  resolveIntegrationAccount,
} from "@purin-labs/connections/data/integration-account";
import {
  listProviderResourcePage,
  refreshProviderResourceSnapshot,
  type DiscoveredProviderResource,
} from "@purin-labs/connections/data/provider-resource";
import { discoverFileResources } from "@purin-labs/agent/context/files/index";
import {
  parseIntegrationAccountId,
  parseWorkspaceId,
} from "@purin-labs/kernel/ids";
import {
  resolveFileProviderAccess,
  storeFilePlacementCredential,
} from "@purin-labs/agent/provider-workflows/file-context-credential";
import { configuredValue } from "@purin-labs/connections/provider-adapters/authorization";
import { discoverSlackChannels } from "../../../provider-adapters/slack";
import { discoverSquareTerminalResources } from "../../../provider-adapters/square";
import {
  admitUserMutation,
  controlMutationIdentity,
  projectionReplay,
  projectionResponse,
} from "@purin-labs/control/worker/admission/control-mutation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import { assertNever } from "@purin-labs/std";
import { account } from "../integrations";
import { authorizeAccountRequest } from "./account-request";
import { providerErrorStatus } from "./provider-start";

export async function handleAccountResources(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "GET",
    "viewer",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const account = await resolveIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
  });
  if (!account.ok) {
    return controlError(account.error.code, 404);
  }
  const url = new URL(request.url);
  const query = url.searchParams.get("query") ?? "";
  const cursor = url.searchParams.get("cursor");
  const page = await listProviderResourcePage({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
    query,
    cursor,
    now: Date.now(),
  });
  return page.ok
    ? controlJson({ kind: "success", page: page.value })
    : controlError(
        page.error.code,
        page.error.code === "provider_resource_query_invalid" ? 422 : 404,
      );
}

export async function handleAccountFileResources(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    authorized.organisationId,
  );
  if (!execution.ok) return controlError(execution.error.code, 409);
  const scope = execution.value;
  const fetcher = fetchWithOrganisationPlacement.bind(
    null,
    scope,
    runtimeFetch,
  );
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok)
    return controlError("integration_account_not_found", 404);
  const account = await resolveIntegrationAccount({
    db: scope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
  });
  if (!account.ok) return controlError(account.error.code, 404);
  if (
    account.value.lifecycle.kind !== "active" ||
    (account.value.provider !== "dropbox" &&
      account.value.provider !== "google_drive")
  ) {
    return controlError("provider_account_ineligible", 409);
  }
  const access = await resolveFileProviderAccess({
    env,
    db: scope.database,
    storeCredential: storeFilePlacementCredential.bind(null, env, scope),
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
    provider: account.value.provider,
    fetcher,
    now: Date.now(),
  });
  if (!access.ok) return controlError(access.error.code, 409);
  const url = new URL(request.url);
  const discovered = await discoverFileResources({
    access: access.value,
    path: url.searchParams.get("path") ?? "",
    query: url.searchParams.get("query") ?? "",
    cursor: url.searchParams.get("cursor"),
    fetcher,
  });
  if (!(await scope.isActive()))
    return controlError("organisation_execution_authority_inactive", 409);
  if (discovered.ok) return controlJson({ ok: true, page: discovered.value });
  switch (discovered.error.code) {
    case "file_resource_discovery_invalid":
      return controlError(discovered.error.code, 422);
    case "file_resource_picker_required":
      return controlError(discovered.error.code, 409);
    case "file_resource_discovery_failed":
      return controlError(discovered.error.code, 502);
    default:
      return assertNever(discovered.error.code);
  }
}

export async function handleAccountDrivePickerConfig(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "GET",
    "admin",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const account = await resolveIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
  });
  if (!account.ok) return controlError(account.error.code, 404);
  if (
    account.value.provider !== "google_drive" ||
    account.value.lifecycle.kind !== "active"
  ) {
    return controlError("provider_account_ineligible", 409);
  }
  const clientId = configuredValue(env.GDRIVE_OAUTH_CLIENT_ID);
  const apiKey = configuredValue(env.GDRIVE_PICKER_API_KEY);
  const appId = configuredValue(env.GDRIVE_PICKER_APP_ID);
  if (clientId === null || apiKey === null || appId === null) {
    return controlError("google_drive_picker_unavailable", 503);
  }
  return controlJson({
    ok: true,
    config: {
      clientId,
      apiKey,
      appId,
      expectedPermissionId: account.value.providerAccountId,
      scope: "https://www.googleapis.com/auth/drive.file",
    },
  });
}

export async function handleRefreshAccountResources(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  const target = await authorizeAccountRequest(
    request,
    env,
    organisationIdRaw,
    integrationAccountIdRaw,
    "POST",
    "admin",
  );
  if (target instanceof Response) return target;
  const { authorized, integrationAccountId } = target;
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("provider_resource_refresh_invalid", 422);
  }
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "configuration_versioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId}/resources/refresh`,
    operation: "provider.resource.refresh",
    replay: projectionReplay(authorized),
  });
  if (admitted instanceof Response) return admitted;
  const context = await resolveActiveProviderAccountContext({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
  });
  if (!context.ok) {
    return controlError(
      context.error.code,
      context.error.code === "integration_account_not_found" ? 404 : 409,
    );
  }
  let provider: "slack" | "square";
  let resources: readonly DiscoveredProviderResource[];
  switch (context.value.account.provider) {
    case "slack": {
      if (context.value.account.accountKind !== "workspace") {
        return controlError("provider_account_ineligible", 409);
      }
      const workspaceId = parseWorkspaceId(
        context.value.account.providerAccountId,
      );
      if (!workspaceId.ok)
        return controlError("provider_account_ineligible", 409);
      const installationIdentity = resolveConfiguredSlackInstallationIdentity({
        deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
        appId: env.SLACK_APP_ID,
      });
      if (!installationIdentity.ok) {
        return controlError("provider_account_ineligible", 409);
      }
      const credential = await resolveActiveSlackOrganisationCredential({
        env,
        keys: env,
        installationIdentity: installationIdentity.value,
        organisationId: authorized.organisationId,
        integrationAccountId,
        workspaceId: workspaceId.value,
      });
      if (!credential.ok || credential.value.kind !== "bearer") {
        return controlError("provider_credential_unavailable", 409);
      }
      const discovered = await discoverSlackChannels({
        fetcher: runtimeFetch,
        accessToken: credential.value.value,
        providerAccountId: workspaceId.value,
      });
      if (!discovered.ok) {
        return controlError(
          discovered.error.code,
          providerErrorStatus(discovered.error.code),
        );
      }
      provider = "slack";
      resources = discovered.value;
      break;
    }
    case "square": {
      // Commerce holds the connection and reads Square (Plan 80 step 4).
      const square = await resolveCommerceMerchant(
        env,
        authorized.executionScope,
        authorized.organisationId,
      );
      if (square === null) {
        return controlError("provider_credential_unavailable", 409);
      }
      const discovered = await discoverSquareTerminalResources({
        square,
        providerAccountId: context.value.account.providerAccountId,
        observedAt: new Date().toISOString(),
      });
      if (!discovered.ok) {
        return controlError(
          discovered.error.code,
          providerErrorStatus(discovered.error.code),
        );
      }
      provider = "square";
      resources = discovered.value;
      break;
    }
    default:
      return controlError("provider_account_ineligible", 409);
  }
  const now = Date.now();
  const refreshed = await refreshProviderResourceSnapshot({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId,
    provider,
    environment: context.value.account.environment,
    resources,
    mutation: {
      boundary: admitted.boundary,
      scope: admitted.scope,
      identity: await controlMutationIdentity(request, admitted.user, now),
    },
    now,
  });
  if (!refreshed.ok) {
    return controlError(
      refreshed.error.code,
      refreshed.error.code === "organisation_not_found" ? 404 : 409,
    );
  }
  return projectionResponse(
    authorized,
    "provider resource refresh projection is missing",
    {
      receipt: {
        receipt_id: refreshed.value.receiptId,
        organisation_id: authorized.organisationId,
        integration_account_id: integrationAccountId,
        snapshot_revision: refreshed.value.snapshotRevision,
        resource_count: refreshed.value.resourceCount,
        configuration_version: refreshed.value.configurationVersion,
        projection_revision: refreshed.value.projectionRevision,
      },
    },
  );
}
