import type {
  CommerceCueFact,
  CommerceProjection,
} from "@purin-labs/commerce-contracts";
import type { IntegrationAccountId, OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { assertRequiredColumns } from "../schema-migrations";
import {
  canonicalJson,
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import {
  type AppliedCommerceObservationResult,
  type CommerceProjectionError,
  type CommerceProjectionKind,
  type CommerceSystemStorageAuthority,
  type DeliveryReceiptRow,
  type FulfillmentKind,
  type InspectedCommerceDelivery,
  type InspectedCommerceObservation,
  type ProjectionIdentity,
  type ProjectionRow,
  type ProjectionTombstoneRow,
  type ReceiptRow,
  type UpsertProjectionIdentity,
  isFulfillmentKind,
} from "../commerce-projection";
import {
  hasInteger,
  hasNonNegativeInteger,
  hasText,
  hasTimestamp,
  invalidEvent,
  isCommerceResourceType,
  isCommerceSource,
  isProjectionKind,
  parseCommerceObservationDispositionOrThrow,
  parseProjectionKindOrThrow,
  resourceTypeForProjection,
} from "./records";

function storedFulfillmentLifecycleValid(
  kind: FulfillmentKind,
  raw: unknown,
): boolean {
  if (!isRecord(raw) || typeof raw.state !== "string") return false;
  switch (kind) {
    case "shipping":
      return (
        (raw.state === "requested" && hasStoredText(raw, "requestedAt")) ||
        (raw.state === "preparing" && hasStoredText(raw, "startedAt")) ||
        (raw.state === "blocked" &&
          hasStoredText(raw, "blockedAt") &&
          hasStoredReason(raw)) ||
        (raw.state === "handed_to_carrier" &&
          hasStoredText(raw, "handedOverAt") &&
          hasStoredText(raw, "shipmentId")) ||
        (raw.state === "cancelled" &&
          hasStoredText(raw, "cancelledAt") &&
          hasStoredReason(raw))
      );
    case "pickup":
      return (
        (raw.state === "requested" && hasStoredText(raw, "requestedAt")) ||
        (raw.state === "preparing" && hasStoredText(raw, "startedAt")) ||
        (raw.state === "blocked" &&
          hasStoredText(raw, "blockedAt") &&
          hasStoredReason(raw)) ||
        (raw.state === "ready_for_pickup" && hasStoredText(raw, "readyAt")) ||
        (raw.state === "completed" && hasStoredText(raw, "completedAt")) ||
        (raw.state === "cancelled" &&
          hasStoredText(raw, "cancelledAt") &&
          hasStoredReason(raw))
      );
    case "local_delivery":
    case "on_premise":
      return (
        (raw.state === "requested" && hasStoredText(raw, "requestedAt")) ||
        (raw.state === "preparing" && hasStoredText(raw, "startedAt")) ||
        (raw.state === "blocked" &&
          hasStoredText(raw, "blockedAt") &&
          hasStoredReason(raw)) ||
        (raw.state === "completed" && hasStoredText(raw, "completedAt")) ||
        (raw.state === "cancelled" &&
          hasStoredText(raw, "cancelledAt") &&
          hasStoredReason(raw))
      );
    case "immediate_handoff":
      return (
        (raw.state === "requested" && hasStoredText(raw, "requestedAt")) ||
        (raw.state === "completed" && hasStoredText(raw, "completedAt")) ||
        (raw.state === "cancelled" &&
          hasStoredText(raw, "cancelledAt") &&
          hasStoredReason(raw))
      );
  }
}

function storedFirstPartyShipmentLifecycleValid(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.state !== "string") return false;
  switch (raw.state) {
    case "ready":
      return hasStoredText(raw, "readyAt");
    case "label_purchased":
      return (
        hasStoredText(raw, "labelAttemptId") &&
        hasStoredText(raw, "trackingNumber") &&
        hasStoredText(raw, "purchasedAt")
      );
    case "in_transit":
      return (
        hasStoredText(raw, "labelAttemptId") &&
        hasStoredText(raw, "trackingNumber") &&
        hasStoredText(raw, "handedOverAt")
      );
    case "delivered":
      return (
        hasStoredText(raw, "labelAttemptId") &&
        hasStoredText(raw, "trackingNumber") &&
        hasStoredText(raw, "handedOverAt") &&
        hasStoredText(raw, "deliveredAt")
      );
    default:
      return false;
  }
}

function storedExternalShipmentLifecycleValid(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.state !== "string") return false;
  switch (raw.state) {
    case "label_created":
      return hasStoredText(raw, "createdAt");
    case "in_transit":
      return hasStoredText(raw, "since");
    case "delivery_exception":
      return hasStoredText(raw, "occurredAt") && hasStoredReason(raw);
    case "delivered":
      return hasStoredText(raw, "deliveredAt");
    case "returned":
      return hasStoredText(raw, "returnedAt") && hasStoredReason(raw);
    default:
      return false;
  }
}

