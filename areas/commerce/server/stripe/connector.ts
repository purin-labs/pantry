import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { listLiveProviderWebhookContexts } from "@purin-labs/connections/data/integration-account";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  StripeChargeFailedCueEvent,
  StripeCueEvent,
  StripeInvoicePaymentFailedCueEvent,
  StripeRefundFailedCueEvent,
  StripeSubscriptionDeletedCueEvent,
} from "@purin-labs/agent/cues/engine";
import {
  resolveProviderWebhookCredential,
  type VaultResolveError,
} from "@purin-labs/authority/credential-vault/index";
import { errorMessage, isRecord } from "@purin-labs/std";
import type { StripeSignatureError } from "@purin-labs/area-commerce-contract/server/stripe-webhook-signature";

export type StripeWebhookError =
  | { code: "stripe_connector_missing" }
  | { code: "stripe_connector_inactive" }
  | { code: "stripe_connector_ambiguous" }
  | { code: "stripe_webhook_secret_invalid" }
  | StripeSignatureError
  | { code: "stripe_connect_account_missing" }
  | { code: "stripe_event_invalid" }
  | { code: "stripe_event_unsupported" }
  | VaultResolveError;

type StripeWebhookRegistration =
  | {
      kind: "created";
      endpointId: string;
      signingSecret: string;
      status: "enabled";
    }
  | {
      kind: "updated";
      endpointId: string;
      status: "enabled";
    };

type StripeWebhookRegistrationError =
  | { code: "stripe_registration_failed"; status: number }
  | { code: "stripe_registration_transport_failed" }
  | { code: "stripe_registration_invalid" }
  | { code: "stripe_registration_secret_missing" };

export type StripeWebhookSecretCandidate = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly signingSecret: string;
};

const STRIPE_WEBHOOK_EVENT_TYPES = [
  "charge.failed",
  "invoice.payment_failed",
  "refund.failed",
  "customer.subscription.deleted",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.requires_action",
  "payment_intent.succeeded",
] as const;

export async function registerStripeWebhook(input: {
  stripeTestKey: string;
  endpointUrl: string;
  idempotencyKey: string;
  existingSigningSecret: boolean;
  fetcher: typeof fetch;
}): Promise<Result<StripeWebhookRegistration, StripeWebhookRegistrationError>> {
  const existing = await findStripeWebhookEndpoint(input);

  if (!existing.ok) {
    return existing;
  }

  if (existing.value !== null) {
    if (!input.existingSigningSecret) {
      return {
        ok: false,
        error: { code: "stripe_registration_secret_missing" },
      };
    }

    return updateStripeWebhookEndpoint(input, existing.value);
  }

  return createStripeWebhookEndpoint(input);
}

async function findStripeWebhookEndpoint(input: {
  stripeTestKey: string;
  endpointUrl: string;
  fetcher: typeof fetch;
}): Promise<Result<string | null, StripeWebhookRegistrationError>> {
  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      "https://api.stripe.com/v1/webhook_endpoints?limit=100",
      {
        headers: {
          authorization: `Bearer ${input.stripeTestKey}`,
        },
      },
    );
  } catch (error) {
    console.error("stripe.webhook_registration_transport_failed", {
      operation: "list",
      error: errorMessage(error),
    });
    return {
      ok: false,
      error: { code: "stripe_registration_transport_failed" },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: { code: "stripe_registration_failed", status: response.status },
    };
  }

  const raw = await readJsonResponse(response);

  if (!raw.ok || !isRecord(raw.value) || !Array.isArray(raw.value.data)) {
    return { ok: false, error: { code: "stripe_registration_invalid" } };
  }

  for (const endpoint of raw.value.data) {
    if (
      isRecord(endpoint) &&
      endpoint.url === input.endpointUrl &&
      typeof endpoint.id === "string"
    ) {
      return { ok: true, value: endpoint.id };
    }
  }

  return { ok: true, value: null };
}

