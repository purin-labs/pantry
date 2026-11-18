/// <reference types="@cloudflare/workers-types" />
import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { parseOrganisationId } from "../src/ids";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import { createMigratedDatabase } from "./sqlite-d1";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";

import type {
  HarnessTurnLease,
  ValidatedProductFolderChangesetV1,
  WorkspaceRevisionReceipt,
} from "@seams/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coordinatorMocks = vi.hoisted(createCoordinatorMocks);

vi.mock("@cloudflare/containers", mockContainers);
vi.mock("../src/chat/turn-access", mockTurnAccess);
vi.mock("../src/actors/agent-session-harness-authority", mockHarnessAuthority);
vi.mock("../src/actors/agent-session-canonical", mockCanonicalSession);
vi.mock("../src/workspace-revision-store", mockWorkspaceStore);
vi.mock(
  "../src/actors/workspace-execution-allocation",
  mockWorkspaceAllocation,
);

import {
  executeWorkspaceProductFolderOperation,
  reconcileWorkspaceCommitIntents,
  writeCodeModeExecutionCounter,
  type WorkspaceProductFolderOperation,
} from "../src/actors/workspace-execution-coordinator";
import { TEST_HARNESS_LEASE_AUTHORITY } from "./fixtures/plan25-turn";
import { isRecord } from "@seams/std";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

