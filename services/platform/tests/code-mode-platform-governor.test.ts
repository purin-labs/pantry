/// <reference types="@cloudflare/workers-types" />

import type { UnitTestEnv } from "./worker-fakes";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  CodeModePlatformGovernorActor,
  type CodeModePlatformReservation,
} from "../src/actors/code-mode-platform-governor";
import {
  CODE_MODE_ENGINE_RESERVED_COST_MICROS,
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  type CodeModeOrganisationReserveInput,
  type WorkspaceExecutorAllocationReservation,
  type WorkspaceExecutorAllocationReserveInput,
} from "../src/actors/code-mode-budget";
import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const DIGEST = "a".repeat(64);

describe("CodeModePlatformGovernorActor", function codeModePlatformGovernorSuite() {
  it("reserves global capacity idempotently and rejects changed admission", async function reserves() {
    const fixture = governorFixture();
    const input = reserveInput(100);
    const first = requireReservation(await fixture.governor.reserve(input));
    const duplicate = requireReservation(await fixture.governor.reserve(input));
    const changed = await fixture.governor.reserve({
      ...input,
      admissionDigest: "b".repeat(64),
    });

    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ kind: "reserved", leaseExpiresAt: 35_100 });
    expect(changed).toEqual({
      ok: false,
      error: { code: "code_mode_reservation_conflict" },
    });
    expect(fixture.storage.nextAlarm()).toBe(35_100);
  });

  it("settles and reconciles the same receipt", async function settles() {
    const fixture = governorFixture();
    const input = reserveInput(100);
    requireReservation(await fixture.governor.reserve(input));
    const settled = requireReservation(
      await fixture.governor.settle({
        requestId: input.requestId,
        organisationId: input.organisationId,
        executionId: input.executionId,
        leaseId: input.leaseId,
        receiptId: "receipt-platform",
        receiptDigest: "b".repeat(64),
        actualCostMicros: 700,
        capabilityCalls: 0,
        inputBytes: 0,
        outputBytes: 0,
        outcome: "succeeded",
        now: 200,
      }),
    );
    const reconciled = requireReservation(
      await fixture.governor.reconcile({
        requestId: input.requestId,
        organisationId: input.organisationId,
        executionId: input.executionId,
        receiptId: "receipt-platform",
        providerCostMicros: 680,
        now: 300,
      }),
    );

    expect(settled).toMatchObject({ kind: "settled", actualCostMicros: 700 });
    expect(reconciled).toMatchObject({
      kind: "reconciled",
      actualCostMicros: 700,
      providerCostMicros: 680,
    });
    expect(fixture.storage.nextAlarm()).toBeNull();
  });

  it("expires abandoned global reservations through its alarm", async function expires() {
    const fixture = governorFixture();
    const input = reserveInput(100);
    requireReservation(await fixture.governor.reserve(input));

    await fixture.fireAlarm(35_100);

    expect(platformState(fixture.database, input.executionId)).toBe("expired");
    expect(fixture.storage.nextAlarm()).toBeNull();
  });
  it(
    "reserves and settles a fixed workspace allocation",
    reservesWorkspaceAllocation,
  );
  it(
    "reserves attachment preparation without a Code Mode root",
    reservesAttachmentPreparation,
  );
  it(
    "enforces the physical workspace Container ceiling",
    enforcesWorkspaceCeiling,
  );
  it("freezes root and workspace admission atomically", freezesAdmission);
  it(
    "reports cutover blockers until reservations expire",
    reportsCutoverBlockers,
  );
  it(
    "blocks quiescence on unreconciled settlements",
    blocksUnreconciledSettlement,
  );
  it("reopens admission explicitly", reopensAdmission);
});

