import { prepareInitialPlacementActivation } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { selectOrganisationHomePlacement } from "@purin-labs/control/worker/home-region";
import { SLACK_INSTALL_REDIRECT_PATH } from "../gateway-routing/slack";
import {
  createOrganisationInstallPreservingExistingInstallModel,
  listInstallLiveness,
  type InstallLivenessRecord,
} from "@purin-labs/tenancy/data/organisation";
import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
} from "@purin-labs/kernel/http";
import {
  newRequestId,
  newSlackInstallationId,
  newSlackOrganisationConnectionId,
  parseSlackAppId,
  parseWorkspaceId,
  type SlackAppId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  admitSlackInstallOrganisation,
  type SlackInstallOrganisationAdmissionError,
} from "../slack/install-organisation";
import { resolveConfiguredSlackInstallationIdentity } from "@purin-labs/connections/slack/installation-identity";
import {
  createSlackInstallation,
  createSlackOrganisationConnection,
} from "@purin-labs/authority/slack/installation-store";
import {
  parseVaultHandle,
  storeVaultSecret,
  type VaultHandle,
} from "@purin-labs/authority/credential-vault/index";
import {
  assertNever,
  encodeBase64Url,
  errorMessage,
  isRecord,
} from "@purin-labs/std";
import { ensureOrganisationObject } from "../gateway/support";
import {
  isLocalDebugRequest,
  parsePublicServiceUrl,
  readRuntimeSecret,
} from "@purin-labs/control/worker/gateway/request-helpers";

export const SLACK_INSTALL_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
] as const;

type SlackOAuthAccessTokenResponse = {
  ok?: unknown;
  access_token?: unknown;
  app_id?: unknown;
  scope?: unknown;
  team?: unknown;
  error?: unknown;
};

type SlackOAuthInstall = {
  appId: SlackAppId;
  teamId: WorkspaceId;
  teamName: string;
  botToken: string;
  scopes: readonly string[];
};

type SlackInstallLivenessStatus =
  "receiving" | "silent" | "never_seen" | "inactive";

type SlackInstallLiveness = InstallLivenessRecord & {
  status: SlackInstallLivenessStatus;
  silenceMs: number | null;
};

const SLACK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export async function handleSlackInstallStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const requestId = newRequestId();
  const clientId = readRuntimeSecret(env.SLACK_CLIENT_ID);
  const stateSecret = readRuntimeSecret(env.SLACK_OAUTH_STATE_SECRET);
  const publicOrigin = parsePublicServiceUrl(env.PANTRY_PUBLIC_ORIGIN);

  if (!clientId.ok || !stateSecret.ok) {
    traceWarn("integration_gateway.slack_install_start.missing_secret", {
      requestId,
    });
    return errorResponse(
      "missing_slack_oauth_secret",
      "Slack OAuth is not configured.",
      500,
    );
  }

  if (publicOrigin === null) {
    return errorResponse(
      "public_origin_invalid",
      "Public Worker origin is invalid.",
      500,
    );
  }

  const state = await createSlackOAuthState({
    secret: stateSecret.value,
    issuedAt: Date.now(),
    nonce: crypto.randomUUID(),
  });
  const authorizeUrl = slackAuthorizeUrl({
    origin: publicOrigin,
    clientId: clientId.value,
    state,
  });

  return Response.redirect(authorizeUrl, 302);
}

