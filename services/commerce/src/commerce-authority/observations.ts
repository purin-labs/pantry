// The aggregate observations that a signed delivery carries.
import type {
  CommerceAggregateObservationV1,
  CommerceResourcesV1,
} from "@seams/commerce-client";

export function inventoryPositionObservation(
  resource: CommerceResourcesV1["inventoryPositions"][number],
): CommerceAggregateObservationV1 {
  return { kind: "inventory_position", resource };
}

export function offerObservation(
  resource: CommerceResourcesV1["offers"][number],
): CommerceAggregateObservationV1 {
  return { kind: "offer", resource };
}

export function orderObservation(
  resource: CommerceResourcesV1["orders"][number],
): CommerceAggregateObservationV1 {
  return { kind: "commerce_order", resource };
}

export function paymentObservation(
  resource: CommerceResourcesV1["payments"][number],
): CommerceAggregateObservationV1 {
  return { kind: "payment", resource };
}

export function fulfillmentObservation(
  resource: CommerceResourcesV1["fulfillments"][number],
): CommerceAggregateObservationV1 {
  return { kind: "fulfillment", resource };
}

export function shipmentObservation(
  resource: CommerceResourcesV1["shipments"][number],
): CommerceAggregateObservationV1 {
  return { kind: "shipment", resource };
}
