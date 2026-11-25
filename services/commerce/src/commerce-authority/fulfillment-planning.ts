import {
  checkoutProfileOf,
  parseFulfillment,
  parseInventoryAllocation,
  parseInventoryMovement,
  parseOrder,
  parseShipment,
  type CompleteCommercePickupV1,
  type AttachFulfillmentTrackingCommand,
  type MarkCommercePickupReadyV1,
  type QuoteShipmentLabelRateCommand,
  type RecordShippingTrackingCommand,
  type CommerceResourcesV1,
  type CommerceFulfillmentV1,
  type CommercePickupFulfillmentV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceMutationErrorV1,
  type CommerceOrderV1,
  type CommercePaymentV1,
  type CommerceFirstPartyShipmentV1,
  orderOriginCheckoutId,
} from "@purin-labs/commerce-client";
import {
  commerceTransition,
  type CommerceInvalidTransition,
  type InventoryAllocation,
  type ShippingQuoteSnapshot,
  type ShippingRouteBinding,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../database.ts";
import {
  listInventoryLots,
  readInventoryItem,
  readInventoryPositionForItemLocation,
} from "../inventory-persistence.ts";
import {
  readCheckout,
  readInventoryAllocation,
} from "../checkout-persistence.ts";
import {
  accountedPositionCanCommit,
  committedInventoryPosition,
  isAccountedPosition,
  planSaleLotConsumption,
} from "./inventory-planning.ts";
import {
  checkoutOrderMatchesCheckout,
  checkoutOrderProfileMatches,
  findResource,
  orderFactsKept,
  orderLineIdFor,
  sha256,
} from "./checkout-shared.ts";
import type { ShippingLabelRateRequest } from "../shipping-gateway.ts";
import type { Variant } from "@purin-labs/type-utils";
import { orderMatchesAccepted, readAcceptedOrder, type AcceptedOrder } from "./order-changes.ts";
import { orderBalance } from "../payments/position.ts";
import { orderSubject, type GuardedMove } from "../plugins/machine-guards.ts";

type PickupReadyPlanResult =
  | Readonly<{
      kind: "planned";
      fulfillment: CommerceFulfillmentV1;
      /** The move that a merchant plugin's guard may refuse. */
      move: GuardedMove;
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type PickupCompletionPlan = Readonly<{
  order: CommerceOrderV1;
  fulfillment: CommerceFulfillmentV1;
  allocations: readonly InventoryAllocation[];
  movements: readonly CommerceInventoryMovementV1[];
  positions: readonly CommerceInventoryPositionV1[];
  lots: readonly CommerceInventoryLotV1[];
}>;

type PickupCompletionPlanResult =
  | Readonly<{ kind: "planned"; value: PickupCompletionPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

function checkRevision(
  kind: string,
  id: string,
  expected: number,
  actual: number | undefined,
): CommerceMutationErrorV1 | undefined {
  if (actual === undefined) return { code: "resource_not_found", kind, id };
  if (actual !== expected)
    return { code: "stale_resource_revision", kind, id, expected, actual };
  return undefined;
}

function definedMutationError(
  value: CommerceMutationErrorV1 | undefined,
): value is CommerceMutationErrorV1 {
  return value !== undefined;
}

function timestampAtOrBefore(left: string, right: string): boolean {
  return Date.parse(left) <= Date.parse(right);
}

export function planPickupReady(
  command: MarkCommercePickupReadyV1,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
): PickupReadyPlanResult {
  const order = findResource(resources.orders, command.orderId);
  const fulfillment = findResource(
    resources.fulfillments,
    command.fulfillmentId,
  );
  const revisionErrors = [
    checkRevision(
      "commerce_order",
      command.orderId,
      command.orderRevision,
      order?.revision,
    ),
    checkRevision(
      "fulfillment",
      command.fulfillmentId,
      command.fulfillmentRevision,
      fulfillment?.revision,
    ),
  ];
  const revisionError = revisionErrors.find(definedMutationError);
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (order === undefined || fulfillment === undefined) {
    throw new Error(
      "Pickup readiness revision validation did not preserve resources",
    );
  }
  const ready = commerceTransition("order", order.lifecycle, "ready_pickup");
  if (!ready.allowed) return { kind: "rejected", error: ready.refusal };
  if (fulfillment.kind !== "pickup" || fulfillment.orderId !== order.id) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "pickupFulfillment.lifecycle",
      },
    };
  }
  const pickupReady = commerceTransition(
    "pickup_fulfillment",
    fulfillment.lifecycle,
    "ready",
  );
  if (!pickupReady.allowed)
    return { kind: "rejected", error: pickupReady.refusal };
  if (
    !timestampAtOrBefore(pickupReady.from.requestedAt, command.requestedAt)
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "pickupFulfillment.lifecycle",
      },
    };
  }
  // An edited order that still owes money waits for its balance payment.
  if (orderBalance(order, resources.payments).outstanding.amountMinor > 0) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "pickupFulfillment.balance",
      },
    };
  }
  // Only this fulfillment's lines; an exchange hands over its lines in a
  // fulfillment of their own.
  const preparedLineIds = order.lineItems
    .filter(
      (line) =>
        line.source.kind === "food_service" &&
        line.source.preparation.kind === "immediate_recipe" &&
        fulfillment.lineItems.some((item) => item.lineItemId === line.id),
    )
    .map((line) => line.id);
  for (const lineId of preparedLineIds) {
    const completedTicket = foodService.preparationTickets.find(
      (ticket) =>
        ticket.orderId === order.id &&
        ticket.fulfillmentId === fulfillment.id &&
        ticket.lifecycle.state === "completed" &&
        ticket.lineSnapshots.some(
          (snapshot) => snapshot.orderLineId === lineId,
        ),
    );
    if (completedTicket === undefined) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "pickupFulfillment.preparation",
        },
      };
    }
  }
  return {
    kind: "planned",
    move: {
      machine: "order",
      event: "ready_pickup",
      from: order.lifecycle.state,
      to: ready.to,
      subject: orderSubject(order, fulfillment, resources.variants),
      at: command.requestedAt,
      attempt: command.idempotencyKey,
    },
    fulfillment: parseFulfillment({
      kind: "pickup",
      id: fulfillment.id,
      revision: fulfillment.revision + 1,
      orderId: fulfillment.orderId,
      lineItems: fulfillment.lineItems,
      locationId: fulfillment.locationId,
      expectedBy: fulfillment.expectedBy,
      lifecycle: { state: pickupReady.to, readyAt: command.requestedAt },
      occurredAt: command.requestedAt,
    }),
  };
}

