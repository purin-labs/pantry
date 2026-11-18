/// <reference types="@cloudflare/workers-types" />

import type {
  AgentSessionLifecycle,
  EventEnvelope,
  HarnessCheckpointRecord,
  SessionTransition,
} from "@seams/contracts";
import { describe, expect, test } from "vitest";
import {
  commitAcceptedSessionInput,
  commitCompletedSessionTurn,
  commitExecutionRequestedSession,
  commitExecutionSettledSession,
  commitInitializedCaseSession,
  commitInitializedSession,
  commitQuarantinedSession,
  commitRuntimeActivatedSession,
  commitStartedSession,
  readAcceptedSessionInput,
  readSessionTurnModelContext,
  type AcceptedSessionInputCommit,
  type ActorTransactionStorage,
  type CancellationResolvedSessionCommit,
  type ActiveLeaseCancellationStartedSessionCommit,
  type CheckpointCommittedSessionCommit,
  type CheckpointingStartedSessionCommit,
  type ExecutionRequestedSessionCommit,
  type ExecutionSettledSessionCommit,
  type InitializedCaseSessionCommit,
  type InitializedSessionCommit,
  type QuarantinedSessionCommit,
  type RuntimeActivatedSessionCommit,
} from "../src/actors/actor-journal";
import {
  commitCancellationResolvedSession,
  commitCancellationStartedSession,
  commitCheckpointingStartedSession,
  recoverInterruptedSessionInTransaction,
} from "../src/actors/actor-journal/transactions";
import {
  claimRunCapability,
  createSessionBudgetAccount,
  readSessionBudgetAccount,
  reserveRunBudget,
  settleRunBudget,
} from "../src/actors/agent-session-budget";
import {
  appendHarnessHistory,
  acceptHarnessEvent,
  canonicalHarnessCheckpointObjectKey,
  commitHarnessCheckpoint,
  type CommitHarnessCheckpointInput,
} from "../src/actors/agent-session-harness-authority";
import type { HarnessHistoryEntry } from "../src/actors/harness-history";
import { createActorActivationSchema } from "../src/actors/actor-activation";
import {
  CANONICAL_SESSION_SCHEMA_VERSION,
  createActorJournalSchema,
  createSessionSchema,
} from "../src/actors/agent-session-schema";
import {
  readCanonicalSessionProjection,
  readVerifiedImportedCanonicalSession,
} from "../src/actors/agent-session-canonical";
import {
  beginSessionTurnStream,
  readSessionTurnReplay,
} from "../src/actors/agent-session-turn-stream";
import { parseSessionTurnInputDigest } from "../src/actors/agent-session-turn-input-digest";
import { buildCanonicalTextTurnStart } from "../src/actors/agent-session-turn-start";
import {
  buildTextTurnCheckpointCommittedCommit,
  buildTextTurnCheckpointingCommit,
} from "../src/actors/agent-session-text-turn";
import {
  markPantryExecutionDispatched,
  readPantryExecutionBilling,
  writePantryExecutionAdmissionInTransaction,
} from "../src/account-platform/execution-billing";
import { parsePantryAccountBinding } from "../src/account-platform/types";
import { prepareSessionInformationFlow } from "../src/actors/agent-session-information-flow";
import type { CodeModeOrganisationReserveInput } from "../src/actors/code-mode-budget";
import {
  parseRequestId,
  parseSessionId,
  parseOrganisationId,
} from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import type { Variant } from "@seams/type-utils";

