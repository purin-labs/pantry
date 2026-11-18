import type {
  SupplierDestinationRail,
  SupplierDestinationRevision,
  SupplierDestinationState,
  SupplierPayable,
  SupplierPayout,
  SupplierPayoutApprovalSeal,
  SupplierPayoutExecutionPlan,
  SupplierPayoutProviderBinding,
  SupplierPayoutState,
} from "@seams/contracts";
import type { VariantBy } from "@seams/type-utils";

const money = { amountMinor: 10_000, currency: "JPY" };

type PayoutCase = VariantBy<
  import("../src/actors/case/types").CommerceCaseProposal,
  "provenance",
  null
>;
declare const payoutCase: PayoutCase;
// @ts-expect-error Payout proposals cannot borrow commerce-system authority through a spread.
const payoutWithCommerceAuthority: import("../src/actors/case/types").CommerceCaseProposal =
  { ...payoutCase, authority: { kind: "lab" } };
void payoutWithCommerceAuthority;

const approvalPendingWithTransfer: SupplierPayoutState = {
  kind: "approval_pending",
  proposalId: "proposal_fixture",
  expiresAt: "2026-09-05T00:00:00Z",
  // @ts-expect-error A state before provider acceptance owns no transfer identity.
  providerTransferId: "transfer_fixture",
};

// @ts-expect-error A settled payout records the receipt its money produced.
const settledWithoutReceipt: SupplierPayoutState = {
  kind: "settled",
  providerTransferId: "transfer_fixture",
  settledAt: "2026-09-05T00:00:00Z",
};

// @ts-expect-error Returned money must name the receipt that restored the payable.
const returnedWithoutRestoration: SupplierPayoutState = {
  kind: "returned",
  providerTransferId: "transfer_fixture",
  returnedAt: "2026-09-05T00:00:00Z",
};

const failedWithProviderText: SupplierPayoutState = {
  kind: "failed",
  // @ts-expect-error A failure is normalized once; raw provider text cannot stand in.
  failure: "BANK_SAID_NO",
  providerEvidenceId: "evidence_fixture",
  failedAt: "2026-09-05T00:00:00Z",
};

const gmoWithWiseFields: SupplierPayoutProviderBinding = {
  kind: "gmo_aozora_private",
  integrationAccountId: "integration_gmo_fixture",
  sourceAccountId: "source_account_fixture",
  destinationRevisionId: "destination_revision_fixture",
  // @ts-expect-error A Wise profile cannot appear on a GMO Aozora binding.
  profileId: "profile_fixture",
};

const wiseWithoutFunding: SupplierPayoutProviderBinding = {
  kind: "wise_enterprise_payouts",
  integrationAccountId: "integration_wise_fixture",
  profileId: "profile_fixture",
  destinationRevisionId: "destination_revision_fixture",
  // @ts-expect-error Only a certified funding mode can move money.
  funding: "personal_token",
};

const payoutWithBankDetails: SupplierPayout = {
  payoutId: "supplier_payout_fixture",
  payableId: "supplier_payable_fixture",
  supplierId: "supplier_fixture",
  purchaseRequestId: "purchase_request_fixture",
  binding: {
    kind: "gmo_aozora_private",
    integrationAccountId: "integration_gmo_fixture",
    sourceAccountId: "source_account_fixture",
    destinationRevisionId: "destination_revision_fixture",
  },
  amountBasis: "recipient_receives",
  recipientAmount: money,
  feeCeiling: { amountMinor: 500, currency: "JPY" },
  idempotencyKey: "payout-fixture",
  state: { kind: "cancelled", cancelledAt: "2026-09-05T00:00:00Z" },
  // @ts-expect-error A payout is an allocation against a payable, never raw bank details.
  destinationAccountNumber: "1234567",
};

// @ts-expect-error A payout always pays what the supplier receives.
const senderPaysBasis: SupplierPayout["amountBasis"] = "sender_pays";

// @ts-expect-error A payable is anchored to a Plan 31-B purchase request.
const payableWithoutPurchaseRequest: SupplierPayable = {
  payableId: "supplier_payable_fixture",
  organisationId: "organisation_fixture",
  merchantId: "merchant_fixture" as SupplierPayable["merchantId"],
  supplierId: "supplier_fixture",
  paymentReference: "INV-1",
  evidenceReference: "drive:invoice-1",
  grossAmount: money,
  dueDate: "2026-10-01T00:00:00Z",
  revision: 1,
  allocation: {
    inFlight: { amountMinor: 0, currency: "JPY" },
    settled: { amountMinor: 0, currency: "JPY" },
  },
  lifecycle: "approved",
};

void approvalPendingWithTransfer;
void settledWithoutReceipt;
void returnedWithoutRestoration;
void failedWithProviderText;
void gmoWithWiseFields;
void wiseWithoutFunding;
void payoutWithBankDetails;
void senderPaysBasis;
void payableWithoutPurchaseRequest;

const draftWithApprover: SupplierDestinationState = {
  kind: "draft",
  proposedBy: "operator_maker_fixture",
  // @ts-expect-error A draft destination has not been approved by anyone.
  activatedBy: "operator_checker_fixture",
};

// @ts-expect-error An active destination records both principals: maker and checker.
const activeWithoutChecker: SupplierDestinationState = {
  kind: "active",
  proposedBy: "operator_maker_fixture",
  activatedAt: "2026-09-05T00:00:00Z",
};

