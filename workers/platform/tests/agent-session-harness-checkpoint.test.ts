/// <reference types="@cloudflare/workers-types" />

import type {
  HarnessCheckpointRecord,
  HarnessTurnLease,
  ProcessingSession,
  SessionBudgetAccount,
  TurnIdentity,
} from "@purin-labs/contracts";
import { describe, expect, test } from "vitest";

import {
  loadCanonicalHarnessCheckpoint,
  validateActiveRunCheckpointBudgetBinding,
  validateCheckpointBudgetBinding,
  prepareHarnessCheckpoint,
  uploadHarnessCheckpoint,
} from "@purin-labs/agent/actors/agent-session-harness-checkpoint";
import { sessionBudgetAccountDigest } from "@purin-labs/agent/actors/agent-session-budget";
import {
  acceptHarnessEvent,
  commitHarnessCheckpoint,
  dropArchivedHarnessCheckpointPayloads,
  retainHarnessCheckpointUploadInTransaction,
  readHarnessCheckpointPublication,
  markHarnessCheckpointPublishedInTransaction,
  appendHarnessHistory,
  issueHarnessTurnLease,
  type HarnessAuthorityStorage,
} from "@purin-labs/agent/actors/agent-session-harness-authority";
import { createSessionSchema } from "@purin-labs/agent/actors/agent-session-schema";
import { beginSessionTurnStream } from "@purin-labs/agent/actors/agent-session-turn-stream";
import {
  TEST_ACCEPTED_INPUT_CONTEXT,
  TEST_HARNESS_LEASE_AUTHORITY,
} from "./fixtures/plan25-turn";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import type { Variant } from "@purin-labs/type-utils";
import {
  requireRequestId,
  requireSessionTurnInputDigest,
  requireOrganisationId,
} from "./test-ids";

const DIGEST_1 = "1".repeat(64);
const MODEL_ROUTE_DIGEST =
  "b1cb2ef60df8212bf12e482db1f74ce7c921ba34585a1cb56de4cfde3d0b47cc";
const MANIFEST = {
  backendId: "pi" as const,
  harnessBuild: "pi-build-1",
  checkpointFormat: "pi-checkpoint-v1",
  model: "moonshotai/kimi-k3",
};
type CheckpointFixtureIdentity = {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly turn: TurnIdentity;
};
const PRODUCTION_SLACK_SESSION_ID =
  "session_case_slack_T0BP7C932D8_C0BP9ASA6UR_1787996039_177949_authority_8f1cd188cb98d561efbe903d";
const DEFAULT_FIXTURE_IDENTITY: CheckpointFixtureIdentity = {
  organisationId: "organisation_1",
  sessionId: "session_1",
  turn: turnIdentity(),
};
const PRODUCTION_SLACK_FIXTURE_IDENTITY: CheckpointFixtureIdentity = {
  organisationId: "organisation_048e5891-4e31-40b1-a155-f9b0feac69c1",
  sessionId: PRODUCTION_SLACK_SESSION_ID,
  turn: turnIdentity(
    "turn_ingress_slack_Ev0BTKJ6JSM8",
    "input_ingress_slack_Ev0BTKJ6JSM8",
  ),
};

