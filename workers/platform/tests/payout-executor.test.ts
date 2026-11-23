import { wisePayoutPlan } from "./supplier-payout-fixtures";
import { describe, expect, it } from "vitest";

import {
  executeSupplierPayout,
  recoverSupplierPayout,
  type PayoutAttemptStore,
  type SupplierPayoutPlanValidator,
  type PayoutProviderOutcome,
  type SupplierPayoutProvider,
} from "@purin-labs/area-commerce/server/payouts/executor";

const PLAN = wisePayoutPlan("organisation_1");
const DIGEST = PLAN.seal.approvalDigest;

const NOW = "2026-09-06T12:00:00Z";

type Calls = {
  createTransfer: number;
  fundTransfer: number;
  inquireTransfer: number;
  inquireFunding: number;
  recordedTransfers: string[];
  recordedFundings: string[];
};

function harness(
  outcomes: Partial<
    Record<keyof SupplierPayoutProvider, PayoutProviderOutcome>
  >,
) {
  const calls: Calls = {
    createTransfer: 0,
    fundTransfer: 0,
    inquireTransfer: 0,
    inquireFunding: 0,
    recordedTransfers: [],
    recordedFundings: [],
  };
  const provider: SupplierPayoutProvider = {
    async createTransfer() {
      calls.createTransfer += 1;
      return outcomes.createTransfer ?? { kind: "unknown" };
    },
    async fundTransfer() {
      calls.fundTransfer += 1;
      return outcomes.fundTransfer ?? { kind: "unknown" };
    },
    async inquireTransfer() {
      calls.inquireTransfer += 1;
      return outcomes.inquireTransfer ?? { kind: "unknown" };
    },
    async inquireFunding() {
      calls.inquireFunding += 1;
      return outcomes.inquireFunding ?? { kind: "unknown" };
    },
  };
  const dispatched: string[] = [];
  const store: PayoutAttemptStore = {
    async recordDispatch(input) {
      dispatched.push(input.requestIdentity);
    },
    async recordProviderTransfer(input) {
      calls.recordedTransfers.push(input.providerTransferId);
    },
    async recordFundingDispatch(input) {
      calls.recordedFundings.push(input.fundingOperationId);
    },
  };
  return { provider, store, calls, dispatched };
}

/**
 * Stands in for Lexicon. The real validator re-parses the plan through its Rust
 * constructors; here the point under test is the executor's ordering, so the
 * plan is taken as valid and agreeing with its own seal.
 */
const VALID: SupplierPayoutPlanValidator = () => ({
  ok: true,
  value: { economicsDigest: DIGEST, matchesApproval: true },
});

function execute(h: ReturnType<typeof harness>, now = NOW) {
  return executeSupplierPayout({
    plan: PLAN,
    attemptId: "attempt_1",
    payoutApprovalDigest: DIGEST,
    now,
    provider: h.provider,
    store: h.store,
    validate: VALID,
  });
}