async function updateStripeWebhookEndpoint(
  input: {
    stripeTestKey: string;
    endpointUrl: string;
    fetcher: typeof fetch;
  },
  endpointId: string,
): Promise<Result<StripeWebhookRegistration, StripeWebhookRegistrationError>> {
  const response = await sendStripeWebhookMutation(
    input,
    `https://api.stripe.com/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
    buildStripeWebhookBody(input.endpointUrl, true),
    null,
  );

  if (!response.ok) {
    return response;
  }

  return parseUpdatedStripeWebhook(response.value, endpointId);
}

async function createStripeWebhookEndpoint(input: {
  stripeTestKey: string;
  endpointUrl: string;
  idempotencyKey: string;
  fetcher: typeof fetch;
}): Promise<Result<StripeWebhookRegistration, StripeWebhookRegistrationError>> {
  const response = await sendStripeWebhookMutation(
    input,
    "https://api.stripe.com/v1/webhook_endpoints",
    buildStripeWebhookBody(input.endpointUrl, false),
    input.idempotencyKey,
  );

  if (!response.ok) {
    return response;
  }

  const raw = response.value;

  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.secret !== "string" ||
    !raw.secret.startsWith("whsec_") ||
    raw.status !== "enabled"
  ) {
    return { ok: false, error: { code: "stripe_registration_invalid" } };
  }

  return {
    ok: true,
    value: {
      kind: "created",
      endpointId: raw.id,
      signingSecret: raw.secret,
      status: raw.status,
    },
  };
}

async function sendStripeWebhookMutation(
  input: { stripeTestKey: string; fetcher: typeof fetch },
  url: string,
  body: URLSearchParams,
  idempotencyKey: string | null,
): Promise<Result<unknown, StripeWebhookRegistrationError>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.stripeTestKey}`,
    "content-type": "application/x-www-form-urlencoded",
  };

  if (idempotencyKey !== null) {
    headers["idempotency-key"] = idempotencyKey;
  }

  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(url, { method: "POST", headers, body });
  } catch (error) {
    console.error("stripe.webhook_registration_transport_failed", {
      operation: "mutate",
      error: errorMessage(error),
    });
    return {
      ok: false,
      error: { code: "stripe_registration_transport_failed" },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: { code: "stripe_registration_failed", status: response.status },
    };
  }

  return readJsonResponse(response);
}

function parseUpdatedStripeWebhook(
  raw: unknown,
  endpointId: string,
): Result<StripeWebhookRegistration, StripeWebhookRegistrationError> {
  if (!isRecord(raw) || raw.id !== endpointId || raw.status !== "enabled") {
    return { ok: false, error: { code: "stripe_registration_invalid" } };
  }

  return {
    ok: true,
    value: { kind: "updated", endpointId, status: "enabled" },
  };
}

function buildStripeWebhookBody(
  endpointUrl: string,
  enableExisting: boolean,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("url", endpointUrl);

  if (enableExisting) {
    body.set("disabled", "false");
  }

  for (const eventType of STRIPE_WEBHOOK_EVENT_TYPES) {
    body.append("enabled_events[]", eventType);
  }

  return body;
}

async function readJsonResponse(
  response: Response,
): Promise<Result<unknown, StripeWebhookRegistrationError>> {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, error: { code: "stripe_registration_invalid" } };
  }
}

export async function resolveStripeWebhookSecrets(
  env: Env,
  scope: OrganisationExecutionScope,
): Promise<
  Result<readonly StripeWebhookSecretCandidate[], StripeWebhookError>
> {
  const organisationId = scope.organisationId;
  const contexts = await listLiveProviderWebhookContexts({
    db: scope.database,
    organisationId,
    provider: "stripe",
    providerAccountId: null,
  });

  if (contexts.length === 0) {
    return { ok: false, error: { code: "stripe_connector_missing" } };
  }

  const candidates = new Map<string, StripeWebhookSecretCandidate>();

  for (const context of contexts) {
    const candidateKey = `${context.integrationAccountId}:${context.signingSecretRef}`;

    if (candidates.has(candidateKey)) {
      continue;
    }

    const secret = await resolveProviderWebhookCredential({
      db: scope.database,
      keys: env,
      organisationId,
      provider: "stripe",
      context,
    });

    if (!secret.ok) {
      if (secret.error.code === "webhook_binding_inactive") {
        return { ok: false, error: { code: "stripe_connector_inactive" } };
      }

      return { ok: false, error: secret.error };
    }

    if (
      secret.value.kind !== "header" ||
      secret.value.header !== "stripe-signing-secret" ||
      !secret.value.value.startsWith("whsec_")
    ) {
      return { ok: false, error: { code: "stripe_webhook_secret_invalid" } };
    }

    candidates.set(candidateKey, {
      integrationAccountId: context.integrationAccountId,
      signingSecret: secret.value.value,
    });
  }

  return { ok: true, value: [...candidates.values()] };
}

export function parseStripeConnectAccountId(
  rawBody: string,
): Result<string, StripeWebhookError> {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: { code: "stripe_event_invalid" } };
  }
  if (
    !isRecord(raw) ||
    typeof raw.account !== "string" ||
    !/^acct_[A-Za-z0-9]+$/u.test(raw.account)
  ) {
    return { ok: false, error: { code: "stripe_connect_account_missing" } };
  }
  return { ok: true, value: raw.account };
}

export function parseStripeCueEvent(
  rawBody: string,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Result<StripeCueEvent, StripeWebhookError> {
  let raw: unknown;

  try {
    raw = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: { code: "stripe_event_invalid" } };
  }

  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !safeInteger(raw.created) ||
    !isRecord(raw.data) ||
    !isRecord(raw.data.object)
  ) {
    return { ok: false, error: { code: "stripe_event_invalid" } };
  }

  const at = raw.created * 1000;

  switch (raw.type) {
    case "charge.failed":
      return parseChargeFailed(
        raw.data.object,
        organisationId,
        integrationAccountId,
        raw.id,
        at,
      );
    case "invoice.payment_failed":
      return parseInvoicePaymentFailed(
        raw.data.object,
        organisationId,
        integrationAccountId,
        raw.id,
        at,
      );
    case "refund.failed":
      return parseRefundFailed(
        raw.data.object,
        organisationId,
        integrationAccountId,
        raw.id,
        at,
      );
    case "customer.subscription.deleted":
      return parseSubscriptionDeleted(
        raw.data.object,
        organisationId,
        integrationAccountId,
        raw.id,
        at,
      );
    default:
      return { ok: false, error: { code: "stripe_event_unsupported" } };
  }
}

