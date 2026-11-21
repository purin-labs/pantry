import {
  checkoutProfileOf,
  parseInventoryAllocation,
  parseInventoryMovement,
  parsePreparationTicket,
  type ManagePreparationTicketCommand,
  type CommerceResourcesV1,
  type CommerceFoodServiceResourcesV1,
  type CommerceInventoryLotV1,
  type CommerceInventoryMovementV1,
  type CommerceInventoryPositionV1,
  type CommerceMutationErrorV1,
  type CommerceOrderOriginV1,
  type CommercePreparationTicketV1,
} from "@purin-labs/commerce-client";
import { merchantOwner } from "./merchant-owner.ts";
import {
  commerceTransition,
  type Checkout,
  type InventoryAllocation,
  type InventoryRequirement,
} from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../../database.ts";
import {
  readCheckout,
  listInventoryAllocations,
} from "../../checkout-persistence.ts";
import {
  listInventoryLots,
  readInventoryPositionForItemLocation,
} from "../../inventory-persistence.ts";
import { foodProvenance } from "./food-service-store.ts";
import {
  accountedPositionCanCommit,
  committedInventoryPosition,
  isAccountedPosition,
  planSaleLotConsumption,
  sameQuantity,
} from "../../commerce-authority/inventory-planning.ts";
import {
  checkoutOrderProfileMatches,
  orderLineIdFor,
  sha256,
  timestampAtOrBefore,
} from "../../commerce-authority/checkout-shared.ts";

export type PreparationTicketPlan = Readonly<{
  ticket: CommercePreparationTicketV1;
  allocations: readonly InventoryAllocation[];
  movements: readonly CommerceInventoryMovementV1[];
  positions: readonly CommerceInventoryPositionV1[];
  lots: readonly CommerceInventoryLotV1[];
}>;

type PreparationTicketPlanResult =
  | Readonly<{ kind: "planned"; value: PreparationTicketPlan }>
  | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }>;

