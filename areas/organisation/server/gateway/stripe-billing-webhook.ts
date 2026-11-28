import type { Env } from "@purin-labs/kernel/env";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
} from "@purin-labs/kernel/http";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import { applyStripeBillingEvent } from "../billing/stripe-event";

/** The largest event body that the webhook reads. A Stripe event is far smaller. */
const MAX_EVENT_BYTES = 262_144;

/**
 * `POST /webhooks/stripe-billing`: the webhook of Pantry's own Stripe
 * account, with its own signing secret (Plan 95 step 6). It is not the
 * webhook of a shop's Stripe account; those belong to Commerce.
 */
export async function handleStripeBillingWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const rawBody = await request.text();
  if (rawBody.length > MAX_EVENT_BYTES)
    return errorResponse(
      "billing_event_invalid",
      "The billing event is too large.",
      413,
    );
  const applied = await applyStripeBillingEvent({
    env,
    rawBody,
    signatureHeader: request.headers.get("stripe-signature"),
    now: Date.now(),
  });
  if (applied.ok) {
    if (applied.value.kind === "changed")
      traceLog("billing.payment_state_changed", {
        requestId: newRequestId(),
        organisation_id: applied.value.organisationId,
        payment_state: applied.value.paymentState,
      });
    return jsonResponse({ ok: true, outcome: applied.value.kind });
  }
  switch (applied.error.code) {
    case "billing_closed":
    case "billing_unavailable":
      // Stripe sends the event again after a 503.
      return errorResponse(applied.error.code, "Billing is unavailable.", 503);
    case "stripe_signature_missing":
    case "stripe_signature_invalid":
    case "stripe_signature_expired":
      return errorResponse(
        applied.error.code,
        "The Stripe signature is not valid.",
        400,
      );
    case "billing_event_invalid":
      return errorResponse(
        applied.error.code,
        "The billing event is not valid.",
        400,
      );
  }
}
