import type {
  ShopifyFulfillmentLifecycleV202607,
  ShopifyPaymentLifecycleV202607,
  ShopifyResourceEnvelopeV202607,
  ShopifyShipmentLifecycleV202607,
  ShopifyTrackingEventKindV202607,
  ShopifyTrackingEventV202607,
} from "@purin-labs/commerce-contracts";
import type { JsonObject } from "../../http";
import type { IntegrationAccountId, OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { Variant } from "@purin-labs/type-utils";
import { isNonEmptyString, isRecord } from "@purin-labs/std";
import type {
  ShopifyCommerceOrderEnvelope,
  ShopifyInitialSyncError,
} from "../connector";
import {
  SHOPIFY_ADMIN_API_VERSION,
  initialResourceContext,
  isUnpaginatedConnection,
  parseInitialPageInfo,
  shopifyGraphqlGid,
} from "./admin-graphql";
import { createInitialShopifyResourceEnvelope } from "./catalog-snapshot";
import { normalizedShopifyTimestamp, shopifyRevision } from "./values";

export function parseInitialOrdersPage(input: {
  readonly raw: JsonObject;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  {
    readonly items: readonly {
      readonly order: ShopifyCommerceOrderEnvelope;
      readonly resources: readonly ShopifyResourceEnvelopeV202607[];
    }[];
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  },
  ShopifyInitialSyncError
> {
  const connection = input.raw.data;
  if (
    !isRecord(connection) ||
    !isRecord(connection.orders) ||
    !Array.isArray(connection.orders.nodes)
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }
  const pageInfo = parseInitialPageInfo(connection.orders.pageInfo);
  if (!pageInfo.ok) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }

  const items: Array<{
    readonly order: ShopifyCommerceOrderEnvelope;
    readonly resources: readonly ShopifyResourceEnvelopeV202607[];
  }> = [];
  for (const node of connection.orders.nodes) {
    const item = parseInitialOrder({
      raw: node,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!item.ok) continue;
    items.push(item.value);
  }

  return { ok: true, value: { items, ...pageInfo.value } };
}

export function parseInitialOrder(input: {
  readonly raw: unknown;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<
  {
    readonly order: ShopifyCommerceOrderEnvelope;
    readonly resources: readonly ShopifyResourceEnvelopeV202607[];
  },
  ShopifyInitialSyncError
> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    typeof input.raw.name !== "string" ||
    typeof input.raw.createdAt !== "string" ||
    typeof input.raw.updatedAt !== "string" ||
    !isRecord(input.raw.currentTotalPriceSet) ||
    !isRecord(input.raw.currentTotalPriceSet.shopMoney) ||
    typeof input.raw.currentTotalPriceSet.shopMoney.amount !== "string" ||
    typeof input.raw.currentTotalPriceSet.shopMoney.currencyCode !== "string" ||
    !isRecord(input.raw.lineItems) ||
    !Array.isArray(input.raw.lineItems.nodes)
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }

  const id = shopifyGraphqlGid(input.raw.id, "Order");
  const currency = input.raw.currentTotalPriceSet.shopMoney.currencyCode;
  if (id === null || !/^[A-Za-z]{3}$/u.test(currency)) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }
  const occurredAt = normalizedShopifyTimestamp(
    input.raw.updatedAt,
    new Date(input.observedAt).toISOString(),
  );
  const lineItems: Array<
    ShopifyCommerceOrderEnvelope["order"]["lineItems"][number]
  > = [];
  for (const rawLine of input.raw.lineItems.nodes) {
    if (
      !isRecord(rawLine) ||
      typeof rawLine.id !== "string" ||
      typeof rawLine.title !== "string" ||
      typeof rawLine.quantity !== "number" ||
      !Number.isSafeInteger(rawLine.quantity) ||
      rawLine.quantity <= 0 ||
      !isRecord(rawLine.originalUnitPriceSet) ||
      !isRecord(rawLine.originalUnitPriceSet.shopMoney) ||
      typeof rawLine.originalUnitPriceSet.shopMoney.amount !== "string"
    ) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "orders",
        },
      };
    }
    const lineId = shopifyGraphqlGid(rawLine.id, "LineItem");
    if (lineId === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "orders",
        },
      };
    }
    const variantId =
      isRecord(rawLine.variant) && typeof rawLine.variant.id === "string"
        ? shopifyGraphqlGid(rawLine.variant.id, "ProductVariant")
        : null;
    const sku =
      typeof rawLine.sku === "string" && rawLine.sku.length > 0
        ? rawLine.sku
        : null;
    if (sku === null) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "orders",
        },
      };
    }
    lineItems.push({
      id: lineId,
      variantId,
      sku,
      title: rawLine.title,
      quantity: rawLine.quantity,
      fulfilledQuantity: 0,
      price: rawLine.originalUnitPriceSet.shopMoney.amount,
    });
  }
  if (lineItems.length === 0) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }

  const cancelledAt =
    input.raw.cancelledAt === null || input.raw.cancelledAt === undefined
      ? { kind: "active" as const }
      : typeof input.raw.cancelledAt === "string"
        ? {
            kind: "cancelled" as const,
            cancelledAt: normalizedShopifyTimestamp(
              input.raw.cancelledAt,
              occurredAt,
            ),
            reason: "shopify_order_cancelled",
          }
        : null;
  if (cancelledAt === null) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }

  const resources = parseInitialOrderResources({
    raw: input.raw,
    orderId: id,
    currency,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    observedAt: input.observedAt,
    occurredAt,
  });
  if (!resources.ok) {
    return resources;
  }

  return {
    ok: true,
    value: {
      order: {
        apiVersion: SHOPIFY_ADMIN_API_VERSION,
        context: {
          organisationId: input.organisationId,
          integrationAccountId: input.integrationAccountId,
          revision: shopifyRevision(occurredAt),
          occurredAt,
          observedAt: new Date(input.observedAt).toISOString(),
          eventId: `shopify:initial:order:${id}`,
          customerReference: `shopify-order-${id}`,
        },
        order: {
          id,
          checkoutId: input.raw.name,
          currency: currency.toUpperCase(),
          totalPrice: input.raw.currentTotalPriceSet.shopMoney.amount,
          fulfillmentStatus: shopifyGraphqlFulfillmentStatus(
            input.raw.displayFulfillmentStatus,
          ),
          cancelledAt,
          lineItems,
        },
      },
      resources: resources.value,
    },
  };
}

