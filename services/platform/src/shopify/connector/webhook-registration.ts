import type { JsonObject } from "../../http";
import type { Result } from "../../result";
import type { VariantBy } from "@seams/type-utils";
import { isRecord } from "@seams/std";
import type {
  ShopifyWebhookRegistration,
  ShopifyWebhookRegistrationError,
  ShopifyWebhookSubscriptionResult,
  ShopifyWebhookTopic,
} from "../connector";
import { sendShopifyAdminGraphql } from "./admin-graphql";
import { validShopDomain } from "./values";

export type ShopifyRegistrationOperation = "list" | "create" | "update";

export type ShopifyWebhookSubscription = {
  subscriptionId: string;
  topic: ShopifyWebhookTopic;
  uri: string;
  format: "JSON" | "XML";
};

export const SHOPIFY_WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "INVENTORY_LEVELS_UPDATE",
  "PRODUCTS_CREATE",
  "PRODUCTS_DELETE",
  "PRODUCTS_UPDATE",
] as const satisfies readonly ShopifyWebhookTopic[];

export const SHOPIFY_WEBHOOK_LOOKUP_QUERY = `
  query SatyrWebhookSubscriptions($topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: 100, topics: $topics) {
      nodes {
        id
        topic
        uri
        format
      }
    }
  }
`;

export const SHOPIFY_WEBHOOK_CREATE_MUTATION = `
  mutation SatyrWebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SHOPIFY_WEBHOOK_UPDATE_MUTATION = `
  mutation SatyrWebhookSubscriptionUpdate(
    $id: ID!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(
      id: $id
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function registerShopifyWebhooks(input: {
  shopDomain: string;
  accessToken: string;
  endpointUrl: string;
  fetcher: typeof fetch;
}): Promise<
  Result<ShopifyWebhookRegistration, ShopifyWebhookRegistrationError>
> {
  if (
    !validShopDomain(input.shopDomain) ||
    input.accessToken.length < 10 ||
    !validWebhookUri(input.endpointUrl)
  ) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation: "list" },
    };
  }

  const existing = await listShopifyWebhooks(input);

  if (!existing.ok) {
    return existing;
  }

  const ordersCreate = await configureShopifyWebhookTopic(
    input,
    existing.value,
    "ORDERS_CREATE",
  );
  const normalizedOrdersCreate =
    normalizeProtectedOrderRegistration(ordersCreate);

  if (!normalizedOrdersCreate.ok) {
    return normalizedOrdersCreate;
  }

  const ordersUpdated = await configureShopifyWebhookTopic(
    input,
    existing.value,
    "ORDERS_UPDATED",
  );
  const normalizedOrdersUpdated =
    normalizeProtectedOrderRegistration(ordersUpdated);
  if (!normalizedOrdersUpdated.ok) {
    return normalizedOrdersUpdated;
  }

  const inventoryLevelsUpdate = await configureShopifyWebhookTopic(
    input,
    existing.value,
    "INVENTORY_LEVELS_UPDATE",
  );

  if (!inventoryLevelsUpdate.ok) {
    return inventoryLevelsUpdate;
  }

  const productsCreate = await configureShopifyWebhookTopic(
    input,
    existing.value,
    "PRODUCTS_CREATE",
  );

  if (!productsCreate.ok) {
    return productsCreate;
  }

  const productsUpdate = await configureShopifyWebhookTopic(
    input,
    existing.value,
    "PRODUCTS_UPDATE",
  );

  if (!productsUpdate.ok) {
    return productsUpdate;
  }

  const productsDelete = await configureShopifyWebhookTopic(
    input,
    existing.value,
    "PRODUCTS_DELETE",
  );

  if (!productsDelete.ok) {
    return productsDelete;
  }

  return {
    ok: true,
    value: {
      kind: "configured",
      ordersCreate: normalizedOrdersCreate.value,
      ordersUpdated: normalizedOrdersUpdated.value,
      inventoryLevelsUpdate: inventoryLevelsUpdate.value,
      productsCreate: productsCreate.value,
      productsDelete: productsDelete.value,
      productsUpdate: productsUpdate.value,
    },
  };
}

export function normalizeProtectedOrderRegistration<
  TTopic extends "ORDERS_CREATE" | "ORDERS_UPDATED",
>(
  registration: Result<
    ShopifyWebhookSubscriptionResult<TTopic>,
    ShopifyWebhookRegistrationError
  >,
): Result<
  | { kind: "live"; subscription: ShopifyWebhookSubscriptionResult<TTopic> }
  | { kind: "unavailable"; reasonCode: "provider_rejected" },
  ShopifyWebhookRegistrationError
> {
  if (registration.ok) {
    return {
      ok: true,
      value: { kind: "live", subscription: registration.value },
    };
  }

  if (isOptionalOrderWebhookRejection(registration.error)) {
    console.warn("shopify.order_webhook_unavailable", {
      operation: registration.error.operation,
      topic: registration.error.topic,
      messages: registration.error.messages,
    });
    return {
      ok: true,
      value: {
        kind: "unavailable",
        reasonCode: "provider_rejected",
      },
    };
  }

  return registration;
}

