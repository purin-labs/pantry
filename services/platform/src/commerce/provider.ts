import type {
  CanonicalCommerceDelivery,
  CanonicalCommerceObservation,
  CommerceProjection,
  FoodServicePreparation,
  InventoryRequirement,
  InventoryRequirementAdjustment,
  InventoryReplenishmentPolicy,
  Menu,
  MenuEntry,
  MenuScope,
  MenuSection,
  ModifierGroupRevision,
  ModifierOption,
  ModifierSelectionSnapshot,
  OrderLifecycle,
  OrderLineInventory,
  OrderLineSource,
  PreparationTicket,
  PreparationTicketLifecycle,
  ProductionBatchDemand,
  Quantity,
  RecipeOutput,
  ShippingFulfillmentBinding,
  ShippingQuoteSnapshot,
  FirstPartyShipmentLifecycle,
  ShipmentPackage,
  SourceProvenance,
} from "@seams/contracts";
import type { CommerceCancellationAuthority } from "./action-model";
import type { Result } from "../result";
import {
  type InstallCommerceMerchantPluginV1,
  type CommerceCommandInput,
  CommerceAdminClient,
  commerceReceivedDeliverySignaturePayload,
  type CancelCommerceOrderV1,
  type AdjustCommerceOfferPriceV1,
  type PublishCommerceCatalogListingV1,
  type UpdateCommerceProductDescriptionV1,
  type CommerceClientError,
  type CommerceDeliveryV1,
  type CommerceReceivedDeliveryV1,
  type CommerceAggregateObservationV1,
  type CommerceObservationV1,
  type CommerceEntityPlaneObservationV1,
  type CommerceQuantityV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  type CommerceFulfillmentV1,
  type CommerceShipmentV1,
  type CommerceFirstPartyShipmentV1,
  type CommerceMutationErrorV1,
  type CommerceMutationReceiptV1,
  type CommerceLotAllocationV1,
  type CommerceMenuV1,
  type CommerceModifierGroupRevisionV1,
  type CommerceRecipeRevisionV1,
  type CommercePreparationStationV1,
  type CommercePreparationTicketV1,
  type CommerceProductionBatchV1,
  type CommerceStockPolicyV1,
  parseShipmentEntityId,
} from "@seams/commerce-client";
import type { Variant } from "@seams/type-utils";
import { isPositiveInteger } from "@seams/std";

export interface CommerceDeliveryVerifier {
  verify(
    input: Readonly<{
      keyId: string;
      algorithm: "ed25519";
      payload: Uint8Array;
      signature: string;
    }>,
  ): Promise<boolean>;
}

export type CommerceEntityPlaneAdmission = Readonly<{
  deliveryId: string;
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
  observedAt: string;
  observations: readonly CommerceEntityPlaneObservationV1[];
}>;

export type NormalizeCommerceDeliveryResult =
  | Readonly<{
      ok: true;
      kind: "aggregate";
      delivery: CanonicalCommerceDelivery;
    }>
  | Readonly<{
      ok: true;
      kind: "entity_plane";
      admission: CommerceEntityPlaneAdmission;
    }>
  | Readonly<{
      ok: false;
      error:
        | "underclerk_delivery_signature_invalid"
        | "underclerk_delivery_organisation_mismatch"
        | "underclerk_delivery_merchant_mismatch"
        | "underclerk_delivery_mixed_observation_categories";
    }>;

export type CommerceCatalogPublicationResult =
  | Readonly<{
      status: "applied" | "replayed";
      receipt: CommerceMutationReceiptV1;
    }>
  | Readonly<{ status: "rejected"; error: CommerceMutationErrorV1 }>
  | Readonly<{ status: "unavailable"; error: CommerceClientError }>;

export type CommerceOrderCancellationResult =
  | Readonly<{
      status: "applied" | "replayed";
      receipt: CommerceMutationReceiptV1;
    }>
  | Readonly<{ status: "rejected"; error: CommerceMutationErrorV1 }>
  | Readonly<{ status: "unavailable"; error: CommerceClientError }>;

export type CommerceProductDescriptionUpdateResult =
  | Readonly<{
      status: "applied" | "replayed";
      receipt: CommerceMutationReceiptV1;
    }>
  | Readonly<{ status: "rejected"; error: CommerceMutationErrorV1 }>
  | Readonly<{ status: "unavailable"; error: CommerceClientError }>;

export type CommerceCancellationAuthorityError =
  | Readonly<{ code: "underclerk_unavailable"; cause: CommerceClientError }>
  | Readonly<{
      code: "underclerk_cancellation_authority_incomplete";
      field: string;
    }>;

export type CommerceCancellationAuthorityResult = Result<
  CommerceCancellationAuthority,
  CommerceCancellationAuthorityError
>;

export type CommerceMutationReceiptReconciliation =
  | Readonly<{ kind: "committed"; receipt: CommerceMutationReceiptV1 }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "indeterminate" }>;

export async function normalizeCommerceEngineDelivery(
  input: Readonly<{
    delivery: CommerceDeliveryV1 | CommerceReceivedDeliveryV1;
    organisationId: string;
    merchantId: string;
    integrationAccountId: string;
    verifier: CommerceDeliveryVerifier;
  }>,
): Promise<NormalizeCommerceDeliveryResult> {
  if (input.delivery.merchantId !== input.merchantId) {
    return { ok: false, error: "underclerk_delivery_merchant_mismatch" };
  }
  if (
    !(await input.verifier.verify({
      keyId: input.delivery.signer.keyId,
      algorithm: input.delivery.signer.algorithm,
      payload: commerceReceivedDeliverySignaturePayload(input.delivery),
      signature: input.delivery.signer.signature,
    }))
  ) {
    return { ok: false, error: "underclerk_delivery_signature_invalid" };
  }
  const entityPlaneObservations = readEntityPlaneObservations(
    input.delivery.observations,
  );
  if (entityPlaneObservations !== null) {
    return {
      ok: true,
      kind: "entity_plane",
      admission: {
        deliveryId: input.delivery.deliveryId,
        organisationId: input.organisationId,
        merchantId: input.delivery.merchantId,
        merchantRevision: input.delivery.merchantRevision,
        observedAt: input.delivery.observedAt,
        observations: entityPlaneObservations,
      },
    };
  }
  const aggregateObservations = readAggregateObservations(
    input.delivery.observations,
  );
  if (aggregateObservations === null) {
    return {
      ok: false,
      error: "underclerk_delivery_mixed_observation_categories",
    };
  }
  return {
    ok: true,
    kind: "aggregate",
    delivery: {
      schemaVersion: 1,
      providerDeliveryId: input.delivery.deliveryId,
      observations: aggregateObservations.map((observation) =>
        normalizeObservation({
          observation,
          deliveryId: input.delivery.deliveryId,
          merchantId: input.merchantId,
          organisationId: input.organisationId,
          integrationAccountId: input.integrationAccountId,
          observedAt: input.delivery.observedAt,
        }),
      ),
    },
  };
}

export function createCommerceEd25519Verifier(
  input: Readonly<{
    expectedKeyId: string;
    publicKey: Uint8Array;
  }>,
): CommerceDeliveryVerifier {
  return {
    async verify(candidate): Promise<boolean> {
      if (
        candidate.keyId !== input.expectedKeyId ||
        candidate.algorithm !== "ed25519"
      )
        return false;
      const signature = decodeBase64Url(candidate.signature);
      if (signature === null) return false;
      try {
        const key = await crypto.subtle.importKey(
          "raw",
          input.publicKey,
          "Ed25519",
          false,
          ["verify"],
        );
        return crypto.subtle.verify(
          "Ed25519",
          key,
          signature,
          candidate.payload,
        );
      } catch {
        return false;
      }
    },
  };
}

export async function publishCatalogListingThroughCommerce(
  input: Readonly<{
    client: CommerceAdminClient;
    command: CommerceCommandInput<PublishCommerceCatalogListingV1>;
  }>,
): Promise<CommerceCatalogPublicationResult> {
  const result = await input.client.publishCatalogListing(input.command);
  if (!result.ok) return { status: "unavailable", error: result.error };
  switch (result.value.outcome) {
    case "applied":
    case "replayed":
      return { status: result.value.outcome, receipt: result.value.receipt };
    case "rejected":
      return { status: "rejected", error: result.value.error };
  }
}

/**
 * Applies one approved Offer price change.
 *
 * Commerce re-checks the policy, both bound revisions, the currency and the
 * listing state against state read at commit, so an approval that has gone
 * stale is refused there rather than applied here.
 */
export async function adjustOfferPriceThroughCommerce(
  input: Readonly<{
    client: CommerceAdminClient;
    command: CommerceCommandInput<AdjustCommerceOfferPriceV1>;
  }>,
): Promise<CommerceCatalogPublicationResult> {
  const result = await input.client.adjustOfferPrice(input.command);
  if (!result.ok) return { status: "unavailable", error: result.error };
  switch (result.value.outcome) {
    case "applied":
    case "replayed":
      return { status: result.value.outcome, receipt: result.value.receipt };
    case "rejected":
      return { status: "rejected", error: result.value.error };
  }
}

