import { armAlarmBy } from "../lifecycle/actor-alarm";
import { readGoalTurnUsage } from "../session-goal-usage";
import type {
  HarnessTurnLease,
  SessionBudgetAccount,
  SessionBudgetUsage,
} from "@seams/contracts";
import { parseRequestId, type RequestId } from "../../ids";
import { traceWarn } from "../../observability";
import type { Result } from "../../result";
import { readHarnessHistoryUsage } from "../agent-session-harness-authority";
import type { EmbeddedHarnessModelUsage } from "../embedded-harness";
import {
  acceptRunModelUsage,
  markRunBudgetIndeterminate,
  readSessionBudgetAccount,
  reconcileExpiredRunBudget,
  settleRunBudget,
  type SessionBudgetError,
} from "../agent-session-budget";
import { parseHarnessTurnLeaseProjection } from "./support";
import type {
  CanonicalEmbeddedHarnessRunError,
  CanonicalRunBudgetIdentity,
} from "./types";

export function acceptCanonicalRunModelUsage(
  storage: DurableObjectStorage,
  identity: CanonicalRunBudgetIdentity,
  totalTokens: number,
  now: number,
  afterRunEnded = false,
): Result<SessionBudgetAccount, SessionBudgetError> {
  return storage.transactionSync(
    acceptCanonicalRunModelUsageTransaction.bind(
      null,
      storage.sql,
      identity,
      totalTokens,
      now,
      afterRunEnded,
    ),
  );
}

function acceptCanonicalRunModelUsageTransaction(
  sql: SqlStorage,
  identity: CanonicalRunBudgetIdentity,
  totalTokens: number,
  now: number,
  afterRunEnded: boolean,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = readSessionBudgetAccount(sql, identity);
  if (!account.ok) return account;
  if (
    account.value.kind !== "open" ||
    account.value.reservation.kind !== "active"
  ) {
    return account.value.kind === "exhausted"
      ? {
          ok: false,
          error: {
            code: "budget_exhausted",
            exhaustion: account.value.exhaustion,
          },
        }
      : { ok: false, error: { code: "budget_reservation_conflict" } };
  }
  const usage: SessionBudgetUsage = {
    tokens: totalTokens,
    activeWallMs: account.value.reservation.acceptedUsage.activeWallMs,
    capabilityCalls: account.value.reservation.acceptedUsage.capabilityCalls,
  };
  return acceptRunModelUsage(sql, {
    ...identity,
    operationId: `budget_model_${identity.runId}`,
    usage,
    now,
    afterRunEnded,
  });
}

export function settleCanonicalRunBudget(
  storage: DurableObjectStorage,
  identity: CanonicalRunBudgetIdentity,
  outcome: "succeeded" | "failed" | "cancelled",
  now: number,
): Result<SessionBudgetAccount, SessionBudgetError> {
  return storage.transactionSync(
    settleCanonicalRunBudgetTransaction.bind(
      null,
      storage.sql,
      identity,
      outcome,
      now,
    ),
  );
}

export function reconcileSleepingSessionRunBudget(
  storage: DurableObjectStorage,
  identity: { readonly organisationId: string; readonly sessionId: string },
  now: number,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = readSessionBudgetAccount(storage.sql, identity);
  if (!account.ok) return account;
  if (
    account.value.kind === "exhausted" ||
    account.value.reservation.kind === "none"
  ) {
    return { ok: true, value: account.value };
  }
  if (account.value.reservation.kind === "indeterminate") {
    return { ok: false, error: { code: "budget_reservation_indeterminate" } };
  }
  const reservation = account.value.reservation;
  const runIdentity: CanonicalRunBudgetIdentity = {
    ...identity,
    runId: reservation.reservation.runId,
    reservationId: reservation.reservation.reservationId,
    runtimeGeneration: reservation.reservation.runtimeGeneration,
    turnLeaseGeneration: reservation.reservation.turnLeaseGeneration,
    budgetRevision: reservation.reservation.budgetRevision,
  };
  if (reservation.acceptedUsage.capabilityCalls > 0) {
    const marked = storage.transactionSync(
      markRunBudgetIndeterminate.bind(null, storage.sql, {
        ...runIdentity,
        operationId: `budget_orphan_indeterminate_${runIdentity.runId}`,
        reason: "provider_effect_indeterminate",
        now,
      }),
    );
    return marked.ok
      ? { ok: false, error: { code: "budget_reservation_indeterminate" } }
      : marked;
  }
  return storage.transactionSync(
    settleRunBudget.bind(null, storage.sql, {
      ...runIdentity,
      operationId: `budget_orphan_settle_${runIdentity.runId}`,
      usage: reservation.acceptedUsage,
      outcome: "failed",
      now,
    }),
  );
}

