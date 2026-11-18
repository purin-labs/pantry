import { OrganisationExecutionScope } from "../organisation-execution-scope";
import { createCueQueueMessage } from "../cues/engine";
import {
  listRegionalProviderAccountTargets,
  type ActiveProviderAccountTarget,
} from "../data/integration-account";
import type { Env } from "../env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
} from "../http";
import {
  newRequestId,
  parseOrganisationId,
} from "../ids";
import { traceLog } from "../observability";
import {
  parseStripeConnectAccountId,
  parseStripeCueEvent,
  resolveStripeWebhookSecrets,
  verifyStripeWebhookSignature,
  type StripeWebhookSecretCandidate,
  type StripeWebhookError,
} from "./connector";
import type { Result } from "../result";
import { assertNever, isRecord } from "@seams/std";
import { revokeAccountRemovedAtProvider } from "../provider-lifecycle/provider-revocation";
import {
  decodePathSegmentValue,
} from "../gateway/support";

export async function handleStripeConnectWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  const webhookId = env.STRIPE_CONNECT_WEBHOOK_ID;
  const signingSecret = env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (
    webhookId === undefined ||
    !/^we_[A-Za-z0-9]+$/u.test(webhookId) ||
    signingSecret === undefined ||
    !/^whsec_[A-Za-z0-9]+$/u.test(signingSecret)
  ) {
    return errorResponse(
      "stripe_connect_webhook_unavailable",
      "Stripe Connect webhook verification is unavailable.",
      503,
    );
  }
  const rawBody = await request.text();
  const verified = await verifyStripeWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get("stripe-signature"),
    signingSecret,
    nowMs: Date.now(),
  });
  if (!verified.ok) {
    return stripeWebhookErrorResponse(verified.error);
  }
  const accountId = parseStripeConnectAccountId(rawBody);
  if (!accountId.ok) {
    return stripeWebhookErrorResponse(accountId.error);
  }
  const targets = await listRegionalProviderAccountTargets({
    env,
    provider: "stripe",
    providerAccountId: accountId.value,
    providerNativeId: webhookId,
  });
  if (targets.length === 0) {
    return jsonResponse({ ok: true, ignored: true });
  }
  const receivedAt = Date.now();
  const deauthorization = parseStripeDeauthorization(
    rawBody,
    env.STRIPE_CONNECT_CLIENT_ID,
  );
  if (deauthorization === "another_application") {
    return jsonResponse({ ok: true, ignored: true });
  }
  if (deauthorization === "this_application") {
    return revokeDeauthorizedStripeAccounts(
      env,
      targets,
      accountId.value,
      receivedAt,
    );
  }
  let queued = 0;
  for (const target of targets) {
    const event = parseStripeCueEvent(
      rawBody,
      target.organisationId,
      target.integrationAccountId,
    );
    if (!event.ok) {
      if (event.error.code === "stripe_event_unsupported") {
        continue;
      }
      return stripeWebhookErrorResponse(event.error);
    }
    const requestId = newRequestId();
    await env.CUE_Q.send(
      createCueQueueMessage({
        requestId,
        receivedAt,
        event: event.value,
      }),
    );
    queued += 1;
    traceLog("stripe.connect_webhook_queued", {
      requestId,
      organisation_id: target.organisationId,
      integration_account_id: target.integrationAccountId,
      provider_account_id: accountId.value,
      native_id: event.value.nativeId,
      event_type: event.value.eventType,
    });
  }
  return jsonResponse({ ok: true, queued });
}

/**
 * The seller disconnected Pantry's application from the Stripe account. Each
 * live account of that Stripe account goes to the credential revocation. An
 * account that is already revoked is not listed again, so a repeated event
 * changes nothing.
 */
async function revokeDeauthorizedStripeAccounts(
  env: Env,
  targets: readonly ActiveProviderAccountTarget[],
  providerAccountId: string,
  receivedAt: number,
): Promise<Response> {
  let revoked = 0;
  for (const target of targets) {
    const scope = await OrganisationExecutionScope.resolve(
      env,
      target.organisationId,
    );
    if (!scope.ok) {
      return errorResponse(
        scope.error.code,
        "The organisation region is unavailable.",
        503,
      );
    }
    const outcome = await revokeAccountRemovedAtProvider({
      env,
      scope: scope.value,
      integrationAccountId: target.integrationAccountId,
      provider: "stripe",
      providerAccountId,
      reason: "stripe_application_deauthorized",
      now: receivedAt,
    });
    if (outcome.ok && outcome.value.kind === "revoked") revoked += 1;
  }
  return jsonResponse({ ok: true, revoked });
}

