import type {
  LabCatalogItemV1,
  LabEventV1,
  LabScenarioIdV1,
  LabShipmentV1,
  LabTrackingEventKindV1,
  LabTrackingEventV1,
} from "@purin-labs/commerce-contracts";

import type { Result } from "@purin-labs/kernel/result";
import { COMMERCE_LAB_CATALOG_VERSION, COMMERCE_LAB_PRODUCTS } from "./catalog";
import type { VariantBy } from "@purin-labs/type-utils";
import { exhaustiveList } from "@purin-labs/std";

export const COMMERCE_LAB_SCENARIO_VERSION = 1 as const;

export const COMMERCE_LAB_SCENARIO_IDS = exhaustiveList<LabScenarioIdV1>()([
  "product-listing",
  "happy-order",
  "payment-failed",
  "inventory-shortage",
  "shipment-delayed",
  "cancellation-refund",
]);

export type CommerceLabScenarioId = (typeof COMMERCE_LAB_SCENARIO_IDS)[number];

declare const commerceLabIdempotencyKeyBrand: unique symbol;

export type CommerceLabIdempotencyKey = string & {
  readonly [commerceLabIdempotencyKeyBrand]: "CommerceLabIdempotencyKey";
};

type CommerceLabScenarioEventSpec =
  | {
      readonly eventType: "product_listed";
      readonly resourceId: "product_field_watch";
      readonly revision: 2 | 3;
      readonly atOffsetMs: number;
    }
  | {
      readonly eventType: "order_created";
      readonly resourceId: string;
      readonly revision: 1;
      readonly atOffsetMs: number;
      readonly customerId: "customer_lab_ada";
      readonly sku: "LAB-WATCH-FIELD-BLK";
      readonly quantity: number;
      readonly amountMinor: number;
      readonly currency: "USD";
    }
  | {
      readonly eventType: "order_fulfillment_pending" | "order_fulfilled";
      readonly resourceId: string;
      readonly revision: 2 | 3;
      readonly atOffsetMs: number;
      readonly customerId: "customer_lab_ada";
      readonly sku: "LAB-WATCH-FIELD-BLK";
      readonly quantity: number;
      readonly fulfilledQuantity: number;
      readonly amountMinor: number;
      readonly currency: "USD";
    }
  | {
      readonly eventType:
        "payment_captured" | "payment_failed" | "refund_completed";
      readonly resourceId: string;
      readonly revision: number;
      readonly atOffsetMs: number;
      readonly orderId: string;
      readonly paymentId: string;
      readonly amountMinor: number;
      readonly currency: "USD";
      readonly reason: string | null;
    }
  | {
      readonly eventType: "inventory_shortage";
      readonly resourceId: string;
      readonly revision: number;
      readonly atOffsetMs: number;
      readonly orderId: string;
      readonly sku: "LAB-WATCH-FIELD-BLK";
      readonly requested: number;
      readonly available: number;
      readonly locationId: "location_lab_main";
    }
  | {
      readonly eventType: "inventory_observed";
      readonly resourceId: string;
      readonly revision: 1;
      readonly atOffsetMs: number;
      readonly sku: "LAB-WATCH-FIELD-BLK";
      readonly available: number;
      readonly locationId: "location_lab_main";
    }
  | {
      readonly eventType: "cancellation_refund_proposed";
      readonly resourceId: string;
      readonly revision: number;
      readonly atOffsetMs: number;
      readonly orderId: string;
      readonly paymentId: string;
      readonly amountMinor: number;
      readonly currency: "USD";
      readonly reason: "customer_requested";
    }
  | {
      readonly eventType: "fulfillment_requested";
      readonly resourceId: string;
      readonly revision: 1;
      readonly atOffsetMs: number;
      readonly orderId: string;
      readonly locationId: "location_lab_main";
      readonly expectedByOffsetMs: number;
    }
  | {
      readonly eventType: "fulfillment_handed_to_carrier";
      readonly resourceId: string;
      readonly revision: 2;
      readonly atOffsetMs: number;
      readonly orderId: string;
      readonly locationId: "location_lab_main";
      readonly expectedByOffsetMs: number;
      readonly shipmentId: string;
    }
  | {
      readonly eventType:
        | "shipment_label_created"
        | "shipment_in_transit"
        | "tracking_stalled"
        | "delivery_exception"
        | "shipment_delivered"
        | "shipment_returned";
      readonly resourceId: string;
      readonly revision: number;
      readonly atOffsetMs: number;
      readonly orderId: string;
      readonly fulfillmentId: string;
      readonly trackingNumber: string;
      readonly reason: string | null;
    };