describe("supplier payout executor", function payoutExecutorSuite() {
  it("treats a lost creation response as unknown, not as a failure", async function lostCreationResponse() {
    const h = harness({ createTransfer: { kind: "unknown" } });
    expect(await execute(h)).toEqual({
      kind: "indeterminate",
      operation: {
        kind: "transfer_creation",
        requestIdentity: "payout-request-1",
      },
    });
    // Critically, it did not fund anything it cannot name.
    expect(h.calls.fundTransfer).toBe(0);
  });

  it("recovers a lost creation by adopting the provider's transfer, never creating a second", async function adoptsExistingTransfer() {
    const h = harness({
      inquireTransfer: { kind: "accepted", providerTransferId: "transfer_1" },
      fundTransfer: { kind: "funded", fundingOperationId: "funding_1" },
    });
    expect(
      await recoverSupplierPayout({
        plan: PLAN,
        attemptId: "attempt_1",
        payoutApprovalDigest: DIGEST,
        operation: {
          kind: "transfer_creation",
          requestIdentity: "payout-request-1",
        },
        now: NOW,
        provider: h.provider,
        store: h.store,
        validate: VALID,
      }),
    ).toEqual({
      kind: "provider_action_required",
      actionCode: "funding_required",
      providerTransferId: "transfer_1",
    });
    // The whole point: recovery never creates.
    expect(h.calls.createTransfer).toBe(0);
    expect(h.calls.fundTransfer).toBe(0);
    expect(h.calls.recordedTransfers).toEqual(["transfer_1"]);
  });

  it("never repeats an unknown funding operation as a new transfer", async function unknownFundingStaysFunding() {
    const h = harness({
      createTransfer: { kind: "accepted", providerTransferId: "transfer_1" },
      fundTransfer: { kind: "unknown" },
    });
    const first = await execute(h);
    expect(first).toEqual({
      kind: "indeterminate",
      operation: {
        kind: "funding",
        providerTransferId: "transfer_1",
        fundingOperationId: "funding:attempt_1",
      },
    });

    if (first.kind !== "indeterminate")
      throw new Error("expected indeterminate");
    const recovered = await recoverSupplierPayout({
      plan: PLAN,
      attemptId: "attempt_1",
      payoutApprovalDigest: DIGEST,
      operation: first.operation,
      now: NOW,
      provider: h.provider,
      store: h.store,
      validate: VALID,
    });
    // Still unknown, and still not a second transfer.
    expect(recovered).toEqual(first);
    expect(h.calls.createTransfer).toBe(1);
    expect(h.calls.inquireTransfer).toBe(0);
    expect(h.calls.inquireFunding).toBe(1);
  });

  it("keeps a confirmed funding pending until delivery evidence arrives", async function fundingConfirmed() {
    const h = harness({
      inquireFunding: { kind: "funded", fundingOperationId: "funding_1" },
    });
    expect(
      await recoverSupplierPayout({
        plan: PLAN,
        attemptId: "attempt_1",
        payoutApprovalDigest: DIGEST,
        operation: {
          kind: "funding",
          providerTransferId: "transfer_1",
          fundingOperationId: "funding:attempt_1",
        },
        now: NOW,
        provider: h.provider,
        store: h.store,
        validate: VALID,
      }),
    ).toEqual({
      kind: "provider_pending",
      providerTransferId: "transfer_1",
    });
    expect(h.calls.createTransfer).toBe(0);
    expect(h.calls.fundTransfer).toBe(0);
  });

  it("refuses an expired approval without contacting the provider", async function expiredApproval() {
    const h = harness({});
    expect(await execute(h, "2026-09-08T00:00:00Z")).toEqual({
      kind: "not_executable",
      reason: "approval_expired",
    });
    expect(h.calls.createTransfer).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it("records the funding operation before funding is dispatched, not after", async function fundingDurability() {
    const h = harness({
      createTransfer: { kind: "accepted", providerTransferId: "transfer_1" },
    });
    // The provider dies mid-funding, exactly as a lost response would.
    h.provider.fundTransfer = async () => {
      // By this point the funding operation must already be durable, or a
      // crash here leaves recovery unable to tell "never funded" from
      // "funded, answer lost".
      expect(h.calls.recordedFundings).toEqual(["funding:attempt_1"]);
      return { kind: "unknown" };
    };
    const result = await execute(h);
    expect(result).toEqual({
      kind: "indeterminate",
      operation: {
        kind: "funding",
        providerTransferId: "transfer_1",
        fundingOperationId: "funding:attempt_1",
      },
    });
    // And the operation it reports is the one it wrote down.
    expect(h.calls.recordedFundings).toEqual(["funding:attempt_1"]);
  });

  it("refuses a plan Lexicon will not accept", async function planInvalid() {
    const h = harness({
      createTransfer: { kind: "accepted", providerTransferId: "transfer_1" },
    });
    expect(
      await executeSupplierPayout({
        plan: PLAN,
        attemptId: "attempt_1",
        payoutApprovalDigest: DIGEST,
        now: NOW,
        provider: h.provider,
        store: h.store,
        validate: () => ({ ok: false }),
      }),
    ).toEqual({ kind: "not_executable", reason: "plan_invalid" });
    // Nothing was dispatched, and no attempt was recorded against a plan that
    // never should have reached the provider.
    expect(h.calls.createTransfer).toBe(0);
    expect(h.dispatched).toEqual([]);
  });

  it("refuses a plan whose economics no longer match its own seal", async function economicsChanged() {
    const h = harness({
      createTransfer: { kind: "accepted", providerTransferId: "transfer_1" },
    });
    expect(
      await executeSupplierPayout({
        plan: PLAN,
        attemptId: "attempt_1",
        payoutApprovalDigest: DIGEST,
        now: NOW,
        provider: h.provider,
        store: h.store,
        // Well-formed, but approved for different economics — a new quote, a
        // moved fee, a different recipient.
        validate: () => ({
          ok: true,
          value: { economicsDigest: "cd".repeat(32), matchesApproval: false },
        }),
      }),
    ).toEqual({ kind: "not_executable", reason: "economics_changed" });
    expect(h.calls.createTransfer).toBe(0);
  });

  it("refuses a plan that does not match the payout Pantry holds", async function digestMismatch() {
    const h = harness({
      createTransfer: { kind: "accepted", providerTransferId: "transfer_1" },
    });
    expect(
      await executeSupplierPayout({
        plan: PLAN,
        attemptId: "attempt_1",
        // The payout's recorded digest is not the one this plan computes to.
        payoutApprovalDigest: "ef".repeat(32),
        now: NOW,
        provider: h.provider,
        store: h.store,
        validate: VALID,
      }),
    ).toEqual({ kind: "not_executable", reason: "approval_digest_mismatch" });
    expect(h.calls.createTransfer).toBe(0);
  });
});
