// What an agent's stock proposal becomes: the current records, read now, and
// the exact change for the approval card. Each refusal is in words that the
// agent can act on. No stock moves here.
import { parseInventoryQuantityText } from "@seams/control-api";
import type { Quantity } from "@seams/contracts";
import {
  parseListEntryReadRequest,
  parseProductionRequestFields,
  purchaseRequestAttributeValues,
  type CommerceEntityPlaneClient,
  type CommerceStockSnapshot,
} from "@seams/commerce-client";
import type { CommerceListEntry } from "@seams/commerce-contracts";

import {
  StockActionRequestError,
  type StockOperation,
  type StockOperationAction,
} from "./stock-action";

export type StockProposalRequest = Readonly<{
  kind:
    | "receive_stock"
    | "count_stock"
    | "adjust_stock"
    | "request_production"
    | "advance_production_request"
    | "update_purchase_request";
  reason: string;
  /** The position or the list entry's revision that the agent read. */
  expectedRevision: number;
  inventoryPositionId: string | null;
  entryId: string | null;
  quantity: string | null;
  lotId: string | null;
  lotCode: string | null;
  lotExpiresAt: string | null;
  receivedAt: string | null;
  purchaseRequestEntryId: string | null;
  direction: "increase" | "decrease" | null;
  adjustmentReason: "correction" | "waste" | "damage" | null;
  recipeId: string | null;
  neededBy: string | null;
  status: "accepted" | "scheduled" | null;
  owner: string | null;
  purchaseRequestId: string | null;
  expectedDeliveryAt: string | null;
  notes: string | null;
}>;

type Observed = (
  entityType: string,
  entityId: string,
  revision: number,
) => boolean;

type PlanInput = Readonly<{
  organisationId: string;
  merchantId: string;
  snapshot: CommerceStockSnapshot;
  plane: CommerceEntityPlaneClient;
  observed: Observed;
  /** Canonical ids hold the provider id after the last colon. */
  providerId: (id: string) => string;
}>;

type Item =
  CommerceStockSnapshot["commerce"]["resources"]["inventoryItems"][number];

function refuse(words: string): never {
  throw new StockActionRequestError(words);
}

function requireField<T>(value: T | null, name: string, kind: string): T {
  if (value === null) refuse(`${kind} needs ${name}.`);
  return value;
}

function quantityOf(
  text: string | null,
  item: Item,
  kind: string,
  allowZero = false,
): Quantity {
  const value = requireField(text, "quantity", kind);
  try {
    return parseInventoryQuantityText(value, item.baseUnit, allowZero);
  } catch {
    return refuse(
      `The quantity "${value}" is not valid for ${item.name}. Give a decimal number in ${item.baseUnit}.`,
    );
  }
}

function timestamp(text: string, name: string): string {
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed))
    refuse(`${name} must be a date and time, such as 2026-11-03T06:00:00Z.`);
  return new Date(parsed).toISOString();
}

function positionContext(input: PlanInput, request: StockProposalRequest) {
  const id = requireField(
    request.inventoryPositionId,
    "inventoryPositionId",
    request.kind,
  );
  if (!input.observed("inventory_position", id, request.expectedRevision))
    refuse(
      "Read this stock position with commerce_entity_context first. Give its id and the revision that you read.",
    );
  const resources = input.snapshot.commerce.resources;
  const providerId = input.providerId(id);
  const position = resources.inventoryPositions.find(
    (candidate) => candidate.id === providerId,
  );
  if (position === undefined) refuse("This stock position no longer exists.");
  if (position.revision !== request.expectedRevision)
    refuse(
      `The stock position changed since that read: it is now at revision ${position.revision}. Read it again before you propose.`,
    );
  const item = resources.inventoryItems.find(
    (candidate) => candidate.id === position.inventoryItemId,
  );
  const location = resources.locations.find(
    (candidate) => candidate.id === position.locationId,
  );
  if (item === undefined || location === undefined)
    refuse("This stock position has no item or location.");
  return { position, item, location };
}

async function listEntry(
  input: PlanInput,
  listId: string,
  entryId: string,
): Promise<Readonly<{ entry: CommerceListEntry; listRevision: number }>> {
  const read = await input.plane.readListEntry(
    parseListEntryReadRequest({
      merchantId: input.merchantId,
      listId,
      entryId,
    }),
  );
  if (!read.ok) throw new Error("stock proposal list entry unavailable");
  if (read.value.kind === "missing")
    refuse(`List entry ${entryId} no longer exists.`);
  return {
    entry: read.value.entry,
    listRevision: Number(read.value.listRevision),
  };
}

function itemNameOf(input: PlanInput, itemId: string): string {
  return (
    input.snapshot.commerce.resources.inventoryItems.find(
      (candidate) => candidate.id === itemId,
    )?.name ?? itemId
  );
}

function attributeText(entry: CommerceListEntry, id: string): string | null {
  const value = entry.attributeValues.find(
    (attribute) => attribute.attributeId === id,
  )?.value;
  return value?.kind === "short_text" ? String(value.value) : null;
}