export async function handleSlackInstall(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  const requestId = newRequestId();
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";

  if (code.length === 0) {
    return errorResponse(
      "missing_slack_oauth_code",
      "Slack OAuth code is required.",
      400,
    );
  }

  const clientId = readRuntimeSecret(env.SLACK_CLIENT_ID);
  const clientSecret = readRuntimeSecret(env.SLACK_CLIENT_SECRET);
  const configuredAppId = parseSlackAppId(env.SLACK_APP_ID ?? "");
  const stateSecret = readRuntimeSecret(env.SLACK_OAUTH_STATE_SECRET);
  const publicOrigin = parsePublicServiceUrl(env.PANTRY_PUBLIC_ORIGIN);

  if (
    !clientId.ok ||
    !clientSecret.ok ||
    !stateSecret.ok ||
    !configuredAppId.ok
  ) {
    traceWarn("integration_gateway.slack_install.missing_client_secret", {
      requestId,
    });
    return errorResponse(
      "missing_slack_oauth_secret",
      "Slack OAuth is not configured.",
      500,
    );
  }

  if (publicOrigin === null) {
    return errorResponse(
      "public_origin_invalid",
      "Public Worker origin is invalid.",
      500,
    );
  }

  const verifiedState = await verifySlackOAuthState({
    secret: stateSecret.value,
    state,
    now: Date.now(),
  });

  if (!verifiedState.ok) {
    traceWarn("integration_gateway.slack_install.invalid_state", {
      requestId,
      reason: verifiedState.error,
    });
    return errorResponse(
      "invalid_slack_oauth_state",
      "Slack OAuth state is invalid.",
      400,
    );
  }

  const install = await exchangeSlackOAuthCode({
    code,
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    redirectUri: slackInstallRedirectUri(publicOrigin),
  });

  if (!install.ok) {
    traceWarn("integration_gateway.slack_install.exchange_failed", {
      requestId,
      reason: install.error,
    });
    return errorResponse(
      "slack_oauth_exchange_failed",
      "Slack OAuth exchange failed.",
      502,
    );
  }
  if (install.value.appId !== configuredAppId.value) {
    return errorResponse(
      "slack_app_identity_mismatch",
      "Slack OAuth returned a different application identity.",
      409,
    );
  }

  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.PANTRY_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) {
    return errorResponse(
      installationIdentity.error.code,
      "Slack installation identity is unavailable.",
      503,
    );
  }

  const now = Date.now();
  // The installer's browser makes this request, so its location is theirs.
  const placement = selectOrganisationHomePlacement(env, request, undefined);

  if (!placement.ok) {
    traceWarn("integration_gateway.slack_install.placement_invalid", {
      requestId,
      code: placement.error.code,
    });
    return errorResponse(
      "organisation_placement_configuration_invalid",
      "Organisation placement configuration is invalid.",
      503,
    );
  }

  const admission = await admitSlackInstallOrganisation({
    env,
    placement: placement.value,
    workspaceId: install.value.teamId,
    installationIdentity: installationIdentity.value,
    teamName: install.value.teamName,
    occurredAt: now,
  });
  if (!admission.ok) {
    return slackInstallAdmissionErrorResponse(admission.error);
  }

  const organisationId = admission.value.organisationId;
  const handle = slackBotTokenHandle(install.value.teamId);

  const stored = await storeVaultSecret({
    db: admission.value.database,
    keys: env,
    organisationId,
    handle,
    secret: { kind: "bearer", value: install.value.botToken },
    now,
  });

  if (!stored.ok) {
    traceWarn("integration_gateway.slack_install.vault_store_failed", {
      requestId,
      organisation_id: organisationId,
      reason: stored.error.code,
    });
    return errorResponse(
      "slack_bot_token_store_failed",
      "Slack bot token could not be stored.",
      502,
    );
  }

  const record = await createOrganisationInstallPreservingExistingInstallModel(
    admission.value.database,
    env.DB,
    {
      organisationId,
      name: install.value.teamName,
      surfaceKind: "slack",
      workspaceId: install.value.teamId,
      installModel: "unlisted",
      botTokenRef: handle,
      scopes: install.value.scopes,
      placement: admission.value.placement,
      createdAt: now,
      installedAt: now,
    },
  );

  await prepareInitialPlacementActivation(env.DB, {
    organisationId,
    fenceToken: admission.value.fenceToken,
    activatedAt: now,
  }).run();
  const installedScope = await OrganisationExecutionScope.resolveAtPlacement(
    env,
    organisationId,
    admission.value.placement,
  );
  if (!installedScope.ok) {
    return errorResponse(
      installedScope.error.code,
      "Organisation placement publication is pending.",
      503,
    );
  }

  const installationId = newSlackInstallationId();
  await createSlackInstallation(env.DB, {
    installationId,
    environment: installationIdentity.value.environment,
    appId: install.value.appId,
    workspaceId: install.value.teamId,
    credentialOrganisationId: organisationId,
    botTokenRef: handle,
    installModel: "unlisted",
    scopes: install.value.scopes,
    installedAt: now,
  });
  await createSlackOrganisationConnection(env, {
    connectionId: newSlackOrganisationConnectionId(),
    installationId,
    organisationId,
    integrationAccountId: record.integrationAccountId,
    connectedAt: now,
  });

  await ensureOrganisationObject(env, record);

  traceLog("integration_gateway.slack_install.created", {
    requestId,
    organisation_id: record.organisationId,
    workspace_id: record.workspaceId,
    install_model: record.installModel,
  });

  return jsonResponse({ ok: true, organisationInstall: record });
}