type ShipmentScenarioEventType = Extract<
  CommerceLabScenarioEventSpec,
  { readonly trackingNumber: string }
>["eventType"];

export type ExpectedCommerceProjection = {
  readonly kind:
    | "product"
    | "inventory_position"
    | "commerce_order"
    | "payment"
    | "fulfillment"
    | "shipment";
  readonly canonicalId: string;
  readonly lifecycle: string;
};

export type ExpectedCommerceSlackEffect =
  | { readonly kind: "none" }
  | {
      readonly kind: "proposal";
      readonly eventType:
        | "payment_failed"
        | "inventory_shortage"
        | "tracking_stalled"
        | "delivery_exception"
        | "cancellation_refund_proposed";
      readonly canonicalId: string;
    };

export type CommerceLabPublicationProposal =
  | { readonly kind: "none" }
  | {
      readonly kind: "catalog_publication";
      readonly actionId: "commerce_lab_publish_offer_field_watch_black_r2";
      readonly provider: "lab";
      readonly productId: "product_field_watch";
      readonly productRevision: 2;
      readonly variantId: "variant_field_watch_black";
      readonly variantRevision: 2;
      readonly offerId: "offer_variant_field_watch_black_lab_online";
      readonly offerRevision: 2;
      readonly salesChannelId: "sales_channel_lab_online";
      readonly salesChannelRevision: 2;
      readonly desiredLifecycle: "listed";
      readonly providerEventId: string;
    };

type CommerceLabScenario = {
  readonly scenarioId: CommerceLabScenarioId;
  readonly scenarioVersion: typeof COMMERCE_LAB_SCENARIO_VERSION;
  readonly catalogVersion: typeof COMMERCE_LAB_CATALOG_VERSION;
  readonly events: readonly CommerceLabScenarioEventSpec[];
  readonly expectedProjections: readonly ExpectedCommerceProjection[];
  readonly expectedSlackEffect: ExpectedCommerceSlackEffect;
  readonly publicationProposal:
    | { readonly kind: "none" }
    | {
        readonly kind: "catalog_publication";
        readonly actionId: "commerce_lab_publish_offer_field_watch_black_r2";
        readonly provider: "lab";
        readonly productId: "product_field_watch";
        readonly productRevision: 2;
        readonly variantId: "variant_field_watch_black";
        readonly variantRevision: 2;
        readonly offerId: "offer_variant_field_watch_black_lab_online";
        readonly offerRevision: 2;
        readonly salesChannelId: "sales_channel_lab_online";
        readonly salesChannelRevision: 2;
        readonly desiredLifecycle: "listed";
        readonly eventIndex: 0;
      };
};

type CommerceLabScenarioRun = {
  readonly runId: string;
  readonly scenarioId: CommerceLabScenarioId;
  readonly scenarioVersion: typeof COMMERCE_LAB_SCENARIO_VERSION;
  readonly catalogVersion: typeof COMMERCE_LAB_CATALOG_VERSION;
  readonly idempotencyKey: CommerceLabIdempotencyKey;
  readonly providerEventIds: readonly string[];
  readonly events: readonly CommerceLabScenarioRunEvent[];
  readonly expectedProjections: readonly ExpectedCommerceProjection[];
  readonly expectedSlackEffect: ExpectedCommerceSlackEffect;
  readonly publicationProposal: CommerceLabPublicationProposal;
};

