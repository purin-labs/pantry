import type { Result } from "../result";
import { isRecord } from "@purin-labs/std";

const SHOPIFY_ADMIN_API_VERSION = "2026-07";

type ShopifyAcceptanceOperation =
  "verify_development_store" | "resolve_variant" | "create_order";

const SHOPIFY_ACCEPTANCE_SKU = "PANTRY-CK4-20260809";

type ShopifyDevelopmentOrderTrigger = {
  kind: "development_order_submitted";
  provider: "shopify";
  shopDomain: string;
  sourceIdentifier: string;
};

export type ShopifyDevelopmentOrderTriggerError =
  | { code: "shopify_acceptance_credential_invalid" }
  | {
      code: "shopify_acceptance_transport_failed";
      operation: ShopifyAcceptanceOperation;
    }
  | {
      code: "shopify_acceptance_request_failed";
      operation: ShopifyAcceptanceOperation;
      status: number;
    }
  | {
      code: "shopify_acceptance_response_invalid";
      operation: ShopifyAcceptanceOperation;
    }
  | {
      code: "shopify_acceptance_graphql_error";
      operation: ShopifyAcceptanceOperation;
    }
  | { code: "shopify_acceptance_store_not_development" }
  | { code: "shopify_acceptance_variant_not_found" }
  | { code: "shopify_acceptance_order_rejected" };

type ShopifyAcceptanceGraphqlResponse = {
  data: Record<string, unknown>;
};

export async function triggerShopifyDevelopmentOrder(input: {
  shopDomain: string;
  accessToken: string;
  sourceIdentifier: string;
  fetcher: typeof fetch;
}): Promise<
  Result<ShopifyDevelopmentOrderTrigger, ShopifyDevelopmentOrderTriggerError>
> {
  if (
    !isShopifyDomain(input.shopDomain) ||
    input.accessToken.length < 10 ||
    !isAcceptanceSourceIdentifier(input.sourceIdentifier)
  ) {
    return {
      ok: false,
      error: { code: "shopify_acceptance_credential_invalid" },
    };
  }

  const plan = await sendShopifyAcceptanceGraphql(
    input,
    "verify_development_store",
    {
      query:
        "query PantryAcceptanceShopPlan { shop { plan { partnerDevelopment } } }",
      variables: {},
    },
  );

  if (!plan.ok) {
    return plan;
  }

  const development = parseDevelopmentShop(plan.value);

  if (!development.ok) {
    return development;
  }

  if (!development.value) {
    return {
      ok: false,
      error: { code: "shopify_acceptance_store_not_development" },
    };
  }

  const variant = await sendShopifyAcceptanceGraphql(input, "resolve_variant", {
    query: `query PantryAcceptanceVariant($query: String!) {
      productVariants(first: 1, query: $query) { nodes { id sku } }
    }`,
    variables: { query: `sku:${SHOPIFY_ACCEPTANCE_SKU}` },
  });

  if (!variant.ok) {
    return variant;
  }

  const variantId = parseAcceptanceVariantId(variant.value);

  if (!variantId.ok) {
    return variantId;
  }

  const created = await sendShopifyAcceptanceGraphql(input, "create_order", {
    query: `mutation PantryAcceptanceOrder($order: OrderCreateOrderInput!) {
      orderCreate(order: $order) {
        userErrors { field message }
      }
    }`,
    variables: {
      order: {
        currency: "USD",
        financialStatus: "PENDING",
        lineItems: [
          {
            quantity: 1,
            variantId: variantId.value,
          },
        ],
        sourceIdentifier: input.sourceIdentifier,
        tags: ["pantry-m8-acceptance"],
        test: true,
      },
    },
  });

  if (!created.ok) {
    return created;
  }

  const accepted = parseAcceptedOrderSubmission(created.value);

  return accepted.ok
    ? {
        ok: true,
        value: {
          kind: "development_order_submitted",
          provider: "shopify",
          shopDomain: input.shopDomain,
          sourceIdentifier: input.sourceIdentifier,
        },
      }
    : accepted;
}

function parseAcceptanceVariantId(
  raw: ShopifyAcceptanceGraphqlResponse,
): Result<string, ShopifyDevelopmentOrderTriggerError> {
  const variants = raw.data.productVariants;

  if (!isRecord(variants) || !Array.isArray(variants.nodes)) {
    return {
      ok: false,
      error: {
        code: "shopify_acceptance_response_invalid",
        operation: "resolve_variant",
      },
    };
  }

  const variant = variants.nodes[0];
  if (
    !isRecord(variant) ||
    typeof variant.id !== "string" ||
    variant.sku !== SHOPIFY_ACCEPTANCE_SKU
  ) {
    return {
      ok: false,
      error: { code: "shopify_acceptance_variant_not_found" },
    };
  }

  return { ok: true, value: variant.id };
}

async function sendShopifyAcceptanceGraphql(
  input: { shopDomain: string; accessToken: string; fetcher: typeof fetch },
  operation: ShopifyAcceptanceOperation,
  body: { query: string; variables: Record<string, unknown> },
): Promise<
  Result<ShopifyAcceptanceGraphqlResponse, ShopifyDevelopmentOrderTriggerError>
> {
  let response: Response;

  try {
    const fetcher = input.fetcher;
    response = await fetcher(
      `https://${input.shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": input.accessToken,
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return {
      ok: false,
      error: { code: "shopify_acceptance_transport_failed", operation },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "shopify_acceptance_request_failed",
        operation,
        status: response.status,
      },
    };
  }

  let raw: unknown;

  try {
    raw = await response.json();
  } catch {
    return {
      ok: false,
      error: { code: "shopify_acceptance_response_invalid", operation },
    };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      error: { code: "shopify_acceptance_response_invalid", operation },
    };
  }

  if (Array.isArray(raw.errors) && raw.errors.length > 0) {
    return {
      ok: false,
      error: { code: "shopify_acceptance_graphql_error", operation },
    };
  }

  if (!isRecord(raw.data)) {
    return {
      ok: false,
      error: { code: "shopify_acceptance_response_invalid", operation },
    };
  }

  return { ok: true, value: { data: raw.data } };
}

function parseDevelopmentShop(
  raw: ShopifyAcceptanceGraphqlResponse,
): Result<boolean, ShopifyDevelopmentOrderTriggerError> {
  const shop = raw.data.shop;

  if (
    !isRecord(shop) ||
    !isRecord(shop.plan) ||
    typeof shop.plan.partnerDevelopment !== "boolean"
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_acceptance_response_invalid",
        operation: "verify_development_store",
      },
    };
  }

  return { ok: true, value: shop.plan.partnerDevelopment };
}

function parseAcceptedOrderSubmission(
  raw: ShopifyAcceptanceGraphqlResponse,
): Result<true, ShopifyDevelopmentOrderTriggerError> {
  const payload = raw.data.orderCreate;

  if (!isRecord(payload) || !Array.isArray(payload.userErrors)) {
    return {
      ok: false,
      error: {
        code: "shopify_acceptance_response_invalid",
        operation: "create_order",
      },
    };
  }

  if (payload.userErrors.length > 0) {
    return { ok: false, error: { code: "shopify_acceptance_order_rejected" } };
  }

  return { ok: true, value: true };
}

function isShopifyDomain(raw: string): boolean {
  return raw.length <= 255 && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(raw);
}

function isAcceptanceSourceIdentifier(raw: string): boolean {
  return raw.length <= 128 && /^pantry-m8-[0-9a-f-]{36}$/u.test(raw);
}
