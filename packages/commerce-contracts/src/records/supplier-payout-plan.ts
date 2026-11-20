// Plan 78: generated once from the ts-rs bindings of the Rust contracts.
// TypeScript is now the source; edit these schemas by hand.
import { Type, type Static } from "typebox";
import { OpenObject, recordParser } from "@purin-labs/contract-schema";
import {
  commerceMerchantIdSchema,
  integrationAccountIdSchema,
  organisationIdSchema,
  resourceIdSchema,
} from "./identifiers.ts";
import { moneySchema } from "./money.ts";
import { commerceTimestampSchema } from "./provenance.ts";
import {
  supplierPayoutAmountBasisSchema,
  wiseFundingModeSchema,
} from "./supplier-payout.ts";

/**
 * An exact decimal FX rate. Rates are compared and re-checked against
 * provider responses, so they are never floating point.
 */
export const decimalRateSchema = Type.String();
export type DecimalRate = Static<typeof decimalRateSchema>;

/**
 * Who the payout is for, shared by both rails. These identities are the same
 * question on every provider, so they are not duplicated per branch.
 */
export const supplierPayoutSubjectSchema = OpenObject({
  payoutId: resourceIdSchema,
  organisationId: organisationIdSchema,
  merchantId: commerceMerchantIdSchema,
  supplierId: resourceIdSchema,
  payableId: resourceIdSchema,
  purchaseRequestId: resourceIdSchema,
});
export type SupplierPayoutSubject = Static<typeof supplierPayoutSubjectSchema>;

/**
 * A fee the provider quoted, and when it was seen. A GMO fee is observed
 * before approval rather than locked by the provider, so the observation time
 * is part of the evidence.
 */
export const observedProviderFeeSchema = OpenObject({
  amount: moneySchema,
  observedAt: commerceTimestampSchema,
});
export type ObservedProviderFee = Static<typeof observedProviderFeeSchema>;

/**
 * What the approval authorized, and until when. A plan whose deadline has
 * passed is not executable and returns to proposal preparation.
 */
export const supplierPayoutApprovalSealSchema = OpenObject({
  approvalDigest: Type.String(),
  executionDeadline: commerceTimestampSchema,
  idempotencyKey: Type.String(),
});
export type SupplierPayoutApprovalSeal = Static<
  typeof supplierPayoutApprovalSealSchema
>;

/**
 * A domestic JPY transfer from the merchant's own GMO Aozora account.
 */
export const gmoAozoraPayoutPlanSchema = OpenObject({
  subject: supplierPayoutSubjectSchema,
  integrationAccountId: integrationAccountIdSchema,
  sourceAccountId: resourceIdSchema,
  destinationRevisionId: resourceIdSchema,
  maskedDestinationSummary: Type.String(),
  amountBasis: supplierPayoutAmountBasisSchema,
  recipientAmount: moneySchema,
  observedFee: observedProviderFeeSchema,
  feeCeiling: moneySchema,
  requestedTransferDate: commerceTimestampSchema,
  supplierReference: Type.String(),
  seal: supplierPayoutApprovalSealSchema,
});
export type GmoAozoraPayoutPlan = Static<typeof gmoAozoraPayoutPlanSchema>;

/**
 * A cross-border transfer through the merchant's Wise enterprise profile.
 */
export const wiseBusinessPayoutPlanSchema = OpenObject({
  subject: supplierPayoutSubjectSchema,
  integrationAccountId: integrationAccountIdSchema,
  profileId: resourceIdSchema,
  funding: wiseFundingModeSchema,
  destinationRevisionId: resourceIdSchema,
  providerRecipientId: resourceIdSchema,
  quoteId: resourceIdSchema,
  paymentOptionId: resourceIdSchema,
  payInMethod: Type.String(),
  payOutMethod: Type.String(),
  amountBasis: supplierPayoutAmountBasisSchema,
  sourceTotal: moneySchema,
  targetAmount: moneySchema,
  feeTotal: moneySchema,
  taxTotal: moneySchema,
  feeCeiling: moneySchema,
  rate: decimalRateSchema,
  rateExpiresAt: commerceTimestampSchema,
  transferRequirementsDigest: Type.String(),
  customerTransactionId: Type.String(),
  supplierReference: Type.String(),
  seal: supplierPayoutApprovalSealSchema,
});
export type WiseBusinessPayoutPlan = Static<
  typeof wiseBusinessPayoutPlanSchema
>;

/**
 * The exact instruction handed to the executor. Adding a rail means adding a
 * branch here, which forces every consumer to handle it.
 */
export const supplierPayoutExecutionPlanSchema = Type.Union([
  Type.Intersect([
    OpenObject({ kind: Type.Literal("gmo_aozora") }),
    gmoAozoraPayoutPlanSchema,
  ]),
  Type.Intersect([
    OpenObject({ kind: Type.Literal("wise") }),
    wiseBusinessPayoutPlanSchema,
  ]),
]);
export type SupplierPayoutExecutionPlan = Static<
  typeof supplierPayoutExecutionPlanSchema
>;

// Parsers of the records above (Plan 78 step 2).
export const parseSupplierPayoutSubject = recordParser(
  supplierPayoutSubjectSchema,
);
export const parseObservedProviderFee = recordParser(observedProviderFeeSchema);
export const parseSupplierPayoutApprovalSeal = recordParser(
  supplierPayoutApprovalSealSchema,
);
export const parseGmoAozoraPayoutPlan = recordParser(gmoAozoraPayoutPlanSchema);
export const parseWiseBusinessPayoutPlan = recordParser(
  wiseBusinessPayoutPlanSchema,
);
export const parseSupplierPayoutExecutionPlan = recordParser(
  supplierPayoutExecutionPlanSchema,
);
