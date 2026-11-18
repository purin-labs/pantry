import {
  activateActor,
  createActorActivationSchema,
} from "../src/actors/actor-activation";
import type { ActorActivationRequest } from "../src/actors/actor-registry";
import { createActorExecutionBarrierSchema } from "../src/actors/actor-execution-quiescence";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "../src/actors/agent-session-schema";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { createMigratedDatabase } from "./sqlite-d1";
import {
  activateActorFixture,
  requireOrganisationBootstrap,
  requireOrganisationExecutionScope,
} from "./organisation-execution-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { connectRealAccountPlatform } from "./real-account-platform-fixture";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  issueControlSession,
  readActiveOrganisationMembershipRevision,
  upsertUser,
} from "../src/data/control-plane";
import { buildControlAuthority } from "../src/request-authority";
import { bindOperatorTurnAccess } from "../src/chat/turn-access";
import { requireSessionId } from "./test-ids";
/// <reference types="@cloudflare/workers-types" />

import type {
  HarnessTurnLease,
  RequestAuthority,
  WorkspaceRevisionReceipt,
} from "@seams/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const admissionMocks = vi.hoisted(createAdmissionMocks);

vi.mock("../src/actors/agent-session-harness-authority", harnessAuthorityMock);
vi.mock("../src/actors/actor-router", actorRouterMock);
vi.mock(
  "../src/actors/agent-session-code-mode-settlement",
  durableSettlementMock,
);
vi.mock("../src/actors/actor-journal", actorJournalMock);
vi.mock("../src/actors/agent-session-canonical", canonicalSessionMock);
vi.mock("../src/actor-wasm", actorWasmMock);
vi.mock("@cloudflare/containers", containerModuleMock);

import { createHarnessCodeModeAdmission } from "../src/actors/code-mode-admission";
import type { CodeModeOrganisationReserveInput } from "../src/actors/code-mode-budget";
import {
  admittedCodeModeExecutionRecord,
  encodeCodeModeExecutionRecord,
} from "../src/actors/code-mode-execution-record";
import type { OrganisationId } from "../src/ids";
import { platformEnv } from "./worker-fakes";

describe("Harness Code Mode admission saga", function codeModeAdmissionSuite() {
  beforeEach(resetAdmissionMocks);

  it("reserves platform then organisation and delegates durable settlement", async function settlesSaga() {
    const events: string[] = [];
    admissionMocks.platformReserve.mockImplementation(
      recordPlatformReserve.bind(null, events),
    );
    admissionMocks.organisationReserve.mockImplementation(
      recordOrganisationReserve.bind(null, events),
    );
    admissionMocks.durableSettle.mockResolvedValue({ ok: true, value: null });
    const admission = createHarnessCodeModeAdmission(await admissionFixture());

    const execution = await admission.begin("text('ok')", "call-root");
    await expect(admission.begin("text('ok')", "call-root")).resolves.toEqual(
      execution,
    );
    await admission.claim(execution, "call-root:1", 20);
    await admission.complete(execution, "call-root:1", 30);
    await admission.settle(execution, "succeeded", 40);

    expect(events).toEqual(["platform_reserved", "organisation_reserved"]);
    expect(admissionMocks.durableSettle).toHaveBeenCalledTimes(1);
    expect(admissionMocks.platformReserve).toHaveBeenCalledTimes(1);
    expect(admissionMocks.organisationReserve).toHaveBeenCalledTimes(1);
    expect(admissionMocks.organisationClaim).toHaveBeenCalledTimes(1);
    expect(admissionMocks.organisationComplete).toHaveBeenCalledTimes(1);
  });

  it("compensates the platform reservation when organisation admission fails", async function compensates() {
    admissionMocks.organisationReserve.mockResolvedValue({
      ok: false,
      error: { code: "code_mode_organisation_daily_budget_exceeded" },
    });
    const admission = createHarnessCodeModeAdmission(await admissionFixture());

    await expect(
      admission.begin("text('blocked')", "call-blocked"),
    ).rejects.toThrow("Code Mode organisation admission failed");

    expect(admissionMocks.platformCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "admission_compensated",
      }),
    );
  });

  it("fails before organisation admission when the platform denies execution", async function failsClosed() {
    admissionMocks.platformReserve.mockResolvedValue({
      ok: false,
      error: { code: "code_mode_platform_disabled" },
    });
    const admission = createHarnessCodeModeAdmission(await admissionFixture());

    await expect(
      admission.begin("text('blocked')", "call-disabled"),
    ).rejects.toThrow("Code Mode platform admission failed");

    expect(admissionMocks.organisationReserve).not.toHaveBeenCalled();
  });
});

