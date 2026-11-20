// The queue message that asks for a fresh read of one Shopify order.
// This file holds its type, its constructor and its parser.
// `ingress-queue.ts` calls the parser when it reads the event queue.

import { isRecord } from "@purin-labs/std";

import type { JsonObject } from "../http";
import type { IntegrationAccountId, OrganisationId, RequestId } from "../ids";
import {
  readIntegrationAccountId,
  readOrganisationId,
  readRequestId,
  readRequiredNumber,
  readRequiredString,
  type IngressQueueMessageError,
} from "../queue-fields";
import type { Result } from "../result";

export type ShopifyCommerceRefreshQueueMessage = {
  readonly type: "shopify.commerce_refresh.v1";
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly shopDomain: string;
  readonly webhookId: string;
  readonly target: {
    readonly kind: "order";
    readonly orderGid: string;
  };
};

export function createShopifyCommerceRefreshQueueMessage(input: {
  readonly requestId: RequestId;
  readonly receivedAt: number;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly shopDomain: string;
  readonly webhookId: string;
  readonly target: ShopifyCommerceRefreshQueueMessage["target"];
}): ShopifyCommerceRefreshQueueMessage {
  return { type: "shopify.commerce_refresh.v1", ...input };
}

export function parseShopifyCommerceRefreshQueuePayload(
  body: JsonObject,
): Result<ShopifyCommerceRefreshQueueMessage, IngressQueueMessageError> {
  const requestId = readRequestId(body);
  if (!requestId.ok) return requestId;
  const receivedAt = readRequiredNumber(body, "receivedAt");
  if (
    !receivedAt.ok ||
    !Number.isSafeInteger(receivedAt.value) ||
    receivedAt.value < 0
  ) {
    return { ok: false, error: { code: "invalid_field", field: "receivedAt" } };
  }
  const organisationId = readOrganisationId(body);
  if (!organisationId.ok) return organisationId;
  const integrationAccountId = readIntegrationAccountId(body);
  if (!integrationAccountId.ok) return integrationAccountId;
  const shopDomain = readRequiredString(body, "shopDomain");
  if (
    !shopDomain.ok ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/iu.test(shopDomain.value)
  ) {
    return { ok: false, error: { code: "invalid_field", field: "shopDomain" } };
  }
  const webhookId = readRequiredString(body, "webhookId");
  if (!webhookId.ok || webhookId.value.length > 256) {
    return { ok: false, error: { code: "invalid_field", field: "webhookId" } };
  }
  if (
    !isRecord(body.target) ||
    body.target.kind !== "order" ||
    typeof body.target.orderGid !== "string" ||
    !/^gid:\/\/shopify\/Order\/[0-9]+$/u.test(body.target.orderGid)
  ) {
    return { ok: false, error: { code: "invalid_field", field: "target" } };
  }
  return {
    ok: true,
    value: {
      type: "shopify.commerce_refresh.v1",
      requestId: requestId.value,
      receivedAt: receivedAt.value,
      organisationId: organisationId.value,
      integrationAccountId: integrationAccountId.value,
      shopDomain: shopDomain.value,
      webhookId: webhookId.value,
      target: { kind: "order", orderGid: body.target.orderGid },
    },
  };
}
