import type {
  PayoutIndeterminateOperation,
  SupplierPayoutExecutionPlan,
} from "@seams/contracts";
import type { Variant } from "@seams/type-utils";

/** Funding acknowledgement is not evidence of delivery to the supplier. */
export type PayoutProviderOutcome =
  | Readonly<{ kind: "accepted"; providerTransferId: string }>
  | Readonly<{ kind: "funded"; fundingOperationId: string }>
  | Readonly<{ kind: "rejected"; reason: string }>
  | Readonly<{ kind: "unknown" }>;

export interface SupplierPayoutProvider {
  createTransfer(
    plan: SupplierPayoutExecutionPlan,
  ): Promise<PayoutProviderOutcome>;
  fundTransfer(
    plan: SupplierPayoutExecutionPlan,
    providerTransferId: string,
  ): Promise<PayoutProviderOutcome>;
  inquireTransfer(requestIdentity: string): Promise<PayoutProviderOutcome>;
  inquireFunding(
    providerTransferId: string,
    fundingOperationId: string,
  ): Promise<PayoutProviderOutcome>;
}

export interface PayoutAttemptStore {
  recordDispatch(
    input: Readonly<{
      payoutId: string;
      attemptId: string;
      approvalDigest: string;
      requestIdentity: string;
    }>,
  ): Promise<void>;
  recordProviderTransfer(
    input: Readonly<{
      payoutId: string;
      attemptId: string;
      providerTransferId: string;
    }>,
  ): Promise<void>;
  recordFundingDispatch(
    input: Readonly<{
      payoutId: string;
      attemptId: string;
      providerTransferId: string;
      fundingOperationId: string;
    }>,
  ): Promise<void>;
}

export type PayoutExecutionResult =
  | Readonly<{ kind: "provider_pending"; providerTransferId: string }>
  | Readonly<{
      kind: "provider_action_required";
      providerTransferId: string;
      actionCode: "funding_required" | "funding_rejected";
    }>
  | Readonly<{ kind: "rejected"; reason: string }>
  | Readonly<{ kind: "indeterminate"; operation: PayoutIndeterminateOperation }>
  | Readonly<{ kind: "not_executable"; reason: PayoutRefusal }>;

export type PayoutRefusal =
  | "approval_expired"
  | "approval_digest_mismatch"
  | "plan_invalid"
  | "economics_changed";

export type SupplierPayoutPlanValidator = (
  plan: SupplierPayoutExecutionPlan,
) =>
  | Readonly<{
      ok: true;
      value: Readonly<{ economicsDigest: string; matchesApproval: boolean }>;
    }>
  | Readonly<{ ok: false }>;

export type PayoutExecutionInput = Readonly<{
  plan: SupplierPayoutExecutionPlan;
  attemptId: string;
  payoutApprovalDigest: string;
  now: string;
  provider: SupplierPayoutProvider;
  store: PayoutAttemptStore;
  validate: SupplierPayoutPlanValidator;
}>;

export type PayoutFundingInput = Readonly<{
  plan: Variant<SupplierPayoutExecutionPlan, "wise">;
  attemptId: string;
  providerTransferId: string;
  payoutApprovalDigest: string;
  now: string;
  provider: SupplierPayoutProvider;
  store: PayoutAttemptStore;
  validate: SupplierPayoutPlanValidator;
}>;

function executionRefusal(
  input: Pick<
    PayoutExecutionInput,
    "plan" | "payoutApprovalDigest" | "now" | "validate"
  >,
): PayoutRefusal | null {
  const validated = input.validate(input.plan);
  if (!validated.ok) return "plan_invalid";
  if (!validated.value.matchesApproval) return "economics_changed";
  if (validated.value.economicsDigest !== input.payoutApprovalDigest)
    return "approval_digest_mismatch";
  const deadline = Date.parse(input.plan.seal.executionDeadline);
  const now = Date.parse(input.now);
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || deadline <= now)
    return "approval_expired";
  if (input.plan.kind === "wise") {
    const rateExpiresAt = Date.parse(input.plan.rateExpiresAt);
    if (!Number.isFinite(rateExpiresAt) || rateExpiresAt <= now)
      return "approval_expired";
  }
  return null;
}

