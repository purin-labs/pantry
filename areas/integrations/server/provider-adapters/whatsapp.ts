import {
  resolveWhatsAppApplicationConfiguration,
  resolveWhatsAppEmbeddedSignupCredential,
} from "@purin-labs/connections/whatsapp/application";
import {
  unsubscribeWhatsAppApp,
  WHATSAPP_GRAPH_API_VERSION,
} from "@purin-labs/connections/whatsapp/graph";
import { parseWhatsAppBusinessAccountId } from "@purin-labs/connections/whatsapp/identifiers";
import {
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  SHORT_PROVIDER_STATE_TTL_MS,
} from "@purin-labs/connections/provider-adapters/authorization";
import type {
  ProviderCleanupAdapter,
  ProviderCleanupResult,
  ProviderOnboardingAdapter,
} from "@purin-labs/area-integrations-contract/server/provider-adapter";

const MANUAL_INSTRUCTION = "remove_whatsapp_access_in_meta" as const;
const WHATSAPP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
  "business_management",
] as const;

export const whatsappCleanupAdapter: ProviderCleanupAdapter<"whatsapp"> = {
  provider: "whatsapp",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: removeWhatsAppConnection,
};

export const whatsappOnboardingAdapter: ProviderOnboardingAdapter<"whatsapp"> =
  {
    provider: "whatsapp",
    requiredScopes: WHATSAPP_SCOPES,
    stateTtlMs: SHORT_PROVIDER_STATE_TTL_MS,
    parseStartContext: parseWhatsAppStartContext,
    configurationIsValid: whatsappConfigurationIsValid,
    authorizationSecret: whatsappAuthorizationSecret,
    authorizationUrl: whatsappAuthorizationUrl,
    scopeIsGranted: exactScopeIsGranted,
  };

function parseWhatsAppStartContext(
  raw: unknown,
): { readonly provider: "whatsapp" } | null {
  return parseProviderOnlyStartContext("whatsapp", raw);
}

function whatsappConfigurationIsValid(
  env: Parameters<typeof whatsappAuthorizationSecret>[0],
): boolean {
  return (
    resolveWhatsAppApplicationConfiguration(env).ok &&
    resolveWhatsAppEmbeddedSignupCredential(env).ok
  );
}

function whatsappAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"whatsapp">["configurationIsValid"]
  >[0],
): string | null {
  const value = env.WHATSAPP_APP_SECRET?.trim() ?? "";
  return value.length === 0 ? null : value;
}

async function whatsappAuthorizationUrl(
  input: Parameters<
    ProviderOnboardingAdapter<"whatsapp">["authorizationUrl"]
  >[0],
): Promise<string> {
  const url = new URL(
    `https://www.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/dialog/oauth`,
  );
  url.searchParams.set("client_id", input.configuration.appId);
  url.searchParams.set(
    "config_id",
    input.configuration.embeddedSignupConfigurationId,
  );
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("override_default_response_type", "true");
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function removeWhatsAppConnection(
  input: Parameters<ProviderCleanupAdapter<"whatsapp">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  if (!input.cleanup.removeApplicationSubscription) return { kind: "removed" };
  const wabaId = parseWhatsAppBusinessAccountId(input.cleanup.wabaId);
  if (!wabaId.ok) return permanentFailure("provider_cleanup_response_invalid");
  const credential =
    input.credentials.expiringBearer ?? input.credentials.bearer;
  if (credential === null) {
    return permanentFailure("provider_cleanup_configuration_missing");
  }
  const removed = await unsubscribeWhatsAppApp({
    wabaId: wabaId.value,
    accessToken: credential.value,
    fetcher: input.fetcher,
  });
  return removed.ok
    ? { kind: "removed" }
    : {
        kind: "retryable_failure",
        reason: "provider_cleanup_http_unavailable",
      };
}

function permanentFailure(
  reason:
    | "provider_cleanup_configuration_missing"
    | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return { kind: "permanent_failure", reason, instruction: MANUAL_INSTRUCTION };
}
