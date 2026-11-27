// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, SafeInteger } from "@purin-labs/contract-schema";
import {
  refundDutyAllocationSchema,
  refundLineAllocationSchema,
  refundTaxAllocationSchema,
  resourceIdSchema,
} from "./identifiers.ts";
import { moneySchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

const paymentDisputeLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("action_required"),
    observedAt: commerceTimestampSchema,
    responseDueAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("under_review"),
    observedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("won"),
    resolvedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("lost"),
    resolvedAt: commerceTimestampSchema,
  }),
]);
export type PaymentDisputeLifecycle = Static<
  typeof paymentDisputeLifecycleSchema
>;

const paymentDisputeSchema = OpenObject({
  disputeId: resourceIdSchema,
  orderId: resourceIdSchema,
  paymentId: resourceIdSchema,
  revision: SafeInteger,
  providerDisputeReference: Type.String(),
  amount: moneySchema,
  reason: Type.String(),
  evidenceReferences: Type.Array(Type.String()),
  lifecycle: paymentDisputeLifecycleSchema,
});
export type PaymentDispute = Static<typeof paymentDisputeSchema>;

const refundAllocationSchema = OpenObject({
  lineAllocations: Type.Array(refundLineAllocationSchema),
  taxAllocations: Type.Array(refundTaxAllocationSchema),
  dutyAllocations: Type.Array(refundDutyAllocationSchema),
  shippingAllocation: moneySchema,
});
export type RefundAllocation = Static<typeof refundAllocationSchema>;

const refundReasonSchema = Type.Union([
  OpenObject({ kind: Type.Literal("cancellation"), reason: Type.String() }),
  OpenObject({
    kind: Type.Literal("order_refund"),
    policyId: resourceIdSchema,
    reason: Type.String(),
  }),
]);
export type RefundReason = Static<typeof refundReasonSchema>;

const refundAttemptLifecycleSchema = Type.Union([
  OpenObject({
    state: Type.Literal("requested"),
    requestedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("processing"),
    reconciliationIdentity: Type.String(),
    reconcileAfter: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("succeeded"),
    providerRefundReference: Type.String(),
    refundedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("failed"),
    reason: Type.String(),
    failedAt: commerceTimestampSchema,
  }),
  OpenObject({
    state: Type.Literal("indeterminate"),
    reconciliationIdentity: Type.String(),
    reconcileAfter: commerceTimestampSchema,
  }),
]);
export type RefundAttemptLifecycle = Static<
  typeof refundAttemptLifecycleSchema
>;

const refundAttemptSchema = OpenObject({
  refundAttemptId: resourceIdSchema,
  orderId: resourceIdSchema,
  paymentId: resourceIdSchema,
  revision: SafeInteger,
  reason: refundReasonSchema,
  allocation: refundAllocationSchema,
  idempotencyIdentity: Type.String(),
  lifecycle: refundAttemptLifecycleSchema,
});
export type RefundAttempt = Static<typeof refundAttemptSchema>;