describe("Actor journal transaction", function actorJournalTransactionSuite() {
  test(
    "quarantines interrupted work that cannot end as a failed turn, and blocks retries until effects are reconciled",
    quarantinesInterruptedRun,
  );
  test(
    "rolls back interruption recovery if its journal cannot commit",
    rollsBackInterruptedRun,
  );
  test(
    "initializes a fresh canonical session exactly once",
    initializesFreshSession,
  );
  test(
    "rejects duplicate Case initialization when the migrated budget account is missing",
    rejectsDuplicateCaseInitializationWithoutBudget,
  );
  test("accepts one input and converges exact redelivery", async function acceptsAndDeduplicates() {
    const fixture = await acceptedTransactionFixture();
    const input = acceptedInputCommit();

    expect(commitAcceptedSessionInput(fixture.storage, input)).toEqual({
      ok: true,
      value: { kind: "accepted", eventId: "event_1", sequence: 1 },
    });
    expect(commitAcceptedSessionInput(fixture.storage, input)).toEqual({
      ok: true,
      value: { kind: "duplicate", eventId: "event_1", sequence: 1 },
    });

    expect(readCount(fixture.database, "actor_journal")).toBe(2);
    expect(readCount(fixture.database, "actor_inbox")).toBe(2);
    expect(readCount(fixture.database, "actor_outbox")).toBe(0);
    expect(
      readAcceptedSessionInput(fixture.storage.sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        streamId: "stream_1",
        turnId: "turn_1",
        inputId: "input_1",
      }),
    ).toEqual({
      ok: true,
      value: input.event.body.input,
    });
    expect(
      readText(
        fixture.database,
        "SELECT lifecycle_kind FROM session_meta",
        "lifecycle_kind",
      ),
    ).toBe("activating");
    await expect(
      readVerifiedImportedCanonicalSession(
        fixture.storage.sql,
        "organisation_1",
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "activating" } },
    });

    const conflicting = acceptedInputCommit();
    conflicting.commandId = "command_2";
    expect(commitAcceptedSessionInput(fixture.storage, conflicting)).toEqual({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(readCount(fixture.database, "actor_journal")).toBe(2);
  });

  test("rolls back every durable record when projection fails", async function rollsBackProjectionFailure() {
    const fixture = await acceptedTransactionFixture();
    const input = acceptedInputCommit();
    fixture.database.exec(
      `CREATE TRIGGER reject_canonical_projection
       BEFORE UPDATE ON session_meta
       BEGIN SELECT RAISE(ABORT, 'projection_rejected'); END`,
    );

    expect(function commitWithRejectedProjection() {
      commitAcceptedSessionInput(fixture.storage, input);
    }).toThrow("projection_rejected");

    expect(readCount(fixture.database, "actor_journal")).toBe(1);
    expect(readCount(fixture.database, "actor_inbox")).toBe(1);
    expect(readCount(fixture.database, "actor_outbox")).toBe(0);
    expect(
      readText(
        fixture.database,
        "SELECT lifecycle_kind FROM session_meta",
        "lifecycle_kind",
      ),
    ).toBe("sleeping");
  });

  test("rejects an accepted-input transition that the Rust reducer rejects", async function rejectsInvalidInputTransition() {
    const fixture = await acceptedTransactionFixture();
    const input = acceptedInputCommit();
    input.event.body.state.inputId = "input_other";

    expect(commitAcceptedSessionInput(fixture.storage, input)).toEqual({
      ok: false,
      error: { code: "invalid_transition" },
    });
    expect(readCount(fixture.database, "actor_journal")).toBe(1);
    expect(readCount(fixture.database, "actor_inbox")).toBe(1);
    expect(readCount(fixture.database, "actor_outbox")).toBe(0);
  });

  test("activates one runtime and atomically issues its harness lease", async function activatesRuntime() {
    const fixture = await acceptedTransactionFixture();
    expect(
      commitAcceptedSessionInput(fixture.storage, acceptedInputCommit()).ok,
    ).toBe(true);
    const input = runtimeActivatedCommit();

    expect(commitRuntimeActivatedSession(fixture.storage, input)).toEqual({
      ok: true,
      value: { kind: "accepted", eventId: "event_2", sequence: 2 },
    });
    expect(commitRuntimeActivatedSession(fixture.storage, input)).toEqual({
      ok: true,
      value: { kind: "duplicate", eventId: "event_2", sequence: 2 },
    });
    expect(readCount(fixture.database, "actor_journal")).toBe(3);
    expect(readCount(fixture.database, "actor_inbox")).toBe(3);
    expect(readCount(fixture.database, "session_harness_lease")).toBe(1);
    await expect(
      readVerifiedImportedCanonicalSession(
        fixture.storage.sql,
        "organisation_1",
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "processing" } },
    });

    const changed = runtimeActivatedCommit();
    changed.harnessLease.expiresAt = 200;
    expect(commitRuntimeActivatedSession(fixture.storage, changed)).toEqual({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
  });

  test("rolls back the harness lease when runtime projection fails", async function rollsBackRuntimeActivation() {
    const fixture = await acceptedTransactionFixture();
    expect(
      commitAcceptedSessionInput(fixture.storage, acceptedInputCommit()).ok,
    ).toBe(true);
    fixture.database.exec(
      `CREATE TRIGGER reject_runtime_projection
       BEFORE UPDATE ON session_meta
       BEGIN SELECT RAISE(ABORT, 'runtime_projection_rejected'); END`,
    );

    expect(function commitRejectedRuntimeProjection() {
      commitRuntimeActivatedSession(fixture.storage, runtimeActivatedCommit());
    }).toThrow("runtime_projection_rejected");
    expect(readCount(fixture.database, "actor_journal")).toBe(2);
    expect(readCount(fixture.database, "actor_inbox")).toBe(2);
    expect(readCount(fixture.database, "session_harness_lease")).toBe(0);
    expect(
      readText(
        fixture.database,
        "SELECT lifecycle_kind FROM session_meta",
        "lifecycle_kind",
      ),
    ).toBe("activating");
  });

  test("atomically fences the harness before resolving cancellation", async function cancelsHarnessTurn() {
    const fixture = await processingTransactionFixture();
    const started = cancellationStartedCommit();

    expect(commitCancellationStartedSession(fixture.storage, started)).toEqual({
      ok: true,
      value: { kind: "accepted", eventId: "event_cancel_1", sequence: 3 },
    });
    expect(commitCancellationStartedSession(fixture.storage, started)).toEqual({
      ok: true,
      value: { kind: "duplicate", eventId: "event_cancel_1", sequence: 3 },
    });
    expect(readCount(fixture.database, "session_harness_lease")).toBe(0);
    expect(
      acceptHarnessEvent(fixture.storage, {
        leaseId: started.harnessLease.leaseId,
        sessionId: started.harnessLease.session.sessionId,
        turn: started.harnessLease.turn,
        sequence: 1,
        eventDigest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        payload: '{"kind":"delta","text":"late"}',
        acceptedAt: 13,
      }),
    ).toEqual({
      ok: false,
      error: { code: "harness_lease_missing" },
    });

    const resolved = cancellationResolvedCommit();
    expect(
      commitCancellationResolvedSession(fixture.storage, resolved),
    ).toEqual({
      ok: true,
      value: { kind: "accepted", eventId: "event_cancel_2", sequence: 4 },
    });
    await expect(
      readVerifiedImportedCanonicalSession(
        fixture.storage.sql,
        "organisation_1",
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          kind: "checkpointing",
          state: { outcome: "cancelled" },
        },
      },
    });
  });

  test("checkpoints one completed harness turn and closes its lease atomically", async function checkpointsCompletedTurn() {
    const fixture = await processingTransactionFixture();
    const checkpoint = await acceptedHarnessCheckpoint(fixture.storage);
    const started = checkpointingStartedCommit(checkpoint);
    const completed = await checkpointCommittedCommit(
      checkpoint,
      started.state,
    );

    expect(commitCheckpointingStartedSession(fixture.storage, started)).toEqual(
      {
        ok: true,
        value: {
          kind: "accepted",
          eventId: started.event.eventId,
          sequence: 3,
        },
      },
    );
    expect(
      commitCompletedSessionTurn(fixture.storage, {
        checkpoint: completed,
        lastSequence: checkpoint.cursor.lastSequence - 1,
        completedAt: checkpoint.blob.createdAt,
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "accepted",
        eventId: completed.event.eventId,
        sequence: 4,
      },
    });
    expect(commitCheckpointingStartedSession(fixture.storage, started)).toEqual(
      {
        ok: true,
        value: {
          kind: "duplicate",
          eventId: started.event.eventId,
          sequence: 3,
        },
      },
    );
    expect(
      commitCompletedSessionTurn(fixture.storage, {
        checkpoint: completed,
        lastSequence: checkpoint.cursor.lastSequence - 1,
        completedAt: checkpoint.blob.createdAt,
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "duplicate",
        eventId: completed.event.eventId,
        sequence: 4,
      },
    });
    expect(
      commitRuntimeActivatedSession(fixture.storage, runtimeActivatedCommit()),
    ).toEqual({
      ok: true,
      value: { kind: "duplicate", eventId: "event_2", sequence: 2 },
    });
    expect(readCount(fixture.database, "actor_journal")).toBe(5);
    expect(readCount(fixture.database, "actor_inbox")).toBe(5);
    expect(readCount(fixture.database, "session_harness_checkpoint")).toBe(1);
    expect(readCount(fixture.database, "session_harness_lease")).toBe(0);
    expect(
      readPantryExecutionBilling(fixture.storage.sql, checkpoint.turn.turnId),
    ).toMatchObject({
      kind: "customer_unpriced",
      phase: {
        kind: "recorded",
        terminal: {
          kind: "completed",
          sourceRecordId: `finalize_${checkpoint.turn.turnId}_${checkpoint.cursor.lastSequence}`,
          sourceDigest: checkpoint.blob.sha256,
          occurredAt: checkpoint.blob.createdAt,
        },
      },
    });
    await expect(
      readVerifiedImportedCanonicalSession(
        fixture.storage.sql,
        "organisation_1",
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { lifecycle: { kind: "sleeping" } },
    });
  });

  test("accepts one execution receipt under the active harness lease", async function acceptsExecutionReceipt() {
    const fixture = await processingTransactionFixture();
    expect(
      commitExecutionRequestedSession(
        fixture.storage,
        executionRequestedCommit(),
      ).ok,
    ).toBe(true);
    markExecutionDispatching(fixture.database);
    const input = executionSettledCommit();

    expect(commitExecutionSettledSession(fixture.storage, input)).toEqual({
      ok: true,
      value: { kind: "accepted", eventId: "event_execution_1", sequence: 4 },
    });
    expect(commitExecutionSettledSession(fixture.storage, input)).toEqual({
      ok: true,
      value: { kind: "duplicate", eventId: "event_execution_1", sequence: 4 },
    });
    await expect(
      readVerifiedImportedCanonicalSession(
        fixture.storage.sql,
        "organisation_1",
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          kind: "processing",
          state: { activeTurn: { kind: "reducing_result" } },
        },
      },
    });
    expect(
      readText(
        fixture.database,
        "SELECT state_kind FROM actor_outbox WHERE effect_id = 'execution-cmx_execution_1'",
        "state_kind",
      ),
    ).toBe("settled");
  });

  test("rejects stale execution authority before accepting its receipt", async function rejectsStaleExecutionReceipt() {
    const fixture = await processingTransactionFixture();
    expect(
      commitExecutionRequestedSession(
        fixture.storage,
        executionRequestedCommit(),
      ).ok,
    ).toBe(true);
    markExecutionDispatching(fixture.database);
    const input = executionSettledCommit();
    input.harnessLease.runtimeLease.generation = 2;

    expect(commitExecutionSettledSession(fixture.storage, input)).toEqual({
      ok: false,
      error: { code: "invalid_transition" },
    });
    expect(readCount(fixture.database, "actor_journal")).toBe(4);
    expect(
      readText(
        fixture.database,
        "SELECT state_kind FROM actor_outbox WHERE effect_id = 'execution-cmx_execution_1'",
        "state_kind",
      ),
    ).toBe("dispatching");
  });

  test("rejects an execution workspace advance without effect-receipt causation", async function rejectsUnboundWorkspaceAdvance() {
    const fixture = await processingTransactionFixture();
    expect(
      commitExecutionRequestedSession(
        fixture.storage,
        executionRequestedCommit(),
      ).ok,
    ).toBe(true);
    markExecutionDispatching(fixture.database);
    const input = executionSettledCommit();
    const receiptBody = input.event.body.receipt.receipt;
    const activeTurn = input.state.state.activeTurn;
    if (
      receiptBody.kind !== "inline" ||
      activeTurn.kind !== "reducing_result"
    ) {
      throw new Error("invalid execution settlement fixture");
    }
    const unbound = {
      ...receiptBody.value.workspaceRevisionReceipt,
      receiptId: "workspace_receipt_unbound",
      revision: "workspace_revision_unbound",
      causation: { kind: "command" as const, commandId: "command_unbound" },
    };
    receiptBody.value.workspaceRevisionReceipt = unbound;
    activeTurn.state.workspaceRevisionReceipt = unbound;

    expect(commitExecutionSettledSession(fixture.storage, input)).toEqual({
      ok: false,
      error: { code: "invalid_transition" },
    });
    expect(readCount(fixture.database, "actor_journal")).toBe(4);
    expect(
      readText(
        fixture.database,
        "SELECT state_kind FROM actor_outbox WHERE effect_id = 'execution-cmx_execution_1'",
        "state_kind",
      ),
    ).toBe("dispatching");
  });

  test("rolls back receipt acceptance when settlement finalization fails", async function rollsBackReceiptSettlement() {
    const fixture = await processingTransactionFixture();
    expect(
      commitExecutionRequestedSession(
        fixture.storage,
        executionRequestedCommit(),
      ).ok,
    ).toBe(true);
    markExecutionDispatching(fixture.database);
    const input = executionSettledCommit();
    fixture.database.exec(
      `CREATE TRIGGER reject_execution_settlement
       BEFORE UPDATE ON actor_outbox
       WHEN OLD.effect_id = 'execution-cmx_execution_1'
       BEGIN SELECT RAISE(ABORT, 'settlement_rejected'); END`,
    );

    expect(function commitRejectedSettlement() {
      commitExecutionSettledSession(fixture.storage, input);
    }).toThrow("settlement_rejected");
    expect(readCount(fixture.database, "actor_journal")).toBe(4);
    expect(
      readText(
        fixture.database,
        "SELECT lifecycle_kind FROM session_meta",
        "lifecycle_kind",
      ),
    ).toBe("processing");
  });

  test("journals an indeterminate execution and quarantines the session atomically", async function quarantinesIndeterminateExecution() {
    const fixture = await processingTransactionFixture();
    const input = quarantinedSessionCommit();
    seedExecutionSettlementOutbox(fixture.database, input.settlementEffectId);

    expect(commitQuarantinedSession(fixture.storage, input)).toEqual({
      ok: true,
      value: {
        kind: "accepted",
        eventId: "event_indeterminate_1",
        sequence: 3,
      },
    });
    expect(commitQuarantinedSession(fixture.storage, input)).toEqual({
      ok: true,
      value: {
        kind: "duplicate",
        eventId: "event_indeterminate_1",
        sequence: 3,
      },
    });
    await expect(
      readVerifiedImportedCanonicalSession(
        fixture.storage.sql,
        "organisation_1",
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          kind: "quarantined",
          state: {
            reason: "effect_indeterminate",
            recovery: { kind: "terminate_only" },
          },
        },
      },
    });
    expect(
      readText(
        fixture.database,
        "SELECT state_kind FROM actor_outbox WHERE effect_id = 'effect_settlement_1'",
        "state_kind",
      ),
    ).toBe("indeterminate");
  });

  test("rolls back lease closure when the sleeping projection fails", async function rollsBackCheckpointCompletion() {
    const fixture = await processingTransactionFixture();
    const checkpoint = await acceptedHarnessCheckpoint(fixture.storage);
    const started = checkpointingStartedCommit(checkpoint);
    const completed = await checkpointCommittedCommit(
      checkpoint,
      started.state,
    );
    expect(commitCheckpointingStartedSession(fixture.storage, started).ok).toBe(
      true,
    );
    fixture.database.exec(
      `CREATE TRIGGER reject_sleeping_projection
       BEFORE UPDATE ON session_meta
       BEGIN SELECT RAISE(ABORT, 'sleeping_projection_rejected'); END`,
    );

    expect(function commitRejectedSleepingProjection() {
      commitCompletedSessionTurn(fixture.storage, {
        checkpoint: completed,
        lastSequence: checkpoint.cursor.lastSequence - 1,
        completedAt: checkpoint.blob.createdAt,
      });
    }).toThrow("sleeping_projection_rejected");
    expect(readCount(fixture.database, "actor_journal")).toBe(4);
    expect(readCount(fixture.database, "session_harness_lease")).toBe(1);
    expect(
      readPantryExecutionBilling(fixture.storage.sql, checkpoint.turn.turnId),
    ).toMatchObject({
      kind: "customer_unpriced",
      phase: { kind: "dispatched" },
    });
    expect(
      readText(
        fixture.database,
        "SELECT lifecycle_kind FROM session_meta",
        "lifecycle_kind",
      ),
    ).toBe("checkpointing");
  });
});

