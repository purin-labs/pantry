import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";

export type ActionFieldSource =
  | {
      kind: "required_string";
      name: "shopDomain" | "orderId";
      pattern: string;
      maximumLength: number;
    }
  | {
      kind: "nullable_string";
      name: "staffNote";
      maximumLength: number;
    }
  | {
      kind: "enum";
      name: "cancelReason";
      values: readonly string[];
    }
  | {
      kind: "boolean";
      name: "refundOriginal" | "restock" | "notifyCustomer";
    };

type ActionSourceBase = {
  stakes: "high_stakes";
  idempotency: "none";
  credentialScope: "write";
  fields: readonly ActionFieldSource[];
  auditFields: readonly string[];
};

type ShopifyActionSource = ActionSourceBase & {
  id: "shopify_order_cancel";
  capabilityId: typeof CAPABILITY_KEYS.shopifyOrderCancel;
  command: "pantry-shopify-order-cancel";
  provider: "shopify";
  verb: "order.cancel";
  method: "POST";
  host: "*.myshopify.com";
  path: "/admin/api/2026-07/graphql.json";
  resourceKey: "shopify:order:{orderId}";
  idempotency: "none";
};

export type ActionSource = ShopifyActionSource;

export const ACTION_REGISTRY: readonly ActionSource[] = [
  {
    id: "shopify_order_cancel",
    capabilityId: CAPABILITY_KEYS.shopifyOrderCancel,
    command: "pantry-shopify-order-cancel",
    provider: "shopify",
    verb: "order.cancel",
    method: "POST",
    host: "*.myshopify.com",
    path: "/admin/api/2026-07/graphql.json",
    stakes: "high_stakes",
    resourceKey: "shopify:order:{orderId}",
    idempotency: "none",
    credentialScope: "write",
    auditFields: [
      "shopDomain",
      "orderId",
      "cancelReason",
      "refundOriginal",
      "restock",
      "notifyCustomer",
      "staffNote",
    ],
    fields: [
      {
        kind: "required_string",
        name: "shopDomain",
        pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$",
        maximumLength: 255,
      },
      {
        kind: "required_string",
        name: "orderId",
        pattern: "^gid://shopify/Order/[0-9]+$",
        maximumLength: 255,
      },
      {
        kind: "enum",
        name: "cancelReason",
        values: [
          "CUSTOMER",
          "DECLINED",
          "FRAUD",
          "INVENTORY",
          "OTHER",
          "STAFF",
        ],
      },
      { kind: "boolean", name: "refundOriginal" },
      { kind: "boolean", name: "restock" },
      { kind: "boolean", name: "notifyCustomer" },
      { kind: "nullable_string", name: "staffNote", maximumLength: 255 },
    ],
  },
];
