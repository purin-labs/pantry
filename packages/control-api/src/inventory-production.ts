import type { Quantity } from "@purin-labs/contracts";
import { isPositiveInteger, isRecord } from "@purin-labs/std";
import { parseInventoryQuantity } from "./inventory-receipt.ts";

export type InventoryProductionRecipe = Readonly<{
  id: string;
  revision: number;
  name: string;
  yield: Quantity;
  inputs: readonly {
    name: string;
    quantity: Quantity;
    available: Quantity | null;
  }[];
}>;
export type InventoryProductionCreation = Readonly<{
  kind: "create";
  merchantRevision: number;
  listRevision: number;
  positionId: string;
  positionRevision: number;
  inventoryItemId: string;
  locationId: string;
  recipeId: string;
  recipeRevision: number;
  quantity: Quantity;
  neededBy: string;
  requestedAt: string;
}>;
export type InventoryProductionTransition = Readonly<{
  kind: "accept" | "schedule";
  merchantRevision: number;
  listRevision: number;
  requestId: string;
  requestRevision: number;
  recipeId: string;
  recipeRevision: number;
  locationId: string;
  quantity: Quantity;
  neededBy: string;
  requestedAt: string;
}>;

export function parseInventoryProductionTransition(
  value: unknown,
): InventoryProductionTransition {
  if (
    !isRecord(value) ||
    (value.kind !== "accept" && value.kind !== "schedule") ||
    !isPositiveInteger(value.merchantRevision) ||
    !isPositiveInteger(value.listRevision) ||
    !isPositiveInteger(value.requestRevision) ||
    !isPositiveInteger(value.recipeRevision)
  )
    throw new Error("Production transition is invalid.");
  const quantity = parseInventoryQuantity(value.quantity);
  const neededBy = text(value.neededBy);
  const requestedAt = text(value.requestedAt);
  if (
    quantity.amount === 0 ||
    BigInt(quantity.amount) * 10n ** BigInt(6 - quantity.scale) >
      BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isFinite(Date.parse(neededBy)) ||
    !Number.isFinite(Date.parse(requestedAt))
  )
    throw new Error("Production transition is invalid.");
  return {
    kind: value.kind,
    merchantRevision: value.merchantRevision,
    listRevision: value.listRevision,
    requestId: text(value.requestId),
    requestRevision: value.requestRevision,
    recipeId: text(value.recipeId),
    recipeRevision: value.recipeRevision,
    locationId: text(value.locationId),
    quantity,
    neededBy,
    requestedAt,
  };
}

export function parseInventoryProductionCreation(
  value: unknown,
): InventoryProductionCreation {
  if (
    !isRecord(value) ||
    value.kind !== "create" ||
    !isPositiveInteger(value.merchantRevision) ||
    !isPositiveInteger(value.listRevision) ||
    !isPositiveInteger(value.positionRevision) ||
    !isPositiveInteger(value.recipeRevision)
  )
    throw new Error("Production submission is invalid.");
  const quantity = parseInventoryQuantity(value.quantity);
  const neededBy = text(value.neededBy);
  const requestedAt = text(value.requestedAt);
  if (
    quantity.amount === 0 ||
    BigInt(quantity.amount) * 10n ** BigInt(6 - quantity.scale) >
      BigInt(Number.MAX_SAFE_INTEGER) ||
    !Number.isFinite(Date.parse(neededBy)) ||
    !Number.isFinite(Date.parse(requestedAt))
  )
    throw new Error("Production submission is invalid.");
  return {
    kind: "create",
    merchantRevision: value.merchantRevision,
    listRevision: value.listRevision,
    positionId: text(value.positionId),
    positionRevision: value.positionRevision,
    inventoryItemId: text(value.inventoryItemId),
    locationId: text(value.locationId),
    recipeId: text(value.recipeId),
    recipeRevision: value.recipeRevision,
    quantity,
    neededBy,
    requestedAt,
  };
}
export type InventoryProductionRequest = Readonly<{
  id: string;
  revision: number;
  itemId: string;
  name: string;
  locationId: string;
  recipeId: string;
  recipeRevision: number;
  quantity: Quantity;
  neededBy: string;
  status: "requested" | "accepted" | "scheduled";
  batches: readonly { id: string; actualYield: Quantity }[];
}>;
export type InventoryProductionContext = Readonly<{
  merchantRevision: number;
  inventoryItemId: string;
  inventoryPositionId: string;
  inventoryPositionRevision: number;
  locationId: string;
  itemName: string;
  recipes: readonly InventoryProductionRecipe[];
  linkableRecipes: readonly InventoryProductionRecipe[];
  demand:
    | { kind: "inactive" }
    | { kind: "unavailable" }
    | {
        kind: "ready";
        listRevision: number;
        merchantRevision: number;
        requests: readonly InventoryProductionRequest[];
        invalidRequests: readonly { id: string; message: string }[];
        nextCursor: string | null;
      };
}>;