function slackInstallAdmissionErrorResponse(
  error: SlackInstallOrganisationAdmissionError,
): Response {
  switch (error.code) {
    case "slack_install_existing_workspace_requires_organisation_flow":
      return errorResponse(
        error.code,
        "Reconnect this Slack workspace from its Purin Pantry organisation portal.",
        409,
      );
    case "slack_install_bootstrap_state_invalid":
      return errorResponse(
        error.code,
        "Slack installation organisation state is unavailable.",
        503,
      );
    default:
      return assertNever(error);
  }
}

export async function handleSlackInstallLiveness(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }

  if (!isLocalDebugRequest(request)) {
    return notFound();
  }

  const now = Date.now();
  const staleAfterMs = readStaleAfterMs(url);
  const installs: Awaited<ReturnType<typeof listInstallLiveness>>[number][] =
    [];
  for (const database of configuredOrganisationDatabases(env)) {
    const candidates = await listInstallLiveness({
      db: database,
      surfaceKind: "slack",
    });
    for (const candidate of candidates) {
      const execution = await OrganisationExecutionScope.resolve(
        env,
        candidate.organisationId,
      );
      if (!execution.ok) {
        return errorResponse(
          execution.error.code,
          "The organisation region is unavailable.",
          503,
        );
      }
      if (execution.value.database === database) installs.push(candidate);
    }
  }

  return jsonResponse({
    ok: true,
    now,
    staleAfterMs,
    installs: installs.map((install) =>
      installLiveness(install, now, staleAfterMs),
    ),
  });
}