type CommerceLabScenarioRunEvent = LabEventV1;

type CommerceLabScenarioError =
  | { readonly code: "scenario_id_invalid" }
  | { readonly code: "idempotency_key_invalid" }
  | { readonly code: "started_at_invalid" };

const HAPPY_ORDER_EVENTS = [
  {
    eventType: "product_listed",
    resourceId: "product_field_watch",
    revision: 3,
    atOffsetMs: 0,
  },
  ...orderPreparationEvents("happy"),
  shipmentEvent(
    "shipment_delivered",
    "shipment_lab_happy",
    3,
    5_000,
    "order_lab_happy",
    "fulfillment_lab_happy",
    null,
  ),
  orderLifecycleEvent(
    "order_fulfilled",
    "order_lab_happy",
    3,
    6_000,
    1,
    1,
    42_500,
  ),
] as const satisfies readonly CommerceLabScenarioEventSpec[];

const DELAYED_ORDER_EVENTS = orderPreparationEvents("delayed");

function orderPreparationEvents(
  suffix: "happy" | "delayed",
): readonly CommerceLabScenarioEventSpec[] {
  const orderId = `order_lab_${suffix}`;
  const paymentId = `payment_lab_${suffix}`;
  const fulfillmentId = `fulfillment_lab_${suffix}`;
  const shipmentId = `shipment_lab_${suffix}`;
  return [
    orderCreated(orderId, 0, 1, 42_500),
    paymentEvent("payment_captured", paymentId, 1_000, orderId, null),
    orderLifecycleEvent(
      "order_fulfillment_pending",
      orderId,
      2,
      1_500,
      1,
      0,
      42_500,
    ),
    fulfillmentRequested(fulfillmentId, 2_000, orderId),
    shipmentEvent(
      "shipment_label_created",
      shipmentId,
      1,
      3_000,
      orderId,
      fulfillmentId,
      null,
    ),
    fulfillmentHandedToCarrier(fulfillmentId, 2, 3_500, orderId, shipmentId),
    shipmentEvent(
      "shipment_in_transit",
      shipmentId,
      2,
      4_000,
      orderId,
      fulfillmentId,
      null,
    ),
  ];
}

