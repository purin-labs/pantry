import type { HarnessTurnLease } from "@purin-labs/contracts";
import type {
  RunBudgetIndeterminateReason,
  RunBudgetReservation,
  RunBudgetReservationState,
  SessionBudget,
  SessionBudgetAccount,
  SessionBudgetAllowance,
  SessionBudgetDimension,
  SessionBudgetExhaustion,
  SessionBudgetUsage,
  Sha256Digest,
} from "@purin-labs/contracts";

import type { Result } from "@purin-labs/kernel/result";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
  sha256Hex,
} from "@purin-labs/std";

const NONE_RESERVATION: RunBudgetReservationState = { kind: "none" };
const ZERO_USAGE: SessionBudgetUsage = {
  tokens: 0,
  activeWallMs: 0,
  capabilityCalls: 0,
};

type SqlRow = Record<string, SqlStorageValue>;

type BudgetAccountRow = SqlRow & {
  singleton: number;
  organisation_id: string;
  session_id: string;
  budget_json: string;
  usage_json: string;
  usage_cursor: number;
  state_kind: string;
  exhaustion_json: string | null;
  reservation_json: string;
  updated_at: number;
};

type BudgetEventRow = SqlRow & {
  sequence: number;
  event_id: string;
  operation_id: string;
  organisation_id: string;
  session_id: string;
  run_id: string | null;
  reservation_id: string | null;
  kind: string;
  payload: string;
  at: number;
};

type BudgetIdentity = {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly now: number;
};

type RunBudgetIdentity = BudgetIdentity & {
  readonly runId: string;
  readonly reservationId: string;
  readonly runtimeGeneration: number;
  readonly turnLeaseGeneration: number;
  readonly budgetRevision: string;
};

type BudgetRunEventIdentity = Pick<
  RunBudgetIdentity,
  "organisationId" | "sessionId" | "runId" | "reservationId"
>;

type AcceptedCapabilityBudgetClaim = Variant<CapabilityBudgetClaim, "accepted">;

type PersistedCapabilityBudgetClaim = AcceptedCapabilityBudgetClaim & {
  readonly runId: string;
  readonly runtimeGeneration: number;
  readonly turnLeaseGeneration: number;
  readonly budgetRevision: string;
};

type BudgetEvent =
  | {
      readonly kind: "SessionBudgetInitialized";
      readonly account: SessionBudgetAccount;
    }
  | {
      readonly kind: "RunBudgetReserved";
      readonly reservation: RunBudgetReservation;
    }
  | {
      readonly kind: "RunCapabilityClaimed";
      readonly claim: PersistedCapabilityBudgetClaim;
    }
  | {
      readonly kind: "RunBudgetMarkedIndeterminate";
      readonly account: SessionBudgetAccount;
    }
  | {
      readonly kind: "RunBudgetSettled";
      readonly account: SessionBudgetAccount;
      readonly runId: string;
      readonly reservationId: string;
      readonly runtimeGeneration: number;
      readonly turnLeaseGeneration: number;
      readonly budgetRevision: string;
      readonly usage: SessionBudgetUsage;
      readonly outcome: "succeeded" | "failed" | "cancelled";
    }
  | {
      readonly kind: "RunBudgetReconciled";
      readonly account: SessionBudgetAccount;
      readonly runId: string;
      readonly reservationId: string;
      readonly runtimeGeneration: number;
      readonly turnLeaseGeneration: number;
      readonly budgetRevision: string;
      readonly usage: SessionBudgetUsage;
      readonly outcome: "succeeded" | "failed" | "cancelled";
    }
  | {
      readonly kind: "RunBudgetUsageAccepted";
      readonly account: SessionBudgetAccount;
    }
  | {
      readonly kind: "SessionBudgetExhausted";
      readonly account: SessionBudgetAccount;
    };

type BudgetEventKind = BudgetEvent["kind"];

type SessionBudgetEvent = Variant<BudgetEvent, "SessionBudgetInitialized">;

type RunBudgetEvent = Exclude<BudgetEvent, SessionBudgetEvent>;

type DecodedBudgetEvent = {
  readonly sequence: number;
  readonly eventId: string;
  readonly operationId: string;
  readonly organisationId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly reservationId: string | null;
  readonly at: number;
  readonly payload: BudgetEvent;
};

type CreateSessionBudgetAccountInput = BudgetIdentity & {
  readonly budget: SessionBudget;
};

export type ReserveRunBudgetInput = RunBudgetIdentity & {
  readonly turnId: string;
};

type AcceptRunModelUsageInput = RunBudgetIdentity & {
  readonly usage: SessionBudgetUsage;
  /**
   * The run has already ended and its usage only needs recording; its time
   * limit no longer stops anything.
   */
  readonly afterRunEnded?: boolean;
};

type ClaimRunCapabilityInput = RunBudgetIdentity & {
  readonly claimId: string;
};

type SettleRunBudgetInput = RunBudgetIdentity & {
  readonly usage: SessionBudgetUsage;
  readonly outcome: "succeeded" | "failed" | "cancelled";
};

type MarkRunBudgetIndeterminateInput = RunBudgetIdentity & {
  readonly reason: RunBudgetIndeterminateReason;
};

type ReconcileRunBudgetInput = RunBudgetIdentity & {
  readonly usage: SessionBudgetUsage;
  readonly outcome: "succeeded" | "failed" | "cancelled";
};

type ReconcileExpiredRunBudgetInput = BudgetIdentity;

type CapabilityBudgetClaim =
  | {
      readonly kind: "accepted";
      readonly claimId: string;
      readonly reservationId: string;
      readonly usage: SessionBudgetUsage;
    }
  | {
      readonly kind: "duplicate";
      readonly claimId: string;
      readonly reservationId: string;
      readonly usage: SessionBudgetUsage;
    };

export type SessionBudgetError =
  | { readonly code: "invalid_budget_input"; readonly field: string }
  | { readonly code: "budget_account_missing" }
  | { readonly code: "budget_account_conflict" }
  | { readonly code: "budget_persisted_state_invalid" }
  | { readonly code: "budget_reservation_conflict" }
  | { readonly code: "budget_reservation_missing" }
  | { readonly code: "budget_reservation_indeterminate" }
  | { readonly code: "budget_reservation_lease_conflict" }
  | { readonly code: "budget_usage_not_monotonic" }
  | {
      readonly code: "budget_exhausted";
      readonly exhaustion: SessionBudgetExhaustion;
    }
  | { readonly code: "budget_deadline_not_elapsed" }
  | { readonly code: "budget_idempotency_conflict" }
  | { readonly code: "budget_operation_conflict" };

type CheckpointBudgetGapRun =
  | { readonly kind: "none" }
  | {
      readonly kind: "active";
      readonly runId: string;
      readonly reservationId: string;
      readonly capabilityCalls: number;
      readonly indeterminate: boolean;
    };

type ValidateCheckpointBudgetGapInput = {
  readonly organisationId: string;
  readonly sessionId: string;
  readonly budgetRevision: string;
  readonly checkpointUsage: SessionBudgetUsage;
  readonly checkpointUsageCursor: number;
  readonly account: SessionBudgetAccount;
  readonly activeRunId: string;
  readonly activeReservationId: string;
};

export async function sessionBudgetAccountDigest(
  account: SessionBudgetAccount,
): Promise<Sha256Digest> {
  return sha256Hex(
    JSON.stringify({
      kind: account.kind,
      budget: account.budget,
      usage: account.usage,
      usageCursor: account.usageCursor,
      reservation: account.reservation,
      exhaustion: account.kind === "exhausted" ? account.exhaustion : null,
    }),
  );
}