async function exchangeSlackOAuthCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<Result<SlackOAuthInstall, string>> {
  const form = new URLSearchParams();
  form.set("client_id", input.clientId);
  form.set("client_secret", input.clientSecret);
  form.set("code", input.code);
  form.set("redirect_uri", input.redirectUri);

  try {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const parsed = await response.json<SlackOAuthAccessTokenResponse>();

    return parseSlackOAuthAccessTokenResponse(parsed);
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function parseSlackOAuthAccessTokenResponse(
  response: SlackOAuthAccessTokenResponse,
): Result<SlackOAuthInstall, string> {
  if (response.ok !== true) {
    return { ok: false, error: slackApiError(response.error) };
  }

  if (
    typeof response.access_token !== "string" ||
    response.access_token.length === 0
  ) {
    return { ok: false, error: "missing_access_token" };
  }

  if (typeof response.app_id !== "string") {
    return { ok: false, error: "missing_app_id" };
  }
  const appId = parseSlackAppId(response.app_id);
  if (!appId.ok) {
    return { ok: false, error: "invalid_app_id" };
  }

  if (!isRecord(response.team)) {
    return { ok: false, error: "missing_team" };
  }

  const teamIdRaw = response.team.id;
  const teamNameRaw = response.team.name;

  if (typeof teamIdRaw !== "string" || typeof teamNameRaw !== "string") {
    return { ok: false, error: "invalid_team" };
  }

  const teamId = parseWorkspaceId(teamIdRaw);

  if (!teamId.ok) {
    return { ok: false, error: "invalid_team_id" };
  }

  return {
    ok: true,
    value: {
      appId: appId.value,
      teamId: teamId.value,
      teamName: teamNameRaw,
      botToken: response.access_token,
      scopes: slackOAuthScopes(response.scope),
    },
  };
}

function slackApiError(error: unknown): string {
  return typeof error === "string" && error.length > 0
    ? error
    : "slack_api_error";
}

function slackOAuthScopes(raw: unknown): readonly string[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }

  return raw.split(",").map(trimString).filter(nonEmptyString);
}

function slackAuthorizeUrl(input: {
  origin: string;
  clientId: string;
  state: string;
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", SLACK_INSTALL_SCOPES.join(","));
  url.searchParams.set(
    "redirect_uri",
    `${input.origin}${SLACK_INSTALL_REDIRECT_PATH}`,
  );
  url.searchParams.set("state", input.state);

  return url.toString();
}

async function createSlackOAuthState(input: {
  secret: string;
  issuedAt: number;
  nonce: string;
}): Promise<string> {
  const payload = `${input.issuedAt}.${input.nonce}`;
  const signature = await signSlackOAuthState(input.secret, payload);

  return `${payload}.${signature}`;
}

async function verifySlackOAuthState(input: {
  secret: string;
  state: string;
  now: number;
}): Promise<Result<true, string>> {
  const parsed = parseSlackOAuthState(input.state);

  if (!parsed.ok) {
    return parsed;
  }

  if (input.now - parsed.value.issuedAt > SLACK_OAUTH_STATE_TTL_MS) {
    return { ok: false, error: "state_expired" };
  }

  if (parsed.value.issuedAt > input.now + 60_000) {
    return { ok: false, error: "state_from_future" };
  }

  const expected = await signSlackOAuthState(
    input.secret,
    parsed.value.payload,
  );

  if (!timingSafeEqualString(parsed.value.signature, expected)) {
    return { ok: false, error: "state_signature_mismatch" };
  }

  return { ok: true, value: true };
}

function parseSlackOAuthState(
  state: string,
): Result<{ issuedAt: number; payload: string; signature: string }, string> {
  const parts = state.split(".");
  const [issuedAtRaw, nonce, signature] = parts;

  if (
    parts.length !== 3 ||
    issuedAtRaw === undefined ||
    nonce === undefined ||
    signature === undefined ||
    nonce.length === 0 ||
    signature.length === 0
  ) {
    return { ok: false, error: "state_malformed" };
  }

  const issuedAt = Number.parseInt(issuedAtRaw, 10);

  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    return { ok: false, error: "state_malformed" };
  }

  return {
    ok: true,
    value: { issuedAt, payload: `${issuedAtRaw}.${nonce}`, signature },
  };
}

async function signSlackOAuthState(
  secret: string,
  payload: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  return encodeBase64Url(new Uint8Array(signature));
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);

  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function readStaleAfterMs(url: URL): number {
  const raw = url.searchParams.get("staleAfterMs");

  if (raw === null) {
    return 10 * 60 * 1000;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value) || value <= 0) {
    return 10 * 60 * 1000;
  }

  return value;
}

function installLiveness(
  install: InstallLivenessRecord,
  now: number,
  staleAfterMs: number,
): SlackInstallLiveness {
  const silenceMs =
    install.lastEventReceivedAt === null
      ? null
      : Math.max(0, now - install.lastEventReceivedAt);

  return {
    ...install,
    status: installLivenessStatus(install, silenceMs, staleAfterMs),
    silenceMs,
  };
}

function installLivenessStatus(
  install: InstallLivenessRecord,
  silenceMs: number | null,
  staleAfterMs: number,
): SlackInstallLivenessStatus {
  if (install.installStatus !== "active") {
    return "inactive";
  }

  if (silenceMs === null) {
    return "never_seen";
  }

  return silenceMs > staleAfterMs ? "silent" : "receiving";
}

function trimString(value: string): string {
  return value.trim();
}

function nonEmptyString(value: string): boolean {
  return value.length > 0;
}

function slackInstallRedirectUri(publicOrigin: string): string {
  return `${publicOrigin}${SLACK_INSTALL_REDIRECT_PATH}`;
}

function slackBotTokenHandle(workspaceId: WorkspaceId): VaultHandle {
  const parsed = parseVaultHandle(
    `vault:slack:bot:${workspaceId.toLowerCase()}:${crypto.randomUUID()}`,
  );

  if (!parsed.ok) {
    throw new Error(
      `Slack workspace id did not produce a vault handle: ${workspaceId}`,
    );
  }

  return parsed.value;
}
