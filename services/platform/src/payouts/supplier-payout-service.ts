import type { OrganisationDatabase } from "../database-handles";
import { PAYOUT_EVENT_ATTEMPT_MATCH } from "../data/supplier-payout-event-inbox";
import type {
  SupplierPayable,
  SupplierPayoutExecutionPlan,
  SupplierPayoutState,
} from "@seams/contracts";

import {
  advanceSupplierPayout,
  readSupplierPayout,
  readSupplierPayoutByIdempotencyKey,
  type SupplierPayoutRow,
} from "../data/supplier-payout-store";
import {
  payoutPlanMatchesRow,
  payoutSourceReference,
  readSealedPayoutPlan,
} from "../data/supplier-payout-plan";
import { payoutIsCertified } from "../data/supplier-payout-certification";
import {
  readActiveSupplierDestination,
  readSupplierPayable,
  type SupplierDestinationRow,
  type SupplierPayableRow,
} from "../data/supplier-payable-store";
import {
  executeSupplierPayout,
  fundSupplierPayoutTransfer,
  type PayoutAttemptStore,
  type SupplierPayoutPlanValidator,
  type SupplierPayoutProvider,
} from "./executor";
import { listSupplierPayoutAttempts } from "../data/supplier-payout-attempt";
import type { OrganisationId } from "../ids";
import type { Variant } from "@seams/type-utils";
import { assertNever, isRecord } from "@seams/std";

type PayoutProposalError =
  | "payable_not_found"
  | "payable_not_payable"
  | "destination_not_active"
  | "destination_currency_mismatch"
  | "insufficient_remaining"
  | "allocation_conflict"
  | "payout_exists";

type PayoutProposalResult =
  | Readonly<{ ok: true; payout: SupplierPayoutRow }>
  | Readonly<{
      ok: false;
      error: PayoutProposalError;
      existing?: SupplierPayoutRow;
    }>;

/**
 * Lexicon's payable command port.
 *
 * Injected so this module stays free of the wasm runtime; production wires
 * `applySupplierPayableCommandWithLexicon`. A permissive stand-in here would
 * defeat the allocation rules entirely, which is why nothing in production
 * constructs one.
 */
export type PayableCommandRunner = (
  input: Readonly<{
    payable: unknown;
    command: unknown;
  }>,
) => Readonly<{ ok: true; value: SupplierPayable }> | Readonly<{ ok: false }>;

type PayoutProposalInput = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  payableId: string;
  destinationId: string;
  payoutId: string;
  proposalId: string;
  /** The stable request identity; one payout per key, per organisation. */
  idempotencyKey: string;
  recipientAmountMinor: number;
  feeCeilingMinor: number;
  rail: SupplierPayoutRow["rail"];
  integrationAccountId: string;
  expiresAt: string;
  now: number;
  applyPayableCommand: PayableCommandRunner;
}>;

/**
 * Propose a payout against an approved payable.
 *
 * Nothing is sent here and nothing is approved. The result is a payout awaiting
 * an approver, with the payable's money already held so that two proposals
 * cannot both spend the same remaining balance.
 */