function createAdmissionMocks() {
  return {
    preflight: vi.fn(),
    platformReserve: vi.fn(),
    platformCancel: vi.fn(),
    organisationReserve: vi.fn(),
    organisationCancel: vi.fn(),
    organisationClaim: vi.fn(),
    organisationComplete: vi.fn(),
    durableSettle: vi.fn(),
    commitExecutionRequested: vi.fn(),
    executionRow: undefined as ExecutionRowFixture | undefined,
    lease: emptyHarnessLease(),
  };
}

function emptyHarnessLease(): HarnessTurnLease | null {
  return null;
}

function resetAdmissionMocks(): void {
  admissionMocks.preflight.mockReset();
  admissionMocks.platformReserve.mockReset();
  admissionMocks.platformCancel.mockReset();
  admissionMocks.organisationReserve.mockReset();
  admissionMocks.organisationCancel.mockReset();
  admissionMocks.organisationClaim.mockReset();
  admissionMocks.organisationComplete.mockReset();
  admissionMocks.durableSettle.mockReset();
  admissionMocks.commitExecutionRequested.mockReset();
  admissionMocks.preflight.mockReturnValue({ ok: true, value: null });
  admissionMocks.platformReserve.mockImplementation(successfulReserve);
  admissionMocks.organisationReserve.mockImplementation(successfulReserve);
  admissionMocks.organisationCancel.mockResolvedValue({
    ok: true,
    value: { kind: "cancelled" },
  });
  admissionMocks.platformCancel.mockResolvedValue({
    ok: true,
    value: { kind: "cancelled" },
  });
  admissionMocks.organisationClaim.mockResolvedValue({
    ok: true,
    value: capabilityCounter(),
  });
  admissionMocks.organisationComplete.mockResolvedValue({
    ok: true,
    value: capabilityCounter(),
  });
  admissionMocks.durableSettle.mockResolvedValue({ ok: true, value: null });
  admissionMocks.commitExecutionRequested.mockImplementation(
    commitExecutionRequestFixture,
  );
  admissionMocks.executionRow = undefined;
  admissionMocks.lease = null;
}

function harnessAuthorityMock() {
  return { preflightHarnessTurnLease: admissionMocks.preflight };
}

function actorRouterMock() {
  return {
    requireActiveOrganisationActorAtPlacement: vi.fn().mockResolvedValue({
      reserveCodeModeBudget: admissionMocks.organisationReserve,
      cancelCodeModeBudget: admissionMocks.organisationCancel,
      claimCodeModeCapability: admissionMocks.organisationClaim,
      completeCodeModeCapability: admissionMocks.organisationComplete,
    }),
  };
}

function actorJournalMock() {
  return {
    commitExecutionRequestedSession: admissionMocks.commitExecutionRequested,
  };
}

function canonicalSessionMock() {
  return {
    readCanonicalSessionProjection: processingLifecycle,
    parseWorkspaceReceipt: parseWorkspaceReceiptFixture,
  };
}

function actorWasmMock() {
  return {
    validateCanonicalSessionAdvance: vi
      .fn()
      .mockReturnValue({ ok: true, value: null }),
  };
}

function durableSettlementMock() {
  return {
    codeModeExecutionReceiptId: mockCodeModeExecutionReceiptId,
    settleCodeModeExecutionDurably: admissionMocks.durableSettle,
    resumeCodeModeExecutionSettlement: vi.fn().mockResolvedValue({
      ok: true,
      value: { kind: "not_started" },
    }),
  };
}

function containerModuleMock() {
  class Container {}
  return { Container };
}

function mockCodeModeExecutionReceiptId(executionId: string): string {
  return `receipt-${executionId}`;
}