export async function executeSupplierPayout(
  input: PayoutExecutionInput,
): Promise<PayoutExecutionResult> {
  const refusal = executionRefusal(input);
  if (refusal !== null) return { kind: "not_executable", reason: refusal };
  const requestIdentity = input.plan.seal.idempotencyKey;
  await input.store.recordDispatch({
    payoutId: input.plan.subject.payoutId,
    attemptId: input.attemptId,
    approvalDigest: input.payoutApprovalDigest,
    requestIdentity,
  });
  let created: PayoutProviderOutcome;
  try {
    created = await input.provider.createTransfer(input.plan);
  } catch {
    return {
      kind: "indeterminate",
      operation: { kind: "transfer_creation", requestIdentity },
    };
  }
  if (created.kind === "rejected")
    return { kind: "rejected", reason: created.reason };
  if (created.kind !== "accepted") {
    return {
      kind: "indeterminate",
      operation: { kind: "transfer_creation", requestIdentity },
    };
  }
  await input.store.recordProviderTransfer({
    payoutId: input.plan.subject.payoutId,
    attemptId: input.attemptId,
    providerTransferId: created.providerTransferId,
  });
  // A domestic bank transfer has no separate Wise-style funding operation.
  if (input.plan.kind === "gmo_aozora") {
    return {
      kind: "provider_pending",
      providerTransferId: created.providerTransferId,
    };
  }
  return fundSupplierPayoutTransfer({
    plan: input.plan,
    attemptId: input.attemptId,
    providerTransferId: created.providerTransferId,
    payoutApprovalDigest: input.payoutApprovalDigest,
    now: input.now,
    provider: input.provider,
    store: input.store,
    validate: input.validate,
  });
}

/** Fund one already-recorded Wise transfer after a fresh governed approval. */
export async function fundSupplierPayoutTransfer(
  input: PayoutFundingInput,
): Promise<PayoutExecutionResult> {
  const refusal = executionRefusal(input);
  if (refusal !== null) return { kind: "not_executable", reason: refusal };
  const fundingOperationId = `funding:${input.attemptId}`;
  await input.store.recordFundingDispatch({
    payoutId: input.plan.subject.payoutId,
    attemptId: input.attemptId,
    providerTransferId: input.providerTransferId,
    fundingOperationId,
  });
  let funded: PayoutProviderOutcome;
  try {
    funded = await input.provider.fundTransfer(
      input.plan,
      input.providerTransferId,
    );
  } catch {
    return {
      kind: "indeterminate",
      operation: {
        kind: "funding",
        providerTransferId: input.providerTransferId,
        fundingOperationId,
      },
    };
  }
  switch (funded.kind) {
    case "funded":
      return {
        kind: "provider_pending",
        providerTransferId: input.providerTransferId,
      };
    case "rejected":
      return {
        kind: "provider_action_required",
        providerTransferId: input.providerTransferId,
        actionCode: "funding_rejected",
      };
    case "accepted":
    case "unknown":
      return {
        kind: "indeterminate",
        operation: {
          kind: "funding",
          providerTransferId: input.providerTransferId,
          fundingOperationId,
        },
      };
  }
}

/** Recovery only inquires. Resuming funding requires a fresh governed execution. */
export async function recoverSupplierPayout(
  input: PayoutExecutionInput &
    Readonly<{
      operation: PayoutIndeterminateOperation;
    }>,
): Promise<PayoutExecutionResult> {
  const operation = input.operation;
  let outcome: PayoutProviderOutcome;
  try {
    outcome =
      operation.kind === "funding"
        ? await input.provider.inquireFunding(
            operation.providerTransferId,
            operation.fundingOperationId,
          )
        : await input.provider.inquireTransfer(operation.requestIdentity);
  } catch {
    return { kind: "indeterminate", operation };
  }
  if (operation.kind === "funding") {
    if (outcome.kind === "funded")
      return {
        kind: "provider_pending",
        providerTransferId: operation.providerTransferId,
      };
    if (outcome.kind === "rejected") {
      return {
        kind: "provider_action_required",
        providerTransferId: operation.providerTransferId,
        actionCode: "funding_rejected",
      };
    }
    return { kind: "indeterminate", operation };
  }
  if (outcome.kind === "rejected")
    return { kind: "rejected", reason: outcome.reason };
  if (outcome.kind !== "accepted") return { kind: "indeterminate", operation };
  await input.store.recordProviderTransfer({
    payoutId: input.plan.subject.payoutId,
    attemptId: input.attemptId,
    providerTransferId: outcome.providerTransferId,
  });
  return input.plan.kind === "gmo_aozora"
    ? {
        kind: "provider_pending",
        providerTransferId: outcome.providerTransferId,
      }
    : {
        kind: "provider_action_required",
        providerTransferId: outcome.providerTransferId,
        actionCode: "funding_required",
      };
}
