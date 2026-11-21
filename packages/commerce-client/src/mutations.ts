import type { Variant } from "@purin-labs/type-utils";
import type { CommerceInvalidTransition } from "@purin-labs/commerce-contracts";
import type {
  CommerceQuantityUnit,
  CommerceFulfillmentV1,
  CommerceInventoryItemV1,
  CommerceInventoryLotV1,
  CommerceInventoryMovementV1,
  CommerceInventoryPositionV1,
  CommerceLocationV1,
  CommerceOfferV1,
  CommerceOrderV1,
  CommercePaymentV1,
  CommerceProductV1,
  CommerceSalesChannelV1,
  CommerceShipmentV1,
  CommerceEngineTimestamp,
  CommerceVariantV1,
} from "./commerce-resources.ts";
import type {
  CommerceEntityPlaneObservationV1,
} from "./entity-plane/parsers.ts";
import type { CommerceFoodServiceObservationV1 } from "./food-service.ts";
import {
  requireObject,
} from "./wire-readers.ts";
import {
  parseAcknowledgeCommerceDeliveryV1 as parseAcknowledgeCommerceDeliveryV1Record,
  parseCommerceDeliveryV1 as parseCommerceDeliveryV1Record,
  parseCommerceDeliveryAcknowledgementV1 as parseCommerceDeliveryAcknowledgementV1Record,
  parseCommerceMutationErrorV1 as parseCommerceMutationErrorV1Record,
  parseCommerceMutationReceiptV1 as parseCommerceMutationReceiptV1Record,
  parseCommerceMutationResultV1 as parseCommerceMutationResultV1Record,
} from "@purin-labs/commerce-contracts/records/api-mutations";
import { decodeRecord } from "./entity-plane/record-decoding.ts";
import type * as contracts from "@purin-labs/commerce-contracts/records/api-mutations";

/** Who sent the request of a receipt (Plan 80 step 3). */
export type CommerceMutationActorV1 = contracts.CommerceMutationActorV1;

export type CommerceMutationPrincipalV1 = Readonly<{
  kind: "plugin";
  pluginId: string;
  version: number;
  /** The handler or action that returned the command. */
  source: "handler" | "action";
  sourceId: string;
}>;

/**
 * A signed receipt: version 2 (Plan 80 step 2), or version 1, which also
 * named the owner and an action nonce, as it was signed.
 */
export type CommerceMutationReceiptV1 = contracts.CommerceMutationReceiptV1;

/** Why a product stays: its history or an open record still needs it. */
export type ProductDeleteRefusal =
  | "sold"
  | "on_menu"
  | "open_checkout"
  | "reserved_stock"
  | "draft_order"
  | "price_list"
  | "discount"
  | "linked_record";

export type CommerceMutationErrorV1 =
  | Readonly<{ code: "unsupported_version"; received: string }>
  | Readonly<{ code: "invalid_command"; field: string }>
  | Readonly<{ code: "merchant_not_found"; merchantId: string }>
  | Readonly<{
      code: "merchant_mismatch";
      merchantId: string;
      organisationId: string;
    }>
  | Readonly<{
      code: "stale_merchant_revision";
      expected: number;
      actual: number;
    }>
  | Readonly<{
      code: "stale_resource_revision";
      kind: string;
      id: string;
      expected: number;
      actual: number;
    }>
  | Readonly<{
      code: "resource_revision_not_advanced";
      kind: string;
      id: string;
      current: number;
      received: number;
    }>
  | Readonly<{ code: "resource_not_found"; kind: string; id: string }>
  | Readonly<{ code: "resource_relationship_invalid"; field: string }>
  | Readonly<{ code: "inventory_count_shortage"; inventoryPositionId: string; observedAmount: number; reservedAmount: number; scale: number; unit: CommerceQuantityUnit }>
  | Readonly<{ code: "resource_already_exists"; kind: string; id: string }>
  | Readonly<{ code: "offer_not_prepared"; offerId: string; state: string }>
  | Readonly<{
      code: "inventory_receipt_already_applied";
      receiptId: string;
      receiptLineId: string;
      movementId: string;
    }>
  | Readonly<{
      code: "insufficient_inventory";
      inventoryItemId: string;
      locationId: string;
      requestedAmount: number;
      availableAmount: number;
    }>
  | Readonly<{ code: "checkout_quote_mismatch"; checkoutId: string }>
  | Readonly<{ code: "checkout_refresh_required"; checkoutId: string }>
  | Readonly<{
      /** A merchant plugin's checkout rule refused the checkout. */
      code: "checkout_refused";
      pluginId: string;
      /** The plugin's message for the buyer. */
      message: string;
    }>
  | Readonly<{
      /** A merchant plugin's action refused to run, with its reason. */
      code: "action_refused";
      pluginId: string;
      actionId: string;
      message: string;
    }>
  | Readonly<{
      code: "product_delete_refused";
      productId: string;
      reason: ProductDeleteRefusal;
    }>
  | Readonly<{
      /** A merchant plugin's guard refused a move of a record's state. */
      code: "transition_refused";
      pluginId: string;
      machine: string;
      event: string;
      /** The plugin's message for staff. */
      message: string;
    }>
  | Readonly<{
      code: "checkout_quote_expired";
      checkoutId: string;
      expiresAt: CommerceEngineTimestamp;
    }>
  | Readonly<{ code: "idempotency_conflict"; idempotencyKey: string }>
  | CommerceInvalidTransition;