async function reservesWorkspaceAllocation(): Promise<void> {
  const fixture = governorFixture();
  const root = workspaceRootInput(100, 0);
  requireReservation(await fixture.governor.reserve(root));
  const input = workspaceAllocationInput(root, 120, 0);
  const first = requireWorkspaceReservation(
    await fixture.governor.reserveWorkspaceAllocation(input),
  );
  const duplicate = requireWorkspaceReservation(
    await fixture.governor.reserveWorkspaceAllocation(input),
  );

  expect(first).toEqual(duplicate);
  expect(first).toMatchObject({
    kind: "reserved",
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  });

  const settledInput = {
    requestId: input.requestId,
    organisationId: input.organisationId,
    parent: input.parent,
    allocationId: input.allocationId,
    receiptId: "receipt-platform-workspace",
    receiptDigest: "b".repeat(64),
    actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    inputBytes: 500,
    outputBytes: 700,
    durationMs: 800,
    outcome: "succeeded" as const,
    now: 900,
  };
  const settled = requireWorkspaceReservation(
    await fixture.governor.settleWorkspaceAllocation(settledInput),
  );
  const settledDuplicate = requireWorkspaceReservation(
    await fixture.governor.settleWorkspaceAllocation(settledInput),
  );

  expect(settled).toEqual(settledDuplicate);
  expect(settled).toMatchObject({ kind: "settled", actualCostMicros: 250 });
  expect(fixture.storage.nextAlarm()).toBe(35_100);
}

async function reservesAttachmentPreparation(): Promise<void> {
  const fixture = governorFixture();
  const input = preparationAllocationInput(100);
  const first = requireWorkspaceReservation(
    await fixture.governor.reserveWorkspaceAllocation(input),
  );
  const duplicate = requireWorkspaceReservation(
    await fixture.governor.reserveWorkspaceAllocation(input),
  );

  expect(first).toEqual(duplicate);
  expect(first).toMatchObject({
    kind: "reserved",
    parent: {
      kind: "attachment_preparation",
      preparationId: "prep-platform-turn-attachment-1",
      sessionId: "session-platform-preparation",
      turnId: "turn-platform-preparation",
    },
  });
  expect(platformState(fixture.database, "cmx-platform")).toBeNull();

  const settledInput = {
    requestId: input.requestId,
    organisationId: input.organisationId,
    parent: input.parent,
    allocationId: input.allocationId,
    receiptId: "receipt-platform-preparation",
    receiptDigest: "b".repeat(64),
    actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    inputBytes: 500,
    outputBytes: 700,
    durationMs: 800,
    outcome: "succeeded" as const,
    now: 900,
  };
  const settled = requireWorkspaceReservation(
    await fixture.governor.settleWorkspaceAllocation(settledInput),
  );
  const settledReplay = requireWorkspaceReservation(
    await fixture.governor.reserveWorkspaceAllocation(input),
  );

  expect(settled).toMatchObject({ kind: "settled", actualCostMicros: 250 });
  expect(settledReplay).toEqual(settled);
}

async function enforcesWorkspaceCeiling(): Promise<void> {
  const fixture = governorFixture();
  for (let index = 0; index < 4; index += 1) {
    const root = workspaceRootInput(100, index);
    requireReservation(await fixture.governor.reserve(root));
    requireWorkspaceReservation(
      await fixture.governor.reserveWorkspaceAllocation(
        workspaceAllocationInput(root, 120, index),
      ),
    );
  }
  const fifthRoot = workspaceRootInput(100, 4);
  requireReservation(await fixture.governor.reserve(fifthRoot));
  const fifth = await fixture.governor.reserveWorkspaceAllocation(
    workspaceAllocationInput(fifthRoot, 120, 4),
  );

  expect(fifth).toEqual({
    ok: false,
    error: { code: "code_mode_workspace_platform_concurrency_exceeded" },
  });
}

async function freezesAdmission(): Promise<void> {
  const fixture = governorFixture();
  const root = workspaceRootInput(100, 0);
  requireReservation(await fixture.governor.reserve(root));
  const input = controlInput("freeze_admission", 200, "freeze-1");
  const first = await fixture.governor.controlAdmission(input);
  const duplicate = await fixture.governor.controlAdmission({
    ...input,
    requestId: requireParsed(parseRequestId("req-freeze-retry")),
    now: 250,
  });
  const conflict = await fixture.governor.controlAdmission({
    ...input,
    reason: "changed",
  });

  expect(first).toEqual(duplicate);
  expect(first).toMatchObject({
    ok: true,
    value: { state: "frozen", generation: 2 },
  });
  expect(conflict).toEqual({
    ok: false,
    error: { code: "code_mode_platform_operator_conflict" },
  });

  const rootDenied = await fixture.governor.reserve(workspaceRootInput(210, 1));
  expect(rootDenied).toEqual({
    ok: false,
    error: { code: "code_mode_platform_disabled" },
  });

  const workspaceDenied = await fixture.governor.reserveWorkspaceAllocation(
    workspaceAllocationInput(root, 120, 0),
  );
  expect(workspaceDenied).toEqual({
    ok: false,
    error: { code: "code_mode_platform_disabled" },
  });
}