function parseInitialOrderResources(input: {
  readonly raw: JsonObject;
  readonly orderId: string;
  readonly currency: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly occurredAt: string;
}): Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError> {
  const resources: ShopifyResourceEnvelopeV202607[] = [];
  if (input.raw.transactions !== undefined) {
    if (!Array.isArray(input.raw.transactions)) {
      return {
        ok: false,
        error: {
          code: "shopify_initial_sync_response_invalid",
          resource: "orders",
        },
      };
    }
    for (const node of input.raw.transactions) {
      const payment = parseInitialPaymentResource({
        raw: node,
        orderId: input.orderId,
        fallbackCurrency: input.currency,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        observedAt: input.observedAt,
        fallbackOccurredAt: input.occurredAt,
      });
      if (!payment.ok) return payment;
      if (payment.value !== null) resources.push(payment.value);
    }
  }
  const fulfillmentResources = parseInitialFulfillmentResources(input);
  if (!fulfillmentResources.ok) return fulfillmentResources;
  resources.push(...fulfillmentResources.value);
  return { ok: true, value: resources };
}

function parseInitialFulfillmentResources(input: {
  readonly raw: JsonObject;
  readonly orderId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError> {
  if (input.raw.fulfillments === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input.raw.fulfillments)) {
    return initialOrdersInvalid();
  }

  const resources: ShopifyResourceEnvelopeV202607[] = [];
  for (const raw of input.raw.fulfillments) {
    const parsed = parseInitialFulfillment({
      raw,
      orderId: input.orderId,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      observedAt: input.observedAt,
    });
    if (!parsed.ok) return parsed;
    resources.push(...parsed.value);
  }
  return { ok: true, value: resources };
}

function parseInitialFulfillment(input: {
  readonly raw: unknown;
  readonly orderId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
}): Result<readonly ShopifyResourceEnvelopeV202607[], ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    typeof input.raw.createdAt !== "string" ||
    typeof input.raw.updatedAt !== "string" ||
    typeof input.raw.status !== "string" ||
    (input.raw.displayStatus !== null &&
      typeof input.raw.displayStatus !== "string") ||
    (input.raw.inTransitAt !== null &&
      typeof input.raw.inTransitAt !== "string") ||
    (input.raw.deliveredAt !== null &&
      typeof input.raw.deliveredAt !== "string") ||
    (input.raw.estimatedDeliveryAt !== null &&
      typeof input.raw.estimatedDeliveryAt !== "string") ||
    !isRecord(input.raw.fulfillmentLineItems) ||
    !Array.isArray(input.raw.fulfillmentLineItems.nodes) ||
    !isUnpaginatedConnection(input.raw.fulfillmentLineItems) ||
    !Array.isArray(input.raw.trackingInfo) ||
    !isRecord(input.raw.events) ||
    !Array.isArray(input.raw.events.nodes) ||
    !isUnpaginatedConnection(input.raw.events)
  ) {
    return initialOrdersInvalid();
  }

  const fulfillmentId = shopifyGraphqlGid(input.raw.id, "Fulfillment");
  const locationId =
    isRecord(input.raw.location) && typeof input.raw.location.id === "string"
      ? shopifyGraphqlGid(input.raw.location.id, "Location")
      : null;
  if (
    fulfillmentId === null ||
    locationId === null ||
    input.raw.estimatedDeliveryAt === null
  ) {
    return { ok: true, value: [] };
  }

  const lineItems = parseInitialFulfillmentLineItems(
    input.raw.fulfillmentLineItems.nodes,
  );
  if (!lineItems.ok) return lineItems;
  const shipment = parseInitialShipment({
    raw: input.raw,
    orderId: input.orderId,
    fulfillmentId,
  });
  if (!shipment.ok) return shipment;

  const createdAt = normalizedShopifyTimestamp(
    input.raw.createdAt,
    new Date(input.observedAt).toISOString(),
  );
  const updatedAt = normalizedShopifyTimestamp(input.raw.updatedAt, createdAt);
  const lifecycle = initialFulfillmentLifecycle({
    status: input.raw.status,
    displayStatus: input.raw.displayStatus,
    createdAt,
    updatedAt,
    inTransitAt: input.raw.inTransitAt,
    deliveredAt: input.raw.deliveredAt,
    shipment: shipment.value,
  });
  if (lifecycle === null) return { ok: true, value: [] };

  const fulfillment: ShopifyResourceEnvelopeV202607 =
    createInitialShopifyResourceEnvelope({
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      occurredAt: updatedAt,
      observedAt: input.observedAt,
      eventId: `shopify:initial:fulfillment:${fulfillmentId}`,
      customerReference: `shopify-fulfillment-${fulfillmentId}`,
      resource: {
        kind: "fulfillment",
        resource: {
          id: fulfillmentId,
          orderId: input.orderId,
          locationId,
          expectedBy: normalizedShopifyTimestamp(
            input.raw.estimatedDeliveryAt,
            updatedAt,
          ),
          lineItems: lineItems.value,
          lifecycle,
          updatedAt,
        },
      },
    });
  if (shipment.value === null) return { ok: true, value: [fulfillment] };

  const shipmentEnvelope = createInitialShopifyResourceEnvelope({
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    occurredAt: updatedAt,
    observedAt: input.observedAt,
    eventId: `shopify:initial:shipment:${shipment.value.resource.resource.id}`,
    customerReference: `shopify-shipment-${shipment.value.resource.resource.id}`,
    resource: shipment.value.resource,
  });
  return { ok: true, value: [fulfillment, shipmentEnvelope] };
}

