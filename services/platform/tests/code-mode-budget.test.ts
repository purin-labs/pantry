/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import {
  CODE_MODE_ENGINE_RESERVED_COST_MICROS,
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  claimCodeModeCapabilityCall,
  cancelWorkspaceExecutorOrganisationAllocation,
  cancelCodeModeOrganisationBudget,
  completeCodeModeCapabilityCall,
  createCodeModeBudgetSchema,
  expireCodeModeOrganisationReservations,
  readNextCodeModeOrganisationAlarmAt,
  reconcileCodeModeOrganisationBudget,
  reserveWorkspaceExecutorOrganisationAllocation,
  reserveCodeModeOrganisationBudget,
  settleWorkspaceExecutorOrganisationAllocation,
  settleCodeModeOrganisationBudget,
  type CodeModeOrganisationReservation,
  type CodeModeOrganisationReserveInput,
} from "../src/actors/code-mode-budget";
import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const DIGEST = "a".repeat(64);

describe("Code Mode organisation budget ledger", function codeModeBudgetSuite() {
  it("reserves once for an organisation session turn and expires the lease", function reservesAndExpires() {
    const fixture = budgetFixture();
    const input = reserveInput(100);
    const first = requireReservation(
      reserveCodeModeOrganisationBudget(fixture.sql, input),
    );
    const duplicate = requireReservation(
      reserveCodeModeOrganisationBudget(fixture.sql, input),
    );
    const competing = reserveCodeModeOrganisationBudget(fixture.sql, {
      ...input,
      executionId: "cmx-other",
      idempotencyKey: "code-other",
      leaseId: "lease-other",
    });

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ kind: "reserved", leaseExpiresAt: 35_100 });
    expect(competing).toEqual({
      ok: false,
      error: { code: "code_mode_reservation_conflict" },
    });
    expect(readNextCodeModeOrganisationAlarmAt(fixture.sql)).toBe(35_100);

    expireCodeModeOrganisationReservations(fixture.sql, 35_100);

    expect(reservationState(fixture.database, input.executionId)).toBe(
      "expired",
    );
    expect(readNextCodeModeOrganisationAlarmAt(fixture.sql)).toBeNull();
  });

  it("settles one immutable receipt within the reserved amount", function settlesReceipt() {
    const fixture = budgetFixture();
    const input = reserveInput(100);
    requireReservation(reserveCodeModeOrganisationBudget(fixture.sql, input));
    const settleInput = {
      requestId: input.requestId,
      organisationId: input.organisationId,
      executionId: input.executionId,
      leaseId: input.leaseId,
      receiptId: "receipt-code-primary",
      receiptDigest: "b".repeat(64),
      actualCostMicros: 700,
      capabilityCalls: 0,
      inputBytes: 0,
      outputBytes: 0,
      outcome: "succeeded" as const,
      now: 180,
    };
    const settled = requireReservation(
      settleCodeModeOrganisationBudget(fixture.sql, settleInput),
    );
    const duplicate = requireReservation(
      settleCodeModeOrganisationBudget(fixture.sql, settleInput),
    );
    const conflicting = settleCodeModeOrganisationBudget(fixture.sql, {
      ...settleInput,
      receiptDigest: "c".repeat(64),
    });

    expect(settled).toEqual(duplicate);
    expect(settled).toMatchObject({
      kind: "settled",
      receiptId: "receipt-code-primary",
      actualCostMicros: 700,
      priceBookRevision: "price-book-v1",
    });
    expect(conflicting).toEqual({
      ok: false,
      error: { code: "code_mode_reservation_conflict" },
    });
    expect(receiptCount(fixture.database)).toBe(1);
    const reconciled = requireReservation(
      reconcileCodeModeOrganisationBudget(fixture.sql, {
        requestId: input.requestId,
        organisationId: input.organisationId,
        executionId: input.executionId,
        receiptId: "receipt-code-primary",
        providerCostMicros: 680,
        now: 200,
      }),
    );
    expect(reconciled).toMatchObject({
      kind: "reconciled",
      actualCostMicros: 700,
      providerCostMicros: 680,
      reconciledAt: 200,
    });
  });

  it("claims and completes capability budget before settlement", function claimsCalls() {
    const fixture = budgetFixture();
    const input = reserveInput(100);
    requireReservation(reserveCodeModeOrganisationBudget(fixture.sql, input));
    const claim = {
      requestId: input.requestId,
      organisationId: input.organisationId,
      executionId: input.executionId,
      leaseId: input.leaseId,
      callId: "nested-call-1",
      inputBytes: 200,
      now: 120,
    };
    const claimed = requireCounter(
      claimCodeModeCapabilityCall(fixture.sql, claim),
    );
    const duplicate = requireCounter(
      claimCodeModeCapabilityCall(fixture.sql, claim),
    );
    const completed = requireCounter(
      completeCodeModeCapabilityCall(fixture.sql, {
        requestId: input.requestId,
        organisationId: input.organisationId,
        executionId: input.executionId,
        leaseId: input.leaseId,
        callId: "nested-call-1",
        outputBytes: 300,
        now: 130,
      }),
    );

    expect(claimed).toEqual(duplicate);
    expect(claimed).toMatchObject({
      capabilityCalls: 1,
      inFlightCalls: 1,
      inputBytes: 200,
    });
    expect(completed).toMatchObject({
      capabilityCalls: 1,
      inFlightCalls: 0,
      inputBytes: 200,
      outputBytes: 300,
    });
  });

  it("rejects cost overruns and fences cancellation by lease", function enforcesFence() {
    const fixture = budgetFixture();
    const input = reserveInput(100);
    requireReservation(reserveCodeModeOrganisationBudget(fixture.sql, input));
    const overrun = settleCodeModeOrganisationBudget(fixture.sql, {
      requestId: input.requestId,
      organisationId: input.organisationId,
      executionId: input.executionId,
      leaseId: input.leaseId,
      receiptId: "receipt-overrun",
      receiptDigest: "b".repeat(64),
      actualCostMicros: 1_001,
      capabilityCalls: 0,
      inputBytes: 0,
      outputBytes: 0,
      outcome: "succeeded",
      now: 150,
    });
    const stale = cancelCodeModeOrganisationBudget(fixture.sql, {
      requestId: input.requestId,
      organisationId: input.organisationId,
      executionId: input.executionId,
      leaseId: "lease-stale",
      reason: "turn_cancelled",
      now: 160,
    });
    const cancelled = requireReservation(
      cancelCodeModeOrganisationBudget(fixture.sql, {
        requestId: input.requestId,
        organisationId: input.organisationId,
        executionId: input.executionId,
        leaseId: input.leaseId,
        reason: "turn_cancelled",
        now: 170,
      }),
    );

    expect(overrun).toEqual({
      ok: false,
      error: {
        code: "code_mode_cost_exceeds_reservation",
        reservedCostMicros: 1_000,
      },
    });
    expect(stale).toEqual({
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    });
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      reason: "turn_cancelled",
    });
  });

  it("rejects malformed immutable identities before storage", function parsesBoundary() {
    const fixture = budgetFixture();
    const input = reserveInput(100);
    const invalid = reserveCodeModeOrganisationBudget(fixture.sql, {
      ...input,
      programDigest: "not-a-digest",
    });

    expect(invalid).toEqual({
      ok: false,
      error: { code: "invalid_code_mode_budget_input", field: "programDigest" },
    });
    expect(reservationCount(fixture.database)).toBe(0);
  });

  it("rejects idempotent retries that change pinned authority", function rejectsChangedRetry() {
    const fixture = budgetFixture();
    const input = reserveInput(100);
    requireReservation(reserveCodeModeOrganisationBudget(fixture.sql, input));
    const changed = reserveCodeModeOrganisationBudget(fixture.sql, {
      ...input,
      catalogDigest: "b".repeat(64),
    });

    expect(changed).toEqual({
      ok: false,
      error: { code: "code_mode_reservation_conflict" },
    });
  });

  it("reserves and settles one fixed workspace allocation under the root fence", function workspaceAllocation() {
    const fixture = budgetFixture();
    const root = reserveInput(100);
    const parent = {
      ...root,
      priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
      reservedCostMicros:
        CODE_MODE_ENGINE_RESERVED_COST_MICROS +
        WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    };
    requireReservation(reserveCodeModeOrganisationBudget(fixture.sql, parent));
    const allocation = workspaceAllocationInput(parent, 120);
    const first = requireWorkspaceAllocation(
      reserveWorkspaceExecutorOrganisationAllocation(fixture.sql, allocation),
    );
    const duplicate = requireWorkspaceAllocation(
      reserveWorkspaceExecutorOrganisationAllocation(fixture.sql, allocation),
    );
    const competing = reserveWorkspaceExecutorOrganisationAllocation(
      fixture.sql,
      {
        ...allocation,
        allocationId: "wxa-competing",
        idempotencyKey: "workspace-competing",
      },
    );

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      kind: "reserved",
      profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
      reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    });
    expect(competing).toEqual({
      ok: false,
      error: { code: "code_mode_workspace_allocation_limit_exceeded" },
    });

    const settledInput = {
      requestId: allocation.requestId,
      organisationId: allocation.organisationId,
      parent: allocation.parent,
      allocationId: allocation.allocationId,
      receiptId: "receipt-workspace-allocation",
      receiptDigest: "b".repeat(64),
      actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
      inputBytes: 500,
      outputBytes: 700,
      durationMs: 800,
      outcome: "succeeded" as const,
      now: 900,
    };
    const settled = requireWorkspaceAllocation(
      settleWorkspaceExecutorOrganisationAllocation(fixture.sql, settledInput),
    );
    const settledDuplicate = requireWorkspaceAllocation(
      settleWorkspaceExecutorOrganisationAllocation(fixture.sql, settledInput),
    );

    expect(settled).toEqual(settledDuplicate);
    expect(settled).toMatchObject({
      kind: "settled",
      actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
      inputBytes: 500,
      outputBytes: 700,
      durationMs: 800,
    });
  });

  it("reserves attachment preparation without a Code Mode root and replays its settlement", function attachmentPreparationAllocation() {
    const fixture = budgetFixture();
    const allocation = preparationAllocationInput(100);
    const first = requireWorkspaceAllocation(
      reserveWorkspaceExecutorOrganisationAllocation(fixture.sql, allocation),
    );
    const duplicate = requireWorkspaceAllocation(
      reserveWorkspaceExecutorOrganisationAllocation(fixture.sql, allocation),
    );

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      kind: "reserved",
      parent: {
        kind: "attachment_preparation",
        preparationId: "prep-turn-code-budget-attachment-1",
        sessionId: "session-code-budget-preparation",
        turnId: "turn-code-budget",
      },
    });
    expect(reservationCount(fixture.database)).toBe(0);

    const settledInput = {
      requestId: allocation.requestId,
      organisationId: allocation.organisationId,
      parent: allocation.parent,
      allocationId: allocation.allocationId,
      receiptId: "receipt-preparation-allocation",
      receiptDigest: "b".repeat(64),
      actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
      inputBytes: 500,
      outputBytes: 700,
      durationMs: 800,
      outcome: "succeeded" as const,
      now: 900,
    };
    const settled = requireWorkspaceAllocation(
      settleWorkspaceExecutorOrganisationAllocation(fixture.sql, settledInput),
    );
    const settledReplay = requireWorkspaceAllocation(
      reserveWorkspaceExecutorOrganisationAllocation(fixture.sql, allocation),
    );

    expect(settled).toMatchObject({ kind: "settled", actualCostMicros: 250 });
    expect(settledReplay).toEqual(settled);

    const firstRoot = reserveCodeModeOrganisationBudget(
      fixture.sql,
      reserveInput(1_000),
    );
    const secondRoot = reserveCodeModeOrganisationBudget(fixture.sql, {
      ...reserveInput(1_100),
      requestId: requireParsed(parseRequestId("req-code-budget-second-root")),
      sessionId: requireParsed(
        parseSessionId("session-code-budget-second-root"),
      ),
      turnId: "turn-code-budget-second-root",
      executionId: "cmx-second-root",
      idempotencyKey: "code-second-root",
      leaseId: "lease-second-root",
    });

    expect(firstRoot.ok).toBe(true);
    expect(secondRoot.ok).toBe(true);
  });

  it("fences and expires nested workspace allocations", function workspaceAllocationFences() {
    const fixture = budgetFixture();
    const root = {
      ...reserveInput(100),
      priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
      reservedCostMicros:
        CODE_MODE_ENGINE_RESERVED_COST_MICROS +
        WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    };
    requireReservation(reserveCodeModeOrganisationBudget(fixture.sql, root));
    const allocation = workspaceAllocationInput(root, 120);
    requireWorkspaceAllocation(
      reserveWorkspaceExecutorOrganisationAllocation(fixture.sql, allocation),
    );
    const stale = cancelWorkspaceExecutorOrganisationAllocation(fixture.sql, {
      requestId: allocation.requestId,
      organisationId: allocation.organisationId,
      parent: {
        ...allocation.parent,
        leaseId: "lease-stale",
      },
      allocationId: allocation.allocationId,
      reason: "turn_cancelled",
      now: 130,
    });

    expect(stale).toEqual({
      ok: false,
      error: { code: "code_mode_reservation_lease_conflict" },
    });

    expireCodeModeOrganisationReservations(
      fixture.sql,
      allocation.leaseExpiresAt,
    );
    expect(
      workspaceAllocationState(fixture.database, allocation.allocationId),
    ).toBe("expired");
  });
});