const COMMERCE_LAB_SCENARIOS = [
  {
    scenarioId: "product-listing",
    scenarioVersion: COMMERCE_LAB_SCENARIO_VERSION,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    events: [
      {
        eventType: "product_listed",
        resourceId: "product_field_watch",
        revision: 2,
        atOffsetMs: 0,
      },
      {
        eventType: "inventory_observed",
        resourceId: "inventory_lab_field_black",
        revision: 1,
        atOffsetMs: 1_000,
        sku: "LAB-WATCH-FIELD-BLK",
        available: 12,
        locationId: "location_lab_main",
      },
    ],
    expectedProjections: [
      {
        kind: "product",
        canonicalId: "product_field_watch",
        lifecycle: "active",
      },
      {
        kind: "inventory_position",
        canonicalId: "inventory_lab_field_black",
        lifecycle: "in_stock",
      },
    ],
    expectedSlackEffect: { kind: "none" },
    publicationProposal: {
      kind: "catalog_publication",
      actionId: "commerce_lab_publish_offer_field_watch_black_r2",
      provider: "lab",
      productId: "product_field_watch",
      productRevision: 2,
      variantId: "variant_field_watch_black",
      variantRevision: 2,
      offerId: "offer_variant_field_watch_black_lab_online",
      offerRevision: 2,
      salesChannelId: "sales_channel_lab_online",
      salesChannelRevision: 2,
      desiredLifecycle: "listed",
      eventIndex: 0,
    },
  },
  {
    scenarioId: "happy-order",
    scenarioVersion: COMMERCE_LAB_SCENARIO_VERSION,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    events: HAPPY_ORDER_EVENTS,
    expectedProjections: [
      {
        kind: "commerce_order",
        canonicalId: "order_lab_happy",
        lifecycle: "fulfilled",
      },
      {
        kind: "payment",
        canonicalId: "payment_lab_happy",
        lifecycle: "captured",
      },
      {
        kind: "fulfillment",
        canonicalId: "fulfillment_lab_happy",
        lifecycle: "handed_to_carrier",
      },
      {
        kind: "shipment",
        canonicalId: "shipment_lab_happy",
        lifecycle: "delivered",
      },
    ],
    expectedSlackEffect: { kind: "none" },
    publicationProposal: { kind: "none" },
  },
  {
    scenarioId: "payment-failed",
    scenarioVersion: COMMERCE_LAB_SCENARIO_VERSION,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    events: [
      orderCreated("order_lab_payment_failed", 0, 1, 42_500),
      paymentEvent(
        "payment_failed",
        "payment_lab_failed",
        1_000,
        "order_lab_payment_failed",
        "card_declined",
      ),
    ],
    expectedProjections: [
      {
        kind: "commerce_order",
        canonicalId: "order_lab_payment_failed",
        lifecycle: "confirmed",
      },
      {
        kind: "payment",
        canonicalId: "payment_lab_failed",
        lifecycle: "failed",
      },
    ],
    expectedSlackEffect: {
      kind: "proposal",
      eventType: "payment_failed",
      canonicalId: "payment_lab_failed",
    },
    publicationProposal: { kind: "none" },
  },
  {
    scenarioId: "inventory-shortage",
    scenarioVersion: COMMERCE_LAB_SCENARIO_VERSION,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    events: [
      orderCreated("order_lab_shortage", 0, 20, 850_000),
      orderLifecycleEvent(
        "order_fulfillment_pending",
        "order_lab_shortage",
        2,
        500,
        20,
        0,
        850_000,
      ),
      {
        eventType: "inventory_shortage",
        resourceId: "inventory_lab_field_black",
        revision: 2,
        atOffsetMs: 1_000,
        orderId: "order_lab_shortage",
        sku: "LAB-WATCH-FIELD-BLK",
        requested: 20,
        available: 12,
        locationId: "location_lab_main",
      },
    ],
    expectedProjections: [
      {
        kind: "commerce_order",
        canonicalId: "order_lab_shortage",
        lifecycle: "fulfillment_pending",
      },
      {
        kind: "inventory_position",
        canonicalId: "inventory_lab_field_black",
        lifecycle: "in_stock",
      },
    ],
    expectedSlackEffect: {
      kind: "proposal",
      eventType: "inventory_shortage",
      canonicalId: "inventory_lab_field_black",
    },
    publicationProposal: { kind: "none" },
  },
  {
    scenarioId: "shipment-delayed",
    scenarioVersion: COMMERCE_LAB_SCENARIO_VERSION,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    events: [
      ...DELAYED_ORDER_EVENTS,
      shipmentEvent(
        "delivery_exception",
        "shipment_lab_delayed",
        3,
        86_401_000,
        "order_lab_delayed",
        "fulfillment_lab_delayed",
        "carrier_delay_exception",
      ),
    ],
    expectedProjections: [
      {
        kind: "shipment",
        canonicalId: "shipment_lab_delayed",
        lifecycle: "delivery_exception",
      },
    ],
    expectedSlackEffect: {
      kind: "proposal",
      eventType: "delivery_exception",
      canonicalId: "shipment_lab_delayed",
    },
    publicationProposal: { kind: "none" },
  },
  {
    scenarioId: "cancellation-refund",
    scenarioVersion: COMMERCE_LAB_SCENARIO_VERSION,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    events: [
      orderCreated("order_lab_cancelled", 0, 1, 42_500),
      paymentEvent(
        "payment_captured",
        "payment_lab_cancelled",
        1_000,
        "order_lab_cancelled",
        null,
      ),
      {
        eventType: "cancellation_refund_proposed",
        resourceId: "payment_lab_cancelled",
        revision: 2,
        atOffsetMs: 2_000,
        orderId: "order_lab_cancelled",
        paymentId: "payment_lab_cancelled",
        amountMinor: 42_500,
        currency: "USD",
        reason: "customer_requested",
      },
    ],
    expectedProjections: [
      {
        kind: "commerce_order",
        canonicalId: "order_lab_cancelled",
        lifecycle: "confirmed",
      },
      {
        kind: "payment",
        canonicalId: "payment_lab_cancelled",
        lifecycle: "captured",
      },
    ],
    expectedSlackEffect: {
      kind: "proposal",
      eventType: "cancellation_refund_proposed",
      canonicalId: "payment_lab_cancelled",
    },
    publicationProposal: { kind: "none" },
  },
] as const satisfies readonly CommerceLabScenario[];