function parseInitialFulfillmentLineItems(
  raw: readonly unknown[],
): Result<
  Array<{ readonly lineItemId: string; readonly quantity: number }>,
  ShopifyInitialSyncError
> {
  const lineItems: Array<{
    readonly lineItemId: string;
    readonly quantity: number;
  }> = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.quantity !== "number" ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0 ||
      !isRecord(item.lineItem) ||
      typeof item.lineItem.id !== "string"
    ) {
      return initialOrdersInvalid();
    }
    const lineItemId = shopifyGraphqlGid(item.lineItem.id, "LineItem");
    if (lineItemId === null) return initialOrdersInvalid();
    lineItems.push({ lineItemId, quantity: item.quantity });
  }
  return lineItems.length > 0
    ? { ok: true, value: lineItems }
    : initialOrdersInvalid();
}

type ParsedInitialShipment = {
  readonly resource: Variant<
    ShopifyResourceEnvelopeV202607["resource"],
    "shipment"
  >;
  readonly carrierHandoffAt: string | null;
};

type InitialTrackingEventKind = Exclude<
  ShopifyTrackingEventKindV202607,
  { readonly state: "returned" }
>;

type InitialTrackingEvent = Omit<ShopifyTrackingEventV202607, "kind"> & {
  readonly kind: InitialTrackingEventKind;
};

