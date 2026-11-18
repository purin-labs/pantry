// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger, recordParser } from "../schema.ts";
import {
  commerceMerchantIdSchema,
  organisationIdSchema,
  resourceIdSchema,
} from "./identifiers.ts";
import { moneySchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

/**
 * How much of a payable money has moved for.
 *
 * `in_flight` is approved-or-submitted but unsettled; `settled` is
 * provider-confirmed. Remaining is what is left to allocate. In-flight money
 * is held, not spent: it is released only by provider evidence proving the
 * payout can never settle.
 */
export const supplierPayableAllocationSchema = OpenObject({
  inFlight: moneySchema,
  settled: moneySchema,
});
export type SupplierPayableAllocation = Static<
  typeof supplierPayableAllocationSchema
>;

/**
 * Where a payable stands. `partially_paid` and `paid` are settlement facts,
 * not approval facts: money that is returned moves a payable back.
 */
export const supplierPayableLifecycleSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("approved"),
  Type.Literal("partially_paid"),
  Type.Literal("paid"),
  Type.Literal("void"),
]);
export type SupplierPayableLifecycle = Static<
  typeof supplierPayableLifecycleSchema
>;

/**
 * One approved amount owed to one supplier for one Plan 31-B purchase request.
 */
export const supplierPayableSchema = OpenObject({
  payableId: resourceIdSchema,
  organisationId: organisationIdSchema,
  merchantId: commerceMerchantIdSchema,
  supplierId: resourceIdSchema,
  purchaseRequestId: resourceIdSchema,
  paymentReference: Type.String(),
  evidenceReference: Type.String(),
  grossAmount: moneySchema,
  dueDate: commerceTimestampSchema,
  revision: SafeInteger,
  allocation: supplierPayableAllocationSchema,
  lifecycle: supplierPayableLifecycleSchema,
});
export type SupplierPayable = Static<typeof supplierPayableSchema>;

// Parsers of the records above (Plan 78 step 2).
export const parseSupplierPayableAllocation = recordParser(
  supplierPayableAllocationSchema,
);
export const parseSupplierPayableLifecycle = recordParser(
  supplierPayableLifecycleSchema,
);
export const parseSupplierPayable = recordParser(supplierPayableSchema);
