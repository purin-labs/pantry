// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
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
const supplierPayableAllocationSchema = OpenObject({
  inFlight: moneySchema,
  settled: moneySchema,
});

/**
 * Where a payable stands. `partially_paid` and `paid` are settlement facts,
 * not approval facts: money that is returned moves a payable back.
 */
const supplierPayableLifecycleSchema = Type.Union([
  Type.Literal("draft"),
  Type.Literal("approved"),
  Type.Literal("partially_paid"),
  Type.Literal("paid"),
  Type.Literal("void"),
]);

/**
 * One approved amount owed to one supplier for one Plan 31-B purchase request.
 */
const supplierPayableSchema = OpenObject({
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