async function initializesFreshSession(): Promise<void> {
  const fixture = transactionFixture();
  const commit = initializedSessionCommit();
  expect(commitInitializedSession(fixture.storage, commit)).toEqual({
    ok: true,
    value: { kind: "accepted", eventId: "event_initialize_1", sequence: 0 },
  });
  expect(commitInitializedSession(fixture.storage, commit)).toEqual({
    ok: true,
    value: { kind: "duplicate", eventId: "event_initialize_1", sequence: 0 },
  });
  expect(
    readCanonicalSessionProjection(
      fixture.storage.sql,
      "organisation_1",
      "session_1",
    ),
  ).toMatchObject({
    kind: "sleeping",
    state: { resumePoint: { kind: "new" } },
  });
  expect(
    fixture.database
      .prepare("PRAGMA table_info(session_turn_context)")
      .all()
      .map((row) => (row as { readonly name: string }).name),
  ).toEqual([
    "turn_id",
    "organisation_id",
    "session_id",
    "bundle_digest",
    "bundle_json",
  ]);
  const start = buildCanonicalTextTurnStart({
    current: commit.state,
    request: canonicalTextTurnStartRequest(),
  });
  expect(start.ok).toBe(true);
  if (!start.ok) return;
  const budget = createSessionBudgetAccount(fixture.storage.sql, {
    organisationId: "organisation_1",
    sessionId: "session_1",
    operationId: "budget_initialize_start_1",
    now: 10,
    budget: {
      budgetRevision: "budget_1",
      maxTokens: 10_000,
      maxWallMs: 60_000,
      maxToolCalls: 20,
    },
  });
  expect(budget.ok).toBe(true);
  const requestId = parseRequestId("request_start_1");
  const organisationId = parseOrganisationId("organisation_1");
  const inputDigest = parseSessionTurnInputDigest("f".repeat(64));
  if (!requestId.ok || !organisationId.ok || !inputDigest.ok) {
    throw new Error("invalid start identity fixture");
  }
  const informationFlow = await prepareSessionInformationFlow({
    sql: fixture.storage.sql,
    organisationId: "organisation_1",
    sessionId: "session_1",
    turnId: start.value.harnessLease.turn.turnId,
    authorityPartitionDigest: start.value.harnessLease.authorityPartitionDigest,
    contextBundle: sessionTurnContext().bundle,
  });
  expect(informationFlow.ok).toBe(true);
  if (!informationFlow.ok) return;
  expect(
    commitStartedSession(fixture.storage, {
      acceptedInput: start.value.acceptedInput,
      activatedRuntime: {
        ...start.value.activatedRuntime,
        harnessLease: {
          ...start.value.harnessLease,
          runtimeLease: { generation: 9, leaseId: "runtime_lease_invalid" },
        },
      },
      attachments: [],
      context: sessionTurnContext(),
      informationFlow: informationFlow.value,
      stream: {
        turnId: start.value.harnessLease.turn.turnId,
        requestId: requestId.value,
        organisationId: organisationId.value,
        inputDigest: inputDigest.value,
        startedAt: 11,
      },
    }).ok,
  ).toBe(false);
  expect(readCount(fixture.database, "actor_journal")).toBe(1);
  expect(
    readCanonicalSessionProjection(
      fixture.storage.sql,
      "organisation_1",
      "session_1",
    ),
  ).toMatchObject({ kind: "sleeping" });
  expect(
    commitStartedSession(fixture.storage, {
      acceptedInput: start.value.acceptedInput,
      activatedRuntime: start.value.activatedRuntime,
      attachments: [],
      context: sessionTurnContext(),
      informationFlow: informationFlow.value,
      stream: {
        turnId: start.value.harnessLease.turn.turnId,
        requestId: requestId.value,
        organisationId: organisationId.value,
        inputDigest: inputDigest.value,
        startedAt: 11,
      },
    }),
  ).toMatchObject({
    ok: true,
    value: { stream: "started" },
  });
  expect(readCount(fixture.database, "session_harness_lease")).toBe(1);
  await expect(
    readSessionTurnModelContext(fixture.storage.sql, {
      turnId: start.value.harnessLease.turn.turnId,
      organisationId: "organisation_1",
      sessionId: "session_1",
    }),
  ).resolves.toEqual({ ok: true, value: sessionTurnContext() });
}