export function createSessionBudgetAccount(
  sql: SqlStorage,
  input: CreateSessionBudgetAccountInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const invalid = validateIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const budget = normalizeBudget(input.budget);
  if (!budget.ok) {
    return budget;
  }

  const existing = readAccountRow(sql);
  if (existing !== undefined) {
    const account = decodeBudgetAccountRow(existing);
    if (!account.ok) {
      return account;
    }
    return existing.organisation_id === input.organisationId &&
      existing.session_id === input.sessionId &&
      budgetsEqual(account.value.budget, budget.value)
      ? account
      : { ok: false, error: { code: "budget_account_conflict" } };
  }

  const account: SessionBudgetAccount = {
    kind: "open",
    budget: budget.value,
    usage: ZERO_USAGE,
    usageCursor: nextBudgetSequence(sql, input.sessionId),
    reservation: NONE_RESERVATION,
  };
  const encoded = encodeStoredBudgetAccount(account);
  sql.exec(
    `INSERT INTO session_budget_account (
       singleton, organisation_id, session_id, budget_json, usage_json,
       usage_cursor, state_kind, exhaustion_json, reservation_json, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.organisationId,
    input.sessionId,
    encoded.budgetJson,
    encoded.usageJson,
    encoded.usageCursor,
    encoded.stateKind,
    encoded.exhaustionJson,
    encoded.reservationJson,
    input.now,
  );
  appendSessionBudgetEvent(sql, input, {
    kind: "SessionBudgetInitialized",
    account,
  });
  return { ok: true, value: account };
}

export function readSessionBudgetAccount(
  sql: SqlStorage,
  input: { readonly organisationId: string; readonly sessionId: string },
): Result<SessionBudgetAccount, SessionBudgetError> {
  if (!nonEmpty(input.organisationId) || !nonEmpty(input.sessionId)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "identity" },
    };
  }
  const row = readAccountRow(sql);
  if (row === undefined) {
    return { ok: false, error: { code: "budget_account_missing" } };
  }
  if (
    row.organisation_id !== input.organisationId ||
    row.session_id !== input.sessionId
  ) {
    return { ok: false, error: { code: "budget_account_conflict" } };
  }
  return decodeBudgetAccountRow(row);
}

export function reserveRunBudget(
  sql: SqlStorage,
  input: ReserveRunBudgetInput,
): Result<RunBudgetReservation, SessionBudgetError> {
  const invalid = validateRunIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  if (!nonEmpty(input.turnId)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "turnId" },
    };
  }
  const duplicate = readOperation(sql, input.operationId);
  if (duplicate !== undefined) {
    const exhausted = replayExhaustionError(duplicate, input);
    if (exhausted !== null) {
      return exhausted;
    }
    if (
      duplicate.organisation_id !== input.organisationId ||
      duplicate.session_id !== input.sessionId ||
      duplicate.run_id !== input.runId ||
      duplicate.reservation_id !== input.reservationId ||
      duplicate.kind !== "RunBudgetReserved"
    ) {
      return { ok: false, error: { code: "budget_operation_conflict" } };
    }
    const reservation = decodeBudgetReservationEvent(duplicate);
    if (!reservation.ok) {
      return reservation;
    }
    return reservation.value.turnId === input.turnId &&
      reservation.value.runtimeGeneration === input.runtimeGeneration &&
      reservation.value.turnLeaseGeneration === input.turnLeaseGeneration &&
      reservation.value.budgetRevision === input.budgetRevision
      ? reservation
      : { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const account = readRunAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  if (account.value.kind !== "open") {
    return exhaustedError(account.value.exhaustion);
  }
  if (account.value.reservation.kind !== "none") {
    return { ok: false, error: { code: "budget_reservation_conflict" } };
  }
  const expectedId = deterministicReservationId(input);
  if (input.reservationId !== expectedId) {
    return { ok: false, error: { code: "budget_idempotency_conflict" } };
  }
  const allowance = remainingAllowance(
    account.value.budget,
    account.value.usage,
  );
  if (allowance.tokens === 0 || allowance.activeWallMs === 0) {
    return markExhausted(
      sql,
      input,
      account.value,
      allowance.tokens === 0 ? "tokens" : "active_wall_ms",
    );
  }
  const reservation: RunBudgetReservation = {
    reservationId: input.reservationId,
    runId: input.runId,
    turnId: input.turnId,
    runtimeGeneration: input.runtimeGeneration,
    turnLeaseGeneration: input.turnLeaseGeneration,
    budgetRevision: input.budgetRevision,
    allowance,
    acceptedAt: input.now,
    deadlineAt: input.now + allowance.activeWallMs,
  };
  const active: RunBudgetReservationState = {
    kind: "active",
    reservation,
    acceptedUsage: ZERO_USAGE,
  };
  sql.exec(
    `INSERT INTO session_budget_reservation (
       reservation_id, organisation_id, session_id, run_id, state_kind,
       reservation_json, accepted_usage_json, reason, updated_at
     ) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?)`,
    input.reservationId,
    input.organisationId,
    input.sessionId,
    input.runId,
    JSON.stringify(reservation),
    JSON.stringify(ZERO_USAGE),
    input.now,
  );
  updateAccountReservation(sql, input, account.value, active);
  appendRunBudgetEvent(sql, input, {
    kind: "RunBudgetReserved",
    reservation,
  });
  return { ok: true, value: reservation };
}

export function acceptRunModelUsage(
  sql: SqlStorage,
  input: AcceptRunModelUsageInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  return acceptRunUsage(sql, input, "RunBudgetUsageAccepted");
}

export function claimRunCapability(
  sql: SqlStorage,
  input: ClaimRunCapabilityInput,
): Result<CapabilityBudgetClaim, SessionBudgetError> {
  const invalid = validateRunIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  if (!nonEmpty(input.claimId)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "claimId" },
    };
  }
  const duplicate = readOperation(sql, input.operationId);
  if (duplicate !== undefined) {
    const exhausted = replayExhaustionError(duplicate, input);
    if (exhausted !== null) {
      return exhausted;
    }
    if (
      duplicate.organisation_id !== input.organisationId ||
      duplicate.session_id !== input.sessionId ||
      duplicate.run_id !== input.runId ||
      duplicate.reservation_id !== input.reservationId ||
      duplicate.kind !== "RunCapabilityClaimed"
    ) {
      return { ok: false, error: { code: "budget_operation_conflict" } };
    }
    const claim = decodeBudgetCapabilityEvent(duplicate);
    if (!claim.ok) {
      return claim;
    }
    return claim.value.claimId === input.claimId &&
      claim.value.runtimeGeneration === input.runtimeGeneration &&
      claim.value.turnLeaseGeneration === input.turnLeaseGeneration &&
      claim.value.budgetRevision === input.budgetRevision
      ? {
          ok: true,
          value: {
            kind: "duplicate",
            claimId: claim.value.claimId,
            reservationId: claim.value.reservationId,
            usage: claim.value.usage,
          },
        }
      : { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const account = readRunAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  const reservation = requireActiveReservation(account.value, input);
  if (!reservation.ok) {
    return reservation;
  }
  if (
    reservation.value.acceptedUsage.capabilityCalls >=
    reservation.value.reservation.allowance.capabilityCalls
  ) {
    return markExhausted(sql, input, account.value, "capability_calls");
  }
  const usage: SessionBudgetUsage = {
    ...reservation.value.acceptedUsage,
    capabilityCalls: reservation.value.acceptedUsage.capabilityCalls + 1,
  };
  const accepted = acceptReservationUsage(
    sql,
    input,
    account.value,
    reservation.value.reservation,
    usage,
  );
  if (!accepted.ok) {
    return accepted;
  }
  const claim: AcceptedCapabilityBudgetClaim = {
    kind: "accepted",
    claimId: input.claimId,
    reservationId: input.reservationId,
    usage,
  };
  appendRunBudgetEvent(sql, input, {
    kind: "RunCapabilityClaimed",
    claim: {
      kind: claim.kind,
      claimId: claim.claimId,
      reservationId: claim.reservationId,
      usage: claim.usage,
      runId: input.runId,
      runtimeGeneration: input.runtimeGeneration,
      turnLeaseGeneration: input.turnLeaseGeneration,
      budgetRevision: input.budgetRevision,
    },
  });
  return { ok: true, value: claim };
}

export function settleRunBudget(
  sql: SqlStorage,
  input: SettleRunBudgetInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  return settleRun(sql, input, "RunBudgetSettled");
}

export function markRunBudgetIndeterminate(
  sql: SqlStorage,
  input: MarkRunBudgetIndeterminateInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const invalid = validateRunIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  if (!isRunBudgetIndeterminateReason(input.reason)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "reason" },
    };
  }
  const duplicate = readOperation(sql, input.operationId);
  if (duplicate !== undefined) {
    return duplicateIndeterminateEvent(duplicate, input);
  }
  const account = readRunAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  const reservation = requireActiveReservation(account.value, input);
  if (!reservation.ok) {
    return reservation;
  }
  const state: RunBudgetReservationState = {
    kind: "indeterminate",
    reservation: reservation.value.reservation,
    acceptedUsage: reservation.value.acceptedUsage,
    reason: input.reason,
  };
  sql.exec(
    `UPDATE session_budget_reservation
     SET state_kind = 'indeterminate', reason = ?, updated_at = ?
     WHERE reservation_id = ? AND session_id = ?`,
    input.reason,
    input.now,
    input.reservationId,
    input.sessionId,
  );
  const next = updateAccountReservation(sql, input, account.value, state);
  appendRunBudgetEvent(sql, input, {
    kind: "RunBudgetMarkedIndeterminate",
    account: next,
  });
  return { ok: true, value: next };
}

export function reconcileRunBudget(
  sql: SqlStorage,
  input: ReconcileRunBudgetInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  return settleRun(sql, input, "RunBudgetReconciled");
}

export function settleControlledRunCancellation(
  sql: SqlStorage,
  input: Omit<RunBudgetIdentity, "operationId"> & { readonly now: number },
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = readSessionBudgetAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  if (account.value.kind === "exhausted") {
    return exhaustedError(account.value.exhaustion);
  }
  if (account.value.reservation.kind === "none") {
    return account;
  }
  const reservation = account.value.reservation;
  const settlement = {
    ...input,
    operationId: `budget_cancel_${input.runId}`,
    usage: reservation.acceptedUsage,
    outcome: "cancelled" as const,
  };
  return reservation.kind === "active"
    ? settleRun(sql, settlement, "RunBudgetSettled")
    : settleRun(sql, settlement, "RunBudgetReconciled");
}

export function validateCheckpointBudgetGap(
  sql: SqlStorage,
  input: ValidateCheckpointBudgetGapInput,
): Result<null, SessionBudgetError> {
  if (
    !nonEmpty(input.organisationId) ||
    !nonEmpty(input.sessionId) ||
    !nonEmpty(input.budgetRevision) ||
    !nonEmpty(input.activeRunId) ||
    !nonEmpty(input.activeReservationId) ||
    !isNonNegativeInteger(input.checkpointUsageCursor)
  ) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "checkpoint_gap" },
    };
  }
  const checkpointUsage = decodeSessionBudgetUsage(input.checkpointUsage);
  if (!checkpointUsage.ok) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "checkpointUsage" },
    };
  }
  if (
    input.account.kind !== "open" ||
    input.account.budget.budgetRevision !== input.budgetRevision ||
    input.account.reservation.kind !== "active" ||
    input.account.reservation.reservation.runId !== input.activeRunId ||
    input.account.reservation.reservation.reservationId !==
      input.activeReservationId ||
    !usagesEqual(input.account.reservation.acceptedUsage, ZERO_USAGE) ||
    input.account.usageCursor <= input.checkpointUsageCursor
  ) {
    return { ok: false, error: { code: "budget_reservation_lease_conflict" } };
  }

  const rows = sql
    .exec<BudgetEventRow>(
      `SELECT sequence, event_id, operation_id, organisation_id, session_id, run_id,
            reservation_id, kind, payload, at
     FROM session_budget_event
     WHERE session_id = ? AND sequence > ? AND sequence <= ?
     ORDER BY sequence ASC`,
      input.sessionId,
      input.checkpointUsageCursor,
      input.account.usageCursor,
    )
    .toArray();
  if (rows.length !== input.account.usageCursor - input.checkpointUsageCursor) {
    return { ok: false, error: { code: "budget_persisted_state_invalid" } };
  }

  let expectedUsage = checkpointUsage.value;
  let run: CheckpointBudgetGapRun = { kind: "none" };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) {
      return { ok: false, error: { code: "budget_persisted_state_invalid" } };
    }
    const decoded = decodeBudgetEvent(row);
    if (!decoded.ok) {
      return decoded;
    }
    const event = decoded.value;
    if (
      event.sequence !== input.checkpointUsageCursor + index + 1 ||
      event.organisationId !== input.organisationId ||
      event.sessionId !== input.sessionId
    ) {
      return { ok: false, error: { code: "budget_persisted_state_invalid" } };
    }
    const advanced = advanceCheckpointBudgetGap(
      run,
      expectedUsage,
      event,
      input,
    );
    if (!advanced.ok) {
      return advanced;
    }
    run = advanced.value.run;
    expectedUsage = advanced.value.usage;
  }

  return run.kind === "active" &&
    run.runId === input.activeRunId &&
    run.reservationId === input.activeReservationId &&
    run.capabilityCalls === 0 &&
    !run.indeterminate &&
    usagesEqual(expectedUsage, input.account.usage)
    ? { ok: true, value: null }
    : { ok: false, error: { code: "budget_reservation_lease_conflict" } };
}

function advanceCheckpointBudgetGap(
  run: CheckpointBudgetGapRun,
  usage: SessionBudgetUsage,
  event: DecodedBudgetEvent,
  input: ValidateCheckpointBudgetGapInput,
): Result<
  { readonly run: CheckpointBudgetGapRun; readonly usage: SessionBudgetUsage },
  SessionBudgetError
> {
  const invalid: Result<never, SessionBudgetError> = {
    ok: false,
    error: { code: "budget_reservation_lease_conflict" },
  };
  switch (event.payload.kind) {
    case "RunBudgetReserved": {
      const reservation = event.payload.reservation;
      if (
        run.kind !== "none" ||
        reservation.budgetRevision !== input.budgetRevision ||
        event.runId !== reservation.runId ||
        event.reservationId !== reservation.reservationId
      ) {
        return invalid;
      }
      return {
        ok: true,
        value: {
          run: {
            kind: "active",
            runId: reservation.runId,
            reservationId: reservation.reservationId,
            capabilityCalls: 0,
            indeterminate: false,
          },
          usage,
        },
      };
    }
    case "RunCapabilityClaimed": {
      const claim = event.payload.claim;
      if (
        run.kind !== "active" ||
        run.indeterminate ||
        claim.runId !== run.runId ||
        claim.reservationId !== run.reservationId ||
        claim.budgetRevision !== input.budgetRevision ||
        !claim.claimId.startsWith(
          "attachment_preparation:message.attachment.inspect:",
        ) ||
        claim.usage.tokens !== 0 ||
        claim.usage.activeWallMs !== 0 ||
        claim.usage.capabilityCalls !== run.capabilityCalls + 1
      ) {
        return invalid;
      }
      return {
        ok: true,
        value: {
          run: { ...run, capabilityCalls: claim.usage.capabilityCalls },
          usage,
        },
      };
    }
    case "RunBudgetMarkedIndeterminate": {
      const account = event.payload.account;
      if (
        run.kind !== "active" ||
        run.indeterminate ||
        account.kind !== "open" ||
        account.reservation.kind !== "indeterminate" ||
        account.reservation.reservation.runId !== run.runId ||
        account.reservation.reservation.reservationId !== run.reservationId ||
        account.usageCursor !== event.sequence ||
        account.usage.tokens !== usage.tokens ||
        account.usage.activeWallMs !== usage.activeWallMs ||
        account.usage.capabilityCalls !==
          usage.capabilityCalls + run.capabilityCalls ||
        account.reservation.acceptedUsage.tokens !== 0 ||
        account.reservation.acceptedUsage.activeWallMs !== 0 ||
        account.reservation.acceptedUsage.capabilityCalls !==
          run.capabilityCalls
      ) {
        return invalid;
      }
      return {
        ok: true,
        value: { run: { ...run, indeterminate: true }, usage },
      };
    }
    case "RunBudgetSettled":
    case "RunBudgetReconciled": {
      const settlement = event.payload;
      if (
        run.kind !== "active" ||
        settlement.runId !== run.runId ||
        settlement.reservationId !== run.reservationId ||
        settlement.budgetRevision !== input.budgetRevision ||
        (run.indeterminate
          ? settlement.kind !== "RunBudgetReconciled"
          : settlement.kind !== "RunBudgetSettled") ||
        (run.capabilityCalls > 0
          ? settlement.outcome !== "cancelled"
          : settlement.outcome === "succeeded") ||
        settlement.usage.tokens !== 0 ||
        settlement.usage.activeWallMs !== 0 ||
        settlement.usage.capabilityCalls !== run.capabilityCalls ||
        settlement.account.kind !== "open" ||
        settlement.account.reservation.kind !== "none" ||
        settlement.account.usageCursor !== event.sequence ||
        settlement.account.usage.tokens !== usage.tokens ||
        settlement.account.usage.activeWallMs < usage.activeWallMs ||
        settlement.account.usage.capabilityCalls !==
          usage.capabilityCalls + run.capabilityCalls
      ) {
        return invalid;
      }
      return {
        ok: true,
        value: { run: { kind: "none" }, usage: settlement.account.usage },
      };
    }
    case "RunBudgetUsageAccepted":
    case "SessionBudgetExhausted":
    case "SessionBudgetInitialized":
      return invalid;
    default:
      return assertNever(event.payload);
  }
}

export function reconcileExpiredRunBudget(
  sql: SqlStorage,
  input: ReconcileExpiredRunBudgetInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const invalid = validateIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const duplicate = readOperation(sql, input.operationId);
  if (duplicate !== undefined) {
    const exhausted = replayExpiredExhaustionError(duplicate, input);
    if (exhausted !== null) {
      return exhausted;
    }
    return duplicateAccountEvent(duplicate, {
      organisationId: input.organisationId,
      sessionId: input.sessionId,
      kind: "SessionBudgetExhausted",
    });
  }
  const account = readSessionBudgetAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  if (account.value.kind !== "open") {
    return account;
  }
  if (account.value.reservation.kind === "none") {
    return account;
  }
  if (account.value.reservation.kind === "indeterminate") {
    return { ok: false, error: { code: "budget_reservation_indeterminate" } };
  }
  if (input.now < account.value.reservation.reservation.deadlineAt) {
    return { ok: false, error: { code: "budget_deadline_not_elapsed" } };
  }
  // A run still going a grace period after its time limit could not stop
  // at a step of its own; it is cut off and its Session closes.
  if (
    input.now <
    account.value.reservation.reservation.deadlineAt + RUN_TIME_STOP_GRACE_MS
  ) {
    return { ok: false, error: { code: "budget_deadline_not_elapsed" } };
  }
  const reservation = account.value.reservation.reservation;
  return markExhaustedWithUsage(
    sql,
    {
      ...input,
      runId: reservation.runId,
      reservationId: reservation.reservationId,
      runtimeGeneration: reservation.runtimeGeneration,
      turnLeaseGeneration: reservation.turnLeaseGeneration,
      budgetRevision: reservation.budgetRevision,
    },
    account.value,
    {
      ...account.value.usage,
      activeWallMs:
        account.value.usage.activeWallMs -
        account.value.reservation.acceptedUsage.activeWallMs +
        reservation.allowance.activeWallMs,
    },
    "active_wall_ms",
  );
}

/**
 * How long a run may go on after its time limit to finish the model call it
 * is in; it starts no new step in that time.
 */
export const RUN_TIME_STOP_GRACE_MS = 60_000;

/** The stop of one run that reached its time limit; it is not stored. */
function runTimeExhaustion(
  input: Pick<RunBudgetIdentity, "sessionId" | "runId" | "now">,
  account: SessionBudgetAccount,
  runUsage: SessionBudgetUsage,
): SessionBudgetExhaustion {
  return {
    exhaustionId: `exhaustion_${input.sessionId}_${input.runId}_active_wall_ms`,
    dimension: "active_wall_ms",
    runId: input.runId,
    observedUsage: {
      ...account.usage,
      activeWallMs: Math.max(account.usage.activeWallMs, runUsage.activeWallMs),
    },
    exhaustedAt: input.now,
  };
}

function settleRun(
  sql: SqlStorage,
  input: SettleRunBudgetInput | ReconcileRunBudgetInput,
  eventKind: "RunBudgetSettled" | "RunBudgetReconciled",
): Result<SessionBudgetAccount, SessionBudgetError> {
  const invalid = validateRunIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const duplicate = readOperation(sql, input.operationId);
  if (duplicate !== undefined) {
    return duplicateSettlementEvent(duplicate, input, eventKind);
  }
  const account = readRunAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  const reservation = requireReservationForSettlement(account.value, input);
  if (!reservation.ok) {
    return reservation;
  }
  if (
    eventKind === "RunBudgetSettled" &&
    reservation.value.kind === "indeterminate"
  ) {
    return { ok: false, error: { code: "budget_reservation_indeterminate" } };
  }
  const requestedUsage = decodeSessionBudgetUsage(input.usage);
  if (!requestedUsage.ok) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "usage" },
    };
  }
  const usage = normalizedUsage(
    input.usage,
    reservation.value.reservation.acceptedAt,
    input.now,
  );
  if (!usage.ok) {
    return usage;
  }
  const accepted = acceptReservationUsage(
    sql,
    input,
    account.value,
    reservation.value.reservation,
    usage.value,
    true,
  );
  if (!accepted.ok) {
    return accepted;
  }
  const finalAccount = accepted.value;
  if (finalAccount.kind === "exhausted") {
    return exhaustedError(finalAccount.exhaustion);
  }
  sql.exec(
    `DELETE FROM session_budget_reservation
     WHERE reservation_id = ? AND session_id = ?`,
    input.reservationId,
    input.sessionId,
  );
  const settled: SessionBudgetAccount = {
    ...finalAccount,
    reservation: NONE_RESERVATION,
  };
  updateAccount(sql, input, settled);
  switch (eventKind) {
    case "RunBudgetSettled":
      appendRunBudgetEvent(sql, input, {
        kind: eventKind,
        account: settled,
        runId: input.runId,
        reservationId: input.reservationId,
        runtimeGeneration: input.runtimeGeneration,
        turnLeaseGeneration: input.turnLeaseGeneration,
        budgetRevision: input.budgetRevision,
        usage: requestedUsage.value,
        outcome: input.outcome,
      });
      break;
    case "RunBudgetReconciled":
      appendRunBudgetEvent(sql, input, {
        kind: eventKind,
        account: settled,
        runId: input.runId,
        reservationId: input.reservationId,
        runtimeGeneration: input.runtimeGeneration,
        turnLeaseGeneration: input.turnLeaseGeneration,
        budgetRevision: input.budgetRevision,
        usage: requestedUsage.value,
        outcome: input.outcome,
      });
      break;
    default:
      return assertNever(eventKind);
  }
  return { ok: true, value: settled };
}

function acceptRunUsage(
  sql: SqlStorage,
  input: AcceptRunModelUsageInput,
  eventKind: "RunBudgetUsageAccepted",
): Result<SessionBudgetAccount, SessionBudgetError> {
  const invalid = validateRunIdentity(input);
  if (invalid !== null) {
    return { ok: false, error: invalid };
  }
  const duplicate = readOperation(sql, input.operationId);
  if (duplicate !== undefined) {
    return duplicateUsageAcceptedEvent(duplicate, input);
  }
  const account = readRunAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  const reservation = requireActiveReservation(account.value, input);
  if (!reservation.ok) {
    return reservation;
  }
  const usage = normalizedUsage(
    input.usage,
    reservation.value.reservation.acceptedAt,
    input.now,
  );
  if (!usage.ok) {
    return usage;
  }
  const accepted = acceptReservationUsage(
    sql,
    input,
    account.value,
    reservation.value.reservation,
    usage.value,
    false,
    input.afterRunEnded === true,
  );
  if (!accepted.ok) {
    return accepted;
  }
  appendRunBudgetEvent(sql, input, {
    kind: eventKind,
    account: accepted.value,
  });
  return accepted;
}

function acceptReservationUsage(
  sql: SqlStorage,
  input: RunBudgetIdentity,
  account: SessionBudgetAccount,
  reservation: RunBudgetReservation,
  reportedUsage: SessionBudgetUsage,
  settling = false,
  afterRunEnded = settling,
): Result<SessionBudgetAccount, SessionBudgetError> {
  // An ended run records at most its own time limit, so the reservation stays
  // within its allowance; the run's time no longer limits anything.
  const runUsage: SessionBudgetUsage =
    afterRunEnded &&
    reportedUsage.activeWallMs > reservation.allowance.activeWallMs
      ? { ...reportedUsage, activeWallMs: reservation.allowance.activeWallMs }
      : reportedUsage;
  if (account.kind !== "open") {
    return exhaustedError(account.exhaustion);
  }
  const current = account.reservation;
  if (
    current.kind === "none" ||
    current.reservation.reservationId !== reservation.reservationId
  ) {
    return { ok: false, error: { code: "budget_reservation_missing" } };
  }
  if (current.kind === "indeterminate" && !settling) {
    return { ok: false, error: { code: "budget_reservation_indeterminate" } };
  }
  if (
    runUsage.tokens < current.acceptedUsage.tokens ||
    runUsage.activeWallMs < current.acceptedUsage.activeWallMs ||
    runUsage.capabilityCalls < current.acceptedUsage.capabilityCalls
  ) {
    return { ok: false, error: { code: "budget_usage_not_monotonic" } };
  }
  // A run past its time stops, but the Session stays open: the failed-turn
  // path then settles the run with its whole time, as after any failure.
  if (
    !afterRunEnded &&
    runUsage.activeWallMs > reservation.allowance.activeWallMs
  ) {
    return exhaustedError(runTimeExhaustion(input, account, runUsage));
  }
  const delta = subtractUsage(runUsage, current.acceptedUsage);
  const nextUsage = addUsage(account.usage, delta);
  const exceeded = firstExceededDimension(nextUsage, account.budget);
  if (exceeded !== null) {
    return markExhaustedWithUsage(sql, input, account, nextUsage, exceeded);
  }
  const nextReservation: RunBudgetReservationState = {
    kind: "active",
    reservation,
    acceptedUsage: runUsage,
  };
  const nextAccount: SessionBudgetAccount = {
    kind: "open",
    budget: account.budget,
    usage: nextUsage,
    usageCursor: nextBudgetSequence(sql, input.sessionId),
    reservation: nextReservation,
  };
  sql.exec(
    `UPDATE session_budget_reservation
     SET accepted_usage_json = ?, updated_at = ?
     WHERE reservation_id = ? AND session_id = ?`,
    JSON.stringify(runUsage),
    input.now,
    reservation.reservationId,
    input.sessionId,
  );
  updateAccount(sql, input, nextAccount);
  return { ok: true, value: nextAccount };
}

function markExhausted(
  sql: SqlStorage,
  input: RunBudgetIdentity,
  account: SessionBudgetAccount,
  dimension: SessionBudgetDimension,
): Result<never, SessionBudgetError> {
  if (account.kind !== "open") {
    return exhaustedError(account.exhaustion);
  }
  return markExhaustedWithUsage(sql, input, account, account.usage, dimension);
}

function markExhaustedWithUsage(
  sql: SqlStorage,
  input: RunBudgetIdentity,
  account: SessionBudgetAccount,
  usage: SessionBudgetUsage,
  dimension: SessionBudgetDimension,
): Result<never, SessionBudgetError> {
  const exhaustion: SessionBudgetExhaustion = {
    exhaustionId: `exhaustion_${input.sessionId}_${input.runId}_${dimension}`,
    dimension,
    runId: input.runId,
    observedUsage: usage,
    exhaustedAt: input.now,
  };
  const exhausted: SessionBudgetAccount = {
    kind: "exhausted",
    budget: account.budget,
    usage,
    usageCursor: nextBudgetSequence(sql, input.sessionId),
    exhaustion,
    reservation: { kind: "none" },
  };
  sql.exec(
    `DELETE FROM session_budget_reservation WHERE session_id = ?`,
    input.sessionId,
  );
  updateAccount(sql, input, exhausted);
  appendRunBudgetEvent(sql, input, {
    kind: "SessionBudgetExhausted",
    account: exhausted,
  });
  return exhaustedError(exhaustion);
}

function updateAccountReservation(
  sql: SqlStorage,
  input: BudgetIdentity,
  account: SessionBudgetAccount,
  reservation: RunBudgetReservationState,
): SessionBudgetAccount {
  const next: SessionBudgetAccount =
    account.kind === "open"
      ? {
          ...account,
          reservation,
          usageCursor: nextBudgetSequence(sql, input.sessionId),
        }
      : account;
  updateAccount(sql, input, next);
  return next;
}

function updateAccount(
  sql: SqlStorage,
  input: BudgetIdentity,
  account: SessionBudgetAccount,
): void {
  const encoded = encodeStoredBudgetAccount(account);
  sql.exec(
    `UPDATE session_budget_account
     SET usage_json = ?, usage_cursor = ?, state_kind = ?, exhaustion_json = ?, reservation_json = ?, updated_at = ?
     WHERE singleton = 1 AND organisation_id = ? AND session_id = ?`,
    encoded.usageJson,
    encoded.usageCursor,
    encoded.stateKind,
    encoded.exhaustionJson,
    encoded.reservationJson,
    input.now,
    input.organisationId,
    input.sessionId,
  );
}

function appendBudgetEvent(
  sql: SqlStorage,
  input: BudgetIdentity,
  runId: string | null,
  reservationId: string | null,
  event: BudgetEvent,
): void {
  const eventId = deterministicBudgetEventId(
    input.sessionId,
    input.operationId,
  );
  const sequence = nextBudgetSequence(sql, input.sessionId);
  sql.exec(
    `INSERT INTO session_budget_event (
       sequence, event_id, operation_id, organisation_id, session_id, run_id,
       reservation_id, kind, payload, at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sequence,
    eventId,
    input.operationId,
    input.organisationId,
    input.sessionId,
    runId,
    reservationId,
    event.kind,
    encodeBudgetEvent(event),
    input.now,
  );
}