function planReceive(
  input: PlanInput,
  request: StockProposalRequest,
): Promise<StockOperation> | StockOperation {
  const { position, item, location } = positionContext(input, request);
  if (item.lifecycle !== "active") refuse(`${item.name} is not active.`);
  const lot = () => {
    if (item.tracking.kind !== "lot_tracked") {
      if (request.lotCode !== null)
        refuse(`${item.name} does not track lots. Set lotCode to null.`);
      return { kind: "not_tracked" } as const;
    }
    const lotCode = requireField(request.lotCode, "lotCode", request.kind);
    const expiresAt =
      request.lotExpiresAt === null
        ? null
        : timestamp(request.lotExpiresAt, "lotExpiresAt");
    if (item.tracking.expiry === "required" && expiresAt === null)
      refuse(`${item.name} tracks expiry. Give lotExpiresAt from the delivery.`);
    return { kind: "tracked", lotCode, expiresAt } as const;
  };
  const operation = (): StockOperation => ({
    kind: "receive_stock",
    inventoryItemId: item.id,
    inventoryPositionId: position.id,
    locationId: location.id,
    itemName: item.name,
    locationName: location.name,
    quantity: quantityOf(request.quantity, item, request.kind),
    lot: lot(),
    purchaseRequestEntryId: request.purchaseRequestEntryId,
    receivedAt:
      request.receivedAt === null
        ? null
        : timestamp(request.receivedAt, "receivedAt"),
  });
  if (request.purchaseRequestEntryId === null) return operation();
  return listEntry(
    input,
    "replenishment_queue",
    request.purchaseRequestEntryId,
  ).then(({ entry }) => {
    if (attributeText(entry, "inventory_item_id") !== item.id)
      refuse("That purchase request is for another item.");
    return operation();
  });
}

function planCount(
  input: PlanInput,
  request: StockProposalRequest,
): StockOperation {
  const { position, item, location } = positionContext(input, request);
  const lots = input.snapshot.lots.filter(
    (lot) =>
      lot.inventoryItemId === position.inventoryItemId &&
      lot.locationId === position.locationId,
  );
  const lot =
    request.lotId === null
      ? null
      : lots.find((candidate) => candidate.id === request.lotId);
  if (lot === undefined)
    refuse(`Lot ${request.lotId} is not at this stock position.`);
  if (item.tracking.kind === "lot_tracked" && lot === null)
    refuse(
      `${item.name} tracks lots. Name the lot that the person counted in lotId.`,
    );
  if (item.tracking.kind !== "lot_tracked" && lot !== null)
    refuse(`${item.name} does not track lots. Set lotId to null.`);
  const onHandAtProposal =
    lot !== null
      ? lot.remainingQuantity
      : position.balance.kind === "accounted"
        ? position.balance.onHand
        : null;
  return {
    kind: "count_stock",
    inventoryPositionId: position.id,
    expectedPositionRevision: position.revision,
    itemName: item.name,
    locationName: location.name,
    onHandAtProposal,
    target:
      lot === null
        ? { kind: "aggregate" }
        : {
            kind: "lot",
            lotId: lot.id,
            lotRevision: lot.revision,
            lotCode: lot.lotCode,
          },
    change:
      request.kind === "count_stock"
        ? {
            kind: "count",
            observedQuantity: quantityOf(
              request.quantity,
              item,
              request.kind,
              true,
            ),
          }
        : adjustment(request, item),
  };
}

function adjustment(request: StockProposalRequest, item: Item) {
  const direction = requireField(request.direction, "direction", request.kind);
  const reason = requireField(
    request.adjustmentReason,
    "adjustmentReason",
    request.kind,
  );
  if (direction === "increase" && reason !== "correction")
    refuse("An increase can only be a correction.");
  return {
    kind: "adjustment" as const,
    direction,
    quantity: quantityOf(request.quantity, item, request.kind),
    reason,
  };
}

