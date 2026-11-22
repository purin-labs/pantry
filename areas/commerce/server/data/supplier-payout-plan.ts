import type { SupplierPayoutExecutionPlan } from "@purin-labs/commerce-contracts";
import {
  assertSupplierPayoutPlanWithLexicon,
  validateSupplierPayoutPlanWithLexicon,
} from "../commerce-wasm";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { SupplierPayoutRow } from "./supplier-payout-store";
import { isRecord } from "@purin-labs/std";

export function payoutPlanMatchesRow(
  plan: SupplierPayoutExecutionPlan,
  payout: SupplierPayoutRow,
  organisationId: OrganisationId,
): boolean {
  const amount =
    plan.kind === "gmo_aozora" ? plan.recipientAmount : plan.targetAmount;
  return (
    plan.subject.organisationId === organisationId &&
    plan.subject.payoutId === payout.payoutId &&
    plan.subject.payableId === payout.payableId &&
    plan.subject.supplierId === payout.supplierId &&
    plan.subject.purchaseRequestId === payout.purchaseRequestId &&
    plan.integrationAccountId === payout.integrationAccountId &&
    plan.destinationRevisionId === payout.destinationRevisionId &&
    payout.rail ===
      (plan.kind === "gmo_aozora"
        ? "gmo_aozora_private"
        : "wise_enterprise_payouts") &&
    amount.amountMinor === payout.recipientAmountMinor &&
    amount.currency === payout.currency &&
    plan.feeCeiling.amountMinor === payout.feeCeilingMinor &&
    plan.seal.idempotencyKey === payout.idempotencyKey
  );
}

export function readSealedPayoutPlan(
  payout: SupplierPayoutRow,
  organisationId: OrganisationId,
): SupplierPayoutExecutionPlan | null {
  try {
    const document: unknown = JSON.parse(payout.payoutJson);
    if (!isRecord(document)) return null;
    const plan = document.plan;
    assertSupplierPayoutPlanWithLexicon(plan);
    const validation = validateSupplierPayoutPlanWithLexicon(plan);
    return validation.ok &&
      validation.value.matchesApproval &&
      validation.value.economicsDigest === payout.approvalDigest &&
      payoutPlanMatchesRow(plan, payout, organisationId)
      ? plan
      : null;
  } catch {
    return null;
  }
}

export function payoutSourceReference(
  plan: SupplierPayoutExecutionPlan,
): string {
  return plan.kind === "gmo_aozora" ? plan.sourceAccountId : plan.profileId;
}
