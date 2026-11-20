import {
  configuredValue,
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "./authorization";
import {
  providerHttpFailure,
  type ProviderCleanupAdapter,
  type ProviderCleanupResult,
  type ProviderOnboardingAdapter,
} from "../integrations/contract/provider-adapter";
import {
  newRequestId,
  parseSlackAppId,
  parseChannelId,
  parseWorkspaceId,
  type SlackAppId,
  type WorkspaceId,
} from "../ids";
import { traceWarn } from "../observability";
import type { DiscoveredProviderResource } from "../data/provider-resource";
import type { Result } from "../result";
import type { VariantBy } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";

const MANUAL_INSTRUCTION = "remove_slack_app_in_slack" as const;
export const SLACK_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "channels:read",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
] as const;

type SlackProtocolError =
  | { readonly code: "provider_oauth_response_invalid" }
  | { readonly code: "provider_scope_missing" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
      readonly requestId: string | null;
    };

type SlackInstallation = {
  readonly token: string;
  readonly appId: SlackAppId;
  readonly teamId: WorkspaceId;
  readonly teamName: string;
  readonly botUserId: string;
  readonly scopes: readonly string[];
};

export type SlackProviderIdentityObservation =
  | { readonly kind: "healthy" }
  | {
      readonly kind: "provider_rejected";
      readonly httpStatus: number;
      readonly slackError: string | null;
    }
  | {
      readonly kind: "workspace_mismatch";
      readonly expectedWorkspaceId: string;
      readonly observedWorkspaceId: string;
    }
  | { readonly kind: "invalid_response"; readonly httpStatus: number }
  | { readonly kind: "transport_failure"; readonly errorName: string };

export const slackCleanupAdapter: ProviderCleanupAdapter<"slack"> = {
  provider: "slack",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: removeSlackInstallation,
};

export const slackOnboardingAdapter: ProviderOnboardingAdapter<"slack"> = {
  provider: "slack",
  requiredScopes: SLACK_SCOPES,
  stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseSlackStartContext,
  configurationIsValid: slackConfigurationIsValid,
  authorizationSecret: slackAuthorizationSecret,
  authorizationUrl: slackAuthorizationUrl,
  scopeIsGranted: exactScopeIsGranted,
};

function parseSlackStartContext(
  raw: unknown,
): { readonly provider: "slack" } | null {
  return parseProviderOnlyStartContext("slack", raw);
}

export async function exchangeSlackAuthorizationCode(
  input: Readonly<{
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<SlackInstallation, SlackProtocolError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
  } catch {
    return exchangeFailure(503, null);
  }
  if (!response.ok) {
    return exchangeFailure(response.status, response.headers.get("request-id"));
  }
  return parseSlackInstallation(await readJson(response));
}

export function parseSlackInstallation(
  raw: unknown,
): Result<SlackInstallation, SlackProtocolError> {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    typeof raw.access_token !== "string" ||
    typeof raw.app_id !== "string" ||
    !isRecord(raw.team) ||
    typeof raw.team.id !== "string" ||
    typeof raw.team.name !== "string" ||
    typeof raw.bot_user_id !== "string" ||
    raw.bot_user_id.length === 0 ||
    typeof raw.scope !== "string"
  ) {
    return invalidResponse();
  }
  const teamId = parseWorkspaceId(raw.team.id);
  const appId = parseSlackAppId(raw.app_id);
  if (!teamId.ok || !appId.ok) return invalidResponse();
  return {
    ok: true,
    value: {
      token: raw.access_token,
      appId: appId.value,
      teamId: teamId.value,
      teamName: raw.team.name,
      botUserId: raw.bot_user_id,
      scopes: raw.scope.split(",").map(trimScope).filter(nonEmptyScope),
    },
  };
}

