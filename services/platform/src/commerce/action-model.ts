import type {
  CanonicalCommerceDelivery,
  CommerceProjection,
  CommerceOrder,
  Fulfillment,
  Offer,
} from "@seams/contracts";
import { DESCRIPTION_LIMIT } from "@seams/product-description-crdt/limits";

import { COMMERCE_LAB_INTEGRATION_ACCOUNT_ID } from "../commerce-lab/lab-metadata";
import type { IntegrationAccountId, OrganisationId } from "../ids";
import type {
  CanonicalActionDraft,
  LedgerCanonicalAction,
} from "../actors/action-ledger";
import type { Result } from "../result";
import {
  MERCHANT_PLUGIN_INSTALL_VERB,
  merchantPluginActionPath,
  parseInstallMerchantPluginRequest,
  parseMerchantPluginActionPath,
  type InstallMerchantPluginAction,
} from "./merchant-plugin-action";
import {
  ORDER_REFUND_VERB,
  orderRefundActionPath,
  parseOrderRefundAction,
  parseOrderRefundActionPath,
  type OrderRefundAction,
} from "./order-refund-action";
import {
  parseStockOperationAction,
  parseStockOperationActionPath,
  stockOperationActionPath,
  stockOperationExpectedRevision,
  stockOperationResourceId,
  stockOperationVerb,
  type StockOperationAction,
} from "./stock-action";
import {
  CAFE_MENU_PUBLISH_VERB,
  cafeMenuActionPath,
  parseCafeMenuActionPath,
  parsePublishCafeMenuRequest,
  type PublishCafeMenuAction,
} from "./cafe-menu-action";
import {
  MENU_PRICE_CHANGE_VERB,
  menuPriceActionPath,
  parseChangeMenuPriceRequest,
  parseMenuPriceActionPath,
  type ChangeMenuPriceAction,
} from "./menu-price-action";
import { isSha256Digest } from "../policy";
import { hashOpaqueSecret } from "../data/control-plane";
import type { UnversionedControlMutationBoundary } from "../data/control-mutation";
import {
  reconcileActionExecution,
  type ActionLedgerEntry,
  type ActionLedgerError,
} from "../actors/action-ledger";
import type { Variant } from "@seams/type-utils";
import {
  hasExactKeys,
  isPositiveInteger,
  isRecord,
  positiveIntegerOrNull,
  sha256Hex,
} from "@seams/std";
import type {
  CommerceLabProviderReceipt,
  CommerceProviderReceipt,
  CommerceShopifyProviderReceipt,
  CommerceProviderResource,
} from "@seams/control-api";