type AllocationCommitPlanResult =
  | Readonly<{
      kind: "planned";
      allocation: InventoryAllocation;
      movement: CommerceInventoryMovementV1;
      position: CommerceInventoryPositionV1;
      lots: readonly CommerceInventoryLotV1[];
    }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planPickupCompletion(
  database: CommerceDatabase,
  command: CompleteCommercePickupV1,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
): PickupCompletionPlanResult {
  const order = findResource(resources.orders, command.orderId);
  const payment = findResource(resources.payments, command.paymentId);
  const fulfillment = findResource(
    resources.fulfillments,
    command.fulfillmentId,
  );
  const revisionErrors = [
    checkRevision(
      "commerce_order",
      command.orderId,
      command.orderRevision,
      order?.revision,
    ),
    checkRevision(
      "payment",
      command.paymentId,
      command.paymentRevision,
      payment?.revision,
    ),
    checkRevision(
      "fulfillment",
      command.fulfillmentId,
      command.fulfillmentRevision,
      fulfillment?.revision,
    ),
  ];
  const revisionError = revisionErrors.find(definedMutationError);
  if (revisionError !== undefined)
    return { kind: "rejected", error: revisionError };
  if (
    order === undefined ||
    payment === undefined ||
    fulfillment === undefined
  ) {
    throw new Error(
      "Pickup completion revision validation did not preserve resources",
    );
  }
  const complete = commerceTransition(
    "order",
    order.lifecycle,
    "complete_pickup",
  );
  if (!complete.allowed) return { kind: "rejected", error: complete.refusal };
  if (fulfillment.kind === "pickup") {
    const handOver = commerceTransition(
      "pickup_fulfillment",
      fulfillment.lifecycle,
      "complete",
    );
    if (!handOver.allowed)
      return { kind: "rejected", error: handOver.refusal };
  }
  if (
    !pickupCompletionRelationshipsAreValid(
      order,
      complete.from.since,
      payment,
      fulfillment,
      command.requestedAt,
    ) ||
    orderBalance(order, resources.payments).outstanding.amountMinor > 0
  ) {
    return pickupCompletionRejected("pickupCompletion.lifecycle");
  }
  // Only this fulfillment's lines; an exchange hands over its lines in a
  // fulfillment of their own.
  const preparedLineIds = order.lineItems
    .filter(
      (line) =>
        line.source.kind === "food_service" &&
        line.source.preparation.kind === "immediate_recipe" &&
        fulfillment.lineItems.some((item) => item.lineItemId === line.id),
    )
    .map((line) => line.id);
  for (const lineId of preparedLineIds) {
    const ticket = foodService.preparationTickets.find(
      (candidate) =>
        candidate.orderId === order.id &&
        candidate.fulfillmentId === fulfillment.id &&
        candidate.lifecycle.state === "completed" &&
        candidate.lineSnapshots.some(
          (snapshot) => snapshot.orderLineId === lineId,
        ),
    );
    if (ticket === undefined)
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "pickupFulfillment.preparation",
        },
      };
  }
  // Counter handover uses this same pickup path. Both channels record their
  // Checkout on the origin; only the online branch pins a storefront profile.
  const originCheckoutId = orderOriginCheckoutId(order.origin);
  if (originCheckoutId === undefined) {
    return pickupCompletionRejected("pickupCompletion.orderOrigin");
  }
  const checkout = readCheckout(database, command.merchantId, originCheckoutId);
  if (
    checkout?.lifecycle.state !== "accepted" ||
    !checkoutOrderMatchesCheckout(
      order.origin,
      checkout.checkoutId,
      checkoutProfileOf(checkout),
    ) ||
    checkout.lifecycle.orderId !== order.id ||
    !timestampAtOrBefore(checkout.lifecycle.acceptedAt, command.requestedAt)
  ) {
    return pickupCompletionRejected("pickupCompletion.checkout");
  }
  // The lines to hand over are the ones the last order change accepted: the
  // checkout quote, or the last edit.
  const accepted = readAcceptedOrder(database, command.merchantId, order);
  if (accepted === undefined || !orderMatchesAccepted(order, accepted))
    return pickupCompletionRejected("pickupCompletion.acceptedOrder");
  const lineError = validatePickupCompletionLines(order, fulfillment, accepted);
  if (lineError !== undefined) return { kind: "rejected", error: lineError };
  const currentLots = new Map<string, CommerceInventoryLotV1>();
  for (const lot of listInventoryLots(database, command.merchantId))
    currentLots.set(lot.id, lot);
  const plannedPositions = new Map<string, CommerceInventoryPositionV1>();
  const changedLots = new Map<string, CommerceInventoryLotV1>();
  const allocations: InventoryAllocation[] = [];
  const movements: CommerceInventoryMovementV1[] = [];
  const allocationIds = new Set<string>();
  for (const acceptedLine of accepted.lines) {
    const orderLineId = acceptedLine.orderLineId;
    // Lines an earlier fulfillment handed over keep their committed stock.
    if (!fulfillment.lineItems.some((item) => item.lineItemId === orderLineId)) continue;
    for (const allocationId of acceptedLine.allocationIds) {
      if (!allocationIds.add(allocationId)) {
        return pickupCompletionRejected("pickupCompletion.allocationIds");
      }
      const currentAllocation = readInventoryAllocation(
        database,
        command.merchantId,
        allocationId,
      );
      if (
        currentAllocation !== undefined &&
        isCompletedPreparationAllocation(
          currentAllocation,
          order.id,
          orderLineId,
          command.fulfillmentId,
          foodService,
        )
      ) {
        continue;
      }
      const allocationPlan = planPickupAllocationCommit(
        database,
        command,
        orderLineId,
        fulfillment.locationId,
        allocationId,
        currentAllocation,
        plannedPositions,
        currentLots,
        changedLots,
      );
      if (allocationPlan.kind === "rejected") return allocationPlan;
      allocations.push(allocationPlan.allocation);
      movements.push(allocationPlan.movement);
      plannedPositions.set(allocationPlan.position.id, allocationPlan.position);
      for (const lot of allocationPlan.lots) {
        currentLots.set(lot.id, lot);
        changedLots.set(lot.id, lot);
      }
    }
  }
  const nextOrder = fulfilledOrder(
    order,
    fulfillment,
    command.requestedAt,
    "pickup",
  );
  if ("code" in nextOrder) return { kind: "rejected", error: nextOrder };
  return {
    kind: "planned",
    value: {
      order: nextOrder,
      fulfillment: completedFulfillment(fulfillment, command.requestedAt),
      allocations,
      movements,
      positions: [...plannedPositions.values()],
      lots: [...changedLots.values()],
    },
  };
}