export async function observeSlackProviderIdentity(
  input: Readonly<{
    providerAccountId: string;
    bearer: string;
    fetcher: typeof fetch;
  }>,
): Promise<SlackProviderIdentityObservation> {
  try {
    const fetcher = input.fetcher;
    const response = await fetcher("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.bearer}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const raw = await readJson(response);
    if (!isRecord(raw))
      return { kind: "invalid_response", httpStatus: response.status };
    if (!response.ok || raw.ok !== true) {
      return {
        kind: "provider_rejected",
        httpStatus: response.status,
        slackError: typeof raw.error === "string" ? raw.error : null,
      };
    }
    if (typeof raw.team_id !== "string") {
      return { kind: "invalid_response", httpStatus: response.status };
    }
    return raw.team_id === input.providerAccountId
      ? { kind: "healthy" }
      : {
          kind: "workspace_mismatch",
          expectedWorkspaceId: input.providerAccountId,
          observedWorkspaceId: raw.team_id,
        };
  } catch (error) {
    return {
      kind: "transport_failure",
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
  }
}

const SLACK_DISCOVERY_MAX_ATTEMPTS = 3;

type SlackChannelPage = {
  readonly resources: readonly DiscoveredProviderResource[];
  readonly nextCursor: string;
};

export async function discoverSlackChannels(
  input: Readonly<{
    fetcher: typeof fetch;
    accessToken: string;
    providerAccountId: WorkspaceId;
  }>,
): Promise<Result<readonly DiscoveredProviderResource[], SlackProtocolError>> {
  const resources: DiscoveredProviderResource[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL("https://slack.com/api/conversations.list");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    url.searchParams.set("types", "public_channel,private_channel");
    if (cursor.length > 0) url.searchParams.set("cursor", cursor);
    const parsed = await discoverSlackChannelPage(input, url.toString());
    if (!parsed.ok) return parsed;
    resources.push(...parsed.value.resources);
    cursor = parsed.value.nextCursor;
    if (cursor.length === 0) return { ok: true, value: resources };
  }
  return invalidResponse();
}

async function discoverSlackChannelPage(
  input: Readonly<{
    fetcher: typeof fetch;
    accessToken: string;
    providerAccountId: WorkspaceId;
  }>,
  url: string,
): Promise<Result<SlackChannelPage, SlackProtocolError>> {
  let lastFailure: VariantBy<
    SlackProtocolError,
    "code",
    "provider_oauth_exchange_failed"
  > = {
    code: "provider_oauth_exchange_failed",
    status: 502,
    requestId: null,
  };
  for (let attempt = 1; attempt <= SLACK_DISCOVERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const fetcher = input.fetcher;
      const response = await fetcher(url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
      const parsed = response.ok
        ? parseSlackChannelPage(
            await readJson(response),
            input.providerAccountId,
          )
        : exchangeFailure(response.status, response.headers.get("request-id"));
      if (parsed.ok) return parsed;
      if (!isRetryableSlackDiscoveryFailure(parsed.error)) return parsed;
      lastFailure = parsed.error;
      traceSlackDiscoveryRetry(
        input.providerAccountId,
        attempt,
        lastFailure,
        null,
      );
    } catch (error) {
      lastFailure = {
        code: "provider_oauth_exchange_failed",
        status: 502,
        requestId: null,
      };
      traceSlackDiscoveryRetry(
        input.providerAccountId,
        attempt,
        lastFailure,
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }
  return { ok: false, error: lastFailure };
}

export function parseSlackChannelPage(
  raw: unknown,
  providerAccountId: WorkspaceId,
): Result<SlackChannelPage, SlackProtocolError> {
  if (!isRecord(raw)) return invalidResponse();
  if (raw.ok !== true)
    return { ok: false, error: slackChannelDiscoveryError(raw.error) };
  if (!Array.isArray(raw.channels)) return invalidResponse();
  const resources: DiscoveredProviderResource[] = [];
  for (const channel of raw.channels) {
    if (
      !isRecord(channel) ||
      typeof channel.id !== "string" ||
      typeof channel.name !== "string" ||
      channel.is_archived === true
    )
      continue;
    const channelId = parseChannelId(channel.id);
    if (!channelId.ok) continue;
    resources.push({
      canonicalResourceId: channelId.value,
      providerResourceId: channelId.value,
      providerAccountId,
      displayLabel: `#${channel.name}`,
      accessState: channel.is_member === false ? "inaccessible" : "accessible",
      providerRevision: slackChannelRevision(channel),
      resourceKind:
        channel.is_private === true ? "private_channel" : "public_channel",
    });
  }
  const nextCursor =
    isRecord(raw.response_metadata) &&
    typeof raw.response_metadata.next_cursor === "string"
      ? raw.response_metadata.next_cursor
      : "";
  return { ok: true, value: { resources, nextCursor } };
}

function slackConfigurationIsValid(
  env: Parameters<typeof slackAuthorizationSecret>[0],
): boolean {
  return (
    configuredValue(env.SLACK_CLIENT_ID) !== null &&
    slackAuthorizationSecret(env) !== null
  );
}

function slackAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"slack">["configurationIsValid"]
  >[0],
): string | null {
  return configuredValue(env.SLACK_CLIENT_SECRET);
}

async function slackAuthorizationUrl(
  input: Parameters<ProviderOnboardingAdapter<"slack">["authorizationUrl"]>[0],
): Promise<string> {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("scope", SLACK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function removeSlackInstallation(
  input: Parameters<ProviderCleanupAdapter<"slack">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const token = input.credentials.bearer;
  const clientId = input.env.SLACK_CLIENT_ID;
  const clientSecret = input.env.SLACK_CLIENT_SECRET;
  if (token === null) {
    return permanentFailure("provider_cleanup_credential_missing");
  }
  if (clientId === undefined || clientSecret === undefined) {
    return permanentFailure("provider_cleanup_configuration_missing");
  }
  return uninstallSlackApplication({
    fetcher: input.fetcher,
    token: token.value,
    clientId,
    clientSecret,
  });
}

export async function uninstallSlackApplication(input: {
  readonly fetcher: typeof fetch;
  readonly token: string;
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<ProviderCleanupResult> {
  let response: Response;
  try {
    response = await input.fetcher("https://slack.com/api/apps.uninstall", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        token: input.token,
      }),
    });
  } catch {
    return {
      kind: "retryable_failure",
      reason: "provider_cleanup_http_unavailable",
    };
  }
  if (!response.ok)
    return providerHttpFailure(response.status, MANUAL_INSTRUCTION);
  const raw: unknown = await response.json().catch(() => null);
  return slackRemovalSucceeded(raw)
    ? { kind: "removed" }
    : permanentFailure("provider_cleanup_response_invalid");
}

function slackRemovalSucceeded(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    "ok" in raw &&
    raw.ok === true
  );
}

function permanentFailure(
  reason:
    | "provider_cleanup_configuration_missing"
    | "provider_cleanup_credential_missing"
    | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return { kind: "permanent_failure", reason, instruction: MANUAL_INSTRUCTION };
}

function slackChannelDiscoveryError(raw: unknown): SlackProtocolError {
  switch (raw) {
    case "missing_scope":
      return { code: "provider_scope_missing" };
    case "ratelimited":
      return {
        code: "provider_oauth_exchange_failed",
        status: 429,
        requestId: null,
      };
    case "fatal_error":
    case "internal_error":
    case "request_timeout":
    case "service_unavailable":
      return {
        code: "provider_oauth_exchange_failed",
        status: 503,
        requestId: null,
      };
    default:
      return { code: "provider_oauth_response_invalid" };
  }
}

function isRetryableSlackDiscoveryFailure(
  error: SlackProtocolError,
): error is VariantBy<
  SlackProtocolError,
  "code",
  "provider_oauth_exchange_failed"
> {
  return (
    error.code === "provider_oauth_exchange_failed" &&
    error.status >= 500 &&
    error.status < 600
  );
}

function traceSlackDiscoveryRetry(
  providerAccountId: WorkspaceId,
  attempt: number,
  error: VariantBy<
    SlackProtocolError,
    "code",
    "provider_oauth_exchange_failed"
  >,
  errorName: string | null,
): void {
  if (attempt >= SLACK_DISCOVERY_MAX_ATTEMPTS) return;
  traceWarn("provider_onboarding.slack_resource_retry", {
    requestId: newRequestId(),
    workspace_id: providerAccountId,
    attempt,
    max_attempts: SLACK_DISCOVERY_MAX_ATTEMPTS,
    provider_status: error.status,
    provider_request_id: error.requestId,
    error_name: errorName,
  });
}

function slackChannelRevision(
  channel: Readonly<Record<string, unknown>>,
): string {
  const updated = typeof channel.updated === "number" ? channel.updated : 0;
  const membership = channel.is_member === false ? "outside" : "member";
  return `slack-channel:${updated}:${membership}`;
}

function exchangeFailure(
  status: number,
  requestId: string | null,
): Result<never, SlackProtocolError> {
  return {
    ok: false,
    error: { code: "provider_oauth_exchange_failed", status, requestId },
  };
}

function invalidResponse<T>(): Result<T, SlackProtocolError> {
  return { ok: false, error: { code: "provider_oauth_response_invalid" } };
}

function trimScope(scope: string): string {
  return scope.trim();
}

function nonEmptyScope(scope: string): boolean {
  return scope.length > 0;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
