import type {
  InventoryTrackingPolicy,
  QuantityUnit,
  Quantity,
} from "@purin-labs/commerce-contracts";
import { isPositiveInteger, isRecord } from "@purin-labs/std";

export type InventoryReceiptContext = Readonly<{
  merchantRevision: number;
  inventoryItemId: string;
  inventoryItemRevision: number;
  inventoryPositionId: string;
  inventoryPositionRevision: number;
  locationId: string;
  itemName: string;
  locationName: string;
  unit: QuantityUnit;
  tracking: InventoryTrackingPolicy;
  onHand: string | null;
  available: string;
  allocated: string | null;
  onHandQuantity: Quantity | null;
  lots: readonly {
    id: string;
    revision: number;
    code: string;
    quantity: Quantity;
  }[];
  purchases:
    | { kind: "unavailable" }
    | {
        kind: "ready";
        entries: readonly {
          id: string;
          revision: number;
          supplier: string;
          required: string;
          received: string;
        }[];
      };
}>;

/** One purchase that has not fully arrived, with its delivery date if any. */
export type InventoryDelivery = Readonly<{
  id: string;
  inventoryItemId: string;
  locationId: string;
  supplier: string;
  status: string;
  required: string;
  received: string;
  expectedAt: string | null;
}>;

export type InventoryDeliveries =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "ready";
      entries: readonly InventoryDelivery[];
      /** True when more purchases are open than one read carries. */
      truncated: boolean;
    }>;

export function parseInventoryDeliveries(raw: unknown): InventoryDeliveries {
  if (!isRecord(raw)) throw new Error("Deliveries are unavailable.");
  if (raw.kind === "unavailable") return { kind: "unavailable" };
  if (
    raw.kind !== "ready" ||
    !Array.isArray(raw.entries) ||
    typeof raw.truncated !== "boolean"
  )
    throw new Error("Deliveries are invalid.");
  return {
    kind: "ready",
    entries: raw.entries.map(parseDelivery),
    truncated: raw.truncated,
  };
}

function parseDelivery(value: unknown): InventoryDelivery {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isText(value.inventoryItemId) ||
    !isText(value.locationId) ||
    !isText(value.supplier) ||
    !isText(value.status) ||
    !isText(value.required) ||
    !isText(value.received) ||
    !(value.expectedAt === null || isText(value.expectedAt))
  )
    throw new Error("Delivery is invalid.");
  return {
    id: value.id,
    inventoryItemId: value.inventoryItemId,
    locationId: value.locationId,
    supplier: value.supplier,
    status: value.status,
    required: value.required,
    received: value.received,
    expectedAt: value.expectedAt,
  };
}

export function parseInventoryReceiptContext(
  raw: unknown,
): InventoryReceiptContext {
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.context))
    throw new Error("Receiving is unavailable.");
  const value = raw.context;
  if (
    !isPositiveInteger(value.merchantRevision) ||
    !isPositiveInteger(value.inventoryItemRevision) ||
    !isPositiveInteger(value.inventoryPositionRevision) ||
    !isText(value.inventoryItemId) ||
    !isText(value.inventoryPositionId) ||
    !isText(value.locationId) ||
    !isText(value.itemName) ||
    !isText(value.locationName) ||
    !isText(value.available) ||
    (value.onHand !== null && !isText(value.onHand))
  )
    throw new Error("Receiving details are invalid.");
  return {
    merchantRevision: value.merchantRevision,
    inventoryItemId: value.inventoryItemId,
    inventoryItemRevision: value.inventoryItemRevision,
    inventoryPositionId: value.inventoryPositionId,
    inventoryPositionRevision: value.inventoryPositionRevision,
    locationId: value.locationId,
    itemName: value.itemName,
    locationName: value.locationName,
    unit: parseUnit(value.unit),
    tracking: parseTracking(value.tracking),
    onHand: value.onHand,
    available: value.available,
    allocated: nullableDisplay(value.allocated),
    onHandQuantity:
      value.onHandQuantity === null
        ? null
        : parseInventoryQuantity(value.onHandQuantity),
    lots: parseLots(value.lots),
    purchases: parsePurchases(value.purchases),
  };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseUnit(raw: unknown): QuantityUnit {
  switch (raw) {
    case "each":
    case "gram":
    case "kilogram":
    case "milliliter":
    case "liter":
      return raw;
    default:
      throw new Error("Receiving unit is invalid.");
  }
}

function parseTracking(raw: unknown): InventoryTrackingPolicy {
  if (!isRecord(raw)) throw new Error("Stock tracking is invalid.");
  if (raw.kind === "aggregate") return { kind: "aggregate" };
  if (
    raw.kind === "lot_tracked" &&
    (raw.expiry === "required" || raw.expiry === "optional")
  )
    return { kind: "lot_tracked", expiry: raw.expiry };
  throw new Error("Stock tracking is invalid.");
}

function nullableDisplay(value: unknown): string | null {
  if (value === null || isText(value)) return value;
  throw new Error("Stock quantity is invalid.");
}
export function parseInventoryQuantity(value: unknown): Quantity {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.amount) ||
    Number(value.amount) < 0 ||
    !Number.isSafeInteger(value.scale) ||
    Number(value.scale) < 0 ||
    Number(value.scale) > 6
  )
    throw new Error("Stock quantity is invalid.");
  const unit = parseUnit(value.unit);
  if (unit === "each" && value.scale !== 0)
    throw new Error("Whole units are required.");
  return { amount: Number(value.amount), scale: Number(value.scale), unit };
}
function parseLots(value: unknown): InventoryReceiptContext["lots"] {
  if (!Array.isArray(value)) throw new Error("Lots are unavailable.");
  return value.map(parseLot);
}
function parseLot(value: unknown): InventoryReceiptContext["lots"][number] {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isText(value.code) ||
    !isPositiveInteger(value.revision)
  )
    throw new Error("Lot is invalid.");
  return {
    id: value.id,
    revision: value.revision,
    code: value.code,
    quantity: parseInventoryQuantity(value.quantity),
  };
}
function parsePurchases(value: unknown): InventoryReceiptContext["purchases"] {
  if (!isRecord(value)) throw new Error("Purchasing is unavailable.");
  if (value.kind === "unavailable") return { kind: "unavailable" };
  if (value.kind === "ready" && Array.isArray(value.entries))
    return { kind: "ready", entries: value.entries.map(parsePurchase) };
  throw new Error("Purchase requests are invalid.");
}
function parsePurchase(value: unknown) {
  if (
    !isRecord(value) ||
    !isText(value.id) ||
    !isPositiveInteger(value.revision) ||
    !isText(value.supplier) ||
    !isText(value.required) ||
    !isText(value.received)
  )
    throw new Error("Purchase request is invalid.");
  return {
    id: value.id,
    revision: value.revision,
    supplier: value.supplier,
    required: value.required,
    received: value.received,
  };
}

export function parseInventoryQuantityText(
  text: string,
  unit: QuantityUnit,
  allowZero = false,
): Quantity {
  if (!/^\d+(?:\.\d{1,6})?$/u.test(text))
    throw new Error("Enter a positive quantity with up to six decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const amount = Number(`${whole}${fraction}`);
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    (!allowZero && amount === 0)
  )
    throw new Error("Enter a positive quantity within the supported range.");
  if (unit === "each" && fraction.length > 0)
    throw new Error("Enter a whole number of pieces.");
  return { amount, scale: fraction.length, unit };
}
