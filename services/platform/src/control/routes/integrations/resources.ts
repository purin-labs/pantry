import { resolveCommerceMerchant } from "../../../commerce/square-link";
import { runtimeFetch } from "../../../runtime-fetch";
import {
  fetchWithOrganisationPlacement,
  OrganisationExecutionScope,
} from "../../../organisation-execution-scope";
import type { Env } from "../../../env";
import { resolveActiveSlackOrganisationCredential } from "../../../credential-vault";
import { resolveUser } from "../../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  readControlMutationReplay,
  type ControlMutationReceiptScope,
} from "../../../data/control-mutation";
import {
  resolveActiveProviderAccountContext,
  resolveIntegrationAccount,
} from "../../../data/integration-account";
import { buildOnboardingProjection } from "../../../data/onboarding-projection";
import {
  listProviderResourcePage,
  refreshProviderResourceSnapshot,
  type DiscoveredProviderResource,
} from "../../../data/provider-resource";
import { discoverFileResources } from "../../../context/files";
import { parseIntegrationAccountId, parseWorkspaceId } from "../../../ids";
import {
  resolveFileProviderAccess,
  storeFilePlacementCredential,
} from "../../../provider-workflows/file-context-credential";
import { configuredValue } from "../../../provider-adapters/authorization";
import { discoverSlackChannels } from "../../../provider-adapters/slack";
import { discoverSquareTerminalResources } from "../../../provider-adapters/square";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";
import { controlCausationId } from "../../mutation";
import { mutationProjectionResponse } from "../../mutation-projection";
import { resolveConfiguredSlackInstallationIdentity } from "../../../slack/installation-identity";
import { assertNever } from "@seams/std";
import { account } from "../integrations";
import { providerErrorStatus } from "./provider-start";

export async function handleAccountResources(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  integrationAccountIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  const account = await resolveIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
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
    integrationAccountId: integrationAccountId.value,
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
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok)
    return controlError("integration_account_not_found", 404);
  const account = await resolveIntegrationAccount({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
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
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  if (!integrationAccountId.ok) {
    return controlError("integration_account_not_found", 404);
  }
  const body = await readJsonRecord(request);
  if (!body.ok || Object.keys(body.value).length !== 0) {
    return controlError("provider_resource_refresh_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: true,
  });
  if (!boundary.ok || boundary.value.kind !== "configuration_versioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/accounts/${integrationAccountId.value}/resources/refresh`,
    operation: "provider.resource.refresh",
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return mutationProjectionResponse(
      authorized.executionScope.database,
      authorized.organisationId,
      authorized.membership,
      replay.receipt,
    );
  }
  const context = await resolveActiveProviderAccountContext({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    integrationAccountId: integrationAccountId.value,
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
        deploymentProfile: env.SATYR_DEPLOYMENT_PROFILE,
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
        integrationAccountId: integrationAccountId.value,
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
    integrationAccountId: integrationAccountId.value,
    provider,
    environment: context.value.account.environment,
    resources,
    mutation: {
      boundary: boundary.value,
      scope,
      identity: newControlMutationIdentity({
        portalSubjectHash: await hashPortalSubject(
          identity.issuer,
          identity.subject,
        ),
        causationId: controlCausationId(request),
        now,
      }),
    },
    now,
  });
  if (!refreshed.ok) {
    return controlError(
      refreshed.error.code,
      refreshed.error.code === "organisation_not_found" ? 404 : 409,
    );
  }
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) {
    throw new Error("provider resource refresh projection is missing");
  }
  return controlJson({
    kind: "success",
    projection,
    receipt: {
      receipt_id: refreshed.value.receiptId,
      organisation_id: authorized.organisationId,
      integration_account_id: integrationAccountId.value,
      snapshot_revision: refreshed.value.snapshotRevision,
      resource_count: refreshed.value.resourceCount,
      configuration_version: refreshed.value.configurationVersion,
      projection_revision: refreshed.value.projectionRevision,
    },
  });
}
