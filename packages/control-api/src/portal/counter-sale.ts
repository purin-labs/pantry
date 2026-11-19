import type { CounterSaleState } from "../index.ts";
import {
  isCounterRegisterPaymentMethod,
  type CounterRegisterPaymentMethod,
} from "../counter-register.ts";
import { exhaustiveList, hasExactKeys } from "@purin-labs/std";

export type CounterSaleManualTender = Readonly<{
  cashReceivedMinor: number | null;
  changeDueMinor: number | null;
  currency: string;
}>;

export type CounterSale = Readonly<{
  checkoutId: string;
  satyrLocationId: string;
  revision: number;
  state: CounterSaleState;
  collectable: boolean;
  recoverable: Readonly<{
    paymentAttemptId: string;
    reasonCode: string;
    reconcileAfter: string;
  }> | null;
  quote: Readonly<{
    quoteDigest: string;
    checkoutRevision: number;
    lineCount: number;
    amount: Readonly<{ amountMinor: number; currency: string }>;
  }> | null;
  orderId: string | null;
  capturedPaymentReference: string | null;
  pickupCode?: string | null;
  paymentMethod?: CounterRegisterPaymentMethod | null;
  tenderBrand?: string | null;
  providerRefundable?: boolean | null;
  manualTender?: CounterSaleManualTender | null;
  afterSale: Readonly<{
    order: Readonly<{ id: string; revision: number; state: string }>;
    payment: Readonly<{ id: string; revision: number; state: string }>;
    fulfillment: Readonly<{ id: string; revision: number; state: string }>;
    refundState: "none" | "pending" | "completed" | "failed";
  }> | null;
}>;

const REQUIRED_SALE_KEYS = [
  "schemaVersion",
  "checkoutId",
  "satyrLocationId",
  "revision",
  "state",
  "collectable",
  "recoverable",
  "quote",
  "orderId",
  "capturedPaymentReference",
  "afterSale",
] as const;

const ALLOWED_SALE_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_SALE_KEYS,
  "pickupCode",
  "paymentMethod",
  "tenderBrand",
  "providerRefundable",
  "manualTender",
]);

const SALE_STATES = exhaustiveList<CounterSaleState>()([
  "awaiting_collection",
  "collecting",
  "submission_unknown",
  "declined",
  "captured_unplaced",
  "complete",
  "expired",
]);

export function parseEnvelope(raw: unknown): CounterSale {
  const object = requireObject(raw, "counter sale response");
  requireExactKeys(object, ["ok", "counterSale"], "counter sale response");
  if (object.ok !== true) throw new Error("The counter sale is unavailable.");
  return parseSale(object.counterSale);
}

function parseSale(raw: unknown): CounterSale {
  const object = requireObject(raw, "counter sale");
  for (const key of REQUIRED_SALE_KEYS) {
    if (!(key in object)) {
      throw new Error("counter sale fields are invalid.");
    }
  }
  for (const key of Object.keys(object)) {
    if (!ALLOWED_SALE_KEYS.has(key)) {
      throw new Error("counter sale fields are invalid.");
    }
  }
  if (object.schemaVersion !== "satyr.counter-sale.v1") {
    throw new Error(
      "This sale is reported in a version this portal cannot read.",
    );
  }
  const state = object.state;
  if (
    typeof state !== "string" ||
    !SALE_STATES.includes(state as CounterSaleState)
  ) {
    throw new Error("Counter sale state is invalid.");
  }
  if (
    typeof object.checkoutId !== "string" ||
    typeof object.satyrLocationId !== "string" ||
    typeof object.revision !== "number" ||
    typeof object.collectable !== "boolean"
  ) {
    throw new Error("Counter sale is invalid.");
  }
  const optionalFields: {
    pickupCode?: string | null;
    paymentMethod?: CounterRegisterPaymentMethod | null;
    tenderBrand?: string | null;
    providerRefundable?: boolean | null;
    manualTender?: CounterSaleManualTender | null;
  } = {};
  if ("pickupCode" in object) {
    optionalFields.pickupCode = nullableText(object.pickupCode, "pickupCode");
  }
  if ("paymentMethod" in object) {
    if (
      object.paymentMethod !== null &&
      !isCounterRegisterPaymentMethod(object.paymentMethod)
    ) {
      throw new Error("Counter sale payment method is invalid.");
    }
    optionalFields.paymentMethod = object.paymentMethod;
  }
  if ("tenderBrand" in object) {
    optionalFields.tenderBrand = nullableText(
      object.tenderBrand,
      "tenderBrand",
    );
  }
  if ("providerRefundable" in object) {
    if (
      object.providerRefundable !== null &&
      typeof object.providerRefundable !== "boolean"
    ) {
      throw new Error("Counter sale providerRefundable is invalid.");
    }
    optionalFields.providerRefundable = object.providerRefundable;
  }
  if ("manualTender" in object) {
    optionalFields.manualTender =
      object.manualTender === null
        ? null
        : parseManualTender(object.manualTender);
  }
  return {
    checkoutId: object.checkoutId,
    satyrLocationId: object.satyrLocationId,
    revision: object.revision,
    state: state as CounterSaleState,
    collectable: object.collectable,
    recoverable:
      object.recoverable === null ? null : parseRecoverable(object.recoverable),
    quote: object.quote === null ? null : parseQuote(object.quote),
    orderId: nullableText(object.orderId, "orderId"),
    capturedPaymentReference: nullableText(
      object.capturedPaymentReference,
      "capturedPaymentReference",
    ),
    ...optionalFields,
    afterSale: parseAfterSale(object.afterSale),
  };
}

