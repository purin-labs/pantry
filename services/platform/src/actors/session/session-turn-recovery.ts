import type { SessionShared } from "./session-shared";
import type { SessionCheckpoints } from "./session-checkpoints";
import type { SessionHarnessTurns } from "./session-harness-turns";
import {
  countOpenEffectsBesidesBilling,
  reconcilePantryExecutionBilling,
} from "../../account-platform/execution-billing";
import { buildRecoveringSessionCancellation } from "../agent-session-recovery";
import { reconcileQuarantinedCodeModeSettlements } from "../agent-session-code-mode-settlement";
import {
  readPiDurableRecovery,
  rebindPiRecoveryCodeModeLease,
  resumePiDurableRecovery,
  type SavedRecovery,
} from "../pi-durable-recovery";
import { armAlarmBy } from "../lifecycle/actor-alarm";
import {
  finishHarnessTurnContinuation,
  discardHarnessTurnContinuation,
} from "../agent-session-continuation";
import {
  recoverInterruptedSessionInTransaction,
  terminateQuarantinedSessionInTransaction,
} from "../actor-journal/transactions";
import { JournalTransitionAbort } from "../actor-journal/aborts";
import {
  inspectAgentSessionCutoverQuiescence,
  type SessionCutoverBlocker,
} from "../agent-session-cutover-quiescence";
import { readAcceptedCheckpointFinalization } from "../agent-session-finalization";
import { parseOrganisationId, parseSessionId, newRequestId } from "../../ids";
import { traceWarn } from "../../observability";
import { SessionExecutionAdmission } from "../session-execution-admission";
import { settleActorExecution } from "../actor-execution-quiescence";
import { readCanonicalSessionForPersistence } from "../agent-session-canonical";
import {
  appendHarnessHistory,
  readHarnessHistory,
  readUnpublishedHarnessCheckpoint,
} from "../agent-session-harness-authority";
import type {
  HarnessHistoryEntry,
  HarnessTurnLease,
} from "@purin-labs/contracts";
import { isRecord, parseJsonOrNull, sha256Hex } from "@purin-labs/std";
import {
  canonicalRunBudgetIdentity,
  settleControlledRunCancellation,
} from "../agent-session-budget";
import { canonicalStopNotice } from "../pi-durable-history";
import { readPiUsage } from "../pi-durable-usage";
import {
  acceptCanonicalRunModelUsage,
  readCurrentHarnessTurnLease,
} from "./run-budget";
import { failSessionTurnStream } from "../agent-session-turn-stream";
import { materializedHarnessHistory } from "./harness-source";
import { failOrphanedSessionTurnStreams } from "./replay";
import { CODE_MODE_LEASE_REBIND_RETRY_MS } from "./support";
import { KNOWN_ZERO_MODEL_USAGE } from "./transient-turns";

/**
 * What a Session termination ends by itself: the quarantine, and the open
 * billing of its turns.
 */
const BLOCKERS_THAT_TERMINATION_ENDS: ReadonlySet<SessionCutoverBlocker> =
  new Set(["quarantined_lifecycle", "pending_effects", "dispatching_effects"]);

const INTERRUPTED_CALL_NOTE =
  "This call did not finish: the turn stopped before its result arrived.";
const INTERRUPTED_TURN_NOTE =
  "The turn stopped before it finished, so Sous Chef did not complete this request.";

/**
 * Recovery of interrupted harness turns and of checkpoint publication and finalization.
 */
export class SessionTurnRecovery {
  constructor(
    private readonly shared: SessionShared,
    private readonly checkpoints: SessionCheckpoints,
    private readonly harnessTurns: SessionHarnessTurns,
  ) {}

  private recoverUnrecoverableTurn(now: number): void {
    recoverInterruptedSessionInTransaction(this.shared.ctx.storage.sql, now);
    discardHarnessTurnContinuation(this.shared.ctx.storage.sql);
  }

  /**
   * Ends a turn that a process loss interrupted and that Pi cannot resume
   * (Refactor 15, refactor 3). The turn ends as a failed turn, as a Stop
   * does, so the Session sleeps and takes the thread's next message. Its
   * history ends on a stop notice, its run budget settles with the tokens
   * that Pi recorded, and its stream fails as `session_interrupted`, so the
   * surface runs the message again as a new turn. An effect that the turn
   * may have caused keeps its own record: a Code Mode settlement or a
   * commerce action reconciles on its own path. Only a turn that cannot end
   * this way quarantines the Session.
   */
  async endOrQuarantineInterruptedTurn(): Promise<void> {
    if (await this.endInterruptedTurn()) return;
    this.shared.ctx.storage.transactionSync(
      this.recoverUnrecoverableTurn.bind(this, Date.now()),
    );
    await this.endInterruptedTurnQuarantine();
  }

