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
} from "./domain";

const NOTION_VERSION = "2026-03-11";
const MANUAL_INSTRUCTION = "revoke_notion_access_in_notion" as const;
const NOTION_SCOPES = ["content.read"] as const;

export const notionCleanupAdapter: ProviderCleanupAdapter<"notion"> = {
  provider: "notion",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: revokeNotionToken,
};

export const notionOnboardingAdapter: ProviderOnboardingAdapter<"notion"> = {
  provider: "notion",
  requiredScopes: NOTION_SCOPES,
  stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseNotionStartContext,
  configurationIsValid: notionConfigurationIsValid,
  authorizationSecret: notionAuthorizationSecret,
  authorizationUrl: notionAuthorizationUrl,
  scopeIsGranted: exactScopeIsGranted,
};

function parseNotionStartContext(
  raw: unknown,
): { readonly provider: "notion" } | null {
  return parseProviderOnlyStartContext("notion", raw);
}

function notionConfigurationIsValid(
  env: Parameters<typeof notionAuthorizationSecret>[0],
): boolean {
  return (
    configuredValue(env.NOTION_OAUTH_CLIENT_ID) !== null &&
    notionAuthorizationSecret(env) !== null
  );
}

function notionAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"notion">["configurationIsValid"]
  >[0],
): string | null {
  return configuredValue(env.NOTION_OAUTH_CLIENT_SECRET);
}

async function notionAuthorizationUrl(
  input: Parameters<ProviderOnboardingAdapter<"notion">["authorizationUrl"]>[0],
): Promise<string> {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function revokeNotionToken(
  input: Parameters<ProviderCleanupAdapter<"notion">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const tokens = input.credentials.oauthTokens;
  const clientId = input.env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = input.env.NOTION_OAUTH_CLIENT_SECRET;
  if (tokens === null)
    return permanentFailure("provider_cleanup_credential_missing");
  if (clientId === undefined || clientSecret === undefined) {
    return permanentFailure("provider_cleanup_configuration_missing");
  }
  let response: Response;
  try {
    response = await input.fetcher("https://api.notion.com/v1/oauth/revoke", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "content-type": "application/json",
        "notion-version": NOTION_VERSION,
      },
      body: JSON.stringify({ token: tokens.accessToken }),
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
  return notionRevocationSucceeded(raw)
    ? { kind: "removed" }
    : permanentFailure("provider_cleanup_response_invalid");
}

function notionRevocationSucceeded(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    "request_id" in raw &&
    typeof raw.request_id === "string" &&
    raw.request_id.length > 0
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
