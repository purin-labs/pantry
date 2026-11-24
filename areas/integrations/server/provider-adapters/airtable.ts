import {
  configuredValue,
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  pkceChallenge,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "@purin-labs/connections/provider-adapters/authorization";
import type {
  ProviderCleanupAdapter,
  ProviderCleanupResult,
  ProviderOnboardingAdapter,
} from "@purin-labs/area-integrations-contract/server/provider-adapter";

const AIRTABLE_SCOPES = [
  "data.records:read",
  "data.records:write",
  "schema.bases:read",
  "schema.bases:write",
  "data.recordComments:read",
  "data.recordComments:write",
  "webhook:manage",
] as const;

const MANUAL_INSTRUCTION = "revoke_airtable_access_in_airtable" as const;

export const airtableCleanupAdapter: ProviderCleanupAdapter<"airtable"> = {
  provider: "airtable",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: removeAirtableConnection,
};

export const airtableOnboardingAdapter: ProviderOnboardingAdapter<"airtable"> =
  {
    provider: "airtable",
    requiredScopes: AIRTABLE_SCOPES,
    stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
    parseStartContext: parseAirtableStartContext,
    configurationIsValid: airtableConfigurationIsValid,
    authorizationSecret: airtableAuthorizationSecret,
    authorizationUrl: airtableAuthorizationUrl,
    scopeIsGranted: exactScopeIsGranted,
  };

function parseAirtableStartContext(
  raw: unknown,
): { readonly provider: "airtable" } | null {
  return parseProviderOnlyStartContext("airtable", raw);
}

function airtableConfigurationIsValid(
  env: Parameters<typeof airtableAuthorizationSecret>[0],
): boolean {
  return (
    configuredValue(env.AIRTABLE_OAUTH_CLIENT_ID) !== null &&
    airtableAuthorizationSecret(env) !== null
  );
}

function airtableAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"airtable">["configurationIsValid"]
  >[0],
): string | null {
  return configuredValue(env.AIRTABLE_OAUTH_CLIENT_SECRET);
}

async function airtableAuthorizationUrl(
  input: Parameters<
    ProviderOnboardingAdapter<"airtable">["authorizationUrl"]
  >[0],
): Promise<string> {
  if (input.pkceVerifier === null)
    throw new Error("Airtable PKCE verifier is missing");
  const url = new URL("https://airtable.com/oauth2/v1/authorize");
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", AIRTABLE_SCOPES.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set(
    "code_challenge",
    await pkceChallenge(input.pkceVerifier),
  );
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function removeAirtableConnection(
  _input: Parameters<ProviderCleanupAdapter<"airtable">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  return {
    kind: "manual_action_required",
    reason: "provider_cleanup_provider_rejected",
    instruction: MANUAL_INSTRUCTION,
  };
}