export function isCommerceActionNonce(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

export async function commerceActionMutationDigest(
  boundary: UnversionedControlMutationBoundary,
): Promise<string> {
  return (
    await hashOpaqueSecret(
      `${boundary.idempotencyKey}\u0000${boundary.requestHash}`,
    )
  ).slice(0, 32);
}

export type CommerceActionRequest =
  | InstallMerchantPluginAction
  | PublishCafeMenuAction
  | ChangeMenuPriceAction
  | OrderRefundAction
  | StockOperationAction
  | {
      readonly kind: "publish_catalog_listing";
      readonly productId: string;
      readonly productRevision: number;
      readonly variantId: string;
      readonly variantRevision: number;
      readonly offerId: string;
      readonly offerRevision: number;
      readonly salesChannelId: string;
      readonly salesChannelRevision: number;
    }
  | {
      readonly kind: "update_product_description";
      readonly productId: string;
      readonly productRevision: number;
      readonly description: string;
    }
  | {
      readonly kind: "cancel_order";
      readonly resourceId: string;
      readonly expectedRevision: number;
      readonly reason:
        "customer_requested" | "fraud_suspected" | "inventory_unavailable";
      readonly refund: "none" | "full";
      readonly restock: boolean;
      readonly notifyCustomer: boolean;
      readonly note: string | null;
    }
  | {
      readonly kind: "attach_tracking";
      readonly batchId: string;
      readonly merchantRevision: number;
      readonly orderId: string;
      readonly fulfillmentId: string;
      readonly fulfillmentRevision: number;
      readonly shipmentId: string;
      readonly shipmentRevision: number;
      readonly trackingNumber: string;
    }
  | {
      /**
       * One immediate price change on a listed Offer.
       *
       * Both revisions are bound: the Offer the proposal was built against and
       * the price policy the approval was given under. A change to either
       * needs a new proposal, because the allowance the operator approved may
       * no longer be the one that applies.
       */
      readonly kind: "adjust_offer_price";
      readonly offerId: string;
      readonly expectedOfferRevision: number;
      readonly expectedPolicyRevision: number;
      readonly proposedPriceMinor: number;
      readonly currency: string;
    }
  | {
      /**
       * Submitting one approved supplier payout to its provider.
       *
       * The payout revision is bound because the approval is single-use: a
       * payout that has moved on since the proposal was built is not the one
       * anybody approved, and the economics digest it carries is the proof of
       * which one they did.
       */
      readonly kind: "submit_supplier_payout";
      readonly payoutId: string;
      readonly expectedPayoutRevision: number;
      readonly approvalDigest: string;
    }
  | {
      /** Funding the exact Wise transfer recovered after interrupted creation. */
      readonly kind: "resume_supplier_payout_funding";
      readonly payoutId: string;
      readonly expectedPayoutRevision: number;
      readonly approvalDigest: string;
      readonly attemptId: string;
      readonly providerTransferId: string;
    };

type CommerceCancellationRequest = Variant<
  CommerceActionRequest,
  "cancel_order"
>;

export type CommerceCancellationAuthority = Readonly<{
  readonly kind: "underclerk_full_refund";
  readonly merchantRevision: number;
  readonly paymentId: string;
  readonly paymentRevision: number;
  readonly fulfillmentId: string;
  readonly fulfillmentRevision: number;
  readonly checkoutProfileId: string;
  readonly checkoutProfileRevision: number;
  readonly refundPolicyId: string;
  readonly refundAmountMinor: number;
  readonly refundCurrency: string;
  readonly refundGovernance: "automatic_eligible" | "approval_required";
}>;

type CommerceCancellationPathFields = Readonly<{
  readonly kind: "cancel_order";
  readonly resourceId: string;
  readonly expectedRevision: number;
  readonly reason: CommerceCancellationRequest["reason"];
  readonly refund: CommerceCancellationRequest["refund"];
  readonly restock: boolean;
  readonly notifyCustomer: boolean;
  readonly note: string | null;
}>;

export type CommerceActionError =
  | { readonly code: "commerce_action_invalid"; readonly field: string }
  | { readonly code: "commerce_action_projection_missing" }
  | { readonly code: "commerce_action_projection_kind_mismatch" }
  | {
      readonly code: "commerce_action_revision_stale";
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly code: "commerce_action_provider_unsupported" }
  | {
      readonly code: "commerce_action_authority_rebase_required";
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly code: "commerce_action_path_invalid" }
  | { readonly code: "commerce_action_event_invalid"; readonly field: string };

export type CommerceActionPath =
  | InstallMerchantPluginAction
  | PublishCafeMenuAction
  | ChangeMenuPriceAction
  | OrderRefundAction
  | StockOperationAction
  | {
      readonly kind: "publish_catalog_listing";
      readonly productId: string;
      readonly productRevision: number;
      readonly variantId: string;
      readonly variantRevision: number;
      readonly offerId: string;
      readonly offerRevision: number;
      readonly salesChannelId: string;
      readonly salesChannelRevision: number;
    }
  | {
      readonly kind: "update_product_description";
      readonly productId: string;
      readonly productRevision: number;
      readonly description: string;
    }
  | {
      readonly kind: "cancel_order";
      readonly resourceId: string;
      readonly expectedRevision: number;
      readonly reason: CommerceCancellationRequest["reason"];
      readonly refund: CommerceCancellationRequest["refund"];
      readonly restock: boolean;
      readonly notifyCustomer: boolean;
      readonly note: string | null;
      readonly execution: Readonly<{ readonly kind: "provider_managed" }>;
    }
  | (CommerceCancellationPathFields & {
      readonly execution: CommerceCancellationAuthority;
    })
  | {
      readonly kind: "attach_tracking";
      readonly batchId: string;
      readonly merchantRevision: number;
      readonly orderId: string;
      readonly fulfillmentId: string;
      readonly fulfillmentRevision: number;
      readonly shipmentId: string;
      readonly shipmentRevision: number;
      readonly trackingNumber: string;
    }
  | {
      /**
       * One immediate price change on a listed Offer.
       *
       * Both revisions are bound: the Offer the proposal was built against and
       * the price policy the approval was given under. A change to either
       * needs a new proposal, because the allowance the operator approved may
       * no longer be the one that applies.
       */
      readonly kind: "adjust_offer_price";
      readonly offerId: string;
      readonly expectedOfferRevision: number;
      readonly expectedPolicyRevision: number;
      readonly proposedPriceMinor: number;
      readonly currency: string;
    }
  | {
      readonly kind: "submit_supplier_payout";
      readonly payoutId: string;
      readonly expectedPayoutRevision: number;
      readonly approvalDigest: string;
    }
  | {
      readonly kind: "resume_supplier_payout_funding";
      readonly payoutId: string;
      readonly expectedPayoutRevision: number;
      readonly approvalDigest: string;
      readonly attemptId: string;
      readonly providerTransferId: string;
    };

export type CommerceEntityPlaneActionPath = {
  readonly kind: "patch_commerce_list_entry";
  readonly entryId: string;
  readonly listId: string;
  readonly expectedRevision: number;
  readonly expectedListRevision: number;
};

export type CommerceProviderReceiptError = {
  readonly code: "commerce_provider_receipt_invalid";
};

export type CommerceProviderReceiptReconciliationError =
  | CommerceProviderReceiptError
  | ActionLedgerError
  | { readonly code: "commerce_provider_receipt_action_mismatch" };

export function reconcileCommerceProviderReceipt(
  sql: SqlStorage,
  input: {
    readonly organisationId: OrganisationId;
    readonly nonce: string;
    readonly receipt: CommerceProviderReceipt;
    readonly now: number;
  },
): Result<ActionLedgerEntry, CommerceProviderReceiptReconciliationError> {
  if (input.receipt.actionNonce !== input.nonce) {
    return {
      ok: false,
      error: { code: "commerce_provider_receipt_action_mismatch" },
    };
  }
  const outcome = providerReceiptOutcome(input.receipt);
  return reconcileActionExecution(sql, {
    organisationId: input.organisationId,
    nonce: input.nonce,
    outcome,
    providerResult: JSON.stringify(input.receipt),
    now: input.now,
  });
}

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
    !isSha256Digest(raw.flowBindingDigest) ||
    !isSha256Digest(raw.decisionDigest)
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
    raw.provider === "underclerk" &&
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
          provider: "underclerk",
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
        provider: "underclerk",
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

function providerReceiptOutcome(
  receipt: CommerceProviderReceipt,
): "confirmed" | "failed" | "indeterminate" {
  if (receipt.provider === "lab" || receipt.provider === "underclerk")
    return "confirmed";
  switch (receipt.status) {
    case "accepted":
      return "confirmed";
    case "failed":
      return "failed";
    case "indeterminate":
      return "indeterminate";
  }
}

export function parseCommerceActionRequest(
  raw: unknown,
): Result<CommerceActionRequest, CommerceActionError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalid("kind");
  }
  if (raw.kind === "install_merchant_plugin") {
    return parseInstallMerchantPluginRequest(raw);
  }
  if (raw.kind === "publish_cafe_menu") {
    return parsePublishCafeMenuRequest(raw);
  }
  if (raw.kind === "change_menu_price") {
    return parseChangeMenuPriceRequest(raw);
  }
  if (raw.kind === "refund_order") {
    return parseOrderRefundAction(raw);
  }
  if (raw.kind === "stock_operation") {
    return parseStockOperationAction(raw);
  }
  if (raw.kind === "publish_catalog_listing") {
    return parsePublishRequest(raw);
  }
  if (raw.kind === "update_product_description") {
    return parseUpdateProductDescriptionRequest(raw);
  }
  if (raw.kind === "cancel_order") {
    return parseCancelRequest(raw);
  }
  if (raw.kind === "attach_tracking") {
    return parseAttachTrackingRequest(raw);
  }
  if (raw.kind === "adjust_offer_price") {
    return parseAdjustOfferPriceRequest(raw);
  }
  if (raw.kind === "submit_supplier_payout") {
    return parseSubmitSupplierPayoutRequest(raw);
  }
  if (raw.kind === "resume_supplier_payout_funding") {
    return parseResumeSupplierPayoutFundingRequest(raw);
  }
  return invalid("kind");
}

/**
 * A payout submission request.
 *
 * The digest is required to be a digest, not merely a string: it is the proof
 * of which economics were approved, and a malformed one could never match the
 * payout it claims to authorize.
 */
function parseSubmitSupplierPayoutRequest(
  raw: Record<string, unknown>,
): Result<CommerceActionRequest, CommerceActionError> {
  const payoutId = text(raw.payoutId) ? raw.payoutId : null;
  if (payoutId === null) return invalid("payoutId");
  if (!isPositiveInteger(raw.expectedPayoutRevision))
    return invalid("expectedPayoutRevision");
  if (
    typeof raw.approvalDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.approvalDigest)
  ) {
    return invalid("approvalDigest");
  }
  return {
    ok: true,
    value: {
      kind: "submit_supplier_payout",
      payoutId,
      expectedPayoutRevision: raw.expectedPayoutRevision,
      approvalDigest: raw.approvalDigest,
    },
  };
}

function parseResumeSupplierPayoutFundingRequest(
  raw: Record<string, unknown>,
): Result<CommerceActionRequest, CommerceActionError> {
  const payoutId = text(raw.payoutId) ? raw.payoutId : null;
  if (payoutId === null) return invalid("payoutId");
  if (!isPositiveInteger(raw.expectedPayoutRevision))
    return invalid("expectedPayoutRevision");
  if (
    typeof raw.approvalDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(raw.approvalDigest)
  ) {
    return invalid("approvalDigest");
  }
  if (!text(raw.attemptId)) return invalid("attemptId");
  if (!text(raw.providerTransferId)) return invalid("providerTransferId");
  return {
    ok: true,
    value: {
      kind: "resume_supplier_payout_funding",
      payoutId,
      expectedPayoutRevision: raw.expectedPayoutRevision,
      approvalDigest: raw.approvalDigest,
      attemptId: raw.attemptId,
      providerTransferId: raw.providerTransferId,
    },
  };
}