export async function proposeSupplierPayout(
  input: PayoutProposalInput,
): Promise<PayoutProposalResult> {
  // A retry finds its own earlier payout rather than proposing a second one
  // against the same payable.
  const existing = await readSupplierPayoutByIdempotencyKey(
    input.db,
    input.organisationId,
    input.idempotencyKey,
  );
  if (existing !== undefined) {
    return { ok: false, error: "payout_exists", existing };
  }

  const payable = await readSupplierPayable(
    input.db,
    input.organisationId,
    input.payableId,
  );
  if (payable === undefined) {
    return { ok: false, error: "payable_not_found" };
  }
  if (
    payable.lifecycle !== "approved" &&
    payable.lifecycle !== "partially_paid"
  ) {
    // A draft has not been agreed and a void one is not owed. Neither can fund
    // a payout, whatever its remaining balance arithmetic says.
    return { ok: false, error: "payable_not_payable" };
  }

  const conflict = await input.db
    .prepare(`${PAYABLE_CONFLICT_QUERY} LIMIT 1`)
    .bind(input.organisationId, input.payableId)
    .first();
  if (conflict !== null) {
    return { ok: false, error: "allocation_conflict" };
  }

  const destination = await readActiveSupplierDestination(
    input.db,
    input.organisationId,
    input.destinationId,
  );
  if (
    destination === undefined ||
    destination.supplierId !== payable.supplierId ||
    destination.rail !== destinationRailForPayout(input.rail)
  ) {
    return { ok: false, error: "destination_not_active" };
  }

  const remaining =
    payable.grossAmountMinor - payable.inFlightMinor - payable.settledMinor;
  if (input.recipientAmountMinor > remaining) {
    return { ok: false, error: "insufficient_remaining" };
  }

  // Lexicon decides whether the allocation is legal and what the payable
  // becomes. The arithmetic above is a cheap pre-check, not the authority.
  const allocated = input.applyPayableCommand({
    payable: JSON.parse(payable.payableJson),
    command: {
      kind: "allocate",
      amount: {
        currency: payable.currency,
        amountMinor: input.recipientAmountMinor,
      },
    },
  });
  if (!allocated.ok) {
    return { ok: false, error: "allocation_conflict" };
  }
  const nextPayable = allocated.value;
  const payoutJson = JSON.stringify({
    payoutId: input.payoutId,
    state: {
      kind: "approval_pending",
      proposalId: input.proposalId,
      expiresAt: input.expiresAt,
    },
  });
  const persisted = await persistSupplierPayoutProposal({
    proposal: input,
    payable,
    destination,
    nextPayable,
    payoutJson,
  });
  if (!persisted) {
    return { ok: false, error: "allocation_conflict" };
  }
  const payout = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  if (payout === undefined) {
    return { ok: false, error: "payout_exists" };
  }

  return { ok: true, payout };
}

function destinationRailForPayout(
  rail: SupplierPayoutRow["rail"],
): "gmo_aozora_domestic" | "wise_recipient" {
  switch (rail) {
    case "gmo_aozora_private":
      return "gmo_aozora_domestic";
    case "wise_enterprise_payouts":
      return "wise_recipient";
    default:
      return assertNever(rail);
  }
}

async function persistSupplierPayoutProposal(persistence: {
  readonly proposal: PayoutProposalInput;
  readonly payable: SupplierPayableRow;
  readonly destination: SupplierDestinationRow;
  readonly nextPayable: SupplierPayable;
  readonly payoutJson: string;
}): Promise<boolean> {
  const { proposal, payable, destination, nextPayable } = persistence;

  // Inserting the proposal fences allocation. A failed insert or stale payable
  // leaves both resources unchanged in the atomic D1 batch.
  const writes = await proposal.db.batch([
    proposal.db
      .prepare(
        `INSERT INTO supplier_payout (
      organisation_id, payout_id, payable_id, supplier_id, purchase_request_id, rail,
      integration_account_id, destination_revision_id, currency, recipient_amount_minor,
      fee_ceiling_minor, idempotency_key, state_kind, approval_digest, payout_json, revision, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval_pending', NULL, ?, 1, ?, ?
      WHERE EXISTS (SELECT 1 FROM supplier_payable WHERE organisation_id = ? AND payable_id = ? AND revision = ?)
      AND NOT EXISTS (${PAYABLE_CONFLICT_QUERY})
      ON CONFLICT DO NOTHING`,
      )
      .bind(
        proposal.organisationId,
        proposal.payoutId,
        payable.payableId,
        payable.supplierId,
        payable.purchaseRequestId,
        proposal.rail,
        proposal.integrationAccountId,
        destination.revisionId,
        payable.currency,
        proposal.recipientAmountMinor,
        proposal.feeCeilingMinor,
        proposal.idempotencyKey,
        persistence.payoutJson,
        proposal.now,
        proposal.now,
        proposal.organisationId,
        payable.payableId,
        payable.revision,
        proposal.organisationId,
        proposal.payableId,
      ),
    proposal.db
      .prepare(
        `UPDATE supplier_payable SET in_flight_minor = ?, settled_minor = ?, lifecycle = ?,
      revision = ?, payable_json = ?, updated_at = ?
      WHERE organisation_id = ? AND payable_id = ? AND revision = ? AND changes() = 1`,
      )
      .bind(
        nextPayable.allocation.inFlight.amountMinor,
        nextPayable.allocation.settled.amountMinor,
        nextPayable.lifecycle,
        nextPayable.revision,
        JSON.stringify(nextPayable),
        proposal.now,
        proposal.organisationId,
        payable.payableId,
        payable.revision,
      ),
  ]);

  return (writes[0]?.meta.changes ?? 0) === 1;
}