function storedShipmentEventsValid(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.every((event) => {
    if (
      !isRecord(event) ||
      !hasStoredText(event, "eventId") ||
      !hasStoredText(event, "occurredAt") ||
      !hasStoredText(event, "location") ||
      !isRecord(event.kind) ||
      typeof event.kind.kind !== "string"
    ) {
      return false;
    }
    switch (event.kind.kind) {
      case "label_created":
      case "in_transit":
      case "delivered":
      case "returned":
        return true;
      case "delivery_exception":
        return (
          typeof event.kind.reason === "string" && event.kind.reason.length > 0
        );
      default:
        return false;
    }
  });
}

function storedShipmentPackageValid(raw: unknown): boolean {
  if (
    !isRecord(raw) ||
    !isRecord(raw.weight) ||
    !isRecord(raw.dimensions) ||
    !hasStoredText(raw, "packageId") ||
    !isPositiveInteger(raw.weight.grams) ||
    !isPositiveInteger(raw.dimensions.lengthMillimeters) ||
    !isPositiveInteger(raw.dimensions.widthMillimeters) ||
    !isPositiveInteger(raw.dimensions.heightMillimeters) ||
    !Array.isArray(raw.lineQuantities) ||
    !Array.isArray(raw.customsLines) ||
    raw.lineQuantities.length === 0 ||
    raw.customsLines.length === 0
  ) {
    return false;
  }
  const lineIds = new Set<string>();
  for (const line of raw.lineQuantities) {
    if (
      !isRecord(line) ||
      typeof line.orderLineId !== "string" ||
      line.orderLineId.length === 0 ||
      !storedPositiveShipmentQuantity(line.quantity) ||
      lineIds.has(line.orderLineId)
    ) {
      return false;
    }
    lineIds.add(line.orderLineId);
  }
  const customsIds = new Set<string>();
  for (const line of raw.customsLines) {
    if (
      !isRecord(line) ||
      typeof line.orderLineId !== "string" ||
      line.orderLineId.length === 0 ||
      !storedPositiveShipmentQuantity(line.quantity) ||
      !hasStoredText(line, "description") ||
      !isRecord(line.weight) ||
      !isPositiveInteger(line.weight.grams) ||
      !storedNonNegativeMoney(line.declaredValue) ||
      !hasStoredText(line, "countryOfOrigin") ||
      !hasStoredText(line, "hsCode") ||
      customsIds.has(line.orderLineId)
    ) {
      return false;
    }
    customsIds.add(line.orderLineId);
  }
  if (lineIds.size !== customsIds.size) return false;
  for (const line of raw.lineQuantities) {
    if (!isRecord(line)) return false;
    const customs = raw.customsLines.find(
      (candidate) =>
        isRecord(candidate) && candidate.orderLineId === line.orderLineId,
    );
    if (
      !isRecord(customs) ||
      !storedShipmentQuantityEqual(line.quantity, customs.quantity)
    ) {
      return false;
    }
  }
  return true;
}

function storedPositiveShipmentQuantity(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    isPositiveInteger(raw.amount) &&
    isNonNegativeInteger(raw.scale) &&
    raw.scale <= 6 &&
    typeof raw.unit === "string" &&
    isShipmentQuantityUnit(raw.unit) &&
    (raw.unit !== "each" || raw.scale === 0)
  );
}

function isShipmentQuantityUnit(value: string): boolean {
  return (
    value === "each" ||
    value === "gram" ||
    value === "kilogram" ||
    value === "milliliter" ||
    value === "liter"
  );
}

function storedShipmentQuantityEqual(left: unknown, right: unknown): boolean {
  return (
    isRecord(left) &&
    isRecord(right) &&
    left.amount === right.amount &&
    left.scale === right.scale &&
    left.unit === right.unit
  );
}

function storedNonNegativeMoney(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    isNonNegativeInteger(raw.amountMinor) &&
    typeof raw.currency === "string" &&
    raw.currency.length > 0
  );
}

function hasStoredText(raw: Record<string, unknown>, key: string): boolean {
  return typeof raw[key] === "string" && raw[key] !== "";
}

function hasStoredReason(raw: Record<string, unknown>): boolean {
  return typeof raw.reason === "string" && raw.reason.trim().length > 0;
}

export function validateCommerceProjectionTables(sql: SqlStorage): void {
  assertRequiredColumns(sql, "commerce_projection", [
    "organisation_id",
    "projection_kind",
    "canonical_id",
    "integration_account_id",
    "revision",
    "lifecycle",
    "projection_json",
    "updated_at",
    "lab_run_id",
  ]);
  assertRequiredColumns(sql, "commerce_event_receipt", [
    "organisation_id",
    "event_id",
    "disposition",
    "delivery_count",
    "lab_run_id",
  ]);
  assertRequiredColumns(sql, "commerce_cue_outbox", [
    "organisation_id",
    "native_id",
    "event_json",
    "state",
    "lab_run_id",
  ]);
  assertRequiredColumns(sql, "commerce_lab_state", [
    "organisation_id",
    "lab_namespace",
    "catalog_version",
  ]);
}

