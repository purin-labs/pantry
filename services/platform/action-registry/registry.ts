import { CAPABILITY_KEYS } from "../src/authorization/capability-catalogue.ts";

export type ActionFieldSource =
  | {
      kind: "integer";
      name: "amountMinor";
      minimum: number;
      maximum: number;
    }
  | {
      kind: "literal";
      name: "currency" | "source" | "payoutMethod";
      value: string;
    }
  | {
      kind: "required_string";
      name:
        | "chargeId"
        | "subscriptionId"
        | "destinationId"
        | "destinationAccountId"
        | "paymentIntentId"
        | "paymentMethodId"
        | "shopDomain"
        | "orderId";
      pattern: string;
      maximumLength: number;
    }
  | {
      kind: "nullable_string";
      name: "description" | "staffNote";
      maximumLength: number;
    }
  | {
      kind: "enum";
      name: "cancelReason";
      values: readonly string[];
    }
  | {
      kind: "nullable_enum";
      name: "reason";
      values: readonly string[];
    }
  | {
      kind: "boolean";
      name:
        | "invoiceNow"
        | "prorate"
        | "cancelAtPeriodEnd"
        | "refundOriginal"
        | "restock"
        | "notifyCustomer";
    };

type ActionSourceBase = {
  stakes: "high_stakes";
  idempotency: "provider-key" | "none";
  credentialScope: "write";
  fields: readonly ActionFieldSource[];
  auditFields: readonly string[];
};

type StripeActionSource = ActionSourceBase & {
  provider: "stripe";
  method: "POST" | "DELETE";
  host: "api.stripe.com";
} & (
    | {
        id: "stripe_charge_create";
        capabilityId: typeof CAPABILITY_KEYS.stripeChargeCreate;
        command: "satyr-stripe-charge";
        verb: "charge.create";
        path: "/v1/charges";
        resourceKey: "stripe:charge.create";
      }
    | {
        id: "stripe_refund_create";
        capabilityId: typeof CAPABILITY_KEYS.stripeRefundCreate;
        command: "satyr-stripe-refund";
        verb: "refund.create";
        path: "/v1/refunds";
        resourceKey: "stripe:charge:{chargeId}";
      }
    | {
        id: "stripe_subscription_cancel";
        capabilityId: typeof CAPABILITY_KEYS.stripeSubscriptionCancel;
        command: "satyr-stripe-subscription-cancel";
        verb: "subscription.cancel";
        path: "/v1/subscriptions/{subscriptionId}";
        resourceKey: "stripe:subscription:{subscriptionId}";
      }
    | {
        id: "stripe_payout_create";
        capabilityId: typeof CAPABILITY_KEYS.stripePayoutCreate;
        command: "satyr-stripe-payout";
        verb: "payout.create";
        path: "/v1/payouts";
        resourceKey: "stripe:payout:{destinationId}";
      }
    | {
        id: "stripe_transfer_create";
        capabilityId: typeof CAPABILITY_KEYS.stripeTransferCreate;
        command: "satyr-stripe-transfer";
        verb: "transfer.create";
        path: "/v1/transfers";
        resourceKey: "stripe:account:{destinationAccountId}";
      }
    | {
        id: "stripe_payment_intent_capture";
        capabilityId: typeof CAPABILITY_KEYS.stripePaymentIntentCapture;
        command: "satyr-stripe-payment-intent-capture";
        verb: "payment_intent.capture";
        path: "/v1/payment_intents/{paymentIntentId}/capture";
        resourceKey: "stripe:payment-intent:{paymentIntentId}";
      }
    | {
        id: "stripe_payment_intent_confirm";
        capabilityId: typeof CAPABILITY_KEYS.stripePaymentIntentConfirm;
        command: "satyr-stripe-payment-intent-confirm";
        verb: "payment_intent.confirm";
        path: "/v1/payment_intents/{paymentIntentId}/confirm";
        resourceKey: "stripe:payment-intent:{paymentIntentId}";
      }
    | {
        id: "stripe_subscription_update";
        capabilityId: typeof CAPABILITY_KEYS.stripeSubscriptionUpdate;
        command: "satyr-stripe-subscription-update";
        verb: "subscription.update";
        path: "/v1/subscriptions/{subscriptionId}";
        resourceKey: "stripe:subscription:{subscriptionId}";
      }
  );

type ShopifyActionSource = ActionSourceBase & {
  id: "shopify_order_cancel";
  capabilityId: typeof CAPABILITY_KEYS.shopifyOrderCancel;
  command: "satyr-shopify-order-cancel";
  provider: "shopify";
  verb: "order.cancel";
  method: "POST";
  host: "*.myshopify.com";
  path: "/admin/api/2026-07/graphql.json";
  resourceKey: "shopify:order:{orderId}";
  idempotency: "none";
};

export type ActionSource = StripeActionSource | ShopifyActionSource;