export function parseCommerceLabScenarioId(
  raw: string,
): Result<CommerceLabScenarioId, CommerceLabScenarioError> {
  for (const scenarioId of COMMERCE_LAB_SCENARIO_IDS) {
    if (scenarioId === raw) {
      return { ok: true, value: scenarioId };
    }
  }

  return { ok: false, error: { code: "scenario_id_invalid" } };
}

export function parseCommerceLabIdempotencyKey(
  raw: string,
): Result<CommerceLabIdempotencyKey, CommerceLabScenarioError> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u.test(raw)) {
    return { ok: false, error: { code: "idempotency_key_invalid" } };
  }

  return { ok: true, value: raw as CommerceLabIdempotencyKey };
}

function getCommerceLabScenario(
  scenarioId: CommerceLabScenarioId,
): CommerceLabScenario {
  for (const scenario of COMMERCE_LAB_SCENARIOS) {
    if (scenario.scenarioId === scenarioId) {
      return scenario;
    }
  }

  throw new Error(`commerce_lab_scenario_missing:${scenarioId}`);
}

export function createCommerceLabScenarioRun(input: {
  readonly scenarioId: CommerceLabScenarioId;
  readonly idempotencyKey: CommerceLabIdempotencyKey;
  readonly startedAt: number;
}): Result<CommerceLabScenarioRun, CommerceLabScenarioError> {
  if (!Number.isSafeInteger(input.startedAt) || input.startedAt < 0) {
    return { ok: false, error: { code: "started_at_invalid" } };
  }

  const scenario = getCommerceLabScenario(input.scenarioId);
  const runId = `commerce_lab_run_${input.scenarioId}_${input.idempotencyKey}`;
  const events: CommerceLabScenarioRunEvent[] = [];
  const providerEventIds: string[] = [];

  for (let index = 0; index < scenario.events.length; index += 1) {
    const spec = scenario.events[index];

    if (spec === undefined) {
      throw new Error("commerce_lab_event_index_invalid");
    }

    const providerEventId = `${runId}_event_${index + 1}`;
    providerEventIds.push(providerEventId);
    events.push(buildLabEvent(spec, providerEventId, input.startedAt, events));
  }

  return {
    ok: true,
    value: {
      runId,
      scenarioId: input.scenarioId,
      scenarioVersion: scenario.scenarioVersion,
      catalogVersion: scenario.catalogVersion,
      idempotencyKey: input.idempotencyKey,
      providerEventIds,
      events,
      expectedProjections: scenario.expectedProjections,
      expectedSlackEffect: scenario.expectedSlackEffect,
      publicationProposal: publicationProposalForRun(
        scenario.publicationProposal,
        providerEventIds,
      ),
    },
  };
}

