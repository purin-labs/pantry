/// <reference types="@cloudflare/workers-types" />

import { DatabaseSync } from "node:sqlite";
import type {
  HarnessTurnLease,
  StoredMessageAttachment,
} from "@purin-labs/contracts";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { EmbeddedHarnessUserInput } from "@purin-labs/agent/actors/embedded-harness";
import {
  MESSAGE_PREPARATION_LIMITS,
  type MessagePreparationAttempt,
  messagePreparationIdentity,
  prepareAcceptedMessageAttachment,
  readAcceptedMessageAttachment,
} from "@purin-labs/agent/actors/message-preparation";
import {
  beginMessagePreparation,
  createMessagePreparationSchema,
  readMessagePreparation,
} from "@purin-labs/agent/actors/message-preparation-store";
import { parseStoredAttachment } from "@purin-labs/agent/messages/stored-attachment";
import {
  emptySqliteFixture,
  sqlStorage,
  TestSqlStorage,
} from "./sqlite-storage";
import { isRecord } from "@purin-labs/std";

const mocks = vi.hoisted(function createMocks() {
  return { preflight: vi.fn() };
});

vi.mock(
  "@purin-labs/agent/actors/agent-session-harness-authority",
  function mockHarnessAuthority() {
    return { preflightHarnessTurnLease: mocks.preflight };
  },
);

type PreparedInput = Exclude<
  EmbeddedHarnessUserInput,
  { readonly kind: "text" }
>;