export function planPreparationTicketCreate(
  database: CommerceDatabase,
  command: ManagePreparationTicketCommand,
  resources: CommerceResourcesV1,
  foodService: CommerceFoodServiceResourcesV1,
): PreparationTicketPlanResult {
  const operation = command.operation;
  if (operation.kind !== "create") {
    throw new Error(
      "Preparation ticket create planner received another operation",
    );
  }
  const order = resources.orders.find(
    (candidate) => candidate.id === operation.orderId,
  );
  const fulfillment = resources.fulfillments.find(
    (candidate) => candidate.id === operation.fulfillmentId,
  );
  const station = foodService.preparationStations.find(
    (candidate) => candidate.stationId === operation.stationId,
  );
  if (order === undefined)
    return preparationTicketRejected("preparationTicket.order");
  if (
    fulfillment === undefined ||
    fulfillment.kind !== "pickup" ||
    fulfillment.orderId !== order.id
  ) {
    return preparationTicketRejected("preparationTicket.fulfillment");
  }
  const pickupPrepare = commerceTransition(
    "pickup_fulfillment",
    fulfillment.lifecycle,
    "prepare",
  );
  if (!pickupPrepare.allowed)
    return { kind: "rejected", error: pickupPrepare.refusal };
  if (station === undefined)
    return preparationTicketRejected("preparationTicket.station");
  if (
    station.lifecycle !== "active" ||
    station.locationId !== fulfillment.locationId
  ) {
    return preparationTicketRejected("preparationTicket.station.location");
  }
  const prepare = commerceTransition("order", order.lifecycle, "prepare");
  if (!prepare.allowed) return { kind: "rejected", error: prepare.refusal };
  if (
    (order.origin.kind !== "online" && order.origin.kind !== "point_of_sale") ||
    !timestampAtOrBefore(prepare.from.since, command.requestedAt)
  ) {
    return preparationTicketRejected("preparationTicket.order.lifecycle");
  }
  const checkout = readCheckout(
    database,
    command.merchantId,
    order.origin.checkoutId,
  );
  if (
    checkout?.lifecycle.state !== "accepted" ||
    checkout.lifecycle.orderId !== order.id ||
    !checkoutMatchesPreparationOrder(order.origin, checkout) ||
    checkout.checkoutId !== order.origin.checkoutId ||
    !timestampAtOrBefore(checkout.lifecycle.acceptedAt, command.requestedAt) ||
    !timestampAtOrBefore(pickupPrepare.from.requestedAt, command.requestedAt)
  ) {
    return preparationTicketRejected("preparationTicket.checkout");
  }
  const existingTicket = foodService.preparationTickets.find(
    (candidate) =>
      candidate.orderId === order.id &&
      candidate.fulfillmentId === fulfillment.id &&
      candidate.lineSnapshots.some((line) =>
        order.lineItems.some((item) => item.id === line.orderLineId),
      ),
  );
  if (existingTicket !== undefined)
    return preparationTicketRejected("preparationTicket.alreadyExists");
  const snapshots: CommercePreparationTicketV1["lineSnapshots"] = [];
  for (const line of order.lineItems) {
    if (
      line.source.kind !== "food_service" ||
      line.source.preparation.kind !== "immediate_recipe"
    )
      continue;
    const quoteLine = checkout.lifecycle.quote.lines.find(
      (candidate) =>
        orderLineIdFor(order.id, candidate.checkoutLineId) === line.id,
    );
    if (
      quoteLine?.source.kind !== "food_service" ||
      quoteLine.source.preparation.kind !== "immediate_recipe"
    ) {
      return preparationTicketRejected("preparationTicket.checkout.line");
    }
    if (
      line.quantity.unit !== "each" ||
      line.quantity.scale !== 0 ||
      line.quantity.amount < 1
    ) {
      return preparationTicketRejected("preparationTicket.line.quantity");
    }
    const requirements: InventoryRequirement[] = [];
    if (quoteLine.source.inventory.kind !== "requirements") {
      return preparationTicketRejected("preparationTicket.line.requirements");
    }
    for (const item of quoteLine.source.inventory.items) {
      const multiplied = multiplyRequirement(item, line.quantity.amount);
      if (multiplied === undefined)
        return preparationTicketRejected("preparationTicket.line.requirements");
      requirements.push(multiplied);
    }
    if (requirements.length === 0)
      return preparationTicketRejected("preparationTicket.line.requirements");
    snapshots.push({
      orderLineId: line.id,
      menuEntryId: line.source.menuEntryId,
      menuEntryRevision: line.source.menuEntryRevision,
      recipeId: line.source.preparation.recipeId,
      recipeRevision: line.source.preparation.recipeRevision,
      modifiers: [...line.source.modifiers],
      requirements,
    });
  }
  if (snapshots.length === 0)
    return preparationTicketRejected("preparationTicket.lines");
  const queuedAt = command.requestedAt;
  const ticket: CommercePreparationTicketV1 = parsePreparationTicket({
    provenance: foodProvenance(
      merchantOwner(database, command.merchantId),
      command.merchantId,
      "preparation_ticket",
      operation.ticketId,
      1,
      queuedAt,
    ),
    ticketId: operation.ticketId,
    orderId: order.id,
    fulfillmentId: fulfillment.id,
    locationId: fulfillment.locationId,
    stationId: station.stationId,
    revision: 1,
    lineSnapshots: snapshots,
    lifecycle: { state: "queued", queuedAt },
  });
  return {
    kind: "planned",
    value: { ticket, allocations: [], movements: [], positions: [], lots: [] },
  };
}

