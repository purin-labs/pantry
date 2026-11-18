// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger, recordParser } from "../schema.ts";

export const commerceBoundaryContextSchema = OpenObject({
  organisationId: Type.String(),
  integrationAccountId: Type.String(),
  revision: SafeInteger,
  occurredAt: Type.String(),
  observedAt: Type.String(),
  eventId: Type.String(),
  customerReference: Type.String(),
});
export type CommerceBoundaryContext = Static<
  typeof commerceBoundaryContextSchema
>;

export const labCatalogOptionV1Schema = OpenObject({
  name: Type.String(),
  value: Type.String(),
});
export type LabCatalogOptionV1 = Static<typeof labCatalogOptionV1Schema>;

export const labCatalogMediaKindV1Schema = Type.Union([
  Type.Literal("image"),
  Type.Literal("video"),
  Type.Literal("model3d"),
]);
export type LabCatalogMediaKindV1 = Static<typeof labCatalogMediaKindV1Schema>;

export const labCatalogMediaV1Schema = OpenObject({
  kind: labCatalogMediaKindV1Schema,
  url: Type.String(),
  altText: Type.String(),
});
export type LabCatalogMediaV1 = Static<typeof labCatalogMediaV1Schema>;

export const labCatalogVariantV1Schema = OpenObject({
  variantId: Type.String(),
  sku: Type.String(),
  title: Type.String(),
  amountMinor: SafeInteger,
  currency: Type.String(),
  available: Type.Boolean(),
  options: Type.Array(labCatalogOptionV1Schema),
  media: Type.Array(labCatalogMediaV1Schema),
});
export type LabCatalogVariantV1 = Static<typeof labCatalogVariantV1Schema>;

export const labCatalogItemV1Schema = OpenObject({
  resourceId: Type.String(),
  title: Type.String(),
  description: Type.String(),
  variants: Type.Array(labCatalogVariantV1Schema),
});
export type LabCatalogItemV1 = Static<typeof labCatalogItemV1Schema>;

export const labScenarioIdV1Schema = Type.Union([
  Type.Literal("product-listing"),
  Type.Literal("happy-order"),
  Type.Literal("payment-failed"),
  Type.Literal("inventory-shortage"),
  Type.Literal("shipment-delayed"),
  Type.Literal("cancellation-refund"),
]);
export type LabScenarioIdV1 = Static<typeof labScenarioIdV1Schema>;

export const labOrderStateV1Schema = Type.Union([
  Type.Literal("pending_confirmation"),
  Type.Literal("confirmed"),
  Type.Literal("fulfillment_pending"),
  Type.Literal("partially_fulfilled"),
  Type.Literal("fulfilled"),
  Type.Literal("cancelled"),
]);
export type LabOrderStateV1 = Static<typeof labOrderStateV1Schema>;

export const labOrderLineItemV1Schema = OpenObject({
  id: Type.String(),
  variantId: Type.String(),
  sku: Type.String(),
  title: Type.String(),
  quantity: SafeInteger,
  fulfilledQuantity: SafeInteger,
  unitAmountMinor: SafeInteger,
});
export type LabOrderLineItemV1 = Static<typeof labOrderLineItemV1Schema>;

export const labOrderV1Schema = OpenObject({
  id: Type.String(),
  checkoutId: Type.String(),
  customerReference: Type.String(),
  currency: Type.String(),
  totalAmountMinor: SafeInteger,
  state: labOrderStateV1Schema,
  lineItems: Type.Array(labOrderLineItemV1Schema),
});
export type LabOrderV1 = Static<typeof labOrderV1Schema>;

export const labOrderLifecycleV1Schema = OpenObject({
  id: Type.String(),
  checkoutId: Type.String(),
  customerReference: Type.String(),
  currency: Type.String(),
  totalAmountMinor: SafeInteger,
  lineItems: Type.Array(labOrderLineItemV1Schema),
});
export type LabOrderLifecycleV1 = Static<typeof labOrderLifecycleV1Schema>;

export const labPaymentV1Schema = OpenObject({
  resourceId: Type.String(),
  orderId: Type.String(),
  amountMinor: SafeInteger,
  currency: Type.String(),
  reason: Type.String(),
});
export type LabPaymentV1 = Static<typeof labPaymentV1Schema>;

export const labInventoryV1Schema = OpenObject({
  resourceId: Type.String(),
  orderId: Type.String(),
  variantId: Type.String(),
  sku: Type.String(),
  requested: SafeInteger,
  available: SafeInteger,
  locationId: Type.String(),
});
export type LabInventoryV1 = Static<typeof labInventoryV1Schema>;

export const labInventoryObservedV1Schema = OpenObject({
  resourceId: Type.String(),
  variantId: Type.String(),
  sku: Type.String(),
  locationId: Type.String(),
  available: SafeInteger,
});
export type LabInventoryObservedV1 = Static<
  typeof labInventoryObservedV1Schema
>;

export const labFulfillmentLineItemV1Schema = OpenObject({
  lineItemId: Type.String(),
  quantity: SafeInteger,
});
export type LabFulfillmentLineItemV1 = Static<
  typeof labFulfillmentLineItemV1Schema
>;

export const labFulfillmentV1Schema = OpenObject({
  resourceId: Type.String(),
  orderId: Type.String(),
  locationId: Type.String(),
  expectedBy: Type.String(),
  lineItems: Type.Array(labFulfillmentLineItemV1Schema),
});
export type LabFulfillmentV1 = Static<typeof labFulfillmentV1Schema>;

export const labFulfillmentOverdueV1Schema = OpenObject({
  resourceId: Type.String(),
  orderId: Type.String(),
  locationId: Type.String(),
  requestedAt: Type.String(),
  expectedBy: Type.String(),
  lineItems: Type.Array(labFulfillmentLineItemV1Schema),
});
export type LabFulfillmentOverdueV1 = Static<
  typeof labFulfillmentOverdueV1Schema
