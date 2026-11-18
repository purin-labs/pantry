/// <reference types="@cloudflare/workers-types" />

import type { UnitTestEnv } from "./worker-fakes";
import type {
  CodeModeExecutionReceipt,
  HarnessTurnLease,
} from "@seams/contracts";
import { describe, expect, test } from "vitest";

import {
  reconcileCodeModeSettlements,
  recordCodeModeWorkspaceCommit,
  type CodeModeSettlementStorage,
} from "../src/actors/agent-session-code-mode-settlement";
import { createSessionHarnessAuthoritySchema } from "../src/actors/agent-session-harness-authority";
import { createActorJournalSchema } from "../src/actors/agent-session-schema";
import { type CodeModeOrganisationSettleInput } from "../src/actors/code-mode-budget";
import { parseRequestId, parseOrganisationId } from "../src/ids";
import { fixtureTurnAuthority } from "./fixtures/plan25-turn";
import {
  emptySqliteFixture,
  sqlStorage,
  type TestSqlStorage,
} from "./sqlite-storage";

describe("Code Mode workspace commit recovery", function codeModeWorkspaceCommitRecoverySuite() {
  test("persists the complete workspace-committed settlement before dispatch", async function persistsWorkspaceCommit() {
    const fixture = settlementFixture();
    const input = settlementInput(fixture.storage);

    await expect(recordCodeModeWorkspaceCommit(input)).resolves.toEqual({
      ok: true,
      value: { kind: "workspace_committed" },
    });

    const rawRow = fixture.database
      .prepare(
        `SELECT request_envelope, state_kind, state_projection
       FROM actor_outbox WHERE effect_id = ?`,
      )
      .get("execution-cmx-execution_1");
    const row = parseSettlementRow(rawRow);
    expect(row.state_kind).toBe("pending");
    expect(JSON.parse(row.request_envelope)).toEqual({
      kind: "code_mode_execution_settlement.v1",
      settle: input.settle,
      lease: input.lease,
      receipt: input.receipt,
    });
    expect(JSON.parse(row.state_projection)).toEqual({
      kind: "workspace_committed",
      receiptId: "receipt-cmx-execution_1",
      workspaceRevisionReceipt: input.receipt.workspaceRevisionReceipt,
    });
    expect(fixture.storage.alarm).toBeGreaterThan(Date.now());

    await expect(recordCodeModeWorkspaceCommit(input)).resolves.toEqual({
      ok: true,
      value: { kind: "workspace_committed" },
    });
  });

  test("rejects a conflicting receipt after the workspace commit is recorded", async function rejectsConflict() {
    const fixture = settlementFixture();
    const input = settlementInput(fixture.storage);
    await recordCodeModeWorkspaceCommit(input);

    await expect(
      recordCodeModeWorkspaceCommit(
        settlementInputWithRootOutputBytes(
          input,
          input.receipt.rootOutputBytes + 1,
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "code_mode_settlement_invalid" },
    });
  });

  test("fails closed when the recorded recovery projection is corrupt", async function rejectsCorruptProjection() {
    const fixture = settlementFixture();
    const input = settlementInput(fixture.storage);
    await recordCodeModeWorkspaceCommit(input);
    fixture.database
      .prepare(
        `UPDATE actor_outbox SET state_projection = ? WHERE effect_id = ?`,
      )
      .run(
        JSON.stringify({
          kind: "workspace_committed",
          receiptId: "receipt-other",
        }),
        "execution-cmx-execution_1",
      );

    await expect(recordCodeModeWorkspaceCommit(input)).resolves.toEqual({
      ok: false,
      error: { code: "code_mode_settlement_invalid" },
    });
  });

  test("terminalizes a rejected recovery without rearming its alarm", async function terminalizesRejectedRecovery() {
    const fixture = settlementFixture();
    const input = settlementInput(fixture.storage);
    await recordCodeModeWorkspaceCommit(input);
    fixture.storage.consumeAlarm();

    await reconcileCodeModeSettlements({
      env: {} as UnitTestEnv,
      storage: fixture.storage.binding(),
    });

    const row = parseSettlementRow(
      fixture.database
        .prepare(
          `SELECT request_envelope, state_kind, state_projection
           FROM actor_outbox WHERE effect_id = ?`,
        )
        .get("execution-cmx-execution_1"),
    );
    expect(row.state_kind).toBe("indeterminate");
    expect(JSON.parse(row.state_projection)).toEqual({
      kind: "indeterminate",
      reason: "code_mode_settlement_invalid",
    });
    expect(fixture.storage.alarm).toBeNull();
  });
});

function parseSettlementRow(raw: unknown): {
  readonly request_envelope: string;
  readonly state_kind: string;
  readonly state_projection: string;
} {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("request_envelope" in raw) ||
    !("state_kind" in raw) ||
    !("state_projection" in raw) ||
    typeof raw.request_envelope !== "string" ||
    typeof raw.state_kind !== "string" ||
    typeof raw.state_projection !== "string"
  ) {
    throw new Error("invalid settlement row fixture");
  }
  return {
    request_envelope: raw.request_envelope,
    state_kind: raw.state_kind,
    state_projection: raw.state_projection,
  };
}