export function planPreparationTicketStart(
  command: ManagePreparationTicketCommand,
  ticket: CommercePreparationTicketV1,
): PreparationTicketPlanResult {
  if (command.operation.kind !== "start") {
    throw new Error(
      "Preparation ticket start planner received another operation",
    );
  }
  if (ticket.revision !== command.operation.expectedTicketRevision)
    return preparationTicketRejected("preparationTicket.lifecycle");
  const start = commerceTransition(
    "preparation_ticket",
    ticket.lifecycle,
    "start",
  );
  if (!start.allowed) return { kind: "rejected", error: start.refusal };
  if (!timestampAtOrBefore(start.from.queuedAt, command.requestedAt)) {
    return preparationTicketRejected("preparationTicket.lifecycle.queuedAt");
  }
  const revision = ticket.revision + 1;
  const nextTicket = parsePreparationTicket({
    provenance: preparationTicketProvenance(ticket.provenance, revision),
    ticketId: ticket.ticketId,
    orderId: ticket.orderId,
    fulfillmentId: ticket.fulfillmentId,
    locationId: ticket.locationId,
    stationId: ticket.stationId,
    revision,
    lineSnapshots: ticket.lineSnapshots,
    lifecycle: { state: "preparing", startedAt: command.requestedAt },
  });
  return {
    kind: "planned",
    value: {
      ticket: nextTicket,
      allocations: [],
      movements: [],
      positions: [],
      lots: [],
    },
  };
}