/**
 * Installs one approved merchant plugin version. Commerce checks the
 * definition, the settings and the expected installation revision at commit,
 * so a plugin that changed since the proposal is refused there.
 */
export async function installMerchantPluginThroughCommerce(
  input: Readonly<{
    client: CommerceAdminClient;
    command: CommerceCommandInput<InstallCommerceMerchantPluginV1>;
  }>,
): Promise<CommerceCatalogPublicationResult> {
  const result = await input.client.installMerchantPlugin(input.command);
  if (!result.ok) {
    return result.error.kind === "rejected"
      ? { status: "rejected", error: result.error.error }
      : { status: "unavailable", error: result.error };
  }
  switch (result.value.outcome) {
    case "applied":
    case "replayed":
      return { status: result.value.outcome, receipt: result.value.receipt };
    case "rejected":
      return { status: "rejected", error: result.value.error };
  }
}

export async function updateProductDescriptionThroughCommerce(
  input: Readonly<{
    client: CommerceAdminClient;
    command: CommerceCommandInput<UpdateCommerceProductDescriptionV1>;
  }>,
): Promise<CommerceProductDescriptionUpdateResult> {
  const result = await input.client.updateProductDescription(input.command);
  if (!result.ok) return { status: "unavailable", error: result.error };
  switch (result.value.outcome) {
    case "applied":
    case "replayed":
      return { status: result.value.outcome, receipt: result.value.receipt };
    case "rejected":
      return { status: "rejected", error: result.value.error };
  }
}

export async function cancelOrderThroughCommerce(
  input: Readonly<{
    client: CommerceAdminClient;
    command: CommerceCommandInput<CancelCommerceOrderV1>;
  }>,
): Promise<CommerceOrderCancellationResult> {
  const result = await input.client.cancelOrder(input.command);
  if (!result.ok) {
    return result.error.kind === "rejected"
      ? { status: "rejected", error: result.error.error }
      : { status: "unavailable", error: result.error };
  }
  switch (result.value.outcome) {
    case "applied":
    case "replayed":
      return { status: result.value.outcome, receipt: result.value.receipt };
    case "rejected":
      return { status: "rejected", error: result.value.error };
  }
}

export async function resolveCommerceCancellationAuthority(
  input: Readonly<{
    client: CommerceAdminClient;
    organisationId: string;
    merchantId: string;
    orderId: string;
    orderRevision: number;
    requestedAt: string;
  }>,
): Promise<CommerceCancellationAuthorityResult> {
  if (!isPositiveInteger(input.orderRevision)) {
    return cancellationAuthorityIncomplete("orderRevision");
  }
  if (!timestampAtOrBefore(input.requestedAt, input.requestedAt)) {
    return cancellationAuthorityIncomplete("requestedAt");
  }

  const snapshot = await input.client.readSnapshot(input.merchantId);
  if (!snapshot.ok) return commerceUnavailable(snapshot.error);
  if (snapshot.value.merchantId !== input.merchantId) {
    return cancellationAuthorityIncomplete("snapshot.merchantId");
  }
  if (!isPositiveInteger(snapshot.value.merchantRevision)) {
    return cancellationAuthorityIncomplete("snapshot.merchantRevision");
  }

  const order = uniqueOrderById(snapshot.value.resources.orders, input.orderId);
  if (order === undefined) return cancellationAuthorityIncomplete("order");
  if (order.revision !== input.orderRevision) {
    return cancellationAuthorityIncomplete("order.revision");
  }
  if (!timestampAtOrBefore(order.occurredAt, input.requestedAt)) {
    return cancellationAuthorityIncomplete("order.occurredAt");
  }
  if (
    order.lifecycle.state !== "fulfillment_pending" ||
    !timestampAtOrBefore(order.lifecycle.since, input.requestedAt)
  ) {
    return cancellationAuthorityIncomplete("order.lifecycle");
  }
  if (
    order.origin.kind !== "online" ||
    order.origin.configuration.kind !== "checkout_profile"
  ) {
    return cancellationAuthorityIncomplete("order.origin");
  }
  if (order.adjustments.length !== 0) {
    return cancellationAuthorityIncomplete("order.adjustments");
  }
  if (!cancellationOrderLinesAreValid(order)) {
    return cancellationAuthorityIncomplete("order.lineItems");
  }
  if (!isPositiveMoney(order.totals.total)) {
    return cancellationAuthorityIncomplete("order.totals");
  }
  if (!supportedCancellationTotals(order)) {
    return cancellationAuthorityIncomplete("order.totals");
  }

  const payment = uniqueCapturedPaymentForOrder(
    snapshot.value.resources.payments,
    order.id,
  );
  if (payment === undefined) return cancellationAuthorityIncomplete("payment");
  if (
    payment.lifecycle.state !== "captured" ||
    !timestampAtOrBefore(payment.occurredAt, input.requestedAt) ||
    !timestampAtOrBefore(payment.lifecycle.capturedAt, input.requestedAt)
  ) {
    return cancellationAuthorityIncomplete("payment.timestamp");
  }
  if (
    !isPositiveMoney(payment.amount) ||
    payment.amount.amountMinor !== order.totals.total.amountMinor ||
    payment.amount.currency !== order.totals.total.currency
  ) {
    return cancellationAuthorityIncomplete("payment.amount");
  }

  const fulfillment = uniqueRequestedFulfillmentForOrder(
    snapshot.value.resources.fulfillments,
    order.id,
  );
  if (fulfillment === undefined)
    return cancellationAuthorityIncomplete("fulfillment");
  if (
    (fulfillment.kind !== "pickup" && fulfillment.kind !== "shipping") ||
    fulfillment.lifecycle.state !== "requested" ||
    !timestampAtOrBefore(fulfillment.occurredAt, input.requestedAt) ||
    !timestampAtOrBefore(fulfillment.lifecycle.requestedAt, input.requestedAt)
  ) {
    return cancellationAuthorityIncomplete("fulfillment.timestamp");
  }
  if (!exactCancellationFulfillmentLines(order, fulfillment)) {
    return cancellationAuthorityIncomplete("fulfillment.lineItems");
  }

  const profileResult = await input.client.readCheckoutProfile(
    input.merchantId,
    order.origin.configuration.checkoutProfile.checkoutProfileId,
    order.origin.configuration.checkoutProfile.revision,
  );
  if (!profileResult.ok) return commerceUnavailable(profileResult.error);
  const profile = profileResult.value;
  if (
    profile.checkoutProfileId !==
      order.origin.configuration.checkoutProfile.checkoutProfileId ||
    profile.revision !== order.origin.configuration.checkoutProfile.revision ||
    profile.merchantId !== input.merchantId
  ) {
    return cancellationAuthorityIncomplete("checkoutProfile");
  }
  switch (profile.lifecycle.state) {
    case "draft":
      return cancellationAuthorityIncomplete("checkoutProfile");
    case "published":
      if (
        !timestampAtOrBefore(profile.lifecycle.publishedAt, input.requestedAt)
      ) {
        return cancellationAuthorityIncomplete("checkoutProfile");
      }
      break;
    case "retired":
      if (
        !timestampAtOrBefore(
          profile.lifecycle.publishedAt,
          input.requestedAt,
        ) ||
        !timestampAtOrBefore(profile.lifecycle.retiredAt, input.requestedAt)
      ) {
        return cancellationAuthorityIncomplete("checkoutProfile");
      }
      break;
  }

  return {
    ok: true,
    value: {
      kind: "underclerk_full_refund",
      merchantRevision: snapshot.value.merchantRevision,
      paymentId: payment.id,
      paymentRevision: payment.revision,
      fulfillmentId: fulfillment.id,
      fulfillmentRevision: fulfillment.revision,
      checkoutProfileId: profile.checkoutProfileId,
      checkoutProfileRevision: profile.revision,
      refundPolicyId: profile.configuration.afterSalePolicy.refundPolicyId,
      refundAmountMinor: order.totals.total.amountMinor,
      refundCurrency: order.totals.total.currency,
      refundGovernance:
        profile.configuration.afterSalePolicy.refundGovernance.kind ===
          "automatic_up_to" &&
        profile.configuration.afterSalePolicy.refundGovernance.threshold
          .currency === order.totals.total.currency &&
        order.totals.total.amountMinor <=
          profile.configuration.afterSalePolicy.refundGovernance.threshold
            .amountMinor
          ? "automatic_eligible"
          : "approval_required",
    },
  };
}

type CancellationFulfillment = Variant<
  CommerceFulfillmentV1,
  "pickup" | "shipping"
> &
  Readonly<{
    lifecycle: Readonly<{ state: "requested"; requestedAt: string }>;
  }>;