async function admissionFixture() {
  const db = createMigratedDatabase();
  const now = Date.now();
  const owner = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject: "code-mode-admission-owner",
      email: "code-mode-admission-owner@example.test",
      displayName: "Code Mode owner",
      emailVerified: true,
    },
    now,
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner,
    organisationName: "Code Mode admission",
    environment: "development",
    mutation: organisationBootstrapMutation(owner, now),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now,
  });
  const issued = await issueControlSession({
    db,
    userId: owner.userId,
    now,
    ttlMs: 3_600_000,
  });
  const namespace = {
    idFromName: vi.fn().mockReturnValue("platform-id"),
    get: vi.fn().mockReturnValue({
      reserve: admissionMocks.platformReserve,
      cancel: admissionMocks.platformCancel,
      isAdmissionOpen: vi.fn().mockResolvedValue(true),
    }),
  };
  const connected = await connectRealAccountPlatform(
    platformEnv({
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
      CODE_MODE_PLATFORM_GOVERNOR_ACTOR: namespace,
    }),
    {
      organisationId: organisation.organisationId,
      owner: { user: owner, session: issued.session },
      members: [],
    },
  );
  const env = connected.env;
  const scope = await requireOrganisationExecutionScope(
    env,
    organisation.organisationId,
  );
  await scope.database
    .prepare(
      `UPDATE organisation_onboarding
     SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL,
         activation_receipt_id = ?, activated_at = ?, updated_at = ?
     WHERE organisation_id = ?`,
    )
    .bind(
      `activation_code_mode_${organisation.organisationId}`,
      now,
      now,
      organisation.organisationId,
    )
    .run();
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: scope.database,
    organisationId: organisation.organisationId,
  });
  if (membershipRevision === null)
    throw new Error("Missing Code Mode owner membership");
  const authority = buildControlAuthority({
    organisationId: organisation.organisationId,
    userId: owner.userId,
    requesterPersonId: organisation.personId,
    membershipRevision,
    role: "owner",
  }).requestAuthority;
  const lease = createHarnessLease(organisation.organisationId, authority);
  admissionMocks.lease = lease;
  const bound = await bindOperatorTurnAccess(
    scope,
    requireSessionId(lease.session.sessionId),
    lease.turn.turnId,
    authority,
    {
      kind: "control_session",
      controlSessionId: issued.session.controlSessionId,
    },
  );
  if (!bound) throw new Error("Code Mode owner session binding failed");
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  createActorActivationSchema(sql);
  createActorExecutionBarrierSchema(sql);
  await activateActorFixture(
    env,
    { activate: activateSessionFixture.bind(null, sql) },
    {
      objectKind: "session",
      organisationId: organisation.organisationId,
      logicalObjectId: requireSessionId("session-code-admission"),
    },
    CANONICAL_SESSION_SCHEMA_VERSION,
  );
  return {
    env,
    storage: admissionStorage(sql),
    organisationId: organisation.organisationId,
    lease,
    catalogDigest: "f".repeat(64),
  };
}

type ExecutionRowFixture = {
  request_envelope: string;
  state_kind: string;
  state_projection: string;
};

function admissionStorage(sql: SqlStorage): DurableObjectStorage {
  return new AdmissionStorageFixture(sql) as unknown as DurableObjectStorage;
}

async function activateSessionFixture(
  sql: SqlStorage,
  request: ActorActivationRequest,
) {
  return activateActor(sql, request);
}

function executeAdmissionSql(
  sql: SqlStorage,
  query: string,
  ...params: SqlStorageValue[]
) {
  if (query.includes("state_object_activation"))
    return sql.exec(query, ...params);
  if (
    query.includes("FROM actor_outbox") &&
    query.includes("request_envelope")
  ) {
    return new SqlRows(
      admissionMocks.executionRow === undefined
        ? []
        : [admissionMocks.executionRow],
    );
  }
  if (query.includes("UPDATE actor_outbox")) {
    const row = admissionMocks.executionRow;
    if (row !== undefined) {
      row.state_kind = "dispatching";
      row.state_projection = String(params[0]);
    }
    return new SqlRows([]);
  }
  return new SqlRows([]);
}

class AdmissionStorageFixture {
  readonly sql;
  constructor(sql: SqlStorage) {
    this.sql = {
      exec: vi.fn().mockImplementation(executeAdmissionSql.bind(null, sql)),
    };
  }

  transactionSync<T>(callback: () => T): T {
    return callback();
  }
}

class SqlRows<T> {
  constructor(private readonly rows: readonly T[]) {}

  toArray(): readonly T[] {
    return this.rows;
  }
}

function commitExecutionRequestFixture(
  _storage: unknown,
  input: {
    readonly reserve: CodeModeOrganisationReserveInput;
  },
) {
  admissionMocks.executionRow = {
    // The record as the journal writes it: with its lease generation and
    // the deadline of the admission.
    request_envelope: encodeCodeModeExecutionRecord(
      admittedCodeModeExecutionRecord(input.reserve),
    ),
    state_kind: "pending",
    state_projection: JSON.stringify({
      kind: "pending",
      capabilityCalls: 0,
      inputBytes: 0,
      outputBytes: 0,
    }),
  };
  return {
    ok: true,
    value: { kind: "accepted", eventId: "event", sequence: 3 },
  };
}

