import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import type { Env } from "@purin-labs/kernel/env";
import { createEmailChangeQueueMessage } from "../mail/queue-messages";
import {
  parseGmailPushEnvelope,
  readGmailPushBody,
  verifyGooglePushToken,
} from "./google-pubsub";
import { channelIngress } from "@purin-labs/area-inbox-contract/server/channel-ingress";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
} from "@purin-labs/kernel/ids";
import {
  traceLog,
  traceWarn,
} from "@purin-labs/kernel/observability";

/**
 * Gmail Pub/Sub push boundary. The push token is verified against Google's
 * JWKS with the configured audience and service-account identity; the
 * envelope is a droppable hint, so unroutable payloads acknowledge with 200
 * and only durable-queue failures ask Pub/Sub to retry.
 */
export async function handleEmailGoogleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const requestId = newRequestId();
  const now = Date.now();
  const verified = await verifyGooglePushToken({
    authorizationHeader: request.headers.get("authorization"),
    audience: env.GMAIL_PUBSUB_AUDIENCE,
    serviceAccountEmail: env.GMAIL_PUBSUB_SERVICE_ACCOUNT,
    now,
    fetcher: runtimeFetch,
  });
  if (!verified.ok) {
    const status =
      verified.error.code === "pubsub_configuration_missing" ? 503 : 401;
    traceWarn("integration_gateway.email_push_rejected", {
      requestId,
      reason: verified.error.code,
    });
    return Response.json({ error: verified.error.code }, { status });
  }
  const envelope = parseGmailPushEnvelope(
    readGmailPushBody(await request.text()),
  );
  if (!envelope.ok) {
    traceLog("integration_gateway.email_push_ignored", {
      requestId,
      reason: envelope.error.code,
    });
    return Response.json({ kind: "ignored" }, { status: 200 });
  }
  const mailbox = await channelIngress.use().findEmailMailboxByAddress({
    env,
    observedAddress: envelope.value.emailAddress,
  });
  if (mailbox === null) {
    traceLog("integration_gateway.email_push_ignored", {
      requestId,
      reason: "mailbox_unroutable",
    });
    return Response.json({ kind: "ignored" }, { status: 200 });
  }
  const organisationId = parseOrganisationId(mailbox.organisationId);
  const integrationAccountId = parseIntegrationAccountId(
    mailbox.integrationAccountId,
  );
  if (!organisationId.ok || !integrationAccountId.ok) {
    return Response.json({ kind: "ignored" }, { status: 200 });
  }
  try {
    await env.EVENT_Q.send(
      createEmailChangeQueueMessage({
        requestId,
        receivedAt: now,
        organisationId: organisationId.value,
        integrationAccountId: integrationAccountId.value,
        historyId: envelope.value.historyId,
        notificationId: envelope.value.notificationId,
      }),
    );
  } catch {
    return Response.json({ error: "queue_unavailable" }, { status: 500 });
  }
  return Response.json({ kind: "accepted" }, { status: 200 });
}