export function inspectCanonicalDelivery(
  raw: unknown,
): Result<InspectedCommerceDelivery, CommerceProjectionError> {
  const value = raw;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.providerDeliveryId !== "string" ||
    value.providerDeliveryId.length === 0 ||
    !Array.isArray(value.observations) ||
    value.observations.length === 0
  ) {
    return invalidEvent("delivery");
  }
  const observations: InspectedCommerceObservation[] = [];
  const observationIds = new Set<string>();
  for (const rawObservation of value.observations) {
    if (
      !isRecord(rawObservation) ||
      typeof rawObservation.observationId !== "string" ||
      rawObservation.observationId.length === 0 ||
      observationIds.has(rawObservation.observationId)
    ) {
      return invalidEvent("delivery.observations");
    }
    observationIds.add(rawObservation.observationId);
    if (rawObservation.kind === "upsert") {
      const identity = parseProjectionIdentity(rawObservation.projection);
      if (!identity.ok) {
        return identity;
      }
      observations.push({
        kind: rawObservation.kind,
        observationId: rawObservation.observationId,
        observationJson: canonicalJson(rawObservation),
        projection: rawObservation.projection as CommerceProjection,
        projectionJson: canonicalJson(rawObservation.projection),
        identity: identity.value,
      });
      continue;
    }
    if (rawObservation.kind === "delete") {
      const identity = parseDeletionIdentity(rawObservation.provenance);
      if (!identity.ok) {
        return identity;
      }
      observations.push({
        kind: rawObservation.kind,
        observationId: rawObservation.observationId,
        observationJson: canonicalJson(rawObservation),
        provenanceJson: canonicalJson(rawObservation.provenance),
        identity: identity.value,
      });
      continue;
    }
    return invalidEvent("delivery.observations.kind");
  }

  return {
    ok: true,
    value: {
      providerDeliveryId: value.providerDeliveryId,
      deliveryJson: canonicalJson(value),
      observations,
    },
  };
}

export function matchesCommerceSystemAuthority(
  delivery: InspectedCommerceDelivery,
  authority: CommerceSystemStorageAuthority,
  integrationAccountId: IntegrationAccountId,
): boolean {
  for (const observation of delivery.observations) {
    if (observation.identity.integrationAccountId !== integrationAccountId)
      return false;
    if (authority.kind === "lab") {
      if (observation.identity.source !== "lab") return false;
      continue;
    }
    const expectedSource =
      authority.kind === "satyr_commerce" ? "underclerk" : "shopify";
    if (
      observation.identity.source !== expectedSource ||
      authority.revision < 1
    )
      return false;
  }
  return true;
}

export function parseCommerceCueFact(
  raw: unknown,
): Result<CommerceCueFact, CommerceProjectionError> {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return invalidEvent("cueFacts.kind");
  }
  switch (raw.kind) {
    case "payment_failed":
      if (
        !hasText(raw, "orderId") ||
        !hasText(raw, "paymentId") ||
        !hasInteger(raw, "amountMinor") ||
        !hasText(raw, "currency") ||
        !hasText(raw, "reason")
      ) {
        return invalidEvent("cueFacts.payment_failed");
      }
      return { ok: true, value: raw as CommerceCueFact };
    case "inventory_shortage":
      if (
        !hasText(raw, "orderId") ||
        !hasText(raw, "sku") ||
        !hasNonNegativeInteger(raw, "requested") ||
        !hasNonNegativeInteger(raw, "available") ||
        !hasText(raw, "locationId")
      ) {
        return invalidEvent("cueFacts.inventory_shortage");
      }
      return { ok: true, value: raw as CommerceCueFact };
    case "order_unshipped":
      if (
        !hasText(raw, "orderId") ||
        !hasText(raw, "fulfillmentId") ||
        !hasTimestamp(raw, "expectedBy")
      ) {
        return invalidEvent("cueFacts.order_unshipped");
      }
      return { ok: true, value: raw as CommerceCueFact };
    case "tracking_stalled":
      if (
        !hasText(raw, "orderId") ||
        !hasText(raw, "shipmentId") ||
        !hasText(raw, "trackingNumber") ||
        !hasTimestamp(raw, "lastEventAt")
      ) {
        return invalidEvent("cueFacts.tracking_stalled");
      }
      return { ok: true, value: raw as CommerceCueFact };
    case "delivery_exception":
      if (
        !hasText(raw, "orderId") ||
        !hasText(raw, "shipmentId") ||
        !hasText(raw, "trackingNumber") ||
        !hasText(raw, "status") ||
        !hasText(raw, "reason")
      ) {
        return invalidEvent("cueFacts.delivery_exception");
      }
      return { ok: true, value: raw as CommerceCueFact };
    case "cancellation_refund_proposed":
      if (
        !hasText(raw, "orderId") ||
        !hasText(raw, "paymentId") ||
        !hasInteger(raw, "amountMinor") ||
        !hasText(raw, "currency") ||
        !hasText(raw, "reason")
      ) {
        return invalidEvent("cueFacts.cancellation_refund_proposed");
      }
      return { ok: true, value: raw as CommerceCueFact };
    default:
      return invalidEvent("cueFacts.kind");
  }
}