function processingLifecycle() {
  const lease = harnessLease();
  const executionId = admittedExecutionId();
  const activeTurn =
    executionId === null
      ? {
          kind: "admitted" as const,
          state: { identity: lease.turn, admittedAt: lease.issuedAt },
        }
      : {
          kind: "awaiting_execution" as const,
          state: {
            identity: lease.turn,
            executionId,
            effectId: `execution-${executionId}`,
          },
        };
  return {
    kind: "processing" as const,
    state: {
      identity: lease.session,
      contract: {
        policyVersion: "policy-code-v1",
        budgetRevision: lease.turn.budgetRevision,
        runtimeRevision: lease.runtimeRevision,
        lastEventSequence: 2,
      },
      resumePoint: {
        kind: "new" as const,
        workspaceRevisionReceipt: {
          receiptId: "workspace-receipt-1",
          outcome: "accepted" as const,
          workspaceId: "workspace-1",
          revision: "workspace-revision-1",
          canonicalHead:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          correlationId: "correlation-1",
          causation: { kind: "command" as const, commandId: "command-1" },
        },
      },
      runtimeLease: lease.runtimeLease,
      activeTurn,
    },
  };
}

function admittedExecutionId(): string | null {
  const row = admissionMocks.executionRow;
  if (row === undefined) return null;
  const parsed: unknown = JSON.parse(row.request_envelope);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("executionId" in parsed)
  ) {
    return null;
  }
  return typeof parsed.executionId === "string" ? parsed.executionId : null;
}

function harnessLease(): HarnessTurnLease {
  if (admissionMocks.lease === null)
    throw new Error("Missing Code Mode harness lease");
  return admissionMocks.lease;
}

function createHarnessLease(
  organisationId: OrganisationId,
  requestAuthority: Extract<RequestAuthority, { kind: "control" }>,
): HarnessTurnLease {
  const now = Date.now();
  return {
    requestAuthority,
    leaseId: "harness-lease-code",
    session: {
      organisationId,
      sessionId: "session-code-admission",
      streamId: "stream-code-admission",
    },
    turn: {
      turnId: "turn-code-admission",
      inputId: "input-code-admission",
      turnLeaseGeneration: 1,
      budgetRevision: "budget-code-v1",
    },
    runtimeLease: { generation: 1, leaseId: "runtime-lease-code" },
    runtimeRevision: "runtime-code-v1",
    authorityPartitionDigest: "b".repeat(64),
    issuedAt: now,
    expiresAt: now + 30_000,
  };
}

function committedWorkspaceReceiptFixture() {
  return {
    receiptId: "workspace-receipt-2",
    outcome: "accepted" as const,
    workspaceId: "workspace-1",
    revision: "workspace-revision-2",
    canonicalHead: "b".repeat(64),
    correlationId: "correlation-2",
    causation: {
      kind: "effect_receipt" as const,
      receiptId: "receipt-execution-2",
    },
  };
}

function parseWorkspaceReceiptFixture(
  raw: unknown,
): WorkspaceRevisionReceipt | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("receiptId" in raw) ||
    !("outcome" in raw) ||
    !("workspaceId" in raw) ||
    !("revision" in raw) ||
    !("canonicalHead" in raw) ||
    !("correlationId" in raw) ||
    !("causation" in raw)
  )
    return null;
  const receipt = committedWorkspaceReceiptFixture();
  return JSON.stringify(raw) === JSON.stringify(receipt) ? receipt : null;
}

function successfulReserve(input: CodeModeOrganisationReserveInput) {
  return Promise.resolve({
    ok: true,
    value: {
      kind: "reserved",
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runtimeGeneration: input.runtimeGeneration,
      executionId: input.executionId,
      admissionDigest: input.admissionDigest,
      idempotencyKey: input.idempotencyKey,
      leaseId: input.leaseId,
      reservedCostMicros: input.reservedCostMicros,
      executionDeadlineAt: input.executionDeadlineAt,
      leaseExpiresAt: input.leaseExpiresAt,
      priceBookRevision: input.priceBookRevision,
    },
  });
}

function recordPlatformReserve(
  events: string[],
  input: CodeModeOrganisationReserveInput,
) {
  events.push("platform_reserved");
  return successfulReserve(input);
}

function recordOrganisationReserve(
  events: string[],
  input: CodeModeOrganisationReserveInput,
) {
  events.push("organisation_reserved");
  return successfulReserve(input);
}

function capabilityCounter() {
  return {
    executionId: "cmx-fixture",
    capabilityCalls: 1,
    inFlightCalls: 0,
    inputBytes: 20,
    outputBytes: 30,
  };
}