describe("workspace execution coordinator", function workspaceExecutionCoordinatorSuite() {
  beforeEach(resetCoordinatorMocks);

  it("records intent before D1 and preserves the accepted workspace receipt", async function commitsWorkspace() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.execute.mockImplementation(
      checkAllocationIntentThenExecute.bind(null, fixture.storage),
    );
    coordinatorMocks.settleAllocation.mockImplementation(
      checkSettlementIntentThenSettle.bind(null, fixture.storage),
    );
    coordinatorMocks.commit.mockImplementation(
      checkIntentThenCommit.bind(null, fixture.storage),
    );

    const result = await executeWorkspaceProductFolderOperation({
      scope: fixture.scope,
      env: fixture.env,
      storage: fixture.storage.binding(),
      operation: operationFixture(),
    });

    expect(result).toEqual({ ok: true, value: acceptedReceipt() });
    expect(coordinatorMocks.commit).toHaveBeenCalledTimes(1);
    expect(fixture.storage.alarm).not.toBeNull();
    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({ ok: true, value: acceptedReceipt() });
    expect(coordinatorMocks.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting retry after the workspace commit", async function rejectsConflictingRetry() {
    const fixture = await coordinatorFixture();

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({ ok: true, value: acceptedReceipt() });

    const conflicting = operationFixture();
    const result = await executeWorkspaceProductFolderOperation({
      scope: fixture.scope,
      env: fixture.env,
      storage: fixture.storage.binding(),
      operation: {
        ...conflicting,
        candidate: {
          ...conflicting.candidate,
          productMarkdown: "# Conflicting product\n",
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "workspace_execution_state_conflict" },
    });
    expect(coordinatorMocks.execute).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.settleAllocation).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.commit).toHaveBeenCalledTimes(1);
  });

  it("settles a terminated executor once without accepting workspace state", async function recordsFailure() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.execute.mockResolvedValue({
      kind: "failed",
      error: {
        kind: "container_unavailable",
        reason: "executor process terminated",
      },
      usage: { requestBytes: 700, responseBytes: 120, gatewayDurationMs: 4 },
    });

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_container_failed",
        reason: "container_unavailable",
      },
    });
    expect(JSON.parse(fixture.storage.row.state_projection)).toEqual(
      expect.objectContaining({
        kind: "workspace_execution_failed",
        allocationReceipt: expect.objectContaining({
          kind: "failed",
          outcome: "platform_failed",
          reason: "container_unavailable",
          inputBytes: 700,
          outputBytes: 120,
          durationMs: 4,
        }),
      }),
    );

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_container_failed",
        reason: "container_unavailable",
      },
    });
    expect(coordinatorMocks.execute).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.settleAllocation).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.commit).not.toHaveBeenCalled();
  });

  it("settles a timed-out Container once as a platform failure", async function recordsTimeout() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.execute.mockResolvedValue({
      kind: "failed",
      error: { kind: "deadline_exceeded" },
      usage: { requestBytes: 700, responseBytes: 0, gatewayDurationMs: 30_000 },
    });

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_container_failed",
        reason: "deadline_exceeded",
      },
    });
    expect(JSON.parse(fixture.storage.row.state_projection)).toEqual(
      expect.objectContaining({
        kind: "workspace_execution_failed",
        operationIdentity: operationIdentityFixture(),
        allocationReceipt: expect.objectContaining({
          kind: "failed",
          outcome: "platform_failed",
          reason: "deadline_exceeded",
          outputBytes: 0,
          durationMs: 30_000,
        }),
      }),
    );
    expect(coordinatorMocks.settleAllocation).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.prepare).not.toHaveBeenCalled();
    expect(coordinatorMocks.commit).not.toHaveBeenCalled();
  });

  it("rejects an executor result returned after turn cancellation", async function rejectsStaleLease() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.execute.mockImplementation(returnAfterTurnCancellation);

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_commit_failed",
        reason: "harness_lease_rejected",
      },
    });
    expect(JSON.parse(fixture.storage.row.state_projection)).toEqual(
      expect.objectContaining({
        kind: "workspace_commit_failed",
        operationIdentity: operationIdentityFixture(),
        allocationReceipt: expect.objectContaining({ kind: "succeeded" }),
        reason: "harness_lease_rejected",
      }),
    );
    expect(coordinatorMocks.execute).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.settleAllocation).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.prepare).not.toHaveBeenCalled();
    expect(coordinatorMocks.commit).not.toHaveBeenCalled();
  });

  it("retries settlement without rerunning the Container", async function recoversSettlement() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.settleAllocation.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "workspace_allocation_authority_failed",
        authority: "platform",
        reason: "platform_unavailable",
      },
    });

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_allocation_failed",
        reason: "platform_unavailable",
      },
    });
    expect(JSON.parse(fixture.storage.row.state_projection).kind).toBe(
      "workspace_allocation_settlement_pending",
    );
    expect(
      writeCodeModeExecutionCounter(
        fixture.storage.binding(),
        operationFixture().executionLease,
        { capabilityCalls: 2, inputBytes: 80, outputBytes: 120 },
        Date.now(),
      ),
    ).toEqual({ ok: true, value: null });
    expect(JSON.parse(fixture.storage.row.state_projection)).toEqual(
      expect.objectContaining({
        kind: "workspace_allocation_settlement_pending",
        capabilityCalls: 2,
        inputBytes: 80,
        outputBytes: 120,
        intent: expect.any(Object),
      }),
    );

    coordinatorMocks.settleAllocation.mockImplementation(
      settleAllocationFixture,
    );
    await reconcileWorkspaceCommitIntents({
      scope: fixture.scope,
      env: fixture.env,
      storage: fixture.storage.binding(),
    });

    expect(coordinatorMocks.execute).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.settleAllocation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fixture.storage.row.state_projection).kind).toBe(
      "workspace_committed",
    );
  });

  it("marks split allocation authority indeterminate before Container dispatch", async function rejectsSplitAuthority() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.reserveAllocation.mockResolvedValue({
      ok: false,
      error: {
        code: "workspace_allocation_authority_indeterminate",
        authority: "platform",
        reason: "platform_compensation_failed",
      },
    });

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_allocation_failed",
        reason: "platform_compensation_failed",
      },
    });
    expect(fixture.storage.row.state_kind).toBe("indeterminate");
    expect(coordinatorMocks.execute).not.toHaveBeenCalled();
  });

  it("recovers the exact D1 commit after a failure following the durable intent", async function recoversCommit() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.commit.mockResolvedValueOnce({
      ok: false,
      error: { code: "workspace_revision_storage_failed" },
    });

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_commit_failed",
        reason: "workspace_revision_storage_failed",
      },
    });
    expect(JSON.parse(fixture.storage.row.state_projection).kind).toBe(
      "workspace_commit_pending",
    );

    coordinatorMocks.commit.mockResolvedValue({
      ok: true,
      value: { kind: "duplicate", receipt: acceptedReceipt() },
    });
    await reconcileWorkspaceCommitIntents({
      scope: fixture.scope,
      env: fixture.env,
      storage: fixture.storage.binding(),
    });

    expect(coordinatorMocks.commit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fixture.storage.row.state_projection)).toEqual({
      kind: "workspace_committed",
      capabilityCalls: 1,
      inputBytes: 64,
      outputBytes: 96,
      operationIdentity: operationIdentityFixture(),
      allocationReceipt: expect.objectContaining({
        kind: "succeeded",
        allocationId: "wxa-execution_1",
      }),
      workspaceRevisionReceipt: acceptedReceipt(),
    });
  });

  it("quarantines a stale workspace base without accepting a revision", async function rejectsStaleBase() {
    const fixture = await coordinatorFixture();
    coordinatorMocks.commit.mockResolvedValue({
      ok: false,
      error: { code: "workspace_revision_base_conflict" },
    });

    await expect(
      executeWorkspaceProductFolderOperation({
        scope: fixture.scope,
        env: fixture.env,
        storage: fixture.storage.binding(),
        operation: operationFixture(),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "workspace_execution_commit_failed",
        reason: "workspace_revision_base_conflict",
      },
    });
    expect(fixture.storage.row.state_kind).toBe("indeterminate");
    expect(JSON.parse(fixture.storage.row.state_projection)).toEqual({
      kind: "workspace_commit_indeterminate",
      reason: "workspace_revision_base_conflict",
    });
    expect(coordinatorMocks.execute).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.settleAllocation).toHaveBeenCalledTimes(1);
    expect(coordinatorMocks.verify).not.toHaveBeenCalled();
  });
});

