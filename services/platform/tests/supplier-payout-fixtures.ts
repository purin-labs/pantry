import type { SupplierPayoutExecutionPlan } from "@purin-labs/contracts";
import {
  assertSupplierPayoutPlanWithLexicon,
  validateSupplierPayoutPlanWithLexicon,
} from "../src/commerce/commerce-wasm";

export function payoutPlan(
  organisationId: string,
): SupplierPayoutExecutionPlan {
  const plan: unknown = {
    kind: "gmo_aozora",
    subject: {
      payoutId: "supplier_payout_1",
      organisationId,
      merchantId: "merchant_1",
      supplierId: "supplier_1",
      payableId: "supplier_payable_1",
      purchaseRequestId: "purchase_request_1",
    },
    integrationAccountId: "integration_gmo",
    sourceAccountId: "source_account_1",
    destinationRevisionId: "destination_revision_1",
    maskedDestinationSummary: "Bank ****1234",
    amountBasis: "recipient_receives",
    recipientAmount: { amountMinor: 10000, currency: "JPY" },
    observedFee: {
      amount: { amountMinor: 330, currency: "JPY" },
      observedAt: "2026-09-06T00:00:00Z",
    },
    feeCeiling: { amountMinor: 500, currency: "JPY" },
    requestedTransferDate: "2026-09-06T00:00:00Z",
    supplierReference: "INV-1",
    seal: {
      approvalDigest: "ab".repeat(32),
      executionDeadline: "2026-09-07T00:00:00Z",
      idempotencyKey: "payout-request-1",
    },
  };
  assertSupplierPayoutPlanWithLexicon(plan);
  const proof = validateSupplierPayoutPlanWithLexicon(plan);
  if (!proof.ok) throw new Error(JSON.stringify(proof.error));
  plan.seal.approvalDigest = proof.value.economicsDigest;
  return plan;
}

export function wisePayoutPlan(
  organisationId: string,
): SupplierPayoutExecutionPlan {
  const gmo = payoutPlan(organisationId);
  const plan: SupplierPayoutExecutionPlan = {
    kind: "wise",
    subject: gmo.subject,
    integrationAccountId: "integration_wise",
    profileId: "profile_1",
    funding: "balance",
    destinationRevisionId: "destination_revision_1",
    providerRecipientId: "recipient_1",
    quoteId: "quote_1",
    paymentOptionId: "option_1",
    payInMethod: "BALANCE",
    payOutMethod: "BANK_TRANSFER",
    amountBasis: "recipient_receives",
    sourceTotal: { amountMinor: 10100, currency: "JPY" },
    targetAmount: { amountMinor: 10000, currency: "JPY" },
    feeTotal: { amountMinor: 100, currency: "JPY" },
    taxTotal: { amountMinor: 0, currency: "JPY" },
    feeCeiling: { amountMinor: 500, currency: "JPY" },
    rate: "1",
    rateExpiresAt: "2026-09-07T00:00:00Z",
    transferRequirementsDigest: "cd".repeat(32),
    customerTransactionId: "payout-request-1",
    supplierReference: "INV-1",
    seal: gmo.seal,
  };
  const proof = validateSupplierPayoutPlanWithLexicon(plan);
  if (!proof.ok) throw new Error(JSON.stringify(proof.error));
  plan.seal.approvalDigest = proof.value.economicsDigest;
  return plan;
}