describe("canonical harness checkpoint persistence", function checkpointPersistenceSuite() {
  test("accepts one immutable checkpoint and reuses its exact publication on retry", async function exactRetry() {
    const fixture = await checkpointFixture();
    const bucket = new CheckpointBucket();
    const input = checkpointInput(fixture.historyCursor);

    const first = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: input,
      now: timestampSource(13),
    });
    expect(first.ok && first.value.kind).toBe("committed");
    expect(fixture.checkpointCount()).toBe(1);
    expect(bucket.putCount).toBe(1);

    if (!first.ok) throw new Error(first.error.code);

    const retry = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: input,
      now: timestampSource(14),
    });
    expect(retry.ok && retry.value.kind).toBe("duplicate");
    expect(bucket.has(first.value.checkpoint.blob.objectKey)).toBe(true);
    expect(bucket.putCount).toBe(1);
    expect(fixture.checkpointCount()).toBe(1);
  });

  test("rejects organisation rebinding before R2 mutation", async function rejectsOrganisationRebinding() {
    const fixture = await checkpointFixture();
    const bucket = new CheckpointBucket();
    const result = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: {
        ...checkpointInput(fixture.historyCursor),
        session: {
          ...checkpointInput(fixture.historyCursor).session,
          organisationId: "organisation_other",
        },
      },
      now: timestampSource(13),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "harness_checkpoint_cursor_mismatch" },
    });
    expect(bucket.putCount).toBe(0);
  });

  test("restores only through the committed semantic binding", async function restoresBinding() {
    const fixture = await checkpointFixture();
    const bucket = new CheckpointBucket();
    const plaintext = new TextEncoder().encode("checkpoint state");
    const committed = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: checkpointInput(fixture.historyCursor),
      now: timestampSource(13),
    });
    if (!committed.ok) throw new Error(committed.error.code);
    // As after a relocation: the Session keeps no copy of the payload, so
    // each restore reads the archive.
    dropArchivedHarnessCheckpointPayloads(fixture.storage.sql);
    const restoreState = await processingRestoreState(
      committed.value.checkpoint,
    );
    const wrongBackendBuild = await loadCanonicalHarnessCheckpoint({
      bucket: bucket.binding(),
      root: checkpointRoot(),
      state: restoreState,
      checkpoint: committed.value.checkpoint,
      manifest: {
        ...MANIFEST,
        harnessBuild: "pi-build-other",
      },
      sql: fixture.storage.sql,
    });
    expect(wrongBackendBuild).toEqual({
      ok: false,
      error: { code: "harness_checkpoint_backend_mismatch" },
    });
    expect(bucket.getCount).toBe(0);

    const restored = await loadCanonicalHarnessCheckpoint({
      bucket: bucket.binding(),
      root: checkpointRoot(),
      state: restoreState,
      checkpoint: committed.value.checkpoint,
      manifest: MANIFEST,
      sql: fixture.storage.sql,
    });
    if (!restored.ok) throw new Error(JSON.stringify(restored.error));
    expect(new Uint8Array(restored.value)).toEqual(plaintext);
    expect(
      new TextDecoder().decode(
        bucket.body(committed.value.checkpoint.blob.objectKey),
      ),
    ).not.toContain("checkpoint state");

    const rebound = await loadCanonicalHarnessCheckpoint({
      bucket: bucket.binding(),
      root: checkpointRoot(),
      state: restoreState,
      checkpoint: {
        ...committed.value.checkpoint,
        workspaceBaseRevision: "workspace_stale",
      },
      manifest: MANIFEST,
      sql: fixture.storage.sql,
    });
    expect(rebound).toEqual({
      ok: false,
      error: {
        code: "actor_reducer_rejected",
        reason: "checkpoint_id_mismatch",
      },
    });

    bucket.tamper(committed.value.checkpoint.blob.objectKey);
    const tampered = await loadCanonicalHarnessCheckpoint({
      bucket: bucket.binding(),
      root: checkpointRoot(),
      state: restoreState,
      checkpoint: committed.value.checkpoint,
      manifest: MANIFEST,
      sql: fixture.storage.sql,
    });
    expect(tampered).toEqual({
      ok: false,
      error: { code: "checkpoint_corrupt" },
    });
  });

  test("restores a first-turn checkpoint into a second turn with a production Slack session id", async function restoresSlackMultiTurn() {
    const fixture = await checkpointFixture(PRODUCTION_SLACK_FIXTURE_IDENTITY);
    const bucket = new CheckpointBucket();
    const plaintext = new TextEncoder().encode("first turn checkpoint state");
    const committed = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: {
        ...checkpointInput(
          fixture.historyCursor,
          PRODUCTION_SLACK_FIXTURE_IDENTITY,
        ),
        checkpoint: ownedArrayBuffer(plaintext),
      },
      now: timestampSource(13),
    });
    if (!committed.ok) throw new Error(committed.error.code);

    const secondTurn = turnIdentity(
      "turn_ingress_slack_Ev0BTDCJ3M19",
      "input_ingress_slack_Ev0BTDCJ3M19",
      2,
    );
    const restoreState = await processingRestoreState(
      committed.value.checkpoint,
      { ...PRODUCTION_SLACK_FIXTURE_IDENTITY, turn: secondTurn },
    );
    const restored = await loadCanonicalHarnessCheckpoint({
      bucket: bucket.binding(),
      root: checkpointRoot(),
      state: restoreState,
      checkpoint: committed.value.checkpoint,
      manifest: MANIFEST,
      sql: fixture.storage.sql,
    });
    if (!restored.ok) throw new Error(JSON.stringify(restored.error));

    expect(committed.value.checkpoint.blob.objectKey.length).toBeGreaterThan(
      256,
    );
    expect(restoreState.state.activeTurn.state.identity.turnId).toBe(
      secondTurn.turnId,
    );
    expect(committed.value.checkpoint.turn.turnId).toBe(
      PRODUCTION_SLACK_FIXTURE_IDENTITY.turn.turnId,
    );
    expect(new Uint8Array(restored.value)).toEqual(plaintext);
  });

  test("rejects semantic checkpoint rebinding before R2 mutation", async function rejectsSemanticRebinding() {
    const fixture = await checkpointFixture();
    const bucket = new CheckpointBucket();
    const input = checkpointInput(fixture.historyCursor);
    const first = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: input,
      now: timestampSource(13),
    });
    if (!first.ok) throw new Error(first.error.code);

    const rebound = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: { ...input, toolCatalogDigest: "e".repeat(64) },
      now: timestampSource(14),
    });

    expect(rebound).toEqual({
      ok: false,
      error: { code: "harness_checkpoint_conflict" },
    });
    expect(bucket.putCount).toBe(1);
    expect(fixture.checkpointCount()).toBe(1);
  });

  test("binds the checkpoint to the exact budget projection", async function bindsBudgetProjection() {
    const fixture = await checkpointFixture();
    const input = checkpointInput(fixture.historyCursor);
    const account = {
      kind: "open" as const,
      budget: {
        budgetRevision: input.budgetRevision,
        maxTokens: 10_000,
        maxWallMs: 60_000,
        maxToolCalls: 20,
      },
      usage: input.budgetUsage,
      usageCursor: input.usageCursor,
      reservation: { kind: "none" as const },
    };
    const budgetAccountDigest = await sessionBudgetAccountDigest(account);

    expect(
      await validateCheckpointBudgetBinding({
        checkpoint: { ...input, budgetAccountDigest },
        account,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await validateCheckpointBudgetBinding({
        checkpoint: {
          ...input,
          budgetUsage: { ...input.budgetUsage, tokens: 1 },
        },
        account,
      }),
    ).toEqual({
      ok: false,
      error: { code: "checkpoint_budget_usage_mismatch" },
    });

    const bucket = new CheckpointBucket();
    const committed = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: input,
      now: timestampSource(13),
    });
    if (!committed.ok) throw new Error(committed.error.code);
    const rebound = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: bucket.binding(),
      root: checkpointRoot(),
      checkpoint: { ...input, budgetAccountDigest: "e".repeat(64) },
      now: timestampSource(14),
    });
    expect(rebound).toEqual({
      ok: false,
      error: { code: "harness_checkpoint_conflict" },
    });
  });

  test("restores after failed turns spent only wall time", async function restoresAfterSafeFailure() {
    const fixture = await checkpointFixture();
    const input = checkpointInput(fixture.historyCursor);
    const checkpointAccount: SessionBudgetAccount = {
      kind: "open",
      budget: {
        budgetRevision: input.budgetRevision,
        maxTokens: 10_000,
        maxWallMs: 60_000,
        maxToolCalls: 20,
      },
      usage: input.budgetUsage,
      usageCursor: input.usageCursor,
      reservation: { kind: "none" },
    };
    const committed = await acceptCheckpointFixture({
      storage: fixture.storage,
      bucket: new CheckpointBucket().binding(),
      root: checkpointRoot(),
      checkpoint: {
        ...input,
        budgetAccountDigest:
          await sessionBudgetAccountDigest(checkpointAccount),
      },
      now: timestampSource(13),
    });
    if (!committed.ok) throw new Error(committed.error.code);
    const activeAccount: SessionBudgetAccount = {
      ...checkpointAccount,
      usage: { ...checkpointAccount.usage, activeWallMs: 25 },
      usageCursor: committed.value.checkpoint.usageCursor + 3,
      reservation: activeReservation(),
    };
    const identity = { reservationId: "reservation_2", runId: "run_2" };

    expect(
      await validateActiveRunCheckpointBudgetBinding({
        sql: fixture.storage.sql,
        account: activeAccount,
        checkpoint: committed.value.checkpoint,
        identity,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await validateActiveRunCheckpointBudgetBinding({
        sql: fixture.storage.sql,
        account: {
          ...activeAccount,
          usage: { ...activeAccount.usage, tokens: 1 },
        },
        checkpoint: committed.value.checkpoint,
        identity,
      }),
    ).toEqual({
      ok: false,
      error: { code: "budget_reservation_lease_conflict" },
    });
    expect(
      await validateActiveRunCheckpointBudgetBinding({
        sql: fixture.storage.sql,
        account: {
          ...activeAccount,
          reservation: activeReservation({
            tokens: 0,
            activeWallMs: 0,
            capabilityCalls: 1,
          }),
        },
        checkpoint: committed.value.checkpoint,
        identity,
      }),
    ).toEqual({
      ok: false,
      error: { code: "budget_reservation_lease_conflict" },
    });
  });
});