export function parseProjectionIdentity(
  raw: unknown,
): Result<UpsertProjectionIdentity, CommerceProjectionError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "projection"]) ||
    !isProjectionKind(raw.kind) ||
    !isRecord(raw.projection)
  ) {
    return invalidEvent("event.projection");
  }
  const provenance = raw.projection.provenance;
  if (
    !isRecord(provenance) ||
    typeof provenance.organisationId !== "string" ||
    typeof provenance.integrationAccountId !== "string" ||
    !isCommerceSource(provenance.source) ||
    !isCommerceResourceType(provenance.resourceType) ||
    provenance.resourceType !== resourceTypeForProjection(raw.kind) ||
    typeof provenance.resourceId !== "string" ||
    provenance.resourceId.length === 0 ||
    !isPositiveInteger(provenance.revision) ||
    typeof provenance.occurredAt !== "string" ||
    typeof provenance.observedAt !== "string" ||
    !projectionShapeValid(raw.kind, raw.projection) ||
    !projectionPrimaryIdentityMatchesProvenance(raw.kind, raw.projection)
  ) {
    return invalidEvent("event.projection.provenance");
  }
  const lifecycle = readProjectionLifecycle(raw.kind, raw.projection);
  const occurredAt = Date.parse(provenance.occurredAt);
  const observedAt = Date.parse(provenance.observedAt);
  if (
    lifecycle === null ||
    Number.isNaN(occurredAt) ||
    Number.isNaN(observedAt) ||
    observedAt < occurredAt
  ) {
    return invalidEvent("event.projection.lifecycle");
  }

  return {
    ok: true,
    value: {
      kind: raw.kind,
      canonicalId: provenance.resourceId,
      organisationId: provenance.organisationId,
      integrationAccountId: provenance.integrationAccountId,
      source: provenance.source,
      revision: provenance.revision,
      occurredAt: provenance.occurredAt,
      lifecycle,
    },
  };
}

function parseDeletionIdentity(
  raw: unknown,
): Result<ProjectionIdentity, CommerceProjectionError> {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    typeof raw.integrationAccountId !== "string" ||
    !isCommerceSource(raw.source) ||
    !isProjectionKind(raw.resourceType) ||
    typeof raw.resourceId !== "string" ||
    raw.resourceId.length === 0 ||
    !isPositiveInteger(raw.revision) ||
    typeof raw.occurredAt !== "string" ||
    typeof raw.observedAt !== "string"
  ) {
    return invalidEvent("event.delete.provenance");
  }
  const occurredAt = Date.parse(raw.occurredAt);
  const observedAt = Date.parse(raw.observedAt);
  if (
    Number.isNaN(occurredAt) ||
    Number.isNaN(observedAt) ||
    observedAt < occurredAt
  ) {
    return invalidEvent("event.delete.provenance");
  }
  return {
    ok: true,
    value: {
      kind: raw.resourceType,
      canonicalId: raw.resourceId,
      organisationId: raw.organisationId,
      integrationAccountId: raw.integrationAccountId,
      source: raw.source,
      revision: raw.revision,
      occurredAt: raw.occurredAt,
    },
  };
}