export function failCanonicalRunBudget(
  storage: DurableObjectStorage,
  identity: CanonicalRunBudgetIdentity,
  lease: HarnessTurnLease,
  error: CanonicalEmbeddedHarnessRunError,
  now: number,
): Result<SessionBudgetAccount, SessionBudgetError> {
  // The run has ended, so recording its usage no longer checks its time.
  const goalUsage = readGoalTurnUsage(storage.sql, lease);
  if (goalUsage.kind !== "untracked") {
    const accepted = acceptCanonicalRunModelUsage(
      storage,
      identity,
      goalUsage.reportedTokens,
      now,
      true,
    );
    if (!accepted.ok) return accepted;
  } else if (
    error.code === "embedded_harness_token_budget_exhausted" ||
    error.code === "embedded_harness_turn_failed_with_usage"
  ) {
    const accepted = acceptCanonicalRunModelUsage(
      storage,
      identity,
      error.modelUsage.totalTokens,
      now,
      true,
    );
    if (!accepted.ok) return accepted;
  }
  const account = readSessionBudgetAccount(storage.sql, identity);
  if (!account.ok) return account;
  if (
    account.value.kind !== "open" ||
    account.value.reservation.kind !== "active"
  ) {
    return account.value.kind === "exhausted"
      ? {
          ok: false,
          error: {
            code: "budget_exhausted",
            exhaustion: account.value.exhaustion,
          },
        }
      : { ok: false, error: { code: "budget_reservation_conflict" } };
  }
  const reason =
    goalUsage.kind === "unknown" ||
    error.code === "embedded_harness_model_usage_missing" ||
    (error.code === "embedded_harness_turn_failed_with_usage" &&
      error.cause.code === "embedded_harness_model_usage_missing")
      ? ("model_receipt_missing" as const)
      : account.value.reservation.acceptedUsage.capabilityCalls > 0
        ? ("provider_effect_indeterminate" as const)
        : null;
  if (reason === null) {
    return settleCanonicalRunBudget(storage, identity, "failed", now);
  }
  return storage.transactionSync(
    markRunBudgetIndeterminate.bind(null, storage.sql, {
      ...identity,
      operationId: `budget_indeterminate_${identity.runId}`,
      reason,
      now,
    }),
  );
}

function settleCanonicalRunBudgetTransaction(
  sql: SqlStorage,
  identity: CanonicalRunBudgetIdentity,
  outcome: "succeeded" | "failed" | "cancelled",
  now: number,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = readSessionBudgetAccount(sql, identity);
  if (!account.ok) return account;
  if (
    account.value.kind !== "open" ||
    account.value.reservation.kind === "none"
  ) {
    return account.value.kind === "exhausted"
      ? {
          ok: false,
          error: {
            code: "budget_exhausted",
            exhaustion: account.value.exhaustion,
          },
        }
      : { ok: false, error: { code: "budget_reservation_missing" } };
  }
  return settleRunBudget(sql, {
    ...identity,
    operationId: `budget_settle_${identity.runId}`,
    usage: account.value.reservation.acceptedUsage,
    outcome,
    now,
  });
}