const gmoWithRecipientFingerprint: SupplierDestinationRail = {
  kind: "gmo_aozora_domestic",
  // @ts-expect-error A domestic bank transfer has no Wise recipient.
  providerRecipientId: "recipient_fixture",
};

const destinationWithBankDetails: SupplierDestinationRevision = {
  revisionId: "destination_revision_fixture",
  destinationId: "destination_fixture",
  supplierId: "supplier_fixture",
  rail: { kind: "gmo_aozora_domestic" },
  maskedSummary: "Sumitomo ****1234",
  configurationRef: "vault:destination_fixture",
  revision: 1,
  state: { kind: "draft", proposedBy: "operator_maker_fixture" },
  // @ts-expect-error Raw bank details live in encrypted provider configuration, never here.
  accountNumber: "1234567",
};

void draftWithApprover;
void activeWithoutChecker;
void gmoWithRecipientFingerprint;
void destinationWithBankDetails;

const subject = {
  payoutId: "supplier_payout_fixture",
  organisationId: "organisation_fixture",
  merchantId: "merchant_fixture" as SupplierPayable["merchantId"],
  supplierId: "supplier_fixture",
  payableId: "supplier_payable_fixture",
  purchaseRequestId: "purchase_request_fixture",
};

const seal = {
  approvalDigest: "ab".repeat(32),
  executionDeadline: "2026-09-06T00:00:00Z",
  idempotencyKey: "payout-fixture",
};

const gmoPlanWithQuote: SupplierPayoutExecutionPlan = {
  kind: "gmo_aozora",
  subject,
  integrationAccountId: "integration_gmo_fixture",
  sourceAccountId: "source_account_fixture",
  destinationRevisionId: "destination_revision_fixture",
  maskedDestinationSummary: "Sumitomo ****1234",
  amountBasis: "recipient_receives",
  recipientAmount: { amountMinor: 10_000, currency: "JPY" },
  observedFee: {
    amount: { amountMinor: 330, currency: "JPY" },
    observedAt: "2026-09-05T00:00:00Z",
  },
  feeCeiling: { amountMinor: 500, currency: "JPY" },
  requestedTransferDate: "2026-09-05T00:00:00Z",
  supplierReference: "INV-1",
  seal,
  // @ts-expect-error A Wise quote cannot appear on a GMO Aozora plan.
  quoteId: "quote_fixture",
};

// @ts-expect-error A Wise plan binds the payment option its price came from.
const wisePlanWithoutPaymentOption: SupplierPayoutExecutionPlan = {
  kind: "wise",
  subject,
  integrationAccountId: "integration_wise_fixture",
  profileId: "profile_fixture",
  funding: "balance",
  destinationRevisionId: "destination_revision_fixture",
  providerRecipientId: "recipient_fixture",
  quoteId: "quote_fixture",
  payInMethod: "BALANCE",
  payOutMethod: "BANK_TRANSFER",
  amountBasis: "recipient_receives",
  sourceTotal: { amountMinor: 1_100_000, currency: "JPY" },
  targetAmount: { amountMinor: 6_500, currency: "EUR" },
  feeTotal: { amountMinor: 1_200, currency: "JPY" },
  taxTotal: { amountMinor: 120, currency: "JPY" },
  feeCeiling: { amountMinor: 2_000, currency: "JPY" },
  rate: "0.00612",
  rateExpiresAt: "2026-09-05T00:30:00Z",
  transferRequirementsDigest: "cd".repeat(32),
  customerTransactionId: "4f2a1b6c-0000-4000-8000-000000000001",
  supplierReference: "INV-2",
  seal,
};

// @ts-expect-error An approval is time-boxed: it must carry its deadline.
const sealWithoutDeadline: SupplierPayoutApprovalSeal = {
  approvalDigest: "ab".repeat(32),
  idempotencyKey: "payout-fixture",
};

void gmoPlanWithQuote;
void wisePlanWithoutPaymentOption;
void sealWithoutDeadline;

const fundingAsSettlement: import("../src/payouts/executor").PayoutExecutionResult =
  {
    // @ts-expect-error Funding acknowledgement cannot produce a settled execution result.
    kind: "settled",
    providerTransferId: "transfer_1",
    fundingOperationId: "funding_1",
  };
void fundingAsSettlement;

declare const rejectedRequestEvidence: VariantBy<
  import("../src/data/supplier-payout-event-inbox").SupplierPayoutEvidence,
  "targetKind",
  "request"
>;
const requestAsSettlement: import("../src/data/supplier-payout-event-inbox").SupplierPayoutEvidence =
  {
    ...rejectedRequestEvidence,
    observation: {
      kind: "settled",
      // @ts-expect-error Spreading request evidence cannot grant it settlement authority.
      providerTransferId: "transfer_1",
      receiptReference: "receipt_1",
      settledAt: "2026-09-06T00:00:00Z",
    },
  };
void requestAsSettlement;

// @ts-expect-error A funding approval cannot omit the provider transfer it authorizes.
const fundingResumeWithoutTransfer: import("../src/commerce/action-model").CommerceActionRequest =
  {
    kind: "resume_supplier_payout_funding",
    payoutId: "supplier_payout_1",
    expectedPayoutRevision: 4,
    approvalDigest: "ab".repeat(32),
    attemptId: "attempt_1",
  };
void fundingResumeWithoutTransfer;