function projectionShapeValid(
  kind: CommerceProjectionKind,
  projection: Record<string, unknown>,
): boolean {
  if (!projectionKeysValid(kind, projection)) return false;
  switch (kind) {
    case "product":
      return (
        typeof projection.title === "string" &&
        typeof projection.description === "string"
      );
    case "sellable_variant":
      return (
        isRecord(projection.provenance) &&
        typeof projection.productId === "string" &&
        typeof projection.variantId === "string" &&
        typeof projection.sku === "string" &&
        typeof projection.title === "string" &&
        Array.isArray(projection.options) &&
        Array.isArray(projection.media)
      );
    case "inventory_item":
      return (
        isRecord(projection.provenance) &&
        typeof projection.merchantCode === "string" &&
        typeof projection.name === "string" &&
        typeof projection.baseUnit === "string" &&
        storedInventoryCategory(projection.category) &&
        storedInventoryTracking(projection.tracking) &&
        storedInventoryItemLifecycle(projection.lifecycle)
      );
    case "location":
      return (
        isRecord(projection.provenance) &&
        typeof projection.name === "string" &&
        typeof projection.kind === "string"
      );
    case "sales_channel":
      return (
        isRecord(projection.provenance) &&
        typeof projection.name === "string" &&
        typeof projection.kind === "string"
      );
    case "offer":
      return (
        isRecord(projection.provenance) &&
        typeof projection.variantId === "string" &&
        typeof projection.salesChannelId === "string" &&
        isRecord(projection.price) &&
        isRecord(projection.availability) &&
        isRecord(projection.lifecycle)
      );
    case "inventory_position":
      return (
        typeof projection.inventoryItemId === "string" &&
        typeof projection.locationId === "string" &&
        storedInventoryBalance(projection.balance)
      );
    case "inventory_movement":
      return (
        typeof projection.inventoryItemId === "string" &&
        typeof projection.locationId === "string" &&
        isRecord(projection.change) &&
        typeof projection.change.kind === "string" &&
        typeof projection.idempotencyKey === "string"
      );
    case "inventory_lot":
      return (
        typeof projection.lotCode === "string" &&
        typeof projection.inventoryItemId === "string" &&
        typeof projection.locationId === "string" &&
        typeof projection.sourceMovementId === "string" &&
        storedInventoryQuantity(projection.receivedQuantity) !== null &&
        storedInventoryQuantity(projection.remainingQuantity) !== null &&
        isRecord(projection.expiry) &&
        isRecord(projection.lifecycle)
      );
    case "commerce_order":
      return (
        isRecord(projection.origin) &&
        typeof projection.origin.kind === "string" &&
        isRecord(projection.buyer) &&
        typeof projection.buyer.kind === "string" &&
        projection.fulfillmentMethod === undefined &&
        Array.isArray(projection.lineItems) &&
        isRecord(projection.totals) &&
        isRecord(projection.totals.total) &&
        Array.isArray(projection.adjustments)
      );
    case "payment":
      return (
        typeof projection.orderId === "string" && isRecord(projection.amount)
      );
    case "fulfillment":
      return (
        typeof projection.orderId === "string" &&
        typeof projection.locationId === "string" &&
        typeof projection.expectedBy === "string" &&
        Array.isArray(projection.lineItems) &&
        isFulfillmentKind(projection.kind) &&
        storedFulfillmentLifecycleValid(projection.kind, projection.lifecycle)
      );
    case "shipment":
      return (
        typeof projection.orderId === "string" &&
        typeof projection.fulfillmentId === "string" &&
        storedShipmentEventsValid(projection.events) &&
        (projection.kind === "first_party"
          ? storedShipmentPackageValid(projection.package) &&
            storedFirstPartyShipmentLifecycleValid(projection.lifecycle)
          : projection.kind === "external"
            ? typeof projection.carrier === "string" &&
              projection.carrier.length > 0 &&
              typeof projection.trackingNumber === "string" &&
              projection.trackingNumber.length > 0 &&
              typeof projection.estimatedDeliveryAt === "string" &&
              storedExternalShipmentLifecycleValid(projection.lifecycle)
            : false)
      );
    case "menu":
      return (
        isRecord(projection.provenance) &&
        typeof projection.menuId === "string" &&
        isPositiveInteger(projection.revision) &&
        typeof projection.name === "string" &&
        isRecord(projection.scope) &&
        isRecord(projection.validity) &&
        Array.isArray(projection.sections) &&
        Array.isArray(projection.entries) &&
        isRecord(projection.lifecycle)
      );
    case "modifier_group_revision":
      return (
        isRecord(projection.provenance) &&
        typeof projection.modifierGroupId === "string" &&
        isPositiveInteger(projection.revision) &&
        typeof projection.name === "string" &&
        Number.isSafeInteger(projection.minimumSelections) &&
        Number.isSafeInteger(projection.maximumSelections) &&
        Array.isArray(projection.options) &&
        isRecord(projection.lifecycle)
      );
    case "recipe_revision":
      return (
        isRecord(projection.provenance) &&
        typeof projection.recipeId === "string" &&
        isPositiveInteger(projection.revision) &&
        typeof projection.name === "string" &&
        Array.isArray(projection.inputs) &&
        isRecord(projection.output) &&
        isRecord(projection.lifecycle)
      );
    case "preparation_station":
      return (
        isRecord(projection.provenance) &&
        typeof projection.stationId === "string" &&
        typeof projection.locationId === "string" &&
        isPositiveInteger(projection.revision) &&
        typeof projection.name === "string" &&
        typeof projection.lifecycle === "string"
      );
    case "preparation_ticket":
      return (
        isRecord(projection.provenance) &&
        typeof projection.ticketId === "string" &&
        typeof projection.orderId === "string" &&
        typeof projection.fulfillmentId === "string" &&
        typeof projection.locationId === "string" &&
        typeof projection.stationId === "string" &&
        isPositiveInteger(projection.revision) &&
        Array.isArray(projection.lineSnapshots) &&
        isRecord(projection.lifecycle)
      );
    case "production_batch":
      return (
        isRecord(projection.provenance) &&
        typeof projection.productionBatchId === "string" &&
        isProductionBatchDemand(projection.demand) &&
        typeof projection.recipeId === "string" &&
        isPositiveInteger(projection.recipeRevision) &&
        typeof projection.locationId === "string" &&
        typeof projection.stationId === "string" &&
        isPositiveInteger(projection.revision) &&
        isRecord(projection.plannedYield) &&
        isRecord(projection.actualYield) &&
        typeof projection.completedAt === "string" &&
        Array.isArray(projection.inputMovementIds) &&
        typeof projection.outputMovementId === "string" &&
        typeof projection.outputLotId === "string"
      );
    case "stock_policy":
      return (
        isRecord(projection.provenance) &&
        typeof projection.stockPolicyId === "string" &&
        typeof projection.inventoryItemId === "string" &&
        typeof projection.locationId === "string" &&
        isPositiveInteger(projection.revision) &&
        isStockPolicyReplenishment(projection.replenishment) &&
        (projection.lifecycle === "active" ||
          projection.lifecycle === "inactive")
      );
  }
}