export function isOptionalOrderWebhookRejection(
  error: ShopifyWebhookRegistrationError,
): error is VariantBy<
  ShopifyWebhookRegistrationError,
  "code",
  "shopify_registration_rejected"
> {
  return (
    error.code === "shopify_registration_rejected" &&
    (error.topic === "ORDERS_CREATE" || error.topic === "ORDERS_UPDATED")
  );
}

export async function listShopifyWebhooks(input: {
  shopDomain: string;
  accessToken: string;
  endpointUrl: string;
  fetcher: typeof fetch;
}): Promise<
  Result<readonly ShopifyWebhookSubscription[], ShopifyWebhookRegistrationError>
> {
  const response = await sendShopifyAdminGraphql(input, "list", {
    query: SHOPIFY_WEBHOOK_LOOKUP_QUERY,
    variables: {
      topics: [...SHOPIFY_WEBHOOK_TOPICS],
    },
  });

  if (!response.ok) {
    return response;
  }

  return parseShopifyWebhookList(response.value);
}

export async function configureShopifyWebhookTopic<
  TTopic extends ShopifyWebhookTopic,
>(
  input: {
    shopDomain: string;
    accessToken: string;
    endpointUrl: string;
    fetcher: typeof fetch;
  },
  existing: readonly ShopifyWebhookSubscription[],
  topic: TTopic,
): Promise<
  Result<
    ShopifyWebhookSubscriptionResult<TTopic>,
    ShopifyWebhookRegistrationError
  >
> {
  const matching = matchingShopifySubscriptions(
    existing,
    topic,
    input.endpointUrl,
  );

  if (matching.length > 1) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation: "list" },
    };
  }

  const current = matching[0];

  if (current === undefined) {
    const stale = topicShopifySubscriptions(existing, topic);
    if (stale.length > 1) {
      return {
        ok: false,
        error: { code: "shopify_registration_invalid", operation: "list" },
      };
    }
    const staleCurrent = stale[0];
    return staleCurrent === undefined
      ? createShopifyWebhookTopic(input, topic)
      : updateShopifyWebhookTopic(input, staleCurrent, topic);
  }

  if (current.format === "JSON") {
    return {
      ok: true,
      value: {
        kind: "existing",
        topic,
        subscriptionId: current.subscriptionId,
        uri: current.uri,
      },
    };
  }

  return updateShopifyWebhookTopic(input, current, topic);
}

export async function createShopifyWebhookTopic<
  TTopic extends ShopifyWebhookTopic,
>(
  input: {
    shopDomain: string;
    accessToken: string;
    endpointUrl: string;
    fetcher: typeof fetch;
  },
  topic: TTopic,
): Promise<
  Result<
    ShopifyWebhookSubscriptionResult<TTopic>,
    ShopifyWebhookRegistrationError
  >
> {
  const response = await sendShopifyAdminGraphql(input, "create", {
    query: SHOPIFY_WEBHOOK_CREATE_MUTATION,
    variables: {
      topic,
      webhookSubscription: webhookSubscriptionInput(input.endpointUrl, topic),
    },
  });

  if (!response.ok) {
    return response;
  }

  const subscription = parseShopifyWebhookMutation(
    response.value,
    "webhookSubscriptionCreate",
    "create",
    topic,
    input.endpointUrl,
  );

  return subscription.ok
    ? {
        ok: true,
        value: {
          kind: "created",
          topic,
          subscriptionId: subscription.value.subscriptionId,
          uri: subscription.value.uri,
        },
      }
    : subscription;
}

export async function updateShopifyWebhookTopic<
  TTopic extends ShopifyWebhookTopic,
>(
  input: {
    shopDomain: string;
    accessToken: string;
    endpointUrl: string;
    fetcher: typeof fetch;
  },
  current: ShopifyWebhookSubscription,
  topic: TTopic,
): Promise<
  Result<
    ShopifyWebhookSubscriptionResult<TTopic>,
    ShopifyWebhookRegistrationError
  >
> {
  const response = await sendShopifyAdminGraphql(input, "update", {
    query: SHOPIFY_WEBHOOK_UPDATE_MUTATION,
    variables: {
      id: current.subscriptionId,
      webhookSubscription: webhookSubscriptionInput(input.endpointUrl, topic),
    },
  });

  if (!response.ok) {
    return response;
  }

  const subscription = parseShopifyWebhookMutation(
    response.value,
    "webhookSubscriptionUpdate",
    "update",
    topic,
    input.endpointUrl,
  );

  return subscription.ok
    ? {
        ok: true,
        value: {
          kind: "updated",
          topic,
          subscriptionId: subscription.value.subscriptionId,
          uri: subscription.value.uri,
        },
      }
    : subscription;
}

export function parseShopifyWebhookList(
  raw: unknown,
): Result<
  readonly ShopifyWebhookSubscription[],
  ShopifyWebhookRegistrationError
