import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../organisation-execution-scope";
import { resolveActiveOrganisationPlacement } from "../data/organisation-placement";
import {
  routeWhatsAppWebhookAccount,
  whatsappConnectorIdValue,
} from "../data/whatsapp";
import {
  parseWhatsAppWebhookBody,
  verifyWhatsAppWebhookChallenge,
  verifyWhatsAppWebhookSignature,
  type WhatsAppWebhookEvent,
} from "./webhook";
import type { WhatsAppAdmissionRequest } from "../actors/connector-whatsapp-rpc";
import type { Env } from "../env";
import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import {
  newRequestId,
  parseConnectorId,
  parseOrganisationId,
  type RequestId,
} from "../ids";
import {
  traceLog,
  traceWarn,
} from "../observability";

/**
 * Meta's single WhatsApp callback. `GET` answers the subscription challenge;
 * `POST` verifies `X-Hub-Signature-256` over the exact request bytes, parses
 * the payload into the closed event union, routes each event to the one
 * account that owns the phone-number asset, and durably admits it to that
 * account's Connector before returning success. Admission failure returns an
 * error so Meta retries; a verified duplicate returns success without
 * creating a second cue.
 */
export async function handleWhatsAppWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const requestId = newRequestId();
  const url = new URL(request.url);
  if (request.method === "GET") {
    const challenge = verifyWhatsAppWebhookChallenge({
      url,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    });
    if (!challenge.ok) {
      traceWarn("integration_gateway.whatsapp_challenge_rejected", {
        requestId,
        reason: challenge.error.code,
      });
      const status =
        challenge.error.code === "whatsapp_verify_token_missing" ? 503 : 403;
      return new Response("forbidden", { status });
    }
    return new Response(challenge.value.challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const rawBody = await request.text();
  const verified = await verifyWhatsAppWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get("x-hub-signature-256"),
    appSecret: env.WHATSAPP_APP_SECRET,
  });
  if (!verified.ok) {
    traceWarn("integration_gateway.whatsapp_signature_rejected", {
      requestId,
      reason: verified.error.code,
    });
    const status =
      verified.error.code === "whatsapp_app_secret_missing" ? 503 : 401;
    return Response.json({ error: verified.error.code }, { status });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ kind: "ignored" }, { status: 200 });
  }
  const parsed = parseWhatsAppWebhookBody(payload);
  if (!parsed.ok) {
    traceLog("integration_gateway.whatsapp_payload_ignored", {
      requestId,
      reason: parsed.error.field,
    });
    return Response.json({ kind: "ignored" }, { status: 200 });
  }
  const now = Date.now();
  for (const event of parsed.value) {
    const admitted = await admitWhatsAppWebhookEvent({
      env,
      event,
      requestId,
      now,
    });
    if (admitted.kind === "retry") {
      return Response.json({ error: admitted.reason }, { status: 503 });
    }
  }
  return Response.json({ kind: "accepted" }, { status: 200 });
}

export type WhatsAppWebhookAdmission =
  | { readonly kind: "accepted" }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "retry"; readonly reason: string };

export async function admitWhatsAppWebhookEvent(
  input: Readonly<{
    env: Env;
    event: WhatsAppWebhookEvent;
    requestId: RequestId;
    now: number;
  }>,
): Promise<WhatsAppWebhookAdmission> {
  let route: Awaited<ReturnType<typeof routeWhatsAppWebhookAccount>> = null;
  for (const database of configuredOrganisationDatabases(input.env)) {
    const candidate = await routeWhatsAppWebhookAccount({
      db: database,
      wabaId: input.event.wabaId,
      phoneNumberId: input.event.phoneNumberId,
    });
    if (candidate === null) continue;
    const organisation = parseOrganisationId(candidate.organisationId);
    if (!organisation.ok) return { kind: "retry", reason: "identity_invalid" };
    const execution = await OrganisationExecutionScope.resolve(
      input.env,
      organisation.value,
    );
    if (!execution.ok) return { kind: "retry", reason: execution.error.code };
    if (execution.value.database !== database) continue;
    if (route !== null)
      return { kind: "retry", reason: "account_route_ambiguous" };
    route = candidate;
  }
  if (route === null) {
    traceLog("integration_gateway.whatsapp_event_unroutable", {
      requestId: input.requestId,
      reason: "account_unroutable",
    });
    return { kind: "ignored", reason: "account_unroutable" };
  }
  const organisationId = parseOrganisationId(route.organisationId);
  const connectorId = parseConnectorId(
    whatsappConnectorIdValue(route.integrationAccountId),
  );
  if (!organisationId.ok || !connectorId.ok) {
    return { kind: "ignored", reason: "identity_invalid" };
  }
  const placement = await resolveActiveOrganisationPlacement(
    input.env.DB,
    organisationId.value,
  );
  if (!placement.ok) {
    return { kind: "retry", reason: placement.error.code };
  }
  const connector = await resolveActiveConnectorActorAtPlacement({
    env: input.env,
    namespace: input.env.CONNECTOR,
    organisationId: organisationId.value,
    connectorId: connectorId.value,
    placement: placement.value,
    now: input.now,
  });
  if (!connector.ok) {
    return { kind: "retry", reason: connector.error.code };
  }
  const accepted = await connector.value.acceptWhatsAppEvent({
    identity: {
      organisationId: organisationId.value,
      connectorId: connectorId.value,
    },
    event: whatsappAdmissionRequest(input.event),
    now: input.now,
  });
  return accepted.ok
    ? { kind: "accepted" }
    : { kind: "retry", reason: accepted.error.code };
}

export function whatsappAdmissionRequest(
  event: WhatsAppWebhookEvent,
): WhatsAppAdmissionRequest {
  switch (event.kind) {
    case "text_message":
      return {
        kind: "text_message",
        customerWaId: event.customerWaId,
        providerMessageId: event.providerMessageId,
        providerTimestamp: event.providerTimestamp,
        body: event.body,
      };
    case "unsupported_message":
      return {
        kind: "unsupported_message",
        customerWaId: event.customerWaId,
        providerMessageId: event.providerMessageId,
        messageType: event.messageType,
      };
    case "status":
      return {
        kind: "status",
        whatsappMessageId: event.whatsappMessageId,
        status: event.status,
        statusAt: event.statusAt,
        failureCode: event.failureCode,
      };
  }
}
