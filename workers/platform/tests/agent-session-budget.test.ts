/// <reference types="@cloudflare/workers-types" />

import { describe, expect, test } from "vitest";

import {
  acceptRunModelUsage,
  claimRunCapability,
  createSessionBudgetAccount,
  markRunBudgetIndeterminate,
  readSessionBudgetAccount,
  reconcileRunBudget,
  reconcileExpiredRunBudget,
  reserveRunBudget,
  RUN_TIME_STOP_GRACE_MS,
  sessionBudgetAccountDigest,
  settleControlledRunCancellation,
  settleRunBudget,
  validateCheckpointBudgetGap,
  type ReserveRunBudgetInput,
} from "@purin-labs/agent/actors/agent-session-budget";
import { createSessionSchema } from "@purin-labs/agent/actors/agent-session-schema";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("AgentSession cumulative budget", function budgetSuite() {
  test("creates an account, reserves one run, accepts inclusive usage, and settles", function acceptsUsage() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    expect(
      createSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        operationId: "init_1",
        budget,
        now: 1,
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "open", usage: { tokens: 0 } },
    });
    const reserve = reserveRunBudget(sql, runInput("reserve_1"));
    expect(reserve).toMatchObject({
      ok: true,
      value: { reservationId: runInput("reserve_1").reservationId },
    });
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "open", reservation: { kind: "active" } },
    });
    expect(reserveRunBudget(sql, runInput("reserve_1"))).toMatchObject({
      ok: true,
      value: { reservationId: runInput("reserve_1").reservationId },
    });
    expect(
      acceptRunModelUsage(sql, {
        ...runInput("usage_1"),
        operationId: "usage_1",
        usage: { tokens: 10, activeWallMs: 10, capabilityCalls: 0 },
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "open", usage: { tokens: 10 } },
    });
    expect(
      acceptRunModelUsage(sql, {
        ...runInput("usage_1"),
        operationId: "usage_1",
        usage: { tokens: 10, activeWallMs: 10, capabilityCalls: 0 },
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "open", usage: { tokens: 10 } },
    });
    const settled = settleRunBudget(sql, {
      ...runInput("settle_1"),
      usage: { tokens: 10, activeWallMs: 10, capabilityCalls: 0 },
      outcome: "succeeded",
    });
    expect(settled).toMatchObject({
      ok: true,
      value: { kind: "open", reservation: { kind: "none" } },
    });
    expect(
      settleRunBudget(sql, {
        ...runInput("settle_1"),
        usage: { tokens: 10, activeWallMs: 10, capabilityCalls: 0 },
        outcome: "succeeded",
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "open", reservation: { kind: "none" } },
    });
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "open", reservation: { kind: "none" } },
    });
  });

  test("replays exact usage and conflicts on changed duplicate usage", function rejectsChangedUsageReplay() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));
    const usageInput = {
      ...runInput("usage_replay"),
      usage: { tokens: 3, activeWallMs: 1, capabilityCalls: 0 },
    };
    expect(acceptRunModelUsage(sql, usageInput)).toMatchObject({
      ok: true,
      value: {
        kind: "open",
        reservation: { kind: "active", acceptedUsage: usageInput.usage },
      },
    });
    expect(acceptRunModelUsage(sql, usageInput)).toMatchObject({
      ok: true,
      value: {
        kind: "open",
        reservation: { kind: "active", acceptedUsage: usageInput.usage },
      },
    });
    expect(
      acceptRunModelUsage(sql, {
        ...usageInput,
        usage: { tokens: 4, activeWallMs: 1, capabilityCalls: 0 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
  });

  test("replays settlement only for the same request", function rejectsDivergentSettlementReplay() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));
    const settlementInput = {
      ...runInput("settle_replay"),
      usage: { tokens: 3, activeWallMs: 1, capabilityCalls: 0 },
      outcome: "succeeded" as const,
    };
    const settled = settleRunBudget(sql, settlementInput);
    expect(settled).toMatchObject({
      ok: true,
      value: { reservation: { kind: "none" } },
    });
    expect(settleRunBudget(sql, { ...settlementInput, now: 100 })).toEqual(
      settled,
    );
    expect(
      settleRunBudget(sql, {
        ...settlementInput,
        now: 100,
        runtimeGeneration: 2,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      settleRunBudget(sql, {
        ...settlementInput,
        now: 100,
        turnLeaseGeneration: 2,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      settleRunBudget(sql, {
        ...settlementInput,
        now: 100,
        budgetRevision: "budget_2",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      settleRunBudget(sql, {
        ...settlementInput,
        now: 100,
        usage: { tokens: 4, activeWallMs: 1, capabilityCalls: 0 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      settleRunBudget(sql, { ...settlementInput, now: 100, outcome: "failed" }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
  });

  test("conflicts when capability or usage replay changes lease or budget revision", function rejectsChangedReplayIdentity() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));

    const claimInput = { ...runInput("claim_replay"), claimId: "claim_1" };
    expect(claimRunCapability(sql, claimInput)).toMatchObject({
      ok: true,
      value: { kind: "accepted" },
    });
    expect(claimRunCapability(sql, claimInput)).toMatchObject({
      ok: true,
      value: { kind: "duplicate" },
    });
    expect(
      claimRunCapability(sql, { ...claimInput, runtimeGeneration: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      claimRunCapability(sql, { ...claimInput, turnLeaseGeneration: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      claimRunCapability(sql, { ...claimInput, budgetRevision: "budget_2" }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });

    const usageInput = {
      ...runInput("usage_replay_identity"),
      usage: { tokens: 3, activeWallMs: 1, capabilityCalls: 1 },
    };
    expect(acceptRunModelUsage(sql, usageInput)).toMatchObject({ ok: true });
    expect(acceptRunModelUsage(sql, usageInput)).toMatchObject({ ok: true });
    expect(
      acceptRunModelUsage(sql, { ...usageInput, runtimeGeneration: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      acceptRunModelUsage(sql, { ...usageInput, turnLeaseGeneration: 2 }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      acceptRunModelUsage(sql, { ...usageInput, budgetRevision: "budget_2" }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
  });

  test("rejects divergent duplicate operation identities and event kinds", function rejectsDivergence() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    const reservation = reserveRunBudget(sql, runInput("shared_operation"));
    expect(reservation).toMatchObject({ ok: true });
    expect(
      reserveRunBudget(sql, {
        ...runInput("shared_operation"),
        organisationId: "organisation_other",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      claimRunCapability(sql, {
        ...runInput("shared_operation"),
        claimId: "claim_1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });

    expect(
      acceptRunModelUsage(sql, {
        ...runInput("usage_divergence"),
        runId: "run_other",
        operationId: "shared_operation",
        usage: { tokens: 1, activeWallMs: 1, capabilityCalls: 0 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });

    expect(
      acceptRunModelUsage(sql, {
        ...runInput("usage_1"),
        usage: { tokens: 1, activeWallMs: 1, capabilityCalls: 0 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      settleRunBudget(sql, {
        ...runInput("usage_1"),
        operationId: "shared_operation",
        usage: { tokens: 1, activeWallMs: 1, capabilityCalls: 0 },
        outcome: "succeeded",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });

    expect(
      settleRunBudget(sql, {
        ...runInput("settle_divergence"),
        reservationId: "reservation_other",
        usage: { tokens: 1, activeWallMs: 1, capabilityCalls: 0 },
        outcome: "succeeded",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_reservation_lease_conflict" },
    });
  });

  test("replays a capability claim and rejects the next claim before an effect", function rejectsOverrun() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 1,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));
    const claimInput = { ...runInput("claim_1"), claimId: "claim_1" };
    expect(claimRunCapability(sql, claimInput)).toMatchObject({
      ok: true,
      value: { kind: "accepted", usage: { capabilityCalls: 1 } },
    });
    expect(claimRunCapability(sql, claimInput)).toMatchObject({
      ok: true,
      value: { kind: "duplicate", usage: { capabilityCalls: 1 } },
    });
    const second = claimRunCapability(sql, {
      ...runInput("claim_2"),
      claimId: "claim_2",
    });
    expect(second).toMatchObject({
      ok: false,
      error: {
        code: "budget_exhausted",
        exhaustion: { dimension: "capability_calls" },
      },
    });
    expect(
      claimRunCapability(sql, { ...runInput("claim_2"), claimId: "claim_2" }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "budget_exhausted",
        exhaustion: { dimension: "capability_calls" },
      },
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM session_budget_reservation")
        .get()?.count,
    ).toBe(0);
  });

  test("expires a run a grace period after its persisted deadline and binds the account digest", async function expiresRun() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));
    expect(
      reconcileExpiredRunBudget(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        operationId: "expire_1",
        now: 109 + RUN_TIME_STOP_GRACE_MS,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_deadline_not_elapsed" },
    });
    const expired = reconcileExpiredRunBudget(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "expire_2",
      now: 110 + RUN_TIME_STOP_GRACE_MS,
    });
    expect(expired).toMatchObject({
      ok: false,
      error: {
        code: "budget_exhausted",
        exhaustion: { dimension: "active_wall_ms" },
      },
    });
    expect(
      reconcileExpiredRunBudget(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        operationId: "expire_2",
        now: 111 + RUN_TIME_STOP_GRACE_MS,
      }),
    ).toEqual(expired);
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: true,
      value: { kind: "exhausted", reservation: { kind: "none" } },
    });
    if (expired.ok) throw new Error("expected exhaustion");
    if (expired.error.code !== "budget_exhausted")
      throw new Error(expired.error.code);
    const digest = await sessionBudgetAccountDigest({
      kind: "exhausted",
      budget,
      usage: { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
      usageCursor: 2,
      exhaustion: expired.error.exhaustion,
      reservation: { kind: "none" },
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      fixture.database
        .prepare("SELECT usage_cursor FROM session_budget_account")
        .get()?.usage_cursor,
    ).toBe(2);
  });

  test("preserves an effect claim across an indeterminate crash and reconciles it once", function reconcilesCrashAfterEffect() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));
    claimRunCapability(sql, { ...runInput("claim_1"), claimId: "effect_1" });
    expect(
      markRunBudgetIndeterminate(sql, {
        ...runInput("indeterminate_1"),
        reason: "provider_effect_indeterminate",
      }),
    ).toMatchObject({
      ok: true,
      value: { reservation: { kind: "indeterminate" } },
    });
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "open",
        reservation: {
          kind: "indeterminate",
          reason: "provider_effect_indeterminate",
        },
      },
    });
    expect(
      markRunBudgetIndeterminate(sql, {
        ...runInput("indeterminate_1"),
        reason: "model_receipt_missing",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      settleRunBudget(sql, {
        ...runInput("settle_blocked"),
        usage: { tokens: 0, activeWallMs: 10, capabilityCalls: 1 },
        outcome: "failed",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_reservation_indeterminate" },
    });
    const reconciliation = {
      ...runInput("reconcile_1"),
      usage: { tokens: 0, activeWallMs: 10, capabilityCalls: 1 },
      outcome: "succeeded" as const,
    };
    expect(reconcileRunBudget(sql, reconciliation)).toMatchObject({
      ok: true,
      value: { usage: { capabilityCalls: 1 }, reservation: { kind: "none" } },
    });
    const laterReconciliation = reconcileRunBudget(sql, {
      ...reconciliation,
      now: 111,
    });
    expect(laterReconciliation).toMatchObject({
      ok: true,
      value: { usage: { capabilityCalls: 1 }, reservation: { kind: "none" } },
    });
    expect(
      reconcileRunBudget(sql, {
        ...reconciliation,
        now: 111,
        runtimeGeneration: 2,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      reconcileRunBudget(sql, {
        ...reconciliation,
        now: 111,
        usage: { tokens: 1, activeWallMs: 10, capabilityCalls: 1 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      reconcileRunBudget(sql, {
        ...reconciliation,
        now: 111,
        outcome: "failed",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    expect(
      reconcileRunBudget(sql, {
        ...reconciliation,
        now: 111,
        budgetRevision: "budget_2",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    const next = reserveRunBudget(sql, {
      ...runInput("reserve_2"),
      runId: "run_2",
      turnId: "turn_2",
      reservationId: "reservation_session_1_run_2_2_2_budget_1",
      runtimeGeneration: 2,
      turnLeaseGeneration: 2,
      now: 20,
    });
    expect(next).toMatchObject({
      ok: true,
      value: { allowance: { capabilityCalls: 1 } },
    });
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({ ok: true, value: { usage: { capabilityCalls: 1 } } });
  });

  test("settles a controlled cancellation from active or indeterminate preparation", function settlesControlledCancellation() {
    for (const state of ["active", "indeterminate"] as const) {
      const fixture = emptySqliteFixture();
      const sql = sqlStorage(fixture.storage);
      createSessionSchema(sql);
      createSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        operationId: "init_1",
        budget: {
          budgetRevision: "budget_1",
          maxTokens: 10,
          maxWallMs: 100,
          maxToolCalls: 2,
        },
        now: 1,
      });
      reserveRunBudget(sql, runInput("reserve_1"));
      claimRunCapability(sql, {
        ...runInput("claim_1"),
        claimId: "attachment_preparation:message.attachment.inspect:prep_1",
      });
      if (state === "indeterminate") {
        markRunBudgetIndeterminate(sql, {
          ...runInput("indeterminate_1"),
          reason: "provider_effect_indeterminate",
        });
      }

      const cancelled = settleControlledRunCancellation(sql, {
        ...runInput("ignored"),
        now: 20,
      });

      expect(cancelled).toMatchObject({
        ok: true,
        value: {
          kind: "open",
          usage: { tokens: 0, capabilityCalls: 1 },
          reservation: { kind: "none" },
        },
      });
      expect(
        settleControlledRunCancellation(sql, {
          ...runInput("ignored_replay"),
          now: 21,
        }),
      ).toEqual(cancelled);
      expect(
        reserveRunBudget(sql, {
          ...runInput("reserve_2"),
          runId: "run_2",
          turnId: "turn_2",
          reservationId: "reservation_session_1_run_2_2_2_budget_1",
          runtimeGeneration: 2,
          turnLeaseGeneration: 2,
          now: 22,
        }),
      ).toMatchObject({
        ok: true,
        value: { allowance: { capabilityCalls: 1 } },
      });
    }
  });

  test("proves a checkpoint gap only from controlled preparation cancellation and zero-usage failures", function provesControlledCheckpointGap() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget: {
        budgetRevision: "budget_1",
        maxTokens: 10,
        maxWallMs: 100,
        maxToolCalls: 4,
      },
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));
    claimRunCapability(sql, {
      ...runInput("claim_1"),
      claimId: "attachment_preparation:message.attachment.inspect:prep_1",
    });
    settleControlledRunCancellation(sql, { ...runInput("cancel_1"), now: 20 });
    reserveRunBudget(sql, laterRunInput("reserve_2", 2, 21));
    settleRunBudget(sql, {
      ...laterRunInput("settle_2", 2, 22),
      usage: { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
      outcome: "failed",
    });
    const active = laterRunInput("reserve_3", 3, 23);
    reserveRunBudget(sql, active);
    const account = readSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
    });
    if (!account.ok) throw new Error(account.error.code);

    const input = {
      organisationId: "organisation_1",
      sessionId: "session_1",
      budgetRevision: "budget_1",
      checkpointUsage: { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
      checkpointUsageCursor: 0,
      account: account.value,
      activeRunId: active.runId,
      activeReservationId: active.reservationId,
    };
    expect(validateCheckpointBudgetGap(sql, input)).toEqual({
      ok: true,
      value: null,
    });

    fixture.database
      .prepare(
        "UPDATE session_budget_event SET payload = replace(payload, ?, ?) WHERE kind = 'RunCapabilityClaimed'",
      )
      .run(
        "attachment_preparation:message.attachment.inspect:prep_1",
        "effect_1",
      );
    expect(validateCheckpointBudgetGap(sql, input)).toEqual({
      ok: false,
      error: { code: "budget_reservation_lease_conflict" },
    });
  });

  test("rejects stale settlement and reconciliation lease generations", function rejectsStaleSettlementLease() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));

    expect(
      settleRunBudget(sql, {
        ...runInput("stale_settle"),
        runtimeGeneration: 2,
        usage: { tokens: 0, activeWallMs: 1, capabilityCalls: 0 },
        outcome: "succeeded",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_reservation_lease_conflict" },
    });
    expect(
      reconcileRunBudget(sql, {
        ...runInput("stale_reconcile"),
        turnLeaseGeneration: 2,
        usage: { tokens: 0, activeWallMs: 1, capabilityCalls: 0 },
        outcome: "succeeded",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_reservation_lease_conflict" },
    });
  });

  test("normalizes budget input and rejects invalid reservation fields", function normalizesBudgetInput() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    const budgetWithExtra = { ...budget, future: true };
    expect(
      createSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        operationId: "init_1",
        budget: budgetWithExtra,
        now: 1,
      }),
    ).toMatchObject({ ok: true, value: { budget } });
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({ ok: true, value: { budget } });
    reserveRunBudget(sql, runInput("reserve_1"));

    expect(
      reserveRunBudget(sql, {
        ...runInput("invalid_turn"),
        turnId: "",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_budget_input", field: "turnId" },
    });
    expect(
      markRunBudgetIndeterminate(sql, {
        ...runInput("invalid_reason"),
        reason: "future_reason" as never,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_budget_input", field: "reason" },
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM session_budget_event")
        .get()?.count,
    ).toBe(2);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM session_budget_reservation")
        .get()?.count,
    ).toBe(1);
  });

  test("fails closed when a persisted account or duplicate event is corrupt", function rejectsCorruption() {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionSchema(sql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(sql, runInput("reserve_1"));

    fixture.database
      .prepare(
        "UPDATE session_budget_event SET payload = ? WHERE operation_id = ?",
      )
      .run("[]", "reserve_1");
    expect(reserveRunBudget(sql, runInput("reserve_1"))).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });

    fixture.database
      .prepare("UPDATE session_budget_account SET usage_json = ?")
      .run("[]");
    expect(
      readSessionBudgetAccount(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });
  });

  test("rejects malformed budget and reservation branches", function rejectsMalformedBranches() {
    const budgetFixture = emptySqliteFixture();
    const budgetSql = sqlStorage(budgetFixture.storage);
    createSessionSchema(budgetSql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(budgetSql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    budgetFixture.database
      .prepare("UPDATE session_budget_account SET budget_json = ?")
      .run(JSON.stringify({ ...budget, future: true }));
    expect(
      readSessionBudgetAccount(budgetSql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });

    const reservationFixture = emptySqliteFixture();
    const reservationSql = sqlStorage(reservationFixture.storage);
    createSessionSchema(reservationSql);
    createSessionBudgetAccount(reservationSql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(reservationSql, runInput("reserve_1"));
    reservationFixture.database
      .prepare("UPDATE session_budget_account SET reservation_json = ?")
      .run(JSON.stringify({ kind: "none", future: true }));
    expect(
      readSessionBudgetAccount(reservationSql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });
  });

  test("rejects malformed exhaustion and event identity", function rejectsMalformedExhaustionAndIdentity() {
    const exhaustionFixture = emptySqliteFixture();
    const exhaustionSql = sqlStorage(exhaustionFixture.storage);
    createSessionSchema(exhaustionSql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 1,
    };
    createSessionBudgetAccount(exhaustionSql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(exhaustionSql, runInput("reserve_1"));
    claimRunCapability(exhaustionSql, {
      ...runInput("claim_1"),
      claimId: "claim_1",
    });
    claimRunCapability(exhaustionSql, {
      ...runInput("claim_2"),
      claimId: "claim_2",
    });
    exhaustionFixture.database
      .prepare("UPDATE session_budget_account SET exhaustion_json = ?")
      .run(
        JSON.stringify({
          exhaustionId: "exhaustion_1",
          dimension: "tokens",
          runId: "run_1",
          observedUsage: { tokens: 0, activeWallMs: 0, capabilityCalls: 1 },
          exhaustedAt: 10,
        }),
      );
    expect(
      readSessionBudgetAccount(exhaustionSql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });

    const eventFixture = emptySqliteFixture();
    const eventSql = sqlStorage(eventFixture.storage);
    createSessionSchema(eventSql);
    createSessionBudgetAccount(eventSql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget: { ...budget, maxToolCalls: 2 },
      now: 1,
    });
    reserveRunBudget(eventSql, runInput("reserve_1"));
    eventFixture.database
      .prepare(
        "UPDATE session_budget_event SET event_id = ? WHERE operation_id = ?",
      )
      .run("budget_event_session_1_corrupt", "reserve_1");
    expect(reserveRunBudget(eventSql, runInput("reserve_1"))).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });
    eventFixture.database
      .prepare(
        "UPDATE session_budget_event SET event_id = ? WHERE operation_id = ?",
      )
      .run("budget_event_session_1_reserve_1", "reserve_1");
    eventFixture.database
      .prepare(
        "UPDATE session_budget_event SET reservation_id = ? WHERE operation_id = ?",
      )
      .run("reservation_other", "reserve_1");
    expect(reserveRunBudget(eventSql, runInput("reserve_1"))).toMatchObject({
      ok: false,
      error: { code: "budget_operation_conflict" },
    });
    eventFixture.database
      .prepare(
        "UPDATE session_budget_event SET reservation_id = ?, payload = ? WHERE operation_id = ?",
      )
      .run(
        runInput("reserve_1").reservationId,
        JSON.stringify({
          kind: "RunBudgetReserved",
          reservation: {
            reservationId: runInput("reserve_1").reservationId,
            runId: "run_1",
            turnId: "turn_1",
            runtimeGeneration: 1,
            turnLeaseGeneration: 1,
            budgetRevision: "budget_1",
            allowance: { tokens: 10, activeWallMs: 100, capabilityCalls: 2 },
            acceptedAt: 10,
            deadlineAt: 111,
          },
        }),
        "reserve_1",
      );
    expect(reserveRunBudget(eventSql, runInput("reserve_1"))).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });
  });

  test("fails closed when event row identity diverges from its payload", function rejectsEventIdentityDivergence() {
    const claimFixture = emptySqliteFixture();
    const claimSql = sqlStorage(claimFixture.storage);
    createSessionSchema(claimSql);
    const budget = {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    };
    createSessionBudgetAccount(claimSql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(claimSql, runInput("reserve_1"));
    const claimInput = { ...runInput("claim_identity"), claimId: "claim_1" };
    expect(claimRunCapability(claimSql, claimInput)).toMatchObject({
      ok: true,
    });
    claimFixture.database
      .prepare(
        "UPDATE session_budget_event SET run_id = ? WHERE operation_id = ?",
      )
      .run("run_mutated", "claim_identity");
    expect(
      claimRunCapability(claimSql, { ...claimInput, runId: "run_mutated" }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });

    const settlementFixture = emptySqliteFixture();
    const settlementSql = sqlStorage(settlementFixture.storage);
    createSessionSchema(settlementSql);
    createSessionBudgetAccount(settlementSql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      operationId: "init_1",
      budget,
      now: 1,
    });
    reserveRunBudget(settlementSql, runInput("reserve_1"));
    const settlementInput = {
      ...runInput("settlement_identity"),
      usage: { tokens: 3, activeWallMs: 1, capabilityCalls: 0 },
      outcome: "succeeded" as const,
    };
    expect(settleRunBudget(settlementSql, settlementInput)).toMatchObject({
      ok: true,
    });
    settlementFixture.database
      .prepare(
        "UPDATE session_budget_event SET reservation_id = ? WHERE operation_id = ?",
      )
      .run("reservation_mutated", "settlement_identity");
    expect(
      settleRunBudget(settlementSql, {
        ...settlementInput,
        reservationId: "reservation_mutated",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "budget_persisted_state_invalid" },
    });
  });
});

function runInput(operationId: string): ReserveRunBudgetInput {
  return {
    organisationId: "organisation_1",
    sessionId: "session_1",
    operationId,
    now: 10,
    runId: "run_1",
    reservationId: "reservation_session_1_run_1_1_1_budget_1",
    runtimeGeneration: 1,
    turnLeaseGeneration: 1,
    budgetRevision: "budget_1",
    turnId: "turn_1",
  };
}

function laterRunInput(
  operationId: string,
  generation: number,
  now: number,
): ReserveRunBudgetInput {
  return {
    ...runInput(operationId),
    now,
    runId: `run_${generation}`,
    turnId: `turn_${generation}`,
    reservationId: `reservation_session_1_run_${generation}_${generation}_${generation}_budget_1`,
    runtimeGeneration: generation,
    turnLeaseGeneration: generation,
  };
}