function budgetFixture() {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createCodeModeBudgetSchema({
    sql,
    transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
  });
  return { ...fixture, sql };
}

function reserveInput(now: number): CodeModeOrganisationReserveInput {
  return {
    requestId: requireParsed(parseRequestId("req-code-budget")),
    organisationId: requireParsed(
      parseOrganisationId("organisation-code-budget"),
    ),
    sessionId: requireParsed(parseSessionId("session-code-budget")),
    turnId: "turn-code-budget",
    runtimeGeneration: 1,
    executionId: "cmx-primary",
    idempotencyKey: "code-primary",
    leaseId: "lease-primary",
    executionDeadlineAt: now + 30_000,
    leaseExpiresAt: now + 35_000,
    admissionDigest: DIGEST,
    programDigest: DIGEST,
    requirementsDigest: DIGEST,
    policyDigest: DIGEST,
    catalogDigest: DIGEST,
    routerRevision: "router-v1",
    runtimeRevision: "runtime-v1",
    priceBookRevision: "price-book-v1",
    placement: {
      kind: "cloudflare_sandbox_worker",
      adapterRevision: "adapter-v1",
      packageVersion: "1",
      reason: "generated_javascript_remote_execution",
      evidenceDigest: DIGEST,
    },
    budget: {
      maxDurationMs: 30_000,
      maxCapabilityCalls: 8,
      maxConcurrentCalls: 2,
      maxSourceBytes: 65_536,
      maxOutputBytes: 24_576,
    },
    reservedCostMicros: 1_000,
    customerDisposition: "included_interactive",
    now,
  };
}