function parseChargeFailed(
  charge: Record<string, unknown>,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  nativeId: string,
  at: number,
): Result<StripeChargeFailedCueEvent, StripeWebhookError> {
  if (
    typeof charge.id !== "string" ||
    !safeInteger(charge.amount) ||
    typeof charge.currency !== "string" ||
    !nullableString(charge.failure_code) ||
    !nullableString(charge.failure_message)
  ) {
    return invalidStripeEvent();
  }

  return {
    ok: true,
    value: {
      organisationId,
      integrationAccountId,
      source: "stripe",
      nativeId,
      eventType: "charge.failed",
      payload: {
        chargeId: charge.id,
        amountMinor: charge.amount,
        currency: charge.currency,
        failureCode: charge.failure_code,
        failureMessage: charge.failure_message,
      },
      at,
    },
  };
}

function parseInvoicePaymentFailed(
  invoice: Record<string, unknown>,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  nativeId: string,
  at: number,
): Result<StripeInvoicePaymentFailedCueEvent, StripeWebhookError> {
  if (
    typeof invoice.id !== "string" ||
    !nullableString(invoice.customer) ||
    !nullableString(invoice.subscription) ||
    !safeInteger(invoice.amount_due) ||
    typeof invoice.currency !== "string" ||
    !nonNegativeSafeInteger(invoice.attempt_count) ||
    !nullableSafeInteger(invoice.next_payment_attempt)
  ) {
    return invalidStripeEvent();
  }

  return {
    ok: true,
    value: {
      organisationId,
      integrationAccountId,
      source: "stripe",
      nativeId,
      eventType: "invoice.payment_failed",
      payload: {
        invoiceId: invoice.id,
        customerId: invoice.customer,
        subscriptionId: invoice.subscription,
        amountDueMinor: invoice.amount_due,
        currency: invoice.currency,
        attemptCount: invoice.attempt_count,
        nextPaymentAttemptAt: secondsToNullableMilliseconds(
          invoice.next_payment_attempt,
        ),
      },
      at,
    },
  };
}

function parseRefundFailed(
  refund: Record<string, unknown>,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  nativeId: string,
  at: number,
): Result<StripeRefundFailedCueEvent, StripeWebhookError> {
  if (
    typeof refund.id !== "string" ||
    !nullableString(refund.charge) ||
    !nullableString(refund.payment_intent) ||
    !safeInteger(refund.amount) ||
    typeof refund.currency !== "string" ||
    !nullableString(refund.failure_reason)
  ) {
    return invalidStripeEvent();
  }

  return {
    ok: true,
    value: {
      organisationId,
      integrationAccountId,
      source: "stripe",
      nativeId,
      eventType: "refund.failed",
      payload: {
        refundId: refund.id,
        chargeId: refund.charge,
        paymentIntentId: refund.payment_intent,
        amountMinor: refund.amount,
        currency: refund.currency,
        failureReason: refund.failure_reason,
      },
      at,
    },
  };
}

function parseSubscriptionDeleted(
  subscription: Record<string, unknown>,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  nativeId: string,
  at: number,
): Result<StripeSubscriptionDeletedCueEvent, StripeWebhookError> {
  if (
    typeof subscription.id !== "string" ||
    typeof subscription.customer !== "string" ||
    typeof subscription.status !== "string" ||
    typeof subscription.cancel_at_period_end !== "boolean" ||
    !nullableSafeInteger(subscription.canceled_at) ||
    !nullableSafeInteger(subscription.ended_at)
  ) {
    return invalidStripeEvent();
  }

  return {
    ok: true,
    value: {
      organisationId,
      integrationAccountId,
      source: "stripe",
      nativeId,
      eventType: "customer.subscription.deleted",
      payload: {
        subscriptionId: subscription.id,
        customerId: subscription.customer,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: secondsToNullableMilliseconds(subscription.canceled_at),
        endedAt: secondsToNullableMilliseconds(subscription.ended_at),
      },
      at,
    },
  };
}

function invalidStripeEvent(): Result<never, StripeWebhookError> {
  return { ok: false, error: { code: "stripe_event_invalid" } };
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return safeInteger(value) && value >= 0;
}

function nullableSafeInteger(value: unknown): value is number | null {
  return value === null || safeInteger(value);
}

function secondsToNullableMilliseconds(value: number | null): number | null {
  return value === null ? null : value * 1000;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
