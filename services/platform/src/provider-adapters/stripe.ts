import {
  configuredValue,
  exactScopeIsGranted,
  parseProviderOnlyStartContext,
  STRIPE_PROVIDER_STATE_TTL_MS,
} from "./authorization";
import {
  providerHttpFailure,
  type ProviderCleanupAdapter,
  type ProviderCleanupResult,
  type ProviderOnboardingAdapter,
} from "../integrations/contract/provider-adapter";
import { newRequestId } from "../ids";
import { traceWarn } from "../observability";
import type { Result } from "../result";
import { isRecord, isString } from "@purin-labs/std";

const MANUAL_INSTRUCTION = "revoke_stripe_access_in_stripe" as const;
const STRIPE_SCOPES = ["read_write"] as const;
const STRIPE_CONNECT_EVENTS = [
  "charge.failed",
  "invoice.payment_failed",
  "refund.failed",
  "customer.subscription.deleted",
  "account.application.deauthorized",
] as const;

type StripeProtocolError =
  | { readonly code: "provider_configuration_missing" }
  | { readonly code: "provider_oauth_response_invalid" }
  | { readonly code: "provider_account_ineligible" }
  | { readonly code: "provider_webhook_registration_failed" }
  | {
      readonly code: "provider_oauth_exchange_failed";
      readonly status: number;
      readonly requestId: string | null;
    };

type StripeAuthorizationGrant = {
  readonly accessToken: string;
  readonly accountId: string;
  readonly scope: string;
};

type StripeAccountSummary = {
  readonly accountId: string;
  readonly country: string;
  readonly displayName: string;
  readonly activeCapabilities: readonly string[];
};

type StripeWebhookConfiguration = {
  readonly id: string;
  readonly secret: string;
};

export const stripeCleanupAdapter: ProviderCleanupAdapter<"stripe"> = {
  provider: "stripe",
  manualActionInstruction: MANUAL_INSTRUCTION,
  remove: removeStripeConnection,
};

export const stripeOnboardingAdapter: ProviderOnboardingAdapter<"stripe"> = {
  provider: "stripe",
  requiredScopes: STRIPE_SCOPES,
  stateTtlMs: STRIPE_PROVIDER_STATE_TTL_MS,
  parseStartContext: parseStripeStartContext,
  configurationIsValid: stripeConfigurationIsValid,
  authorizationSecret: stripeAuthorizationSecret,
  authorizationUrl: stripeAuthorizationUrl,
  scopeIsGranted: exactScopeIsGranted,
};

function parseStripeStartContext(
  raw: unknown,
): { readonly provider: "stripe" } | null {
  return parseProviderOnlyStartContext("stripe", raw);
}

export async function exchangeStripeAuthorizationCode(
  input: Readonly<{
    clientSecret: string;
    code: string;
    fetcher: typeof fetch;
  }>,
): Promise<Result<StripeAuthorizationGrant, StripeProtocolError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher("https://connect.stripe.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: "authorization_code",
      }),
    });
  } catch {
    return exchangeFailure(503, null);
  }
  if (!response.ok) {
    return exchangeFailure(response.status, response.headers.get("request-id"));
  }
  return parseStripeToken(await readJson(response));
}

export function stripeCredentialEnvironment(
  accessToken: string,
): "development" | "production" | null {
  if (accessToken.startsWith("sk_test_")) return "development";
  if (accessToken.startsWith("sk_live_")) return "production";
  return null;
}

export async function discoverStripeAccount(
  input: Readonly<{
    fetcher: typeof fetch;
    accountId: string;
    accessToken: string;
    environment: "development" | "production";
  }>,
): Promise<Result<StripeAccountSummary, StripeProtocolError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://api.stripe.com/v1/accounts/${encodeURIComponent(input.accountId)}`,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
  } catch {
    return exchangeFailure(502, null);
  }
  if (!response.ok) {
    return exchangeFailure(response.status, response.headers.get("request-id"));
  }
  return parseStripeAccountSummary(
    await readJson(response),
    input.accountId,
    input.environment,
  );
}

