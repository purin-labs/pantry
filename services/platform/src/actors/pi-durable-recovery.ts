import type {
  HarnessTurnLease,
  AgentSessionLifecycle,
  SessionRecoveryAction,
  AcceptedHarnessEventCursor,
  TurnLifecycle,
} from "@purin-labs/contracts";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";
import { readImportedCanonicalSession } from "./agent-session-canonical";
import { parsePersistedHarnessTurnLease } from "./agent-session-harness-authority";
import {
  parseContinuation,
  readTurnContinuationRow,
  setTurnContinuationPhase,
  writeHarnessTurnContinuation,
  type HarnessTurnContinuation,
} from "./agent-session-continuation";
import {
  buildSessionExecutionRecovery,
  buildSessionExecutionResume,
  buildSessionRecoveryAction,
} from "./agent-session-recovery";
import {
  commitExecutionRecoveryStartedSession,
  commitExecutionRecoveryUpdatedSession,
  commitExecutionResumedSession,
} from "./actor-journal";
import {
  canonicalRunBudgetIdentity,
  readSessionBudgetAccount,
  settleRunBudget,
  markRunBudgetIndeterminate,
  reserveRunBudget,
} from "./agent-session-budget";
import { readPiUsage } from "./pi-durable-usage";
import type { Env } from "../env";
import type { StrictUnion, Variant } from "@purin-labs/type-utils";
import { traceWarn } from "../observability";
import { deriveCodeModeLeaseBinding } from "./code-mode-execution-record";
import {
  adoptCodeModeLeaseRebind,
  confirmCodeModeLeaseRebind,
  prepareCodeModeLeaseRebind,
  type ConfirmedCodeModeLeaseRebind,
} from "./code-mode-lease-rebind";
import {
  classifyCodeModeRecovery,
  codeModeRecoveryAction,
  codeModeRecoveryRebind,
} from "./code-mode-recovery";
import { PI_DURABLE_BUILD } from "./pi-durable-checkpoint";
import { mayRerunToolCall, type ToolCaller } from "./pi-tool-replay";
import type { ToolRegistry } from "../agent-tools/catalog/tool-registry";
import type { SessionPageEffects } from "./session/tool-wiring";
import type { Result } from "../result";

/** An unfinished Pi turn that the Session resumes. */
export type SavedRecovery = {
  continuation: HarnessTurnContinuation;
  lease: HarnessTurnLease;
  cursor: AcceptedHarnessEventCursor | null;
};

/**
 * Whether the reservation of the unfinished Code Mode execution holds the
 * lease of the runtime generation that a resume will commit.
 */
export type PiRecoveryLeaseRebind = StrictUnion<
  /** No admitted execution continues under a new lease. */
  | { readonly kind: "not_required" }
  | {
      readonly kind: "confirmed";
      readonly rebind: ConfirmedCodeModeLeaseRebind;
    }
  /** An owner cannot confirm now. The recovery repeats the same rebind. */
  | { readonly kind: "deferred"; readonly reason: string }
  /** No owner will confirm. The execution cannot continue. */
  | { readonly kind: "refused"; readonly reason: string }
>;