async function publishedList(input: PlanInput, listId: string) {
  const metadata = await input.plane.publishedResourceMetadata({
    kind: "enumerate",
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (!metadata.ok || metadata.value.kind !== "enumerated")
    throw new Error("stock proposal list metadata unavailable");
  const list = metadata.value.lists.find(
    (candidate) => candidate.listId === listId,
  );
  if (list === undefined)
    refuse(
      listId === "production_requests"
        ? "Production requests are not set up. An owner or admin turns them on from the Stock page."
        : "Purchasing is not set up. An owner or admin turns it on from the Stock page.",
    );
  return list;
}

async function planProductionRequest(
  input: PlanInput,
  request: StockProposalRequest,
): Promise<StockOperation> {
  const { position, item, location } = positionContext(input, request);
  if (item.category !== "finished_good")
    refuse(`${item.name} is not a finished good. Only those have production requests.`);
  const quantity = quantityOf(request.quantity, item, request.kind);
  const neededBy = timestamp(
    requireField(request.neededBy, "neededBy", request.kind),
    "neededBy",
  );
  const active = input.snapshot.foodService.resources.recipeRevisions.filter(
    (recipe) =>
      recipe.lifecycle.state === "active" &&
      recipe.output.kind === "stocked" &&
      recipe.output.inventoryItemId === item.id &&
      recipe.output.yieldQuantity.unit === item.baseUnit,
  );
  const named =
    request.recipeId === null
      ? active
      : active.filter(
          (recipe) => String(recipe.recipeId) === request.recipeId,
        );
  const recipeIds = new Set(named.map((recipe) => String(recipe.recipeId)));
  if (recipeIds.size === 0)
    refuse(
      `${item.name} has no active recipe that matches. A person links one from the Stock page.`,
    );
  if (recipeIds.size > 1)
    refuse(
      `${item.name} has ${recipeIds.size} active recipes. Ask the person which recipe to use, and give recipeId.`,
    );
  const recipe = named.reduce((latest, candidate) =>
    candidate.revision > latest.revision ? candidate : latest,
  );
  const list = await publishedList(input, "production_requests");
  return {
    kind: "request_production",
    inventoryItemId: item.id,
    inventoryPositionId: position.id,
    locationId: location.id,
    itemName: item.name,
    locationName: location.name,
    recipeId: String(recipe.recipeId),
    recipeRevision: recipe.revision,
    recipeName: recipe.name,
    quantity,
    neededBy,
    listRevision: Number(list.publishedRevision),
  };
}

function observedEntry(
  input: PlanInput,
  request: StockProposalRequest,
  listId: string,
): string {
  const entryId = requireField(request.entryId, "entryId", request.kind);
  if (
    !input.observed(`list_entry:${listId}`, entryId, request.expectedRevision)
  )
    refuse(
      "Read this list entry with commerce_entity_context first. Give its entryId and the revision that you read.",
    );
  return entryId;
}

function staleEntry(entry: CommerceListEntry, expected: number): void {
  if (Number(entry.revision) !== expected)
    refuse(
      `The list entry changed since that read: it is now at revision ${Number(entry.revision)}. Read it again before you propose.`,
    );
}

async function planProductionAdvance(
  input: PlanInput,
  request: StockProposalRequest,
): Promise<StockOperation> {
  const entryId = observedEntry(input, request, "production_requests");
  const status = requireField(request.status, "status", request.kind);
  const { entry, listRevision } = await listEntry(
    input,
    "production_requests",
    entryId,
  );
  staleEntry(entry, request.expectedRevision);
  const fields = parseProductionRequestFields(entry.attributeValues);
  const from = status === "accepted" ? "requested" : "accepted";
  if (fields.status !== from)
    refuse(
      `This production request is ${fields.status}. It must be ${from} before it can become ${status}.`,
    );
  return {
    kind: "advance_production_request",
    entryId,
    expectedRevision: request.expectedRevision,
    listRevision,
    status,
    itemName: itemNameOf(input, String(entry.entityRef.entityId)),
    recipeId: fields.recipeId,
    recipeRevision: fields.recipeRevision,
    locationId: fields.locationId,
    quantity: fields.quantity,
    neededBy: fields.neededBy,
  };
}

async function planPurchaseUpdate(
  input: PlanInput,
  request: StockProposalRequest,
): Promise<StockOperation> {
  const entryId = observedEntry(input, request, "replenishment_queue");
  const owner = requireField(request.owner, "owner", request.kind);
  const purchaseRequestId = requireField(
    request.purchaseRequestId,
    "purchaseRequestId",
    request.kind,
  );
  const expectedDeliveryAt =
    request.expectedDeliveryAt === null
      ? null
      : timestamp(request.expectedDeliveryAt, "expectedDeliveryAt");
  const { entry } = await listEntry(input, "replenishment_queue", entryId);
  staleEntry(entry, request.expectedRevision);
  const list = await publishedList(input, "replenishment_queue");
  return {
    kind: "update_purchase_request",
    entryId,
    expectedRevision: request.expectedRevision,
    listRevision: Number(list.publishedRevision),
    itemName: itemNameOf(
      input,
      attributeText(entry, "inventory_item_id") ??
        String(entry.entityRef.entityId),
    ),
    owner,
    purchaseRequestId,
    expectedDeliveryAt,
    notes: request.notes,
    attributeValues: purchaseRequestAttributeValues(list, entry, {
      owner,
      purchaseRequestId,
      expectedDeliveryAt,
      notes: request.notes,
    }),
  };
}

export async function planStockOperation(
  input: PlanInput,
  request: StockProposalRequest,
): Promise<StockOperationAction> {
  const plan = (): Promise<StockOperation> | StockOperation => {
    switch (request.kind) {
      case "receive_stock":
        return planReceive(input, request);
      case "count_stock":
      case "adjust_stock":
        return planCount(input, request);
      case "request_production":
        return planProductionRequest(input, request);
      case "advance_production_request":
        return planProductionAdvance(input, request);
      case "update_purchase_request":
        return planPurchaseUpdate(input, request);
    }
  };
  return {
    kind: "stock_operation",
    reason: request.reason,
    operation: await plan(),
  };
}