function uniqueOrderById(
  orders: readonly CommerceOrderV1[],
  orderId: string,
): CommerceOrderV1 | undefined {
  let match: CommerceOrderV1 | undefined;
  for (const order of orders) {
    if (order.id !== orderId) continue;
    if (match !== undefined) return undefined;
    match = order;
  }
  return match;
}

function uniqueCapturedPaymentForOrder(
  payments: readonly CommercePaymentV1[],
  orderId: string,
): CommercePaymentV1 | undefined {
  let match: CommercePaymentV1 | undefined;
  for (const payment of payments) {
    if (payment.orderId !== orderId || payment.lifecycle.state !== "captured")
      continue;
    if (match !== undefined) return undefined;
    match = payment;
  }
  return match;
}

function uniqueRequestedFulfillmentForOrder(
  fulfillments: readonly CommerceFulfillmentV1[],
  orderId: string,
): CancellationFulfillment | undefined {
  let match: CancellationFulfillment | undefined;
  for (const fulfillment of fulfillments) {
    if (
      fulfillment.orderId !== orderId ||
      !isCancellationFulfillment(fulfillment)
    )
      continue;
    if (match !== undefined) return undefined;
    match = fulfillment;
  }
  return match;
}

function isCancellationFulfillment(
  fulfillment: CommerceFulfillmentV1,
): fulfillment is CancellationFulfillment {
  return (
    (fulfillment.kind === "pickup" || fulfillment.kind === "shipping") &&
    fulfillment.lifecycle.state === "requested"
  );
}

function cancellationOrderLinesAreValid(order: CommerceOrderV1): boolean {
  if (order.lineItems.length === 0) return false;
  const lineIds = new Set<string>();
  for (const line of order.lineItems) {
    if (
      lineIds.has(line.id) ||
      (line.source.kind !== "catalog" && line.source.kind !== "food_service") ||
      line.fulfilledQuantity.amount !== 0 ||
      line.fulfilledQuantity.scale !== line.quantity.scale ||
      line.fulfilledQuantity.unit !== line.quantity.unit
    ) {
      return false;
    }
    lineIds.add(line.id);
  }
  return true;
}

function exactCancellationFulfillmentLines(
  order: CommerceOrderV1,
  fulfillment: CancellationFulfillment,
): boolean {
  if (fulfillment.lineItems.length !== order.lineItems.length) return false;
  for (const orderLine of order.lineItems) {
    let matches = 0;
    for (const fulfillmentLine of fulfillment.lineItems) {
      if (
        fulfillmentLine.lineItemId === orderLine.id &&
        orderLine.quantity.scale === 0 &&
        orderLine.quantity.unit === "each" &&
        fulfillmentLine.quantity === orderLine.quantity.amount
      ) {
        matches += 1;
      }
    }
    if (matches !== 1) return false;
  }
  return true;
}

function supportedCancellationTotals(order: CommerceOrderV1): boolean {
  const currency = order.totals.total.currency;
  const totals = [
    order.totals.subtotal,
    order.totals.discount,
    order.totals.tax,
    order.totals.duty,
    order.totals.shipping,
    order.totals.serviceFee,
    order.totals.tip,
    order.totals.rounding,
    order.totals.total,
  ];
  if (
    totals.some((money) => money.currency !== currency) ||
    order.totals.total.amountMinor <= 0 ||
    order.totals.discount.amountMinor !== 0 ||
    order.totals.serviceFee.amountMinor !== 0 ||
    order.totals.tip.amountMinor !== 0 ||
    order.totals.rounding.amountMinor !== 0
  ) {
    return false;
  }

  let lineTotal = 0;
  let taxTotal = 0;
  for (const line of order.lineItems) {
    if (line.lineTotal.currency !== currency || line.tax.currency !== currency)
      return false;
    const nextLineTotal = safeMoneySum(lineTotal, line.lineTotal.amountMinor);
    const nextTaxTotal = safeMoneySum(taxTotal, line.tax.amountMinor);
    if (nextLineTotal === null || nextTaxTotal === null) return false;
    lineTotal = nextLineTotal;
    taxTotal = nextTaxTotal;
  }
  const dutyAndShipping = safeMoneySum(
    order.totals.duty.amountMinor,
    order.totals.shipping.amountMinor,
  );
  if (dutyAndShipping === null) return false;
  // Included tax is a part of the line totals, not an amount on top.
  const lineAndTax =
    order.totals.taxIncluded === true
      ? lineTotal
      : safeMoneySum(lineTotal, taxTotal);
  if (lineAndTax === null) return false;
  const allocatedTotal = safeMoneySum(lineAndTax, dutyAndShipping);
  return (
    allocatedTotal !== null &&
    lineTotal === order.totals.subtotal.amountMinor &&
    taxTotal === order.totals.tax.amountMinor &&
    allocatedTotal === order.totals.total.amountMinor
  );
}