function parseManualTender(raw: unknown): CounterSaleManualTender {
  const object = requireObject(raw, "counter sale manual tender");
  requireExactKeys(
    object,
    ["cashReceivedMinor", "changeDueMinor", "currency"],
    "counter sale manual tender",
  );
  if (
    (object.cashReceivedMinor !== null &&
      !Number.isSafeInteger(object.cashReceivedMinor)) ||
    (object.changeDueMinor !== null &&
      !Number.isSafeInteger(object.changeDueMinor)) ||
    typeof object.currency !== "string"
  ) {
    throw new Error("Counter sale manual tender is invalid.");
  }
  return {
    cashReceivedMinor:
      object.cashReceivedMinor === null
        ? null
        : Number(object.cashReceivedMinor),
    changeDueMinor:
      object.changeDueMinor === null ? null : Number(object.changeDueMinor),
    currency: object.currency,
  };
}

function parseAfterSale(raw: unknown): CounterSale["afterSale"] {
  if (raw === null) return null;
  const object = requireObject(raw, "counter sale after-sale state");
  requireExactKeys(
    object,
    ["order", "payment", "fulfillment", "refundState"],
    "counter sale after-sale state",
  );
  const refundState = parseRefundState(object.refundState);
  return {
    order: parseAfterSaleResource(object.order, "counter sale order"),
    payment: parseAfterSaleResource(object.payment, "counter sale payment"),
    fulfillment: parseAfterSaleResource(
      object.fulfillment,
      "counter sale fulfillment",
    ),
    refundState,
  };
}

function parseRefundState(
  raw: unknown,
): "none" | "pending" | "completed" | "failed" {
  switch (raw) {
    case "none":
    case "pending":
    case "completed":
    case "failed":
      return raw;
    default:
      throw new Error("Counter sale refund state is invalid.");
  }
}

function parseAfterSaleResource(
  raw: unknown,
  label: string,
): Readonly<{ id: string; revision: number; state: string }> {
  const object = requireObject(raw, label);
  requireExactKeys(object, ["id", "revision", "state"], label);
  if (
    typeof object.id !== "string" ||
    !Number.isSafeInteger(object.revision) ||
    Number(object.revision) <= 0 ||
    typeof object.state !== "string"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return {
    id: object.id,
    revision: Number(object.revision),
    state: object.state,
  };
}

function parseRecoverable(
  raw: unknown,
): NonNullable<CounterSale["recoverable"]> {
  const object = requireObject(raw, "counter sale recovery");
  requireExactKeys(
    object,
    ["paymentAttemptId", "reasonCode", "reconcileAfter"],
    "counter sale recovery",
  );
  if (
    typeof object.paymentAttemptId !== "string" ||
    typeof object.reasonCode !== "string" ||
    typeof object.reconcileAfter !== "string"
  ) {
    throw new Error("Counter sale recovery is invalid.");
  }
  return {
    paymentAttemptId: object.paymentAttemptId,
    reasonCode: object.reasonCode,
    reconcileAfter: object.reconcileAfter,
  };
}

function parseQuote(raw: unknown): NonNullable<CounterSale["quote"]> {
  const object = requireObject(raw, "counter sale quote");
  requireExactKeys(
    object,
    ["quoteDigest", "checkoutRevision", "lineCount", "amount"],
    "counter sale quote",
  );
  if (
    typeof object.quoteDigest !== "string" ||
    !/^quote_[a-f0-9]{64}$/u.test(object.quoteDigest)
  ) {
    throw new Error("Counter sale quote digest is invalid.");
  }
  if (
    typeof object.checkoutRevision !== "number" ||
    typeof object.lineCount !== "number"
  ) {
    throw new Error("Counter sale quote is invalid.");
  }
  const amount = requireObject(object.amount, "counter sale amount");
  requireExactKeys(amount, ["amountMinor", "currency"], "counter sale amount");
  if (
    typeof amount.amountMinor !== "number" ||
    typeof amount.currency !== "string"
  ) {
    throw new Error("Counter sale amount is invalid.");
  }
  return {
    quoteDigest: object.quoteDigest,
    checkoutRevision: object.checkoutRevision,
    lineCount: object.lineCount,
    amount: { amountMinor: amount.amountMinor, currency: amount.currency },
  };
}

function nullableText(raw: unknown, field: string): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string")
    throw new Error(`Counter sale ${field} is invalid.`);
  return raw;
}

export function requireObject(
  raw: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${field} must be an object.`);
  }
  return raw as Record<string, unknown>;
}

export function requireExactKeys(
  raw: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  if (!hasExactKeys(raw, keys)) throw new Error(`${field} fields are invalid.`);
}
