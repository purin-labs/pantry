import { isRecord } from "@seams/std";

export type StockQuantity = Readonly<{
  amount: number;
  scale: number;
  unit: string;
}>;

export type StockOperationView =
  | Readonly<{
      kind: "receive_stock";
      itemName: string;
      locationName: string;
      quantity: StockQuantity;
      lot:
        | Readonly<{ kind: "not_tracked" }>
        | Readonly<{
            kind: "tracked";
            lotCode: string;
            expiresAt: string | null;
          }>;
      purchaseRequestEntryId: string | null;
      receivedAt: string | null;
    }>
  | Readonly<{
      kind: "count_stock";
      itemName: string;
      locationName: string;
      onHandAtProposal: StockQuantity | null;
      target:
        | Readonly<{ kind: "aggregate" }>
        | Readonly<{ kind: "lot"; lotCode: string }>;
      change:
        | Readonly<{ kind: "count"; observedQuantity: StockQuantity }>
        | Readonly<{
            kind: "adjustment";
            direction: "increase" | "decrease";
            quantity: StockQuantity;
            reason: "correction" | "waste" | "damage";
          }>;
    }>
  | Readonly<{
      kind: "request_production";
      itemName: string;
      locationName: string;
      recipeName: string;
      quantity: StockQuantity;
      neededBy: string;
    }>
  | Readonly<{
      kind: "advance_production_request";
      itemName: string;
      status: "accepted" | "scheduled";
      quantity: StockQuantity;
      neededBy: string;
    }>
  | Readonly<{
      kind: "update_purchase_request";
      itemName: string;
      owner: string;
      purchaseRequestId: string;
      expectedDeliveryAt: string | null;
      notes: string | null;
    }>;

export type StockOperationDetails = Readonly<{
  kind: "stock_operation";
  reason: string;
  operation: StockOperationView;
}>;

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("Stock action details are invalid.");
  return value;
}

function optionalText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function quantity(value: unknown): StockQuantity {
  if (
    !isRecord(value) ||
    typeof value.amount !== "number" ||
    typeof value.scale !== "number"
  )
    throw new Error("Stock action details are invalid.");
  return { amount: value.amount, scale: value.scale, unit: text(value.unit) };
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Stock action details are invalid.");
  return value;
}

function parseOperation(raw: Record<string, unknown>): StockOperationView {
  switch (raw.kind) {
    case "receive_stock": {
      const lot = record(raw.lot);
      return {
        kind: raw.kind,
        itemName: text(raw.itemName),
        locationName: text(raw.locationName),
        quantity: quantity(raw.quantity),
        lot:
          lot.kind === "tracked"
            ? {
                kind: "tracked",
                lotCode: text(lot.lotCode),
                expiresAt: optionalText(lot.expiresAt),
              }
            : { kind: "not_tracked" },
        purchaseRequestEntryId: optionalText(raw.purchaseRequestEntryId),
        receivedAt: optionalText(raw.receivedAt),
      };
    }
    case "count_stock": {
      const target = record(raw.target);
      const change = record(raw.change);
      return {
        kind: raw.kind,
        itemName: text(raw.itemName),
        locationName: text(raw.locationName),
        onHandAtProposal:
          raw.onHandAtProposal === null ? null : quantity(raw.onHandAtProposal),
        target:
          target.kind === "lot"
            ? { kind: "lot", lotCode: text(target.lotCode) }
            : { kind: "aggregate" },
        change:
          change.kind === "count"
            ? {
                kind: "count",
                observedQuantity: quantity(change.observedQuantity),
              }
            : {
                kind: "adjustment",
                direction:
                  change.direction === "increase" ? "increase" : "decrease",
                quantity: quantity(change.quantity),
                reason:
                  change.reason === "waste" || change.reason === "damage"
                    ? change.reason
                    : "correction",
              },
      };
    }
    case "request_production":
      return {
        kind: raw.kind,
        itemName: text(raw.itemName),
        locationName: text(raw.locationName),
        recipeName: text(raw.recipeName),
        quantity: quantity(raw.quantity),
        neededBy: text(raw.neededBy),
      };
    case "advance_production_request":
      return {
        kind: raw.kind,
        itemName: text(raw.itemName),
        status: raw.status === "scheduled" ? "scheduled" : "accepted",
        quantity: quantity(raw.quantity),
        neededBy: text(raw.neededBy),
      };
    case "update_purchase_request":
      return {
        kind: raw.kind,
        itemName: text(raw.itemName),
        owner: text(raw.owner),
        purchaseRequestId: text(raw.purchaseRequestId),
        expectedDeliveryAt: optionalText(raw.expectedDeliveryAt),
        notes: raw.notes === null ? null : String(raw.notes),
      };
    default:
      throw new Error("Stock action details are invalid.");
  }
}

export function parseStockOperationDetails(
  raw: Record<string, unknown>,
): StockOperationDetails {
  return {
    kind: "stock_operation",
    reason: text(raw.reason),
    operation: parseOperation(record(raw.operation)),
  };
}