function settlementInputWithRootOutputBytes(
  input: ReturnType<typeof settlementInput>,
  rootOutputBytes: number,
): ReturnType<typeof settlementInput> {
  return {
    storage: input.storage,
    settle: input.settle,
    lease: input.lease,
    receipt: {
      executionId: input.receipt.executionId,
      turn: input.receipt.turn,
      admissionDigest: input.receipt.admissionDigest,
      receiptDigest: input.receipt.receiptDigest,
      priceBookRevision: input.receipt.priceBookRevision,
      reservedCostMicros: input.receipt.reservedCostMicros,
      actualCostMicros: input.receipt.actualCostMicros,
      capabilityCalls: input.receipt.capabilityCalls,
      inputBytes: input.receipt.inputBytes,
      outputBytes: input.receipt.outputBytes,
      rootOutputBytes,
      workspaceExecutorUsage: input.receipt.workspaceExecutorUsage,
      outcome: input.receipt.outcome,
      workspaceRevisionReceipt: input.receipt.workspaceRevisionReceipt,
    },
  };
}

class SettlementStorageFixture implements CodeModeSettlementStorage {
  readonly sql: SqlStorage;
  alarm: number | null = null;

  constructor(
    private readonly database: import("node:sqlite").DatabaseSync,
    storage: TestSqlStorage,
  ) {
    this.sql = sqlStorage(storage);
  }

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm =
      scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  binding(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }

  consumeAlarm(): void {
    this.alarm = null;
  }
}

function settlementFixture(): {
  readonly database: import("node:sqlite").DatabaseSync;
  readonly storage: SettlementStorageFixture;
} {
  const fixture = emptySqliteFixture();
  createActorJournalSchema(sqlStorage(fixture.storage));
  createSessionHarnessAuthoritySchema(sqlStorage(fixture.storage));
  fixture.database
    .prepare(
      `INSERT INTO actor_outbox (
       effect_id, organisation_id, originating_event_id, request_envelope,
       state_kind, state_projection, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      "execution-cmx-execution_1",
      "organisation_1",
      "event_execution_1",
      JSON.stringify({
        kind: "code_mode_execution.v1",
        executionId: "cmx-execution_1",
        leaseId: "lease_execution_1",
        organisationId: "organisation_1",
      }),
      JSON.stringify({
        kind: "pending",
        capabilityCalls: 0,
        inputBytes: 0,
        outputBytes: 0,
      }),
      12,
    );
  return {
    database: fixture.database,
    storage: new SettlementStorageFixture(fixture.database, fixture.storage),
  };
}

function settlementInput(storage: CodeModeSettlementStorage): {
  readonly storage: CodeModeSettlementStorage;
  readonly settle: CodeModeOrganisationSettleInput;
  readonly lease: HarnessTurnLease;
  readonly receipt: CodeModeExecutionReceipt;
} {
  const requestId = parseRequestId("request_execution_settlement_1");
  const organisationId = parseOrganisationId("organisation_1");
  if (!requestId.ok || !organisationId.ok)
    throw new Error("invalid settlement fixture identity");
  const authority = fixtureTurnAuthority(
    organisationId.value,
    "connector_fixture",
  );
  const lease: HarnessTurnLease = {
    leaseId: "harness_lease_1",
    session: {
      organisationId: "organisation_1",
      sessionId: "session_1",
      streamId: "stream_1",
    },
    turn: {
      turnId: "turn_1",
      inputId: "input_1",
      turnLeaseGeneration: 1,
      budgetRevision: "budget_1",
    },
    runtimeLease: { generation: 1, leaseId: "runtime_lease_1" },
    runtimeRevision: "runtime_1",
    requestAuthority: authority.requestAuthority,
    authorityPartitionDigest: authority.authorityPartition.digest,
    issuedAt: 10,
    expiresAt: 10_000,
  };
  const receipt: CodeModeExecutionReceipt = {
    executionId: "cmx-execution_1",
    turn: lease.turn,
    admissionDigest: "a".repeat(64),
    receiptDigest: "b".repeat(64),
    priceBookRevision: "code-mode-price-book-v1",
    reservedCostMicros: 1_000,
    actualCostMicros: 800,
    capabilityCalls: 2,
    inputBytes: 128,
    outputBytes: 256,
    rootOutputBytes: 64,
    workspaceExecutorUsage: { kind: "unused" },
    outcome: "succeeded",
    workspaceRevisionReceipt: {
      receiptId: "workspace_receipt_1",
      outcome: "accepted",
      workspaceId: "workspace_1",
      revision: "workspace_revision_1",
      canonicalHead: "c".repeat(64),
      correlationId: "cmx-execution_1",
      causation: {
        kind: "effect_receipt",
        receiptId: "receipt-cmx-execution_1",
      },
    },
  };
  return {
    storage,
    settle: {
      requestId: requestId.value,
      organisationId: organisationId.value,
      executionId: receipt.executionId,
      leaseId: "lease_execution_1",
      receiptId: "receipt-cmx-execution_1",
      receiptDigest: receipt.receiptDigest,
      actualCostMicros: receipt.actualCostMicros,
      capabilityCalls: receipt.capabilityCalls,
      inputBytes: receipt.inputBytes,
      outputBytes: receipt.outputBytes,
      outcome: receipt.outcome,
      now: 20,
    },
    lease,
    receipt,
  };
}
