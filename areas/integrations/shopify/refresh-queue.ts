// The Shopify messages of the event queue (Refactor 17, step A2.5): the
// fresh read of one order. The event queue of the webhook surface reads a
// message through the provider module port, and it acks or retries the
// message after the handler of this file.
import type { CanonicalCommerceDelivery } from "@purin-labs/commerce-contracts";
import { createCommerceDeliveryQueueMessage } from "@purin-labs/area-commerce-contract/server/queue-messages";
import type {
  ProviderQueueMessages,
  ProviderQueueOutcome,
} from "@purin-labs/area-integrations/server/contract/provider-modules";
import type { Env } from "@purin-labs/kernel/env";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { resolveShopifyWriteCredential } from "./action-execution";
import { fetchShopifyOrderCommerceRefresh } from "./connector/initial-sync";
import {
  normalizeShopifyCommerceOrderDelivery,
  normalizeShopifyCommerceResourceDelivery,
} from "./delivery-normalizers";
import {
  parseShopifyCommerceRefreshQueuePayload,
  type ShopifyCommerceRefreshQueueMessage,
} from "./queue-messages";

export const SHOPIFY_QUEUE_MESSAGES: ProviderQueueMessages = {
  parse(type, body) {
    if (type !== "shopify.commerce_refresh.v1") return null;
    const parsed = parseShopifyCommerceRefreshQueuePayload(body);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      value: {
        type: parsed.value.type,
        run: (env, messageId) =>
          handleShopifyCommerceRefresh(env, messageId, parsed.value),
      },
    };
  },
};

/**
 * Reads the order of a refresh message from the shop, and queues one
 * commerce delivery for the order and for each of its resources.
 */
async function handleShopifyCommerceRefresh(
  env: Env,
  messageId: string,
  body: ShopifyCommerceRefreshQueueMessage,
): Promise<ProviderQueueOutcome> {
  const credential = await resolveShopifyWriteCredential({
    env,
    organisationId: body.organisationId,
    integrationAccountId: body.integrationAccountId,
    fetcher: runtimeFetch,
    now: Date.now(),
  });
  if (!credential.ok || credential.value.shopDomain !== body.shopDomain) {
    traceWarn("event_queue.shopify_refresh_credential_unavailable", {
      requestId: body.requestId,
      message_id: messageId,
      webhook_id: body.webhookId,
    });
    return "retry";
  }

  const snapshot = await fetchShopifyOrderCommerceRefresh({
    shopDomain: credential.value.shopDomain,
    accessToken: credential.value.accessToken,
    organisationId: body.organisationId,
    integrationAccountId: body.integrationAccountId,
    observedAt: body.receivedAt,
    orderGid: body.target.orderGid,
    webhookId: body.webhookId,
    fetcher: runtimeFetch,
  });
  if (!snapshot.ok) {
    traceWarn("event_queue.shopify_refresh_failed", {
      requestId: body.requestId,
      message_id: messageId,
      webhook_id: body.webhookId,
      reason: snapshot.error.code,
    });
    return "retry";
  }

  const deliveries: CanonicalCommerceDelivery[] = [];
  const order = normalizeShopifyCommerceOrderDelivery(snapshot.value.order);
  if (!order.ok) return "retry";
  deliveries.push(order.value);
  for (const resource of snapshot.value.resources) {
    const normalized = normalizeShopifyCommerceResourceDelivery(resource);
    if (!normalized.ok) return "retry";
    deliveries.push(normalized.value);
  }
  for (const delivery of deliveries) {
    await env.EVENT_Q.send(
      createCommerceDeliveryQueueMessage({
        requestId: body.requestId,
        receivedAt: body.receivedAt,
        organisationId: body.organisationId,
        integrationAccountId: body.integrationAccountId,
        labRunId: null,
        canonicalDeliveryJson: JSON.stringify(delivery),
        canonicalCueFactsJson: "[]",
      }),
      { contentType: "json" },
    );
  }
  traceLog("event_queue.shopify_refresh_queued", {
    requestId: body.requestId,
    message_id: messageId,
    webhook_id: body.webhookId,
    delivery_count: deliveries.length,
  });
  return "ack";
}
