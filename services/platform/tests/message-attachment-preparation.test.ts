/// <reference types="@cloudflare/workers-types" />

import type {
  HarnessTurnLease,
  MessageAttachmentPreparationIdentity,
  MessageAttachmentPreparationLimits,
  StoredMessageAttachment,
} from "@seams/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseSessionId } from "../src/ids";
import type { AttachmentPreparationWorkspaceExecutorAllocation } from "../src/actors/workspace-execution-allocation";
import type {
  WorkspaceExecutorInspectionInvocation,
  WorkspaceExecutorInspectionRequest,
} from "../src/workspace-executor-container";
import {
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
} from "../src/actors/code-mode-budget";
import { prepareAttachmentInExecutor } from "../src/actors/message-attachment-preparation";
import { parseStoredAttachment } from "../src/messages/stored-attachment";
import { TEST_HARNESS_LEASE_AUTHORITY } from "./fixtures/plan25-turn";
import { requireOrganisationId } from "./test-ids";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const mocks = vi.hoisted(function createMocks() {
  return {
    reserve: vi.fn(),
    settle: vi.fn(),
    cancel: vi.fn(),
    inspect: vi.fn(),
    preflight: vi.fn(),
  };
});

vi.mock("@cloudflare/containers", function mockContainers() {
  class Container {}
  return { Container };
});
vi.mock(
  "../src/actors/workspace-execution-allocation",
  function mockAllocation() {
    return {
      reserveAttachmentPreparationAllocation: mocks.reserve,
      settleAttachmentPreparationAllocation: mocks.settle,
      cancelAttachmentPreparationAllocation: mocks.cancel,
    };
  },
);
vi.mock(
  "../src/actors/agent-session-harness-authority",
  function mockHarnessAuthority() {
    return { preflightHarnessTurnLease: mocks.preflight };
  },
);

const ORGANISATION = requireOrganisationId("organisation_1");
const PREPARATION_ID = "preparation_1";
const ALLOCATION_ID = "wxa-preparation_1";
const LIMITS: MessageAttachmentPreparationLimits = {
  maxInputBytes: 4 * 1024 * 1024,
  maxOutputBytes: 1 * 1024 * 1024,
  maxDurationMs: 30_000,
  maxFrames: 12,
};