function createCoordinatorMocks() {
  return {
    preflight: vi.fn(),
    origin: vi.fn(),
    read: vi.fn(),
    prepare: vi.fn(),
    commit: vi.fn(),
    verify: vi.fn(),
    execute: vi.fn(),
    reserveAllocation: vi.fn(),
    settleAllocation: vi.fn(),
    cancelAllocation: vi.fn(),
  };
}

function resetCoordinatorMocks(): void {
  coordinatorMocks.origin.mockReset();
  coordinatorMocks.origin.mockResolvedValue(true);
  coordinatorMocks.preflight.mockReset();
  coordinatorMocks.read.mockReset();
  coordinatorMocks.prepare.mockReset();
  coordinatorMocks.commit.mockReset();
  coordinatorMocks.verify.mockReset();
  coordinatorMocks.execute.mockReset();
  coordinatorMocks.reserveAllocation.mockReset();
  coordinatorMocks.settleAllocation.mockReset();
  coordinatorMocks.cancelAllocation.mockReset();
  coordinatorMocks.preflight.mockReturnValue({ ok: true, value: null });
  coordinatorMocks.read.mockResolvedValue({
    ok: true,
    value: materializationFixture(),
  });
  coordinatorMocks.prepare.mockResolvedValue({
    ok: true,
    value: { receipt: acceptedReceipt() },
  });
  coordinatorMocks.commit.mockResolvedValue({
    ok: true,
    value: { kind: "committed", receipt: acceptedReceipt() },
  });
  coordinatorMocks.verify.mockResolvedValue({
    ok: true,
    value: acceptedReceipt(),
  });
  coordinatorMocks.execute.mockResolvedValue({
    kind: "succeeded",
    response: executorResponseFixture(),
    usage: { requestBytes: 700, responseBytes: 400, gatewayDurationMs: 9 },
  });
  coordinatorMocks.reserveAllocation.mockImplementation(
    reserveAllocationFixture,
  );
  coordinatorMocks.settleAllocation.mockImplementation(settleAllocationFixture);
  coordinatorMocks.cancelAllocation.mockResolvedValue({
    ok: true,
    value: { kind: "cancelled" },
  });
}

function mockContainers(): { Container: new () => object } {
  class Container {}
  return { Container };
}

function mockHarnessAuthority() {
  return {
    parsePersistedHarnessTurnLease: parseHarnessLeaseFixture,
    preflightHarnessTurnLease: coordinatorMocks.preflight,
  };
}

function parseHarnessLeaseFixture(raw: unknown): HarnessTurnLease | null {
  if (
    !isRecord(raw) ||
    !isRecord(raw.session) ||
    !isRecord(raw.turn) ||
    !isRecord(raw.runtimeLease)
  )
    return null;
  if (
    typeof raw.leaseId !== "string" ||
    typeof raw.session.organisationId !== "string" ||
    typeof raw.session.sessionId !== "string" ||
    typeof raw.session.streamId !== "string" ||
    typeof raw.turn.turnId !== "string" ||
    typeof raw.turn.inputId !== "string" ||
    typeof raw.turn.turnLeaseGeneration !== "number" ||
    typeof raw.turn.budgetRevision !== "string" ||
    typeof raw.runtimeLease.generation !== "number" ||
    typeof raw.runtimeLease.leaseId !== "string" ||
    typeof raw.runtimeRevision !== "string" ||
    typeof raw.issuedAt !== "number" ||
    typeof raw.expiresAt !== "number"
  )
    return null;
  return {
    ...TEST_HARNESS_LEASE_AUTHORITY,
    leaseId: raw.leaseId,
    session: {
      organisationId: raw.session.organisationId,
      sessionId: raw.session.sessionId,
      streamId: raw.session.streamId,
    },
    turn: {
      turnId: raw.turn.turnId,
      inputId: raw.turn.inputId,
      turnLeaseGeneration: raw.turn.turnLeaseGeneration,
      budgetRevision: raw.turn.budgetRevision,
    },
    runtimeLease: {
      generation: raw.runtimeLease.generation,
      leaseId: raw.runtimeLease.leaseId,
    },
    runtimeRevision: raw.runtimeRevision,
    issuedAt: raw.issuedAt,
    expiresAt: raw.expiresAt,
  };
}