>;

export const labFulfillmentHandedToCarrierV1Schema = OpenObject({
  resourceId: Type.String(),
  orderId: Type.String(),
  locationId: Type.String(),
  expectedBy: Type.String(),
  shipmentId: Type.String(),
  lineItems: Type.Array(labFulfillmentLineItemV1Schema),
});
export type LabFulfillmentHandedToCarrierV1 = Static<
  typeof labFulfillmentHandedToCarrierV1Schema
>;

export const labTrackingEventKindV1Schema = Type.Union([
  Type.Literal("label_created"),
  Type.Literal("in_transit"),
  Type.Literal("delivery_exception"),
  Type.Literal("delivered"),
  Type.Literal("returned"),
]);
export type LabTrackingEventKindV1 = Static<
  typeof labTrackingEventKindV1Schema
>;

export const labTrackingEventV1Schema = OpenObject({
  eventId: Type.String(),
  occurredAt: Type.String(),
  kind: labTrackingEventKindV1Schema,
  reason: Type.String(),
  location: Type.String(),
});
export type LabTrackingEventV1 = Static<typeof labTrackingEventV1Schema>;

export const labShipmentV1Schema = OpenObject({
  resourceId: Type.String(),
  orderId: Type.String(),
  fulfillmentId: Type.String(),
  carrier: Type.String(),
  trackingNumber: Type.String(),
  estimatedDeliveryAt: Type.String(),
  reason: Type.String(),
  trackingEvents: Type.Array(labTrackingEventV1Schema),
});
export type LabShipmentV1 = Static<typeof labShipmentV1Schema>;

export const labEventV1Schema = Type.Union([
  OpenObject({
    kind: Type.Literal("catalog_item_prepared"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labCatalogItemV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("catalog_item_listed"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labCatalogItemV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("order_created"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labOrderV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("order_fulfillment_pending"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labOrderLifecycleV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("order_fulfilled"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labOrderLifecycleV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("payment_captured"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labPaymentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("payment_failed"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labPaymentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("refund_completed"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labPaymentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("inventory_shortage"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labInventoryV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("inventory_observed"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labInventoryObservedV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("cancellation_refund_proposed"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labPaymentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("fulfillment_requested"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labFulfillmentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("fulfillment_overdue"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labFulfillmentOverdueV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("fulfillment_handed_to_carrier"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labFulfillmentHandedToCarrierV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("shipment_label_created"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labShipmentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("shipment_in_transit"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labShipmentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("tracking_stalled"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labShipmentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("delivery_exception"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labShipmentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("shipment_delivered"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labShipmentV1Schema,
  }),
  OpenObject({
    kind: Type.Literal("shipment_returned"),
    eventId: Type.String(),
    revision: SafeInteger,
    occurredAt: Type.String(),
    payload: labShipmentV1Schema,
  }),
]);
export type LabEventV1 = Static<typeof labEventV1Schema>;

export const labEventEnvelopeV1Schema = OpenObject({
  schemaVersion: Type.String(),
  namespace: Type.String(),
  runId: Type.String(),
  scenarioId: labScenarioIdV1Schema,
  organisationId: Type.String(),
  integrationAccountId: Type.String(),
  observedAt: Type.String(),
  event: labEventV1Schema,
});
export type LabEventEnvelopeV1 = Static<typeof labEventEnvelopeV1Schema>;

// Parsers of the records above (Plan 78 step 2).
export const parseCommerceBoundaryContext = recordParser(
  commerceBoundaryContextSchema,
);
export const parseLabCatalogOptionV1 = recordParser(labCatalogOptionV1Schema);
export const parseLabCatalogMediaKindV1 = recordParser(
  labCatalogMediaKindV1Schema,
);
export const parseLabCatalogMediaV1 = recordParser(labCatalogMediaV1Schema);
export const parseLabCatalogVariantV1 = recordParser(labCatalogVariantV1Schema);
export const parseLabCatalogItemV1 = recordParser(labCatalogItemV1Schema);
export const parseLabScenarioIdV1 = recordParser(labScenarioIdV1Schema);
export const parseLabOrderStateV1 = recordParser(labOrderStateV1Schema);
export const parseLabOrderLineItemV1 = recordParser(labOrderLineItemV1Schema);
export const parseLabOrderV1 = recordParser(labOrderV1Schema);
export const parseLabOrderLifecycleV1 = recordParser(labOrderLifecycleV1Schema);
export const parseLabPaymentV1 = recordParser(labPaymentV1Schema);
export const parseLabInventoryV1 = recordParser(labInventoryV1Schema);
export const parseLabInventoryObservedV1 = recordParser(
  labInventoryObservedV1Schema,
);
export const parseLabFulfillmentLineItemV1 = recordParser(
  labFulfillmentLineItemV1Schema,
);
export const parseLabFulfillmentV1 = recordParser(labFulfillmentV1Schema);
export const parseLabFulfillmentOverdueV1 = recordParser(
  labFulfillmentOverdueV1Schema,
);
export const parseLabFulfillmentHandedToCarrierV1 = recordParser(
  labFulfillmentHandedToCarrierV1Schema,
);
export const parseLabTrackingEventKindV1 = recordParser(
  labTrackingEventKindV1Schema,
);
export const parseLabTrackingEventV1 = recordParser(labTrackingEventV1Schema);
export const parseLabShipmentV1 = recordParser(labShipmentV1Schema);
export const parseLabEventV1 = recordParser(labEventV1Schema);
export const parseLabEventEnvelopeV1 = recordParser(labEventEnvelopeV1Schema);