function safeMoneySum(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

function isPositiveMoney(
  money: Readonly<{ amountMinor: number; currency: string }>,
): boolean {
  return isPositiveInteger(money.amountMinor);
}

function timestampAtOrBefore(left: string, right: string): boolean {
  return left.endsWith("Z") && Date.parse(left) <= Date.parse(right);
}

function commerceUnavailable<T>(
  cause: CommerceClientError,
): Result<T, CommerceCancellationAuthorityError> {
  return { ok: false, error: { code: "underclerk_unavailable", cause } };
}

function cancellationAuthorityIncomplete<T>(
  field: string,
): Result<T, CommerceCancellationAuthorityError> {
  return {
    ok: false,
    error: { code: "underclerk_cancellation_authority_incomplete", field },
  };
}

export async function reconcileCommerceOrderCancellation(
  input: Readonly<{
    client: CommerceAdminClient;
    organisationId: string;
    merchantId: string;
    idempotencyKey: string;
    refundAttemptId: string;
  }>,
): Promise<CommerceMutationReceiptReconciliation> {
  const result = await input.client.readMutationReceipt(
    input.merchantId,
    input.idempotencyKey,
  );
  if (!result.ok) return { kind: "indeterminate" };
  const receipt = result.value;
  if (receipt === null) return { kind: "absent" };
  return receipt.merchantId === input.merchantId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.commandKind === "cancel_order" &&
    receipt.resource.kind === "refund_attempt" &&
    receipt.resource.id === input.refundAttemptId
    ? { kind: "committed", receipt }
    : { kind: "indeterminate" };
}

export async function reconcileCommerceProductDescriptionUpdate(
  input: Readonly<{
    client: CommerceAdminClient;
    organisationId: string;
    merchantId: string;
    idempotencyKey: string;
    productId: string;
  }>,
): Promise<CommerceMutationReceiptReconciliation> {
  const result = await input.client.readMutationReceipt(
    input.merchantId,
    input.idempotencyKey,
  );
  if (!result.ok) return { kind: "indeterminate" };
  const receipt = result.value;
  if (receipt === null) return { kind: "absent" };
  return receipt.merchantId === input.merchantId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.commandKind === "update_product_description" &&
    receipt.resource.kind === "product" &&
    receipt.resource.id === input.productId
    ? { kind: "committed", receipt }
    : { kind: "indeterminate" };
}

/** Whether the refund of one approved action committed under its key. */
export async function reconcileCommerceOrderRefund(
  input: Readonly<{
    client: CommerceAdminClient;
    merchantId: string;
    idempotencyKey: string;
    refundAttemptId: string;
  }>,
): Promise<CommerceMutationReceiptReconciliation> {
  const result = await input.client.readMutationReceipt(
    input.merchantId,
    input.idempotencyKey,
  );
  if (!result.ok) return { kind: "indeterminate" };
  const receipt = result.value;
  if (receipt === null) return { kind: "absent" };
  return receipt.merchantId === input.merchantId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.resource.kind === "refund_attempt" &&
    receipt.resource.id === input.refundAttemptId
    ? { kind: "committed", receipt }
    : { kind: "indeterminate" };
}

/** Whether the publication of one approved menu committed under its key. */
export async function reconcileCommerceCafeMenuPublication(
  input: Readonly<{
    client: CommerceAdminClient;
    merchantId: string;
    idempotencyKey: string;
    menuId: string;
  }>,
): Promise<CommerceMutationReceiptReconciliation> {
  const result = await input.client.readMutationReceipt(
    input.merchantId,
    input.idempotencyKey,
  );
  if (!result.ok) return { kind: "indeterminate" };
  const receipt = result.value;
  if (receipt === null) return { kind: "absent" };
  return receipt.merchantId === input.merchantId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.commandKind === "publish_menu" &&
    receipt.resource.kind === "menu" &&
    receipt.resource.id === input.menuId
    ? { kind: "committed", receipt }
    : { kind: "indeterminate" };
}

/** Whether one approved offer update (a menu price) committed under its key. */
export async function reconcileCommerceOfferUpdate(
  input: Readonly<{
    client: CommerceAdminClient;
    merchantId: string;
    idempotencyKey: string;
    offerId: string;
  }>,
): Promise<CommerceMutationReceiptReconciliation> {
  const result = await input.client.readMutationReceipt(
    input.merchantId,
    input.idempotencyKey,
  );
  if (!result.ok) return { kind: "indeterminate" };
  const receipt = result.value;
  if (receipt === null) return { kind: "absent" };
  return receipt.merchantId === input.merchantId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.commandKind === "update_offer" &&
    receipt.resource.kind === "offer" &&
    receipt.resource.id === input.offerId
    ? { kind: "committed", receipt }
    : { kind: "indeterminate" };
}

export async function reconcileCommerceCatalogPublication(
  input: Readonly<{
    client: CommerceAdminClient;
    organisationId: string;
    merchantId: string;
    idempotencyKey: string;
    offerId: string;
  }>,
): Promise<CommerceMutationReceiptReconciliation> {
  const result = await input.client.readMutationReceipt(
    input.merchantId,
    input.idempotencyKey,
  );
  if (!result.ok) return { kind: "indeterminate" };
  const receipt = result.value;
  if (receipt === null) return { kind: "absent" };
  return receipt.merchantId === input.merchantId &&
    receipt.idempotencyKey === input.idempotencyKey &&
    receipt.commandKind === "publish_catalog_listing" &&
    receipt.resource.kind === "offer" &&
    receipt.resource.id === input.offerId
    ? { kind: "committed", receipt }
    : { kind: "indeterminate" };
}

export function commerceCanonicalResourceId(
  merchantId: string,
  resourceId: string,
): string {
  return `underclerk:${merchantId}:${resourceId}`;
}

export function commerceProviderResourceId(
  merchantId: string,
  canonicalResourceId: string,
): string | null {
  const prefix = `underclerk:${merchantId}:`;
  if (!canonicalResourceId.startsWith(prefix)) return null;
  const resourceId = canonicalResourceId.slice(prefix.length);
  return resourceId.length === 0 ? null : resourceId;
}

function readEntityPlaneObservations(
  observations: readonly CommerceObservationV1[],
): readonly CommerceEntityPlaneObservationV1[] | null {
  const entityPlaneObservations: CommerceEntityPlaneObservationV1[] = [];
  for (const observation of observations) {
    switch (observation.kind) {
      case "system_entity_changed":
      case "custom_entity_changed":
      case "relationship_changed":
      case "commerce_list_entry_changed":
        entityPlaneObservations.push(observation);
        break;
      default:
        return null;
    }
  }
  return entityPlaneObservations.length === 0 ? null : entityPlaneObservations;
}

function readAggregateObservations(
  observations: readonly CommerceObservationV1[],
): readonly CommerceAggregateObservationV1[] | null {
  const aggregateObservations: CommerceAggregateObservationV1[] = [];
  for (const observation of observations) {
    switch (observation.kind) {
      case "system_entity_changed":
      case "custom_entity_changed":
      case "relationship_changed":
      case "commerce_list_entry_changed":
        return null;
      default:
        aggregateObservations.push(observation);
    }
  }
  return aggregateObservations;
}

function normalizeObservation(
  input: Readonly<{
    observation: CommerceAggregateObservationV1;
    deliveryId: string;
    merchantId: string;
    organisationId: string;
    integrationAccountId: string;
    observedAt: string;
  }>,
): CanonicalCommerceObservation {
  const projection = normalizeProjection(input);
  const provenance = projection.projection.provenance;
  return {
    kind: "upsert",
    observationId: `${input.deliveryId}:${projection.kind}:${provenance.resourceId}:${provenance.revision}`,
    projection,
  };
}

function normalizeProjection(
  input: Readonly<{
    observation: CommerceAggregateObservationV1;
    merchantId: string;
    organisationId: string;
    integrationAccountId: string;
    observedAt: string;
  }>,
): CommerceProjection {
  const provenance = commerceProvenance(input);
  switch (input.observation.kind) {
    case "location":
      return {
        kind: "location",
        projection: {
          provenance,
          name: input.observation.resource.name,
          kind: input.observation.resource.kind,
          lifecycle: input.observation.resource.lifecycle,
        },
      };
    case "sales_channel":
      return {
        kind: "sales_channel",
        projection: {
          provenance,
          name: input.observation.resource.name,
          kind: input.observation.resource.kind,
          lifecycle: input.observation.resource.lifecycle,
        },
      };
    case "product":
      return {
        kind: "product",
        projection: {
          provenance,
          title: input.observation.resource.title,
          description: input.observation.resource.description,
        },
      };
    case "sellable_variant":
      return {
        kind: "sellable_variant",
        projection: {
          provenance,
          productId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.productId,
          ),
          variantId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.id,
          ),
          sku: input.observation.resource.sku,
          title: input.observation.resource.title,
          options: [...input.observation.resource.options],
          media: [...input.observation.resource.media],
        },
      };
    case "inventory_item":
      return {
        kind: "inventory_item",
        projection: {
          provenance,
          merchantCode: input.observation.resource.merchantCode,
          name: input.observation.resource.name,
          baseUnit: input.observation.resource.baseUnit,
          category: input.observation.resource.category,
          tracking: input.observation.resource.tracking,
          lifecycle: input.observation.resource.lifecycle,
        },
      };
    case "offer":
      return {
        kind: "offer",
        projection: {
          provenance,
          variantId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.variantId,
          ),
          salesChannelId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.salesChannelId,
          ),
          price: input.observation.resource.price,
          availability: input.observation.resource.availability,
          lifecycle: input.observation.resource.lifecycle,
        },
      };
    case "inventory_position":
      return {
        kind: "inventory_position",
        projection: {
          provenance,
          inventoryItemId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.inventoryItemId,
          ),
          locationId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.locationId,
          ),
          balance: input.observation.resource.balance,
        },
      };
    case "inventory_movement":
      return {
        kind: "inventory_movement",
        projection: {
          provenance,
          inventoryItemId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.inventoryItemId,
          ),
          locationId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.locationId,
          ),
          change: normalizeInventoryMovementChange(
            input.observation.resource.change,
            input.merchantId,
          ),
          idempotencyKey: input.observation.resource.idempotencyKey,
        },
      };
    case "inventory_lot":
      return {
        kind: "inventory_lot",
        projection: {
          provenance,
          lotCode: input.observation.resource.lotCode,
          inventoryItemId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.inventoryItemId,
          ),
          locationId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.locationId,
          ),
          sourceMovementId: commerceCanonicalResourceId(
            input.merchantId,
            input.observation.resource.sourceMovementId,
          ),
          receivedQuantity: commerceQuantity(
            input.observation.resource.receivedQuantity,
          ),
          remainingQuantity: commerceQuantity(
            input.observation.resource.remainingQuantity,
          ),
          expiry: input.observation.resource.expiry,
          lifecycle: input.observation.resource.lifecycle,
        },
      };
    case "commerce_order":
      return normalizeOrderProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "payment":
      return normalizePaymentProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "fulfillment":
      return normalizeFulfillmentProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "shipment":
      return normalizeShipmentProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "menu":
      return normalizeMenuProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "modifier_group_revision":
      return normalizeModifierGroupRevisionProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "recipe_revision":
      return normalizeRecipeRevisionProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "preparation_station":
      return normalizePreparationStationProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "preparation_ticket":
      return normalizePreparationTicketProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "production_batch":
      return normalizeProductionBatchProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
    case "stock_policy":
      return normalizeStockPolicyProjection(
        input.observation.resource,
        provenance,
        input.merchantId,
      );
  }
}

type MenuProjection = Variant<CommerceProjection, "menu">;
type ModifierGroupRevisionProjection = Variant<
  CommerceProjection,
  "modifier_group_revision"
>;
type RecipeRevisionProjection = Variant<CommerceProjection, "recipe_revision">;
type PreparationStationProjection = Variant<
  CommerceProjection,
  "preparation_station"
>;
type PreparationTicketProjection = Variant<
  CommerceProjection,
  "preparation_ticket"
>;
type ProductionBatchProjection = Variant<
  CommerceProjection,
  "production_batch"
>;
type StockPolicyProjection = Variant<CommerceProjection, "stock_policy">;

function normalizeMenuProjection(
  resource: CommerceMenuV1,
  provenance: SourceProvenance,
  merchantId: string,
): MenuProjection {
  return {
    kind: "menu",
    projection: {
      provenance,
      menuId: commerceCanonicalResourceId(merchantId, resource.menuId),
      revision: resource.revision,
      name: resource.name,
      salesChannelId: commerceCanonicalResourceId(
        merchantId,
        resource.salesChannelId,
      ),
      scope: normalizeMenuScope(resource.scope, merchantId),
      validity: resource.validity,
      sections: normalizeMenuSections(resource.sections, merchantId),
      entries: normalizeMenuEntries(resource.entries, merchantId),
      lifecycle: resource.lifecycle,
    },
  };
}