export function parseCommerceCancellationAuthority(
  raw: unknown,
): Result<CommerceCancellationAuthority, CommerceActionError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "merchantRevision",
      "paymentId",
      "paymentRevision",
      "fulfillmentId",
      "fulfillmentRevision",
      "checkoutProfileId",
      "checkoutProfileRevision",
      "refundPolicyId",
      "refundAmountMinor",
      "refundCurrency",
      "refundGovernance",
    ])
  ) {
    return invalid("authority");
  }
  if (raw.kind !== "underclerk_full_refund") return invalid("authority.kind");
  const merchantRevision = positiveIntegerOrNull(raw.merchantRevision);
  if (merchantRevision === null) return invalid("authority.merchantRevision");
  const paymentId = text(raw.paymentId) ? raw.paymentId : null;
  if (paymentId === null) return invalid("authority.paymentId");
  const paymentRevision = positiveIntegerOrNull(raw.paymentRevision);
  if (paymentRevision === null) return invalid("authority.paymentRevision");
  const fulfillmentId = text(raw.fulfillmentId) ? raw.fulfillmentId : null;
  if (fulfillmentId === null) return invalid("authority.fulfillmentId");
  const fulfillmentRevision = positiveIntegerOrNull(raw.fulfillmentRevision);
  if (fulfillmentRevision === null)
    return invalid("authority.fulfillmentRevision");
  const checkoutProfileId = text(raw.checkoutProfileId)
    ? raw.checkoutProfileId
    : null;
  if (checkoutProfileId === null) return invalid("authority.checkoutProfileId");
  const checkoutProfileRevision = positiveIntegerOrNull(
    raw.checkoutProfileRevision,
  );
  if (checkoutProfileRevision === null)
    return invalid("authority.checkoutProfileRevision");
  const refundPolicyId = text(raw.refundPolicyId) ? raw.refundPolicyId : null;
  if (refundPolicyId === null) return invalid("authority.refundPolicyId");
  const refundAmountMinor = positiveIntegerOrNull(raw.refundAmountMinor);
  if (refundAmountMinor === null) return invalid("authority.refundAmountMinor");
  if (!currencyCode(raw.refundCurrency))
    return invalid("authority.refundCurrency");
  if (
    raw.refundGovernance !== "automatic_eligible" &&
    raw.refundGovernance !== "approval_required"
  ) {
    return invalid("authority.refundGovernance");
  }
  return {
    ok: true,
    value: {
      kind: "underclerk_full_refund",
      merchantRevision,
      paymentId,
      paymentRevision,
      fulfillmentId,
      fulfillmentRevision,
      checkoutProfileId,
      checkoutProfileRevision,
      refundPolicyId,
      refundAmountMinor,
      refundCurrency: raw.refundCurrency,
      refundGovernance: raw.refundGovernance,
    },
  };
}

export async function buildCommerceCancellationActionDraft(
  input: Readonly<{
    readonly request: CommerceCancellationRequest;
    readonly authority: CommerceCancellationAuthority;
    readonly current: Variant<CommerceProjection, "commerce_order">;
  }>,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  if (input.request.refund !== "full") return invalid("refund");
  if (!input.request.restock) return invalid("restock");
  if (input.request.notifyCustomer) return invalid("notifyCustomer");
  if (input.request.note !== null) return invalid("note");

  const authority = parseCommerceCancellationAuthority(input.authority);
  if (!authority.ok) return authority;
  if (input.current.kind !== "commerce_order") {
    return {
      ok: false,
      error: { code: "commerce_action_projection_kind_mismatch" },
    };
  }

  const order = input.current.projection;
  const currentRevision = order.provenance.revision;
  if (
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 1 ||
    order.provenance.resourceId !== input.request.resourceId ||
    currentRevision !== input.request.expectedRevision
  ) {
    return {
      ok: false,
      error: {
        code: "commerce_action_revision_stale",
        expected: input.request.expectedRevision,
        actual: Number.isSafeInteger(currentRevision) ? currentRevision : 0,
      },
    };
  }

  const total = order.totals.total;
  if (!Number.isSafeInteger(total.amountMinor) || total.amountMinor <= 0) {
    return invalid("current.totals.total.amountMinor");
  }
  if (!currencyCode(total.currency))
    return invalid("current.totals.total.currency");
  if (
    total.amountMinor !== authority.value.refundAmountMinor ||
    total.currency !== authority.value.refundCurrency
  ) {
    return invalid("authority.refundAmount");
  }

  const path: CommerceActionPath = {
    kind: "cancel_order",
    resourceId: input.request.resourceId,
    expectedRevision: input.request.expectedRevision,
    reason: input.request.reason,
    refund: input.request.refund,
    restock: input.request.restock,
    notifyCustomer: input.request.notifyCustomer,
    note: input.request.note,
    execution: authority.value,
  };
  const pathValue = cancellationPath(path);
  const amountValue = canonicalAmountValue(
    authority.value.refundAmountMinor,
    authority.value.refundCurrency,
  );
  if (amountValue === null) return invalid("authority.refundCurrency");
  const argsHash = await sha256Hex(JSON.stringify(pathValue));
  return {
    ok: true,
    value: {
      host: "satyr.commerce",
      verb: "commerce.order.cancel",
      path: pathValue,
      argsHash,
      amount: amountValue,
      resourceKey: `commerce:cancel_order:${input.request.resourceId}`,
    },
  };
}

export async function buildCommerceActionDraft(input: {
  readonly organisationId: string;
  readonly integrationAccountId: IntegrationAccountId;
  readonly sessionId: string;
  readonly threadId: string;
  readonly request: CommerceActionRequest;
  readonly current: CommerceProjection;
  readonly exp: number;
  readonly now: number;
}): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  return buildActionRequestDraft(input.request);
}

export function buildMerchantPluginActionDraft(
  request: InstallMerchantPluginAction,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  return buildActionRequestDraft(request);
}

/** A refund names its money on the ledger, as a cancellation does. */
export async function buildOrderRefundActionDraft(
  request: OrderRefundAction,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  const draft = await buildActionRequestDraft(request);
  if (!draft.ok) return draft;
  const amount = canonicalAmountValue(request.amountMinor, request.currency);
  if (amount === null) return invalid("currency");
  return { ok: true, value: { ...draft.value, amount } };
}

export function buildStockOperationActionDraft(
  request: StockOperationAction,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  return buildActionRequestDraft(request);
}

export function buildCafeMenuActionDraft(
  request: PublishCafeMenuAction,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  return buildActionRequestDraft(request);
}

export function buildMenuPriceActionDraft(
  request: ChangeMenuPriceAction,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  return buildActionRequestDraft(request);
}

export function buildSupplierPayoutActionDraft(
  request: Variant<
    CommerceActionRequest,
    "submit_supplier_payout" | "resume_supplier_payout_funding"
  >,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  return buildActionRequestDraft(request);
}

async function buildActionRequestDraft(
  request: CommerceActionRequest,
): Promise<Result<CanonicalActionDraft, CommerceActionError>> {
  const path = actionPath(request);
  if (!path.ok) return path;
  const argsHash = await sha256Hex(JSON.stringify(path.value));
  const common = {
    host: "satyr.commerce",
    path: path.value,
    argsHash,
    amount: null,
    resourceKey: `commerce:${request.kind}:${actionResourceId(request)}`,
  } as const;
  return {
    ok: true,
    value: {
      ...common,
      verb: actionVerb(request),
    },
  };
}

/**
 * The commerce actions that an owner or admin may approve from a Slack card,
 * without the Google step-up. The owner chose these on 2026-10-28: each one
 * changes the catalogue, a price, tracking or a plugin. An order cancellation
 * refunds money and a supplier payout sends it, so both keep the step-up.
 */