export function parseStripeAccountSummary(
  raw: unknown,
  expectedAccountId: string,
  environment: "development" | "production",
): Result<StripeAccountSummary, StripeProtocolError> {
  if (
    !isRecord(raw) ||
    raw.id !== expectedAccountId ||
    typeof raw.country !== "string" ||
    !/^[A-Z]{2}$/u.test(raw.country) ||
    typeof raw.charges_enabled !== "boolean" ||
    !isRecord(raw.capabilities)
  ) {
    return ineligibleAccount();
  }
  if (
    environment === "production" &&
    (raw.charges_enabled !== true ||
      raw.capabilities.card_payments !== "active")
  ) {
    return ineligibleAccount();
  }
  if (environment === "development" && raw.details_submitted !== true) {
    return ineligibleAccount();
  }
  const activeCapabilities: string[] = [];
  for (const [capability, status] of Object.entries(raw.capabilities)) {
    if (status === "active") activeCapabilities.push(capability);
  }
  const businessProfile = isRecord(raw.business_profile)
    ? raw.business_profile
    : null;
  const displayName =
    businessProfile !== null &&
    typeof businessProfile.name === "string" &&
    businessProfile.name.trim().length > 0
      ? businessProfile.name.trim()
      : expectedAccountId;
  return {
    ok: true,
    value: {
      accountId: expectedAccountId,
      country: raw.country,
      displayName,
      activeCapabilities,
    },
  };
}

export function stripeConnectWebhookConfiguration(
  env: Pick<
    Parameters<ProviderOnboardingAdapter<"stripe">["configurationIsValid"]>[0],
    "STRIPE_CONNECT_WEBHOOK_ID" | "STRIPE_CONNECT_WEBHOOK_SECRET"
  >,
): Result<StripeWebhookConfiguration, StripeProtocolError> {
  const id = env.STRIPE_CONNECT_WEBHOOK_ID;
  const secret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (
    id === undefined ||
    !/^we_[A-Za-z0-9]+$/u.test(id) ||
    secret === undefined ||
    !/^whsec_[A-Za-z0-9]+$/u.test(secret)
  ) {
    return { ok: false, error: { code: "provider_configuration_missing" } };
  }
  return { ok: true, value: { id, secret } };
}

export async function verifyStripeConnectWebhook(
  input: Readonly<{
    fetcher: typeof fetch;
    webhook: StripeWebhookConfiguration;
    clientSecret: string;
    environment: "development" | "production";
  }>,
): Promise<Result<true, StripeProtocolError>> {
  let response: Response;
  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://api.stripe.com/v1/webhook_endpoints/${encodeURIComponent(input.webhook.id)}`,
      { headers: { authorization: `Bearer ${input.clientSecret}` } },
    );
  } catch (error) {
    traceStripeWebhookFailure("transport", null, null, error);
    return webhookFailure();
  }
  if (!response.ok) {
    traceStripeWebhookFailure(
      "provider_rejected",
      response.status,
      response.headers.get("request-id"),
      null,
    );
    return webhookFailure();
  }
  const raw = await readJson(response);
  if (!stripeWebhookResponseIsValid(raw, input)) {
    traceWarn("provider_onboarding.stripe_webhook_verification_failed", {
      requestId: newRequestId(),
      failure_kind: "invalid_response",
      response_is_object: isRecord(raw),
      endpoint_matches: isRecord(raw) && raw.id === input.webhook.id,
      status_enabled: isRecord(raw) && raw.status === "enabled",
      livemode_matches:
        isRecord(raw) && raw.livemode === (input.environment === "production"),
      events_complete:
        isRecord(raw) && stripeWebhookEventsAreComplete(raw.enabled_events),
    });
    return webhookFailure();
  }
  return { ok: true, value: true };
}

function stripeConfigurationIsValid(
  env: Parameters<typeof stripeAuthorizationSecret>[0],
): boolean {
  return (
    configuredValue(env.STRIPE_CONNECT_CLIENT_ID) !== null &&
    stripeAuthorizationSecret(env) !== null &&
    stripeConnectWebhookConfiguration(env).ok
  );
}