function normalizeMenuSections(
  sections: readonly MenuSection[],
  merchantId: string,
): Menu["sections"] {
  const normalized: Menu["sections"] = [];
  for (const section of sections) {
    normalized.push({
      sectionId: commerceCanonicalResourceId(merchantId, section.sectionId),
      menuId: commerceCanonicalResourceId(merchantId, section.menuId),
      revision: section.revision,
      name: section.name,
      position: section.position,
    });
  }
  return normalized;
}

function normalizeMenuEntries(
  entries: readonly MenuEntry[],
  merchantId: string,
): Menu["entries"] {
  const normalized: Menu["entries"] = [];
  for (const entry of entries) {
    const modifierGroupRevisions: MenuEntry["modifierGroupRevisions"] = [];
    for (const reference of entry.modifierGroupRevisions) {
      modifierGroupRevisions.push({
        modifierGroupId: commerceCanonicalResourceId(
          merchantId,
          reference.modifierGroupId,
        ),
        revision: reference.revision,
      });
    }
    normalized.push({
      menuEntryId: commerceCanonicalResourceId(merchantId, entry.menuEntryId),
      sectionId: commerceCanonicalResourceId(merchantId, entry.sectionId),
      revision: entry.revision,
      offerId: commerceCanonicalResourceId(merchantId, entry.offerId),
      offerRevision: entry.offerRevision,
      consumptionPlanId: commerceCanonicalResourceId(
        merchantId,
        entry.consumptionPlanId,
      ),
      consumptionPlanRevision: entry.consumptionPlanRevision,
      modifierGroupRevisions,
      lifecycle: entry.lifecycle,
    });
  }
  return normalized;
}

function normalizeMenuScope(scope: MenuScope, merchantId: string): MenuScope {
  switch (scope.kind) {
    case "location":
      return {
        kind: "location",
        locationId: commerceCanonicalResourceId(merchantId, scope.locationId),
      };
    case "location_group": {
      const locationIds: string[] = [];
      for (const locationId of scope.locationIds) {
        locationIds.push(commerceCanonicalResourceId(merchantId, locationId));
      }
      return { kind: "location_group", locationIds };
    }
  }
}

function normalizeModifierGroupRevisionProjection(
  resource: CommerceModifierGroupRevisionV1,
  provenance: SourceProvenance,
  merchantId: string,
): ModifierGroupRevisionProjection {
  return {
    kind: "modifier_group_revision",
    projection: {
      provenance,
      modifierGroupId: commerceCanonicalResourceId(
        merchantId,
        resource.modifierGroupId,
      ),
      revision: resource.revision,
      name: resource.name,
      minimumSelections: resource.minimumSelections,
      maximumSelections: resource.maximumSelections,
      options: normalizeModifierOptions(resource.options, merchantId),
      lifecycle: resource.lifecycle,
    },
  };
}

function normalizeModifierOptions(
  options: readonly ModifierOption[],
  merchantId: string,
): ModifierGroupRevision["options"] {
  const normalized: ModifierGroupRevision["options"] = [];
  for (const option of options) {
    normalized.push({
      modifierOptionId: commerceCanonicalResourceId(
        merchantId,
        option.modifierOptionId,
      ),
      name: option.name,
      priceDelta: option.priceDelta,
      requirementAdjustments: normalizeRequirementAdjustments(
        option.requirementAdjustments,
        merchantId,
      ),
    });
  }
  return normalized;
}

function normalizeRecipeRevisionProjection(
  resource: CommerceRecipeRevisionV1,
  provenance: SourceProvenance,
  merchantId: string,
): RecipeRevisionProjection {
  return {
    kind: "recipe_revision",
    projection: {
      provenance,
      recipeId: commerceCanonicalResourceId(merchantId, resource.recipeId),
      revision: resource.revision,
      name: resource.name,
      inputs: normalizeInventoryRequirements(resource.inputs, merchantId),
      output: normalizeRecipeOutput(resource.output, merchantId),
      lifecycle: resource.lifecycle,
    },
  };
}

function normalizeInventoryRequirements(
  requirements: readonly InventoryRequirement[],
  merchantId: string,
): InventoryRequirement[] {
  const normalized: InventoryRequirement[] = [];
  for (const requirement of requirements) {
    normalized.push(normalizeInventoryRequirement(requirement, merchantId));
  }
  return normalized;
}

function normalizeInventoryRequirement(
  requirement: InventoryRequirement,
  merchantId: string,
): InventoryRequirement {
  return {
    inventoryItemId: commerceCanonicalResourceId(
      merchantId,
      requirement.inventoryItemId,
    ),
    quantity: commerceQuantity(requirement.quantity),
  };
}

function normalizeRequirementAdjustments(
  adjustments: readonly InventoryRequirementAdjustment[],
  merchantId: string,
): InventoryRequirementAdjustment[] {
  const normalized: InventoryRequirementAdjustment[] = [];
  for (const adjustment of adjustments) {
    normalized.push({
      kind: adjustment.kind,
      inventoryItemId: commerceCanonicalResourceId(
        merchantId,
        adjustment.inventoryItemId,
      ),
      quantity: commerceQuantity(adjustment.quantity),
    });
  }
  return normalized;
}

function normalizeRecipeOutput(
  output: RecipeOutput,
  merchantId: string,
): RecipeOutput {
  switch (output.kind) {
    case "immediate":
      return { kind: "immediate" };
    case "stocked":
      return {
        kind: "stocked",
        inventoryItemId: commerceCanonicalResourceId(
          merchantId,
          output.inventoryItemId,
        ),
        yieldQuantity: commerceQuantity(output.yieldQuantity),
      };
  }
}

function normalizePreparationStationProjection(
  resource: CommercePreparationStationV1,
  provenance: SourceProvenance,
  merchantId: string,
): PreparationStationProjection {
  return {
    kind: "preparation_station",
    projection: {
      provenance,
      stationId: commerceCanonicalResourceId(merchantId, resource.stationId),
      locationId: commerceCanonicalResourceId(
        merchantId,
        resource.locationId,
      ),
      revision: resource.revision,
      name: resource.name,
      lifecycle: resource.lifecycle,
    },
  };
}

function normalizePreparationTicketProjection(
  resource: CommercePreparationTicketV1,
  provenance: SourceProvenance,
  merchantId: string,
): PreparationTicketProjection {
  return {
    kind: "preparation_ticket",
    projection: {
      provenance,
      ticketId: commerceCanonicalResourceId(merchantId, resource.ticketId),
      orderId: commerceCanonicalResourceId(merchantId, resource.orderId),
      fulfillmentId: commerceCanonicalResourceId(
        merchantId,
        resource.fulfillmentId,
      ),
      locationId: commerceCanonicalResourceId(
        merchantId,
        resource.locationId,
      ),
      stationId: commerceCanonicalResourceId(merchantId, resource.stationId),
      revision: resource.revision,
      lineSnapshots: normalizeTicketLineSnapshots(
        resource.lineSnapshots,
        merchantId,
      ),
      lifecycle: normalizePreparationTicketLifecycle(
        resource.lifecycle,
        merchantId,
      ),
    },
  };
}

function normalizeTicketLineSnapshots(
  lineSnapshots: readonly PreparationTicket["lineSnapshots"][number][],
  merchantId: string,
): PreparationTicket["lineSnapshots"] {
  const normalized: PreparationTicket["lineSnapshots"] = [];
  for (const line of lineSnapshots) {
    const modifiers: ModifierSelectionSnapshot[] = [];
    for (const modifier of line.modifiers) {
      modifiers.push({
        modifierGroupId: commerceCanonicalResourceId(
          merchantId,
          modifier.modifierGroupId,
        ),
        modifierGroupRevision: modifier.modifierGroupRevision,
        modifierOptionId: commerceCanonicalResourceId(
          merchantId,
          modifier.modifierOptionId,
        ),
        name: modifier.name,
        priceDelta: modifier.priceDelta,
        requirementAdjustments: normalizeRequirementAdjustments(
          modifier.requirementAdjustments,
          merchantId,
        ),
      });
    }
    normalized.push({
      orderLineId: commerceCanonicalResourceId(merchantId, line.orderLineId),
      menuEntryId: commerceCanonicalResourceId(merchantId, line.menuEntryId),
      menuEntryRevision: line.menuEntryRevision,
      recipeId: commerceCanonicalResourceId(merchantId, line.recipeId),
      recipeRevision: line.recipeRevision,
      modifiers,
      requirements: normalizeInventoryRequirements(
        line.requirements,
        merchantId,
      ),
    });
  }
  return normalized;
}