describe("message preparation pipeline", function messagePreparationSuite() {
  beforeEach(function allowLiveLease() {
    mocks.preflight.mockReset();
    mocks.preflight.mockImplementation(function allow(
      _storage: DurableObjectStorage,
      lease: HarnessTurnLease,
      _now: number,
    ) {
      return { ok: true, value: lease };
    });
  });

  test("reuses an accepted snapshot without calling the materializer again", async function reusesAcceptedSnapshot() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(3);
    let materializations = 0;

    const first = await runPreparation(
      storage,
      archive,
      lease,
      source,
      async function materialize() {
        materializations += 1;
        return [preparedText(source)];
      },
    );
    expect(first).toMatchObject({
      ok: true,
      value: {
        inputs: [{ kind: "attachment_text", text: "espresso,3.50" }],
        receipt: { outcome: { kind: "prepared" } },
      },
    });
    expect(materializations).toBe(1);

    const second = await runPreparation(
      storage.restart(),
      archive,
      lease,
      source,
      async function noRerun() {
        throw new Error("materializer_reran");
      },
    );
    expect(second).toEqual(first);
    expect(materializations).toBe(1);

    const replayed = await readAcceptedMessageAttachment({
      authorizeExecution: authorizePreparationFixture,
      storage: storage.restart().binding(),
      archive: archive.binding(),
      lease,
      attachment: source,
    });
    expect(replayed).toEqual({
      ok: true,
      value: first.ok ? first.value.inputs : [],
    });
  });

  test("recovers a result written to R2 after the SQL completion is interrupted", async function recoversAfterR2Write() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(3);
    let materializations = 0;

    storage.failNextCompletion = true;
    const interrupted = await runPreparation(
      storage,
      archive,
      lease,
      source,
      async function materialize() {
        materializations += 1;
        return [preparedText(source)];
      },
    );
    expect(interrupted).toEqual({
      ok: false,
      error: {
        code: "embedded_harness_attachment_preparation_failed",
        attachmentId: source.id,
        reason: "simulated_crash_after_r2",
      },
    });
    expect(materializations).toBe(1);
    expect(archive.keys()).toHaveLength(1);
    expect(
      readMessagePreparation(
        storage.sql,
        messagePreparationIdentity(lease, source),
      ),
    ).toMatchObject({
      ok: true,
      value: { kind: "pending" },
    });

    const recovered = await runPreparation(
      storage.restart(),
      archive,
      lease,
      source,
      async function noRerun() {
        throw new Error("materializer_reran");
      },
    );
    expect(recovered).toMatchObject({
      ok: true,
      value: { inputs: [{ kind: "attachment_text", text: "espresso,3.50" }] },
    });
    expect(materializations).toBe(1);
    expect(
      readMessagePreparation(
        storage.sql,
        messagePreparationIdentity(lease, source),
      ),
    ).toMatchObject({
      ok: true,
      value: { kind: "completed" },
    });
  });

  test("retries an interrupted preparation only on a replacement lease", async function recoversOnReplacementLease() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(3);
    const attempts: MessagePreparationAttempt[] = [];
    let initialDeadlineAt = 0;
    let recoveryDeadlineAt = 0;

    const interrupted = await runPreparation(
      storage,
      archive,
      lease,
      source,
      async function interrupt(deadlineAt, attempt) {
        initialDeadlineAt = deadlineAt;
        attempts.push(attempt);
        throw new Error("materializer_interrupted");
      },
    );
    expect(interrupted).toMatchObject({
      ok: false,
      error: { reason: "materializer_interrupted" },
    });

    const pending = readMessagePreparation(
      storage.sql,
      messagePreparationIdentity(lease, source),
    );
    if (!pending.ok || pending.value?.kind !== "pending")
      throw new Error("preparation fixture did not persist pending state");

    const recovered = await runPreparation(
      storage.restart(),
      archive,
      replacementLease(lease),
      source,
      async function recover(deadlineAt, attempt) {
        recoveryDeadlineAt = deadlineAt;
        attempts.push(attempt);
        return [preparedText(source)];
      },
    );

    expect(recovered).toMatchObject({
      ok: true,
      value: { inputs: [{ kind: "attachment_text" }] },
    });
    expect(
      attempts.map(function attemptKind(attempt) {
        return attempt.kind;
      }),
    ).toEqual(["initial", "recovery"]);
    expect(initialDeadlineAt).toBe(pending.value.deadlineAt);
    expect(recoveryDeadlineAt).toBe(pending.value.deadlineAt);
  });

  test("coalesces concurrent preparations for one storage and attachment", async function coalescesActivePreparation() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(3);
    let resolveMaterialization!: () => void;
    let notifyStarted!: () => void;
    const materializationReleased = new Promise<void>(function waitForRelease(
      resolve,
    ) {
      resolveMaterialization = resolve;
    });
    const materializationStarted = new Promise<void>(function waitForStart(
      resolve,
    ) {
      notifyStarted = resolve;
    });
    let materializations = 0;

    const first = runPreparation(
      storage,
      archive,
      lease,
      source,
      async function holdMaterialization() {
        materializations += 1;
        notifyStarted();
        await materializationReleased;
        return [preparedText(source)];
      },
    );
    await materializationStarted;

    const second = runPreparation(
      storage,
      archive,
      lease,
      source,
      async function duplicateMaterialization() {
        throw new Error("materializer_reran");
      },
    );
    resolveMaterialization();

    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual(results[0]);
    expect(materializations).toBe(1);
  });

  test("keeps an expired pending preparation terminal", async function refusesExpiredPendingRecovery() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(3);
    const identity = messagePreparationIdentity(lease, source);
    const now = Date.now();
    const pending = {
      kind: "pending" as const,
      identity,
      limits: MESSAGE_PREPARATION_LIMITS,
      startedAt: now - 2_000,
      deadlineAt: now - 1,
    };
    expect(beginMessagePreparation(storage.sql, pending)).toMatchObject({
      ok: true,
    });
    let materializations = 0;

    const result = await runPreparation(
      storage,
      archive,
      replacementLease(lease),
      source,
      async function mustNotMaterialize() {
        materializations += 1;
        return [preparedText(source)];
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "embedded_harness_attachment_preparation_failed",
        reason: "preparation_deadline_exceeded",
      },
    });
    expect(materializations).toBe(0);
  });

  test("rejects an R2 snapshot whose output digest was modified", async function rejectsModifiedOutput() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(3);

    const prepared = await runPreparation(
      storage,
      archive,
      lease,
      source,
      async function materialize() {
        return [preparedText(source)];
      },
    );
    expect(prepared).toMatchObject({ ok: true });
    const objectKey = preparedObjectKey(prepared);
    archive.replaceReceiptDigest(objectKey, "f".repeat(64));

    expect(
      await readAcceptedMessageAttachment({
        authorizeExecution: authorizePreparationFixture,
        storage: storage.binding(),
        archive: archive.binding(),
        lease,
        attachment: source,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "embedded_harness_attachment_preparation_failed",
        attachmentId: source.id,
        reason: "preparation_receipt_mismatch",
      },
    });
  });

  test("records an oversized attachment as an unread manifest without reading it", async function limitsOversizedSource() {
    const storage = new PreparationStorage();
    const archive = new MemoryBucket();
    const lease = preparationLease();
    const source = preparationAttachment(
      MESSAGE_PREPARATION_LIMITS.maxInputBytes + 1,
    );
    let materializations = 0;

    const prepared = await runPreparation(
      storage,
      archive,
      lease,
      source,
      async function mustNotRead() {
        materializations += 1;
        throw new Error("oversized_source_was_read");
      },
    );
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        inputs: [
          {
            kind: "attachment_manifest",
            manifest: expect.stringContaining(
              "preparation=source_too_large; content unread",
            ),
          },
        ],
        receipt: { usage: { inputBytes: 0 } },
      },
    });
    expect(materializations).toBe(0);
  });
});

