import type { Quantity, QuantityUnit } from "@purin-labs/commerce-contracts";
import { assertNever } from "@purin-labs/std";
import { err, ok, type Result } from "./result.ts";

declare const quantityBrand: unique symbol;

/** The one unit each dimension is accounted in after admission. */
export type MaterialUnit = "each" | "milligram" | "microliter";

/** A non-negative integer amount in its dimension's accounting unit. */
export type MaterialQuantity = Readonly<{
  amount: number;
  unit: MaterialUnit;
}> & { readonly [quantityBrand]: "MaterialQuantity" };

export type QuantityError =
  | Readonly<{ code: "invalid_quantity"; quantity: Quantity }>
  | Readonly<{ code: "unrepresentable"; quantity: Quantity }>
  | Readonly<{
      code: "unit_mismatch";
      expected: MaterialUnit;
      actual: MaterialUnit;
    }>
  | Readonly<{
      code: "insufficient";
      available: MaterialQuantity;
      requested: MaterialQuantity;
    }>
  | Readonly<{ code: "overflow"; unit: MaterialUnit }>;

const MAX_SCALE = 9;

function accountingUnit(unit: QuantityUnit): [MaterialUnit, number] {
  switch (unit) {
    case "each":
      return ["each", 1];
    case "gram":
      return ["milligram", 1_000];
    case "kilogram":
      return ["milligram", 1_000_000];
    case "milliliter":
      return ["microliter", 1_000];
    case "liter":
      return ["microliter", 1_000_000];
    default:
      return assertNever(unit, "Unsupported quantity unit");
  }
}

function build(amount: number, unit: MaterialUnit): MaterialQuantity {
  return Object.freeze({ amount, unit }) as MaterialQuantity;
}

/**
 * Normalizes a contract quantity once, at admission. Mass, volume and count
 * never convert into one another; an amount finer than the accounting unit is
 * rejected instead of rounded.
 */
export function normalizeQuantity(
  quantity: Quantity,
): Result<MaterialQuantity, QuantityError> {
  if (
    !Number.isSafeInteger(quantity.amount) ||
    quantity.amount < 0 ||
    !Number.isInteger(quantity.scale) ||
    quantity.scale < 0 ||
    quantity.scale > MAX_SCALE
  )
    return err({ code: "invalid_quantity", quantity });
  const [unit, factor] = accountingUnit(quantity.unit);
  const numerator = BigInt(quantity.amount) * BigInt(factor);
  const divisor = 10n ** BigInt(quantity.scale);
  if (
    numerator % divisor !== 0n ||
    numerator / divisor > Number.MAX_SAFE_INTEGER
  )
    return err({ code: "unrepresentable", quantity });
  return ok(build(Number(numerator / divisor), unit));
}

export function zeroQuantity(unit: MaterialUnit): MaterialQuantity {
  return build(0, unit);
}

export function addQuantity(
  left: MaterialQuantity,
  right: MaterialQuantity,
): Result<MaterialQuantity, QuantityError> {
  if (left.unit !== right.unit)
    return err({
      code: "unit_mismatch",
      expected: left.unit,
      actual: right.unit,
    });
  const amount = left.amount + right.amount;
  return Number.isSafeInteger(amount)
    ? ok(build(amount, left.unit))
    : err({ code: "overflow", unit: left.unit });
}

/** Balances never go negative: an overdraw is a failure, not a clamp. */
export function subtractQuantity(
  available: MaterialQuantity,
  requested: MaterialQuantity,
): Result<MaterialQuantity, QuantityError> {
  if (available.unit !== requested.unit)
    return err({
      code: "unit_mismatch",
      expected: available.unit,
      actual: requested.unit,
    });
  if (requested.amount > available.amount)
    return err({ code: "insufficient", available, requested });
  return ok(build(available.amount - requested.amount, available.unit));
}