function parseInitialShipment(input: {
  readonly raw: JsonObject;
  readonly orderId: string;
  readonly fulfillmentId: string;
}): Result<ParsedInitialShipment | null, ShopifyInitialSyncError> {
  if (
    !Array.isArray(input.raw.trackingInfo) ||
    input.raw.trackingInfo.length !== 1 ||
    !isRecord(input.raw.events) ||
    !Array.isArray(input.raw.events.nodes) ||
    input.raw.events.nodes.length === 0 ||
    input.raw.estimatedDeliveryAt === null ||
    typeof input.raw.estimatedDeliveryAt !== "string" ||
    typeof input.raw.updatedAt !== "string"
  ) {
    return { ok: true, value: null };
  }
  const tracking = input.raw.trackingInfo[0];
  if (
    !isRecord(tracking) ||
    typeof tracking.company !== "string" ||
    tracking.company.length === 0 ||
    typeof tracking.number !== "string" ||
    tracking.number.length === 0
  ) {
    return { ok: true, value: null };
  }

  const events: InitialTrackingEvent[] = [];
  let carrierHandoffAt: string | null = null;
  for (const rawEvent of input.raw.events.nodes) {
    const event = parseInitialTrackingEvent(rawEvent);
    if (!event.ok) return event;
    if (event.value === null) return { ok: true, value: null };
    events.push(event.value.event);
    if (carrierHandoffAt === null && event.value.carrierHandoff) {
      carrierHandoffAt = event.value.event.occurredAt;
    }
  }
  events.sort(compareTrackingEvents);
  const lastEvent = events.at(-1);
  if (lastEvent === undefined) return { ok: true, value: null };
  const lifecycle = shipmentLifecycleFromTrackingEvent(lastEvent);
  const shipmentId = shopifyShipmentId(input.fulfillmentId, tracking.number);
  return {
    ok: true,
    value: {
      resource: {
        kind: "shipment",
        resource: {
          id: shipmentId,
          orderId: input.orderId,
          fulfillmentId: input.fulfillmentId,
          carrier: tracking.company,
          trackingNumber: tracking.number,
          estimatedDeliveryAt: input.raw.estimatedDeliveryAt,
          events,
          lifecycle,
          updatedAt: input.raw.updatedAt,
        },
      },
      carrierHandoffAt,
    },
  };
}

function parseInitialTrackingEvent(raw: unknown): Result<
  {
    readonly event: InitialTrackingEvent;
    readonly carrierHandoff: boolean;
  } | null,
  ShopifyInitialSyncError
> {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.happenedAt !== "string" ||
    typeof raw.status !== "string" ||
    (raw.message !== null && typeof raw.message !== "string")
  ) {
    return initialOrdersInvalid();
  }
  const id = shopifyGraphqlGid(raw.id, "FulfillmentEvent");
  const location = trackingEventLocation(raw);
  const kind = initialTrackingEventKind(raw.status, raw.message);
  if (id === null) return initialOrdersInvalid();
  if (location === null || kind === null) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      event: {
        id,
        occurredAt: raw.happenedAt,
        kind,
        location,
      },
      carrierHandoff: [
        "CARRIER_PICKED_UP",
        "IN_TRANSIT",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
      ].includes(raw.status.toUpperCase()),
    },
  };
}