function projectionKeysValid(
  kind: CommerceProjectionKind,
  projection: Record<string, unknown>,
): boolean {
  switch (kind) {
    case "product":
      return hasExactKeys(projection, ["provenance", "title", "description"]);
    case "sellable_variant":
      return hasExactKeys(projection, [
        "provenance",
        "productId",
        "variantId",
        "sku",
        "title",
        "options",
        "media",
      ]);
    case "inventory_item":
      return hasExactKeys(projection, [
        "provenance",
        "merchantCode",
        "name",
        "baseUnit",
        "category",
        "tracking",
        "lifecycle",
      ]);
    case "location":
    case "sales_channel":
      return hasExactKeys(projection, [
        "provenance",
        "name",
        "kind",
        "lifecycle",
      ]);
    case "offer":
      return hasExactKeys(projection, [
        "provenance",
        "variantId",
        "salesChannelId",
        "price",
        "availability",
        "lifecycle",
      ]);
    case "inventory_position":
      return hasExactKeys(projection, [
        "provenance",
        "inventoryItemId",
        "locationId",
        "balance",
      ]);
    case "inventory_movement":
      return hasExactKeys(projection, [
        "provenance",
        "inventoryItemId",
        "locationId",
        "change",
        "idempotencyKey",
      ]);
    case "inventory_lot":
      return hasExactKeys(projection, [
        "provenance",
        "lotCode",
        "inventoryItemId",
        "locationId",
        "sourceMovementId",
        "receivedQuantity",
        "remainingQuantity",
        "expiry",
        "lifecycle",
      ]);
    case "commerce_order":
      return hasExactKeys(projection, [
        "provenance",
        "origin",
        "buyer",
        "lineItems",
        "totals",
        "adjustments",
        "lifecycle",
      ]);
    case "payment":
      return hasExactKeys(projection, [
        "provenance",
        "orderId",
        "amount",
        "lifecycle",
      ]);
    case "fulfillment":
      return projection.kind === "shipping"
        ? hasExactKeys(projection, [
            "provenance",
            "orderId",
            "lineItems",
            "locationId",
            "expectedBy",
            "kind",
            "binding",
            "lifecycle",
          ])
        : hasExactKeys(projection, [
            "provenance",
            "orderId",
            "lineItems",
            "locationId",
            "expectedBy",
            "kind",
            "lifecycle",
          ]);
    case "shipment":
      return projection.kind === "first_party"
        ? hasExactKeys(projection, [
            "kind",
            "provenance",
            "orderId",
            "fulfillmentId",
            "package",
            "lifecycle",
            "events",
          ])
        : hasExactKeys(projection, [
            "kind",
            "provenance",
            "orderId",
            "fulfillmentId",
            "carrier",
            "trackingNumber",
            "estimatedDeliveryAt",
            "lifecycle",
            "events",
          ]);
    case "menu":
      return hasExactKeys(projection, [
        "provenance",
        "menuId",
        "revision",
        "name",
        "salesChannelId",
        "scope",
        "validity",
        "sections",
        "entries",
        "lifecycle",
      ]);
    case "modifier_group_revision":
      return hasExactKeys(projection, [
        "provenance",
        "modifierGroupId",
        "revision",
        "name",
        "minimumSelections",
        "maximumSelections",
        "options",
        "lifecycle",
      ]);
    case "recipe_revision":
      return hasExactKeys(projection, [
        "provenance",
        "recipeId",
        "revision",
        "name",
        "inputs",
        "output",
        "lifecycle",
      ]);
    case "preparation_station":
      return hasExactKeys(projection, [
        "provenance",
        "stationId",
        "locationId",
        "revision",
        "name",
        "lifecycle",
      ]);
    case "preparation_ticket":
      return hasExactKeys(projection, [
        "provenance",
        "ticketId",
        "orderId",
        "fulfillmentId",
        "locationId",
        "stationId",
        "revision",
        "lineSnapshots",
        "lifecycle",
      ]);
    case "production_batch":
      return hasExactKeys(projection, [
        "provenance",
        "productionBatchId",
        "demand",
        "recipeId",
        "recipeRevision",
        "locationId",
        "stationId",
        "revision",
        "plannedYield",
        "actualYield",
        "completedAt",
        "inputMovementIds",
        "outputMovementId",
        "outputLotId",
      ]);
    case "stock_policy":
      return hasExactKeys(projection, [
        "provenance",
        "stockPolicyId",
        "inventoryItemId",
        "locationId",
        "revision",
        "replenishment",
        "lifecycle",
      ]);
  }
}