function appendSessionBudgetEvent(
  sql: SqlStorage,
  input: BudgetIdentity,
  event: SessionBudgetEvent,
): void {
  appendBudgetEvent(sql, input, null, null, event);
}

function appendRunBudgetEvent(
  sql: SqlStorage,
  input: RunBudgetIdentity,
  event: RunBudgetEvent,
): void {
  appendBudgetEvent(sql, input, input.runId, input.reservationId, event);
}

function nextBudgetSequence(sql: SqlStorage, sessionId: string): number {
  const latest =
    sql
      .exec<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), -1) AS sequence
     FROM session_budget_event WHERE session_id = ?`,
        sessionId,
      )
      .toArray()[0]?.sequence ?? -1;
  return latest + 1;
}

function readRunAccount(
  sql: SqlStorage,
  input: RunBudgetIdentity,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = readSessionBudgetAccount(sql, input);
  if (!account.ok) {
    return account;
  }
  if (account.value.kind === "exhausted") {
    return account;
  }
  if (account.value.budget.budgetRevision !== input.budgetRevision) {
    return { ok: false, error: { code: "budget_reservation_lease_conflict" } };
  }
  return account;
}

function requireActiveReservation(
  account: SessionBudgetAccount,
  input: RunBudgetIdentity,
): Result<Variant<RunBudgetReservationState, "active">, SessionBudgetError> {
  if (account.kind !== "open") {
    return exhaustedError(account.exhaustion);
  }
  if (account.reservation.kind === "none") {
    return { ok: false, error: { code: "budget_reservation_missing" } };
  }
  if (account.reservation.kind === "indeterminate") {
    return { ok: false, error: { code: "budget_reservation_indeterminate" } };
  }
  if (
    account.reservation.reservation.reservationId !== input.reservationId ||
    account.reservation.reservation.runId !== input.runId ||
    account.reservation.reservation.runtimeGeneration !==
      input.runtimeGeneration ||
    account.reservation.reservation.turnLeaseGeneration !==
      input.turnLeaseGeneration
  ) {
    return { ok: false, error: { code: "budget_reservation_lease_conflict" } };
  }
  return { ok: true, value: account.reservation };
}

function requireReservationForSettlement(
  account: SessionBudgetAccount,
  input: RunBudgetIdentity,
): Result<
  Variant<RunBudgetReservationState, "active" | "indeterminate">,
  SessionBudgetError
> {
  if (account.kind !== "open") {
    return exhaustedError(account.exhaustion);
  }
  if (account.reservation.kind === "none") {
    return { ok: false, error: { code: "budget_reservation_missing" } };
  }
  if (
    account.reservation.reservation.reservationId !== input.reservationId ||
    account.reservation.reservation.runId !== input.runId ||
    account.reservation.reservation.runtimeGeneration !==
      input.runtimeGeneration ||
    account.reservation.reservation.turnLeaseGeneration !==
      input.turnLeaseGeneration
  ) {
    return { ok: false, error: { code: "budget_reservation_lease_conflict" } };
  }
  return { ok: true, value: account.reservation };
}

type StoredBudgetAccount = {
  readonly budgetJson: string;
  readonly usageJson: string;
  readonly usageCursor: number;
  readonly stateKind: "open" | "exhausted";
  readonly exhaustionJson: string | null;
  readonly reservationJson: string;
};

function encodeStoredBudgetAccount(
  account: SessionBudgetAccount,
): StoredBudgetAccount {
  switch (account.kind) {
    case "open":
      return {
        budgetJson: JSON.stringify(account.budget),
        usageJson: JSON.stringify(account.usage),
        usageCursor: account.usageCursor,
        stateKind: "open",
        exhaustionJson: null,
        reservationJson: JSON.stringify(account.reservation),
      };
    case "exhausted":
      return {
        budgetJson: JSON.stringify(account.budget),
        usageJson: JSON.stringify(account.usage),
        usageCursor: account.usageCursor,
        stateKind: "exhausted",
        exhaustionJson: JSON.stringify(account.exhaustion),
        reservationJson: JSON.stringify({ kind: "none" }),
      };
    default:
      return assertNever(account);
  }
}

function encodeBudgetEvent(event: BudgetEvent): string {
  switch (event.kind) {
    case "SessionBudgetInitialized":
    case "RunBudgetMarkedIndeterminate":
    case "RunBudgetUsageAccepted":
    case "SessionBudgetExhausted":
      return JSON.stringify({ kind: event.kind, account: event.account });
    case "RunBudgetSettled":
    case "RunBudgetReconciled":
      return JSON.stringify({
        kind: event.kind,
        account: event.account,
        runId: event.runId,
        reservationId: event.reservationId,
        runtimeGeneration: event.runtimeGeneration,
        turnLeaseGeneration: event.turnLeaseGeneration,
        budgetRevision: event.budgetRevision,
        usage: event.usage,
        outcome: event.outcome,
      });
    case "RunBudgetReserved":
      return JSON.stringify({
        kind: event.kind,
        reservation: event.reservation,
      });
    case "RunCapabilityClaimed":
      return JSON.stringify({ kind: event.kind, claim: event.claim });
    default:
      return assertNever(event);
  }
}

function decodeBudgetAccountRow(
  row: BudgetAccountRow,
): Result<SessionBudgetAccount, SessionBudgetError> {
  if (
    row.singleton !== 1 ||
    !nonEmpty(row.organisation_id) ||
    !nonEmpty(row.session_id) ||
    !isNonNegativeInteger(row.usage_cursor) ||
    !isNonNegativeInteger(row.updated_at) ||
    (row.state_kind !== "open" && row.state_kind !== "exhausted")
  ) {
    return invalidPersistedBudgetState();
  }
  const budgetJson = decodeJsonSyntax(row.budget_json);
  const usageJson = decodeJsonSyntax(row.usage_json);
  const reservationJson = decodeJsonSyntax(row.reservation_json);
  if (!budgetJson.ok || !usageJson.ok || !reservationJson.ok) {
    return invalidPersistedBudgetState();
  }
  const budget = decodeSessionBudget(budgetJson.value);
  const usage = decodeSessionBudgetUsage(usageJson.value);
  const reservation = decodeRunBudgetReservationState(reservationJson.value);
  if (!budget.ok || !usage.ok || !reservation.ok) {
    return invalidPersistedBudgetState();
  }
  if (row.state_kind === "open") {
    if (
      row.exhaustion_json !== null ||
      !isOpenBudgetStateConsistent(budget.value, usage.value, reservation.value)
    ) {
      return invalidPersistedBudgetState();
    }
    return {
      ok: true,
      value: {
        kind: "open",
        budget: budget.value,
        usage: usage.value,
        usageCursor: row.usage_cursor,
        reservation: reservation.value,
      },
    };
  }
  if (reservation.value.kind !== "none" || row.exhaustion_json === null) {
    return invalidPersistedBudgetState();
  }
  const exhaustionJson = decodeJsonSyntax(row.exhaustion_json);
  if (!exhaustionJson.ok) {
    return invalidPersistedBudgetState();
  }
  const exhaustion = decodeSessionBudgetExhaustion(
    exhaustionJson.value,
    budget.value,
  );
  if (
    !exhaustion.ok ||
    !usagesEqual(exhaustion.value.observedUsage, usage.value)
  ) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      kind: "exhausted",
      budget: budget.value,
      usage: usage.value,
      usageCursor: row.usage_cursor,
      exhaustion: exhaustion.value,
      reservation: { kind: "none" },
    },
  };
}

function decodeRunBudgetReservationState(
  value: unknown,
): Result<RunBudgetReservationState, SessionBudgetError> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return invalidPersistedBudgetState();
  }
  switch (value.kind) {
    case "none":
      if (!hasExactKeys(value, ["kind"])) {
        return invalidPersistedBudgetState();
      }
      return { ok: true, value: NONE_RESERVATION };
    case "active": {
      if (!hasExactKeys(value, ["kind", "reservation", "acceptedUsage"])) {
        return invalidPersistedBudgetState();
      }
      const reservation = decodeRunBudgetReservation(value.reservation);
      const usage = decodeSessionBudgetUsage(value.acceptedUsage);
      if (
        !reservation.ok ||
        !usage.ok ||
        !isReservationStateConsistent(reservation.value, usage.value)
      ) {
        return invalidPersistedBudgetState();
      }
      return {
        ok: true,
        value: {
          kind: "active",
          reservation: reservation.value,
          acceptedUsage: usage.value,
        },
      };
    }
    case "indeterminate": {
      if (
        !hasExactKeys(value, ["kind", "reservation", "acceptedUsage", "reason"])
      ) {
        return invalidPersistedBudgetState();
      }
      const reservation = decodeRunBudgetReservation(value.reservation);
      const usage = decodeSessionBudgetUsage(value.acceptedUsage);
      if (
        !reservation.ok ||
        !usage.ok ||
        !isRunBudgetIndeterminateReason(value.reason) ||
        !isReservationStateConsistent(reservation.value, usage.value)
      ) {
        return invalidPersistedBudgetState();
      }
      return {
        ok: true,
        value: {
          kind: "indeterminate",
          reservation: reservation.value,
          acceptedUsage: usage.value,
          reason: value.reason,
        },
      };
    }
    default:
      return invalidPersistedBudgetState();
  }
}

function decodeRunBudgetReservation(
  value: unknown,
): Result<RunBudgetReservation, SessionBudgetError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "reservationId",
      "runId",
      "turnId",
      "runtimeGeneration",
      "turnLeaseGeneration",
      "budgetRevision",
      "allowance",
      "acceptedAt",
      "deadlineAt",
    ]) ||
    !nonEmpty(value.reservationId) ||
    !nonEmpty(value.runId) ||
    !nonEmpty(value.turnId) ||
    !nonEmpty(value.budgetRevision) ||
    !safePositive(value.runtimeGeneration) ||
    !safePositive(value.turnLeaseGeneration) ||
    !isNonNegativeInteger(value.acceptedAt) ||
    !isNonNegativeInteger(value.deadlineAt) ||
    value.deadlineAt < value.acceptedAt
  ) {
    return invalidPersistedBudgetState();
  }
  const allowance = decodeSessionBudgetAllowance(value.allowance);
  if (
    !allowance.ok ||
    value.deadlineAt - value.acceptedAt !== allowance.value.activeWallMs
  ) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      reservationId: value.reservationId,
      runId: value.runId,
      turnId: value.turnId,
      runtimeGeneration: value.runtimeGeneration,
      turnLeaseGeneration: value.turnLeaseGeneration,
      budgetRevision: value.budgetRevision,
      allowance: allowance.value,
      acceptedAt: value.acceptedAt,
      deadlineAt: value.deadlineAt,
    },
  };
}

function decodeSessionBudgetAllowance(
  value: unknown,
): Result<SessionBudgetAllowance, SessionBudgetError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tokens", "activeWallMs", "capabilityCalls"]) ||
    !isNonNegativeInteger(value.tokens) ||
    !isNonNegativeInteger(value.activeWallMs) ||
    !isNonNegativeInteger(value.capabilityCalls)
  ) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      tokens: value.tokens,
      activeWallMs: value.activeWallMs,
      capabilityCalls: value.capabilityCalls,
    },
  };
}

function decodeSessionBudgetUsage(
  value: unknown,
): Result<SessionBudgetUsage, SessionBudgetError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tokens", "activeWallMs", "capabilityCalls"]) ||
    !isNonNegativeInteger(value.tokens) ||
    !isNonNegativeInteger(value.activeWallMs) ||
    !isNonNegativeInteger(value.capabilityCalls)
  ) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      tokens: value.tokens,
      activeWallMs: value.activeWallMs,
      capabilityCalls: value.capabilityCalls,
    },
  };
}

function decodeSessionBudgetExhaustion(
  value: unknown,
  budget: SessionBudget,
): Result<SessionBudgetExhaustion, SessionBudgetError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "exhaustionId",
      "dimension",
      "runId",
      "observedUsage",
      "exhaustedAt",
    ]) ||
    !nonEmpty(value.exhaustionId) ||
    !isSessionBudgetDimension(value.dimension) ||
    !nonEmpty(value.runId) ||
    !isNonNegativeInteger(value.exhaustedAt)
  ) {
    return invalidPersistedBudgetState();
  }
  const observedUsage = decodeSessionBudgetUsage(value.observedUsage);
  if (
    !observedUsage.ok ||
    !budgetDimensionReached(observedUsage.value, budget, value.dimension)
  ) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      exhaustionId: value.exhaustionId,
      dimension: value.dimension,
      runId: value.runId,
      observedUsage: observedUsage.value,
      exhaustedAt: value.exhaustedAt,
    },
  };
}

function decodeSessionBudgetAccount(
  value: unknown,
): Result<SessionBudgetAccount, SessionBudgetError> {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !isNonNegativeInteger(value.usageCursor)
  ) {
    return invalidPersistedBudgetState();
  }
  const budget = decodeSessionBudget(value.budget);
  const usage = decodeSessionBudgetUsage(value.usage);
  if (!budget.ok || !usage.ok) {
    return invalidPersistedBudgetState();
  }
  switch (value.kind) {
    case "open": {
      if (
        !hasExactKeys(value, [
          "kind",
          "budget",
          "usage",
          "usageCursor",
          "reservation",
        ])
      ) {
        return invalidPersistedBudgetState();
      }
      const reservation = decodeRunBudgetReservationState(value.reservation);
      if (
        !reservation.ok ||
        !isOpenBudgetStateConsistent(
          budget.value,
          usage.value,
          reservation.value,
        )
      ) {
        return invalidPersistedBudgetState();
      }
      return {
        ok: true,
        value: {
          kind: "open",
          budget: budget.value,
          usage: usage.value,
          usageCursor: value.usageCursor,
          reservation: reservation.value,
        },
      };
    }
    case "exhausted": {
      if (
        !hasExactKeys(value, [
          "kind",
          "budget",
          "usage",
          "usageCursor",
          "exhaustion",
          "reservation",
        ])
      ) {
        return invalidPersistedBudgetState();
      }
      const reservation = decodeRunBudgetReservationState(value.reservation);
      const exhaustion = decodeSessionBudgetExhaustion(
        value.exhaustion,
        budget.value,
      );
      if (
        !reservation.ok ||
        reservation.value.kind !== "none" ||
        !exhaustion.ok ||
        !usagesEqual(exhaustion.value.observedUsage, usage.value)
      ) {
        return invalidPersistedBudgetState();
      }
      return {
        ok: true,
        value: {
          kind: "exhausted",
          budget: budget.value,
          usage: usage.value,
          usageCursor: value.usageCursor,
          exhaustion: exhaustion.value,
          reservation: { kind: "none" },
        },
      };
    }
    default:
      return invalidPersistedBudgetState();
  }
}

function decodeSessionBudget(
  value: unknown,
): Result<SessionBudget, SessionBudgetError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "budgetRevision",
      "maxTokens",
      "maxWallMs",
      "maxToolCalls",
    ]) ||
    !nonEmpty(value.budgetRevision) ||
    !safePositive(value.maxTokens) ||
    !safePositive(value.maxWallMs) ||
    !safePositive(value.maxToolCalls)
  ) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      budgetRevision: value.budgetRevision,
      maxTokens: value.maxTokens,
      maxWallMs: value.maxWallMs,
      maxToolCalls: value.maxToolCalls,
    },
  };
}

function isUsageWithinAllowance(
  usage: SessionBudgetUsage,
  allowance: SessionBudgetAllowance,
): boolean {
  return (
    usage.tokens <= allowance.tokens &&
    usage.activeWallMs <= allowance.activeWallMs &&
    usage.capabilityCalls <= allowance.capabilityCalls
  );
}

/** The Session's total time is not limited; each run's time is. */
function isUsageWithinBudget(
  usage: SessionBudgetUsage,
  budget: SessionBudget,
): boolean {
  return (
    usage.tokens <= budget.maxTokens &&
    usage.capabilityCalls <= budget.maxToolCalls
  );
}

function budgetDimensionReached(
  usage: SessionBudgetUsage,
  budget: SessionBudget,
  dimension: SessionBudgetDimension,
): boolean {
  switch (dimension) {
    case "tokens":
      return usage.tokens >= budget.maxTokens;
    case "active_wall_ms":
      return usage.activeWallMs >= budget.maxWallMs;
    case "capability_calls":
      return usage.capabilityCalls >= budget.maxToolCalls;
    default:
      return assertNever(dimension);
  }
}

function usagesEqual(a: SessionBudgetUsage, b: SessionBudgetUsage): boolean {
  return (
    a.tokens === b.tokens &&
    a.activeWallMs === b.activeWallMs &&
    a.capabilityCalls === b.capabilityCalls
  );
}

function isReservationStateConsistent(
  reservation: RunBudgetReservation,
  acceptedUsage: SessionBudgetUsage,
): boolean {
  return isUsageWithinAllowance(acceptedUsage, reservation.allowance);
}

function isOpenBudgetStateConsistent(
  budget: SessionBudget,
  usage: SessionBudgetUsage,
  reservation: RunBudgetReservationState,
): boolean {
  if (!isUsageWithinBudget(usage, budget)) {
    return false;
  }
  switch (reservation.kind) {
    case "none":
      return true;
    case "active":
    case "indeterminate": {
      const acceptedUsage = reservation.acceptedUsage;
      if (
        reservation.reservation.budgetRevision !== budget.budgetRevision ||
        !isReservationStateConsistent(reservation.reservation, acceptedUsage) ||
        acceptedUsage.tokens > usage.tokens ||
        acceptedUsage.activeWallMs > usage.activeWallMs ||
        acceptedUsage.capabilityCalls > usage.capabilityCalls
      ) {
        return false;
      }
      return (
        reservation.reservation.allowance.tokens ===
          budget.maxTokens - (usage.tokens - acceptedUsage.tokens) &&
        reservation.reservation.allowance.activeWallMs <= budget.maxWallMs &&
        reservation.reservation.allowance.capabilityCalls ===
          budget.maxToolCalls -
            (usage.capabilityCalls - acceptedUsage.capabilityCalls)
      );
    }
    default:
      return assertNever(reservation);
  }
}

function normalizedUsage(
  usage: SessionBudgetUsage,
  acceptedAt: number,
  now: number,
): Result<SessionBudgetUsage, SessionBudgetError> {
  const decoded = decodeSessionBudgetUsage(usage);
  if (!decoded.ok) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "usage" },
    };
  }
  return {
    ok: true,
    value: {
      tokens: decoded.value.tokens,
      activeWallMs: Math.max(
        decoded.value.activeWallMs,
        Math.max(0, now - acceptedAt),
      ),
      capabilityCalls: decoded.value.capabilityCalls,
    },
  };
}

function decodeBudgetEvent(
  row: BudgetEventRow,
): Result<DecodedBudgetEvent, SessionBudgetError> {
  if (
    !isNonNegativeInteger(row.sequence) ||
    !nonEmpty(row.event_id) ||
    !nonEmpty(row.operation_id) ||
    !nonEmpty(row.organisation_id) ||
    !nonEmpty(row.session_id) ||
    !isNullableNonEmpty(row.run_id) ||
    !isNullableNonEmpty(row.reservation_id) ||
    !isNonNegativeInteger(row.at)
  ) {
    return invalidPersistedBudgetState();
  }
  if (
    row.event_id !==
    deterministicBudgetEventId(row.session_id, row.operation_id)
  ) {
    return invalidPersistedBudgetState();
  }
  const kind = decodeBudgetEventKind(row.kind);
  const payloadJson = decodeJsonSyntax(row.payload);
  if (kind === null || !payloadJson.ok) {
    return invalidPersistedBudgetState();
  }
  const payload = decodeBudgetEventPayload(kind, payloadJson.value);
  if (!payload.ok || !budgetEventIdentityMatches(row, payload.value)) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      sequence: row.sequence,
      eventId: row.event_id,
      operationId: row.operation_id,
      organisationId: row.organisation_id,
      sessionId: row.session_id,
      runId: row.run_id,
      reservationId: row.reservation_id,
      at: row.at,
      payload: payload.value,
    },
  };
}

function decodeBudgetEventPayload(
  kind: BudgetEventKind,
  value: unknown,
): Result<BudgetEvent, SessionBudgetError> {
  if (!isRecord(value) || value.kind !== kind) {
    return invalidPersistedBudgetState();
  }
  switch (kind) {
    case "SessionBudgetInitialized":
    case "RunBudgetMarkedIndeterminate":
    case "RunBudgetUsageAccepted":
    case "SessionBudgetExhausted": {
      if (!hasExactKeys(value, ["kind", "account"])) {
        return invalidPersistedBudgetState();
      }
      const account = decodeSessionBudgetAccount(value.account);
      return account.ok
        ? { ok: true, value: { kind, account: account.value } }
        : invalidPersistedBudgetState();
    }
    case "RunBudgetSettled":
    case "RunBudgetReconciled": {
      if (
        !hasExactKeys(value, [
          "kind",
          "account",
          "runId",
          "reservationId",
          "runtimeGeneration",
          "turnLeaseGeneration",
          "budgetRevision",
          "usage",
          "outcome",
        ]) ||
        !nonEmpty(value.runId) ||
        !nonEmpty(value.reservationId) ||
        !safePositive(value.runtimeGeneration) ||
        !safePositive(value.turnLeaseGeneration) ||
        !nonEmpty(value.budgetRevision) ||
        !isRunBudgetOutcome(value.outcome)
      ) {
        return invalidPersistedBudgetState();
      }
      const account = decodeSessionBudgetAccount(value.account);
      const usage = decodeSessionBudgetUsage(value.usage);
      return account.ok && usage.ok
        ? {
            ok: true,
            value: {
              kind,
              account: account.value,
              runId: value.runId,
              reservationId: value.reservationId,
              runtimeGeneration: value.runtimeGeneration,
              turnLeaseGeneration: value.turnLeaseGeneration,
              budgetRevision: value.budgetRevision,
              usage: usage.value,
              outcome: value.outcome,
            },
          }
        : invalidPersistedBudgetState();
    }
    case "RunBudgetReserved": {
      if (!hasExactKeys(value, ["kind", "reservation"])) {
        return invalidPersistedBudgetState();
      }
      const reservation = decodeRunBudgetReservation(value.reservation);
      return reservation.ok
        ? { ok: true, value: { kind, reservation: reservation.value } }
        : invalidPersistedBudgetState();
    }
    case "RunCapabilityClaimed": {
      if (!hasExactKeys(value, ["kind", "claim"])) {
        return invalidPersistedBudgetState();
      }
      const claim = decodePersistedCapabilityBudgetClaim(value.claim);
      return claim.ok
        ? { ok: true, value: { kind, claim: claim.value } }
        : invalidPersistedBudgetState();
    }
    default:
      return assertNever(kind);
  }
}

function budgetEventIdentityMatches(
  row: BudgetEventRow,
  event: BudgetEvent,
): boolean {
  switch (event.kind) {
    case "SessionBudgetInitialized":
      return (
        row.run_id === null &&
        row.reservation_id === null &&
        event.account.kind === "open" &&
        event.account.reservation.kind === "none" &&
        usagesEqual(event.account.usage, ZERO_USAGE)
      );
    case "RunBudgetReserved":
      return (
        row.run_id === event.reservation.runId &&
        row.reservation_id === event.reservation.reservationId
      );
    case "RunCapabilityClaimed":
      return (
        row.run_id === event.claim.runId &&
        row.reservation_id === event.claim.reservationId
      );
    case "RunBudgetMarkedIndeterminate":
      return (
        event.account.kind === "open" &&
        event.account.reservation.kind === "indeterminate" &&
        row.run_id === event.account.reservation.reservation.runId &&
        row.reservation_id ===
          event.account.reservation.reservation.reservationId
      );
    case "RunBudgetSettled":
    case "RunBudgetReconciled":
      return (
        row.run_id === event.runId &&
        row.reservation_id === event.reservationId &&
        event.account.kind === "open" &&
        event.account.reservation.kind === "none"
      );
    case "RunBudgetUsageAccepted":
      return (
        event.account.kind === "open" &&
        event.account.reservation.kind === "active" &&
        row.run_id === event.account.reservation.reservation.runId &&
        row.reservation_id ===
          event.account.reservation.reservation.reservationId
      );
    case "SessionBudgetExhausted":
      return (
        event.account.kind === "exhausted" &&
        row.run_id === event.account.exhaustion.runId &&
        row.reservation_id !== null
      );
    default:
      return assertNever(event);
  }
}

function decodePersistedCapabilityBudgetClaim(
  value: unknown,
): Result<PersistedCapabilityBudgetClaim, SessionBudgetError> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "claimId",
      "reservationId",
      "usage",
      "runId",
      "runtimeGeneration",
      "turnLeaseGeneration",
      "budgetRevision",
    ]) ||
    value.kind !== "accepted" ||
    !nonEmpty(value.claimId) ||
    !nonEmpty(value.reservationId) ||
    !nonEmpty(value.runId) ||
    !safePositive(value.runtimeGeneration) ||
    !safePositive(value.turnLeaseGeneration) ||
    !nonEmpty(value.budgetRevision)
  ) {
    return invalidPersistedBudgetState();
  }
  const usage = decodeSessionBudgetUsage(value.usage);
  if (!usage.ok) {
    return invalidPersistedBudgetState();
  }
  return {
    ok: true,
    value: {
      kind: value.kind,
      claimId: value.claimId,
      reservationId: value.reservationId,
      usage: usage.value,
      runId: value.runId,
      runtimeGeneration: value.runtimeGeneration,
      turnLeaseGeneration: value.turnLeaseGeneration,
      budgetRevision: value.budgetRevision,
    },
  };
}

function decodeBudgetAccountEvent(
  row: BudgetEventRow,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const event = decodeBudgetEvent(row);
  if (!event.ok) {
    return event;
  }
  switch (event.value.payload.kind) {
    case "SessionBudgetInitialized":
    case "RunBudgetMarkedIndeterminate":
    case "RunBudgetSettled":
    case "RunBudgetReconciled":
    case "RunBudgetUsageAccepted":
    case "SessionBudgetExhausted":
      return { ok: true, value: event.value.payload.account };
    case "RunBudgetReserved":
    case "RunCapabilityClaimed":
      return invalidPersistedBudgetState();
    default:
      return assertNever(event.value.payload);
  }
}

function duplicateAccountEvent(
  row: BudgetEventRow,
  expected: {
    readonly organisationId: string;
    readonly sessionId: string;
    readonly runId?: string;
    readonly reservationId?: string;
    readonly kind: BudgetEventKind;
  },
): Result<SessionBudgetAccount, SessionBudgetError> {
  if (
    row.organisation_id !== expected.organisationId ||
    row.session_id !== expected.sessionId ||
    row.kind !== expected.kind ||
    (expected.runId !== undefined && row.run_id !== expected.runId) ||
    (expected.reservationId !== undefined &&
      row.reservation_id !== expected.reservationId)
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  return decodeBudgetAccountEvent(row);
}

function duplicateIndeterminateEvent(
  row: BudgetEventRow,
  input: MarkRunBudgetIndeterminateInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = duplicateAccountEvent(row, {
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    runId: input.runId,
    reservationId: input.reservationId,
    kind: "RunBudgetMarkedIndeterminate",
  });
  if (!account.ok) {
    return account;
  }
  if (
    account.value.kind !== "open" ||
    account.value.reservation.kind !== "indeterminate" ||
    account.value.reservation.reason !== input.reason ||
    account.value.reservation.reservation.runtimeGeneration !==
      input.runtimeGeneration ||
    account.value.reservation.reservation.turnLeaseGeneration !==
      input.turnLeaseGeneration ||
    account.value.reservation.reservation.budgetRevision !==
      input.budgetRevision
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  return account;
}

function duplicateSettlementEvent(
  row: BudgetEventRow,
  input: SettleRunBudgetInput | ReconcileRunBudgetInput,
  eventKind: "RunBudgetSettled" | "RunBudgetReconciled",
): Result<SessionBudgetAccount, SessionBudgetError> {
  if (
    row.organisation_id !== input.organisationId ||
    row.session_id !== input.sessionId ||
    row.run_id !== input.runId ||
    row.reservation_id !== input.reservationId ||
    row.kind !== eventKind
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const event = decodeBudgetEvent(row);
  if (!event.ok) {
    return event;
  }
  switch (event.value.payload.kind) {
    case "RunBudgetSettled":
    case "RunBudgetReconciled": {
      const payload = event.value.payload;
      const requestedUsage = decodeSessionBudgetUsage(input.usage);
      if (!requestedUsage.ok) {
        return {
          ok: false,
          error: { code: "invalid_budget_input", field: "usage" },
        };
      }
      if (
        payload.kind !== eventKind ||
        payload.runtimeGeneration !== input.runtimeGeneration ||
        payload.turnLeaseGeneration !== input.turnLeaseGeneration ||
        payload.budgetRevision !== input.budgetRevision ||
        !usagesEqual(payload.usage, requestedUsage.value) ||
        payload.outcome !== input.outcome
      ) {
        return { ok: false, error: { code: "budget_operation_conflict" } };
      }
      return { ok: true, value: payload.account };
    }
    default:
      return { ok: false, error: { code: "budget_operation_conflict" } };
  }
}

function duplicateUsageAcceptedEvent(
  row: BudgetEventRow,
  input: AcceptRunModelUsageInput,
): Result<SessionBudgetAccount, SessionBudgetError> {
  const account = duplicateAccountEvent(row, {
    organisationId: input.organisationId,
    sessionId: input.sessionId,
    runId: input.runId,
    reservationId: input.reservationId,
    kind: "RunBudgetUsageAccepted",
  });
  if (!account.ok) {
    return account;
  }
  if (
    account.value.kind !== "open" ||
    account.value.reservation.kind !== "active"
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const reservation = account.value.reservation.reservation;
  if (
    reservation.runtimeGeneration !== input.runtimeGeneration ||
    reservation.turnLeaseGeneration !== input.turnLeaseGeneration ||
    reservation.budgetRevision !== input.budgetRevision
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const usage = normalizedUsage(input.usage, reservation.acceptedAt, row.at);
  if (!usage.ok) {
    return usage;
  }
  return usagesEqual(usage.value, account.value.reservation.acceptedUsage)
    ? account
    : { ok: false, error: { code: "budget_operation_conflict" } };
}

function replayExhaustionError(
  row: BudgetEventRow,
  expected: BudgetRunEventIdentity,
): Result<never, SessionBudgetError> | null {
  if (row.kind !== "SessionBudgetExhausted") {
    return null;
  }
  if (
    row.organisation_id !== expected.organisationId ||
    row.session_id !== expected.sessionId ||
    row.run_id !== expected.runId ||
    row.reservation_id !== expected.reservationId
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const account = decodeBudgetAccountEvent(row);
  if (!account.ok) {
    return account;
  }
  return account.value.kind === "exhausted"
    ? exhaustedError(account.value.exhaustion)
    : { ok: false, error: { code: "budget_operation_conflict" } };
}

function replayExpiredExhaustionError(
  row: BudgetEventRow,
  expected: BudgetIdentity,
): Result<SessionBudgetAccount, SessionBudgetError> | null {
  if (row.kind !== "SessionBudgetExhausted") {
    return null;
  }
  if (
    row.organisation_id !== expected.organisationId ||
    row.session_id !== expected.sessionId
  ) {
    return { ok: false, error: { code: "budget_operation_conflict" } };
  }
  const account = decodeBudgetAccountEvent(row);
  if (!account.ok) {
    return account;
  }
  return account.value.kind === "exhausted"
    ? exhaustedError(account.value.exhaustion)
    : { ok: false, error: { code: "budget_operation_conflict" } };
}

function decodeBudgetReservationEvent(
  row: BudgetEventRow,
): Result<RunBudgetReservation, SessionBudgetError> {
  const event = decodeBudgetEvent(row);
  if (!event.ok) {
    return event;
  }
  const payload = event.value.payload;
  return payload.kind === "RunBudgetReserved"
    ? { ok: true, value: payload.reservation }
    : invalidPersistedBudgetState();
}

function decodeBudgetCapabilityEvent(
  row: BudgetEventRow,
): Result<PersistedCapabilityBudgetClaim, SessionBudgetError> {
  const event = decodeBudgetEvent(row);
  if (!event.ok) {
    return event;
  }
  const payload = event.value.payload;
  if (payload.kind !== "RunCapabilityClaimed") {
    return invalidPersistedBudgetState();
  }
  return { ok: true, value: payload.claim };
}

function readAccountRow(sql: SqlStorage): BudgetAccountRow | undefined {
  return sql
    .exec<BudgetAccountRow>(
      `SELECT singleton, organisation_id, session_id, budget_json, usage_json, usage_cursor,
            state_kind, exhaustion_json, reservation_json, updated_at
     FROM session_budget_account WHERE singleton = 1 LIMIT 1`,
    )
    .toArray()[0];
}

function readOperation(
  sql: SqlStorage,
  operationId: string,
): BudgetEventRow | undefined {
  return sql
    .exec<BudgetEventRow>(
      `SELECT sequence, event_id, operation_id, organisation_id, session_id, run_id,
            reservation_id, kind, payload, at
     FROM session_budget_event WHERE operation_id = ? LIMIT 1`,
      operationId,
    )
    .toArray()[0];
}

function validateIdentity(input: BudgetIdentity): SessionBudgetError | null {
  if (!nonEmpty(input.organisationId)) {
    return { code: "invalid_budget_input", field: "organisationId" };
  }
  if (!nonEmpty(input.sessionId)) {
    return { code: "invalid_budget_input", field: "sessionId" };
  }
  if (!nonEmpty(input.operationId)) {
    return { code: "invalid_budget_input", field: "operationId" };
  }
  if (!isNonNegativeInteger(input.now)) {
    return { code: "invalid_budget_input", field: "now" };
  }
  return null;
}

function validateRunIdentity(
  input: RunBudgetIdentity,
): SessionBudgetError | null {
  const identity = validateIdentity(input);
  if (identity !== null) {
    return identity;
  }
  if (!nonEmpty(input.runId)) {
    return { code: "invalid_budget_input", field: "runId" };
  }
  if (!nonEmpty(input.reservationId)) {
    return { code: "invalid_budget_input", field: "reservationId" };
  }
  if (!safePositive(input.runtimeGeneration)) {
    return { code: "invalid_budget_input", field: "runtimeGeneration" };
  }
  if (!safePositive(input.turnLeaseGeneration)) {
    return { code: "invalid_budget_input", field: "turnLeaseGeneration" };
  }
  if (!nonEmpty(input.budgetRevision)) {
    return { code: "invalid_budget_input", field: "budgetRevision" };
  }
  return null;
}

function normalizeBudget(
  value: SessionBudget,
): Result<SessionBudget, SessionBudgetError> {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "budget" },
    };
  }
  if (!nonEmpty(value.budgetRevision)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "budgetRevision" },
    };
  }
  if (!safePositive(value.maxTokens)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "maxTokens" },
    };
  }
  if (!safePositive(value.maxWallMs)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "maxWallMs" },
    };
  }
  if (!safePositive(value.maxToolCalls)) {
    return {
      ok: false,
      error: { code: "invalid_budget_input", field: "maxToolCalls" },
    };
  }
  return {
    ok: true,
    value: {
      budgetRevision: value.budgetRevision,
      maxTokens: value.maxTokens,
      maxWallMs: value.maxWallMs,
      maxToolCalls: value.maxToolCalls,
    },
  };
}

function budgetsEqual(a: SessionBudget, b: SessionBudget): boolean {
  return (
    a.budgetRevision === b.budgetRevision &&
    a.maxTokens === b.maxTokens &&
    a.maxWallMs === b.maxWallMs &&
    a.maxToolCalls === b.maxToolCalls
  );
}

function remainingAllowance(
  budget: SessionBudget,
  usage: SessionBudgetUsage,
): SessionBudgetAllowance {
  return {
    tokens: Math.max(0, budget.maxTokens - usage.tokens),
    // Each run gets the whole time limit.
    activeWallMs: budget.maxWallMs,
    capabilityCalls: Math.max(0, budget.maxToolCalls - usage.capabilityCalls),
  };
}

function firstExceededDimension(
  usage: SessionBudgetUsage,
  budget: SessionBudget,
): SessionBudgetDimension | null {
  if (usage.tokens > budget.maxTokens) {
    return "tokens";
  }
  if (usage.capabilityCalls > budget.maxToolCalls) {
    return "capability_calls";
  }
  return null;
}

function addUsage(
  a: SessionBudgetUsage,
  b: SessionBudgetUsage,
): SessionBudgetUsage {
  return {
    tokens: a.tokens + b.tokens,
    activeWallMs: a.activeWallMs + b.activeWallMs,
    capabilityCalls: a.capabilityCalls + b.capabilityCalls,
  };
}

function subtractUsage(
  a: SessionBudgetUsage,
  b: SessionBudgetUsage,
): SessionBudgetUsage {
  return {
    tokens: a.tokens - b.tokens,
    activeWallMs: a.activeWallMs - b.activeWallMs,
    capabilityCalls: a.capabilityCalls - b.capabilityCalls,
  };
}

function deterministicReservationId(input: ReserveRunBudgetInput): string {
  return `reservation_${input.sessionId}_${input.runId}_${input.runtimeGeneration}_${input.turnLeaseGeneration}_${input.budgetRevision}`;
}

function deterministicBudgetEventId(
  sessionId: string,
  operationId: string,
): string {
  return `budget_event_${sessionId}_${operationId}`;
}

function exhaustedError(
  exhaustion: SessionBudgetExhaustion,
): Result<never, SessionBudgetError> {
  return { ok: false, error: { code: "budget_exhausted", exhaustion } };
}

function invalidPersistedBudgetState(): Result<never, SessionBudgetError> {
  return { ok: false, error: { code: "budget_persisted_state_invalid" } };
}

function decodeJsonSyntax(
  raw: string | null,
): Result<unknown, SessionBudgetError> {
  if (typeof raw !== "string") {
    return invalidPersistedBudgetState();
  }
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, value };
  } catch {
    return invalidPersistedBudgetState();
  }
}

function decodeBudgetEventKind(value: unknown): BudgetEventKind | null {
  if (
    value === "SessionBudgetInitialized" ||
    value === "RunBudgetReserved" ||
    value === "RunCapabilityClaimed" ||
    value === "RunBudgetMarkedIndeterminate" ||
    value === "RunBudgetSettled" ||
    value === "RunBudgetReconciled" ||
    value === "RunBudgetUsageAccepted" ||
    value === "SessionBudgetExhausted"
  ) {
    return value;
  }
  return null;
}

function isRunBudgetIndeterminateReason(
  value: unknown,
): value is RunBudgetIndeterminateReason {
  return (
    value === "model_receipt_missing" ||
    value === "capability_receipt_missing" ||
    value === "provider_effect_indeterminate" ||
    value === "executor_receipt_missing"
  );
}

function isRunBudgetOutcome(
  value: unknown,
): value is "succeeded" | "failed" | "cancelled" {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

function isSessionBudgetDimension(
  value: unknown,
): value is SessionBudgetDimension {
  return (
    value === "tokens" ||
    value === "active_wall_ms" ||
    value === "capability_calls"
  );
}

function isNullableNonEmpty(value: unknown): value is string | null {
  return value === null || nonEmpty(value);
}

function nonEmpty(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function safePositive(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

export function canonicalRunBudgetIdentity(
  lease: HarnessTurnLease,
): Omit<ReserveRunBudgetInput, "turnId" | "operationId" | "now"> {
  const runId = `run_${lease.turn.turnId}_${lease.runtimeLease.generation}_${lease.turn.turnLeaseGeneration}`;
  return {
    organisationId: lease.session.organisationId,
    sessionId: lease.session.sessionId,
    runId,
    reservationId: `reservation_${lease.session.sessionId}_${runId}_${lease.runtimeLease.generation}_${lease.turn.turnLeaseGeneration}_${lease.turn.budgetRevision}`,
    runtimeGeneration: lease.runtimeLease.generation,
    turnLeaseGeneration: lease.turn.turnLeaseGeneration,
    budgetRevision: lease.turn.budgetRevision,
  };
}
