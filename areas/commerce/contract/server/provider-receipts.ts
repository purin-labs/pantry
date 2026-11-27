import type {
  CommerceProviderReceipt,
  CommerceProviderResource,
  CommerceShopifyProviderReceipt,
} from "@purin-labs/control-api";
import type { Result } from "@purin-labs/kernel/result";
import {
  hasExactKeys,
  isRecord,
  isSha256Hex,
  positiveIntegerOrNull,
} from "@purin-labs/std";

// The receipt that a commerce provider returns for one governed action. The
// action ledger keeps it as the provider result, and a relocation admin
// reads it back.

export type CommerceProviderReceiptError = {
  readonly code: "commerce_provider_receipt_invalid";
};

export function parseCommerceProviderReceipt(
  raw: unknown,
): Result<CommerceProviderReceipt, CommerceProviderReceiptError> {
  if (
    !isRecord(raw) ||
    raw.kind !== "commerce_provider_receipt" ||
    typeof raw.provider !== "string" ||
    typeof raw.receiptId !== "string" ||
    typeof raw.effectId !== "string" ||
    typeof raw.actionNonce !== "string" ||
    (raw.eventId !== null && typeof raw.eventId !== "string") ||
    typeof raw.resourceId !== "string" ||
    (raw.projectionKind !== "offer" &&
      raw.projectionKind !== "commerce_order" &&
      raw.projectionKind !== "fulfillment" &&
      raw.projectionKind !== "product" &&
      raw.projectionKind !== "merchant_plugin" &&
      raw.projectionKind !== "cafe_menu" &&
      raw.projectionKind !== "order_refund" &&
      raw.projectionKind !== "stock_operation") ||
    typeof raw.revision !== "number" ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    typeof raw.observedAt !== "string" ||
    !isSha256Hex(raw.flowBindingDigest) ||
    !isSha256Hex(raw.decisionDigest)
  ) {
    return { ok: false, error: { code: "commerce_provider_receipt_invalid" } };
  }
  if (
    raw.provider === "lab" &&
    raw.eventId !== null &&
    raw.status === "settled" &&
    raw.projectionKind !== "product" &&
    raw.projectionKind !== "merchant_plugin" &&
    raw.projectionKind !== "cafe_menu" &&
    raw.projectionKind !== "order_refund" &&
    raw.projectionKind !== "stock_operation"
  ) {
    return {
      ok: true,
      value: {
        kind: "commerce_provider_receipt",
        provider: "lab",
        receiptId: raw.receiptId,
        effectId: raw.effectId,
        actionNonce: raw.actionNonce,
        flowBindingDigest: raw.flowBindingDigest,
        decisionDigest: raw.decisionDigest,
        eventId: raw.eventId,
        resourceId: raw.resourceId,
        projectionKind: raw.projectionKind,
        revision: raw.revision,
        status: "settled",
        observedAt: raw.observedAt,
      },
    };
  }
  if (
    raw.provider === "shopify" &&
    raw.eventId === null &&
    raw.projectionKind === "commerce_order" &&
    (raw.status === "accepted" ||
      raw.status === "failed" ||
      raw.status === "indeterminate") &&
    (typeof raw.jobId === "string" || raw.jobId === null) &&
    (typeof raw.jobDone === "boolean" || raw.jobDone === null) &&
    Array.isArray(raw.errors) &&
    raw.errors.every(isCommerceProviderError)
  ) {
    return {
      ok: true,
      value: {
        kind: "commerce_provider_receipt",
        provider: "shopify",
        receiptId: raw.receiptId,
        effectId: raw.effectId,
        actionNonce: raw.actionNonce,
        flowBindingDigest: raw.flowBindingDigest,
        decisionDigest: raw.decisionDigest,
        eventId: null,
        resourceId: raw.resourceId,
        projectionKind: "commerce_order",
        revision: raw.revision,
        status: raw.status,
        jobId: raw.jobId,
        jobDone: raw.jobDone,
        errors: raw.errors,
        observedAt: raw.observedAt,
      },
    };
  }
  if (
    raw.provider === "commerce" &&
    raw.eventId !== null &&
    raw.status === "accepted" &&
    typeof raw.merchantId === "string" &&
    typeof raw.merchantRevision === "number" &&
    Number.isSafeInteger(raw.merchantRevision) &&
    raw.merchantRevision > 0
  ) {
    if (
      (raw.projectionKind === "offer" ||
        raw.projectionKind === "fulfillment" ||
        raw.projectionKind === "product" ||
        raw.projectionKind === "merchant_plugin" ||
        raw.projectionKind === "cafe_menu" ||
        raw.projectionKind === "order_refund" ||
        raw.projectionKind === "stock_operation") &&
      !Object.prototype.hasOwnProperty.call(raw, "providerResource")
    ) {
      return {
        ok: true,
        value: {
          kind: "commerce_provider_receipt",
          provider: "commerce",
          receiptId: raw.receiptId,
          effectId: raw.effectId,
          actionNonce: raw.actionNonce,
          flowBindingDigest: raw.flowBindingDigest,
          decisionDigest: raw.decisionDigest,
          eventId: raw.eventId,
          resourceId: raw.resourceId,
          projectionKind: raw.projectionKind,
          revision: raw.revision,
          status: "accepted",
          merchantId: raw.merchantId,
          merchantRevision: raw.merchantRevision,
          observedAt: raw.observedAt,
        },
      };
    }
    if (
      raw.projectionKind !== "commerce_order" ||
      !isCommerceProviderResource(raw.providerResource)
    ) {
      return {
        ok: false,
        error: { code: "commerce_provider_receipt_invalid" },
      };
    }
    return {
      ok: true,
      value: {
        kind: "commerce_provider_receipt",
        provider: "commerce",
        receiptId: raw.receiptId,
        effectId: raw.effectId,
        actionNonce: raw.actionNonce,
        flowBindingDigest: raw.flowBindingDigest,
        decisionDigest: raw.decisionDigest,
        eventId: raw.eventId,
        resourceId: raw.resourceId,
        projectionKind: "commerce_order",
        revision: raw.revision,
        status: "accepted",
        merchantId: raw.merchantId,
        merchantRevision: raw.merchantRevision,
        providerResource: raw.providerResource,
        observedAt: raw.observedAt,
      },
    };
  }
  return { ok: false, error: { code: "commerce_provider_receipt_invalid" } };
}

function isCommerceProviderError(
  value: unknown,
): value is CommerceShopifyProviderReceipt["errors"][number] {
  if (!isRecord(value)) return false;
  return (
    (value.field === null || typeof value.field === "string") &&
    (value.code === null || typeof value.code === "string") &&
    typeof value.message === "string"
  );
}

function isCommerceProviderResource(
  value: unknown,
): value is CommerceProviderResource {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "id", "revision"]) &&
    value.kind === "refund_attempt" &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.id.length <= 256 &&
    positiveIntegerOrNull(value.revision) !== null
  );
}