export function planPreparationTicketComplete(
  database: CommerceDatabase,
  command: ManagePreparationTicketCommand,
  ticket: CommercePreparationTicketV1,
  resources: CommerceResourcesV1,
): PreparationTicketPlanResult {
  if (command.operation.kind !== "complete") {
    throw new Error(
      "Preparation ticket complete planner received another operation",
    );
  }
  if (ticket.revision !== command.operation.expectedTicketRevision)
    return preparationTicketRejected("preparationTicket.lifecycle");
  const complete = commerceTransition(
    "preparation_ticket",
    ticket.lifecycle,
    "complete",
  );
  if (!complete.allowed) return { kind: "rejected", error: complete.refusal };
  if (!timestampAtOrBefore(complete.from.startedAt, command.requestedAt)) {
    return preparationTicketRejected("preparationTicket.lifecycle.startedAt");
  }
  const order = resources.orders.find(
    (candidate) => candidate.id === ticket.orderId,
  );
  const fulfillment = resources.fulfillments.find(
    (candidate) => candidate.id === ticket.fulfillmentId,
  );
  if (
    order === undefined ||
    (order.origin.kind !== "online" && order.origin.kind !== "point_of_sale")
  ) {
    return preparationTicketRejected("preparationTicket.order.lifecycle");
  }
  const prepareMove = commerceTransition("order", order.lifecycle, "prepare");
  if (!prepareMove.allowed)
    return { kind: "rejected", error: prepareMove.refusal };
  if (
    fulfillment === undefined ||
    fulfillment.kind !== "pickup" ||
    fulfillment.orderId !== order.id ||
    fulfillment.locationId !== ticket.locationId
  ) {
    return preparationTicketRejected("preparationTicket.fulfillment.lifecycle");
  }
  const ticketPrepare = commerceTransition(
    "pickup_fulfillment",
    fulfillment.lifecycle,
    "prepare",
  );
  if (!ticketPrepare.allowed)
    return { kind: "rejected", error: ticketPrepare.refusal };
  const checkout = readCheckout(
    database,
    command.merchantId,
    order.origin.checkoutId,
  );
  if (
    checkout?.lifecycle.state !== "accepted" ||
    !checkoutMatchesPreparationOrder(order.origin, checkout) ||
    checkout.lifecycle.orderId !== order.id
  ) {
    return preparationTicketRejected("preparationTicket.checkout");
  }
  const allocations = listInventoryAllocations(database, command.merchantId);
  const currentLots = new Map<string, CommerceInventoryLotV1>();
  for (const lot of listInventoryLots(database, command.merchantId))
    currentLots.set(lot.id, lot);
  const changedLots = new Map<string, CommerceInventoryLotV1>();
  const plannedPositions = new Map<string, CommerceInventoryPositionV1>();
  const consumedAllocationIds = new Set<string>();
  const nextAllocations: InventoryAllocation[] = [];
  const movements: CommerceInventoryMovementV1[] = [];
  for (const snapshot of ticket.lineSnapshots) {
    const orderLine = order.lineItems.find(
      (line) => line.id === snapshot.orderLineId,
    );
    const checkoutLine = checkout.lifecycle.quote.lines.find(
      (line) =>
        orderLineIdFor(order.id, line.checkoutLineId) === snapshot.orderLineId,
    );
    if (
      orderLine?.source.kind !== "food_service" ||
      orderLine.source.preparation.kind !== "immediate_recipe" ||
      checkoutLine?.source.kind !== "food_service" ||
      checkoutLine.source.preparation.kind !== "immediate_recipe" ||
      checkoutLine.source.menuEntryId !== snapshot.menuEntryId ||
      checkoutLine.source.menuEntryRevision !== snapshot.menuEntryRevision ||
      checkoutLine.source.preparation.recipeId !== snapshot.recipeId ||
      checkoutLine.source.preparation.recipeRevision !== snapshot.recipeRevision
    ) {
      return preparationTicketRejected("preparationTicket.checkout.line");
    }
    const expectedAllocationIds = new Set(checkoutLine.allocationIds);
    if (
      expectedAllocationIds.size !== checkoutLine.allocationIds.length ||
      expectedAllocationIds.size !== snapshot.requirements.length
    ) {
      return preparationTicketRejected("preparationTicket.allocations");
    }
    const ownedAllocations = allocations.filter((allocation) =>
      allocationBelongsToOrderLine(
        allocation,
        ticket.orderId,
        snapshot.orderLineId,
      ),
    );
    if (
      ownedAllocations.some(
        (allocation) => !expectedAllocationIds.has(allocation.allocationId),
      ) ||
      expectedAllocationIds.size !== ownedAllocations.length
    ) {
      return preparationTicketRejected("preparationTicket.allocations.extra");
    }
    for (const requirement of snapshot.requirements) {
      const candidates = allocations.filter(
        (allocation) =>
          expectedAllocationIds.has(allocation.allocationId) &&
          !consumedAllocationIds.has(allocation.allocationId) &&
          allocation.inventoryItemId === requirement.inventoryItemId &&
          allocation.lifecycle.state === "allocated_to_order" &&
          allocation.lifecycle.orderId === ticket.orderId &&
          allocation.lifecycle.orderLineId === snapshot.orderLineId &&
          allocation.lifecycle.consumeOn === "preparation_completed",
      );
      if (
        candidates.length !== 1 ||
        candidates[0] === undefined ||
        !sameQuantity(candidates[0].quantity, requirement.quantity)
      ) {
        return preparationTicketRejected("preparationTicket.allocations");
      }
      const allocation = candidates[0];
      consumedAllocationIds.add(allocation.allocationId);
      if (allocation.locationId !== ticket.locationId)
        return preparationTicketRejected(
          "preparationTicket.allocation.location",
        );
      const item = resources.inventoryItems.find(
        (candidate) => candidate.id === allocation.inventoryItemId,
      );
      if (item === undefined || item.lifecycle !== "active")
        return preparationTicketRejected("preparationTicket.inventoryItem");
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
      if (
        position === undefined ||
        !isAccountedPosition(position) ||
        !accountedPositionCanCommit(position, allocation.quantity)
      ) {
        return preparationTicketRejected("preparationTicket.position");
      }
      const lotPlan = planSaleLotConsumption(
        item,
        allocation,
        currentLots,
        changedLots,
        command.requestedAt,
      );
      if (lotPlan.kind === "rejected")
        return preparationTicketRejected("preparationTicket.lotAvailability");
      const movementId = `movement_${sha256(`${command.merchantId}:${ticket.ticketId}:${allocation.allocationId}:preparation`)}`;
      const movement = parseInventoryMovement({
        id: movementId,
        inventoryItemId: allocation.inventoryItemId,
        locationId: allocation.locationId,
        change: {
          kind: "decrease",
          quantity: allocation.quantity,
          reason: {
            kind: "preparation",
            ticketId: ticket.ticketId,
            recipeRevision: snapshot.recipeRevision,
          },
          lotAllocation: lotPlan.allocation,
        },
        occurredAt: command.requestedAt,
        idempotencyKey: `${command.idempotencyKey}:${allocation.allocationId}`,
      });
      const nextPosition = committedInventoryPosition(
        position,
        allocation.quantity,
        command.requestedAt,
        plannedPositions.has(position.id),
      );
      plannedPositions.set(position.id, nextPosition);
      nextAllocations.push(
        parseInventoryAllocation({
          allocationId: allocation.allocationId,
          inventoryItemId: allocation.inventoryItemId,
          locationId: allocation.locationId,
          quantity: allocation.quantity,
          revision: allocation.revision + 1,
          lifecycle: {
            state: "committed",
            demand: {
              kind: "order",
              orderId: ticket.orderId,
              orderLineId: snapshot.orderLineId,
            },
            movementId,
            committedAt: command.requestedAt,
          },
        }),
      );
      movements.push(movement);
      for (const lot of lotPlan.lots) {
        currentLots.set(lot.id, lot);
        changedLots.set(lot.id, lot);
      }
    }
    if (
      ownedAllocations.some(
        (allocation) => !consumedAllocationIds.has(allocation.allocationId),
      )
    ) {
      return preparationTicketRejected("preparationTicket.allocations.extra");
    }
  }
  if (movements.length === 0)
    return preparationTicketRejected("preparationTicket.movements");
  const revision = ticket.revision + 1;
  const completed = parsePreparationTicket({
    provenance: preparationTicketProvenance(ticket.provenance, revision),
    ticketId: ticket.ticketId,
    orderId: ticket.orderId,
    fulfillmentId: ticket.fulfillmentId,
    locationId: ticket.locationId,
    stationId: ticket.stationId,
    revision,
    lineSnapshots: ticket.lineSnapshots,
    lifecycle: {
      state: "completed",
      completedAt: command.requestedAt,
      movementIds: movements.map((movement) => movement.id),
    },
  });
  return {
    kind: "planned",
    value: {
      ticket: completed,
      allocations: nextAllocations,
      movements,
      positions: [...plannedPositions.values()],
      lots: [...changedLots.values()],
    },
  };
}