function workspaceAllocationInput(
  parent: CodeModeOrganisationReserveInput,
  now: number,
) {
  return {
    requestId: parent.requestId,
    organisationId: parent.organisationId,
    parent: {
      kind: "code_mode_execution" as const,
      executionId: parent.executionId,
      leaseId: parent.leaseId,
    },
    allocationId: "wxa-primary",
    idempotencyKey: "workspace-primary",
    allocationDigest: DIGEST,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt: now + 20_000,
    leaseExpiresAt: now + 25_000,
    now,
  } as const;
}

function preparationAllocationInput(now: number) {
  return {
    requestId: requireParsed(parseRequestId("req-code-budget-preparation")),
    organisationId: requireParsed(
      parseOrganisationId("organisation-code-budget"),
    ),
    parent: {
      kind: "attachment_preparation" as const,
      preparationId: "prep-turn-code-budget-attachment-1",
      leaseId: "harness-lease-code-budget",
      sessionId: requireParsed(
        parseSessionId("session-code-budget-preparation"),
      ),
      turnId: "turn-code-budget",
      runtimeGeneration: 1,
    },
    allocationId: "wxa-prep-turn-code-budget-attachment-1",
    idempotencyKey: "workspace-prep-turn-code-budget-attachment-1",
    allocationDigest: DIGEST,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt: now + 20_000,
    leaseExpiresAt: now + 25_000,
    now,
  } as const;
}