function mockCanonicalSession() {
  return {
    parseWorkspaceReceipt: parseWorkspaceReceiptFixture,
    readCanonicalSessionProjection: canonicalSessionFixture,
  };
}

function mockWorkspaceStore() {
  return {
    parseWorkspaceReceipt: parseWorkspaceReceiptFixture,
    readWorkspaceRevision: coordinatorMocks.read,
    prepareWorkspaceRevisionMutation: coordinatorMocks.prepare,
    commitWorkspaceRevision: coordinatorMocks.commit,
    verifyWorkspaceRevisionReceipt: coordinatorMocks.verify,
  };
}

function mockWorkspaceAllocation() {
  return {
    reserveWorkspaceExecutorAllocation: coordinatorMocks.reserveAllocation,
    settleWorkspaceExecutorAllocation: coordinatorMocks.settleAllocation,
    cancelWorkspaceExecutorAllocation: coordinatorMocks.cancelAllocation,
  };
}

function reserveAllocationFixture(input: {
  readonly organisationId: string;
  readonly executionLease: {
    readonly executionId: string;
    readonly leaseId: string;
  };
  readonly allocationDigest: string;
  readonly executionDeadlineAt: number;
}) {
  return Promise.resolve({
    ok: true,
    value: {
      kind: "reserved",
      organisationId: input.organisationId,
      parent: {
        kind: "code_mode_execution",
        executionId: input.executionLease.executionId,
        leaseId: input.executionLease.leaseId,
      },
      allocationId: "wxa-execution_1",
      idempotencyKey: "workspace-allocation-cmx_execution_1",
      allocationDigest: input.allocationDigest,
      priceBookRevision: "code-mode-price-book-v2",
      profile: {
        kind: "workspace_executor_container",
        instanceType: "lite",
        network: "denied",
        maxDurationMs: 30_000,
        maxInputBytes: 32 * 1024 * 1024,
        maxOutputBytes: 1_048_576,
        maxAllocations: 1,
      },
      reservedCostMicros: 250,
      executionDeadlineAt: input.executionDeadlineAt,
      leaseExpiresAt: input.executionDeadlineAt + 5_000,
    },
  });
}

function settleAllocationFixture(input: {
  readonly settlement: Record<string, unknown>;
}) {
  return Promise.resolve({
    ok: true,
    value: { kind: "settled", ...input.settlement },
  });
}

async function coordinatorFixture(): Promise<{
  readonly env: UnitTestEnv;
  readonly storage: CoordinatorStorage;
  readonly scope: OrganisationExecutionScope;
}> {
  const storage = new CoordinatorStorage();
  const db = createMigratedDatabase();
  const organisationId = parseOrganisationId("organisation_1");
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES (?, 'test-organisation', 'Test organisation', 0)",
    )
    .bind(organisationId.value)
    .run();
  await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisationId.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisationId.value,
  );
  return {
    scope,
    storage,
    env: platformEnv({
      DB: db,
      ARCHIVE: {},
      WORKSPACE_EXECUTOR: {
        getByName: vi.fn().mockReturnValue({
          executeWorkspaceOperation: executeRecordedFixture,
          releaseWorkspaceOperation: releaseRecordedFixture,
        }),
      },
    }),
  };
}