function multiplyRequirement(
  requirement: InventoryRequirement,
  multiplier: number,
): InventoryRequirement | undefined {
  const amount = BigInt(requirement.quantity.amount) * BigInt(multiplier);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return {
    inventoryItemId: requirement.inventoryItemId,
    quantity: {
      amount: Number(amount),
      scale: requirement.quantity.scale,
      unit: requirement.quantity.unit,
    },
  };
}

function preparationTicketProvenance(
  provenance: CommercePreparationTicketV1["provenance"],
  revision: number,
): CommercePreparationTicketV1["provenance"] {
  return {
    organisationId: provenance.organisationId,
    integrationAccountId: provenance.integrationAccountId,
    source: provenance.source,
    resourceType: provenance.resourceType,
    resourceId: provenance.resourceId,
    revision,
    occurredAt: provenance.occurredAt,
    observedAt: provenance.observedAt,
  };
}

function allocationBelongsToOrderLine(
  allocation: InventoryAllocation,
  orderId: string,
  orderLineId: string,
): boolean {
  switch (allocation.lifecycle.state) {
    case "allocated_to_order":
      return (
        allocation.lifecycle.orderId === orderId &&
        allocation.lifecycle.orderLineId === orderLineId
      );
    case "committed":
      return (
        allocation.lifecycle.demand.kind === "order" &&
        allocation.lifecycle.demand.orderId === orderId &&
        allocation.lifecycle.demand.orderLineId === orderLineId
      );
    case "released":
    case "expired":
      return (
        allocation.lifecycle.demand.kind === "order" &&
        allocation.lifecycle.demand.orderId === orderId &&
        allocation.lifecycle.demand.orderLineId === orderLineId
      );
    case "held":
      return false;
  }
}

function checkoutMatchesPreparationOrder(
  origin: CommerceOrderOriginV1,
  checkout: Checkout,
): boolean {
  if (origin.kind === "online") {
    return checkoutOrderProfileMatches(origin, checkoutProfileOf(checkout));
  }
  if (origin.kind === "point_of_sale") {
    return (
      checkout.source.kind === "point_of_sale" &&
      checkout.source.pantryLocationId === origin.locationId
    );
  }
  return false;
}

function preparationTicketRejected(field: string): PreparationTicketPlanResult {
  return {
    kind: "rejected",
    error: { code: "resource_relationship_invalid", field },
  };
}