export const ACTION_REGISTRY: readonly ActionSource[] = [
  {
    id: "stripe_charge_create",
    capabilityId: CAPABILITY_KEYS.stripeChargeCreate,
    command: "satyr-stripe-charge",
    provider: "stripe",
    verb: "charge.create",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/charges",
    stakes: "high_stakes",
    resourceKey: "stripe:charge.create",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: ["amountMinor", "currency", "description"],
    fields: [
      { kind: "integer", name: "amountMinor", minimum: 50, maximum: 1_000_000 },
      { kind: "literal", name: "currency", value: "usd" },
      { kind: "literal", name: "source", value: "tok_visa" },
      { kind: "nullable_string", name: "description", maximumLength: 200 },
    ],
  },
  {
    id: "stripe_refund_create",
    capabilityId: CAPABILITY_KEYS.stripeRefundCreate,
    command: "satyr-stripe-refund",
    provider: "stripe",
    verb: "refund.create",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/refunds",
    stakes: "high_stakes",
    resourceKey: "stripe:charge:{chargeId}",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: ["chargeId", "amountMinor", "currency", "reason"],
    fields: [
      {
        kind: "required_string",
        name: "chargeId",
        pattern: "^ch_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "integer", name: "amountMinor", minimum: 1, maximum: 1_000_000 },
      { kind: "literal", name: "currency", value: "usd" },
      {
        kind: "nullable_enum",
        name: "reason",
        values: ["duplicate", "fraudulent", "requested_by_customer"],
      },
    ],
  },
  {
    id: "stripe_subscription_cancel",
    capabilityId: CAPABILITY_KEYS.stripeSubscriptionCancel,
    command: "satyr-stripe-subscription-cancel",
    provider: "stripe",
    verb: "subscription.cancel",
    method: "DELETE",
    host: "api.stripe.com",
    path: "/v1/subscriptions/{subscriptionId}",
    stakes: "high_stakes",
    resourceKey: "stripe:subscription:{subscriptionId}",
    idempotency: "none",
    credentialScope: "write",
    auditFields: ["subscriptionId", "invoiceNow", "prorate"],
    fields: [
      {
        kind: "required_string",
        name: "subscriptionId",
        pattern: "^sub_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "boolean", name: "invoiceNow" },
      { kind: "boolean", name: "prorate" },
    ],
  },
  {
    id: "stripe_payout_create",
    capabilityId: CAPABILITY_KEYS.stripePayoutCreate,
    command: "satyr-stripe-payout",
    provider: "stripe",
    verb: "payout.create",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/payouts",
    stakes: "high_stakes",
    resourceKey: "stripe:payout:{destinationId}",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: [
      "destinationId",
      "amountMinor",
      "currency",
      "payoutMethod",
      "description",
    ],
    fields: [
      {
        kind: "required_string",
        name: "destinationId",
        pattern: "^(ba|card)_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "integer", name: "amountMinor", minimum: 1, maximum: 1_000_000 },
      { kind: "literal", name: "currency", value: "usd" },
      { kind: "literal", name: "payoutMethod", value: "standard" },
      { kind: "nullable_string", name: "description", maximumLength: 200 },
    ],
  },
  {
    id: "stripe_transfer_create",
    capabilityId: CAPABILITY_KEYS.stripeTransferCreate,
    command: "satyr-stripe-transfer",
    provider: "stripe",
    verb: "transfer.create",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/transfers",
    stakes: "high_stakes",
    resourceKey: "stripe:account:{destinationAccountId}",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: [
      "destinationAccountId",
      "amountMinor",
      "currency",
      "description",
    ],
    fields: [
      {
        kind: "required_string",
        name: "destinationAccountId",
        pattern: "^acct_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "integer", name: "amountMinor", minimum: 1, maximum: 1_000_000 },
      { kind: "literal", name: "currency", value: "usd" },
      { kind: "nullable_string", name: "description", maximumLength: 200 },
    ],
  },
  {
    id: "stripe_payment_intent_capture",
    capabilityId: CAPABILITY_KEYS.stripePaymentIntentCapture,
    command: "satyr-stripe-payment-intent-capture",
    provider: "stripe",
    verb: "payment_intent.capture",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/payment_intents/{paymentIntentId}/capture",
    stakes: "high_stakes",
    resourceKey: "stripe:payment-intent:{paymentIntentId}",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: ["paymentIntentId", "amountMinor", "currency"],
    fields: [
      {
        kind: "required_string",
        name: "paymentIntentId",
        pattern: "^pi_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "integer", name: "amountMinor", minimum: 1, maximum: 1_000_000 },
      { kind: "literal", name: "currency", value: "usd" },
    ],
  },
  {
    id: "stripe_payment_intent_confirm",
    capabilityId: CAPABILITY_KEYS.stripePaymentIntentConfirm,
    command: "satyr-stripe-payment-intent-confirm",
    provider: "stripe",
    verb: "payment_intent.confirm",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/payment_intents/{paymentIntentId}/confirm",
    stakes: "high_stakes",
    resourceKey: "stripe:payment-intent:{paymentIntentId}",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: [
      "paymentIntentId",
      "paymentMethodId",
      "amountMinor",
      "currency",
    ],
    fields: [
      {
        kind: "required_string",
        name: "paymentIntentId",
        pattern: "^pi_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      {
        kind: "required_string",
        name: "paymentMethodId",
        pattern: "^pm_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "integer", name: "amountMinor", minimum: 1, maximum: 1_000_000 },
      { kind: "literal", name: "currency", value: "usd" },
    ],
  },
  {
    id: "stripe_subscription_update",
    capabilityId: CAPABILITY_KEYS.stripeSubscriptionUpdate,
    command: "satyr-stripe-subscription-update",
    provider: "stripe",
    verb: "subscription.update",
    method: "POST",
    host: "api.stripe.com",
    path: "/v1/subscriptions/{subscriptionId}",
    stakes: "high_stakes",
    resourceKey: "stripe:subscription:{subscriptionId}",
    idempotency: "provider-key",
    credentialScope: "write",
    auditFields: ["subscriptionId", "cancelAtPeriodEnd"],
    fields: [
      {
        kind: "required_string",
        name: "subscriptionId",
        pattern: "^sub_[A-Za-z0-9]+$",
        maximumLength: 255,
      },
      { kind: "boolean", name: "cancelAtPeriodEnd" },
    ],
  },
  {
    id: "shopify_order_cancel",
    capabilityId: CAPABILITY_KEYS.shopifyOrderCancel,
    command: "satyr-shopify-order-cancel",
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