function publicationProposalForRun(
  proposal: CommerceLabScenario["publicationProposal"],
  providerEventIds: readonly string[],
): CommerceLabPublicationProposal {
  if (proposal.kind === "none") {
    return proposal;
  }
  const providerEventId = providerEventIds[proposal.eventIndex];
  if (providerEventId === undefined) {
    throw new Error("commerce_lab_publication_event_missing");
  }
  return {
    kind: proposal.kind,
    actionId: proposal.actionId,
    provider: proposal.provider,
    productId: proposal.productId,
    productRevision: proposal.productRevision,
    variantId: proposal.variantId,
    variantRevision: proposal.variantRevision,
    offerId: proposal.offerId,
    offerRevision: proposal.offerRevision,
    salesChannelId: proposal.salesChannelId,
    salesChannelRevision: proposal.salesChannelRevision,
    desiredLifecycle: proposal.desiredLifecycle,
    providerEventId,
  };
}

function buildLabEvent(
  spec: CommerceLabScenarioEventSpec,
  eventId: string,
  startedAt: number,
  priorEvents: readonly LabEventV1[],
): LabEventV1 {
  const occurredAt = new Date(startedAt + spec.atOffsetMs).toISOString();
  switch (spec.eventType) {
    case "product_listed":
      return {
        kind: "catalog_item_listed",
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: labCatalogItem(),
      };
    case "order_created":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: {
          id: spec.resourceId,
          checkoutId: `checkout_${spec.resourceId}`,
          customerReference: spec.customerId,
          currency: spec.currency,
          totalAmountMinor: spec.amountMinor,
          state: "confirmed",
          lineItems: [
            {
              id: `line_${spec.resourceId}_1`,
              variantId: "variant_field_watch_black",
              sku: spec.sku,
              title: "Field Watch — Black dial",
              quantity: spec.quantity,
              fulfilledQuantity: 0,
              unitAmountMinor: 42_500,
            },
          ],
        },
      };
    case "order_fulfillment_pending":
    case "order_fulfilled":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: {
          id: spec.resourceId,
          checkoutId: `checkout_${spec.resourceId}`,
          customerReference: spec.customerId,
          currency: spec.currency,
          totalAmountMinor: spec.amountMinor,
          lineItems: [
            {
              id: `line_${spec.resourceId}_1`,
              variantId: "variant_field_watch_black",
              sku: spec.sku,
              title: "Field Watch — Black dial",
              quantity: spec.quantity,
              fulfilledQuantity: spec.fulfilledQuantity,
              unitAmountMinor: 42_500,
            },
          ],
        },
      };
    case "payment_captured":
    case "payment_failed":
    case "refund_completed":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: labPaymentPayload(spec),
      };
    case "inventory_shortage":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: {
          resourceId: spec.resourceId,
          orderId: spec.orderId,
          variantId: "variant_field_watch_black",
          sku: spec.sku,
          requested: spec.requested,
          available: spec.available,
          locationId: spec.locationId,
        },
      };
    case "inventory_observed":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: {
          resourceId: spec.resourceId,
          variantId: "variant_field_watch_black",
          sku: spec.sku,
          locationId: spec.locationId,
          available: spec.available,
        },
      };
    case "cancellation_refund_proposed":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: labPaymentPayload(spec),
      };
    case "fulfillment_requested":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: {
          resourceId: spec.resourceId,
          orderId: spec.orderId,
          locationId: spec.locationId,
          expectedBy: new Date(
            startedAt + spec.atOffsetMs + spec.expectedByOffsetMs,
          ).toISOString(),
          lineItems: [{ lineItemId: `line_${spec.orderId}_1`, quantity: 1 }],
        },
      };
    case "fulfillment_handed_to_carrier":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: {
          resourceId: spec.resourceId,
          orderId: spec.orderId,
          locationId: spec.locationId,
          expectedBy: new Date(
            startedAt + spec.atOffsetMs + spec.expectedByOffsetMs,
          ).toISOString(),
          shipmentId: spec.shipmentId,
          lineItems: [{ lineItemId: `line_${spec.orderId}_1`, quantity: 1 }],
        },
      };
    case "shipment_label_created":
    case "shipment_in_transit":
    case "tracking_stalled":
    case "delivery_exception":
    case "shipment_delivered":
    case "shipment_returned":
      return {
        kind: spec.eventType,
        eventId,
        revision: spec.revision,
        occurredAt,
        payload: labShipmentPayload(spec, eventId, occurredAt, priorEvents),
      };
  }
}