function pickupCompletionRelationshipsAreValid(
  order: CommerceOrderV1,
  pendingSince: string,
  payment: CommercePaymentV1,
  fulfillment: CommerceFulfillmentV1,
  requestedAt: string,
): fulfillment is CommercePickupFulfillmentV1 {
  return (
    fulfillment.kind === "pickup" &&
    timestampAtOrBefore(pendingSince, requestedAt) &&
    payment.orderId === order.id &&
    paymentWasCapturedBy(payment, requestedAt) &&
    fulfillment.orderId === order.id &&
    fulfillment.lifecycle.state === "ready_for_pickup" &&
    timestampAtOrBefore(fulfillment.lifecycle.readyAt, requestedAt)
  );
}

// The named payment is one the order holds: the first, or a balance payment.
// The order's balance, not this one payment, says the order is paid.
function paymentWasCapturedBy(
  payment: CommercePaymentV1,
  requestedAt: string,
): boolean {
  switch (payment.lifecycle.state) {
    case "captured":
      return timestampAtOrBefore(payment.lifecycle.capturedAt, requestedAt);
    case "partially_refunded":
      return true;
    case "pending":
    case "authorized":
    case "failed":
    case "refunded":
      return false;
  }
}

// The fulfillment hands over what its lines still owe; every other line was
// handed over in full by an earlier fulfillment.
function validatePickupCompletionLines(
  order: CommerceOrderV1,
  fulfillment: CommerceFulfillmentV1,
  accepted: AcceptedOrder,
): CommerceMutationErrorV1 | undefined {
  if (
    order.lineItems.length !== accepted.lines.length ||
    fulfillment.lineItems.length === 0 ||
    fulfillment.lineItems.some(
      (item) => findResource(order.lineItems, item.lineItemId) === undefined,
    )
  ) {
    return pickupCompletionRelationshipError("pickupCompletion.lines");
  }
  for (const acceptedLine of accepted.lines) {
    const lineId = acceptedLine.orderLineId;
    const orderLine = findResource(order.lineItems, lineId);
    const fulfillmentLine = fulfillment.lineItems.find(
      lineItemMatches.bind(undefined, lineId),
    );
    if (
      orderLine === undefined ||
      orderLine.quantity.amount !== acceptedLine.quantity ||
      orderLine.quantity.scale !== 0 ||
      orderLine.quantity.unit !== "each" ||
      (fulfillmentLine === undefined
        ? orderLine.fulfilledQuantity.amount !== orderLine.quantity.amount
        : fulfillmentLine.quantity !==
          orderLine.quantity.amount - orderLine.fulfilledQuantity.amount)
    ) {
      return pickupCompletionRelationshipError("pickupCompletion.lines");
    }
  }
  return undefined;
}