function normalizePreparationTicketLifecycle(
  lifecycle: PreparationTicketLifecycle,
  merchantId: string,
): PreparationTicketLifecycle {
  switch (lifecycle.state) {
    case "queued":
      return { state: "queued", queuedAt: lifecycle.queuedAt };
    case "preparing":
      return { state: "preparing", startedAt: lifecycle.startedAt };
    case "completed": {
      const movementIds: string[] = [];
      for (const movementId of lifecycle.movementIds) {
        movementIds.push(commerceCanonicalResourceId(merchantId, movementId));
      }
      return {
        state: "completed",
        completedAt: lifecycle.completedAt,
        movementIds,
      };
    }
    case "cancelled":
      return { state: "cancelled", cancelledAt: lifecycle.cancelledAt };
  }
}

function normalizeProductionBatchProjection(
  resource: CommerceProductionBatchV1,
  provenance: SourceProvenance,
  merchantId: string,
): ProductionBatchProjection {
  const inputMovementIds: string[] = [];
  for (const movementId of resource.inputMovementIds) {
    inputMovementIds.push(
      commerceCanonicalResourceId(merchantId, movementId),
    );
  }
  return {
    kind: "production_batch",
    projection: {
      provenance,
      productionBatchId: commerceCanonicalResourceId(
        merchantId,
        resource.productionBatchId,
      ),
      demand: normalizeProductionBatchDemand(resource.demand, merchantId),
      recipeId: commerceCanonicalResourceId(merchantId, resource.recipeId),
      recipeRevision: resource.recipeRevision,
      locationId: commerceCanonicalResourceId(
        merchantId,
        resource.locationId,
      ),
      stationId: commerceCanonicalResourceId(merchantId, resource.stationId),
      revision: resource.revision,
      plannedYield: commerceQuantity(resource.plannedYield),
      actualYield: commerceQuantity(resource.actualYield),
      completedAt: resource.completedAt,
      inputMovementIds,
      outputMovementId: commerceCanonicalResourceId(
        merchantId,
        resource.outputMovementId,
      ),
      outputLotId: commerceCanonicalResourceId(
        merchantId,
        resource.outputLotId,
      ),
    },
  };
}

function normalizeProductionBatchDemand(
  demand: ProductionBatchDemand,
  merchantId: string,
): ProductionBatchDemand {
  switch (demand.kind) {
    case "request": return { kind: "request", requestId: demand.requestId, requestRevision: demand.requestRevision };
    case "stock":
      return { kind: "stock" };
    case "shipment":
      return {
        kind: "shipment",
        shipmentId: parseShipmentEntityId(
          commerceCanonicalResourceId(merchantId, demand.shipmentId),
          "productionBatch.demand.shipmentId",
        ),
      };
  }
}

function normalizeStockPolicyProjection(
  resource: CommerceStockPolicyV1,
  provenance: SourceProvenance,
  merchantId: string,
): StockPolicyProjection {
  return {
    kind: "stock_policy",
    projection: {
      provenance,
      stockPolicyId: commerceCanonicalResourceId(
        merchantId,
        resource.stockPolicyId,
      ),
      inventoryItemId: commerceCanonicalResourceId(
        merchantId,
        resource.inventoryItemId,
      ),
      locationId: commerceCanonicalResourceId(
        merchantId,
        resource.locationId,
      ),
      revision: resource.revision,
      replenishment: normalizeReplenishment(resource.replenishment),
      lifecycle: resource.lifecycle,
    },
  };
}

function normalizeReplenishment(
  replenishment: InventoryReplenishmentPolicy,
): InventoryReplenishmentPolicy {
  switch (replenishment.kind) {
    case "none":
      return { kind: "none" };
    case "threshold":
      return {
        kind: "threshold",
        reorderPoint: commerceQuantity(replenishment.reorderPoint),
        targetQuantity: commerceQuantity(replenishment.targetQuantity),
      };
  }
}

function normalizeOrderProjection(
  resource: CommerceOrderV1,
  provenance: SourceProvenance,
  merchantId: string,
): CommerceProjection {
  return {
    kind: "commerce_order",
    projection: {
      provenance,
      origin: normalizeOrderOrigin(resource.origin, merchantId),
      buyer: resource.buyer,
      lineItems: resource.lineItems.map((lineItem) => ({
        lineItemId: commerceCanonicalResourceId(merchantId, lineItem.id),
        source: normalizeOrderLineSource(lineItem.source, merchantId),
        sku: lineItem.sku,
        title: lineItem.title,
        quantity: normalizeQuantity(lineItem.quantity),
        fulfilledQuantity: normalizeQuantity(lineItem.fulfilledQuantity),
        unitPrice: lineItem.unitPrice,
        tax: lineItem.tax,
        discount: lineItem.discount,
        lineTotal: lineItem.lineTotal,
      })),
      totals: resource.totals,
      adjustments: resource.adjustments.map((adjustment) => ({
        adjustmentId: commerceCanonicalResourceId(merchantId, adjustment.id),
        kind: adjustment.kind,
        status: adjustment.status,
        occurredAt: adjustment.occurredAt,
        amount: adjustment.amount,
        reason: adjustment.reason,
      })),
      lifecycle: normalizeOrderLifecycle(resource.lifecycle, merchantId),
    },
  };
}

function normalizeOrderOrigin(
  origin: CommerceOrderV1["origin"],
  merchantId: string,
): CommerceOrderV1["origin"] {
  switch (origin.kind) {
    case "online":
      return {
        ...origin,
        salesChannelId: commerceCanonicalResourceId(
          merchantId,
          origin.salesChannelId,
        ),
        checkoutId: commerceCanonicalResourceId(
          merchantId,
          origin.checkoutId,
        ),
      };
    case "point_of_sale":
      return {
        ...origin,
        salesChannelId: commerceCanonicalResourceId(
          merchantId,
          origin.salesChannelId,
        ),
        locationId: commerceCanonicalResourceId(
          merchantId,
          origin.locationId,
        ),
      };
    case "marketplace":
      return {
        ...origin,
        salesChannelId: commerceCanonicalResourceId(
          merchantId,
          origin.salesChannelId,
        ),
      };
    case "agent":
      return {
        ...origin,
        salesChannelId: commerceCanonicalResourceId(
          merchantId,
          origin.salesChannelId,
        ),
      };
  }
}

function normalizeOrderLineSource(
  source: CommerceOrderV1["lineItems"][number]["source"],
  merchantId: string,
): OrderLineSource {
  switch (source.kind) {
    case "catalog":
      return {
        kind: "catalog",
        variantId: commerceCanonicalResourceId(merchantId, source.variantId),
        variantRevision: source.variantRevision,
        merchantCode: source.merchantCode,
        optionValues: [...source.optionValues],
        offerId: commerceCanonicalResourceId(merchantId, source.offerId),
        offerRevision: source.offerRevision,
        consumptionPlanId: commerceCanonicalResourceId(
          merchantId,
          source.consumptionPlanId,
        ),
        consumptionPlanRevision: source.consumptionPlanRevision,
        inventory: normalizeOrderLineInventory(source.inventory, merchantId),
      };
    case "food_service":
      return {
        kind: "food_service",
        variantId: commerceCanonicalResourceId(merchantId, source.variantId),
        variantRevision: source.variantRevision,
        merchantCode: source.merchantCode,
        optionValues: [...source.optionValues],
        menuId: commerceCanonicalResourceId(merchantId, source.menuId),
        menuRevision: source.menuRevision,
        menuEntryId: commerceCanonicalResourceId(
          merchantId,
          source.menuEntryId,
        ),
        menuEntryRevision: source.menuEntryRevision,
        offerId: commerceCanonicalResourceId(merchantId, source.offerId),
        offerRevision: source.offerRevision,
        consumptionPlanId: commerceCanonicalResourceId(
          merchantId,
          source.consumptionPlanId,
        ),
        consumptionPlanRevision: source.consumptionPlanRevision,
        preparation: normalizeFoodServicePreparation(
          source.preparation,
          merchantId,
        ),
        modifiers: normalizeModifierSnapshots(source.modifiers, merchantId),
        inventory: normalizeOrderLineInventory(source.inventory, merchantId),
      };
    case "source_only":
      return {
        kind: "source_only",
        sourceItemReference: source.sourceItemReference,
      };
  }
}

function normalizeFoodServicePreparation(
  preparation: FoodServicePreparation,
  merchantId: string,
): FoodServicePreparation {
  switch (preparation.kind) {
    case "immediate_recipe":
      return {
        kind: "immediate_recipe",
        recipeId: commerceCanonicalResourceId(
          merchantId,
          preparation.recipeId,
        ),
        recipeRevision: preparation.recipeRevision,
      };
    case "stocked_inventory":
      return { kind: "stocked_inventory" };
  }
}

function normalizeOrderLineInventory(
  inventory: OrderLineInventory,
  merchantId: string,
): OrderLineInventory {
  switch (inventory.kind) {
    case "untracked":
      return { kind: "untracked" };
    case "requirements":
      return {
        kind: "requirements",
        items: normalizeInventoryRequirements(inventory.items, merchantId),
      };
  }
}