function rejectsDuplicateCaseInitializationWithoutBudget(): void {
  const fixture = transactionFixture();
  const input = initializedCaseSessionCommit();
  expect(commitInitializedCaseSession(fixture.storage, input)).toEqual({
    ok: true,
    value: {
      kind: "accepted",
      eventId: input.initialization.event.eventId,
      sequence: 0,
    },
  });

  fixture.database.exec(
    "DELETE FROM session_budget_event; DELETE FROM session_budget_account;",
  );

  expect(commitInitializedCaseSession(fixture.storage, input)).toEqual({
    ok: false,
    error: { code: "invalid_transition" },
  });
  expect(readCount(fixture.database, "session_budget_account")).toBe(0);
  expect(readCount(fixture.database, "session_case_parent")).toBe(1);
}

async function interruptedRunFixture() {
  const fixture = await processingTransactionFixture();
  const lease = runtimeActivatedCommit().harnessLease;
  const budget = createSessionBudgetAccount(fixture.storage.sql, {
    organisationId: lease.session.organisationId,
    sessionId: lease.session.sessionId,
    operationId: "budget_interruption",
    now: 10,
    budget: {
      budgetRevision: lease.turn.budgetRevision,
      maxTokens: 10_000,
      maxWallMs: 60_000,
      maxToolCalls: 20,
    },
  });
  if (!budget.ok) throw new Error(budget.error.code);
  const run = {
    organisationId: lease.session.organisationId,
    sessionId: lease.session.sessionId,
    runId: "run_interruption",
    reservationId: `reservation_${lease.session.sessionId}_run_interruption_${lease.runtimeLease.generation}_${lease.turn.turnLeaseGeneration}_${lease.turn.budgetRevision}`,
    runtimeGeneration: lease.runtimeLease.generation,
    turnLeaseGeneration: lease.turn.turnLeaseGeneration,
    budgetRevision: lease.turn.budgetRevision,
  };
  expect(
    reserveRunBudget(fixture.storage.sql, {
      ...run,
      turnId: lease.turn.turnId,
      operationId: "reserve_interruption",
      now: 11,
    }).ok,
  ).toBe(true);
  expect(
    claimRunCapability(fixture.storage.sql, {
      ...run,
      claimId: "claim_interruption",
      operationId: "claim_interruption",
      now: 12,
    }).ok,
  ).toBe(true);
  const organisationId = parseOrganisationId(lease.session.organisationId);
  const requestId = parseRequestId("request_interruption");
  const digest = parseSessionTurnInputDigest("a".repeat(64));
  if (!organisationId.ok || !requestId.ok || !digest.ok)
    throw new Error("invalid fixture identity");
  expect(
    beginSessionTurnStream(fixture.storage.sql, {
      organisationId: organisationId.value,
      requestId: requestId.value,
      turnId: lease.turn.turnId,
      inputDigest: digest.value,
      startedAt: 11,
    }).ok,
  ).toBe(true);
  seedExecutionSettlementOutbox(fixture.database, "effect_interruption");
  return { ...fixture, lease, run, organisationId: organisationId.value };
}

async function quarantinesInterruptedRun(): Promise<void> {
  const fixture = await interruptedRunFixture();
  const sibling = await processingTransactionFixture();
  // The quarantine is the fallback for a turn that cannot end as a failed
  // turn (Refactor 15): the constructor tries that end first.
  fixture.storage.transactionSync(
    recoverInterruptedSessionInTransaction.bind(null, fixture.storage.sql, 21),
  );
  expect(
    readCanonicalSessionProjection(
      fixture.storage.sql,
      "organisation_1",
      "session_1",
    ),
  ).toMatchObject({
    kind: "quarantined",
    state: {
      reason: "effect_indeterminate",
      recovery: { kind: "terminate_only" },
    },
  });
  expect(
    readCanonicalSessionProjection(
      sibling.storage.sql,
      "organisation_1",
      "session_1",
    ),
  ).toMatchObject({ kind: "processing" });
  expect(
    readSessionTurnReplay(fixture.storage.sql, {
      organisationId: fixture.organisationId,
      turnId: fixture.lease.turn.turnId,
      afterSequence: -1,
    }),
  ).toMatchObject({
    ok: true,
    value: { state: { kind: "failed", errorDetail: "session_interrupted" } },
  });
  expect(
    readSessionBudgetAccount(fixture.storage.sql, fixture.run),
  ).toMatchObject({
    ok: true,
    value: {
      reservation: {
        kind: "indeterminate",
        reason: "provider_effect_indeterminate",
      },
    },
  });
  expect(
    settleRunBudget(fixture.storage.sql, {
      ...fixture.run,
      operationId: "unsafe_settle",
      now: 21,
      outcome: "failed",
      usage: { tokens: 0, activeWallMs: 10, capabilityCalls: 1 },
    }),
  ).toEqual({ ok: false, error: { code: "budget_reservation_indeterminate" } });
  expect(
    reserveRunBudget(fixture.storage.sql, {
      ...fixture.run,
      runId: "run_retry",
      reservationId: "reservation_retry",
      turnId: "turn_retry",
      operationId: "unsafe_retry",
      now: 21,
    }).ok,
  ).toBe(false);
  expect(
    acceptHarnessEvent(fixture.storage, {
      leaseId: fixture.lease.leaseId,
      sessionId: fixture.lease.session.sessionId,
      turn: fixture.lease.turn,
      sequence: 1,
      eventDigest: "a".repeat(64),
      payload: "{}",
      acceptedAt: 21,
    }),
  ).toEqual({ ok: false, error: { code: "harness_lease_missing" } });
  expect(readCount(fixture.database, "actor_outbox")).toBe(1);
  const events = readCount(fixture.database, "actor_journal");
  fixture.storage.transactionSync(
    recoverInterruptedSessionInTransaction.bind(null, fixture.storage.sql, 22),
  );
  expect(readCount(fixture.database, "actor_journal")).toBe(events);
  await expect(
    readVerifiedImportedCanonicalSession(fixture.storage.sql, "organisation_1"),
  ).resolves.toMatchObject({
    ok: true,
    value: { lifecycle: { kind: "quarantined" } },
  });
}