function lineItemMatches(
  lineItemId: string,
  line: CommerceFulfillmentV1["lineItems"][number],
): boolean {
  return line.lineItemId === lineItemId;
}

function planPickupAllocationCommit(
  database: CommerceDatabase,
  command: CompleteCommercePickupV1,
  orderLineId: string,
  fulfillmentLocationId: string,
  allocationId: string,
  allocation: InventoryAllocation | undefined,
  plannedPositions: ReadonlyMap<string, CommerceInventoryPositionV1>,
  currentLots: ReadonlyMap<string, CommerceInventoryLotV1>,
  changedLots: ReadonlyMap<string, CommerceInventoryLotV1>,
): AllocationCommitPlanResult {
  if (allocation === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_allocation",
        id: allocationId,
      },
    };
  }
  if (
    allocation.lifecycle.state !== "allocated_to_order" ||
    allocation.lifecycle.orderId !== command.orderId ||
    allocation.lifecycle.orderLineId !== orderLineId ||
    allocation.lifecycle.consumeOn !== "fulfillment_completed" ||
    allocation.locationId !== fulfillmentLocationId
  ) {
    return allocationCommitRejected("pickupCompletion.allocation");
  }
  const item = readInventoryItem(
    database,
    command.merchantId,
    allocation.inventoryItemId,
  );
  if (item === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "inventory_item",
        id: allocation.inventoryItemId,
      },
    };
  }
  if (item.lifecycle !== "active") {
    return allocationCommitRejected("pickupCompletion.inventoryItem");
  }
  const storedPosition = readInventoryPositionForItemLocation(
    database,
    command.merchantId,
    allocation.inventoryItemId,
    allocation.locationId,
  );
  const position =
    storedPosition === undefined
      ? undefined
      : (plannedPositions.get(storedPosition.id) ?? storedPosition);
  const positionAlreadyPlanned =
    storedPosition !== undefined && plannedPositions.has(storedPosition.id);
  if (
    position === undefined ||
    !isAccountedPosition(position) ||
    !accountedPositionCanCommit(position, allocation.quantity)
  ) {
    return allocationCommitRejected("pickupCompletion.position");
  }
  const movementId = `movement_${sha256(
    `${command.merchantId}:${command.fulfillmentId}:${allocation.allocationId}:sale`,
  )}`;
  const lotPlan = planSaleLotConsumption(
    item,
    allocation,
    currentLots,
    changedLots,
    command.requestedAt,
  );
  if (lotPlan.kind === "rejected") return lotPlan;
  const movement = parseInventoryMovement({
    id: movementId,
    inventoryItemId: allocation.inventoryItemId,
    locationId: allocation.locationId,
    change: {
      kind: "decrease",
      quantity: allocation.quantity,
      reason: { kind: "sale", orderId: command.orderId, orderLineId },
      lotAllocation: lotPlan.allocation,
    },
    occurredAt: command.requestedAt,
    idempotencyKey: `${command.idempotencyKey}:${allocation.allocationId}`,
  });
  return {
    kind: "planned",
    allocation: parseInventoryAllocation({
      allocationId: allocation.allocationId,
      inventoryItemId: allocation.inventoryItemId,
      locationId: allocation.locationId,
      quantity: allocation.quantity,
      revision: allocation.revision + 1,
      lifecycle: {
        state: "committed",
        demand: { kind: "order", orderId: command.orderId, orderLineId },
        movementId,
        committedAt: command.requestedAt,
      },
    }),
    movement,
    position: committedInventoryPosition(
      position,
      allocation.quantity,
      command.requestedAt,
      positionAlreadyPlanned,
    ),
    lots: lotPlan.lots,
  };
}

