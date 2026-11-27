// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject } from "@purin-labs/contract-schema";
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
const payoutIndeterminateOperationSchema = Type.Union([
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
 * Funding modes that have passed provider certification. Wise personal-token
 * funding is excluded because it cannot fund a payout through the API.
 */
export const wiseFundingModeSchema = Type.Literal("balance");

/**
 * Which rail moves the money. A failed rail never triggers another: a new
 * provider requires a new proposal and approval.
 */
const supplierPayoutProviderBindingSchema = Type.Union([
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

/**
 * A normalized terminal failure. Provider-specific status text is parsed once
 * at the provider boundary and never controls the lifecycle.
 */
const supplierPayoutFailureSchema = Type.Union([
  Type.Literal("insufficient_funds"),
  Type.Literal("destination_rejected"),
  Type.Literal("provider_rejected"),
  Type.Literal("approval_expired"),
]);

const supplierPayoutStateSchema = Type.Union([
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
const supplierPayoutSchema = OpenObject({
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
