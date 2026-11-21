// Discounts (Plan 76A step 7). A discount takes an amount or a percentage
// off chosen products or off the order, by code or automatically. Checkout
// spreads each discount over the lines in whole minor units and computes tax
// on the discounted amounts. A code use is held by the checkout and counted
// when the order is placed.
import type { CommerceEngineTimestamp } from "./commerce-resources.ts";
import {
  requireString,
} from "./wire-readers.ts";
import { parseCreateCommerceDiscountV1 as parseCreateCommerceDiscountV1Record, parseDeactivateCommerceDiscountV1 as parseDeactivateCommerceDiscountV1Record, parseCommerceDiscountV1 as parseCommerceDiscountV1Record, parseCommerceDiscountsV1 as parseCommerceDiscountsV1Record } from "@purin-labs/commerce-contracts/records/api-discounts";
import { decodeRecord } from "./entity-plane/record-decoding.ts";

type Money = Readonly<{ amountMinor: number; currency: string }>;

export type CommerceDiscountValueV1 =
  | Readonly<{ kind: "percentage"; basisPoints: number }>
  | Readonly<{ kind: "fixed_amount"; amount: Money }>;

export type CommerceDiscountRuleV1 =
  | Readonly<{ kind: "amount_off_order"; value: CommerceDiscountValueV1 }>
  | Readonly<{
      kind: "amount_off_products";
      value: CommerceDiscountValueV1;
      productIds: readonly string[];
    }>;

export type CommerceDiscountMethodV1 =
  | Readonly<{ kind: "code"; codes: readonly string[] }>
  | Readonly<{ kind: "automatic" }>;

export type CommerceDiscountConditionsV1 = Readonly<{
  /** The subtotal before any discount must reach this amount. */
  minimumSubtotal: Money | null;
  startsAt: CommerceEngineTimestamp;
  endsAt: CommerceEngineTimestamp | null;
  /** Uses across every buyer, counting checkouts that hold one. */
  usageLimit: number | null;
  oncePerCustomer: boolean;
}>;

export type CommerceDiscountV1 = Readonly<{
  id: string;
  revision: number;
  title: string;
  method: CommerceDiscountMethodV1;
  rule: CommerceDiscountRuleV1;
  conditions: CommerceDiscountConditionsV1;
  status: "active" | "inactive";
  /** Placed orders that used the discount. */
  redeemed: number;
  occurredAt: CommerceEngineTimestamp;
}>;

type DiscountCommandBase = Readonly<{
  merchantId: string;
  idempotencyKey: string;
  requestedAt: CommerceEngineTimestamp;
  discountId: string;
}>;

/** A discount is published as created; a published discount cannot change. */
export type CreateCommerceDiscountV1 = DiscountCommandBase &
  Readonly<{
    schemaVersion: "commerce.create-discount.v1";
    title: string;
    method: CommerceDiscountMethodV1;
    rule: CommerceDiscountRuleV1;
    conditions: CommerceDiscountConditionsV1;
  }>;

export type DeactivateCommerceDiscountV1 = DiscountCommandBase &
  Readonly<{
    schemaVersion: "commerce.deactivate-discount.v1";
    expectedRevision: number;
  }>;

export type CommerceDiscountCommandV1 =
  | CreateCommerceDiscountV1
  | DeactivateCommerceDiscountV1;

/** Codes match without regard to case or surrounding space. */
export function normalizeDiscountCode(value: unknown, field: string): string {
  const code = requireString(value, field).trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,40}$/.test(code))
    throw new Error(`${field} must be 3 to 40 letters, digits, - or _`);
  return code;
}

export function parseCreateDiscountCommand(value: unknown): CreateCommerceDiscountV1 {
  return decodeRecord(parseCreateCommerceDiscountV1Record, value);
}

export function parseDeactivateDiscountCommand(value: unknown): DeactivateCommerceDiscountV1 {
  return decodeRecord(parseDeactivateCommerceDiscountV1Record, value);
}

export function parseDiscount(value: unknown): CommerceDiscountV1 {
  return decodeRecord(parseCommerceDiscountV1Record, value);
}

export function parseDiscounts(value: unknown): readonly CommerceDiscountV1[] {
  return decodeRecord(parseCommerceDiscountsV1Record, value);
}