> {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation: "list" },
    };
  }

  const connection = raw.data.webhookSubscriptions;

  if (!isRecord(connection) || !Array.isArray(connection.nodes)) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation: "list" },
    };
  }

  const subscriptions: ShopifyWebhookSubscription[] = [];

  for (const node of connection.nodes) {
    const parsed = parseShopifyWebhookNode(node);

    if (!parsed.ok) {
      return parsed;
    }

    subscriptions.push(parsed.value);
  }

  return { ok: true, value: subscriptions };
}

export function parseShopifyWebhookNode(
  raw: unknown,
): Result<ShopifyWebhookSubscription, ShopifyWebhookRegistrationError> {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !isShopifyWebhookTopic(raw.topic) ||
    typeof raw.uri !== "string" ||
    !isShopifyWebhookFormat(raw.format)
  ) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation: "list" },
    };
  }

  return {
    ok: true,
    value: {
      subscriptionId: raw.id,
      topic: raw.topic,
      uri: raw.uri,
      format: raw.format,
    },
  };
}

export function parseShopifyWebhookMutation(
  raw: unknown,
  payloadField: "webhookSubscriptionCreate" | "webhookSubscriptionUpdate",
  operation: "create" | "update",
  topic: ShopifyWebhookTopic,
  endpointUrl: string,
): Result<ShopifyWebhookSubscription, ShopifyWebhookRegistrationError> {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation },
    };
  }

  const payload = raw.data[payloadField];

  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation },
    };
  }

  if (payload.userErrors.length > 0) {
    const messages = parseShopifyUserErrorMessages(payload.userErrors);

    if (!messages.ok) {
      return {
        ok: false,
        error: { code: "shopify_registration_invalid", operation },
      };
    }

    return {
      ok: false,
      error: {
        code: "shopify_registration_rejected",
        operation,
        topic,
        messages: messages.value,
      },
    };
  }

  const subscription = payload.webhookSubscription;

  if (
    !isRecord(subscription) ||
    typeof subscription.id !== "string" ||
    subscription.topic !== topic ||
    subscription.uri !== endpointUrl
  ) {
    return {
      ok: false,
      error: { code: "shopify_registration_invalid", operation },
    };
  }

  return {
    ok: true,
    value: {
      subscriptionId: subscription.id,
      topic,
      uri: endpointUrl,
      format: "JSON",
    },
  };
}

export function parseShopifyUserErrorMessages(
  raw: readonly unknown[],
): Result<readonly string[], ShopifyWebhookRegistrationError> {
  const messages: string[] = [];

  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.message !== "string" ||
      entry.message.length === 0 ||
      entry.message.length > 500
    ) {
      return {
        ok: false,
        error: { code: "shopify_registration_invalid", operation: "create" },
      };
    }

    messages.push(entry.message);
  }

  return { ok: true, value: messages };
}

export function matchingShopifySubscriptions(
  subscriptions: readonly ShopifyWebhookSubscription[],
  topic: ShopifyWebhookTopic,
  endpointUrl: string,
): readonly ShopifyWebhookSubscription[] {
  const matches: ShopifyWebhookSubscription[] = [];

  for (const subscription of subscriptions) {
    if (subscription.topic === topic && subscription.uri === endpointUrl) {
      matches.push(subscription);
    }
  }

  return matches;
}

export function topicShopifySubscriptions(
  subscriptions: readonly ShopifyWebhookSubscription[],
  topic: ShopifyWebhookTopic,
): readonly ShopifyWebhookSubscription[] {
  return subscriptions.filter((subscription) => subscription.topic === topic);
}

export function webhookSubscriptionInput(
  endpointUrl: string,
  topic: ShopifyWebhookTopic,
): JsonObject {
  return {
    uri: endpointUrl,
    format: "JSON",
    name: shopifyWebhookName(topic),
  };
}

export function validWebhookUri(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.origin !== "null";
  } catch {
    return false;
  }
}

export function isShopifyWebhookTopic(
  raw: unknown,
): raw is ShopifyWebhookTopic {
  return (
    raw === "ORDERS_CREATE" ||
    raw === "ORDERS_UPDATED" ||
    raw === "INVENTORY_LEVELS_UPDATE" ||
    raw === "PRODUCTS_CREATE" ||
    raw === "PRODUCTS_DELETE" ||
    raw === "PRODUCTS_UPDATE"
  );
}

export function shopifyWebhookName(topic: ShopifyWebhookTopic): string {
  switch (topic) {
    case "ORDERS_CREATE":
      return "satyr-orders-create";
    case "ORDERS_UPDATED":
      return "satyr-orders-updated";
    case "INVENTORY_LEVELS_UPDATE":
      return "satyr-inventory-levels-update";
    case "PRODUCTS_CREATE":
      return "satyr-products-create";
    case "PRODUCTS_DELETE":
      return "satyr-products-delete";
    case "PRODUCTS_UPDATE":
      return "satyr-products-update";
  }
}

export function isShopifyWebhookFormat(raw: unknown): raw is "JSON" | "XML" {
  return raw === "JSON" || raw === "XML";
}
