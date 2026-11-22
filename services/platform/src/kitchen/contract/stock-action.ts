// The governed actions that change stock, production requests and purchase
// requests (Plan 81 slice 6). The proposal freezes what the card shows in the
// action path, so an approval signs that exact change. Commerce checks the
// revisions at commit.
import { isRecord } from "@purin-labs/std";
import type { Quantity } from "@purin-labs/commerce-contracts";
import type { ListEntryAttributeValue } from "@purin-labs/commerce-contracts";

import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import type { Result } from "@purin-labs/kernel/result";

/** A refusal that the agent can act on, returned as the tool's words. */
export class StockActionRequestError extends ToolRequestError {}

export type StockReceiveOperation = Readonly<{
  kind: "receive_stock";
  inventoryItemId: string;
  inventoryPositionId: string;
  locationId: string;
  itemName: string;
  locationName: string;
  quantity: Quantity;
  lot:
    | Readonly<{ kind: "not_tracked" }>
    | Readonly<{ kind: "tracked"; lotCode: string; expiresAt: string | null }>;
  /** The purchase request that this delivery answers, if any. */
  purchaseRequestEntryId: string | null;
  /** Null records the time of the approved execution. */
  receivedAt: string | null;
}>;

export type StockCountOperation = Readonly<{
  kind: "count_stock";
  inventoryPositionId: string;
  expectedPositionRevision: number;
  itemName: string;
  locationName: string;
  /** What the record said when the agent proposed the change. */
  onHandAtProposal: Quantity | null;
  target:
    | Readonly<{ kind: "aggregate" }>
    | Readonly<{
        kind: "lot";
        lotId: string;
        lotRevision: number;
        lotCode: string;
      }>;
  change:
    | Readonly<{ kind: "count"; observedQuantity: Quantity }>
    | Readonly<{
        kind: "adjustment";
        direction: "increase" | "decrease";
        quantity: Quantity;
        reason: "correction" | "waste" | "damage";
      }>;
}>;

export type StockProductionRequestOperation = Readonly<{
  kind: "request_production";
  inventoryItemId: string;
  inventoryPositionId: string;
  locationId: string;
  itemName: string;
  locationName: string;
  recipeId: string;
  recipeRevision: number;
  recipeName: string;
  quantity: Quantity;
  neededBy: string;
  listRevision: number;
}>;

export type StockProductionAdvanceOperation = Readonly<{
  kind: "advance_production_request";
  entryId: string;
  expectedRevision: number;
  listRevision: number;
  status: "accepted" | "scheduled";
  itemName: string;
  recipeId: string;
  recipeRevision: number;
  locationId: string;
  quantity: Quantity;
  neededBy: string;
}>;

export type StockPurchaseRequestOperation = Readonly<{
  kind: "update_purchase_request";
  entryId: string;
  expectedRevision: number;
  listRevision: number;
  itemName: string;
  owner: string;
  purchaseRequestId: string;
  expectedDeliveryAt: string | null;
  notes: string | null;
  attributeValues: readonly ListEntryAttributeValue[];
}>;

export type StockOperation =
  | StockReceiveOperation
  | StockCountOperation
  | StockProductionRequestOperation
  | StockProductionAdvanceOperation
  | StockPurchaseRequestOperation;

export type StockOperationAction = Readonly<{
  kind: "stock_operation";
  /** The sentence that the approver reads, and the count's explanation. */
  reason: string;
  operation: StockOperation;
}>;

const STOCK_VERBS = {
  receive_stock: "commerce.stock.receive",
  count_stock: "commerce.stock.count",
  request_production: "commerce.production_request.create",
  advance_production_request: "commerce.production_request.advance",
  update_purchase_request: "commerce.purchase_request.update",
} as const satisfies Record<StockOperation["kind"], string>;

export function stockOperationVerb(operation: StockOperation): string {
  return STOCK_VERBS[operation.kind];
}

export function isStockOperationVerb(verb: string): boolean {
  return (Object.values(STOCK_VERBS) as readonly string[]).includes(verb);
}

/** The record that the ledger names for this action. */
export function stockOperationResourceId(operation: StockOperation): string {
  switch (operation.kind) {
    case "receive_stock":
    case "count_stock":
    case "request_production":
      return operation.inventoryPositionId;
    case "advance_production_request":
    case "update_purchase_request":
      return operation.entryId;
  }
}

/** The revision that the action binds; a receipt adds to the current one. */
export function stockOperationExpectedRevision(
  operation: StockOperation,
): number {
  switch (operation.kind) {
    case "count_stock":
      return operation.expectedPositionRevision;
    case "advance_production_request":
    case "update_purchase_request":
      return operation.expectedRevision;
    case "receive_stock":
    case "request_production":
      return 0;
  }
}

type ParseError = Readonly<{ code: "commerce_action_invalid"; field: string }>;