type PayoutApprovalError =
  | "payout_not_found"
  | "not_awaiting_approval"
  | "plan_invalid"
  | "economics_changed"
  | "approver_is_proposer"
  | "revision_conflict";

/**
 * Approve a proposed payout by sealing the exact economics.
 *
 * The digest comes from Lexicon, computed over the plan itself, so what is
 * recorded is what an approver saw and not a summary of it. From here on any
 * change to the economics produces a different digest and a plan the executor
 * refuses.
 */
export async function approveSupplierPayout(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    payoutId: string;
    plan: SupplierPayoutExecutionPlan;
    approverId: string;
    approvalReceiptId: string;
    executionDeadline: string;
    now: number;
    validate: SupplierPayoutPlanValidator;
    /** Who proposed the destination this payout pays to. */
    readDestinationProposer: (revisionId: string) => Promise<string | null>;
  }>,
): Promise<
  | Readonly<{ ok: true; payout: SupplierPayoutRow }>
  | Readonly<{ ok: false; error: PayoutApprovalError }>
> {
  const payout = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  if (payout === undefined) {
    return { ok: false, error: "payout_not_found" };
  }
  if (payout.stateKind !== "approval_pending") {
    return { ok: false, error: "not_awaiting_approval" };
  }

  // Whoever wrote a supplier's bank details must not be the one who authorizes
  // money to them. The schema enforces this for activation; it has to hold here
  // too, or the separation is only as strong as its weakest gate.
  const proposer = await input.readDestinationProposer(
    payout.destinationRevisionId,
  );
  if (proposer === null || proposer === input.approverId) {
    return { ok: false, error: "approver_is_proposer" };
  }

  const payable = await readSupplierPayable(
    input.db,
    input.organisationId,
    payout.payableId,
  );
  if (
    payable === undefined ||
    payable.merchantId !== input.plan.subject.merchantId
  ) {
    return { ok: false, error: "plan_invalid" };
  }
  const validated = input.validate(input.plan);
  if (
    !validated.ok ||
    !payoutPlanMatchesRow(input.plan, payout, input.organisationId) ||
    input.executionDeadline !== input.plan.seal.executionDeadline ||
    Date.parse(input.executionDeadline) <= input.now
  ) {
    return { ok: false, error: "plan_invalid" };
  }
  if (!validated.value.matchesApproval) {
    // The plan does not carry the digest of its own economics, so sealing it
    // would record an approval of something the plan does not describe.
    return { ok: false, error: "economics_changed" };
  }

  const advanced = await advanceSupplierPayout({
    db: input.db,
    organisationId: input.organisationId,
    payoutId: payout.payoutId,
    expectedRevision: payout.revision,
    stateKind: "approved",
    approvalDigest: validated.value.economicsDigest,
    payoutJson: JSON.stringify({
      ...JSON.parse(payout.payoutJson),
      // The sealed plan is stored here and nowhere else. Recovery and the
      // governed executor both need the exact economics that were approved,
      // and rebuilding them from parts afterwards would reconstruct something
      // adjacent to the approval rather than the approval itself.
      plan: input.plan,
      approval: {
        receiptId: input.approvalReceiptId,
        approverId: input.approverId,
        approvedAt: input.now,
      },
      state: {
        kind: "approved",
        approvalReceiptId: input.approvalReceiptId,
        approvalDigest: validated.value.economicsDigest,
        executionDeadline: input.executionDeadline,
      },
    }),
    now: input.now,
  });
  if (!advanced.ok) {
    return { ok: false, error: "revision_conflict" };
  }
  const reread = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  return reread === undefined
    ? { ok: false, error: "payout_not_found" }
    : { ok: true, payout: reread };
}