function stripeAuthorizationSecret(
  env: Parameters<
    ProviderOnboardingAdapter<"stripe">["configurationIsValid"]
  >[0],
): string | null {
  return configuredValue(env.STRIPE_CONNECT_CLIENT_SECRET);
}

async function stripeAuthorizationUrl(
  input: Parameters<ProviderOnboardingAdapter<"stripe">["authorizationUrl"]>[0],
): Promise<string> {
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("client_id", input.configuration.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  return url.toString();
}

async function removeStripeConnection(
  input: Parameters<ProviderCleanupAdapter<"stripe">["remove"]>[0],
): Promise<ProviderCleanupResult> {
  const clientId = input.env.STRIPE_CONNECT_CLIENT_ID;
  const secretKey = input.env.STRIPE_CONNECT_CLIENT_SECRET;
  if (clientId === undefined || secretKey === undefined) {
    return permanentFailure("provider_cleanup_configuration_missing");
  }
  let response: Response;
  try {
    response = await input.fetcher(
      "https://connect.stripe.com/oauth/deauthorize",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${secretKey}:`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: clientId,
          stripe_user_id: input.cleanup.providerAccountId,
        }),
      },
    );
  } catch {
    return {
      kind: "retryable_failure",
      reason: "provider_cleanup_http_unavailable",
    };
  }
  if (!response.ok)
    return providerHttpFailure(response.status, MANUAL_INSTRUCTION);
  const raw: unknown = await response.json().catch(() => null);
  return stripeRemovalSucceeded(raw, input.cleanup.providerAccountId)
    ? { kind: "removed" }
    : permanentFailure("provider_cleanup_response_invalid");
}

function stripeRemovalSucceeded(
  raw: unknown,
  providerAccountId: string,
): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    "stripe_user_id" in raw &&
    raw.stripe_user_id === providerAccountId
  );
}

function permanentFailure(
  reason:
    | "provider_cleanup_configuration_missing"
    | "provider_cleanup_response_invalid",
): ProviderCleanupResult {
  return { kind: "permanent_failure", reason, instruction: MANUAL_INSTRUCTION };
}

function parseStripeToken(
  raw: unknown,
): Result<StripeAuthorizationGrant, StripeProtocolError> {
  if (
    !isRecord(raw) ||
    typeof raw.access_token !== "string" ||
    typeof raw.stripe_user_id !== "string" ||
    typeof raw.scope !== "string"
  ) {
    return { ok: false, error: { code: "provider_oauth_response_invalid" } };
  }
  return {
    ok: true,
    value: {
      accessToken: raw.access_token,
      accountId: raw.stripe_user_id,
      scope: raw.scope,
    },
  };
}

function stripeWebhookResponseIsValid(
  raw: unknown,
  input: Readonly<{
    webhook: StripeWebhookConfiguration;
    environment: "development" | "production";
  }>,
): boolean {
  return (
    isRecord(raw) &&
    raw.id === input.webhook.id &&
    raw.status === "enabled" &&
    raw.livemode === (input.environment === "production") &&
    stripeWebhookEventsAreComplete(raw.enabled_events)
  );
}

function stripeWebhookEventsAreComplete(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const events = new Set(raw.filter(isString));
  for (const event of STRIPE_CONNECT_EVENTS) {
    if (!events.has(event)) return false;
  }
  return true;
}

function traceStripeWebhookFailure(
  kind: "transport" | "provider_rejected",
  status: number | null,
  requestId: string | null,
  error: unknown,
): void {
  traceWarn("provider_onboarding.stripe_webhook_verification_failed", {
    requestId: newRequestId(),
    failure_kind: kind,
    http_status: status,
    stripe_request_id: requestId,
    error_name: error instanceof Error ? error.name : null,
  });
}

function exchangeFailure(
  status: number,
  requestId: string | null,
): Result<never, StripeProtocolError> {
  return {
    ok: false,
    error: { code: "provider_oauth_exchange_failed", status, requestId },
  };
}

function ineligibleAccount(): Result<never, StripeProtocolError> {
  return { ok: false, error: { code: "provider_account_ineligible" } };
}

function webhookFailure(): Result<never, StripeProtocolError> {
  return { ok: false, error: { code: "provider_webhook_registration_failed" } };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