class CoordinatorStorage {
  readonly row = {
    effect_id: "execution-cmx_execution_1",
    request_envelope: JSON.stringify({
      kind: "code_mode_execution.v1",
      executionId: "cmx_execution_1",
      leaseId: "lease_execution_1",
      organisationId: "organisation_1",
    }),
    state_kind: "dispatching",
    state_projection: JSON.stringify({
      kind: "dispatching",
      capabilityCalls: 1,
      inputBytes: 64,
      outputBytes: 96,
    }),
    updated_at: 1,
  };
  readonly sql = {
    exec: executeCoordinatorSql.bind(null, this),
  } as unknown as SqlStorage;
  alarm: number | null = null;

  binding(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm);
  }

  setAlarm(value: number | Date): Promise<void> {
    this.alarm = value instanceof Date ? value.getTime() : value;
    return Promise.resolve();
  }
}

function executeCoordinatorSql(
  storage: CoordinatorStorage,
  query: string,
  ...params: unknown[]
): SqlRows<Record<string, unknown>> {
  if (query.includes("SELECT effect_id, request_envelope, state_projection")) {
    return new SqlRows([storage.row]);
  }
  if (query.includes("SELECT request_envelope FROM actor_outbox")) {
    return new SqlRows([{ request_envelope: storage.row.request_envelope }]);
  }
  if (
    query.includes("SET state_projection") ||
    query.includes("SET state_kind = 'dispatching', state_projection")
  ) {
    storage.row.state_projection = String(params[0]);
    storage.row.updated_at = Number(params[1]);
    if (query.includes("state_kind = 'dispatching'"))
      storage.row.state_kind = "dispatching";
    return new SqlRows([]);
  }
  if (query.includes("state_kind = 'indeterminate'")) {
    storage.row.state_kind = "indeterminate";
    storage.row.state_projection = String(params[0]);
    return new SqlRows([]);
  }
  return new SqlRows([]);
}

class SqlRows<T> {
  constructor(private readonly rows: readonly T[]) {}

  toArray(): readonly T[] {
    return this.rows;
  }
}

function checkIntentThenCommit(storage: CoordinatorStorage) {
  expect(JSON.parse(storage.row.state_projection).kind).toBe(
    "workspace_commit_pending",
  );
  return Promise.resolve({
    ok: true,
    value: { kind: "committed", receipt: acceptedReceipt() },
  });
}

function checkAllocationIntentThenExecute(storage: CoordinatorStorage) {
  expect(JSON.parse(storage.row.state_projection).kind).toBe(
    "workspace_allocation_pending",
  );
  return Promise.resolve({
    kind: "succeeded",
    response: executorResponseFixture(),
    usage: { requestBytes: 700, responseBytes: 400, gatewayDurationMs: 9 },
  });
}

function checkSettlementIntentThenSettle(
  storage: CoordinatorStorage,
  input: { readonly settlement: Record<string, unknown> },
) {
  expect(JSON.parse(storage.row.state_projection).kind).toBe(
    "workspace_allocation_settlement_pending",
  );
  return settleAllocationFixture(input);
}

function operationFixture(): WorkspaceProductFolderOperation {
  return {
    harnessLease: harnessLeaseFixture(),
    executionLease: {
      executionId: "cmx_execution_1",
      leaseId: "lease_execution_1",
    },
    productRoot: "products/product_1",
    candidate: {
      productMarkdown: "# Updated product\n",
      variantsYaml: "schemaVersion: satyr.variants.v1\nvariants: []\n",
    },
    claimedChangeset: changesetFixture(),
    deadlineAtUnixMs: Date.now() + 30_000,
    committedAt: 1_800_000_000_000,
  };
}

function operationIdentityFixture() {
  const operation = operationFixture();
  return {
    productRoot: operation.productRoot,
    candidate: operation.candidate,
    claimedChangeset: operation.claimedChangeset,
    committedAt: operation.committedAt,
  };
}

function harnessLeaseFixture(): HarnessTurnLease {
  const now = Date.now();
  return {
    ...TEST_HARNESS_LEASE_AUTHORITY,
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
    issuedAt: now,
    expiresAt: now + 60_000,
  };
}

function canonicalSessionFixture() {
  const lease = harnessLeaseFixture();
  return {
    kind: "processing",
    state: {
      identity: lease.session,
      contract: {
        policyVersion: "policy_1",
        budgetRevision: lease.turn.budgetRevision,
        runtimeRevision: lease.runtimeRevision,
        lastEventSequence: 4,
      },
      resumePoint: { kind: "new", workspaceRevisionReceipt: baseReceipt() },
      runtimeLease: lease.runtimeLease,
      activeTurn: {
        kind: "awaiting_execution",
        state: {
          identity: lease.turn,
          executionId: "cmx_execution_1",
          effectId: "execution-cmx_execution_1",
        },
      },
    },
  };
}