/**
 * Send an approved payout.
 *
 * The payout moves to `submitting` before the provider is called, so an
 * interruption leaves a payout that recovery can ask about rather than one that
 * still looks ready to send.
 */
export async function submitSupplierPayout(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    payoutId: string;
    attemptId: string;
    plan: SupplierPayoutExecutionPlan;
    /** The Wise profile or GMO source account this payout is sent from. */
    sourceReference: string;
    environment: "development" | "production";
    now: string;
    provider: SupplierPayoutProvider;
    store: PayoutAttemptStore;
    validate: SupplierPayoutPlanValidator;
  }>,
): Promise<
  | Readonly<{ ok: true; payout: SupplierPayoutRow }>
  | Readonly<{
      ok: false;
      error:
        | "payout_not_found"
        | "not_approved"
        | "uncertified_rail"
        | "revision_conflict";
    }>
> {
  const payout = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  if (payout === undefined) {
    return { ok: false, error: "payout_not_found" };
  }
  if (payout.stateKind !== "approved" || payout.approvalDigest === null) {
    return { ok: false, error: "not_approved" };
  }

  // An approval says a person agreed to these economics. Certification says
  // Pantry has evidence the rail can carry them — for this account, this
  // currency, and at least this amount. Both are required, and neither
  // substitutes for the other.
  const sealedPlan = readSealedPayoutPlan(payout, input.organisationId);
  if (
    sealedPlan === null ||
    payoutSourceReference(sealedPlan) !== input.sourceReference ||
    !payoutPlanMatchesRow(input.plan, payout, input.organisationId) ||
    input.plan.seal.approvalDigest !== sealedPlan.seal.approvalDigest ||
    !Number.isFinite(Date.parse(input.now)) ||
    Date.parse(sealedPlan.seal.executionDeadline) <= Date.parse(input.now)
  ) {
    return { ok: false, error: "not_approved" };
  }
  const covered = await payoutIsCertified({
    db: input.db,
    organisationId: input.organisationId,
    rail: payout.rail,
    integrationAccountId: payout.integrationAccountId,
    sourceReference: input.sourceReference,
    fundingMode: "balance",
    environment: input.environment,
    currency: payout.currency,
    amountMinor: payout.recipientAmountMinor,
  });
  if (!covered) {
    return { ok: false, error: "uncertified_rail" };
  }

  const submitting = await advanceSupplierPayout({
    db: input.db,
    organisationId: input.organisationId,
    payoutId: payout.payoutId,
    expectedRevision: payout.revision,
    stateKind: "submitting",
    approvalDigest: payout.approvalDigest,
    payoutJson: JSON.stringify({
      ...JSON.parse(payout.payoutJson),
      state: {
        kind: "submitting",
        attemptId: input.attemptId,
        submittedAt: input.now,
      },
    }),
    now: Date.parse(input.now),
  });
  // Losing this race means another writer is already submitting. Two submitters
  // would send two transfers for one payable.
  if (!submitting.ok) {
    return { ok: false, error: "revision_conflict" };
  }

  const executed = await executeSupplierPayout({
    plan: sealedPlan,
    attemptId: input.attemptId,
    payoutApprovalDigest: payout.approvalDigest,
    now: input.now,
    provider: input.provider,
    store: input.store,
    validate: input.validate,
  });

  const nextState = stateAfterExecution(
    executed,
    input.attemptId,
    sealedPlan.seal.idempotencyKey,
    input.now,
  );
  await advanceSupplierPayout({
    db: input.db,
    organisationId: input.organisationId,
    payoutId: payout.payoutId,
    expectedRevision: submitting.revision,
    stateKind: nextState.kind,
    approvalDigest: payout.approvalDigest,
    payoutJson: JSON.stringify({
      ...JSON.parse(payout.payoutJson),
      state: nextState,
    }),
    now: Date.parse(input.now),
  });
  const reread = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  return reread === undefined
    ? { ok: false, error: "payout_not_found" }
    : { ok: true, payout: reread };
}

type PayoutFundingResumeError =
  | "payout_not_found"
  | "not_funding_required"
  | "funding_identity_mismatch"
  | "approval_expired"
  | "uncertified_rail"
  | "payout_conflict"
  | "revision_conflict";