async function reportsCutoverBlockers(): Promise<void> {
  const fixture = governorFixture();
  const open = await fixture.governor.inspectCutoverQuiescence({ now: 50 });
  expect(open).toMatchObject({
    ok: true,
    value: { kind: "blocked", blockers: [{ kind: "admission_open" }] },
  });

  const root = workspaceRootInput(100, 0);
  requireReservation(await fixture.governor.reserve(root));
  requireWorkspaceReservation(
    await fixture.governor.reserveWorkspaceAllocation(
      workspaceAllocationInput(root, 120, 0),
    ),
  );
  await fixture.governor.controlAdmission(
    controlInput("freeze_admission", 200, "freeze-2"),
  );
  const blocked = await fixture.governor.inspectCutoverQuiescence({ now: 200 });
  expect(blocked).toMatchObject({
    ok: true,
    value: {
      kind: "blocked",
      blockers: [
        { kind: "live_root_reservations", count: 1 },
        { kind: "live_workspace_allocations", count: 1 },
        { kind: "scheduled_alarm", scheduledAt: 35_100 },
      ],
    },
  });

  await fixture.fireAlarm(35_100);
  const quiescent = await fixture.governor.inspectCutoverQuiescence({
    now: 35_100,
  });
  expect(quiescent).toMatchObject({
    ok: true,
    value: { kind: "quiescent", blockers: [] },
  });
}

async function blocksUnreconciledSettlement(): Promise<void> {
  const fixture = governorFixture();
  const input = reserveInput(100);
  requireReservation(await fixture.governor.reserve(input));
  requireReservation(
    await fixture.governor.settle({
      requestId: input.requestId,
      organisationId: input.organisationId,
      executionId: input.executionId,
      leaseId: input.leaseId,
      receiptId: "receipt-unreconciled-cutover",
      receiptDigest: "b".repeat(64),
      actualCostMicros: 700,
      capabilityCalls: 0,
      inputBytes: 0,
      outputBytes: 0,
      outcome: "succeeded",
      now: 200,
    }),
  );
  await fixture.governor.controlAdmission(
    controlInput("freeze_admission", 300, "freeze-unreconciled"),
  );
  await fixture.storage.deleteAlarm();

  const inspected = await fixture.governor.inspectCutoverQuiescence({
    now: 400,
  });

  expect(inspected).toMatchObject({
    ok: true,
    value: {
      kind: "blocked",
      settledUnreconciled: 1,
      blockers: [{ kind: "settled_unreconciled", count: 1 }],
    },
  });
}

async function reopensAdmission(): Promise<void> {
  const fixture = governorFixture();
  await fixture.governor.controlAdmission(
    controlInput("freeze_admission", 100, "freeze-3"),
  );
  const opened = await fixture.governor.controlAdmission(
    controlInput("open_admission", 200, "open-1"),
  );
  const reserved = await fixture.governor.reserve(reserveInput(300));

  expect(opened).toMatchObject({
    ok: true,
    value: { state: "open", generation: 3 },
  });
  expect(reserved).toMatchObject({ ok: true, value: { kind: "reserved" } });
}

class GovernorStorage {
  private alarmAt: number | null = null;