function requireWorkspaceAllocation<T>(
  result:
    | {
        readonly ok: true;
        readonly value: T;
      }
    | {
        readonly ok: false;
        readonly error: unknown;
      },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function workspaceAllocationState(
  database: import("node:sqlite").DatabaseSync,
  allocationId: string,
): string | null {
  const row = database
    .prepare(
      "SELECT state FROM code_execution_nested_allocation WHERE allocation_id = ?",
    )
    .get(allocationId) as { state: string } | undefined;
  return row?.state ?? null;
}

function requireParsed<T, E>(
  result:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: E;
      },
): T {
  if (!result.ok) throw new Error("invalid_test_identity");
  return result.value;
}

function requireReservation(
  result:
    | {
        readonly ok: true;
        readonly value: CodeModeOrganisationReservation;
      }
    | {
        readonly ok: false;
        readonly error: unknown;
      },
): CodeModeOrganisationReservation {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function requireCounter(
  result:
    | {
        readonly ok: true;
        readonly value: import("../src/actors/code-mode-budget").CodeModeCapabilityCounter;
      }
    | {
        readonly ok: false;
        readonly error: unknown;
      },
) {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function reservationState(
  database: import("node:sqlite").DatabaseSync,
  executionId: string,
): string | null {
  const row = database
    .prepare(
      "SELECT state FROM code_execution_reservation WHERE execution_id = ?",
    )
    .get(executionId) as { state: string } | undefined;
  return row?.state ?? null;
}

function reservationCount(
  database: import("node:sqlite").DatabaseSync,
): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM code_execution_reservation")
    .get() as { count: number };
  return row.count;
}

function receiptCount(database: import("node:sqlite").DatabaseSync): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM code_execution_receipt")
    .get() as { count: number };
  return row.count;
}