async function checkpointFixture(identity = DEFAULT_FIXTURE_IDENTITY) {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createSessionSchema(sql);
  const begun = beginSessionTurnStream(sql, {
    turnId: identity.turn.turnId,
    requestId: requireRequestId("request_1"),
    organisationId: requireOrganisationId(identity.organisationId),
    inputDigest: requireSessionTurnInputDigest("a".repeat(64)),
    startedAt: 1,
  });
  if (!begun.ok) throw new Error(begun.error.code);
  const storage = new CheckpointAuthorityStorage(fixture.database, sql);
  const lease = harnessLease(identity);
  const issued = issueHarnessTurnLease(
    storage,
    processingSession(identity),
    lease,
    10,
  );
  if (!issued.ok) throw new Error(issued.error.code);
  const accepted = acceptHarnessEvent(
    storage,
    eventInput(1, DIGEST_1, "first", 11, identity),
  );
  if (!accepted.ok) throw new Error(accepted.error.code);
  const history = await appendHarnessHistory(storage, {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence: 1,
    previousDigest: null,
    entry: {
      kind: "user_input",
      turn: lease.turn,
      input: {
        ...TEST_ACCEPTED_INPUT_CONTEXT,
        kind: "case",
        inputId: lease.turn.inputId,
        caseId: "case_1",
        assignmentId: "assignment_1",
        caseRevision: 1,
        contentDigest: "c".repeat(64),
        workspaceRevision: "workspace_revision_1",
      },
      content: [{ kind: "text", text: "first" }],
      acceptedAt: 11,
    },
    acceptedAt: 11,
  });
  if (!history.ok) throw new Error(history.error.code);
  return {
    storage,
    historyCursor: history.value.cursor,
    checkpointCount: function checkpointCount() {
      const row = fixture.database
        .prepare("SELECT COUNT(*) AS count FROM session_harness_checkpoint")
        .get();
      return Number(row?.count ?? 0);
    },
  };
}