function projectionPrimaryIdentityMatchesProvenance(
  kind: CommerceProjectionKind,
  projection: Record<string, unknown>,
): boolean {
  if (!isCafeProjectionKind(kind)) return true;
  const provenance = projection.provenance;
  if (!isRecord(provenance) || typeof provenance.resourceId !== "string")
    return false;
  switch (kind) {
    case "menu":
      return projection.menuId === provenance.resourceId;
    case "modifier_group_revision":
      return projection.modifierGroupId === provenance.resourceId;
    case "recipe_revision":
      return projection.recipeId === provenance.resourceId;
    case "preparation_station":
      return projection.stationId === provenance.resourceId;
    case "preparation_ticket":
      return projection.ticketId === provenance.resourceId;
    case "production_batch":
      return projection.productionBatchId === provenance.resourceId;
    case "stock_policy":
      return projection.stockPolicyId === provenance.resourceId;
  }
}

function isCafeProjectionKind(
  kind: CommerceProjectionKind,
): kind is
  | "menu"
  | "modifier_group_revision"
  | "recipe_revision"
  | "preparation_station"
  | "preparation_ticket"
  | "production_batch"
  | "stock_policy" {
  return (
    kind === "menu" ||
    kind === "modifier_group_revision" ||
    kind === "recipe_revision" ||
    kind === "preparation_station" ||
    kind === "preparation_ticket" ||
    kind === "production_batch" ||
    kind === "stock_policy"
  );
}

export type InventoryQuantity = Readonly<{
  amount: number;
  scale: number;
  unit: string;
}>;

type StoredInventoryQuantity = InventoryQuantity | null;

export function storedInventoryQuantity(raw: unknown): StoredInventoryQuantity {
  if (
    !isRecord(raw) ||
    !isNonNegativeInteger(raw.scale) ||
    raw.scale > 6 ||
    typeof raw.unit !== "string" ||
    raw.unit.length === 0
  ) {
    return null;
  }
  const amount = safeNonNegativeInteger(raw.amount);
  return amount === null ? null : { amount, scale: raw.scale, unit: raw.unit };
}

function storedAvailableQuantity(raw: unknown): StoredInventoryQuantity {
  if (
    !isRecord(raw) ||
    !isNonNegativeInteger(raw.scale) ||
    raw.scale > 6 ||
    typeof raw.unit !== "string" ||
    raw.unit.length === 0 ||
    typeof raw.amount !== "number" ||
    !Number.isSafeInteger(raw.amount)
  ) {
    return null;
  }
  return { amount: raw.amount, scale: raw.scale, unit: raw.unit };
}

function safeNonNegativeInteger(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "bigint") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function storedInventoryBalance(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.kind !== "string") return false;
  if (raw.kind === "available_only")
    return storedAvailableQuantity(raw.available) !== null;
  if (raw.kind !== "accounted") return false;
  const onHand = storedInventoryQuantity(raw.onHand);
  const allocated = storedInventoryQuantity(raw.allocated);
  const available = storedInventoryQuantity(raw.available);
  if (onHand === null || allocated === null || available === null) return false;
  return (
    onHand.scale === allocated.scale &&
    onHand.scale === available.scale &&
    onHand.unit === allocated.unit &&
    onHand.unit === available.unit &&
    onHand.amount - allocated.amount === available.amount
  );
}

function storedInventoryCategory(raw: unknown): boolean {
  return (
    raw === "ingredient" ||
    raw === "packaging" ||
    raw === "finished_good" ||
    raw === "operating_supply"
  );
}

function storedInventoryTracking(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return (
    raw.kind === "aggregate" ||
    (raw.kind === "lot_tracked" &&
      (raw.expiry === "required" || raw.expiry === "optional"))
  );
}

function storedInventoryItemLifecycle(raw: unknown): boolean {
  return raw === "active" || raw === "inactive";
}

function isStockPolicyReplenishment(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.kind !== "string") return false;
  if (raw.kind === "none") return true;
  return (
    raw.kind === "threshold" &&
    storedInventoryQuantity(raw.reorderPoint) !== null &&
    storedInventoryQuantity(raw.targetQuantity) !== null
  );
}

function isProductionBatchDemand(raw: unknown): boolean {
  if (!isRecord(raw) || typeof raw.kind !== "string") return false;
  if (raw.kind === "stock") return true;
  return (
    raw.kind === "shipment" &&
    typeof raw.shipmentId === "string" &&
    raw.shipmentId.length > 0
  );
}