  /**
   * Ends the quarantine that an older release gave a Session when a process
   * loss interrupted its turn. The Session ends as failed, as that turn does
   * now, so its Case may end the assignment. A Session that holds an
   * indeterminate effect, or any work other than the billing of its turns,
   * stays quarantined: the effect may have happened, and a person decides it.
   */
  async endInterruptedTurnQuarantine(): Promise<void> {
    const sql = this.shared.ctx.storage.sql;
    const row = sql
      .exec<{ organisation_id: string; session_id: string }>(
        "SELECT organisation_id, session_id FROM session_meta LIMIT 1",
      )
      .toArray()[0];
    if (row === undefined) return;
    const organisationId = parseOrganisationId(row.organisation_id);
    const sessionId = parseSessionId(row.session_id);
    if (!organisationId.ok || !sessionId.ok) return;
    const current = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      sql,
      organisationId.value,
    );
    if (!current.ok) return;
    const lifecycle = current.value.lifecycle;
    if (lifecycle.kind !== "quarantined") return;
    const kept = (reason: string): void =>
      traceWarn("session.quarantine_kept", {
        requestId: newRequestId(),
        organisation_id: organisationId.value,
        session_id: sessionId.value,
        reason,
      });
    if (
      lifecycle.state.reason !== "effect_indeterminate" ||
      lifecycle.state.recovery.kind !== "terminate_only"
    )
      return kept(
        `quarantine:${lifecycle.state.reason}:${lifecycle.state.recovery.kind}`,
      );
    const now = Date.now();
    // An old refused Code Mode settlement settles from the owners' records
    // first; one that no record decides stays and keeps the quarantine.
    await reconcileQuarantinedCodeModeSettlements({
      env: this.shared.env,
      storage: this.shared.ctx.storage,
      organisationId: organisationId.value,
      sessionId: sessionId.value,
      now,
    });
    const work = inspectAgentSessionCutoverQuiescence({
      sql,
      organisationId: organisationId.value,
      sessionId: sessionId.value,
      inspectedAt: now,
      alarmAt: null,
      runtime: { persistence: "v28_canonical", lifecycleKind: "quarantined" },
    });
    if (!work.ok) return kept(`inspection:${work.error.code}`);
    const others = work.value.blockers.filter(
      (blocker) => !BLOCKERS_THAT_TERMINATION_ENDS.has(blocker),
    );
    if (others.length > 0) return kept(`work:${others.join("+")}`);
    const effects = countOpenEffectsBesidesBilling(sql);
    if (effects > 0) return kept(`open_effects:${effects}`);
    const lease = readCurrentHarnessTurnLease(sql);
    if (lease !== null)
      await this.closeInterruptedHistory(
        lease,
        lifecycle.state.contract.modelRoute.model,
        Math.max(lease.issuedAt, Math.min(now, lease.expiresAt - 1)),
      );
    try {
      const ended = this.shared.ctx.storage.transactionSync(
        terminateQuarantinedSessionInTransaction.bind(
          null,
          sql,
          lifecycle,
          now,
        ),
      );
      if (!ended.ok) return;
    } catch (error) {
      if (error instanceof JournalTransitionAbort) return;
      throw error;
    }
    traceWarn("session.quarantine_ended", {
      requestId: newRequestId(),
      organisation_id: organisationId.value,
      session_id: sessionId.value,
    });
    // The billing of the ended turn goes to the account now; a failure
    // leaves it pending, and the alarm that this sets delivers it later.
    await reconcilePantryExecutionBilling({
      env: this.shared.env,
      storage: this.shared.ctx.storage,
    });
  }

  private async endInterruptedTurn(): Promise<boolean> {
    const sql = this.shared.ctx.storage.sql;
    const lease = readCurrentHarnessTurnLease(sql);
    if (lease === null) return false;
    const organisationId = parseOrganisationId(lease.session.organisationId);
    if (!organisationId.ok) return false;
    const current = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      sql,
      organisationId.value,
    );
    if (!current.ok || current.value.lifecycle.kind !== "processing")
      return false;
    const now = Date.now();
    const acceptedAt = Math.max(
      lease.issuedAt,
      Math.min(now, lease.expiresAt - 1),
    );
    await this.closeInterruptedHistory(
      lease,
      current.value.lifecycle.state.contract.modelRoute.model,
      acceptedAt,
    );
    const identity = canonicalRunBudgetIdentity(lease);
    const usage = readPiUsage(sql, lease);
    if (usage !== null && usage.totalTokens > 0) {
      const accepted = acceptCanonicalRunModelUsage(
        this.shared.ctx.storage,
        identity,
        usage.totalTokens,
        now,
        true,
      );
      if (!accepted.ok && accepted.error.code !== "budget_exhausted")
        return false;
    }
    const resolved = await this.harnessTurns.resolveFailedTurn({
      organisationId: organisationId.value,
      lease,
      cancellationId: `interrupted_${lease.turn.turnId}`,
      correlationId: lease.turn.turnId,
      acceptedAt,
    });
    if (!resolved.ok) return false;
    this.shared.ctx.storage.transactionSync(
      settleControlledRunCancellation.bind(null, sql, { ...identity, now }),
    );
    discardHarnessTurnContinuation(sql);
    failSessionTurnStream(sql, lease.turn.turnId, "session_interrupted", now);
    traceWarn("session.interrupted_turn_ended", {
      requestId: newRequestId(),
      organisation_id: organisationId.value,
      session_id: lease.session.sessionId,
      turn_id: lease.turn.turnId,
      usage_known: usage === null || usage.modelCalls === usage.callsWithUsage,
    });
    return true;
  }

  /**
   * The history of an ended turn ends on an answer: each tool call that has
   * no result gets a failed result, and a stop notice follows them, as the
   * next turn reads only a history that ends on an answer.
   */
  private async closeInterruptedHistory(
    lease: HarnessTurnLease,
    model: string,
    acceptedAt: number,
  ): Promise<void> {
    const sql = this.shared.ctx.storage.sql;
    const row = sql
      .exec<{
        history_sequence: number | null;
        history_digest: string | null;
      }>(
        "SELECT history_sequence, history_digest FROM session_harness_lease LIMIT 1",
      )
      .toArray()[0];
    if (row === undefined) return;
    let cursor = {
      sequence: row.history_sequence ?? 0,
      digest: row.history_digest,
    };
    const digest = await sha256Hex(INTERRUPTED_CALL_NOTE);
    const entries: HarnessHistoryEntry[] = [
      ...pendingToolCalls(sql, lease).map((call): HarnessHistoryEntry => ({
        kind: "tool_result",
        turn: lease.turn,
        callId: call.callId,
        tool: call.tool,
        outcome: {
          kind: "failed",
          output: {
            kind: "inline",
            content: [{ kind: "text", text: INTERRUPTED_CALL_NOTE }],
            digest,
          },
        },
        authority: { kind: "read", resultDigest: digest },
        acceptedAt,
      })),
      canonicalStopNotice(INTERRUPTED_TURN_NOTE, model, lease.turn, acceptedAt),
    ];
    for (const entry of entries) {
      const appended = await appendHarnessHistory(this.shared.ctx.storage, {
        leaseId: lease.leaseId,
        sessionId: lease.session.sessionId,
        turn: lease.turn,
        sequence: cursor.sequence + 1,
        previousDigest: cursor.digest,
        entry,
        acceptedAt,
      });
      if (!appended.ok) {
        traceWarn("session.interrupted_history_unclosed", {
          requestId: newRequestId(),
          session_id: lease.session.sessionId,
          turn_id: lease.turn.turnId,
          reason: appended.error.code,
        });
        return;
      }
      cursor = {
        sequence: appended.value.cursor.lastSequence,
        digest: appended.value.cursor.lastEntryDigest,
      };
    }
  }

  async resumePendingPiTurn(): Promise<void> {
    await reconcilePantryExecutionBilling({
      env: this.shared.env,
      storage: this.shared.ctx.storage,
    });
    if (this.shared.canonicalTurn !== null) return;
    const pending = readPiDurableRecovery(this.shared.ctx.storage.sql);
    if (pending === null) return;
    const execution = await SessionExecutionAdmission.resolve(
      this.shared.env,
      this.shared.ctx.storage,
      pending.continuation.organisationId,
    );
    const authorized =
      execution !== null &&
      (await execution.isRecoveryAuthorized(pending.lease));
    // The owners of an unfinished Code Mode reservation confirm the lease of
    // the next runtime generation before the resume commits that generation.
    const rebind = authorized
      ? await rebindPiRecoveryCodeModeLease({
          env: this.shared.env,
          storage: this.shared.ctx.storage,
          now: Date.now(),
        })
      : ({ kind: "not_required" } as const);
    const resumed = this.shared.ctx.storage.transactionSync(
      resumePiDurableRecovery.bind(
        null,
        this.shared.sessionTools().pageEffects.rebindRecovery,
        this.shared.ctx.storage,
        pending,
        authorized,
        rebind,
        Date.now(),
      ),
    );
    if (rebind.kind === "deferred")
      await armAlarmBy(
        this.shared.ctx.storage,
        Date.now() + CODE_MODE_LEASE_REBIND_RETRY_MS,
      );
    // No owner will hold the reservation again, so the script can neither
    // continue nor settle. The turn ends, and the operator can send a new one.
    if (rebind.kind === "refused") await this.endUnresumableTurn();
    if (resumed === null) return;
    const work = this.resumeHarnessTurn(resumed);
    this.shared.canonicalTurn = settleActorExecution(work);
    this.shared.ctx.waitUntil(
      work.finally(this.checkpoints.clearCanonicalTurn.bind(this.checkpoints)),
    );
  }

  /**
   * Ends the turn of a recovery that cannot resume, as an interruption does.
   * A failure here leaves the recovery as it was, and the next alarm repeats it.
   */
  private async endUnresumableTurn(): Promise<void> {
    const row = this.shared.ctx.storage.sql
      .exec<{ organisation_id: string }>(
        "SELECT organisation_id FROM session_meta LIMIT 1",
      )
      .toArray()[0];
    const organisationId =
      row === undefined ? null : parseOrganisationId(row.organisation_id);
    if (organisationId === null || !organisationId.ok) return;
    const current = await readCanonicalSessionForPersistence(
      this.shared.persistence,
      this.shared.ctx.storage.sql,
      organisationId.value,
    );
    if (!current.ok || current.value.lifecycle.kind !== "recovering") return;
    const now = Date.now();
    const cancellation = buildRecoveringSessionCancellation({
      current: current.value.lifecycle,
      event: {
        operationId: `cancel_unresumable_${current.value.lifecycle.state.contract.lastEventSequence}`,
        acceptedAt: now,
      },
    });
    if (!cancellation.ok) return;
    const cancelled =
      await this.harnessTurns.cancelCanonicalEmbeddedHarnessTurn(
        cancellation.value,
      );
    if (!cancelled.ok) {
      await armAlarmBy(
        this.shared.ctx.storage,
        now + CODE_MODE_LEASE_REBIND_RETRY_MS,
      );
      return;
    }
    discardHarnessTurnContinuation(this.shared.ctx.storage.sql);
    failOrphanedSessionTurnStreams(
      this.shared.ctx.storage.sql,
      now,
      "code_mode_execution_unresumable",
    );
  }

  private async resumeHarnessTurn(pending: SavedRecovery): Promise<void> {
    const execution = await SessionExecutionAdmission.resolve(
      this.shared.env,
      this.shared.ctx.storage,
      pending.continuation.organisationId,
    );
    if (execution === null) return;
    try {
      const history = await readHarnessHistory(
        this.shared.ctx.storage.sql,
        pending.lease.session.sessionId,
        pending.continuation.organisationId,
      );
      if (!history.ok) throw new Error(history.error.code);
      const materialized = materializedHarnessHistory(history.value);
      if (!materialized.ok) throw new Error(materialized.error.code);
      // Pi restores its own usage; this attempt starts from none.
      const priorUsage = { ...KNOWN_ZERO_MODEL_USAGE };
      const result =
        await this.harnessTurns.runAndCheckpointCanonicalEmbeddedHarnessTextTurn(
          {
            execution,
            acceptedTurnTools: null,
            startReceiptCheck: null,
            startedInheritedHistory: null,
            startedGoalCase: null,
            requestingOrganisationId: pending.continuation.organisationId,
            requestId: pending.continuation.requestId,
            runtime: {
              kind: "resume_turn",
              binding: pending.continuation.binding,
              cursor: pending.cursor,
              priorUsage,
            },
            lease: pending.lease,
            harnessInstructions: pending.continuation.harnessInstructions,
            thinkingLevel: pending.continuation.thinkingLevel ?? undefined,
            turnPrompt: pending.continuation.turnPrompt,
            browserContext: pending.continuation.browserContext,
            surfaceContext: null,
            completion: pending.continuation.completion,
          },
        );
      if (!result.ok) throw new Error(result.error.code);
    } catch (error) {
      await this.harnessTurns.resolveFailedTurn({
        organisationId: pending.continuation.organisationId,
        lease: pending.lease,
        cancellationId: `cancel_${pending.continuation.requestId}`,
        correlationId: pending.continuation.requestId,
        acceptedAt: Date.now(),
      });
      failSessionTurnStream(
        this.shared.ctx.storage.sql,
        pending.lease.turn.turnId,
        "bakery_continuation_failed",
        Date.now(),
      );
      traceWarn("session.bakery_continuation_failed", {
        requestId: pending.continuation.requestId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    } finally {
      finishHarnessTurnContinuation(
        this.shared.ctx.storage.sql,
        pending.lease.turn.turnId,
      );
    }
  }

  /**
   * Finish what an interrupted turn left: the completion of a turn whose
   * checkpoint is accepted, or the archive write of a completed turn.
   */
  async resumeAcceptedCheckpointFinalization(): Promise<void> {
    const pending = readAcceptedCheckpointFinalization(
      this.shared.ctx.storage.sql,
    );
    if (!pending.ok) return;
    if (pending.value.kind === "none") {
      await this.resumeCheckpointPublication();
      return;
    }
    // The foreground turn owns completion until its execution settles.
    if (this.shared.canonicalTurn !== null) {
      await this.checkpoints.scheduleCheckpointFinalization();
      return;
    }
    const { current } = pending.value.finalization;
    const organisationId = parseOrganisationId(
      current.state.identity.organisationId,
    );
    if (!organisationId.ok) return;
    const execution = await SessionExecutionAdmission.resolve(
      this.shared.env,
      this.shared.ctx.storage,
      organisationId.value,
    );
    if (execution === null) return;
    const result = await this.checkpoints.finalizeAcceptedSessionCheckpoint({
      execution,
      requestingOrganisationId: organisationId.value,
      caller: { kind: "recovery" },
      turnId: current.state.turnId,
    });
    if (!result.ok) await this.checkpoints.scheduleCheckpointFinalization();
  }

  private async resumeCheckpointPublication(): Promise<void> {
    const unpublished = readUnpublishedHarnessCheckpoint(
      this.shared.ctx.storage.sql,
    );
    if (!unpublished.ok || unpublished.value === null) return;
    const organisationId = parseOrganisationId(
      unpublished.value.checkpoint.session.organisationId,
    );
    if (!organisationId.ok) return;
    const execution = await SessionExecutionAdmission.resolve(
      this.shared.env,
      this.shared.ctx.storage,
      organisationId.value,
    );
    if (execution === null) return;
    await this.checkpoints.publishAcceptedCheckpoint({
      execution,
      attempt: "resumed",
      trace: {
        requestId: newRequestId(),
        requestingOrganisationId: organisationId.value,
      },
    });
  }
}

/** The tool calls of the turn whose results the history does not hold. */
function pendingToolCalls(
  sql: SqlStorage,
  lease: HarnessTurnLease,
): readonly { readonly callId: string; readonly tool: string }[] {
  const calls = new Map<string, string>();
  for (const row of sql
    .exec<{ payload: string }>(
      "SELECT payload FROM session_harness_history WHERE session_id = ? AND turn_id = ? ORDER BY sequence",
      lease.session.sessionId,
      lease.turn.turnId,
    )
    .toArray()) {
    const stored = parseJsonOrNull(row.payload);
    const entry = isRecord(stored) ? stored.entry : null;
    if (!isRecord(entry)) continue;
    if (entry.kind === "tool_result" && typeof entry.callId === "string")
      calls.delete(entry.callId);
    if (entry.kind !== "assistant_message" || !Array.isArray(entry.content))
      continue;
    for (const content of entry.content)
      if (
        isRecord(content) &&
        content.kind === "tool_call" &&
        typeof content.callId === "string" &&
        typeof content.tool === "string"
      )
        calls.set(content.callId, content.tool);
  }
  return [...calls].map(([callId, tool]) => ({ callId, tool }));
}