export function beginPiDurableRecovery(
  registry: ToolRegistry,
  storage: DurableObjectStorage,
  now: number,
): boolean {
  const sql = storage.sql;
  if (
    !sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='durable_metadata'",
      )
      .toArray().length
  )
    return false;
  const current = nativeLifecycle(sql);
  if (current?.kind === "recovering")
    return current.state.continuation.kind === "pi";
  if (current?.kind !== "processing") return false;
  const saved = readContinuationAndLease(sql);
  if (saved === null) return false;
  const row = sql
    .exec<{ id: number; record: string }>(
      "SELECT id, record FROM tasks WHERE kind = ? ORDER BY id DESC LIMIT 1",
      JSON.stringify("pi.generation"),
    )
    .toArray()[0];
  if (row === undefined) return false;
  const submission = sql
    .exec<{ id: number }>(
      "SELECT id FROM submissions WHERE request_id = ?",
      JSON.stringify(saved.lease.turn.inputId),
    )
    .toArray()[0];
  const history = sql
    .exec<{ sequence: number; entry_digest: string }>(
      "SELECT sequence, entry_digest FROM session_harness_history ORDER BY sequence DESC LIMIT 1",
    )
    .toArray()[0];
  if (submission === undefined || history === undefined) return false;
  const budget = required(
    readSessionBudgetAccount(sql, current.state.identity),
  );
  if (budget.kind !== "open" || budget.reservation.kind !== "active")
    return false;
  const usage = readPiUsage(sql, saved.lease);
  let action: SessionRecoveryAction;
  let held: SessionRecoveryAction | null;
  const identity = canonicalRunBudgetIdentity(saved.lease);
  if (usage !== null && usage.modelCalls !== usage.callsWithUsage) {
    required(
      markRunBudgetIndeterminate(sql, {
        ...identity,
        operationId: `pi_unknown_${row.id}`,
        now,
        reason: "model_receipt_missing",
      }),
    );
    action = {
      kind: "await_evidence",
      evidence: {
        kind: "model_usage",
        modelRequestId: `pi_request_${row.id}`,
        runId: identity.runId,
        reservationId: identity.reservationId,
      },
    };
  } else if (
    (held = evidenceRequiredAction(
      registry,
      sql,
      current.state.activeTurn,
      now,
    )) !== null
  ) {
    required(
      markRunBudgetIndeterminate(sql, {
        ...identity,
        operationId: `pi_uncertain_${row.id}`,
        now,
        reason: "provider_effect_indeterminate",
      }),
    );
    action = held;
  } else {
    required(
      settleRunBudget(sql, {
        ...identity,
        operationId: `pi_interrupted_${row.id}_${identity.runtimeGeneration}`,
        now,
        usage: {
          tokens: usage?.totalTokens ?? 0,
          capabilityCalls: budget.reservation.acceptedUsage.capabilityCalls,
          activeWallMs: budget.reservation.acceptedUsage.activeWallMs,
        },
        outcome: "succeeded",
      }),
    );
    action = { kind: "resume_task" };
  }
  setTurnContinuationPhase(sql, {
    kind: "pi_task_pending",
    lease: saved.lease,
    cursor: saved.cursor,
  });
  const commit = required(
    buildSessionExecutionRecovery({
      current,
      fencedHarnessLease: saved.lease,
      continuation: {
        kind: "pi",
        harnessTaskId: String(row.id),
        submissionId: String(submission.id),
        harnessBuild: PI_DURABLE_BUILD,
        historyCursor: {
          lastSequence: history.sequence,
          lastEntryDigest: history.entry_digest,
        },
      },
      action,
      event: {
        operationId: `pi_recover_${row.id}_${identity.runtimeGeneration}`,
        acceptedAt: now,
      },
    }),
  );
  required(commitExecutionRecoveryStartedSession(storage, commit));
  return true;
}

export function readPiDurableRecovery(sql: SqlStorage): SavedRecovery | null {
  const current = nativeLifecycle(sql);
  if (
    current?.kind !== "recovering" ||
    current.state.continuation.kind !== "pi"
  )
    return null;
  const row = readTurnContinuationRow(sql);
  if (row === undefined) return null;
  const continuation = parseContinuation(parseJsonOrNull(row.request_envelope));
  const phase = parseJsonOrNull(row.state_projection);
  if (
    continuation === null ||
    !isRecord(phase) ||
    phase.kind !== "pi_task_pending"
  )
    return null;
  const lease = parsePersistedHarnessTurnLease(phase.lease);
  if (lease === null || lease.turn.turnId !== continuation.turnId) return null;
  return { continuation, lease, cursor: deliveryCursor(sql, lease) };
}

/**
 * Binds the reservation of the unfinished Code Mode execution to the lease
 * of the next runtime generation, before that generation is committed.
 *
 * The intended lease is stored first, then each owner is asked. A recovery
 * that stops between two owners repeats the same rebind: the generation that
 * follows the fenced one is fixed, so the intended lease is the same.
 */
export async function rebindPiRecoveryCodeModeLease(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly now: number;
}): Promise<PiRecoveryLeaseRebind> {
  const current = nativeLifecycle(input.storage.sql);
  if (
    current?.kind !== "recovering" ||
    current.state.action.kind !== "resume_task"
  )
    return { kind: "not_required" };
  const execution = codeModeRecoveryRebind(
    classifyCodeModeRecovery(
      input.storage.sql,
      current.state.activeTurn,
      input.now,
    ),
  );
  if (execution === null) return { kind: "not_required" };
  const intended = await deriveCodeModeLeaseBinding(
    execution.executionId,
    current.state.fencedRuntime.generation + 1,
  );
  const preparation = input.storage.transactionSync(
    prepareCodeModeLeaseRebind.bind(null, input.storage.sql, {
      executionId: execution.executionId,
      intended,
      now: input.now,
    }),
  );
  switch (preparation.kind) {
    case "bound":
      return { kind: "not_required" };
    case "refused":
      return preparation;
    case "prepared":
      return confirmCodeModeLeaseRebind({
        env: input.env,
        storage: input.storage,
        rebind: preparation.rebind,
        now: input.now,
      });
    default:
      return preparation satisfies never;
  }
}