function normalizeModifierSnapshots(
  modifiers: readonly ModifierSelectionSnapshot[],
  merchantId: string,
): ModifierSelectionSnapshot[] {
  const normalized: ModifierSelectionSnapshot[] = [];
  for (const modifier of modifiers) {
    normalized.push({
      modifierGroupId: commerceCanonicalResourceId(
        merchantId,
        modifier.modifierGroupId,
      ),
      modifierGroupRevision: modifier.modifierGroupRevision,
      modifierOptionId: commerceCanonicalResourceId(
        merchantId,
        modifier.modifierOptionId,
      ),
      name: modifier.name,
      priceDelta: modifier.priceDelta,
      requirementAdjustments: normalizeRequirementAdjustments(
        modifier.requirementAdjustments,
        merchantId,
      ),
    });
  }
  return normalized;
}

function normalizeQuantity(
  quantity: CommerceOrderV1["lineItems"][number]["quantity"],
): {
  amount: number;
  scale: number;
  unit: CommerceOrderV1["lineItems"][number]["quantity"]["unit"];
} {
  return {
    amount: quantity.amount,
    scale: quantity.scale,
    unit: quantity.unit,
  };
}

function normalizeOrderLifecycle(
  lifecycle: CommerceOrderV1["lifecycle"],
  merchantId: string,
): OrderLifecycle {
  if (lifecycle.state === "partially_fulfilled") {
    return {
      state: lifecycle.state,
      since: lifecycle.since,
      fulfilledLineItemIds: lifecycle.fulfilledLineItemIds.map((id) =>
        commerceCanonicalResourceId(merchantId, id),
      ),
    };
  }
  return lifecycle;
}

function normalizePaymentProjection(
  resource: CommercePaymentV1,
  provenance: SourceProvenance,
  merchantId: string,
): CommerceProjection {
  return {
    kind: "payment",
    projection: {
      provenance,
      orderId: commerceCanonicalResourceId(merchantId, resource.orderId),
      amount: resource.amount,
      lifecycle: resource.lifecycle,
    },
  };
}

function normalizeFulfillmentProjection(
  resource: CommerceFulfillmentV1,
  provenance: SourceProvenance,
  merchantId: string,
): CommerceProjection {
  const base = {
    provenance,
    orderId: commerceCanonicalResourceId(merchantId, resource.orderId),
    lineItems: resource.lineItems.map((lineItem) => ({
      lineItemId: commerceCanonicalResourceId(
        merchantId,
        lineItem.lineItemId,
      ),
      quantity: lineItem.quantity,
    })),
    locationId: commerceCanonicalResourceId(merchantId, resource.locationId),
    expectedBy: resource.expectedBy,
  };
  switch (resource.kind) {
    case "shipping":
      return {
        kind: "fulfillment",
        projection: {
          ...base,
          kind: resource.kind,
          binding: normalizeShippingFulfillmentBinding(
            resource.binding,
            merchantId,
          ),
          lifecycle:
            resource.lifecycle.state === "handed_to_carrier"
              ? {
                  ...resource.lifecycle,
                  shipmentId: commerceCanonicalResourceId(
                    merchantId,
                    resource.lifecycle.shipmentId,
                  ),
                }
              : resource.lifecycle,
        },
      };
    case "pickup":
      return {
        kind: "fulfillment",
        projection: {
          ...base,
          kind: resource.kind,
          lifecycle: resource.lifecycle,
        },
      };
    case "local_delivery":
      return {
        kind: "fulfillment",
        projection: {
          ...base,
          kind: resource.kind,
          lifecycle: resource.lifecycle,
        },
      };
    case "immediate_handoff":
      return {
        kind: "fulfillment",
        projection: {
          ...base,
          kind: resource.kind,
          lifecycle: resource.lifecycle,
        },
      };
    case "on_premise":
      return {
        kind: "fulfillment",
        projection: {
          ...base,
          kind: resource.kind,
          lifecycle: resource.lifecycle,
        },
      };
  }
}

function normalizeShippingFulfillmentBinding(
  binding: ShippingFulfillmentBinding,
  merchantId: string,
): ShippingFulfillmentBinding {
  switch (binding.kind) {
    case "external":
      return { kind: binding.kind, sourceReference: binding.sourceReference };
    case "first_party_checkout":
      return {
        kind: binding.kind,
        protectedAddressReference: commerceCanonicalResourceId(
          merchantId,
          binding.protectedAddressReference,
        ),
        acceptedShippingQuote: normalizeShippingQuoteSnapshot(
          binding.acceptedShippingQuote,
          merchantId,
        ),
      };
  }
}

function normalizeShippingQuoteSnapshot(
  quote: ShippingQuoteSnapshot,
  merchantId: string,
): ShippingQuoteSnapshot {
  return {
    shippingQuoteId: commerceCanonicalResourceId(
      merchantId,
      quote.shippingQuoteId,
    ),
    routeBinding: normalizeShippingRouteBinding(quote.routeBinding, merchantId),
    carrierRate: quote.carrierRate,
    taxQuote: quote.taxQuote,
    dutyQuote: quote.dutyQuote,
    itemSubtotal: quote.itemSubtotal,
    total: quote.total,
    estimatedDelivery: quote.estimatedDelivery,
    address: {
      protectedAddressReference: commerceCanonicalResourceId(
        merchantId,
        quote.address.protectedAddressReference,
      ),
      destinationCountry: quote.address.destinationCountry,
      addressValidationReference: quote.address.addressValidationReference,
      addressDigest: quote.address.addressDigest,
    },
    packagePlan: {
      packagePlanDigest: quote.packagePlan.packagePlanDigest,
      package: {
        packageId: commerceCanonicalResourceId(
          merchantId,
          quote.packagePlan.package.packageId,
        ),
        weight: quote.packagePlan.package.weight,
        dimensions: quote.packagePlan.package.dimensions,
        lineQuantities: quote.packagePlan.package.lineQuantities.map(
          (line) => ({
            checkoutLineId: commerceCanonicalResourceId(
              merchantId,
              line.checkoutLineId,
            ),
            quantity: line.quantity,
          }),
        ),
        customsLines: quote.packagePlan.package.customsLines.map((line) => ({
          checkoutLineId: commerceCanonicalResourceId(
            merchantId,
            line.checkoutLineId,
          ),
          description: line.description,
          quantity: line.quantity,
          weight: line.weight,
          declaredValue: line.declaredValue,
          countryOfOrigin: line.countryOfOrigin,
          hsCode: line.hsCode,
        })),
      },
    },
    inputDigest: quote.inputDigest,
    quotedAt: quote.quotedAt,
    expiresAt: quote.expiresAt,
  };
}

function normalizeShippingRouteBinding(
  route: ShippingQuoteSnapshot["routeBinding"],
  merchantId: string,
): ShippingQuoteSnapshot["routeBinding"] {
  switch (route.kind) {
    case "domestic_japan":
      return {
        kind: route.kind,
        routeId: commerceCanonicalResourceId(merchantId, route.routeId),
        zoneId: commerceCanonicalResourceId(merchantId, route.zoneId),
        carrierRateCapabilityId: route.carrierRateCapabilityId,
        serviceCodes: route.serviceCodes,
      };
    case "japan_to_singapore":
      return {
        kind: route.kind,
        routeId: commerceCanonicalResourceId(merchantId, route.routeId),
        zoneId: commerceCanonicalResourceId(merchantId, route.zoneId),
        carrierRateCapabilityId: route.carrierRateCapabilityId,
        serviceCodes: route.serviceCodes,
        dutyCapabilityId: route.dutyCapabilityId,
        incoterm: route.incoterm,
      };
    case "international":
      return {
        kind: route.kind,
        routeId: commerceCanonicalResourceId(merchantId, route.routeId),
        zoneId: commerceCanonicalResourceId(merchantId, route.zoneId),
        carrierRateCapabilityId: route.carrierRateCapabilityId,
        serviceCodes: route.serviceCodes,
        destinationCountries: route.destinationCountries,
        dutyCapabilityId: route.dutyCapabilityId,
        incoterm: route.incoterm,
      };
  }
}

function normalizeShipmentProjection(
  resource: CommerceShipmentV1,
  provenance: SourceProvenance,
  merchantId: string,
): CommerceProjection {
  const common = {
    provenance,
    orderId: commerceCanonicalResourceId(merchantId, resource.orderId),
    fulfillmentId: commerceCanonicalResourceId(
      merchantId,
      resource.fulfillmentId,
    ),
    events: resource.events.map((event) => ({
      eventId: commerceCanonicalResourceId(merchantId, event.id),
      occurredAt: event.occurredAt,
      kind: event.kind,
      location: event.location,
    })),
  };
  switch (resource.kind) {
    case "first_party":
      return {
        kind: "shipment",
        projection: {
          ...common,
          kind: resource.kind,
          package: normalizeShipmentPackage(resource.package, merchantId),
          lifecycle: normalizeFirstPartyShipmentLifecycle(
            resource.lifecycle,
            merchantId,
          ),
        },
      };
    case "external":
      return {
        kind: "shipment",
        projection: {
          ...common,
          kind: resource.kind,
          carrier: resource.carrier,
          trackingNumber: resource.trackingNumber,
          estimatedDeliveryAt: resource.estimatedDeliveryAt,
          lifecycle: resource.lifecycle,
        },
      };
  }
}