export function parseInventoryProductionContext(
  raw: unknown,
): InventoryProductionContext {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.context))
    throw new Error("Production details are unavailable.");
  const value = raw.context;
  if (
    !isPositiveInteger(value.merchantRevision) ||
    !isPositiveInteger(value.inventoryPositionRevision) ||
    !Array.isArray(value.recipes) ||
    !Array.isArray(value.linkableRecipes)
  )
    throw new Error("Production details are invalid.");
  return {
    merchantRevision: value.merchantRevision,
    inventoryItemId: text(value.inventoryItemId),
    inventoryPositionId: text(value.inventoryPositionId),
    inventoryPositionRevision: value.inventoryPositionRevision,
    locationId: text(value.locationId),
    itemName: text(value.itemName),
    recipes: value.recipes.map(parseRecipe),
    linkableRecipes: value.linkableRecipes.map(parseRecipe),
    demand: parseProductionDemand(value.demand),
  };
}
export function parseProductionDemand(
  value: unknown,
): InventoryProductionContext["demand"] {
  if (!isRecord(value)) throw new Error("Production requests are invalid.");
  if (value.kind === "inactive" || value.kind === "unavailable")
    return { kind: value.kind };
  if (
    value.kind === "ready" &&
    isPositiveInteger(value.listRevision) &&
    isPositiveInteger(value.merchantRevision) &&
    Array.isArray(value.requests) &&
    Array.isArray(value.invalidRequests) &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  )
    return {
      kind: "ready",
      listRevision: value.listRevision,
      merchantRevision: value.merchantRevision,
      requests: value.requests.map(parseRequest),
      invalidRequests: value.invalidRequests.map(parseInvalidRequest),
      nextCursor: value.nextCursor,
    };
  throw new Error("Production requests are invalid.");
}
function parseRecipe(value: unknown): InventoryProductionRecipe {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.revision) ||
    !Array.isArray(value.inputs)
  )
    throw new Error("Recipe is invalid.");
  return {
    id: text(value.id),
    revision: value.revision,
    name: text(value.name),
    yield: parseInventoryQuantity(value.yield),
    inputs: value.inputs.map(parseInput),
  };
}
function parseInput(
  value: unknown,
): InventoryProductionRecipe["inputs"][number] {
  if (!isRecord(value)) throw new Error("Recipe input is invalid.");
  return {
    name: text(value.name),
    quantity: parseInventoryQuantity(value.quantity),
    available:
      value.available === null ? null : parseInventoryQuantity(value.available),
  };
}
function parseRequest(value: unknown): InventoryProductionRequest {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.revision) ||
    !isPositiveInteger(value.recipeRevision) ||
    !Array.isArray(value.batches) ||
    (value.status !== "requested" &&
      value.status !== "accepted" &&
      value.status !== "scheduled")
  )
    throw new Error("Production request is invalid.");
  return {
    id: text(value.id),
    revision: value.revision,
    itemId: text(value.itemId),
    name: text(value.name),
    locationId: text(value.locationId),
    recipeId: text(value.recipeId),
    recipeRevision: value.recipeRevision,
    quantity: parseInventoryQuantity(value.quantity),
    neededBy: text(value.neededBy),
    status: value.status,
    batches: value.batches.map(parseBatch),
  };
}
function parseBatch(
  value: unknown,
): InventoryProductionRequest["batches"][number] {
  if (!isRecord(value)) throw new Error("Production batch is invalid.");
  return {
    id: text(value.id),
    actualYield: parseInventoryQuantity(value.actualYield),
  };
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("Production details are incomplete.");
  return value;
}