export function reconcileCanonicalRunBudgetDeadline(
  storage: DurableObjectStorage,
  now: number,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const identity = readPersistedBudgetIdentity(storage.sql);
  if (identity === null) {
    return { ok: false, error: { code: "budget_account_missing" } };
  }
  const account = readSessionBudgetAccount(storage.sql, identity);
  if (!account.ok) return account;
  if (
    account.value.kind !== "open" ||
    account.value.reservation.kind === "none"
  ) {
    return account;
  }
  return storage.transactionSync(
    reconcileExpiredRunBudget.bind(null, storage.sql, {
      ...identity,
      operationId: `budget_deadline_${account.value.reservation.reservation.reservationId}`,
      now,
    }),
  );
}

export async function schedulePersistedRunBudgetDeadline(
  storage: DurableObjectStorage,
): Promise<void> {
  const identity = readPersistedBudgetIdentity(storage.sql);
  if (identity === null) return;
  const account = readSessionBudgetAccount(storage.sql, identity);
  if (
    !account.ok ||
    account.value.kind !== "open" ||
    account.value.reservation.kind !== "active"
  )
    return;
  await armAlarmBy(storage, account.value.reservation.reservation.deadlineAt);
}

function readPersistedBudgetIdentity(
  sql: SqlStorage,
): { readonly organisationId: string; readonly sessionId: string } | null {
  const row = sql
    .exec<{ organisation_id: string; session_id: string }>(
      `SELECT organisation_id, session_id
     FROM session_budget_account
     WHERE singleton = 1
     LIMIT 1`,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : { organisationId: row.organisation_id, sessionId: row.session_id };
}

export function readCurrentHarnessTurnLease(
  sql: SqlStorage,
): HarnessTurnLease | null {
  const row = sql
    .exec<{ lease_projection: string }>(
      `SELECT lease_projection
     FROM session_harness_lease
     LIMIT 1`,
    )
    .toArray()[0];
  return parseHarnessTurnLeaseProjection(row?.lease_projection);
}

function readHarnessHistoryWarningTraceContext(
  sql: SqlStorage,
  turnId: string,
): { readonly requestId: RequestId; readonly organisationId: string } | null {
  const row = sql
    .exec<{ request_id: string; organisation_id: string }>(
      `SELECT request_id, organisation_id
     FROM session_turn_stream
     WHERE turn_id = ?
     LIMIT 1`,
      turnId,
    )
    .toArray()[0];
  if (row === undefined || row.organisation_id.length === 0) return null;
  const requestId = parseRequestId(row.request_id);
  return requestId.ok
    ? { requestId: requestId.value, organisationId: row.organisation_id }
    : null;
}

// Read committed history after runtime shutdown, when every append of the
// turn is in it. Operators read the warning in Workers Logs.
export function traceHarnessHistoryBudgetWarning(input: {
  readonly sql: SqlStorage;
  readonly sessionId: string;
  readonly turnId: string;
}): void {
  const traceContext = readHarnessHistoryWarningTraceContext(
    input.sql,
    input.turnId,
  );
  if (traceContext === null) return;
  const usage = readHarnessHistoryUsage(
    input.sql,
    input.sessionId,
    traceContext.organisationId,
  );
  if (!usage.ok || !usage.value.warning) return;
  traceWarn("session.harness_history_budget_warning", {
    requestId: traceContext.requestId,
    organisation_id: traceContext.organisationId,
    session_id: input.sessionId,
    turn_id: input.turnId,
    entry_count: usage.value.entryCount,
    inline_bytes: usage.value.inlineBytes,
  });
}

export function combinedHarnessUsage(
  first: EmbeddedHarnessModelUsage,
  second: EmbeddedHarnessModelUsage,
): EmbeddedHarnessModelUsage {
  return {
    modelCalls: first.modelCalls + second.modelCalls,
    callsWithUsage: first.callsWithUsage + second.callsWithUsage,
    inputTokens: first.inputTokens + second.inputTokens,
    cachedInputTokens: first.cachedInputTokens + second.cachedInputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    reasoningTokens: first.reasoningTokens + second.reasoningTokens,
    totalTokens: first.totalTokens + second.totalTokens,
  };
}