/** Whether the event is `account.application.deauthorized`, and for which app. */
function parseStripeDeauthorization(
  rawBody: string,
  clientId: string | undefined,
): "this_application" | "another_application" | "other" {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return "other";
  }
  if (!isRecord(raw) || raw.type !== "account.application.deauthorized") {
    return "other";
  }
  const application =
    isRecord(raw.data) && isRecord(raw.data.object)
      ? raw.data.object.id
      : undefined;
  return clientId === undefined || application === clientId
    ? "this_application"
    : "another_application";
}

export async function handleStripeWebhook(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }

  const organisationId = parseOrganisationId(
    decodePathSegmentValue(organisationIdRaw),
  );

  if (!organisationId.ok) {
    return notFound();
  }

  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;

  const secrets = await resolveStripeWebhookSecrets(env, scope);

  if (!secrets.ok) {
    return stripeWebhookErrorResponse(secrets.error);
  }

  const rawBody = await request.text();
  const selected = await selectStripeWebhookAccount({
    candidates: secrets.value,
    rawBody,
    signatureHeader: request.headers.get("stripe-signature"),
    nowMs: Date.now(),
  });

  if (!selected.ok) {
    return stripeWebhookErrorResponse(selected.error);
  }

  const receivedAt = Date.now();
  const event = parseStripeCueEvent(
    rawBody,
    organisationId.value,
    selected.value.integrationAccountId,
  );
  if (!event.ok) {
    if (event.error.code === "stripe_event_unsupported") {
      return jsonResponse({ ok: true, ignored: true });
    }
    return stripeWebhookErrorResponse(event.error);
  }

  const requestId = newRequestId();

  await env.CUE_Q.send(
    createCueQueueMessage({
      requestId,
      receivedAt,
      event: event.value,
    }),
  );
  traceLog("stripe.webhook_queued", {
    requestId,
    organisation_id: organisationId.value,
    integration_account_id: event.value.integrationAccountId,
    native_id: event.value.nativeId,
    event_type: event.value.eventType,
  });
  return jsonResponse({ ok: true });
}

export async function selectStripeWebhookAccount(input: {
  readonly candidates: readonly StripeWebhookSecretCandidate[];
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly nowMs: number;
}): Promise<Result<StripeWebhookSecretCandidate, StripeWebhookError>> {
  const matched: StripeWebhookSecretCandidate[] = [];
  let firstError: StripeWebhookError | null = null;

  for (const candidate of input.candidates) {
    const verified = await verifyStripeWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      signingSecret: candidate.signingSecret,
      nowMs: input.nowMs,
    });

    if (verified.ok) {
      matched.push(candidate);
    } else if (firstError === null) {
      firstError = verified.error;
    }
  }

  if (matched.length === 1) {
    const candidate = matched.at(0);

    if (candidate === undefined) {
      throw new Error("Stripe webhook candidate cardinality invariant failed");
    }

    return { ok: true, value: candidate };
  }

  if (matched.length > 1) {
    return { ok: false, error: { code: "stripe_connector_ambiguous" } };
  }

  return {
    ok: false,
    error: firstError ?? { code: "stripe_signature_invalid" },
  };
}

export function stripeWebhookErrorResponse(error: StripeWebhookError): Response {
  switch (error.code) {
    case "stripe_signature_missing":
    case "stripe_signature_invalid":
    case "stripe_signature_expired":
      return errorResponse(error.code, "Stripe signature was rejected.", 401);
    case "stripe_event_invalid":
    case "stripe_connect_account_missing":
      return errorResponse(error.code, "Stripe event is invalid.", 400);
    case "stripe_event_unsupported":
      return errorResponse(error.code, "Stripe event is unsupported.", 422);
    case "stripe_connector_missing":
      return notFound();
    case "stripe_connector_inactive":
      return errorResponse(error.code, "Stripe connector is inactive.", 503);
    case "stripe_connector_ambiguous":
      return errorResponse(
        error.code,
        "Stripe webhook account is ambiguous.",
        409,
      );
    case "stripe_webhook_secret_invalid":
    case "vault_handle_unknown":
    case "credential_rule_inactive":
    case "vault_secret_revoked":
    case "vault_root_unavailable":
    case "vault_root_invalid":
    case "vault_ciphertext_invalid":
    case "vault_plaintext_invalid":
      return errorResponse(
        error.code,
        "Stripe webhook verification is unavailable.",
        503,
      );
    default:
      return assertNever(error);
  }
}