function normalizeShipmentPackage(
  package_: ShipmentPackage,
  merchantId: string,
): ShipmentPackage {
  return {
    packageId: commerceCanonicalResourceId(merchantId, package_.packageId),
    weight: package_.weight,
    dimensions: package_.dimensions,
    lineQuantities: package_.lineQuantities.map((line) => ({
      orderLineId: commerceCanonicalResourceId(merchantId, line.orderLineId),
      quantity: line.quantity,
    })),
    customsLines: package_.customsLines.map((line) => ({
      orderLineId: commerceCanonicalResourceId(merchantId, line.orderLineId),
      description: line.description,
      quantity: line.quantity,
      weight: line.weight,
      declaredValue: line.declaredValue,
      countryOfOrigin: line.countryOfOrigin,
      hsCode: line.hsCode,
    })),
  };
}

function normalizeFirstPartyShipmentLifecycle(
  lifecycle: CommerceFirstPartyShipmentV1["lifecycle"],
  merchantId: string,
): FirstPartyShipmentLifecycle {
  switch (lifecycle.state) {
    case "ready":
      return {
        state: "ready",
        readyAt: lifecycle.readyAt,
      };
    case "label_purchased":
      return {
        state: "label_purchased",
        labelAttemptId: commerceCanonicalResourceId(
          merchantId,
          lifecycle.labelAttemptId,
        ),
        trackingNumber: lifecycle.trackingNumber,
        purchasedAt: lifecycle.purchasedAt,
      };
    case "in_transit":
      return {
        state: "in_transit",
        labelAttemptId: commerceCanonicalResourceId(
          merchantId,
          lifecycle.labelAttemptId,
        ),
        trackingNumber: lifecycle.trackingNumber,
        handedOverAt: lifecycle.handedOverAt,
      };
    case "delivered":
      return {
        state: "delivered",
        labelAttemptId: commerceCanonicalResourceId(
          merchantId,
          lifecycle.labelAttemptId,
        ),
        trackingNumber: lifecycle.trackingNumber,
        handedOverAt: lifecycle.handedOverAt,
        deliveredAt: lifecycle.deliveredAt,
      };
  }
}

function commerceProvenance(
  input: Readonly<{
    observation: CommerceAggregateObservationV1;
    merchantId: string;
    organisationId: string;
    integrationAccountId: string;
    observedAt: string;
  }>,
): SourceProvenance {
  const occurredAt = observationOccurredAt(input.observation);
  return {
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    source: "underclerk",
    resourceType: input.observation.kind,
    resourceId: commerceCanonicalResourceId(
      input.merchantId,
      observationResourceId(input.observation),
    ),
    revision: observationRevision(input.observation),
    occurredAt,
    observedAt: laterTimestamp(input.observedAt, occurredAt),
  };
}

function observationResourceId(
  observation: CommerceAggregateObservationV1,
): string {
  switch (observation.kind) {
    case "location":
    case "sales_channel":
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "commerce_order":
    case "payment":
    case "fulfillment":
    case "shipment":
      return observation.resource.id;
    case "menu":
      return observation.resource.menuId;
    case "modifier_group_revision":
      return observation.resource.modifierGroupId;
    case "recipe_revision":
      return observation.resource.recipeId;
    case "preparation_station":
      return observation.resource.stationId;
    case "preparation_ticket":
      return observation.resource.ticketId;
    case "production_batch":
      return observation.resource.productionBatchId;
    case "stock_policy":
      return observation.resource.stockPolicyId;
  }
}

function observationOccurredAt(
  observation: CommerceAggregateObservationV1,
): string {
  switch (observation.kind) {
    case "location":
    case "sales_channel":
    case "product":
    case "sellable_variant":
    case "inventory_item":
    case "offer":
    case "inventory_position":
    case "inventory_movement":
    case "inventory_lot":
    case "commerce_order":
    case "payment":
    case "fulfillment":
    case "shipment":
      return observation.resource.occurredAt;
    case "menu":
    case "modifier_group_revision":
    case "recipe_revision":
    case "preparation_station":
    case "preparation_ticket":
    case "production_batch":
    case "stock_policy":
      return observation.resource.provenance.occurredAt;
  }
}

function observationRevision(
  observation: CommerceAggregateObservationV1,
): number {
  return observation.kind === "inventory_movement"
    ? 1
    : observation.resource.revision;
}

function normalizeInventoryMovementChange(
  change: Variant<
    CommerceAggregateObservationV1,
    "inventory_movement"
  >["resource"]["change"],
  merchantId: string,
): Variant<CommerceProjection, "inventory_movement">["projection"]["change"] {
  switch (change.kind) {
    case "increase":
      return {
        kind: "increase",
        quantity: commerceQuantity(change.quantity),
        reason: normalizeInventoryIncreaseReason(change.reason, merchantId),
      };
    case "decrease":
      return {
        kind: "decrease",
        quantity: commerceQuantity(change.quantity),
        reason: normalizeInventoryDecreaseReason(change.reason, merchantId),
        lotAllocation:
          change.lotAllocation.kind === "not_tracked"
            ? { kind: "not_tracked" }
            : {
                kind: "allocated",
                lots: normalizeLotAllocations(
                  change.lotAllocation.lots,
                  merchantId,
                ),
              },
      };
  }
}

function normalizeLotAllocations(
  lots: readonly CommerceLotAllocationV1[],
  merchantId: string,
): Array<Readonly<{ lotId: string; quantity: Quantity }>> {
  const normalized: Array<Readonly<{ lotId: string; quantity: Quantity }>> = [];
  for (const lot of lots) {
    normalized.push({
      lotId: commerceCanonicalResourceId(merchantId, lot.lotId),
      quantity: commerceQuantity(lot.quantity),
    });
  }
  return normalized;
}

function normalizeInventoryIncreaseReason(
  reason: Variant<
    Variant<
      CommerceAggregateObservationV1,
      "inventory_movement"
    >["resource"]["change"],
    "increase"
  >["reason"],
  merchantId: string,
): Variant<
  Variant<CommerceProjection, "inventory_movement">["projection"]["change"],
  "increase"
>["reason"] {
  switch (reason.kind) {
    case "stock_count": return { kind: "stock_count", countId: commerceCanonicalResourceId(merchantId, reason.countId), explanation: reason.explanation, observedQuantity: commerceQuantity(reason.observedQuantity) };
    case "correction": return { kind: "correction", explanation: reason.explanation };
    case "receipt":
      return {
        kind: "receipt",
        purchase: reason.purchase,
        receiptId: commerceCanonicalResourceId(merchantId, reason.receiptId),
        receiptLineId: commerceCanonicalResourceId(
          merchantId,
          reason.receiptLineId,
        ),
      };
    case "production":
      return {
        kind: "production",
        productionBatchId: commerceCanonicalResourceId(
          merchantId,
          reason.productionBatchId,
        ),
        recipeRevision: reason.recipeRevision,
      };
  }
}

function normalizeInventoryDecreaseReason(
  reason: Variant<
    Variant<
      CommerceAggregateObservationV1,
      "inventory_movement"
    >["resource"]["change"],
    "decrease"
  >["reason"],
  merchantId: string,
): Variant<
  Variant<CommerceProjection, "inventory_movement">["projection"]["change"],
  "decrease"
>["reason"] {
  switch (reason.kind) {
    case "stock_count": return { kind: "stock_count", countId: commerceCanonicalResourceId(merchantId, reason.countId), explanation: reason.explanation, observedQuantity: commerceQuantity(reason.observedQuantity) };
    case "correction": case "waste": case "damage": return { kind: reason.kind, explanation: reason.explanation };
    case "sale":
      return {
        kind: "sale",
        orderId: commerceCanonicalResourceId(merchantId, reason.orderId),
        orderLineId: commerceCanonicalResourceId(
          merchantId,
          reason.orderLineId,
        ),
      };
    case "preparation":
      return {
        kind: "preparation",
        ticketId: commerceCanonicalResourceId(merchantId, reason.ticketId),
        recipeRevision: reason.recipeRevision,
      };
    case "production":
      return {
        kind: "production",
        productionBatchId: commerceCanonicalResourceId(
          merchantId,
          reason.productionBatchId,
        ),
        recipeRevision: reason.recipeRevision,
      };
  }
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function commerceQuantity(quantity: CommerceQuantityV1): Quantity {
  return {
    amount: quantity.amount,
    scale: quantity.scale,
    unit: quantity.unit,
  };
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const standard = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      standard.padEnd(Math.ceil(standard.length / 4) * 4, "="),
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