/** Fund the exact Wise transfer named by a fresh governed action. */
export async function resumeSupplierPayoutFunding(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    payoutId: string;
    expectedPayoutRevision: number;
    attemptId: string;
    providerTransferId: string;
    sourceReference: string;
    environment: "development" | "production";
    now: string;
    provider: SupplierPayoutProvider;
    store: PayoutAttemptStore;
    validate: SupplierPayoutPlanValidator;
  }>,
): Promise<
  | Readonly<{ ok: true; payout: SupplierPayoutRow }>
  | Readonly<{ ok: false; error: PayoutFundingResumeError }>
> {
  const payout = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  if (payout === undefined) {
    return { ok: false, error: "payout_not_found" };
  }
  if (payout.revision !== input.expectedPayoutRevision) {
    return { ok: false, error: "revision_conflict" };
  }
  if (
    payout.stateKind !== "provider_action_required" ||
    payout.approvalDigest === null ||
    payout.rail !== "wise_enterprise_payouts"
  ) {
    return { ok: false, error: "not_funding_required" };
  }

  const plan = readSealedPayoutPlan(payout, input.organisationId);
  const document = parseFundingRequiredPayoutDocument(payout.payoutJson);
  if (
    plan === null ||
    plan.kind !== "wise" ||
    document === null ||
    document.state.attemptId !== input.attemptId ||
    document.state.providerTransferId !== input.providerTransferId ||
    payoutSourceReference(plan) !== input.sourceReference ||
    !payoutPlanMatchesRow(plan, payout, input.organisationId)
  ) {
    return { ok: false, error: "funding_identity_mismatch" };
  }

  const now = Date.parse(input.now);
  if (
    !Number.isFinite(now) ||
    Date.parse(plan.seal.executionDeadline) <= now ||
    Date.parse(plan.rateExpiresAt) <= now
  ) {
    return { ok: false, error: "approval_expired" };
  }
  const attempts = await listSupplierPayoutAttempts(
    input.db,
    input.organisationId,
    payout.payoutId,
  );
  const attempt = attempts[0];
  if (
    attempts.length !== 1 ||
    attempt === undefined ||
    attempt.attemptId !== input.attemptId ||
    attempt.approvalDigest !== payout.approvalDigest ||
    attempt.requestIdentity !== plan.seal.idempotencyKey ||
    attempt.providerTransferId !== input.providerTransferId ||
    attempt.fundingOperationId !== null
  ) {
    return { ok: false, error: "funding_identity_mismatch" };
  }

  const conflict = await input.db
    .prepare(`${PAYABLE_CONFLICT_QUERY} LIMIT 1`)
    .bind(input.organisationId, payout.payableId)
    .first();
  if (conflict !== null) {
    return { ok: false, error: "payout_conflict" };
  }
  const covered = await payoutIsCertified({
    db: input.db,
    organisationId: input.organisationId,
    rail: payout.rail,
    integrationAccountId: payout.integrationAccountId,
    sourceReference: input.sourceReference,
    fundingMode: "balance",
    environment: input.environment,
    currency: payout.currency,
    amountMinor: payout.recipientAmountMinor,
  });
  if (!covered) {
    return { ok: false, error: "uncertified_rail" };
  }

  let funded: Awaited<ReturnType<typeof fundSupplierPayoutTransfer>>;
  try {
    funded = await fundSupplierPayoutTransfer({
      plan,
      attemptId: input.attemptId,
      providerTransferId: input.providerTransferId,
      payoutApprovalDigest: payout.approvalDigest,
      now: input.now,
      provider: input.provider,
      store: input.store,
      validate: input.validate,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "payout_funding_dispatch_conflict"
    ) {
      return { ok: false, error: "payout_conflict" };
    }
    throw error;
  }
  if (funded.kind === "not_executable") {
    return { ok: false, error: "approval_expired" };
  }
  const state = stateAfterFunding(
    funded,
    input.attemptId,
    input.providerTransferId,
    input.now,
  );
  const advanced = await advanceSupplierPayout({
    db: input.db,
    organisationId: input.organisationId,
    payoutId: payout.payoutId,
    expectedRevision: payout.revision,
    stateKind: state.kind,
    approvalDigest: payout.approvalDigest,
    payoutJson: JSON.stringify({ plan, approval: document.approval, state }),
    now,
  });
  if (!advanced.ok) {
    return { ok: false, error: "revision_conflict" };
  }
  const reread = await readSupplierPayout(
    input.db,
    input.organisationId,
    input.payoutId,
  );
  return reread === undefined
    ? { ok: false, error: "payout_not_found" }
    : { ok: true, payout: reread };
}

type FundingRequiredState = Variant<
  SupplierPayoutState,
  "provider_action_required"
>;

function parseFundingRequiredPayoutDocument(
  payoutJson: string,
): Readonly<{ approval: unknown; state: FundingRequiredState }> | null {
  let document: unknown;
  try {
    document = JSON.parse(payoutJson);
  } catch {
    return null;
  }
  if (
    !isRecord(document) ||
    !("approval" in document) ||
    !isRecord(document.state)
  ) {
    return null;
  }
  const state = document.state;
  if (
    state.kind !== "provider_action_required" ||
    state.actionCode !== "funding_required" ||
    typeof state.attemptId !== "string" ||
    state.attemptId.length === 0 ||
    typeof state.providerTransferId !== "string" ||
    state.providerTransferId.length === 0 ||
    typeof state.observedAt !== "string" ||
    !Number.isFinite(Date.parse(state.observedAt))
  ) {
    return null;
  }
  return {
    approval: document.approval,
    state: {
      kind: "provider_action_required",
      attemptId: state.attemptId,
      providerTransferId: state.providerTransferId,
      actionCode: state.actionCode,
      observedAt: state.observedAt,
    },
  };
}

function stateAfterFunding(
  result: Exclude<
    import("./executor").PayoutExecutionResult,
    { readonly kind: "not_executable" }
  >,
  attemptId: string,
  providerTransferId: string,
  now: string,
): SupplierPayoutState {
  switch (result.kind) {
    case "provider_pending":
      return {
        kind: result.kind,
        providerTransferId,
        providerState: "accepted",
        observedAt: now,
      };
    case "provider_action_required":
      return {
        kind: result.kind,
        attemptId,
        providerTransferId,
        actionCode: result.actionCode,
        observedAt: now,
      };
    case "indeterminate":
      return {
        kind: result.kind,
        attemptId,
        operation: result.operation,
        nextInquiryAt: now,
      };
    case "rejected":
      return {
        kind: "provider_action_required",
        attemptId,
        providerTransferId,
        actionCode: "funding_rejected",
        observedAt: now,
      };
  }
}

function stateAfterExecution(
  result: import("./executor").PayoutExecutionResult,
  attemptId: string,
  requestIdentity: string,
  now: string,
): SupplierPayoutState {
  switch (result.kind) {
    case "provider_pending":
      return {
        kind: result.kind,
        providerTransferId: result.providerTransferId,
        providerState: "accepted",
        observedAt: now,
      };
    case "provider_action_required":
      return {
        kind: result.kind,
        attemptId,
        providerTransferId: result.providerTransferId,
        actionCode: result.actionCode,
        observedAt: now,
      };
    case "indeterminate":
      return {
        kind: result.kind,
        attemptId,
        operation: result.operation,
        nextInquiryAt: now,
      };
    case "rejected":
    case "not_executable":
      return {
        kind: "indeterminate",
        attemptId,
        operation: { kind: "transfer_creation", requestIdentity },
        nextInquiryAt: now,
      };
  }
}

const PAYABLE_CONFLICT_QUERY = `SELECT 1 AS present FROM supplier_payout p
    JOIN supplier_payout_attempt a ON a.organisation_id = p.organisation_id AND a.payout_id = p.payout_id
    JOIN supplier_payout_event e ON e.organisation_id = p.organisation_id AND e.rail = p.rail
      AND e.integration_account_id = p.integration_account_id AND ${PAYOUT_EVENT_ATTEMPT_MATCH}
    WHERE p.organisation_id = ? AND p.payable_id = ? AND e.status = 'conflict'`;