function invalid(field: string): Result<never, ParseError> {
  return { ok: false, error: { code: "commerce_action_invalid", field } };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isQuantity(value: unknown): value is Quantity {
  return (
    isRecord(value) &&
    typeof value.amount === "number" &&
    Number.isSafeInteger(value.amount) &&
    value.amount >= 0 &&
    typeof value.scale === "number" &&
    Number.isSafeInteger(value.scale) &&
    value.scale >= 0 &&
    isText(value.unit)
  );
}

function hasText(raw: Record<string, unknown>, keys: readonly string[]) {
  return keys.every((key) => isText(raw[key]));
}

function isReceive(raw: Record<string, unknown>): boolean {
  const lot = raw.lot;
  return (
    hasText(raw, [
      "inventoryItemId",
      "inventoryPositionId",
      "locationId",
      "itemName",
      "locationName",
    ]) &&
    isQuantity(raw.quantity) &&
    isRecord(lot) &&
    (lot.kind === "not_tracked" ||
      (lot.kind === "tracked" &&
        isText(lot.lotCode) &&
        (lot.expiresAt === null || isText(lot.expiresAt)))) &&
    (raw.purchaseRequestEntryId === null ||
      isText(raw.purchaseRequestEntryId)) &&
    (raw.receivedAt === null || isText(raw.receivedAt))
  );
}

function isCount(raw: Record<string, unknown>): boolean {
  const target = raw.target;
  const change = raw.change;
  return (
    hasText(raw, ["inventoryPositionId", "itemName", "locationName"]) &&
    isRevision(raw.expectedPositionRevision) &&
    (raw.onHandAtProposal === null || isQuantity(raw.onHandAtProposal)) &&
    isRecord(target) &&
    (target.kind === "aggregate" ||
      (target.kind === "lot" &&
        hasText(target, ["lotId", "lotCode"]) &&
        isRevision(target.lotRevision))) &&
    isRecord(change) &&
    ((change.kind === "count" && isQuantity(change.observedQuantity)) ||
      (change.kind === "adjustment" &&
        (change.direction === "increase" || change.direction === "decrease") &&
        isQuantity(change.quantity) &&
        (change.reason === "correction" ||
          (change.direction === "decrease" &&
            (change.reason === "waste" || change.reason === "damage")))))
  );
}

function isProductionRequest(raw: Record<string, unknown>): boolean {
  return (
    hasText(raw, [
      "inventoryItemId",
      "inventoryPositionId",
      "locationId",
      "itemName",
      "locationName",
      "recipeId",
      "recipeName",
      "neededBy",
    ]) &&
    isRevision(raw.recipeRevision) &&
    isRevision(raw.listRevision) &&
    isQuantity(raw.quantity)
  );
}

function isProductionAdvance(raw: Record<string, unknown>): boolean {
  return (
    hasText(raw, ["entryId", "itemName", "recipeId", "locationId", "neededBy"]) &&
    isRevision(raw.expectedRevision) &&
    isRevision(raw.listRevision) &&
    isRevision(raw.recipeRevision) &&
    (raw.status === "accepted" || raw.status === "scheduled") &&
    isQuantity(raw.quantity)
  );
}

function isPurchaseUpdate(raw: Record<string, unknown>): boolean {
  return (
    hasText(raw, ["entryId", "itemName", "owner", "purchaseRequestId"]) &&
    isRevision(raw.expectedRevision) &&
    isRevision(raw.listRevision) &&
    (raw.expectedDeliveryAt === null || isText(raw.expectedDeliveryAt)) &&
    (raw.notes === null || typeof raw.notes === "string") &&
    Array.isArray(raw.attributeValues)
  );
}

function isOperation(raw: unknown): raw is StockOperation {
  if (!isRecord(raw)) return false;
  switch (raw.kind) {
    case "receive_stock":
      return isReceive(raw);
    case "count_stock":
      return isCount(raw);
    case "request_production":
      return isProductionRequest(raw);
    case "advance_production_request":
      return isProductionAdvance(raw);
    case "update_purchase_request":
      return isPurchaseUpdate(raw);
    default:
      return false;
  }
}

export function parseStockOperationAction(
  raw: Record<string, unknown>,
): Result<StockOperationAction, ParseError> {
  if (!isText(raw.reason) || raw.reason.length > 256) return invalid("reason");
  if (!isOperation(raw.operation)) return invalid("operation");
  return {
    ok: true,
    value: {
      kind: "stock_operation",
      reason: raw.reason,
      operation: raw.operation,
    },
  };
}

export function stockOperationActionPath(action: StockOperationAction): string {
  const params = new URLSearchParams({ definition: JSON.stringify(action) });
  return `/stock/${encodeURIComponent(stockOperationResourceId(action.operation))}/operation?${params.toString()}`;
}

/** Null when this is not a stock action. */
export function parseStockOperationActionPath(
  verb: string,
  url: URL,
): Result<StockOperationAction, ParseError> | null {
  if (!isStockOperationVerb(verb)) return null;
  const definition = url.searchParams.get("definition");
  if (definition === null) return invalid("path");
  let raw: unknown;
  try {
    raw = JSON.parse(definition);
  } catch {
    return invalid("path");
  }
  if (!isRecord(raw) || raw.kind !== "stock_operation") return invalid("path");
  const parsed = parseStockOperationAction(raw);
  if (!parsed.ok) return parsed;
  return url.pathname ===
    `/stock/${encodeURIComponent(stockOperationResourceId(parsed.value.operation))}/operation` &&
    stockOperationVerb(parsed.value.operation) === verb
    ? parsed
    : invalid("path");
}