async function rollsBackInterruptedRun(): Promise<void> {
  const fixture = await interruptedRunFixture();
  fixture.database
    .exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON actor_journal
    BEGIN SELECT RAISE(ABORT, 'recovery_rejected'); END`);
  expect(
    fixture.storage.transactionSync.bind(
      fixture.storage,
      recoverInterruptedSessionInTransaction.bind(
        null,
        fixture.storage.sql,
        20,
      ),
    ),
  ).toThrow("recovery_rejected");
  expect(readCount(fixture.database, "session_harness_lease")).toBe(1);
  expect(
    readSessionBudgetAccount(fixture.storage.sql, fixture.run),
  ).toMatchObject({ ok: true, value: { reservation: { kind: "active" } } });
  expect(
    readSessionTurnReplay(fixture.storage.sql, {
      organisationId: fixture.organisationId,
      turnId: fixture.lease.turn.turnId,
      afterSequence: -1,
    }),
  ).toMatchObject({ ok: true, value: { state: { kind: "running" } } });
}

function transactionFixture(): {
  database: import("node:sqlite").DatabaseSync;
  storage: ActorTransactionStorage;
} {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  createActorActivationSchema(sql);
  createSessionSchema(sql);
  createActorJournalSchema(sql);
  seedActivation(fixture.database);
  return {
    database: fixture.database,
    storage: new TestActorTransactionStorage(fixture.database, sql),
  };
}

async function acceptedTransactionFixture(): Promise<{
  database: import("node:sqlite").DatabaseSync;
  storage: ActorTransactionStorage;
}> {
  const fixture = transactionFixture();
  const initialized = commitInitializedSession(
    fixture.storage,
    initializedSessionCommit(),
  );
  if (!initialized.ok)
    throw new Error(`fixture initialization failed: ${initialized.error.code}`);
  return fixture;
}

async function processingTransactionFixture(): Promise<{
  database: import("node:sqlite").DatabaseSync;
  storage: ActorTransactionStorage;
}> {
  const fixture = await acceptedTransactionFixture();
  const accepted = commitAcceptedSessionInput(
    fixture.storage,
    acceptedInputCommit(),
  );
  if (!accepted.ok)
    throw new Error(`fixture input failed: ${accepted.error.code}`);
  const activated = commitRuntimeActivatedSession(
    fixture.storage,
    runtimeActivatedCommit(),
  );
  if (!activated.ok)
    throw new Error(`fixture activation failed: ${activated.error.code}`);
  return fixture;
}

class TestActorTransactionStorage implements ActorTransactionStorage {
  constructor(
    private readonly database: import("node:sqlite").DatabaseSync,
    readonly sql: SqlStorage,
  ) {}

  transactionSync<T>(callback: () => T): T {
    return runTransaction(this.database, callback);
  }
}

function runTransaction<T>(
  database: import("node:sqlite").DatabaseSync,
  callback: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function acceptedInputCommit(): AcceptedSessionInputCommit {
  const state = activatingState();
  return {
    source: "surface_actor",
    commandId: "command_1",
    event: inputAcceptedEvent(state),
    state,
  };
}

function initializedSessionCommit(): InitializedSessionCommit {
  const state: InitializedSessionCommit["state"] = {
    kind: "sleeping",
    state: {
      identity: {
        organisationId: "organisation_1",
        sessionId: "session_1",
        streamId: "stream_1",
      },
      contract: {
        policyVersion: "policy_1",
        budgetRevision: "budget_1",
        runtimeRevision: "runtime_1",
        modelRoute: {
          keySource: "platform",
          provider: "openai-compatible",
          model: "moonshotai/kimi-k3",
        },
        lastEventSequence: 0,
      },
      resumePoint: {
        kind: "new",
        workspaceRevisionReceipt: workspaceRevisionReceipt(),
      },
    },
  };
  return {
    source: "surface_actor",
    commandId: "command_initialize_1",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_initialize_1",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 0,
      sourceTime: { kind: "satyr", issuedAt: 1 },
      acceptedAt: 1,
      correlationId: "correlation_initialize_1",
      causation: { kind: "command", commandId: "command_initialize_1" },
      idempotencyKey: "initialize_1",
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "surface_actor" },
      sensitivity: "organisation_private",
      retention: "session",
      body: { kind: "session_initialized", state: state.state },
    },
    state,
    projection: {
      threadKey: "thread_1",
      track: "managed-agents",
      startedAt: 1,
    },
  };
}

function initializedCaseSessionCommit(): InitializedCaseSessionCommit {
  const initialization = initializedSessionCommit();
  const assignment: InitializedCaseSessionCommit["assignment"] = {
    assignmentId: "assignment_1",
    caseId: "case_1",
    caseRevision: 0,
    sessionId: "session_1",
    role: "coordinator",
    objective: { instruction: "case instruction" },
    authority: {
      capabilityProfile: "read_and_propose",
      authorityPartitionDigest: "b".repeat(64),
    },
    authorityPartition: {
      digest: "b".repeat(64),
      key: {
        kind: "direct_conversation",
        organisationId: "organisation_1",
        requesterPersonId: "person_1",
        membershipRevision: 1,
        role: "operator",
        integrationAccountId: "account_slack",
        conversationId: "conversation_1",
      },
      selectedGrantSetDigest: "c".repeat(64),
      capabilityKeys: ["platform:workspace.query:1"],
      policyVersion: "policy_1",
    },
    budget: {
      budgetRevision: "budget_1",
      maxTokens: 10,
      maxWallMs: 100,
      maxToolCalls: 2,
    },
    context: {
      evidenceDependency: { kind: "source_only" },
      caseId: "case_1",
      revision: 0,
      journalCursor: { kind: "before_first" },
      workspaceRevision: "workspace_2",
      entries: [],
    },
  };
  return {
    initialization: {
      ...initialization,
      source: "case_actor",
      event: {
        ...initialization.event,
        principal: { kind: "system", componentId: "case_actor" },
      },
    },
    assignment,
  };
}

function canonicalTextTurnStartRequest() {
  const accepted = acceptedInputCommit().event.body;
  return {
    startId: "start_1",
    correlationId: "correlation_1",
    acceptedAt: 10,
    admittedAt: 11,
    harnessLeaseExpiresAt: 100,
    input: accepted.input,
    requestAuthority: {
      kind: "direct_conversation" as const,
      organisationId: "organisation_1",
      requesterPersonId: "person_1",
      membershipRevision: 1,
      role: "operator",
      connectorId: "connector_slack",
      integrationAccountId: "account_slack",
      conversationId: "conversation_1",
    },
    authorityPartitionDigest: "e".repeat(64),
    grantSetDigest: "f".repeat(64),
    turnId: "turn_1",
    runtimeLease: { generation: 1, leaseId: "runtime_lease_1" },
    turnLeaseGeneration: 1,
    origin: {
      kind: "command" as const,
      principal: { kind: "human" as const, principalId: "user_1" },
    },
  };
}

function sessionTurnContext() {
  return {
    projectContext: null,
    bundle: {
      organisationId: "organisation_1",
      caseId: "case_1",
      assignmentId: "assignment_1",
      sessionId: "session_1",
      policyVersion: "policy_1",
      assemblyStrategyVersion: "context_assembly_v1" as const,
      assembledAt: 10,
      items: [],
      usage: { items: 0, estimatedTokens: 0 },
      disposition: { kind: "complete" as const },
    },
    bundleDigest: "e".repeat(64),
    modelContext: {
      assemblyStrategyVersion: "context_assembly_v1" as const,
      items: [],
      disposition: { kind: "complete" as const },
    },
  };
}

function runtimeActivatedCommit(): RuntimeActivatedSessionCommit {
  const state = processingState();
  return {
    source: "capacity_governor",
    commandId: "command_2",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_2",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 2,
      sourceTime: { kind: "satyr", issuedAt: 11 },
      acceptedAt: 11,
      correlationId: "correlation_1",
      causation: { kind: "command", commandId: "command_2" },
      idempotencyKey: "runtime_activation_1",
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "capacity_governor" },
      sensitivity: "organisation_private",
      retention: "session",
      body: { kind: "runtime_activated", state: state.state },
    },
    state,
    harnessLease: {
      leaseId: "harness_lease_1",
      session: state.state.identity,
      turn: state.state.activeTurn.state.identity,
      runtimeLease: state.state.runtimeLease,
      runtimeRevision: state.state.contract.runtimeRevision,
      requestAuthority: {
        kind: "direct_conversation",
        organisationId: "organisation_1",
        requesterPersonId: "person_1",
        membershipRevision: 1,
        role: "operator",
        connectorId: "connector_slack",
        integrationAccountId: "account_slack",
        conversationId: "conversation_1",
      },
      authorityPartitionDigest: "e".repeat(64),
      issuedAt: 11,
      expiresAt: 100,
    },
  };
}

function cancellationStartedCommit(): ActiveLeaseCancellationStartedSessionCommit {
  const processing = processingState();
  const lease = runtimeActivatedCommit().harnessLease;
  const state: ActiveLeaseCancellationStartedSessionCommit["state"] = {
    kind: "cancelling",
    state: {
      identity: processing.state.identity,
      contract: {
        ...processing.state.contract,
        lastEventSequence: 3,
      },
      plan: {
        kind: "turn",
        turnId: lease.turn.turnId,
        inputId: lease.turn.inputId,
        resumePoint: processing.state.resumePoint,
        lease: {
          kind: "active",
          runtimeLease: lease.runtimeLease,
          turnLeaseGeneration: lease.turn.turnLeaseGeneration,
        },
      },
    },
  };
  return {
    source: "surface_actor",
    commandId: "command_cancel_1",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_cancel_1",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 3,
      sourceTime: { kind: "satyr", issuedAt: 12 },
      acceptedAt: 12,
      correlationId: "correlation_1",
      causation: { kind: "command", commandId: "command_cancel_1" },
      idempotencyKey: "cancel_start_1",
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "surface_actor" },
      sensitivity: "organisation_private",
      retention: "session",
      body: { kind: "cancellation_started", state: state.state },
    },
    state,
    harnessLease: lease,
  };
}

function cancellationResolvedCommit(): CancellationResolvedSessionCommit {
  const cancelling = cancellationStartedCommit().state;
  const plan = cancelling.state.plan;
  if (plan.kind !== "turn" || plan.lease.kind !== "active") {
    throw new Error("cancellation_fixture_invalid");
  }
  const state: CancellationResolvedSessionCommit["state"] = {
    kind: "checkpointing",
    state: {
      identity: cancelling.state.identity,
      contract: {
        ...cancelling.state.contract,
        lastEventSequence: 4,
      },
      runtimeLease: plan.lease.runtimeLease,
      turnId: plan.turnId,
      inputId: plan.inputId,
      turnLeaseGeneration: plan.lease.turnLeaseGeneration,
      outcome: "cancelled",
      resumePoint: plan.resumePoint,
      workspaceRevisionReceipt: workspaceRevisionReceipt(),
    },
  };
  return {
    source: "harness",
    commandId: "command_cancel_2",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_cancel_2",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 4,
      sourceTime: { kind: "satyr", issuedAt: 14 },
      acceptedAt: 14,
      correlationId: "correlation_1",
      causation: { kind: "command", commandId: "command_cancel_2" },
      idempotencyKey: "cancel_resolve_1",
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "embedded_harness" },
      sensitivity: "organisation_private",
      retention: "session",
      body: {
        kind: "cancellation_resolved",
        resolution: { kind: "checkpointing", state: state.state },
      },
    },
    state,
  };
}

function checkpointingStartedCommit(
  checkpoint: HarnessCheckpointRecord,
): CheckpointingStartedSessionCommit {
  const result = buildTextTurnCheckpointingCommit({
    current: processingState(),
    harnessLease: runtimeActivatedCommit().harnessLease,
    workspaceRevisionReceipt: workspaceRevisionReceipt(),
    completion: {
      completionId: `finalize_${checkpoint.turn.turnId}_${checkpoint.cursor.lastSequence}`,
      acceptedAt: checkpoint.blob.createdAt,
    },
  });
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

function seedExecutionSettlementOutbox(
  database: import("node:sqlite").DatabaseSync,
  effectId: string,
): void {
  database
    .prepare(
      `INSERT INTO actor_outbox (
       effect_id, organisation_id, originating_event_id, request_envelope,
       state_kind, state_projection, updated_at
     ) VALUES (?, 'organisation_1', 'event_execution_1', '{}', 'dispatching', '{}', 12)`,
    )
    .run(effectId);
}

function markExecutionDispatching(
  database: import("node:sqlite").DatabaseSync,
): void {
  database.exec(
    `UPDATE actor_outbox
     SET state_kind = 'dispatching'
     WHERE effect_id = 'execution-cmx_execution_1'`,
  );
}

function executionRequestedCommit(): ExecutionRequestedSessionCommit {
  const current = processingState();
  const reserve = executionReserve();
  const request = {
    effectId: "execution-cmx_execution_1",
    kind: "execution" as const,
    capability: "idempotent" as const,
    idempotencyKey: reserve.idempotencyKey,
    request: {
      kind: "inline" as const,
      value: {
        executionId: reserve.executionId,
        turn: current.state.activeTurn.state.identity,
        admissionDigest: reserve.admissionDigest,
        workspaceRevisionReceipt:
          current.state.resumePoint.kind === "new"
            ? current.state.resumePoint.workspaceRevisionReceipt
            : current.state.resumePoint.checkpoint.workspaceRevisionReceipt,
      },
    },
  };
  const state: ExecutionRequestedSessionCommit["state"] = {
    kind: "processing",
    state: {
      ...current.state,
      contract: { ...current.state.contract, lastEventSequence: 3 },
      activeTurn: {
        kind: "awaiting_execution",
        state: {
          identity: current.state.activeTurn.state.identity,
          executionId: reserve.executionId,
          effectId: request.effectId,
        },
      },
    },
  };
  return {
    source: "harness",
    commandId: "command_execution_request_1",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_execution_request_1",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 3,
      sourceTime: { kind: "satyr", issuedAt: 12 },
      acceptedAt: 12,
      correlationId: reserve.executionId,
      causation: { kind: "command", commandId: "command_execution_request_1" },
      idempotencyKey: reserve.idempotencyKey,
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "embedded_harness" },
      sensitivity: "organisation_private",
      retention: "session",
      body: { kind: "execution_requested", request, state: state.state },
    },
    state,
    harnessLease: runtimeActivatedCommit().harnessLease,
    reserve,
  };
}

function executionReserve(): CodeModeOrganisationReserveInput {
  const requestId = parseRequestId("request_execution_1");
  const organisationId = parseOrganisationId("organisation_1");
  const sessionId = parseSessionId("session_1");
  if (!requestId.ok || !organisationId.ok || !sessionId.ok) {
    throw new Error("invalid Code Mode execution fixture identity");
  }
  return {
    requestId: requestId.value,
    organisationId: organisationId.value,
    sessionId: sessionId.value,
    turnId: "turn_1",
    runtimeGeneration: 1,
    executionId: "cmx_execution_1",
    idempotencyKey: "execution_request_1",
    leaseId: "execution_lease_1",
    executionDeadlineAt: 90,
    leaseExpiresAt: 95,
    admissionDigest:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    programDigest:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    requirementsDigest:
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    policyDigest:
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    catalogDigest:
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    routerRevision: "router_1",
    runtimeRevision: "runtime_1",
    priceBookRevision: "code-mode-price-book-v1",
    placement: {
      kind: "cloudflare_sandbox_worker",
      adapterRevision: "sandbox_worker_1",
      packageVersion: "1",
      reason: "generated_javascript_remote_execution",
      evidenceDigest:
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
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
    now: 12,
  };
}

function executionSettledCommit(): ExecutionSettledSessionCommit {
  const requested = executionRequestedCommit().state;
  const workspaceReceipt =
    requested.state.resumePoint.kind === "new"
      ? requested.state.resumePoint.workspaceRevisionReceipt
      : requested.state.resumePoint.checkpoint.workspaceRevisionReceipt;
  const receipt = {
    effectId: "execution-cmx_execution_1",
    kind: "execution" as const,
    capability: "idempotent" as const,
    receiptId: "receipt_execution_1",
    receipt: {
      kind: "inline" as const,
      value: {
        executionId: "cmx_execution_1",
        turn: requested.state.activeTurn.state.identity,
        admissionDigest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        receiptDigest:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        priceBookRevision: "code-mode-price-book-v1",
        reservedCostMicros: 1_000,
        actualCostMicros: 1_000,
        capabilityCalls: 1,
        inputBytes: 32,
        outputBytes: 64,
        rootOutputBytes: 16,
        workspaceExecutorUsage: { kind: "unused" as const },
        outcome: "succeeded" as const,
        workspaceRevisionReceipt: workspaceReceipt,
      },
    },
    settledAt: 12,
  };
  const state: ExecutionSettledSessionCommit["state"] = {
    kind: "processing",
    state: {
      ...requested.state,
      contract: { ...requested.state.contract, lastEventSequence: 4 },
      activeTurn: {
        kind: "reducing_result",
        state: {
          identity: requested.state.activeTurn.state.identity,
          receiptId: receipt.receiptId,
          workspaceRevisionReceipt: workspaceReceipt,
        },
      },
    },
  };
  return {
    source: "harness",
    commandId: "command_execution_1",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_execution_1",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 4,
      sourceTime: { kind: "satyr", issuedAt: 12 },
      acceptedAt: 12,
      correlationId: "correlation_1",
      causation: { kind: "command", commandId: "command_execution_1" },
      idempotencyKey: "execution_settled_1",
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "embedded_harness" },
      sensitivity: "organisation_private",
      retention: "session",
      body: { kind: "execution_settled", receipt, state: state.state },
    },
    state,
    harnessLease: runtimeActivatedCommit().harnessLease,
    settlementEffectId: "execution-cmx_execution_1",
  };
}

function quarantinedSessionCommit(): QuarantinedSessionCommit {
  const current = processingState();
  const state: QuarantinedSessionCommit["state"] = {
    kind: "quarantined",
    state: {
      identity: current.state.identity,
      contract: { ...current.state.contract, lastEventSequence: 3 },
      reason: "effect_indeterminate",
      recovery: { kind: "terminate_only" },
    },
  };
  return {
    source: "harness",
    commandId: "command_indeterminate_1",
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: "event_indeterminate_1",
      organisationId: "organisation_1",
      actorId: "session_1",
      streamId: "stream_1",
      sequence: 3,
      sourceTime: { kind: "satyr", issuedAt: 12 },
      acceptedAt: 12,
      correlationId: "cmx_execution_1",
      causation: { kind: "command", commandId: "command_indeterminate_1" },
      idempotencyKey: "execution_indeterminate_1",
      runtimeRevision: "runtime_1",
      principal: { kind: "system", componentId: "agent_session_actor" },
      sensitivity: "organisation_private",
      retention: "audit_required",
      body: { kind: "session_quarantined", state: state.state },
    },
    state,
    settlementEffectId: "effect_settlement_1",
    indeterminateReason: "code_mode_reservation_conflict",
  };
}

async function checkpointCommittedCommit(
  harnessCheckpoint: HarnessCheckpointRecord,
  current: CheckpointingStartedSessionCommit["state"],
): Promise<CheckpointCommittedSessionCommit> {
  const result = await buildTextTurnCheckpointCommittedCommit({
    current,
    harnessCheckpoint,
    completion: {
      completionId: `finalize_${harnessCheckpoint.turn.turnId}_${harnessCheckpoint.cursor.lastSequence}`,
      acceptedAt: harnessCheckpoint.blob.createdAt,
    },
  });
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

async function acceptedHarnessCheckpoint(
  storage: ActorTransactionStorage,
): Promise<HarnessCheckpointRecord> {
  const lease = runtimeActivatedCommit().harnessLease;
  const requestId = parseRequestId("request_harness_checkpoint");
  const organisationId = parseOrganisationId(lease.session.organisationId);
  const inputDigest = parseSessionTurnInputDigest("a".repeat(64));
  if (!requestId.ok || !organisationId.ok || !inputDigest.ok) {
    throw new Error("fixture identity failed");
  }
  const begun = beginSessionTurnStream(storage.sql, {
    turnId: lease.turn.turnId,
    requestId: requestId.value,
    organisationId: organisationId.value,
    inputDigest: inputDigest.value,
    startedAt: 11,
  });
  if (!begun.ok) {
    throw new Error(`fixture stream failed: ${begun.error.code}`);
  }
  const binding = parsePantryAccountBinding({
    version: 1,
    instanceId: "satyr_journal_fixture",
    nativeOrganisationId: lease.session.organisationId,
    deploymentId: "journal_fixture",
    scope: {
      namespace: "journal_fixture",
      organizationId: "account_organisation_1",
      projectId: "account_project_1",
      billingAccountId: "account_billing_1",
    },
    feePolicy: { kind: "customer_unpriced" },
  });
  if (!binding.ok) throw new Error(binding.error.code);
  const billing = storage.transactionSync(
    writePantryExecutionAdmissionInTransaction.bind(null, storage.sql, {
      binding: binding.value,
      lease,
      modelRoute: processingState().state.contract.modelRoute,
      modelRouteDigest: "d".repeat(64),
      admittedAt: 12,
    }),
  );
  if (!billing.ok) throw new Error(billing.error.code);
  const dispatched = markPantryExecutionDispatched(
    storage.sql,
    lease.turn.turnId,
  );
  if (!dispatched.ok) throw new Error(dispatched.error.code);
  const event = acceptHarnessEvent(storage, {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence: 1,
    eventDigest:
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    payload: JSON.stringify({
      turnId: lease.turn.turnId,
      sequence: 1,
      emittedAt: 12,
      event: {
        type: "done",
        outcome: { status: "success", summary: null, artifacts: [] },
      },
    }),
    acceptedAt: 12,
  });
  if (!event.ok) throw new Error(`fixture event failed: ${event.error.code}`);
  const historyEntry: HarnessHistoryEntry = {
    kind: "user_input",
    turn: lease.turn,
    input: {
      kind: "case",
      inputId: lease.turn.inputId,
      caseId: "case_1",
      assignmentId: "assignment_1",
      caseRevision: 1,
      contentDigest: "c".repeat(64),
      workspaceRevision: "workspace_1",
      contextBundleDigest: "e".repeat(64),
    },
    content: [{ kind: "text", text: "Summarize the catalog." }],
    acceptedAt: 12,
  };
  const history = await appendHarnessHistory(storage, {
    leaseId: lease.leaseId,
    sessionId: lease.session.sessionId,
    turn: lease.turn,
    sequence: 1,
    previousDigest: null,
    entry: historyEntry,
    acceptedAt: 12,
  });
  if (!history.ok)
    throw new Error(`fixture history failed: ${history.error.code}`);
  const checkpoint = harnessCheckpointRecord(
    history.value.cursor.lastEntryDigest,
  );
  const committed = commitHarnessCheckpoint(storage, {
    leaseId: lease.leaseId,
    checkpoint,
    committedAt: 13,
  });
  if (!committed.ok)
    throw new Error(`fixture checkpoint failed: ${committed.error.code}`);
  return checkpoint;
}

function harnessCheckpointRecord(
  historyDigest: string,
): CommitHarnessCheckpointInput["checkpoint"] {
  const lease = runtimeActivatedCommit().harnessLease;
  const digest =
    "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const cursor = {
    turn: lease.turn,
    lastSequence: 1,
    lastEventDigest:
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  return {
    backendId: "pi",
    blob: {
      objectKey: canonicalHarnessCheckpointObjectKey({
        organisationId: lease.session.organisationId,
        sessionId: lease.session.sessionId,
        cursor,
        sha256: digest,
      }),
      sha256: digest,
      byteLength: 64,
      formatVersion: "pi_checkpoint_v1",
      harnessBuild: "pi_build_1",
      createdAt: 13,
    },
    session: lease.session,
    turn: lease.turn,
    runtimeLease: lease.runtimeLease,
    runtimeRevision: lease.runtimeRevision,
    policyVersion: "policy_1",
    budgetRevision: lease.turn.budgetRevision,
    budgetUsage: { tokens: 100, activeWallMs: 10, capabilityCalls: 1 },
    usageCursor: 3,
    budgetAccountDigest: "b".repeat(64),
    cursor,
    historyCursor: { lastSequence: 1, lastEntryDigest: historyDigest },
    lastActorEventSequence: 2,
    workspaceBaseRevision: "workspace_1",
    workspaceRevision: "workspace_2",
    instructionDigest: digest,
    toolCatalogDigest: digest,
    modelRouteDigest: digest,
  };
}

function workspaceRevisionReceipt() {
  return {
    receiptId: "workspace_receipt_2",
    outcome: "accepted" as const,
    workspaceId: "workspace_catalog_1",
    revision: "workspace_2",
    canonicalHead:
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    correlationId: "correlation_1",
    causation: { kind: "command" as const, commandId: "command_3" },
  };
}

function processingState(): Variant<AgentSessionLifecycle, "processing"> {
  const activating = activatingState();
  return {
    kind: "processing",
    state: {
      identity: activating.state.identity,
      contract: { ...activating.state.contract, lastEventSequence: 2 },
      resumePoint: activating.state.resumePoint,
      runtimeLease: { generation: 1, leaseId: "runtime_lease_1" },
      activeTurn: {
        kind: "admitted",
        state: {
          identity: {
            turnId: activating.state.turnId,
            inputId: activating.state.inputId,
            turnLeaseGeneration: 1,
            budgetRevision: activating.state.contract.budgetRevision,
          },
          admittedAt: 11,
        },
      },
    },
  };
}

function seedActivation(database: import("node:sqlite").DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO state_object_activation (
       singleton, registry_id, activation_token, organisation_id, object_kind,
       logical_object_id, physical_object_name, placement_kind, placement_epoch,
       placement_cell_id, location_hint, residency_jurisdiction, schema_version,
       state_version, fence_token, activated_at
     ) VALUES (1, ?, ?, ?, 'session', ?, ?, 'affinity', 1, ?, ?, NULL, ?, 1, ?, 1)`,
    )
    .run(
      "registry_1",
      "activation_1",
      "organisation_1",
      "session_1",
      "session:organisation_1:session_1",
      "cell_1",
      "wnam",
      CANONICAL_SESSION_SCHEMA_VERSION,
      "fence_1",
    );
}