function labCatalogItem(): LabCatalogItemV1 {
  const product = COMMERCE_LAB_PRODUCTS[0];
  if (product === undefined) {
    throw new Error("commerce_lab_catalog_empty");
  }
  const variants: LabCatalogItemV1["variants"] = [];
  for (const variant of product.variants) {
    const options: LabCatalogItemV1["variants"][number]["options"] = [];
    for (const [name, value] of Object.entries(variant.optionValues)) {
      options.push({ name, value });
    }
    variants.push({
      variantId: variant.variantId,
      sku: variant.sku,
      title: variant.title,
      amountMinor: variant.price.amountMinor,
      currency: variant.price.currency,
      available: variant.initialQuantity > 0,
      options,
      media: [
        {
          kind: "image",
          url: product.imageUrl,
          altText: product.title,
        },
      ],
    });
  }
  return {
    resourceId: product.productId,
    title: product.title,
    description: product.description,
    variants,
  };
}

function labPaymentPayload(
  spec: VariantBy<
    CommerceLabScenarioEventSpec,
    "eventType",
    | "payment_captured"
    | "payment_failed"
    | "refund_completed"
    | "cancellation_refund_proposed"
  >,
): {
  readonly resourceId: string;
  readonly orderId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
} {
  return {
    resourceId: spec.paymentId,
    orderId: spec.orderId,
    amountMinor: spec.amountMinor,
    currency: spec.currency,
    reason: spec.reason ?? "",
  };
}

function labShipmentPayload(
  spec: Extract<
    CommerceLabScenarioEventSpec,
    { readonly trackingNumber: string }
  >,
  eventId: string,
  occurredAt: string,
  priorEvents: readonly LabEventV1[],
): LabShipmentV1 {
  const trackingEvents = priorTrackingEvents(priorEvents, spec.resourceId);
  trackingEvents.push({
    eventId: `${eventId}_tracking`,
    occurredAt,
    kind: trackingKind(spec.eventType),
    reason: spec.reason ?? "",
    location: "Pantry lab carrier network",
  });
  return {
    resourceId: spec.resourceId,
    orderId: spec.orderId,
    fulfillmentId: spec.fulfillmentId,
    carrier: "Pantry Lab Carrier",
    trackingNumber: spec.trackingNumber,
    estimatedDeliveryAt: new Date(
      Date.parse(occurredAt) + 2 * 86_400_000,
    ).toISOString(),
    reason: spec.reason ?? "",
    trackingEvents,
  };
}

function priorTrackingEvents(
  events: readonly LabEventV1[],
  resourceId: string,
): LabTrackingEventV1[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || !isShipmentLabEvent(event)) {
      continue;
    }
    if (event.payload.resourceId === resourceId) {
      return [...event.payload.trackingEvents];
    }
  }
  return [];
}

function isShipmentLabEvent(
  event: LabEventV1,
): event is VariantBy<LabEventV1, "payload", LabShipmentV1> {
  return (
    event.kind === "shipment_label_created" ||
    event.kind === "shipment_in_transit" ||
    event.kind === "tracking_stalled" ||
    event.kind === "delivery_exception" ||
    event.kind === "shipment_delivered" ||
    event.kind === "shipment_returned"
  );
}

