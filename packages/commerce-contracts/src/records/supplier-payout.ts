// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, recordParser } from "../schema.ts";
import { integrationAccountIdSchema, resourceIdSchema } from "./identifiers.ts";
import { moneySchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";

/**
 * Where one payout stands.
 *
 * `settled` is not terminal: returns and reversals are observed after the
 * fact. `failed` and `cancelled` are the only states that release the
 * payable's held money, and only on provider evidence that the payout can
 * never settle.
 * Which provider call went dark, and the identity recovery must inquire by.
 *
 * A payout reaches the provider in two separate operations, and they fail
 * differently. If creation is unknown no transfer id exists yet, so recovery
 * asks the provider whether the stable request identity produced one. If
 * funding is unknown the transfer certainly exists, so recovery asks about
 * *that transfer's funding* — creating another would pay the supplier twice
 * for one payable.
 */
export const payoutIndeterminateOperationSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("transfer_creation"),
    requestIdentity: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("funding"),
    providerTransferId: resourceIdSchema,
    fundingOperationId: resourceIdSchema,
  }),
]);
export type PayoutIndeterminateOperation = Static<
  typeof payoutIndeterminateOperationSchema
>;

/**
 * The only action that is safe to take on an unresolved payout.
 */
export const payoutRecoveryActionSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("inquire_transfer_by_request_identity"),
    requestIdentity: Type.String(),
  }),
  OpenObject({
    kind: Type.Literal("inquire_funding"),
    providerTransferId: resourceIdSchema,
    fundingOperationId: resourceIdSchema,
  }),
]);
export type PayoutRecoveryAction = Static<typeof payoutRecoveryActionSchema>;

/**
 * Funding modes that have passed provider certification. Wise personal-token
 * funding is excluded because it cannot fund a payout through the API.
 */
export const wiseFundingModeSchema = Type.Literal("balance");
export type WiseFundingMode = Static<typeof wiseFundingModeSchema>;

/**
 * Which rail moves the money. A failed rail never triggers another: a new
 * provider requires a new proposal and approval.
 */
export const supplierPayoutProviderBindingSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("gmo_aozora_private"),
    integrationAccountId: integrationAccountIdSchema,
    sourceAccountId: resourceIdSchema,
    destinationRevisionId: resourceIdSchema,
  }),
  OpenObject({
    kind: Type.Literal("wise_enterprise_payouts"),
    integrationAccountId: integrationAccountIdSchema,
    profileId: resourceIdSchema,
    funding: wiseFundingModeSchema,
    destinationRevisionId: resourceIdSchema,
  }),
]);
export type SupplierPayoutProviderBinding = Static<
  typeof supplierPayoutProviderBindingSchema
>;

/**
 * What the approved amount means. Supplier invoices fix what the supplier
 * receives, so the merchant bears the fee.
 */
export const supplierPayoutAmountBasisSchema =
  Type.Literal("recipient_receives");
export type SupplierPayoutAmountBasis = Static<
  typeof supplierPayoutAmountBasisSchema
>;

/**
 * A normalized terminal failure. Provider-specific status text is parsed once
 * at the provider boundary and never controls the lifecycle.
 */
export const supplierPayoutFailureSchema = Type.Union([
  Type.Literal("insufficient_funds"),
  Type.Literal("destination_rejected"),
  Type.Literal("provider_rejected"),
  Type.Literal("approval_expired"),
]);
export type SupplierPayoutFailure = Static<typeof supplierPayoutFailureSchema>;

export const supplierPayoutStateSchema = Type.Union([
  OpenObject({
    kind: Type.Literal("approval_pending"),
    proposalId: resourceIdSchema,
    expiresAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("approved"),
    approvalReceiptId: resourceIdSchema,
    approvalDigest: Type.String(),
    executionDeadline: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("submitting"),
    attemptId: resourceIdSchema,
    submittedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("provider_action_required"),
    attemptId: resourceIdSchema,
    providerTransferId: resourceIdSchema,
    actionCode: Type.String(),
    observedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("provider_pending"),
    providerTransferId: resourceIdSchema,
    providerState: Type.String(),
    observedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("settled"),
    providerTransferId: resourceIdSchema,
    receiptReference: Type.String(),
    settledAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("return_pending"),
    providerTransferId: resourceIdSchema,
    observedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("returned"),
    providerTransferId: resourceIdSchema,
    payableRestorationReceiptId: resourceIdSchema,
    returnedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("reversal_pending"),
    providerTransferId: resourceIdSchema,
    observedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("reversed"),
    providerTransferId: resourceIdSchema,
    payableRestorationReceiptId: resourceIdSchema,
    reversedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("failed"),
    failure: supplierPayoutFailureSchema,
    providerEvidenceId: resourceIdSchema,
    failedAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("indeterminate"),
    attemptId: resourceIdSchema /**
     * Which provider operation's outcome is unknown. Recovery is only
     * safe if it knows this: re-running creation when it was *funding*
     * that went dark would send the supplier a second transfer.
     */,
    operation: payoutIndeterminateOperationSchema,
    nextInquiryAt: commerceTimestampSchema,
  }),
  OpenObject({
    kind: Type.Literal("cancelled"),
    cancelledAt: commerceTimestampSchema,
  }),
]);
export type SupplierPayoutState = Static<typeof supplierPayoutStateSchema>;

/**
 * One payout: an allocation against a payable, bound to one rail.
 */
export const supplierPayoutSchema = OpenObject({
  payoutId: resourceIdSchema,
  payableId: resourceIdSchema,
  supplierId: resourceIdSchema,
  purchaseRequestId: resourceIdSchema,
  binding: supplierPayoutProviderBindingSchema,
  amountBasis: supplierPayoutAmountBasisSchema,
  recipientAmount: moneySchema,
  feeCeiling: moneySchema,
  idempotencyKey: Type.String(),
  state: supplierPayoutStateSchema,
});
export type SupplierPayout = Static<typeof supplierPayoutSchema>;

// Parsers of the records above (Plan 78 step 2).
export const parsePayoutIndeterminateOperation = recordParser(
  payoutIndeterminateOperationSchema,
);
export const parsePayoutRecoveryAction = recordParser(
  payoutRecoveryActionSchema,
);
export const parseSupplierPayoutProviderBinding = recordParser(
  supplierPayoutProviderBindingSchema,
);
export const parseSupplierPayoutFailure = recordParser(
  supplierPayoutFailureSchema,
);
export const parseSupplierPayoutState = recordParser(supplierPayoutStateSchema);
export const parseSupplierPayout = recordParser(supplierPayoutSchema);