function activatingState(): Variant<AgentSessionLifecycle, "activating"> {
  const initialized = initializedSessionCommit().state;
  return {
    kind: "activating",
    state: {
      identity: {
        organisationId: "organisation_1",
        sessionId: "session_1",
        streamId: "stream_1",
      },
      contract: {
        policyVersion: "policy_1",
        budgetRevision: "budget_1",
        runtimeRevision: "runtime_1",
        modelRoute: {
          keySource: "platform",
          provider: "openai-compatible",
          model: "moonshotai/kimi-k3",
        },
        lastEventSequence: 1,
      },
      turnId: "turn_1",
      inputId: "input_1",
      resumePoint: initialized.state.resumePoint,
      runtimeGeneration: 1,
    },
  };
}

function inputAcceptedEvent(
  lifecycle: Variant<AgentSessionLifecycle, "activating">,
): EventEnvelope<Variant<SessionTransition, "input_accepted">> {
  return {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: "event_1",
    organisationId: "organisation_1",
    actorId: "session_1",
    streamId: "stream_1",
    sequence: 1,
    sourceTime: { kind: "producer", occurredAt: 9 },
    acceptedAt: 10,
    correlationId: "correlation_1",
    causation: { kind: "command", commandId: "command_1" },
    idempotencyKey: "input_1",
    runtimeRevision: "runtime_1",
    principal: { kind: "human", principalId: "user_1" },
    sensitivity: "organisation_private",
    retention: "session",
    body: {
      kind: "input_accepted",
      input: {
        kind: "case",
        inputId: "input_1",
        caseId: "case_1",
        assignmentId: "assignment_1",
        caseRevision: 1,
        contentDigest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspaceRevision: "workspace_1",
        contextBundleDigest: "e".repeat(64),
      },
      state: lifecycle.state,
    },
  };
}

function readCount(
  database: import("node:sqlite").DatabaseSync,
  table: string,
): number {
  const value = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get()?.count;
  if (typeof value !== "number") throw new Error(`missing count: ${table}`);
  return value;
}

function readText(
  database: import("node:sqlite").DatabaseSync,
  query: string,
  field: string,
): string {
  const value = database.prepare(query).get()?.[field];
  if (typeof value !== "string")
    throw new Error(`missing text fixture field: ${field}`);
  return value;
}