describe("attachment preparation in the executor", function preparationSuite() {
  beforeEach(function resetMocks() {
    mocks.reserve.mockReset();
    mocks.settle.mockReset();
    mocks.cancel.mockReset();
    mocks.inspect.mockReset();
    mocks.preflight.mockReset();
    mocks.reserve.mockImplementation(async function reserve(input: {
      readonly lease: HarnessTurnLease;
      readonly executionDeadlineAt: number;
    }) {
      return {
        ok: true,
        value: reservation(input.lease, input.executionDeadlineAt),
      };
    });
    mocks.settle.mockResolvedValue({ ok: true, value: { kind: "settled" } });
    mocks.cancel.mockResolvedValue({ ok: true, value: { kind: "cancelled" } });
    mocks.preflight.mockReturnValue({ ok: true, value: null });
    mocks.inspect.mockImplementation(async function inspect(
      request: WorkspaceExecutorInspectionRequest,
    ): Promise<WorkspaceExecutorInspectionInvocation> {
      return succeededInvocation(request);
    });
  });

  it("settles a failed invocation using its actual request and response usage", async function settlesFailureUsage() {
    const turnLease = lease();
    const file = attachment("document", "text/csv");
    const identity = preparationIdentity(turnLease, file);
    const deadlineAt = Date.now() + 20_000;
    let settlement:
      | {
          readonly actualCostMicros: number;
          readonly inputBytes: number;
          readonly outputBytes: number;
          readonly durationMs: number;
          readonly outcome: string;
        }
      | undefined;
    mocks.inspect.mockResolvedValue({
      kind: "failed",
      error: { kind: "executor_rejected", status: 413 },
      usage: { requestBytes: 100, responseBytes: 7, gatewayDurationMs: 4 },
    });
    mocks.settle.mockImplementation(async function settle(input: {
      readonly actualCostMicros: number;
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly durationMs: number;
      readonly outcome: string;
    }) {
      settlement = {
        actualCostMicros: input.actualCostMicros,
        inputBytes: input.inputBytes,
        outputBytes: input.outputBytes,
        durationMs: input.durationMs,
        outcome: input.outcome,
      };
      return { ok: true, value: { kind: "settled" } };
    });

    const prepared = await prepareAttachmentInExecutor({
      env: envWith(),
      storage: storageWith(),
      organisationId: ORGANISATION,
      lease: turnLease,
      preparationId: PREPARATION_ID,
      identity,
      limits: LIMITS,
      deadlineAt,
      attachment: file,
      bytes: new Uint8Array([1, 2, 3]),
      executionControl: activeExecutionControl(),
    });

    expect(settlement).toEqual({
      actualCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
      inputBytes: 100,
      outputBytes: 7,
      durationMs: 4,
      outcome: "organisation_failed",
    });
    expect(prepared).toEqual({
      ok: true,
      value: {
        kind: "limited",
        limit: "container_unavailable",
        detail: "executor_rejected:413",
      },
    });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("cancels an uncertain allocation when dispatch throws", async function cancelsDispatchFailure() {
    const turnLease = lease();
    const file = attachment("document", "text/csv");
    const identity = preparationIdentity(turnLease, file);
    const deadlineAt = Date.now() + 20_000;
    mocks.inspect.mockRejectedValue(new Error("container crashed"));
    mocks.cancel.mockRejectedValue(new Error("cancellation unavailable"));

    const prepared = await prepareAttachmentInExecutor({
      env: envWith(),
      storage: storageWith(),
      organisationId: ORGANISATION,
      lease: turnLease,
      preparationId: PREPARATION_ID,
      identity,
      limits: LIMITS,
      deadlineAt,
      attachment: file,
      bytes: new Uint8Array([1, 2, 3]),
      executionControl: activeExecutionControl(),
    });

    expect(prepared).toEqual({
      ok: true,
      value: {
        kind: "limited",
        limit: "container_unavailable",
        detail: "container crashed",
      },
    });
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: ORGANISATION,
        reason: "turn_cancelled",
        reservation: expect.objectContaining({ allocationId: ALLOCATION_ID }),
      }),
    );
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("cancels a reservation when the turn is interrupted before dispatch", async function cancelsInterruptedDispatch() {
    const turnLease = lease();
    const file = attachment("document", "text/csv");
    const identity = preparationIdentity(turnLease, file);
    const deadlineAt = Date.now() + 20_000;
    const executionControl = {
      begin: vi.fn().mockResolvedValue(false),
      finish: vi.fn(),
    };

    const prepared = await prepareAttachmentInExecutor({
      env: envWith(),
      storage: storageWith(),
      organisationId: ORGANISATION,
      lease: turnLease,
      preparationId: PREPARATION_ID,
      identity,
      limits: LIMITS,
      deadlineAt,
      attachment: file,
      bytes: new Uint8Array([1, 2, 3]),
      executionControl,
    });

    expect(prepared).toEqual({
      ok: true,
      value: {
        kind: "limited",
        limit: "preparation_deadline_exceeded",
        detail: "turn_cancelled",
      },
    });
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: ORGANISATION,
        reason: "turn_cancelled",
        reservation: expect.objectContaining({ allocationId: ALLOCATION_ID }),
      }),
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(executionControl.finish).not.toHaveBeenCalled();
  });

  it("compensates an undispatched allocation after the turn lease becomes stale", async function compensatesStaleLease() {
    const turnLease = lease();
    const file = attachment("document", "text/csv");
    const identity = preparationIdentity(turnLease, file);
    const deadlineAt = Date.now() + 20_000;
    mocks.preflight.mockReturnValue({
      ok: false,
      error: { code: "harness_lease_stale" },
    });

    const prepared = await prepareAttachmentInExecutor({
      env: envWith(),
      storage: storageWith(),
      organisationId: ORGANISATION,
      lease: turnLease,
      preparationId: PREPARATION_ID,
      identity,
      limits: LIMITS,
      deadlineAt,
      attachment: file,
      bytes: new Uint8Array([1, 2, 3]),
      executionControl: activeExecutionControl(),
    });

    expect(prepared).toEqual({
      ok: true,
      value: {
        kind: "limited",
        limit: "preparation_deadline_exceeded",
        detail: "harness_lease_stale",
      },
    });
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "admission_compensated" }),
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
});