export function resumePiDurableRecovery(
  rebindPageEffects: SessionPageEffects["rebindRecovery"],
  storage: DurableObjectStorage,
  saved: SavedRecovery,
  authorized: boolean,
  rebind: PiRecoveryLeaseRebind,
  now: number,
): SavedRecovery | null {
  const current = nativeLifecycle(storage.sql);
  if (
    current?.kind !== "recovering" ||
    current.state.action.kind !== "resume_task"
  )
    return null;
  if (!authorized) {
    blockRecovery(storage, current, "authorization", now);
    return null;
  }
  switch (rebind.kind) {
    case "not_required":
    case "confirmed":
      break;
    case "deferred":
      // Nothing changes. The next recovery repeats the same rebind.
      traceWarn("code_mode.lease_rebind_deferred", {
        requestId: saved.continuation.requestId,
        session_id: saved.lease.session.sessionId,
        turn_id: saved.lease.turn.turnId,
        reason: rebind.reason,
      });
      return null;
    case "refused":
      // The reservation cannot hold a new lease, so no VM may start again.
      // The Session Actor ends the turn.
      traceWarn("code_mode.lease_rebind_refused", {
        requestId: saved.continuation.requestId,
        session_id: saved.lease.session.sessionId,
        turn_id: saved.lease.turn.turnId,
        reason: rebind.reason,
      });
      return null;
    default:
      return rebind satisfies never;
  }
  const generation = current.state.fencedRuntime.generation + 1;
  const commit = required(
    buildSessionExecutionResume({
      current: {
        kind: "recovering",
        state: { ...current.state, action: current.state.action },
      },
      runtimeLease: {
        generation,
        leaseId: `runtime_pi_${crypto.randomUUID()}`,
      },
      requestAuthority: saved.lease.requestAuthority,
      authorityPartitionDigest: saved.lease.authorityPartitionDigest,
      harnessLeaseId: `lease_pi_${crypto.randomUUID()}`,
      expiresAt: now + (saved.lease.expiresAt - saved.lease.issuedAt),
      event: { operationId: `pi_resume_${generation}`, acceptedAt: now },
    }),
  );
  const lease = commit.harnessLease;
  const identity = canonicalRunBudgetIdentity(lease);
  const reserved = reserveRunBudget(storage.sql, {
    ...identity,
    turnId: lease.turn.turnId,
    operationId: `budget_reserve_${identity.runId}`,
    now,
  });
  if (!reserved.ok) {
    blockRecovery(storage, current, "budget", now);
    return null;
  }
  required(commitExecutionResumedSession(storage, commit));
  // The lease that the owners confirmed becomes the accepted one in the same
  // transaction that commits its runtime generation.
  if (rebind.kind === "confirmed")
    adoptCodeModeLeaseRebind(storage.sql, {
      rebind: rebind.rebind,
      runtimeGeneration: generation,
      now,
    });
  rebindPageEffects(storage.sql, saved.lease, lease);
  const continuation: HarnessTurnContinuation = {
    kind: saved.continuation.kind,
    organisationId: saved.continuation.organisationId,
    requestId: saved.continuation.requestId,
    turnId: lease.turn.turnId,
    leaseId: lease.leaseId,
    harnessInstructions: saved.continuation.harnessInstructions,
    turnPrompt: saved.continuation.turnPrompt,
    thinkingLevel: saved.continuation.thinkingLevel,
    browserContext: saved.continuation.browserContext,
    completion: {
      completionId: saved.continuation.completion.completionId,
      acceptedAt: now,
    },
    binding: saved.continuation.binding,
  };
  writeHarnessTurnContinuation(storage.sql, continuation);
  return { continuation, lease, cursor: saved.cursor };
}
function nativeLifecycle(sql: SqlStorage): AgentSessionLifecycle | null {
  const row = sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM session_meta LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return null;
  const result = readImportedCanonicalSession(sql, row.organisation_id);
  return result.ok ? result.value.lifecycle : null;
}
function readContinuationAndLease(sql: SqlStorage): SavedRecovery | null {
  const row = readTurnContinuationRow(sql);
  const leaseRow = sql
    .exec<{ lease_projection: string }>(
      "SELECT lease_projection FROM session_harness_lease LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined || leaseRow === undefined) return null;
  const continuation = parseContinuation(parseJsonOrNull(row.request_envelope));
  const lease = parsePersistedHarnessTurnLease(
    parseJsonOrNull(leaseRow.lease_projection),
  );
  if (
    continuation === null ||
    lease === null ||
    continuation.turnId !== lease.turn.turnId
  )
    return null;
  return { continuation, lease, cursor: deliveryCursor(sql, lease) };
}
function deliveryCursor(
  sql: SqlStorage,
  lease: HarnessTurnLease,
): AcceptedHarnessEventCursor | null {
  const row = sql
    .exec<{ sequence: number; event_digest: string }>(
      "SELECT sequence, event_digest FROM turn_delivery_segment WHERE session_id = ? AND turn_id = ? ORDER BY sequence DESC LIMIT 1",
      lease.session.sessionId,
      lease.turn.turnId,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : {
        turn: lease.turn,
        lastSequence: row.sequence,
        lastEventDigest: row.event_digest,
      };
}
/**
 * The action that keeps the harness task stopped until evidence arrives, or
 * `null` when the task may run again.
 */
function evidenceRequiredAction(
  registry: ToolRegistry,
  sql: SqlStorage,
  activeTurn: TurnLifecycle,
  now: number,
): SessionRecoveryAction | null {
  if (hasUncertainTool(registry, sql))
    return { kind: "blocked", reason: "implementation" };
  const action = codeModeRecoveryAction(
    classifyCodeModeRecovery(sql, activeTurn, now),
  );
  return action.kind === "resume_task" ? null : action;
}

/**
 * A tool call whose effect may have happened and that may not run again.
 *
 * Pi runs an interrupted call again when the replay rule that it stored and
 * the rule of the tool are both `safe`. Otherwise it gives the caller a
 * failure that the call never produced. This guard stops the turn before Pi
 * does either for a call that its caller may not repeat.
 */
function hasUncertainTool(registry: ToolRegistry, sql: SqlStorage): boolean {
  for (const row of sql
    .exec<{ record: string }>(
      "SELECT record FROM tasks WHERE kind = ? AND status <> 'terminal'",
      JSON.stringify("pi.tool"),
    )
    .toArray()) {
    const task = parseJsonOrNull(row.record);
    if (
      !isRecord(task) ||
      !isRecord(task.state) ||
      !isRecord(task.state.checkpoint)
    )
      return true;
    if (task.state.checkpoint.phase !== "execute") continue;
    if (task.state.checkpoint.replay !== "safe") return true;
    const call = interruptedCall(sql, task.input);
    if (call === null || !mayRerunToolCall(registry, call.name, call.caller))
      return true;
  }
  return false;
}

/**
 * Whether Pi holds a model's Code Mode call that has not ended. A completed
 * call removes the tool from the agent before Pi ends its task, so a Session
 * lost between the two commits must offer the tool again: Pi reruns a call
 * only with a tool that the agent offers, and the rerun returns the receipt.
 */
export function hasUnfinishedCodeModeCall(sql: SqlStorage): boolean {
  for (const row of sql
    .exec<{ record: string }>(
      "SELECT record FROM tasks WHERE kind = ? AND status <> 'terminal'",
      JSON.stringify("pi.tool"),
    )
    .toArray()) {
    const task = parseJsonOrNull(row.record);
    if (!isRecord(task)) continue;
    const call = interruptedCall(sql, task.input);
    if (call?.name === "codemode" && call.caller === "model") return true;
  }
  return false;
}

/** The tool and the caller of a Pi tool task, from Pi's own records. */
function interruptedCall(
  sql: SqlStorage,
  input: unknown,
): { readonly name: string; readonly caller: ToolCaller } | null {
  if (!isRecord(input)) return null;
  if (input.kind === "nested")
    return isRecord(input.call) && typeof input.call.name === "string"
      ? { name: input.call.name, caller: "script" }
      : null;
  if (
    input.kind !== "model" ||
    typeof input.assistant !== "number" ||
    typeof input.callId !== "string"
  )
    return null;
  // A model call holds no tool name. Its assistant entry does.
  const row = sql
    .exec<{ record: string }>(
      "SELECT record FROM entries WHERE id = ?",
      input.assistant,
    )
    .toArray()[0];
  const entry = row === undefined ? null : parseJsonOrNull(row.record);
  const message =
    isRecord(entry) && Array.isArray(entry.model) ? entry.model[0] : null;
  if (!isRecord(message) || !Array.isArray(message.content)) return null;
  for (const block of message.content)
    if (
      isRecord(block) &&
      block.type === "toolCall" &&
      block.id === input.callId &&
      typeof block.name === "string"
    )
      return { name: block.name, caller: "model" };
  return null;
}
function blockRecovery(
  storage: DurableObjectStorage,
  current: Variant<AgentSessionLifecycle, "recovering">,
  reason: "authorization" | "budget",
  now: number,
): void {
  const commit = required(
    buildSessionRecoveryAction({
      current,
      action: { kind: "blocked", reason },
      event: {
        operationId: `pi_block_${current.state.contract.lastEventSequence}`,
        acceptedAt: now,
      },
    }),
  );
  required(commitExecutionRecoveryUpdatedSession(storage, commit));
}
function required<T>(result: Result<T, { code: string }>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