export type CommerceMutationResultV1 =
  | Readonly<{ outcome: "applied"; receipt: CommerceMutationReceiptV1 }>
  | Readonly<{ outcome: "replayed"; receipt: CommerceMutationReceiptV1 }>
  | Readonly<{ outcome: "rejected"; error: CommerceMutationErrorV1 }>;

export type CommerceAggregateObservationV1 =
  | Readonly<{ kind: "location"; resource: CommerceLocationV1 }>
  | Readonly<{ kind: "sales_channel"; resource: CommerceSalesChannelV1 }>
  | Readonly<{ kind: "product"; resource: CommerceProductV1 }>
  | Readonly<{ kind: "sellable_variant"; resource: CommerceVariantV1 }>
  | Readonly<{ kind: "inventory_item"; resource: CommerceInventoryItemV1 }>
  | Readonly<{ kind: "offer"; resource: CommerceOfferV1 }>
  | Readonly<{
      kind: "inventory_position";
      resource: CommerceInventoryPositionV1;
    }>
  | Readonly<{
      kind: "inventory_movement";
      resource: CommerceInventoryMovementV1;
    }>
  | Readonly<{ kind: "inventory_lot"; resource: CommerceInventoryLotV1 }>
  | Readonly<{ kind: "commerce_order"; resource: CommerceOrderV1 }>
  | Readonly<{ kind: "payment"; resource: CommercePaymentV1 }>
  | Readonly<{ kind: "fulfillment"; resource: CommerceFulfillmentV1 }>
  | Readonly<{ kind: "shipment"; resource: CommerceShipmentV1 }>
  | CommerceFoodServiceObservationV1;

export type CommerceObservationV1 =
  CommerceAggregateObservationV1 | CommerceEntityPlaneObservationV1;

/**
 * A signed delivery: version 2 (Plan 80 step 2), or version 1, which also
 * named the owner, as it was signed.
 */
export type CommerceDeliveryV1 =
  contracts.CommerceDeliveryV1;

/**
 * A delivery read from Commerce. `signedObservations` keeps the observations
 * exactly as Commerce signed them: the parsed observations can hold defaults
 * that an older Commerce never sent, so they cannot reproduce the signature.
 */
export type CommerceReceivedDeliveryV1 = CommerceDeliveryV1 &
  Readonly<{ signedObservations: readonly unknown[] }>;

export type AcknowledgeCommerceDeliveryV1 = Readonly<{
  schemaVersion: "commerce.acknowledge-commerce-delivery.v2";
  merchantId: string;
  deliveryId: string;
  acknowledgedAt: CommerceEngineTimestamp;
  /**
   * Absent: the delivery applied downstream. Present: the consumer determined
   * it can never apply, and the delivery is retired from the pending set with
   * this reason instead of resurfacing forever.
   */
  rejection?: Readonly<{ reason: string }>;
}>;

export type CommerceDeliveryAcknowledgementV1 = Readonly<{
  schemaVersion: "commerce.delivery-acknowledgement.v2";
  outcome:
    "acknowledged" | "already_acknowledged" | "rejected" | "already_rejected";
  merchantId: string;
  deliveryId: string;
  acknowledgedAt: CommerceEngineTimestamp;
}>;

export type CommerceClientError =
  | Readonly<{ kind: "network"; message: string }>
  | Readonly<{
      kind: "rejected";
      status: 409;
      error: CommerceMutationErrorV1;
      message: string;
    }>
  | Readonly<{ kind: "http"; status: number; message: string }>
  | Readonly<{ kind: "invalid_response"; message: string }>;

export type CommerceClientResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: CommerceClientError }>;