function reservation(
  turnLease: HarnessTurnLease,
  executionDeadlineAt: number,
): AttachmentPreparationWorkspaceExecutorAllocation {
  const sessionId = parseSessionId(turnLease.session.sessionId);
  if (!sessionId.ok)
    throw new Error("invalid attachment preparation session fixture");
  return {
    kind: "reserved",
    organisationId: ORGANISATION,
    parent: {
      kind: "attachment_preparation",
      preparationId: PREPARATION_ID,
      leaseId: turnLease.leaseId,
      sessionId: sessionId.value,
      turnId: turnLease.turn.turnId,
      runtimeGeneration: turnLease.runtimeLease.generation,
    },
    allocationId: ALLOCATION_ID,
    idempotencyKey: `workspace-allocation-${PREPARATION_ID}`,
    allocationDigest: "d".repeat(64),
    priceBookRevision: CODE_MODE_PRICE_BOOK_REVISION_V2,
    profile: WORKSPACE_EXECUTOR_ALLOCATION_PROFILE,
    reservedCostMicros: WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
    executionDeadlineAt,
    leaseExpiresAt: turnLease.expiresAt,
  };
}

function succeededInvocation(
  request: WorkspaceExecutorInspectionRequest,
): WorkspaceExecutorInspectionInvocation {
  return {
    kind: "succeeded",
    response: {
      schemaVersion: "workspace_executor_response.v1",
      preparationId: request.preparationId,
      identity: request.identity,
      operation: {
        kind: "attachment_text",
        attachmentId: request.identity.attachmentId,
        text: "espresso,3.50",
        truncated: false,
        sourceSha256: request.identity.sourceSha256,
      },
      inputBytes: 2_000,
      outputBytes: 300,
      durationMs: 12,
    },
    usage: { requestBytes: 2_000, responseBytes: 300, gatewayDurationMs: 12 },
  };
}

function preparationIdentity(
  turnLease: HarnessTurnLease,
  file: StoredMessageAttachment,
): MessageAttachmentPreparationIdentity {
  return {
    organisationId: ORGANISATION,
    sessionId: turnLease.session.sessionId,
    turnId: turnLease.turn.turnId,
    attachmentId: file.id,
    sourceSha256: file.sha256,
    handlerRevision: "message-preparation.v1",
  };
}

function attachment(
  kind: "image" | "document" | "audio" | "video" | "opaque",
  mediaType: string,
  byteLength = 3,
): StoredMessageAttachment {
  const parsed = parseStoredAttachment({
    id: `att_${"a".repeat(32)}`,
    displayName: "file",
    extensionHint: { kind: "none" },
    descriptor:
      kind === "opaque"
        ? {
            kind,
            media: { kind: "unknown", mediaType: "application/octet-stream" },
            formatHint: { declaredMediaType: mediaType },
          }
        : {
            kind,
            media: { kind: "provider_declared", mediaType, provider: "slack" },
          },
    byteLength,
    sha256: "a".repeat(64),
    objectKey: `attachments/${ORGANISATION}/slack/${"a".repeat(64)}`,
    source: {
      kind: "slack",
      integrationAccountId: "account_1",
      workspaceId: "T1",
      channelId: "C1",
      messageTs: "1700000000.000100",
      fileId: "F1",
      revision: "1",
    },
    retention: "session",
    storedAt: 1,
  });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function lease(): HarnessTurnLease {
  const now = Date.now();
  return {
    ...TEST_HARNESS_LEASE_AUTHORITY,
    leaseId: "harness_lease_1",
    session: {
      organisationId: ORGANISATION,
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
    issuedAt: now,
    expiresAt: now + 60_000,
  };
}

function envWith(): UnitTestEnv {
  return platformEnv({
    WORKSPACE_EXECUTOR: {
      getByName: vi.fn(function getByName(allocationId: string) {
        expect(allocationId).toBe(ALLOCATION_ID);
        return { inspectAttachment: mocks.inspect };
      }),
    },
  });
}

function storageWith(): DurableObjectStorage {
  return {} as unknown as DurableObjectStorage;
}

function activeExecutionControl() {
  return {
    begin: vi.fn().mockResolvedValue(true),
    finish: vi.fn(),
  };
}