function initialTrackingEventKind(
  rawStatus: string,
  message: string | null,
): InitialTrackingEventKind | null {
  const status = rawStatus.toUpperCase();
  switch (status) {
    case "LABEL_PRINTED":
    case "LABEL_PURCHASED":
      return { state: "label_created" };
    case "CARRIER_PICKED_UP":
    case "IN_TRANSIT":
    case "OUT_FOR_DELIVERY":
      return { state: "in_transit" };
    case "ATTEMPTED_DELIVERY":
    case "DELAYED":
    case "FAILURE":
      return { state: "delivery_exception", reason: message ?? status };
    case "DELIVERED":
      return { state: "delivered" };
    case "CONFIRMED":
    case "READY_FOR_PICKUP":
      return null;
    default:
      return null;
  }
}

function shipmentLifecycleFromTrackingEvent(
  event: InitialTrackingEvent,
): ShopifyShipmentLifecycleV202607 {
  switch (event.kind.state) {
    case "label_created":
      return { state: "label_created", createdAt: event.occurredAt };
    case "in_transit":
      return { state: "in_transit", since: event.occurredAt };
    case "delivery_exception":
      return {
        state: "delivery_exception",
        occurredAt: event.occurredAt,
        reason: event.kind.reason,
      };
    case "delivered":
      return { state: "delivered", deliveredAt: event.occurredAt };
  }
}

function initialFulfillmentLifecycle(input: {
  readonly status: string;
  readonly displayStatus: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly inTransitAt: string | null;
  readonly deliveredAt: string | null;
  readonly shipment: ParsedInitialShipment | null;
}): ShopifyFulfillmentLifecycleV202607 | null {
  const status = input.status.toUpperCase();
  if (status === "CANCELLED") {
    return {
      state: "cancelled",
      cancelledAt: input.updatedAt,
      reason: "shopify_fulfillment_cancelled",
    };
  }
  if (status === "ERROR" || status === "FAILURE") {
    return { state: "blocked", blockedAt: input.updatedAt, reason: status };
  }
  if (status === "OPEN" || status === "PENDING") {
    return { state: "requested", requestedAt: input.createdAt };
  }
  if (status !== "SUCCESS" || input.displayStatus === null) return null;

  const displayStatus = input.displayStatus.toUpperCase();
  if (
    ["ATTEMPTED_DELIVERY", "DELAYED", "FAILURE", "NOT_DELIVERED"].includes(
      displayStatus,
    )
  ) {
    return {
      state: "blocked",
      blockedAt: input.updatedAt,
      reason: displayStatus,
    };
  }
  if (displayStatus === "CANCELED") {
    return {
      state: "cancelled",
      cancelledAt: input.updatedAt,
      reason: "shopify_fulfillment_cancelled",
    };
  }
  if (
    [
      "CARRIER_PICKED_UP",
      "IN_TRANSIT",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "PICKED_UP",
    ].includes(displayStatus) &&
    input.shipment !== null
  ) {
    const handedOverAt =
      input.inTransitAt ?? input.shipment.carrierHandoffAt ?? input.deliveredAt;
    return handedOverAt === null
      ? null
      : {
          state: "handed_to_carrier",
          handedOverAt,
          shipmentId: input.shipment.resource.resource.id,
        };
  }
  if (
    [
      "CONFIRMED",
      "FULFILLED",
      "LABEL_PRINTED",
      "LABEL_PURCHASED",
      "MARKED_AS_FULFILLED",
      "READY_FOR_PICKUP",
      "SUBMITTED",
    ].includes(displayStatus)
  ) {
    return { state: "preparing", startedAt: input.createdAt };
  }
  return null;
}

function trackingEventLocation(raw: JsonObject): string | null {
  const fields = [raw.address1, raw.city, raw.province, raw.country, raw.zip];
  const parts = fields.filter(isNonEmptyString);
  return parts.length > 0 ? parts.join(", ") : null;
}

function compareTrackingEvents(
  left: ShopifyTrackingEventV202607,
  right: ShopifyTrackingEventV202607,
): number {
  const timestamp = left.occurredAt.localeCompare(right.occurredAt);
  return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
}

function shopifyShipmentId(
  fulfillmentId: string,
  trackingNumber: string,
): string {
  return `${fulfillmentId}/shipment/${encodeURIComponent(trackingNumber)}`;
}