function trackingKind(
  eventType: ShipmentScenarioEventType,
): LabTrackingEventKindV1 {
  switch (eventType) {
    case "shipment_label_created":
      return "label_created";
    case "shipment_in_transit":
    case "tracking_stalled":
      return "in_transit";
    case "delivery_exception":
      return "delivery_exception";
    case "shipment_delivered":
      return "delivered";
    case "shipment_returned":
      return "returned";
  }
}

function orderCreated(
  resourceId: string,
  atOffsetMs: number,
  quantity: number,
  amountMinor: number,
): VariantBy<CommerceLabScenarioEventSpec, "eventType", "order_created"> {
  return {
    eventType: "order_created",
    resourceId,
    revision: 1,
    atOffsetMs,
    customerId: "customer_lab_ada",
    sku: "LAB-WATCH-FIELD-BLK",
    quantity,
    amountMinor,
    currency: "USD",
  };
}

function paymentEvent(
  eventType: "payment_captured" | "payment_failed" | "refund_completed",
  resourceId: string,
  atOffsetMs: number,
  orderId: string,
  reason: string | null,
): VariantBy<
  CommerceLabScenarioEventSpec,
  "eventType",
  "payment_captured" | "payment_failed" | "refund_completed"
> {
  return {
    eventType,
    resourceId,
    revision: eventType === "refund_completed" ? 2 : 1,
    atOffsetMs,
    orderId,
    paymentId: resourceId,
    amountMinor: 42_500,
    currency: "USD",
    reason,
  };
}

function orderLifecycleEvent(
  eventType: "order_fulfillment_pending" | "order_fulfilled",
  resourceId: string,
  revision: 2 | 3,
  atOffsetMs: number,
  quantity: number,
  fulfilledQuantity: number,
  amountMinor: number,
): VariantBy<
  CommerceLabScenarioEventSpec,
  "eventType",
  "order_fulfillment_pending" | "order_fulfilled"
> {
  return {
    eventType,
    resourceId,
    revision,
    atOffsetMs,
    customerId: "customer_lab_ada",
    sku: "LAB-WATCH-FIELD-BLK",
    quantity,
    fulfilledQuantity,
    amountMinor,
    currency: "USD",
  };
}

function fulfillmentRequested(
  resourceId: string,
  atOffsetMs: number,
  orderId: string,
): VariantBy<
  CommerceLabScenarioEventSpec,
  "eventType",
  "fulfillment_requested"
> {
  return {
    eventType: "fulfillment_requested",
    resourceId,
    revision: 1,
    atOffsetMs,
    orderId,
    locationId: "location_lab_main",
    expectedByOffsetMs: 3 * 86_400_000,
  };
}

function fulfillmentHandedToCarrier(
  resourceId: string,
  revision: 2,
  atOffsetMs: number,
  orderId: string,
  shipmentId: string,
): VariantBy<
  CommerceLabScenarioEventSpec,
  "eventType",
  "fulfillment_handed_to_carrier"
> {
  return {
    eventType: "fulfillment_handed_to_carrier",
    resourceId,
    revision,
    atOffsetMs,
    orderId,
    locationId: "location_lab_main",
    expectedByOffsetMs: 3 * 86_400_000,
    shipmentId,
  };
}

function shipmentEvent(
  eventType: ShipmentScenarioEventType,
  resourceId: string,
  revision: number,
  atOffsetMs: number,
  orderId: string,
  fulfillmentId: string,
  reason: string | null,
): VariantBy<
  CommerceLabScenarioEventSpec,
  "eventType",
  | "shipment_label_created"
  | "shipment_in_transit"
  | "tracking_stalled"
  | "delivery_exception"
  | "shipment_delivered"
  | "shipment_returned"
> {
  return {
    eventType,
    resourceId,
    revision,
    atOffsetMs,
    orderId,
    fulfillmentId,
    trackingNumber: "PANTRYLAB0001",
    reason,
  };
}