  constructor(
    readonly sql: SqlStorage,
    private readonly database: DatabaseSync,
  ) {}

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async setAlarm(value: number | Date): Promise<void> {
    this.alarmAt = value instanceof Date ? value.getTime() : value;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  nextAlarm(): number | null {
    return this.alarmAt;
  }
}

function controlInput(
  command: "freeze_admission" | "open_admission",
  now: number,
  idempotencyKey: string,
) {
  return {
    command,
    requestId: requireParsed(parseRequestId(`req-${idempotencyKey}`)),
    idempotencyKey,
    requestedBy: "plan-13-c5",
    reason: "plan-13-cutover",
    now,
  };
}

function governorFixture() {
  const fixture = emptySqliteFixture();
  const storage = new GovernorStorage(
    sqlStorage(fixture.storage),
    fixture.database,
  );
  const actor = new CodeModePlatformGovernorActor(
    { storage } as unknown as DurableObjectState,
    {} as UnitTestEnv,
  );
  async function fireAlarm(now: number): Promise<void> {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await actor.alarm();
    } finally {
      dateNow.mockRestore();
    }
  }
  return { governor: actor, storage, database: fixture.database, fireAlarm };
}

function reserveInput(now: number): CodeModeOrganisationReserveInput {
  return {
    requestId: requireParsed(parseRequestId("req-platform-code")),
    organisationId: requireParsed(
      parseOrganisationId("organisation-platform-code"),
    ),
    sessionId: requireParsed(parseSessionId("session-platform-code")),
    turnId: "turn-platform-code",
    runtimeGeneration: 1,
    executionId: "cmx-platform",
    idempotencyKey: "code-platform",
    leaseId: "lease-platform",
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

function workspaceRootInput(
  now: number,
  index: number,
): CodeModeOrganisationReserveInput {
  const base = reserveInput(now);
  return {
    ...base,
    requestId: requireParsed(parseRequestId(`req-platform-code-${index}`)),
    organisationId: requireParsed(
      parseOrganisationId(`organisation-platform-code-${index}`),
    ),
    sessionId: requireParsed(parseSessionId(`session-platform-code-${index}`)),
    turnId: `turn-platform-code-${index}`,
    executionId: `cmx-platform-${index}`,
    idempotencyKey: `code-platform-${index}`,
    leaseId: `lease-platform-${index}`,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    reservedCostMicros:
      CODE_MODE_ENGINE_RESERVED_COST_MICROS +
      WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  };
}

function workspaceAllocationInput(
  root: CodeModeOrganisationReserveInput,
  now: number,
  index: number,
): WorkspaceExecutorAllocationReserveInput {
  return {
    requestId: root.requestId,
    organisationId: root.organisationId,
    parent: {
      kind: "code_mode_execution" as const,
      executionId: root.executionId,
      leaseId: root.leaseId,
    },
    allocationId: `wxa-platform-${index}`,
    idempotencyKey: `workspace-platform-${index}`,
    allocationDigest: DIGEST,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt: root.executionDeadlineAt,
    leaseExpiresAt: root.leaseExpiresAt,
    now,
  };
}

function preparationAllocationInput(
  now: number,
): WorkspaceExecutorAllocationReserveInput {
  return {
    requestId: requireParsed(parseRequestId("req-platform-preparation")),
    organisationId: requireParsed(
      parseOrganisationId("organisation-platform-preparation"),
    ),
    parent: {
      kind: "attachment_preparation",
      preparationId: "prep-platform-turn-attachment-1",
      leaseId: "harness-platform-preparation",
      sessionId: requireParsed(parseSessionId("session-platform-preparation")),
      turnId: "turn-platform-preparation",
      runtimeGeneration: 1,
    },
    allocationId: "wxa-prep-platform-turn-attachment-1",
    idempotencyKey: "workspace-prep-platform-turn-attachment-1",
    allocationDigest: DIGEST,
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt: now + 20_000,
    leaseExpiresAt: now + 25_000,
    now,
  };
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
        readonly value: CodeModePlatformReservation;
      }
    | {
        readonly ok: false;
        readonly error: unknown;
      },
): CodeModePlatformReservation {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function requireWorkspaceReservation(
  result:
    | {
        readonly ok: true;
        readonly value: WorkspaceExecutorAllocationReservation;
      }
    | {
        readonly ok: false;
        readonly error: unknown;
      },
): WorkspaceExecutorAllocationReservation {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function platformState(
  database: DatabaseSync,
  executionId: string,
): string | null {
  const row = database
    .prepare(
      "SELECT state FROM code_mode_platform_reservation WHERE execution_id = ?",
    )
    .get(executionId) as { state: string } | undefined;
  return row?.state ?? null;
}