/**
 * The order after a pickup or a carrier hands over `fulfillment`: fulfilled
 * when every line is handed over, or partially fulfilled.
 */
function fulfilledOrder(
  order: CommerceOrderV1,
  fulfillment: CommerceFulfillmentV1,
  occurredAt: string,
  handover: "pickup" | "carrier",
): CommerceOrderV1 | CommerceInvalidTransition<"order"> {
  const lineItems: CommerceOrderV1["lineItems"][number][] = [];
  for (const line of order.lineItems) {
    const handedOver = fulfillment.lineItems.some((item) => item.lineItemId === line.id);
    lineItems.push({
      id: line.id,
      source: line.source,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      fulfilledQuantity: handedOver ? line.quantity : line.fulfilledQuantity,
      unitPrice: line.unitPrice,
      tax: line.tax,
      discount: line.discount,
      lineTotal: line.lineTotal,
    });
  }
  const complete = lineItems.every(
    (line) => line.fulfilledQuantity.amount === line.quantity.amount,
  );
  const move = commerceTransition(
    "order",
    order.lifecycle,
    handover === "pickup"
      ? complete
        ? "complete_pickup"
        : "complete_pickup_part"
      : complete
        ? "deliver"
        : "deliver_part",
  );
  if (!move.allowed) return move.refusal;
  return parseOrder({
    id: order.id,
    revision: order.revision + 1,
    origin: order.origin,
    buyer: order.buyer,
    ...orderFactsKept(order),
    lineItems,
    totals: order.totals,
    adjustments: order.adjustments,
    lifecycle: complete
      ? { state: move.to, fulfilledAt: occurredAt }
      : {
          state: move.to,
          since: occurredAt,
          fulfilledLineItemIds: lineItems
            .filter((line) => line.fulfilledQuantity.amount === line.quantity.amount)
            .map((line) => line.id),
        },
    occurredAt,
  });
}

function completedFulfillment(
  fulfillment: CommercePickupFulfillmentV1,
  occurredAt: string,
): CommerceFulfillmentV1 {
  return parseFulfillment({
    kind: fulfillment.kind,
    id: fulfillment.id,
    revision: fulfillment.revision + 1,
    orderId: fulfillment.orderId,
    lineItems: fulfillment.lineItems,
    locationId: fulfillment.locationId,
    expectedBy: fulfillment.expectedBy,
    lifecycle: { state: "completed", completedAt: occurredAt },
    occurredAt,
  });
}

function isCompletedPreparationAllocation(
  allocation: InventoryAllocation,
  orderId: string,
  orderLineId: string,
  fulfillmentId: string,
  foodService: CommerceFoodServiceResourcesV1,
): boolean {
  if (
    allocation.lifecycle.state !== "committed" ||
    allocation.lifecycle.demand.kind !== "order" ||
    allocation.lifecycle.demand.orderId !== orderId ||
    allocation.lifecycle.demand.orderLineId !== orderLineId
  ) {
    return false;
  }
  const movementId = allocation.lifecycle.movementId;
  return foodService.preparationTickets.some(
    (ticket) =>
      ticket.orderId === orderId &&
      ticket.fulfillmentId === fulfillmentId &&
      ticket.lineSnapshots.some(
        (snapshot) => snapshot.orderLineId === orderLineId,
      ) &&
      ticket.lifecycle.state === "completed" &&
      ticket.lifecycle.movementIds.includes(movementId),
  );
}

function pickupCompletionRejected(field: string): PickupCompletionPlanResult {
  return { kind: "rejected", error: pickupCompletionRelationshipError(field) };
}

function allocationCommitRejected(field: string): AllocationCommitPlanResult {
  return { kind: "rejected", error: pickupCompletionRelationshipError(field) };
}

function pickupCompletionRelationshipError(
  field: string,
): CommerceMutationErrorV1 {
  return { code: "resource_relationship_invalid", field };
}

type ShipmentLabelRatePlanResult =
  | Readonly<{ kind: "planned"; request: ShippingLabelRateRequest }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

type ShipmentShippingRouteAuthority = Readonly<{
  routeBinding: ShippingRouteBinding;
  acceptedCarrierRate: ShippingQuoteSnapshot["carrierRate"];
  packagePlanDigest: string;
}>;