function initialOrdersInvalid(): Result<never, ShopifyInitialSyncError> {
  return {
    ok: false,
    error: {
      code: "shopify_initial_sync_response_invalid",
      resource: "orders",
    },
  };
}

function parseInitialPaymentResource(input: {
  readonly raw: unknown;
  readonly orderId: string;
  readonly fallbackCurrency: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: number;
  readonly fallbackOccurredAt: string;
}): Result<ShopifyResourceEnvelopeV202607 | null, ShopifyInitialSyncError> {
  if (
    !isRecord(input.raw) ||
    typeof input.raw.id !== "string" ||
    typeof input.raw.kind !== "string" ||
    typeof input.raw.status !== "string" ||
    !isRecord(input.raw.amountSet) ||
    !isRecord(input.raw.amountSet.shopMoney) ||
    typeof input.raw.amountSet.shopMoney.amount !== "string" ||
    typeof input.raw.amountSet.shopMoney.currencyCode !== "string" ||
    typeof input.raw.createdAt !== "string" ||
    (input.raw.processedAt !== null &&
      input.raw.processedAt !== undefined &&
      typeof input.raw.processedAt !== "string")
  ) {
    return {
      ok: false,
      error: {
        code: "shopify_initial_sync_response_invalid",
        resource: "orders",
      },
    };
  }
  const id = shopifyGraphqlGid(input.raw.id, "OrderTransaction");
  const currency =
    input.raw.amountSet.shopMoney.currencyCode || input.fallbackCurrency;
  if (id === null || !/^[A-Za-z]{3}$/u.test(currency))
    return { ok: true, value: null };
  const createdAt = normalizedShopifyTimestamp(
    input.raw.createdAt,
    input.fallbackOccurredAt,
  );
  const occurredAt = normalizedShopifyTimestamp(
    typeof input.raw.processedAt === "string"
      ? input.raw.processedAt
      : createdAt,
    createdAt,
  );
  const lifecycle = initialPaymentLifecycle(
    input.raw.kind,
    input.raw.status,
    occurredAt,
    input.raw.amountSet.shopMoney.amount,
  );
  if (lifecycle === null) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      apiVersion: SHOPIFY_ADMIN_API_VERSION,
      context: initialResourceContext({
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        occurredAt,
        observedAt: input.observedAt,
        eventId: `shopify:initial:payment:${id}`,
        customerReference: `shopify-payment-${id}`,
      }),
      resource: {
        kind: "payment",
        resource: {
          id,
          orderId: input.orderId,
          amount: input.raw.amountSet.shopMoney.amount,
          currency: currency.toUpperCase(),
          lifecycle,
          updatedAt: occurredAt,
        },
      },
    },
  };
}

function initialPaymentLifecycle(
  rawKind: string,
  rawStatus: string,
  occurredAt: string,
  amount: string,
): ShopifyPaymentLifecycleV202607 | null {
  const kind = rawKind.toUpperCase();
  const status = rawStatus.toUpperCase();
  if (status === "FAILURE" || status === "ERROR") {
    return { state: "failed", failedAt: occurredAt, reason: status };
  }
  if (status === "SUCCESS") {
    if (kind === "AUTHORIZATION")
      return { state: "authorized", authorizedAt: occurredAt };
    if (kind === "REFUND")
      return {
        state: "refunded",
        refundedAt: occurredAt,
        refundedAmount: amount,
      };
    if (kind === "CAPTURE" || kind === "SALE")
      return { state: "captured", capturedAt: occurredAt };
    return null;
  }
  if (
    status === "PENDING" ||
    status === "AWAITING_RESPONSE" ||
    status === "PROCESSING"
  ) {
    return { state: "pending", createdAt: occurredAt };
  }
  return null;
}

function shopifyGraphqlFulfillmentStatus(
  raw: unknown,
): ShopifyCommerceOrderEnvelope["order"]["fulfillmentStatus"] {
  switch (raw) {
    case "FULFILLED":
      return "fulfilled";
    case "PARTIALLY_FULFILLED":
      return "partial";
    default:
      return "unfulfilled";
  }
}