function materializationFixture() {
  return {
    revision: baseReceipt().revision,
    canonicalHead: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    manifest: {
      schemaVersion: "workspace_revision_manifest.v1",
      organisationId: "organisation_1",
      workspaceId: "workspace_1",
      baseRevision: null,
      files: [
        manifestFile(
          "workspace.yaml",
          "text/yaml",
          "schemaVersion: satyr.workspace.v1\n",
        ),
        manifestFile(
          "products/product_1/product.md",
          "text/markdown",
          "# Product\n",
        ),
        manifestFile(
          "products/product_1/variants.yaml",
          "text/yaml",
          "schemaVersion: satyr.variants.v1\nvariants: []\n",
        ),
        manifestFile("brand/voice.md", "text/markdown", "Clear.\n"),
      ],
    },
  };
}

function manifestFile(path: string, mediaType: string, content: string) {
  return {
    path,
    mediaType,
    byteLength: new TextEncoder().encode(content).byteLength,
    sha256: "c".repeat(64),
    content,
  };
}

function executorResponseFixture() {
  const operation = operationFixture();
  return {
    schemaVersion: "workspace_executor_response.v1",
    executionId: operation.executionLease.executionId,
    executionReceiptId: `receipt-${operation.executionLease.executionId}`,
    baseRevision: baseReceipt().revision,
    baseCanonicalHead: "a".repeat(64),
    baseManifestDigest: "b".repeat(64),
    operation: {
      kind: "validated_product_folder_changeset",
      productRoot: operation.productRoot,
      replacementOverlay: {
        productMarkdown: {
          path: `${operation.productRoot}/product.md`,
          utf8: operation.candidate.productMarkdown,
        },
        variantsYaml: {
          path: `${operation.productRoot}/variants.yaml`,
          utf8: operation.candidate.variantsYaml,
        },
      },
      validatedChangeset: operation.claimedChangeset,
    },
    inputBytes: 512,
    outputBytes: 256,
    durationMs: 8,
  };
}

function changesetFixture(): ValidatedProductFolderChangesetV1 {
  return {
    schemaVersion: "satyr.product-folder-changeset.v1",
    organisationId: "organisation_1",
    workspaceId: "workspace_1",
    baseRevision: "workspace_revision_1",
    resultingSemanticHash: "d".repeat(64),
    diff: { productId: "product_1", fields: ["title"], variantIds: [] },
    changesetDigest: "e".repeat(64),
  };
}

function baseReceipt(): WorkspaceRevisionReceipt {
  return {
    receiptId: "workspace_receipt_1",
    outcome: "accepted",
    workspaceId: "workspace_1",
    revision: "workspace_revision_1",
    canonicalHead: "a".repeat(64),
    correlationId: "correlation_1",
    causation: { kind: "command", commandId: "command_1" },
  };
}

function acceptedReceipt(): WorkspaceRevisionReceipt {
  return {
    receiptId: "workspace_receipt_2",
    outcome: "accepted",
    workspaceId: "workspace_1",
    revision: "workspace_revision_2",
    canonicalHead: "d".repeat(64),
    correlationId: "cmx_execution_1",
    causation: { kind: "effect_receipt", receiptId: "receipt-cmx_execution_1" },
  };
}

function parseWorkspaceReceiptFixture(
  raw: unknown,
): WorkspaceRevisionReceipt | null {
  return typeof raw === "object" && raw !== null && "receiptId" in raw
    ? (raw as WorkspaceRevisionReceipt)
    : null;
}

async function mockTurnAccess() {
  const actual = await vi.importActual<
    typeof import("../src/chat/turn-access")
  >("../src/chat/turn-access");
  return { ...actual, authorizeSessionTurnExecution: coordinatorMocks.origin };
}

function returnAfterTurnCancellation() {
  coordinatorMocks.preflight.mockReturnValue({
    ok: false,
    error: { code: "harness_lease_missing" },
  });
  return Promise.resolve({
    kind: "succeeded",
    response: executorResponseFixture(),
    usage: { requestBytes: 700, responseBytes: 400, gatewayDurationMs: 9 },
  });
}

async function executeRecordedFixture(...args: unknown[]) {
  return {
    ok: true,
    value: {
      kind: "completed",
      invocation: await coordinatorMocks.execute(...args),
    },
  };
}
async function releaseRecordedFixture(): Promise<void> {}