type ShipmentShippingRouteResult =
  | Readonly<{ kind: "resolved"; value: ShipmentShippingRouteAuthority }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function resolveShipmentShippingRoute(
  database: CommerceDatabase,
  merchantId: string,
  resources: CommerceResourcesV1,
  shipment: CommerceFirstPartyShipmentV1,
): ShipmentShippingRouteResult {
  const order = findResource(resources.orders, shipment.orderId);
  if (order === undefined || order.origin.kind !== "online") {
    return {
      kind: "rejected",
      error: { code: "resource_relationship_invalid", field: "shipment.order" },
    };
  }
  const checkout = readCheckout(database, merchantId, order.origin.checkoutId);
  if (
    checkout?.lifecycle.state !== "accepted" ||
    !checkoutOrderProfileMatches(order.origin, checkoutProfileOf(checkout)) ||
    checkout.lifecycle.quote.fulfillment.kind !== "shipping"
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "shipment.checkout",
      },
    };
  }
  const quote = checkout.lifecycle.quote.fulfillment.quote;
  return {
    kind: "resolved",
    value: {
      routeBinding: quote.routeBinding,
      acceptedCarrierRate: quote.carrierRate,
      packagePlanDigest: quote.packagePlan.packagePlanDigest,
    },
  };
}

export function planShipmentLabelRate(
  database: CommerceDatabase,
  command: QuoteShipmentLabelRateCommand,
  resources: CommerceResourcesV1,
): ShipmentLabelRatePlanResult {
  const shipment = findResource(resources.shipments, command.shipmentId);
  if (shipment === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_not_found",
        kind: "shipment",
        id: command.shipmentId,
      },
    };
  }
  if (shipment.kind === "first_party") {
    const quote = commerceTransition(
      "shipment",
      shipment.lifecycle,
      "quote_label",
    );
    if (!quote.allowed) return { kind: "rejected", error: quote.refusal };
  }
  if (
    shipment.kind !== "first_party" ||
    shipment.revision !== command.shipmentRevision
  ) {
    return {
      kind: "rejected",
      error: {
        code: "stale_resource_revision",
        kind: "shipment",
        id: command.shipmentId,
        expected: command.shipmentRevision,
        actual: shipment.revision,
      },
    };
  }
  const route = resolveShipmentShippingRoute(
    database,
    command.merchantId,
    resources,
    shipment,
  );
  if (route.kind === "rejected") return route;
  return {
    kind: "planned",
    request: {
      routeBinding: route.value.routeBinding,
      shipmentId: command.shipmentId,
      shipmentRevision: command.shipmentRevision,
      acceptedCarrierRate: route.value.acceptedCarrierRate,
      packagePlanDigest: route.value.packagePlanDigest,
      idempotencyKey: command.idempotencyKey,
      quotedAt: command.requestedAt,
    },
  };
}

type ShippingTrackingPlanCommon = Readonly<{
  shipment: CommerceFirstPartyShipmentV1;
  fulfillment: Variant<CommerceFulfillmentV1, "shipping">;
  order: CommerceOrderV1;
}>;

export type ShippingTrackingPlan = ShippingTrackingPlanCommon &
  (
    | Readonly<{
        kind: "in_transit";
        allocations: readonly [];
        movements: readonly [];
        lots: readonly [];
        positions: readonly [];
      }>
    | Readonly<{
        kind: "delivered";
        allocations: readonly InventoryAllocation[];
        movements: readonly CommerceInventoryMovementV1[];
        lots: readonly CommerceInventoryLotV1[];
        positions: readonly CommerceInventoryPositionV1[];
      }>
  );

type ShippingTrackingPlanResult =
  | Readonly<{ kind: "planned"; value: ShippingTrackingPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export type FulfillmentTrackingAttachmentPlan = Readonly<{
  shipment: CommerceFirstPartyShipmentV1;
  fulfillment: Variant<CommerceFulfillmentV1, "shipping">;
}>;

type FulfillmentTrackingAttachmentPlanResult =
  | Readonly<{ kind: "planned"; value: FulfillmentTrackingAttachmentPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planFulfillmentTrackingAttachment(
  command: AttachFulfillmentTrackingCommand,
  resources: CommerceResourcesV1,
): FulfillmentTrackingAttachmentPlanResult {
  const shipment = findResource(resources.shipments, command.shipmentId);
  const fulfillment = findResource(
    resources.fulfillments,
    command.fulfillmentId,
  );
  const shipmentRefusal = {
    kind: "rejected",
    error: {
      code: "resource_relationship_invalid",
      field: "shipment.trackingAttachment",
    },
  } as const;
  if (
    shipment?.kind !== "first_party" ||
    shipment.revision !== command.shipmentRevision ||
    shipment.orderId !== command.orderId ||
    shipment.fulfillmentId !== command.fulfillmentId
  )
    return shipmentRefusal;
  const shipmentHandover = commerceTransition(
    "shipment",
    shipment.lifecycle,
    "hand_over",
  );
  if (!shipmentHandover.allowed)
    return { kind: "rejected", error: shipmentHandover.refusal };
  if (
    shipmentHandover.from.trackingNumber !== command.trackingNumber ||
    !timestampAtOrBefore(shipmentHandover.from.purchasedAt, command.requestedAt)
  )
    return shipmentRefusal;
  if (
    fulfillment?.kind !== "shipping" ||
    fulfillment.revision !== command.fulfillmentRevision ||
    fulfillment.orderId !== command.orderId
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "fulfillment.trackingAttachment",
      },
    };
  }
  const fulfillmentHandover = commerceTransition(
    "shipping_fulfillment",
    fulfillment.lifecycle,
    "hand_over",
  );
  if (!fulfillmentHandover.allowed)
    return { kind: "rejected", error: fulfillmentHandover.refusal };
  const nextShipment = parseShipment({
    ...shipment,
    revision: shipment.revision + 1,
    events: [
      ...shipment.events,
      {
        id: `tracking_attachment_${command.idempotencyKey}`,
        occurredAt: command.requestedAt,
        kind: { kind: "in_transit" },
        location: "Merchant handoff",
      },
    ],
    lifecycle: {
      state: shipmentHandover.to,
      labelAttemptId: shipmentHandover.from.labelAttemptId,
      trackingNumber: shipmentHandover.from.trackingNumber,
      handedOverAt: command.requestedAt,
    },
    occurredAt: command.requestedAt,
  });
  const nextFulfillment = parseFulfillment({
    ...fulfillment,
    revision: fulfillment.revision + 1,
    lifecycle: {
      state: fulfillmentHandover.to,
      handedOverAt: command.requestedAt,
      shipmentId: shipment.id,
    },
    occurredAt: command.requestedAt,
  });
  if (
    nextShipment.kind !== "first_party" ||
    nextFulfillment.kind !== "shipping"
  ) {
    throw new Error("Tracking attachment parser changed resource branches");
  }
  return {
    kind: "planned",
    value: { shipment: nextShipment, fulfillment: nextFulfillment },
  };
}