function parseInvalidRequest(value: unknown): { id: string; message: string } {
  if (!isRecord(value)) throw new Error("Invalid production reference.");
  return { id: text(value.id), message: text(value.message) };
}

/**
 * Plan 40D: "Accept plan" for one location. Each line is a request that the
 * person saw as `requested`, at the revision and with the planned quantity
 * that the page showed.
 */
export type InventoryProductionPlanLine = Readonly<{
  requestId: string;
  requestRevision: number;
  quantity: string;
}>;
export type InventoryProductionPlanAcceptance = Readonly<{
  kind: "accept_plan";
  lines: readonly InventoryProductionPlanLine[];
}>;
export type InventoryProductionPlanRefusal =
  "request_missing" | "request_changed" | "quantity_invalid";
export type InventoryProductionPlanOutcome = Readonly<{
  requestId: string;
  /** Whether this accept changed the request's quantity. */
  revised: boolean;
}> &
  (
    | Readonly<{ outcome: "accepted"; quantity: Quantity }>
    | Readonly<{ outcome: "refused"; reason: InventoryProductionPlanRefusal }>
    | Readonly<{ outcome: "unavailable" }>
  );
export type InventoryProductionPlanResult = Readonly<{
  ok: true;
  lines: readonly InventoryProductionPlanOutcome[];
}>;

export const PRODUCTION_PLAN_ACCEPT_LIMIT = 100;

export function parseInventoryProductionPlanAcceptance(
  value: unknown,
): InventoryProductionPlanAcceptance {
  if (
    !isRecord(value) ||
    value.kind !== "accept_plan" ||
    !Array.isArray(value.lines) ||
    value.lines.length === 0 ||
    value.lines.length > PRODUCTION_PLAN_ACCEPT_LIMIT
  )
    throw new Error("Production plan is invalid.");
  const lines = value.lines.map(parsePlanLine);
  if (new Set(lines.map(planLineRequest)).size !== lines.length)
    throw new Error("Production plan repeats a request.");
  return { kind: "accept_plan", lines };
}

export function parseInventoryProductionPlanResult(
  value: unknown,
): InventoryProductionPlanResult {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.lines))
    throw new Error("Production plan result is invalid.");
  return { ok: true, lines: value.lines.map(parsePlanOutcome) };
}

function parsePlanLine(value: unknown): InventoryProductionPlanLine {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.requestRevision) ||
    typeof value.quantity !== "string" ||
    !/^\d{1,15}(?:\.\d{1,6})?$/u.test(value.quantity)
  )
    throw new Error("Production plan line is invalid.");
  return {
    requestId: text(value.requestId),
    requestRevision: value.requestRevision,
    quantity: value.quantity,
  };
}

function planLineRequest(line: InventoryProductionPlanLine): string {
  return line.requestId;
}

function parsePlanOutcome(value: unknown): InventoryProductionPlanOutcome {
  if (!isRecord(value) || typeof value.revised !== "boolean")
    throw new Error("Production plan result is invalid.");
  const base = { requestId: text(value.requestId), revised: value.revised };
  switch (value.outcome) {
    case "accepted":
      return {
        ...base,
        outcome: "accepted",
        quantity: parseInventoryQuantity(value.quantity),
      };
    case "refused":
      if (
        value.reason !== "request_missing" &&
        value.reason !== "request_changed" &&
        value.reason !== "quantity_invalid"
      )
        throw new Error("Production plan result is invalid.");
      return { ...base, outcome: "refused", reason: value.reason };
    case "unavailable":
      return { ...base, outcome: "unavailable" };
    default:
      throw new Error("Production plan result is invalid.");
  }
}