export type CommerceMigrationInventoryV2 = Readonly<{
  schemaVersion: "commerce.migration-inventory.v2";
  organisationId: string;
  merchantId: string;
  merchantRevision: number;
  storageSchemaVersion: number;
  contractRevisions: Readonly<{
    source: string;
    target: "pantry.commerce.inventory.v1";
  }>;
  migrationDigest: string;
  candidateClassification: "migrate" | "reject";
  classificationCounts: Readonly<{
    migrate: number;
    reset: number;
    reject: number;
  }>;
  resources: Readonly<{
    locations: number;
    salesChannels: number;
    products: number;
    variants: number;
    inventoryItems: number;
    offers: number;
    inventoryPositions: number;
    orders: number;
    payments: number;
    fulfillments: number;
    shipments: number;
  }>;
  foodService: Readonly<{
    resourceSnapshots: number;
  }>;
  inventoryLedger: Readonly<{
    lots: number;
    movements: number;
    receiptIdentities: number;
    receiptIdentityDigest: string;
  }>;
  unresolvedMappings: Readonly<{
    inventoryItemCategories: number;
    inventoryItemTrackingPolicies: number;
    inventoryItemBaseUnits: number;
    inventoryPositionBalances: number;
    receiptIds: number;
  }>;
  invariantFailures: readonly Readonly<{ code: string; count: number }>[];
  operations: Readonly<{
    commandReceipts: number;
    pendingCommands: number;
    mutationLeases: number;
    pendingReceipts: number;
    pendingCommerceDeliveries: number;
    deliveredCommerceDeliveries: number;
  }>;
}>;

export type CommerceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function parseMutationResult(value: unknown): CommerceMutationResultV1 {
  return decodeRecord(parseCommerceMutationResultV1Record, value);
}

export function parseCommerceDelivery(value: unknown): CommerceDeliveryV1 {
  return decodeRecord(parseCommerceDeliveryV1Record, value);
}

export function parseAcknowledgeDeliveryCommand(value: unknown): AcknowledgeCommerceDeliveryV1 {
  return decodeRecord(parseAcknowledgeCommerceDeliveryV1Record, value);
}

export function parseDeliveryAcknowledgement(value: unknown): CommerceDeliveryAcknowledgementV1 {
  return decodeRecord(parseCommerceDeliveryAcknowledgementV1Record, value);
}

/** A delivery of either version with observations of any form. */
type DeliveryWithObservations<TObservation> =
  CommerceDeliveryV1 extends infer Delivery
    ? Delivery extends unknown
      ? Omit<Delivery, "observations"> &
          Readonly<{ observations: readonly TObservation[] }>
      : never
    : never;

export function commerceDeliverySignaturePayload<TObservation>(
  delivery: DeliveryWithObservations<TObservation>,
): Uint8Array {
  // Version 1 also signed its owner (Plan 80 step 2).
  const payload = {
    schemaVersion: delivery.schemaVersion,
    deliveryId: delivery.deliveryId,
    ...(delivery.schemaVersion === "commerce.commerce-delivery.v1"
      ? { organisationId: delivery.organisationId }
      : {}),
    merchantId: delivery.merchantId,
    merchantRevision: delivery.merchantRevision,
    observedAt: delivery.observedAt,
    observations: delivery.observations,
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** The signed bytes of a delivery; a received delivery uses its observations as sent. */
export function commerceReceivedDeliverySignaturePayload(
  delivery: CommerceDeliveryV1 | CommerceReceivedDeliveryV1,
): Uint8Array {
  return "signedObservations" in delivery
    ? commerceDeliverySignaturePayload({
        ...delivery,
        observations: delivery.signedObservations,
      })
    : commerceDeliverySignaturePayload(delivery);
}

export function parseReceipt(value: unknown): CommerceMutationReceiptV1 {
  return decodeRecord(parseCommerceMutationReceiptV1Record, value);
}

export function parseOptionalReceipt(
  value: unknown,
): CommerceMutationReceiptV1 | null {
  return value === null ? null : parseReceipt(value);
}

function parseMutationError(value: unknown): CommerceMutationErrorV1 {
  return decodeRecord(parseCommerceMutationErrorV1Record, value);
}

export function parseRejectedMutation(
  status: number,
  value: unknown,
): Variant<CommerceClientError, "rejected"> | undefined {
  if (status !== 409) return undefined;
  try {
    const response = requireObject(value, "rejection");
    if (response.outcome !== "rejected") return undefined;
    const error = parseMutationError(response.error);
    return {
      kind: "rejected",
      status: 409,
      error,
      message: `Commerce request rejected: ${error.code}`,
    };
  } catch {
    return undefined;
  }
}