class CheckpointAuthorityStorage implements HarnessAuthorityStorage {
  constructor(
    private readonly database: ReturnType<
      typeof emptySqliteFixture
    >["database"],
    readonly sql: SqlStorage,
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
}

class CheckpointBucket {
  private readonly values = new Map<string, StoredCheckpoint>();
  putCount = 0;
  getCount = 0;

  get size(): number {
    return this.values.size;
  }

  binding(): R2Bucket {
    return {
      head: this.head.bind(this),
      get: this.get.bind(this),
      put: this.put.bind(this),
    } as unknown as R2Bucket;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  body(key: string): Uint8Array {
    const stored = this.values.get(key);
    if (stored === undefined) throw new Error("checkpoint fixture missing");
    return stored.body;
  }

  tamper(key: string): void {
    const stored = this.values.get(key);
    if (stored === undefined) throw new Error("checkpoint fixture missing");
    const body = stored.body.slice();
    const index = body.byteLength - 1;
    body[index] = (body[index] ?? 0) ^ 1;
    this.values.set(key, { ...stored, body });
  }

  private async head(key: string): Promise<R2Object | null> {
    const stored = this.values.get(key);
    return stored === undefined ? null : checkpointObject(key, stored);
  }

  private async get(key: string): Promise<R2ObjectBody | null> {
    this.getCount += 1;
    const stored = this.values.get(key);
    if (stored === undefined) return null;
    return {
      ...checkpointObject(key, stored),
      arrayBuffer: async function arrayBuffer() {
        return ownedArrayBuffer(stored.body);
      },
    } as R2ObjectBody;
  }

  private async put(
    key: string,
    value:
      ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    if (this.values.has(key) && options?.onlyIf !== undefined) return null;
    const body = await checkpointBytes(value);
    const stored = { body, metadata: options?.customMetadata ?? {} };
    this.values.set(key, stored);
    this.putCount += 1;
    return checkpointObject(key, stored);
  }
}

type StoredCheckpoint = {
  body: Uint8Array;
  metadata: Record<string, string>;
};

function checkpointObject(key: string, stored: StoredCheckpoint): R2Object {
  return {
    key,
    size: stored.body.byteLength,
    customMetadata: stored.metadata,
  } as R2Object;
}

function activeReservation(
  acceptedUsage = { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
): Variant<SessionBudgetAccount, "open">["reservation"] {
  return {
    kind: "active",
    reservation: {
      reservationId: "reservation_2",
      runId: "run_2",
      turnId: "turn_2",
      runtimeGeneration: 2,
      turnLeaseGeneration: 2,
      budgetRevision: "budget_1",
      allowance: { tokens: 10_000, activeWallMs: 60_000, capabilityCalls: 20 },
      acceptedAt: 20,
      deadlineAt: 60_020,
    },
    acceptedUsage,
  };
}

async function checkpointBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new Error("unsupported checkpoint body");
}

function checkpointInput(
  historyCursor: import("@purin-labs/contracts").HarnessHistoryCursor,
  identity = DEFAULT_FIXTURE_IDENTITY,
) {
  const lease = harnessLease(identity);
  return {
    leaseId: lease.leaseId,
    backendId: "pi" as const,
    session: lease.session,
    cursor: {
      kind: "accepted" as const,
      turn: lease.turn,
      lastSequence: 1,
      lastEventDigest: DIGEST_1,
    },
    historyCursor,
    runtimeLease: lease.runtimeLease,
    runtimeRevision: lease.runtimeRevision,
    policyVersion: "policy_1",
    budgetRevision: lease.turn.budgetRevision,
    budgetUsage: { tokens: 0, activeWallMs: 0, capabilityCalls: 0 },
    usageCursor: 0,
    budgetAccountDigest: "a".repeat(64),
    lastActorEventSequence: 4,
    workspaceBaseRevision: "workspace_1",
    workspaceRevision: "workspace_1",
    instructionDigest: "b".repeat(64),
    toolCatalogDigest: "c".repeat(64),
    modelRouteDigest: MODEL_ROUTE_DIGEST,
    formatVersion: "pi-checkpoint-v1",
    harnessBuild: "pi-build-1",
    checkpoint: ownedArrayBuffer(new TextEncoder().encode("checkpoint state")),
    createdAt: 12,
  };
}

function processingSession(
  identity = DEFAULT_FIXTURE_IDENTITY,
): ProcessingSession {
  const turn = identity.turn;
  return {
    identity: {
      organisationId: identity.organisationId,
      sessionId: identity.sessionId,
      streamId: "stream_1",
    },
    contract: {
      policyVersion: "policy_1",
      budgetRevision: turn.budgetRevision,
      runtimeRevision: "runtime_1",
      modelRoute: {
        keySource: "platform",
        provider: "openai-compatible",
        model: "moonshotai/kimi-k3",
      },
      lastEventSequence: 4,
    },
    resumePoint: {
      kind: "new",
      workspaceRevisionReceipt: {
        receiptId: "workspace_receipt_1",
        outcome: "accepted",
        workspaceId: "workspace_catalog_1",
        revision: "workspace_1",
        canonicalHead: "f".repeat(64),
        correlationId: "correlation_1",
        causation: { kind: "command", commandId: "workspace_command_1" },
      },
    },
    runtimeLease: { generation: 1, leaseId: "runtime_lease_1" },
    activeTurn: { kind: "admitted", state: { identity: turn, admittedAt: 9 } },
  };
}

async function processingRestoreState(
  checkpoint: HarnessCheckpointRecord,
  identity = DEFAULT_FIXTURE_IDENTITY,
): Promise<{ kind: "processing"; state: ProcessingSession }> {
  const state = processingSession(identity);
  const checkpointId = await sha256Json(checkpoint);
  return {
    kind: "processing",
    state: {
      ...state,
      resumePoint: {
        kind: "checkpoint",
        checkpoint: {
          checkpointId: `checkpoint_${checkpointId}`,
          stateDigest: checkpoint.blob.sha256,
          lastEventSequence: checkpoint.lastActorEventSequence + 1,
          runtimeRevision: checkpoint.runtimeRevision,
          runtimeGeneration: checkpoint.runtimeLease.generation,
          policyVersion: checkpoint.policyVersion,
          budgetRevision: checkpoint.budgetRevision,
          budgetUsage: checkpoint.budgetUsage,
          usageCursor: checkpoint.usageCursor,
          budgetAccountDigest: checkpoint.budgetAccountDigest,
          workspaceRevisionReceipt: {
            receiptId: "workspace_receipt_1",
            outcome: "accepted",
            workspaceId: "workspace_catalog_1",
            revision: checkpoint.workspaceRevision,
            canonicalHead: "f".repeat(64),
            correlationId: "correlation_1",
            causation: { kind: "command", commandId: "workspace_command_1" },
          },
        },
      },
    },
  };
}

async function sha256Json(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return Array.from(digest, toHexByte).join("");
}

function toHexByte(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

function harnessLease(identity = DEFAULT_FIXTURE_IDENTITY): HarnessTurnLease {
  const session = processingSession(identity);
  return {
    ...TEST_HARNESS_LEASE_AUTHORITY,
    leaseId: "harness_lease_1",
    session: session.identity,
    turn: session.activeTurn.state.identity,
    runtimeLease: session.runtimeLease,
    runtimeRevision: session.contract.runtimeRevision,
    issuedAt: 10,
    expiresAt: 20,
  };
}

function turnIdentity(
  turnId = "turn_1",
  inputId = "input_1",
  turnLeaseGeneration = 1,
): TurnIdentity {
  return {
    turnId,
    inputId,
    turnLeaseGeneration,
    budgetRevision: "budget_1",
  };
}

function eventInput(
  sequence: number,
  eventDigest: string,
  payload: string,
  acceptedAt: number,
  identity = DEFAULT_FIXTURE_IDENTITY,
) {
  const lease = harnessLease(identity);
  return {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence,
    eventDigest,
    payload: JSON.stringify({
      turnId: lease.turn.turnId,
      sequence,
      emittedAt: acceptedAt,
      event: { type: "agent_message", text: payload, finalMessage: false },
    }),
    acceptedAt,
  };
}

function checkpointRoot(): SecretsStoreSecret {
  const encoded = Buffer.alloc(32, 7).toString("base64");
  return {
    get: async function getRoot() {
      return encoded;
    },
  } as SecretsStoreSecret;
}

function timestampSource(initial: number): () => number {
  let current = initial;
  return function nextTimestamp() {
    const value = current;
    current += 1;
    return value;
  };
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function acceptCheckpointFixture(
  input: Parameters<typeof prepareHarnessCheckpoint>[0] & {
    bucket: R2Bucket;
    root: SecretsStoreSecret;
  },
) {
  const prepared = await prepareHarnessCheckpoint(input);
  if (!prepared.ok) return prepared;
  const committed = commitHarnessCheckpoint(
    input.storage,
    prepared.value.commit,
  );
  if (!committed.ok) return committed;
  if (committed.value.kind === "committed") {
    const retained = input.storage.transactionSync(
      retainHarnessCheckpointUploadInTransaction.bind(
        null,
        input.storage.sql,
        prepared.value.commit.checkpoint,
        prepared.value.payload,
      ),
    );
    if (!retained.ok) return retained;
  }
  const publication = readHarnessCheckpointPublication(
    input.storage.sql,
    prepared.value.commit.checkpoint,
  );
  if (!publication.ok) return publication;
  if (publication.value.kind === "published") return committed;
  const uploaded = await uploadHarnessCheckpoint({
    storage: input.storage,
    bucket: input.bucket,
    root: input.root,
    publication: publication.value,
    attempt: committed.value.kind === "committed" ? "first" : "resumed",
  });
  if (!uploaded.ok) return uploaded;
  const published = input.storage.transactionSync(
    markHarnessCheckpointPublishedInTransaction.bind(
      null,
      input.storage.sql,
      publication.value,
    ),
  );
  return published.ok ? committed : published;
}