export function planShippingTracking(
  database: CommerceDatabase,
  command: RecordShippingTrackingCommand,
  resources: CommerceResourcesV1,
): ShippingTrackingPlanResult {
  const shipment = findResource(resources.shipments, command.shipmentId);
  if (
    shipment?.kind !== "first_party" ||
    shipment.revision !== command.shipmentRevision
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "shipment.tracking",
      },
    };
  }
  const scan = commerceTransition(
    "shipment",
    shipment.lifecycle,
    command.event.state === "in_transit" ? "hand_over" : "deliver",
  );
  if (!scan.allowed) return { kind: "rejected", error: scan.refusal };
  const scanned = scan.from;
  if (
    !timestampAtOrBefore(
      scanned.state === "label_purchased"
        ? scanned.purchasedAt
        : scanned.handedOverAt,
      command.event.occurredAt,
    )
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "shipment.tracking.occurredAt",
      },
    };
  }
  const event = {
    id: command.event.providerEventId,
    occurredAt: command.event.occurredAt,
    kind: { kind: command.event.state },
    location: command.event.location,
  } as const;
  const nextShipment = parseShipment({
    ...shipment,
    revision: shipment.revision + 1,
    events: [...shipment.events, event],
    lifecycle:
      scanned.state === "label_purchased"
        ? {
            state: "in_transit",
            labelAttemptId: scanned.labelAttemptId,
            trackingNumber: scanned.trackingNumber,
            handedOverAt: command.event.occurredAt,
          }
        : {
            state: "delivered",
            labelAttemptId: scanned.labelAttemptId,
            trackingNumber: scanned.trackingNumber,
            handedOverAt: scanned.handedOverAt,
            deliveredAt: command.event.occurredAt,
          },
    occurredAt: command.requestedAt,
  });
  if (nextShipment.kind !== "first_party")
    throw new Error("Shipping tracking parser returned another shipment kind");
  const fulfillment = findResource(
    resources.fulfillments,
    shipment.fulfillmentId,
  );
  const order = findResource(resources.orders, shipment.orderId);
  if (fulfillment?.kind !== "shipping" || order === undefined) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "shipment.fulfillment",
      },
    };
  }
  const handover = commerceTransition(
    "shipping_fulfillment",
    fulfillment.lifecycle,
    command.event.state === "in_transit" ? "hand_over" : "deliver",
  );
  if (!handover.allowed) return { kind: "rejected", error: handover.refusal };
  // A delivery moves the order, so it must be one that the order allows.
  if (command.event.state !== "in_transit") {
    const deliver = commerceTransition("order", order.lifecycle, "deliver");
    if (!deliver.allowed) return { kind: "rejected", error: deliver.refusal };
  }
  if (command.event.state === "in_transit") {
    const nextFulfillment = parseFulfillment({
      ...fulfillment,
      revision: fulfillment.revision + 1,
      lifecycle: {
        state: handover.to,
        handedOverAt: command.event.occurredAt,
        shipmentId: shipment.id,
      },
      occurredAt: command.requestedAt,
    });
    if (nextFulfillment.kind !== "shipping") {
      throw new Error(
        "Shipping tracking fulfillment parser returned another branch",
      );
    }
    return {
      kind: "planned",
      value: {
        kind: "in_transit",
        shipment: nextShipment,
        fulfillment: nextFulfillment,
        order,
        allocations: [],
        movements: [],
        lots: [],
        positions: [],
      },
    };
  }
  if (order.origin.kind !== "online") {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "shipment.checkout",
      },
    };
  }
  const checkout = readCheckout(
    database,
    command.merchantId,
    order.origin.checkoutId,
  );
  if (
    checkout?.lifecycle.state !== "accepted" ||
    !checkoutOrderProfileMatches(order.origin, checkoutProfileOf(checkout))
  ) {
    return {
      kind: "rejected",
      error: {
        code: "resource_relationship_invalid",
        field: "shipment.checkout",
      },
    };
  }
  const currentLots = new Map<string, CommerceInventoryLotV1>();
  for (const lot of listInventoryLots(database, command.merchantId))
    currentLots.set(lot.id, lot);
  const changedLots = new Map<string, CommerceInventoryLotV1>();
  const positions = new Map<string, CommerceInventoryPositionV1>();
  const allocations: InventoryAllocation[] = [];
  const movements: CommerceInventoryMovementV1[] = [];
  for (const quoteLine of checkout.lifecycle.quote.lines) {
    const lineId = orderLineIdFor(order.id, quoteLine.checkoutLineId);
    for (const allocationId of quoteLine.allocationIds) {
      const allocation = readInventoryAllocation(
        database,
        command.merchantId,
        allocationId,
      );
      if (
        allocation === undefined ||
        allocation.lifecycle.state !== "allocated_to_order" ||
        allocation.lifecycle.orderId !== order.id ||
        allocation.lifecycle.orderLineId !== lineId ||
        allocation.lifecycle.consumeOn !== "fulfillment_completed"
      ) {
        return {
          kind: "rejected",
          error: {
            code: "resource_relationship_invalid",
            field: "shipment.allocation",
          },
        };
      }
      const item = readInventoryItem(
        database,
        command.merchantId,
        allocation.inventoryItemId,
      );
      const storedPosition = readInventoryPositionForItemLocation(
        database,
        command.merchantId,
        allocation.inventoryItemId,
        allocation.locationId,
      );
      const position =
        storedPosition === undefined
          ? undefined
          : (positions.get(storedPosition.id) ?? storedPosition);
      if (
        item === undefined ||
        position === undefined ||
        !isAccountedPosition(position) ||
        !accountedPositionCanCommit(position, allocation.quantity)
      ) {
        return {
          kind: "rejected",
          error: {
            code: "insufficient_inventory",
            inventoryItemId: allocation.inventoryItemId,
            locationId: allocation.locationId,
            requestedAmount: allocation.quantity.amount,
            availableAmount:
              position?.balance.kind === "accounted"
                ? position.balance.available.amount
                : 0,
          },
        };
      }
      const lotPlan = planSaleLotConsumption(
        item,
        allocation,
        currentLots,
        changedLots,
        command.event.occurredAt,
      );
      if (lotPlan.kind === "rejected")
        return { kind: "rejected", error: lotPlan.error };
      const movement = parseInventoryMovement({
        id: `movement_${sha256(`${command.merchantId}:${shipment.id}:${allocationId}:sale`)}`,
        inventoryItemId: allocation.inventoryItemId,
        locationId: allocation.locationId,
        change: {
          kind: "decrease",
          quantity: allocation.quantity,
          reason: { kind: "sale", orderId: order.id, orderLineId: lineId },
          lotAllocation: lotPlan.allocation,
        },
        occurredAt: command.event.occurredAt,
        idempotencyKey: `${command.idempotencyKey}:${allocationId}`,
      });
      allocations.push(
        parseInventoryAllocation({
          allocationId,
          inventoryItemId: allocation.inventoryItemId,
          locationId: allocation.locationId,
          quantity: allocation.quantity,
          revision: allocation.revision + 1,
          lifecycle: {
            state: "committed",
            demand: { kind: "order", orderId: order.id, orderLineId: lineId },
            movementId: movement.id,
            committedAt: command.event.occurredAt,
          },
        }),
      );
      movements.push(movement);
      positions.set(
        position.id,
        committedInventoryPosition(
          position,
          allocation.quantity,
          command.event.occurredAt,
          positions.has(position.id),
        ),
      );
      for (const lot of lotPlan.lots) {
        currentLots.set(lot.id, lot);
        changedLots.set(lot.id, lot);
      }
    }
  }
  const nextOrder = fulfilledOrder(
    order,
    fulfillment,
    command.event.occurredAt,
    "carrier",
  );
  if ("code" in nextOrder) return { kind: "rejected", error: nextOrder };
  return {
    kind: "planned",
    value: {
      kind: "delivered",
      shipment: nextShipment,
      fulfillment,
      order: nextOrder,
      allocations,
      movements,
      lots: [...changedLots.values()],
      positions: [...positions.values()],
    },
  };
}