async function runPreparation(
  storage: PreparationStorage,
  archive: MemoryBucket,
  lease: HarnessTurnLease,
  attachment: StoredMessageAttachment,
  materialize: (
    deadlineAt: number,
    attempt: MessagePreparationAttempt,
  ) => Promise<readonly PreparedInput[]>,
) {
  return prepareAcceptedMessageAttachment({
    storage: storage.binding(),
    archive: archive.binding(),
    lease,
    attachment,
    deadlineAt: Date.now() + 30_000,
    materialize,
  });
}

function preparedText(attachment: StoredMessageAttachment): PreparedInput {
  return {
    kind: "attachment_text",
    manifest: "text/csv; extracted=bounded",
    text: "espresso,3.50",
    truncated: false,
    attachment,
  };
}

function preparedObjectKey(
  prepared: Awaited<ReturnType<typeof prepareAcceptedMessageAttachment>>,
): string {
  if (!prepared.ok || prepared.value.receipt.outcome.kind !== "prepared") {
    throw new Error("preparation fixture did not produce a prepared receipt");
  }
  return prepared.value.receipt.outcome.resultObjectKey;
}

function replacementLease(lease: HarnessTurnLease): HarnessTurnLease {
  const issuedAt = Date.now() + 1;
  return {
    ...lease,
    leaseId: "harness_lease_replacement",
    runtimeLease: { ...lease.runtimeLease, leaseId: "runtime_replacement" },
    issuedAt,
    expiresAt: issuedAt + 60_000,
  };
}

function preparationAttachment(byteLength: number): StoredMessageAttachment {
  const sha256 = "a".repeat(64);
  const parsed = parseStoredAttachment({
    byteLength,
    descriptor: {
      kind: "document",
      media: {
        kind: "provider_declared",
        mediaType: "text/csv",
        provider: "slack",
      },
    },
    displayName: "menu.csv",
    extensionHint: { kind: "none" },
    id: `att_${"a".repeat(32)}`,
    objectKey: `attachments/organisation_preparation/slack/${sha256}`,
    retention: "session",
    sha256,
    source: {
      kind: "slack",
      integrationAccountId: "account_preparation",
      workspaceId: "workspace_preparation",
      channelId: "channel_preparation",
      messageTs: "1700000000.000100",
      fileId: "file_preparation",
      revision: "1",
    },
    storedAt: 1_700_000_000,
  });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function preparationLease(): HarnessTurnLease {
  const now = Date.now();
  return {
    leaseId: "harness_lease_preparation",
    session: {
      organisationId: "organisation_preparation",
      sessionId: "session_preparation",
      streamId: "stream_preparation",
    },
    turn: {
      turnId: "turn_preparation",
      inputId: "input_preparation",
      turnLeaseGeneration: 1,
      budgetRevision: "budget_preparation",
    },
    runtimeLease: { generation: 1, leaseId: "runtime_preparation" },
    runtimeRevision: "runtime_preparation",
    requestAuthority: {
      kind: "workflow",
      organisationId: "organisation_preparation",
      workflowId: "workflow_preparation",
      workflowRevision: 1,
    },
    authorityPartitionDigest: "b".repeat(64),
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
  };
}

class PreparationStorage {
  readonly database: DatabaseSync;
  readonly sql: SqlStorage;
  failNextCompletion = false;
  private transactionCount = 0;

  constructor(database = emptySqliteFixture().database) {
    this.database = database;
    this.sql = sqlStorage(new TestSqlStorage(database));
    createMessagePreparationSchema(this.sql);
  }

  binding(): DurableObjectStorage {
    return this as unknown as DurableObjectStorage;
  }

  restart(): PreparationStorage {
    return new PreparationStorage(this.database);
  }

  transactionSync<Value>(operation: () => Value): Value {
    this.transactionCount += 1;
    if (this.failNextCompletion && this.transactionCount === 2) {
      this.failNextCompletion = false;
      throw new Error("simulated_crash_after_r2");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class MemoryBucket {
  private readonly objects = new Map<string, Uint8Array>();

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  async put(
    key: string,
    value: string | Uint8Array,
    _options?: unknown,
  ): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }

  async get(key: string): Promise<unknown> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return null;
    return {
      size: bytes.byteLength,
      text: async function readText() {
        return new TextDecoder().decode(bytes);
      },
    };
  }

  replaceReceiptDigest(key: string, resultDigest: string): void {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error("preparation_object_missing");
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(raw) || !isRecord(raw.receipt))
      throw new Error("preparation_object_invalid");
    raw.receipt.resultDigest = resultDigest;
    this.objects.set(key, new TextEncoder().encode(JSON.stringify(raw)));
  }
}

async function authorizePreparationFixture(): Promise<void> {}