export function readProjectionLifecycle(
  kind: CommerceProjectionKind,
  projection: Record<string, unknown>,
): string | null {
  const state =
    kind === "product"
      ? { state: "active" }
      : kind === "sellable_variant"
        ? { state: "active" }
        : kind === "inventory_position"
          ? {
              state:
                isRecord(projection.balance) &&
                projection.balance.available &&
                isRecord(projection.balance.available) &&
                projection.balance.available.amount === 0
                  ? "out_of_stock"
                  : "in_stock",
            }
          : kind === "inventory_movement"
            ? { state: "recorded" }
            : kind === "inventory_lot"
              ? projection.lifecycle
              : kind === "inventory_item" &&
                  typeof projection.lifecycle === "string"
                ? { state: projection.lifecycle }
                : (kind === "preparation_station" || kind === "stock_policy") &&
                    typeof projection.lifecycle === "string"
                  ? { state: projection.lifecycle }
                  : kind === "offer"
                    ? projection.lifecycle
                    : kind === "production_batch"
                      ? { state: "completed" }
                      : (projection.lifecycle ?? { state: "active" });
  return isRecord(state) && typeof state.state === "string"
    ? state.state
    : null;
}

/**
 * Selects projection records; a caller appends its `WHERE`. A record was
 * validated at the later of its own write and its account's last completed
 * sync (`commerce_projection_sync`).
 */
export function projectionSelectSql(): string {
  return `SELECT projection_kind AS projectionKind,
                 canonical_id AS canonicalId,
                 integration_account_id AS integrationAccountId,
                 revision,
                 lifecycle,
                 projection_json AS projectionJson,
                 updated_at AS updatedAt,
                 MAX(validated_at, COALESCE((
                   SELECT sync.validated_at FROM commerce_projection_sync sync
                   WHERE sync.organisation_id = commerce_projection.organisation_id
                     AND sync.integration_account_id =
                       commerce_projection.integration_account_id
                 ), validated_at)) AS validatedAt,
                 lab_run_id AS labRunId
          FROM commerce_projection`;
}

export function readProjection(
  sql: SqlStorage,
  organisationId: OrganisationId,
  kind: CommerceProjectionKind,
  canonicalId: string,
): ProjectionRow | null {
  return (
    sql
      .exec<ProjectionRow>(
        `${projectionSelectSql()}
       WHERE organisation_id = ? AND projection_kind = ? AND canonical_id = ?
       LIMIT 1`,
        organisationId,
        kind,
        canonicalId,
      )
      .toArray()[0] ?? null
  );
}

export function readProjectionTombstone(
  sql: SqlStorage,
  organisationId: OrganisationId,
  kind: CommerceProjectionKind,
  canonicalId: string,
): ProjectionTombstoneRow | null {
  return (
    sql
      .exec<ProjectionTombstoneRow>(
        `SELECT projection_kind AS projectionKind,
              canonical_id AS canonicalId,
              integration_account_id AS integrationAccountId,
              revision,
              provenance_json AS provenanceJson,
              updated_at AS updatedAt,
              lab_run_id AS labRunId
       FROM commerce_projection_tombstone
       WHERE organisation_id = ? AND projection_kind = ? AND canonical_id = ?
       LIMIT 1`,
        organisationId,
        kind,
        canonicalId,
      )
      .toArray()[0] ?? null
  );
}

export function readDeliveryReceipt(
  sql: SqlStorage,
  organisationId: OrganisationId,
  providerDeliveryId: string,
): DeliveryReceiptRow | null {
  return (
    sql
      .exec<DeliveryReceiptRow>(
        `SELECT provider_delivery_id AS providerDeliveryId,
              delivery_json AS deliveryJson,
              delivery_count AS deliveryCount,
              commerce_system_kind AS commerceSystemKind,
              commerce_system_revision AS commerceSystemRevision
       FROM commerce_delivery_receipt
       WHERE organisation_id = ? AND provider_delivery_id = ?
       LIMIT 1`,
        organisationId,
        providerDeliveryId,
      )
      .toArray()[0] ?? null
  );
}

export function readObservationResultsForDelivery(
  sql: SqlStorage,
  organisationId: OrganisationId,
  providerDeliveryId: string,
): readonly AppliedCommerceObservationResult[] {
  const rows = sql
    .exec<ReceiptRow>(
      `SELECT event_id AS eventId,
            disposition,
            projection_kind AS projectionKind,
            canonical_id AS canonicalId,
            revision,
            delivery_count AS deliveryCount,
            commerce_system_kind AS commerceSystemKind,
            commerce_system_revision AS commerceSystemRevision
     FROM commerce_event_receipt
     WHERE organisation_id = ? AND provider_delivery_id = ?
     ORDER BY observation_index`,
      organisationId,
      providerDeliveryId,
    )
    .toArray();
  return rows.map((row) => ({
    disposition: parseCommerceObservationDispositionOrThrow(row.disposition),
    observationId: row.eventId,
    projectionKind: parseProjectionKindOrThrow(row.projectionKind),
    canonicalId: row.canonicalId,
    revision: row.revision,
  }));
}