const SLACK_APPROVABLE_ACTION_KINDS: ReadonlySet<string> = new Set([
  "publish_catalog_listing",
  "update_product_description",
  "attach_tracking",
  "adjust_offer_price",
  // Plan 40B phase 4: a café menu price or deal is a price change too.
  "change_menu_price",
  "install_merchant_plugin",
]);

/** Whether an approval from a Slack card may sign this action. */
export function slackMayApproveAction(
  action: Pick<LedgerCanonicalAction, "verb" | "path">,
): boolean {
  const path = parseCommerceActionPath(action);
  return path.ok && SLACK_APPROVABLE_ACTION_KINDS.has(path.value.kind);
}

export function parseCommerceActionPath(
  action: Pick<LedgerCanonicalAction, "verb" | "path">,
): Result<CommerceActionPath, CommerceActionError> {
  let url: URL;
  try {
    url = new URL(`https://commerce.invalid${action.path}`);
  } catch {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const plugin = parseMerchantPluginActionPath(action.verb, url);
  if (plugin !== null)
    return plugin.ok
      ? plugin
      : { ok: false, error: { code: "commerce_action_path_invalid" } };
  const orderRefund = parseOrderRefundActionPath(action.verb, url);
  if (orderRefund !== null)
    return orderRefund.ok
      ? orderRefund
      : { ok: false, error: { code: "commerce_action_path_invalid" } };
  const stockOperation = parseStockOperationActionPath(action.verb, url);
  if (stockOperation !== null)
    return stockOperation.ok
      ? stockOperation
      : { ok: false, error: { code: "commerce_action_path_invalid" } };
  const cafeMenu = parseCafeMenuActionPath(action.verb, url);
  if (cafeMenu !== null)
    return cafeMenu.ok
      ? cafeMenu
      : { ok: false, error: { code: "commerce_action_path_invalid" } };
  const menuPrice = parseMenuPriceActionPath(action.verb, url);
  if (menuPrice !== null)
    return menuPrice.ok
      ? menuPrice
      : { ok: false, error: { code: "commerce_action_path_invalid" } };
  const supplierPayout = parseSupplierPayoutActionPath(action, url);
  if (supplierPayout !== null) return supplierPayout;
  const resource = url.pathname.match(
    /^\/(catalog|orders|fulfillments|offers)\/([^/]+)\/(listing|description|cancel|attach-tracking|price)$/u,
  );
  const rawRevision = url.searchParams.get("expected_revision");
  if (
    resource === null ||
    rawRevision === null ||
    !/^\d+$/u.test(rawRevision)
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const expectedRevision = Number(rawRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  let resourceId: string;
  try {
    resourceId = decodeURIComponent(resource[2] ?? "");
  } catch {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (resourceId.length === 0)
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  if (
    action.verb === "commerce.catalog.update_description" &&
    resource[1] === "catalog" &&
    resource[3] === "description"
  ) {
    if (
      !hasExactActionSearchParams(url.searchParams, [
        "expected_revision",
        "description",
      ])
    ) {
      return { ok: false, error: { code: "commerce_action_path_invalid" } };
    }
    const description = url.searchParams.get("description");
    if (description === null || !validProductDescription(description)) {
      return { ok: false, error: { code: "commerce_action_path_invalid" } };
    }
    return {
      ok: true,
      value: {
        kind: "update_product_description",
        productId: resourceId,
        productRevision: expectedRevision,
        description,
      },
    };
  }
  if (
    action.verb === "commerce.offer.adjust_price" &&
    resource[1] === "offers" &&
    resource[3] === "price"
  ) {
    const expectedPolicyRevision = positiveIntegerParam(
      url.searchParams.get("expected_policy_revision"),
    );
    const proposedPriceMinor = positiveIntegerParam(
      url.searchParams.get("proposed_price_minor"),
    );
    const currency = url.searchParams.get("currency");
    if (
      expectedPolicyRevision === null ||
      proposedPriceMinor === null ||
      currency === null ||
      !/^[A-Z]{3}$/u.test(currency)
    ) {
      return { ok: false, error: { code: "commerce_action_path_invalid" } };
    }
    return {
      ok: true,
      value: {
        kind: "adjust_offer_price",
        offerId: resourceId,
        expectedOfferRevision: expectedRevision,
        expectedPolicyRevision,
        proposedPriceMinor,
        currency,
      },
    };
  }
  if (
    action.verb === "commerce.catalog.publish" &&
    resource[1] === "catalog" &&
    resource[3] === "listing"
  ) {
    const productId = url.searchParams.get("product_id");
    const productRevision = positiveIntegerParam(
      url.searchParams.get("product_revision"),
    );
    const variantId = url.searchParams.get("variant_id");
    const variantRevision = positiveIntegerParam(
      url.searchParams.get("variant_revision"),
    );
    const offerId = resourceId;
    const offerRevision = positiveIntegerParam(
      url.searchParams.get("offer_revision"),
    );
    const salesChannelId = url.searchParams.get("sales_channel_id");
    const salesChannelRevision = positiveIntegerParam(
      url.searchParams.get("sales_channel_revision"),
    );
    if (
      !text(productId) ||
      productRevision === null ||
      !text(variantId) ||
      variantRevision === null ||
      offerRevision === null ||
      !text(salesChannelId) ||
      salesChannelRevision === null ||
      expectedRevision !== offerRevision
    ) {
      return { ok: false, error: { code: "commerce_action_path_invalid" } };
    }
    return {
      ok: true,
      value: {
        kind: "publish_catalog_listing",
        productId,
        productRevision,
        variantId,
        variantRevision,
        offerId,
        offerRevision,
        salesChannelId,
        salesChannelRevision,
      },
    };
  }
  if (
    action.verb === "commerce.fulfillment.attach_tracking" &&
    resource[1] === "fulfillments" &&
    resource[3] === "attach-tracking"
  ) {
    const batchId = url.searchParams.get("batch_id");
    const merchantRevision = positiveIntegerParam(
      url.searchParams.get("merchant_revision"),
    );
    const orderId = url.searchParams.get("order_id");
    const shipmentId = url.searchParams.get("shipment_id");
    const shipmentRevision = positiveIntegerParam(
      url.searchParams.get("shipment_revision"),
    );
    const trackingNumber = url.searchParams.get("tracking_number");
    if (
      !trackingBatchId(batchId) ||
      merchantRevision === null ||
      !text(orderId) ||
      !text(shipmentId) ||
      shipmentRevision === null ||
      !text(trackingNumber)
    ) {
      return { ok: false, error: { code: "commerce_action_path_invalid" } };
    }
    return {
      ok: true,
      value: {
        kind: "attach_tracking",
        batchId,
        merchantRevision,
        orderId,
        fulfillmentId: resourceId,
        fulfillmentRevision: expectedRevision,
        shipmentId,
        shipmentRevision,
        trackingNumber,
      },
    };
  }
  if (
    action.verb !== "commerce.order.cancel" ||
    resource[1] !== "orders" ||
    resource[3] !== "cancel"
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (
    !hasUniqueQueryKeys(url.searchParams, [
      "expected_revision",
      "reason",
      "refund",
      "restock",
      "notify_customer",
      "note",
      "execution",
      "merchant_revision",
      "payment_id",
      "payment_revision",
      "fulfillment_id",
      "fulfillment_revision",
      "checkout_profile_id",
      "checkout_profile_revision",
      "refund_policy_id",
      "refund_amount_minor",
      "refund_currency",
      "refund_governance",
    ])
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const reason = url.searchParams.get("reason");
  const refund = url.searchParams.get("refund");
  const restock = url.searchParams.get("restock");
  const notifyCustomer = url.searchParams.get("notify_customer");
  const note = url.searchParams.get("note");
  if (
    (reason !== "customer_requested" &&
      reason !== "fraud_suspected" &&
      reason !== "inventory_unavailable") ||
    (refund !== "none" && refund !== "full") ||
    (restock !== "true" && restock !== "false") ||
    (notifyCustomer !== "true" && notifyCustomer !== "false") ||
    note === null
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const execution = url.searchParams.get("execution");
  const commerceAuthorityKeys = [
    "merchant_revision",
    "payment_id",
    "payment_revision",
    "fulfillment_id",
    "fulfillment_revision",
    "checkout_profile_id",
    "checkout_profile_revision",
    "refund_policy_id",
    "refund_amount_minor",
    "refund_currency",
    "refund_governance",
  ] as const;
  const hasCommerceAuthorityField = commerceAuthorityKeys.some((key) =>
    url.searchParams.has(key),
  );
  if (execution === null || execution === "provider_managed") {
    if (hasCommerceAuthorityField) {
      return { ok: false, error: { code: "commerce_action_path_invalid" } };
    }
    return {
      ok: true,
      value: {
        kind: "cancel_order",
        resourceId,
        expectedRevision,
        reason,
        refund,
        restock: restock === "true",
        notifyCustomer: notifyCustomer === "true",
        note: note.length === 0 ? null : note,
        execution: { kind: "provider_managed" },
      },
    };
  }
  if (
    execution !== "underclerk_full_refund" ||
    refund !== "full" ||
    restock !== "true" ||
    notifyCustomer !== "false" ||
    note.length !== 0 ||
    !commerceAuthorityKeys.every((key) => url.searchParams.has(key))
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const authority = parseCommerceCancellationAuthority({
    kind: execution,
    merchantRevision: positiveIntegerParam(
      url.searchParams.get("merchant_revision"),
    ),
    paymentId: url.searchParams.get("payment_id"),
    paymentRevision: positiveIntegerParam(
      url.searchParams.get("payment_revision"),
    ),
    fulfillmentId: url.searchParams.get("fulfillment_id"),
    fulfillmentRevision: positiveIntegerParam(
      url.searchParams.get("fulfillment_revision"),
    ),
    checkoutProfileId: url.searchParams.get("checkout_profile_id"),
    checkoutProfileRevision: positiveIntegerParam(
      url.searchParams.get("checkout_profile_revision"),
    ),
    refundPolicyId: url.searchParams.get("refund_policy_id"),
    refundAmountMinor: positiveIntegerParam(
      url.searchParams.get("refund_amount_minor"),
    ),
    refundCurrency: url.searchParams.get("refund_currency"),
    refundGovernance: url.searchParams.get("refund_governance"),
  });
  if (!authority.ok)
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  return {
    ok: true,
    value: {
      kind: "cancel_order",
      resourceId,
      expectedRevision,
      reason,
      refund,
      restock: restock === "true",
      notifyCustomer: false,
      note: null,
      execution: authority.value,
    },
  };
}

function parseSupplierPayoutActionPath(
  action: Pick<LedgerCanonicalAction, "verb" | "path">,
  url: URL,
): Result<CommerceActionPath, CommerceActionError> | null {
  const resource = url.pathname.match(
    /^\/supplier-payouts\/([^/]+)\/(submission|funding)$/u,
  );
  if (resource === null) return null;
  if (action.verb !== "commerce.supplier_payout.submit") {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const operation = resource[2];
  const allowed =
    operation === "submission"
      ? ["expected_revision", "approval_digest"]
      : [
          "expected_revision",
          "approval_digest",
          "attempt_id",
          "provider_transfer_id",
        ];
  if (!hasUniqueQueryKeys(url.searchParams, allowed)) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const expectedPayoutRevision = positiveIntegerParam(
    url.searchParams.get("expected_revision"),
  );
  const approvalDigest = url.searchParams.get("approval_digest");
  let payoutId: string;
  try {
    payoutId = decodeURIComponent(resource[1] ?? "");
  } catch {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (
    !text(payoutId) ||
    expectedPayoutRevision === null ||
    approvalDigest === null ||
    !/^[a-f0-9]{64}$/u.test(approvalDigest)
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (operation === "submission") {
    return {
      ok: true,
      value: {
        kind: "submit_supplier_payout",
        payoutId,
        expectedPayoutRevision,
        approvalDigest,
      },
    };
  }
  const attemptId = url.searchParams.get("attempt_id");
  const providerTransferId = url.searchParams.get("provider_transfer_id");
  if (!text(attemptId) || !text(providerTransferId)) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  return {
    ok: true,
    value: {
      kind: "resume_supplier_payout_funding",
      payoutId,
      expectedPayoutRevision,
      approvalDigest,
      attemptId,
      providerTransferId,
    },
  };
}

export function parseCommerceEntityPlaneActionPath(
  action: Pick<LedgerCanonicalAction, "verb" | "path">,
): Result<CommerceEntityPlaneActionPath, CommerceActionError> {
  if (action.verb !== "commerce.list_entry.patch") {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  let url: URL;
  try {
    url = new URL(`https://commerce.invalid${action.path}`);
  } catch {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const resource = url.pathname.match(/^\/list-entries\/([^/]+)\/patch$/u);
  if (
    resource === null ||
    url.hash.length !== 0 ||
    !hasExactActionSearchParams(url.searchParams, [
      "list_id",
      "expected_revision",
      "expected_list_revision",
    ])
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  const entryId = decodeActionPathText(resource[1]);
  const listId = decodeActionPathText(url.searchParams.get("list_id"));
  const expectedRevision = positiveIntegerParam(
    url.searchParams.get("expected_revision"),
  );
  const expectedListRevision = positiveIntegerParam(
    url.searchParams.get("expected_list_revision"),
  );
  if (
    entryId === null ||
    listId === null ||
    expectedRevision === null ||
    expectedListRevision === null
  ) {
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  return {
    ok: true,
    value: {
      kind: "patch_commerce_list_entry",
      entryId,
      listId,
      expectedRevision,
      expectedListRevision,
    },
  };
}

function hasExactActionSearchParams(
  params: URLSearchParams,
  expected: readonly string[],
): boolean {
  const actual = Array.from(params.keys());
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key)) &&
    expected.every((key) => params.getAll(key).length === 1)
  );
}

function decodeActionPathText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const decoded = decodeURIComponent(value);
    return text(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export async function buildCommerceLabDelivery(input: {
  readonly action: LedgerCanonicalAction;
  readonly current: CommerceProjection | null;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly delivery: CanonicalCommerceDelivery;
      readonly receipt: Omit<
        CommerceLabProviderReceipt,
        "flowBindingDigest" | "decisionDigest"
      >;
    },
    CommerceActionError
  >
> {
  if (
    input.action.integrationAccountId !== COMMERCE_LAB_INTEGRATION_ACCOUNT_ID
  ) {
    return {
      ok: false,
      error: { code: "commerce_action_provider_unsupported" },
    };
  }
  const path = parseCommerceActionPath(input.action);
  if (!path.ok) return path;
  if (input.current === null) {
    return { ok: false, error: { code: "commerce_action_projection_missing" } };
  }
  const currentRevision = projectionRevision(input.current);
  const expectedRevision = commerceActionExpectedRevision(path.value);
  if (currentRevision !== expectedRevision) {
    return {
      ok: false,
      error: {
        code: "commerce_action_revision_stale",
        expected: expectedRevision,
        actual: currentRevision,
      },
    };
  }
  const observedAt = new Date(input.now).toISOString();
  const nextRevision = currentRevision + 1;
  const eventId = `commerce_action_${input.action.nonce.value}`;
  const projection = nextProjection(
    path.value,
    input.current,
    nextRevision,
    observedAt,
  );
  if (!projection.ok) return projection;
  const observationId = `${eventId}:${projection.value.kind}:${actionResourceId(path.value)}:${nextRevision}`;
  const delivery = {
    schemaVersion: 1,
    providerDeliveryId: eventId,
    observations: [
      { kind: "upsert", observationId, projection: projection.value },
    ],
  } satisfies CanonicalCommerceDelivery;
  const receipt: Omit<
    CommerceLabProviderReceipt,
    "flowBindingDigest" | "decisionDigest"
  > = {
    kind: "commerce_provider_receipt",
    provider: "lab",
    receiptId: `receipt_${input.action.nonce.value}`,
    effectId: `effect_${input.action.nonce.value}`,
    actionNonce: input.action.nonce.value,
    eventId,
    resourceId: actionResourceId(path.value),
    projectionKind: projectionKindFor(projection.value.kind),
    revision: nextRevision,
    status: "settled",
    observedAt,
  };
  return { ok: true, value: { delivery, receipt } };
}

function nextProjection(
  path: CommerceActionPath,
  current: CommerceProjection,
  nextRevision: number,
  observedAt: string,
): Result<
  Variant<CommerceProjection, "offer" | "commerce_order" | "fulfillment">,
  CommerceActionError
> {
  if (path.kind === "publish_catalog_listing") {
    if (current.kind !== "offer") {
      return {
        ok: false,
        error: { code: "commerce_action_projection_kind_mismatch" },
      };
    }
    const offer: Offer = current.projection;
    return {
      ok: true,
      value: {
        kind: "offer",
        projection: {
          ...offer,
          lifecycle: { state: "listed", listedAt: observedAt },
          provenance: nextProvenance(
            offer.provenance,
            nextRevision,
            observedAt,
          ),
        },
      },
    };
  }
  if (path.kind === "attach_tracking") {
    if (
      current.kind !== "fulfillment" ||
      current.projection.orderId !== path.orderId
    ) {
      return {
        ok: false,
        error: { code: "commerce_action_projection_kind_mismatch" },
      };
    }
    const fulfillment: Fulfillment = current.projection;
    if (
      fulfillment.kind !== "shipping" ||
      fulfillment.lifecycle.state !== "requested"
    ) {
      return {
        ok: false,
        error: { code: "commerce_action_projection_kind_mismatch" },
      };
    }
    return {
      ok: true,
      value: {
        kind: "fulfillment",
        projection: {
          ...fulfillment,
          provenance: nextProvenance(
            fulfillment.provenance,
            nextRevision,
            observedAt,
          ),
          lifecycle: {
            state: "handed_to_carrier",
            handedOverAt: observedAt,
            shipmentId: path.shipmentId,
          },
        },
      },
    };
  }
  if (
    path.kind === "install_merchant_plugin" ||
    path.kind === "publish_cafe_menu" ||
    path.kind === "change_menu_price" ||
    path.kind === "refund_order" ||
    path.kind === "stock_operation"
  ) {
    // A plugin or a menu is merchant configuration in Commerce, not a
    // projection.
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (path.kind === "adjust_offer_price") {
    // Price changes commit in Commerce against its own Offer state; there is
    // no lab projection to advance for them.
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (path.kind === "update_product_description") {
    // Product descriptions are applied through Commerce; the lab provider
    // has no authoritative product mutation endpoint.
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (
    path.kind === "submit_supplier_payout" ||
    path.kind === "resume_supplier_payout_funding"
  ) {
    // A payout commits against its own store and the provider, and touches no
    // commerce projection at all: money leaving the merchant is not a change to
    // an Order.
    return { ok: false, error: { code: "commerce_action_path_invalid" } };
  }
  if (current.kind !== "commerce_order") {
    return {
      ok: false,
      error: { code: "commerce_action_projection_kind_mismatch" },
    };
  }
  const order: CommerceOrder = current.projection;
  return {
    ok: true,
    value: {
      kind: "commerce_order",
      projection: {
        ...order,
        provenance: nextProvenance(order.provenance, nextRevision, observedAt),
        lifecycle: {
          state: "cancelled",
          cancelledAt: observedAt,
          reason: path.reason,
        },
      },
    },
  };
}

function projectionKindFor(
  kind: Variant<
    CommerceProjection,
    "offer" | "commerce_order" | "fulfillment"
  >["kind"],
): CommerceLabProviderReceipt["projectionKind"] {
  switch (kind) {
    case "offer":
      return "offer";
    case "commerce_order":
      return "commerce_order";
    case "fulfillment":
      return "fulfillment";
  }
}

function nextProvenance(
  provenance: Offer["provenance"],
  revision: number,
  observedAt: string,
): Offer["provenance"] {
  return {
    ...provenance,
    revision,
    occurredAt: observedAt,
    observedAt,
  };
}

function projectionRevision(projection: CommerceProjection): number {
  switch (projection.kind) {
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "location":
    case "sales_channel":
    case "offer":
      return projection.projection.provenance.revision;
    case "commerce_order":
      return projection.projection.provenance.revision;
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "payment":
    case "fulfillment":
    case "shipment":
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return projection.projection.provenance.revision;
  }
}

export function commerceProjectionRevision(
  projection: CommerceProjection,
): number {
  return projectionRevision(projection);
}

function parseAdjustOfferPriceRequest(
  raw: Readonly<Record<string, unknown>>,
): Result<CommerceActionRequest, CommerceActionError> {
  // Read the fields this action needs and ignore the rest, the way the other
  // three request parsers do. The proposal tool schema is one flat object
  // covering every action kind, so a model that obeys it sends the fields of
  // the other kinds explicitly as null; rejecting on key count would refuse
  // exactly what the schema tells the model to send.
  if (!text(raw.offerId)) return invalid("offerId");
  if (!isPositiveInteger(raw.expectedOfferRevision))
    return invalid("expectedOfferRevision");
  if (!isPositiveInteger(raw.expectedPolicyRevision))
    return invalid("expectedPolicyRevision");
  // A zero or negative price is not a discount; the action does not express it.
  if (!isPositiveInteger(raw.proposedPriceMinor))
    return invalid("proposedPriceMinor");
  if (typeof raw.currency !== "string" || !/^[A-Z]{3}$/u.test(raw.currency)) {
    return invalid("currency");
  }
  // Any other field must be absent or null, never a value: a request that
  // names both an Offer price and a listing is not a price change with extra
  // noise, it is an ambiguous request. Checking the complement of our own
  // fields means a kind added later cannot slip a value past this.
  const own = new Set([
    "kind",
    "offerId",
    "expectedOfferRevision",
    "expectedPolicyRevision",
    "proposedPriceMinor",
    "currency",
  ]);
  for (const [key, value] of Object.entries(raw)) {
    if (!own.has(key) && value !== null && value !== undefined)
      return invalid(key);
  }
  return {
    ok: true,
    value: {
      kind: "adjust_offer_price",
      offerId: raw.offerId,
      expectedOfferRevision: raw.expectedOfferRevision,
      expectedPolicyRevision: raw.expectedPolicyRevision,
      proposedPriceMinor: raw.proposedPriceMinor,
      currency: raw.currency,
    },
  };
}

export function commerceActionExpectedRevision(
  path: CommerceActionPath | CommerceActionRequest,
): number {
  switch (path.kind) {
    case "install_merchant_plugin":
      return path.expectedRevision ?? 0;
    case "publish_cafe_menu":
      return path.expectedMenuRevision ?? 0;
    case "change_menu_price":
      return path.expectedOfferRevision;
    case "refund_order":
      return path.expectedOrderRevision;
    case "stock_operation":
      return stockOperationExpectedRevision(path.operation);
    case "publish_catalog_listing":
      return path.offerRevision;
    case "update_product_description":
      return path.productRevision;
    case "cancel_order":
      return path.expectedRevision;
    case "attach_tracking":
      return path.fulfillmentRevision;
    case "adjust_offer_price":
      return path.expectedOfferRevision;
    case "submit_supplier_payout":
      return path.expectedPayoutRevision;
    case "resume_supplier_payout_funding":
      return path.expectedPayoutRevision;
  }
}

export function commerceTrackingAttachmentTargetMatches(
  input: Readonly<{
    fulfillment: Variant<CommerceProjection, "fulfillment">;
    shipment: Variant<CommerceProjection, "shipment">;
    request: Variant<CommerceActionRequest, "attach_tracking">;
  }>,
): boolean {
  const fulfillment = input.fulfillment.projection;
  const shipment = input.shipment.projection;
  return (
    fulfillment.provenance.revision === input.request.fulfillmentRevision &&
    fulfillment.kind === "shipping" &&
    fulfillment.orderId === input.request.orderId &&
    fulfillment.lifecycle.state === "requested" &&
    shipment.provenance.revision === input.request.shipmentRevision &&
    shipment.provenance.source === fulfillment.provenance.source &&
    shipment.provenance.integrationAccountId ===
      fulfillment.provenance.integrationAccountId &&
    shipment.kind === "first_party" &&
    shipment.orderId === input.request.orderId &&
    shipment.fulfillmentId === input.request.fulfillmentId &&
    shipment.lifecycle.state === "label_purchased" &&
    shipment.lifecycle.trackingNumber === input.request.trackingNumber
  );
}

function actionPath(
  request: CommerceActionRequest,
): Result<string, CommerceActionError> {
  if (request.kind === "install_merchant_plugin")
    return { ok: true, value: merchantPluginActionPath(request) };
  if (request.kind === "publish_cafe_menu")
    return { ok: true, value: cafeMenuActionPath(request) };
  if (request.kind === "change_menu_price")
    return { ok: true, value: menuPriceActionPath(request) };
  if (request.kind === "refund_order")
    return { ok: true, value: orderRefundActionPath(request) };
  if (request.kind === "stock_operation")
    return { ok: true, value: stockOperationActionPath(request) };
  if (request.kind === "publish_catalog_listing") {
    const params = new URLSearchParams({
      expected_revision: String(request.offerRevision),
      product_id: request.productId,
      product_revision: String(request.productRevision),
      variant_id: request.variantId,
      variant_revision: String(request.variantRevision),
      offer_revision: String(request.offerRevision),
      sales_channel_id: request.salesChannelId,
      sales_channel_revision: String(request.salesChannelRevision),
    });
    return {
      ok: true,
      value: `/catalog/${encodeURIComponent(request.offerId)}/listing?${params.toString()}`,
    };
  }
  if (request.kind === "update_product_description") {
    const params = new URLSearchParams({
      expected_revision: String(request.productRevision),
      description: request.description,
    });
    return {
      ok: true,
      value: `/catalog/${encodeURIComponent(request.productId)}/description?${params.toString()}`,
    };
  }
  if (request.kind === "attach_tracking") {
    const params = new URLSearchParams({
      expected_revision: String(request.fulfillmentRevision),
      batch_id: request.batchId,
      merchant_revision: String(request.merchantRevision),
      order_id: request.orderId,
      shipment_id: request.shipmentId,
      shipment_revision: String(request.shipmentRevision),
      tracking_number: request.trackingNumber,
    });
    return {
      ok: true,
      value: `/fulfillments/${encodeURIComponent(request.fulfillmentId)}/attach-tracking?${params.toString()}`,
    };
  }
  if (request.kind === "adjust_offer_price") {
    const params = new URLSearchParams({
      expected_revision: String(request.expectedOfferRevision),
      expected_policy_revision: String(request.expectedPolicyRevision),
      proposed_price_minor: String(request.proposedPriceMinor),
      currency: request.currency,
    });
    return {
      ok: true,
      value: `/offers/${encodeURIComponent(request.offerId)}/price?${params.toString()}`,
    };
  }
  if (request.kind === "submit_supplier_payout") {
    const params = new URLSearchParams({
      expected_revision: String(request.expectedPayoutRevision),
      approval_digest: request.approvalDigest,
    });
    return {
      ok: true,
      value: `/supplier-payouts/${encodeURIComponent(request.payoutId)}/submission?${params.toString()}`,
    };
  }
  if (request.kind === "resume_supplier_payout_funding") {
    const params = new URLSearchParams({
      expected_revision: String(request.expectedPayoutRevision),
      approval_digest: request.approvalDigest,
      attempt_id: request.attemptId,
      provider_transfer_id: request.providerTransferId,
    });
    return {
      ok: true,
      value: `/supplier-payouts/${encodeURIComponent(request.payoutId)}/funding?${params.toString()}`,
    };
  }
  return {
    ok: true,
    value: cancellationPath({
      kind: "cancel_order",
      resourceId: request.resourceId,
      expectedRevision: request.expectedRevision,
      reason: request.reason,
      refund: request.refund,
      restock: request.restock,
      notifyCustomer: request.notifyCustomer,
      note: request.note,
      execution: { kind: "provider_managed" },
    }),
  };
}

function cancellationPath(
  path: Variant<CommerceActionPath, "cancel_order">,
): string {
  const params = new URLSearchParams({
    expected_revision: String(path.expectedRevision),
    reason: path.reason,
    refund: path.refund,
    restock: String(path.restock),
    notify_customer: String(path.notifyCustomer),
    note: path.note ?? "",
  });
  switch (path.execution.kind) {
    case "provider_managed":
      break;
    case "underclerk_full_refund":
      params.set("execution", path.execution.kind);
      params.set("merchant_revision", String(path.execution.merchantRevision));
      params.set("payment_id", path.execution.paymentId);
      params.set("payment_revision", String(path.execution.paymentRevision));
      params.set("fulfillment_id", path.execution.fulfillmentId);
      params.set(
        "fulfillment_revision",
        String(path.execution.fulfillmentRevision),
      );
      params.set("checkout_profile_id", path.execution.checkoutProfileId);
      params.set(
        "checkout_profile_revision",
        String(path.execution.checkoutProfileRevision),
      );
      params.set("refund_policy_id", path.execution.refundPolicyId);
      params.set(
        "refund_amount_minor",
        String(path.execution.refundAmountMinor),
      );
      params.set("refund_currency", path.execution.refundCurrency);
      params.set("refund_governance", path.execution.refundGovernance);
      break;
  }
  return `/orders/${encodeURIComponent(path.resourceId)}/cancel?${params.toString()}`;
}

function hasUniqueQueryKeys(
  searchParams: URLSearchParams,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key) || searchParams.getAll(key).length !== 1)
      return false;
  }
  return true;
}

function currencyCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/u.test(value);
}

function canonicalAmountValue(
  amountMinor: number,
  currency: string,
): NonNullable<CanonicalActionDraft["amount"]> | null {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !currencyCode(currency)
  ) {
    return null;
  }
  let fractionDigits: number | undefined;
  try {
    fractionDigits = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return null;
  }
  if (
    fractionDigits === undefined ||
    !Number.isSafeInteger(fractionDigits) ||
    fractionDigits < 0
  ) {
    return null;
  }
  const value = amountMinor / 10 ** fractionDigits;
  return Number.isFinite(value) ? { value, currency } : null;
}

function actionResourceId(
  input: CommerceActionRequest | CommerceActionPath,
): string {
  switch (input.kind) {
    case "install_merchant_plugin":
      return input.pluginId;
    case "publish_cafe_menu":
      return input.menu.menuId;
    case "change_menu_price":
      return input.offerId;
    case "refund_order":
      return input.orderId;
    case "stock_operation":
      return stockOperationResourceId(input.operation);
    case "publish_catalog_listing":
      return input.offerId;
    case "update_product_description":
      return input.productId;
    case "cancel_order":
      return input.resourceId;
    case "attach_tracking":
      return input.fulfillmentId;
    case "adjust_offer_price":
      return input.offerId;
    case "submit_supplier_payout":
      return input.payoutId;
    case "resume_supplier_payout_funding":
      return input.payoutId;
  }
}

function actionVerb(
  input: CommerceActionRequest,
): LedgerCanonicalAction["verb"] {
  switch (input.kind) {
    case "install_merchant_plugin":
      return MERCHANT_PLUGIN_INSTALL_VERB;
    case "publish_cafe_menu":
      return CAFE_MENU_PUBLISH_VERB;
    case "change_menu_price":
      return MENU_PRICE_CHANGE_VERB;
    case "refund_order":
      return ORDER_REFUND_VERB;
    case "stock_operation":
      return stockOperationVerb(input.operation);
    case "publish_catalog_listing":
      return "commerce.catalog.publish";
    case "update_product_description":
      return "commerce.catalog.update_description";
    case "cancel_order":
      return "commerce.order.cancel";
    case "attach_tracking":
      return "commerce.fulfillment.attach_tracking";
    case "adjust_offer_price":
      return "commerce.offer.adjust_price";
    case "submit_supplier_payout":
    case "resume_supplier_payout_funding":
      // Proposing and submitting are different authorities. A propose-capable
      // agent must not be able to send money by reaching the execution path.
      return "commerce.supplier_payout.submit";
  }
}

function positiveIntegerParam(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseUpdateProductDescriptionRequest(
  raw: Record<string, unknown>,
): Result<CommerceActionRequest, CommerceActionError> {
  if (!text(raw.productId)) return invalid("productId");
  const productRevision = positiveIntegerOrNull(raw.productRevision);
  if (productRevision === null) return invalid("productRevision");
  if (!validProductDescription(raw.description)) return invalid("description");
  return {
    ok: true,
    value: {
      kind: "update_product_description",
      productId: raw.productId,
      productRevision,
      description: raw.description,
    },
  };
}

function validProductDescription(value: unknown): value is string {
  return typeof value === "string" && value.length <= DESCRIPTION_LIMIT;
}

function parsePublishRequest(
  raw: Record<string, unknown>,
): Result<CommerceActionRequest, CommerceActionError> {
  const productId = text(raw.productId) ? raw.productId : null;
  const variantId = text(raw.variantId) ? raw.variantId : null;
  const offerId = text(raw.offerId) ? raw.offerId : null;
  const salesChannelId = text(raw.salesChannelId) ? raw.salesChannelId : null;
  if (productId === null) return invalid("productId");
  if (variantId === null) return invalid("variantId");
  if (offerId === null) return invalid("offerId");
  if (salesChannelId === null) return invalid("salesChannelId");
  const productRevision = positiveIntegerOrNull(raw.productRevision);
  const variantRevision = positiveIntegerOrNull(raw.variantRevision);
  const offerRevision = positiveIntegerOrNull(raw.offerRevision);
  const salesChannelRevision = positiveIntegerOrNull(raw.salesChannelRevision);
  if (
    productRevision === null ||
    variantRevision === null ||
    offerRevision === null ||
    salesChannelRevision === null
  ) {
    return invalid("revision");
  }
  return {
    ok: true,
    value: {
      kind: "publish_catalog_listing",
      productId,
      productRevision,
      variantId,
      variantRevision,
      offerId,
      offerRevision,
      salesChannelId,
      salesChannelRevision,
    },
  };
}

function parseCancelRequest(
  raw: Record<string, unknown>,
): Result<CommerceActionRequest, CommerceActionError> {
  if (!text(raw.resourceId)) return invalid("resourceId");
  const expectedRevision = positiveIntegerOrNull(raw.expectedRevision);
  if (expectedRevision === null) return invalid("expectedRevision");
  if (
    raw.reason !== "customer_requested" &&
    raw.reason !== "fraud_suspected" &&
    raw.reason !== "inventory_unavailable"
  )
    return invalid("reason");
  if (raw.refund !== "none" && raw.refund !== "full") return invalid("refund");
  if (typeof raw.restock !== "boolean") return invalid("restock");
  if (typeof raw.notifyCustomer !== "boolean") return invalid("notifyCustomer");
  const note = raw.note === null ? null : text(raw.note) ? raw.note : undefined;
  if (note === undefined) return invalid("note");
  return {
    ok: true,
    value: {
      kind: "cancel_order",
      resourceId: raw.resourceId,
      expectedRevision,
      reason: raw.reason,
      refund: raw.refund,
      restock: raw.restock,
      notifyCustomer: raw.notifyCustomer,
      note,
    },
  };
}

function parseAttachTrackingRequest(
  raw: Record<string, unknown>,
): Result<CommerceActionRequest, CommerceActionError> {
  if (!trackingBatchId(raw.batchId)) return invalid("batchId");
  const merchantRevision = positiveIntegerOrNull(raw.merchantRevision);
  if (merchantRevision === null) return invalid("merchantRevision");
  if (!text(raw.orderId)) return invalid("orderId");
  if (!text(raw.fulfillmentId)) return invalid("fulfillmentId");
  const fulfillmentRevision = positiveIntegerOrNull(raw.fulfillmentRevision);
  if (fulfillmentRevision === null) return invalid("fulfillmentRevision");
  if (!text(raw.shipmentId)) return invalid("shipmentId");
  const shipmentRevision = positiveIntegerOrNull(raw.shipmentRevision);
  if (shipmentRevision === null) return invalid("shipmentRevision");
  if (!text(raw.trackingNumber)) return invalid("trackingNumber");
  return {
    ok: true,
    value: {
      kind: "attach_tracking",
      batchId: raw.batchId,
      merchantRevision,
      orderId: raw.orderId,
      fulfillmentId: raw.fulfillmentId,
      fulfillmentRevision,
      shipmentId: raw.shipmentId,
      shipmentRevision,
      trackingNumber: raw.trackingNumber,
    },
  };
}

function trackingBatchId(value: unknown): value is string {
  return (
    typeof value === "string" && /^tracking_batch_[0-9a-f]{64}$/u.test(value)
  );
}

function invalid(field: string): Result<never, CommerceActionError> {
  return { ok: false, error: { code: "commerce_action_invalid", field } };
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 256
  );
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
    text(value.id) &&
    positiveIntegerOrNull(value.revision) !== null
  );
}
