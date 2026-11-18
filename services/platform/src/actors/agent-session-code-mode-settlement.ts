import type {
  AgentSessionLifecycle,
  CodeModeExecutionReceipt,
  EventEnvelope,
  HarnessTurnLease,
  SessionTransition,
} from "@seams/contracts";

import { validateCanonicalSessionAdvance } from "../actor-wasm";
import type { Env } from "../env";
import {
  newRequestId,
  parseRequestId,
  parseOrganisationId,
  type OrganisationId,
} from "../ids";
import { traceLog, traceWarn } from "../observability";
import type { Result } from "../result";
import { parseWorkspaceReceipt } from "../workspace-revision-store";
import {
  commitExecutionSettledSession,
  commitQuarantinedSession,
  type ActorTransactionStorage,
  type ExecutionSettledSessionCommit,
  type QuarantinedSessionCommit,
} from "./actor-journal";
import {
  readCanonicalSessionProjection,
  readImportedCanonicalSession,
} from "./agent-session-canonical";
import { codeModeExecutionEffectId } from "./code-mode-execution-record";
import {
  markCodeModeExecutionReleased,
  readEndedCodeModeExecutions,
  releaseCodeModeReservation,
  type CodeModeReservationCancel,
} from "./code-mode-execution-release";
import {
  parsePersistedHarnessTurnLease,
  preflightHarnessTurnLease,
} from "./agent-session-harness-authority";
import {
  CODE_MODE_ENGINE_RESERVED_COST_MICROS,
  CODE_MODE_PRICE_BOOK_REVISION_V2,
  WORKSPACE_EXECUTOR_RESERVED_COST_MICROS,
  parseCodeModeSettleInput,
  type CodeModeOrganisationCancelInput,
  type CodeModeOrganisationSettleInput,
} from "./code-mode-budget";
import { codeModePlatformGovernor } from "./code-mode-platform-governor-stub";
import {
  requireActiveOrganisationActorAtPlacement,
  organisationActorStub,
} from "./actor-router";
import { SessionExecutionAdmission } from "./session-execution-admission";
import { readActivationExportSource } from "./actor-export";
import {
  listPlacementActorRegistryEntries,
  type ActorFenceToken,
  type ActorRegistryEntry,
} from "./actor-registry";
import { readPlacementByEpoch } from "../data/organisation-placement";
import { selectOrganisationPlacementDatabase } from "../organisation-execution-scope";
import type { ActorRelocationId } from "./actor-relocation";
import {
  frozenRelocationReceiptGate,
  type RelocationReceiptError,
} from "./actor-relocation-state";
import type { Variant } from "@seams/type-utils";
import { canonicalJson, isRecord, nonNegativeIntegerOrNull } from "@seams/std";
import type {
  HarnessCodeModeExecutionLease,
  HarnessCodeModeExecutionOutcome,
} from "../agent-tools/catalog/types";
import { armAlarmBy } from "./lifecycle/actor-alarm";

const SETTLEMENT_KIND = "code_mode_execution_settlement.v1";
const SETTLEMENT_RECOVERY_DELAY_MS = 1_000;
/** When the alarm looks again at a settlement that it could not finish. */
const SETTLEMENT_RETRY_DELAY_MS = 5_000;
/**
 * How long a live turn's own dispatch holds its settlement (Refactor 15,
 * refactor 3). While it holds it, the alarm leaves the settlement to the
 * turn; after it, the alarm takes over, so a turn whose call never answers
 * does not hold the settlement for good.
 */
const LIVE_DISPATCH_CLAIM_MS = 60_000;

/**
 * The settlements that a live turn of this isolate dispatches now, by effect,
 * with the time that the dispatch started. The claims live in memory: a lost
 * process loses them, and the alarm of the next process recovers the
 * settlement as its own.
 */
const liveDispatches = new WeakMap<object, Map<string, number>>();

function liveClaims(storage: object): Map<string, number> {
  let claims = liveDispatches.get(storage);
  if (claims === undefined) {
    claims = new Map();
    liveDispatches.set(storage, claims);
  }
  return claims;
}

/** True while a live turn's dispatch holds the settlement. */
function heldByLiveTurn(
  storage: object,
  effectId: string,
  now: number,
): boolean {
  const startedAt = liveClaims(storage).get(effectId);
  return startedAt !== undefined && now - startedAt < LIVE_DISPATCH_CLAIM_MS;
}

/** Runs a turn's own dispatch with its claim on the settlement. */
async function dispatchAsLiveTurn(
  input: Parameters<typeof dispatchSettlement>[0],
): Promise<Result<null, CodeModeSettlementError>> {
  const claims = liveClaims(input.storage);
  claims.set(input.effectId, Date.now());
  try {
    return await dispatchSettlement(input);
  } finally {
    claims.delete(input.effectId);
  }
}

export type RelocationSessionSettlementRequest = {
  readonly relocationId: ActorRelocationId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly now: number;
};

type FrozenSessionSettlementError =
  | RelocationReceiptError
  | {
      readonly code: "relocation_provider_work_unresolved";
      readonly operationId: string;
    };

/** Reconcile recorded results only. Unknown effects remain relocation blockers. */
export async function reconcileFrozenCodeModeSettlements(
  env: Env,
  storage: DurableObjectStorage,
  input: RelocationSessionSettlementRequest,
): Promise<Result<null, FrozenSessionSettlementError>> {
  const activation = readActivationExportSource(storage.sql);
  if (
    !activation.ok ||
    activation.value.identity.objectKind !== "session" ||
    activation.value.fenceToken !== input.expectedFenceToken
  )
    return rejectedFrozenSettlement();
  const source = activation.value;
  const rows = storage.sql
    .exec<SettlementRow>(
      `SELECT effect_id, organisation_id, request_envelope, state_kind, state_projection
     FROM actor_outbox WHERE state_kind IN ('pending', 'dispatching', 'indeterminate')
       AND json_extract(request_envelope, '$.kind') = ? ORDER BY effect_id`,
      SETTLEMENT_KIND,
    )
    .toArray();
  // The freeze ended the turn of a script that was running. Its execution
  // has no settlement: it is released here, with the settlements.
  const ended = readEndedExecutions(storage.sql);
  if (rows.length === 0 && ended.length === 0) return { ok: true, value: null };
  const gate = frozenRelocationReceiptGate(env.DB, source, input.relocationId);
  if ((await gate.first()) === null) return rejectedFrozenSettlement();
  const placement = await readPlacementByEpoch(
    env.DB,
    source.identity.organisationId,
    source.placementEpoch,
  );
  if (!placement.ok) return rejectedFrozenSettlement();
  const database = selectOrganisationPlacementDatabase(
    env,
    source.identity.organisationId,
    placement.value.placement,
  );
  if (!database.ok) return rejectedFrozenSettlement();
  const entries = await listPlacementActorRegistryEntries({
    db: database.value,
    organisationId: source.identity.organisationId,
    placementEpoch: source.placementEpoch,
  });
  if (!entries.ok) return rejectedFrozenSettlement();
  const organisationEntry = entries.value.find(isOrganisationSettlementEntry);
  if (organisationEntry === undefined) return rejectedFrozenSettlement();
  const organisation = organisationActorStub(
    env.ORGANISATION,
    organisationEntry.physicalObjectName,
    organisationEntry.placement,
  );
  for (const row of rows) {
    const request = parseSettlementRequest(row.request_envelope);
    if (
      request === null ||
      row.organisation_id !== source.identity.organisationId ||
      request.settle.organisationId !== source.identity.organisationId ||
      request.lease.session.sessionId !== source.identity.logicalObjectId ||
      row.effect_id !== settlementEffectId(request.settle.executionId)
    )
      return unresolvedFrozenSettlement(row.effect_id);
    if ((await gate.first()) === null) return rejectedFrozenSettlement();
    const organisationSettled = await organisation.settleCodeModeBudget(
      request.settle,
    );
    if (!organisationSettled.ok || organisationSettled.value.kind !== "settled")
      return unresolvedFrozenSettlement(row.effect_id);
    const platformSettled = await codeModePlatformGovernor(env).settle(
      request.settle,
    );
    if (!platformSettled.ok || platformSettled.value.kind !== "settled")
      return unresolvedFrozenSettlement(row.effect_id);
    if ((await gate.first()) === null) return rejectedFrozenSettlement();
    const committed = storage.transactionSync(
      commitFrozenSettlement.bind(null, storage.sql, row, request, input),
    );
    if (!committed) return rejectedFrozenSettlement();
  }
  for (const record of ended) {
    if ((await gate.first()) === null) return rejectedFrozenSettlement();
    const release = await releaseCodeModeReservation({
      record,
      organisation: cancelAtOrganisation.bind(null, organisation),
      platform: cancelAtPlatform.bind(null, env),
      now: input.now,
    });
    if (release.kind === "deferred")
      return unresolvedFrozenSettlement(
        codeModeExecutionEffectId(record.executionId),
      );
    if ((await gate.first()) === null) return rejectedFrozenSettlement();
    const released = storage.transactionSync(
      markCodeModeExecutionReleased.bind(
        null,
        storage.sql,
        record,
        release,
        { relocationId: input.relocationId },
        input.now,
      ),
    );
    if (!released) return rejectedFrozenSettlement();
  }
  return { ok: true, value: null };
}

/**
 * Releases the executions whose turns ended before their scripts settled: a
 * cancelled turn, a failed turn, or a turn that could not resume. `deferred`
 * tells the caller to repeat the release, because an owner did not decide.
 */
export async function releaseEndedCodeModeExecutions(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly now: number;
}): Promise<{ readonly deferred: boolean }> {
  const ended = readEndedExecutions(input.storage.sql);
  const organisationId = ended[0]?.organisationId;
  if (organisationId === undefined) return { deferred: false };
  const execution = await SessionExecutionAdmission.resolve(
    input.env,
    input.storage,
    organisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return { deferred: true };
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId,
    placement: execution.scope.placement,
    now: input.now,
  });
  let deferred = false;
  for (const record of ended) {
    const release = await releaseCodeModeReservation({
      record,
      organisation: cancelAtOrganisation.bind(null, organisation),
      platform: cancelAtPlatform.bind(null, input.env),
      now: input.now,
    });
    if (release.kind === "deferred") {
      deferred = true;
      traceWarn("code_mode.execution_release_deferred", {
        requestId: newRequestId(),
        organisation_id: record.organisationId,
        execution_id: record.executionId,
        reason: release.reason,
      });
      continue;
    }
    input.storage.transactionSync(
      markCodeModeExecutionReleased.bind(
        null,
        input.storage.sql,
        record,
        release,
        {},
        input.now,
      ),
    );
    traceLog("code_mode.execution_released", {
      requestId: newRequestId(),
      organisation_id: record.organisationId,
      execution_id: record.executionId,
      organisation_reservation: release.organisation,
      platform_reservation: release.platform,
    });
  }
  return { deferred };
}

/** The age after which a quarantined Session settles a settlement itself. */
const QUARANTINED_SETTLEMENT_AGE_MS = 24 * 60 * 60_000;

type QuarantinedSettlementDecision =
  | {
      readonly kind: "decided";
      readonly outcome:
        "settled" | "reservation_expired" | "reservation_cancelled";
    }
  | { readonly kind: "undecided"; readonly reason: string };

/**
 * Settles the indeterminate settlements, older than one day, of a Session that
 * a refused settlement quarantined (Refactor 15). Only the owners' records
 * decide. The Organisation answers the same settlement from its reservation:
 * a reservation settled with this receipt (and the governor's too) settled
 * it; an expired or cancelled one never settled it, and it cannot settle, and
 * the governor only settles after the Organisation. Any other answer leaves
 * the settlement indeterminate. The quarantined Session runs no turn, so no
 * dispatch races this one. Returns the number of settled rows.
 */
export async function reconcileQuarantinedCodeModeSettlements(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly sessionId: string;
  readonly now: number;
}): Promise<number> {
  const rows = input.storage.sql
    .exec<SettlementRow>(
      `SELECT effect_id, organisation_id, request_envelope, state_kind, state_projection
     FROM actor_outbox WHERE state_kind = 'indeterminate'
       AND json_extract(request_envelope, '$.kind') = ? AND updated_at <= ?
     ORDER BY updated_at ASC LIMIT 8`,
      SETTLEMENT_KIND,
      input.now - QUARANTINED_SETTLEMENT_AGE_MS,
    )
    .toArray();
  let settled = 0;
  for (const row of rows) {
    let decision: QuarantinedSettlementDecision;
    try {
      decision = await decideQuarantinedSettlement(input, row);
    } catch {
      decision = { kind: "undecided", reason: "owner_unreachable" };
    }
    const trace = {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
      session_id: input.sessionId,
      effect_id: row.effect_id,
    };
    if (decision.kind === "undecided") {
      traceWarn("session.code_mode_settlement_undecided", {
        ...trace,
        reason: decision.reason,
      });
      continue;
    }
    const committed = input.storage.transactionSync(
      commitQuarantinedSettlement.bind(
        null,
        input.storage.sql,
        row,
        decision.outcome,
        input.now,
      ),
    );
    if (!committed) continue;
    settled += 1;
    traceWarn("session.code_mode_settlement_reconciled", {
      ...trace,
      outcome: decision.outcome,
    });
  }
  return settled;
}

async function decideQuarantinedSettlement(
  input: Parameters<typeof reconcileQuarantinedCodeModeSettlements>[0],
  row: SettlementRow,
): Promise<QuarantinedSettlementDecision> {
  const request = parseSettlementRequest(row.request_envelope);
  if (
    request === null ||
    row.organisation_id !== input.organisationId ||
    request.settle.organisationId !== input.organisationId ||
    request.lease.session.sessionId !== input.sessionId ||
    row.effect_id !== settlementEffectId(request.settle.executionId)
  )
    return { kind: "undecided", reason: "invalid_persisted_request" };
  const execution = await SessionExecutionAdmission.resolve(
    input.env,
    input.storage,
    input.organisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return { kind: "undecided", reason: "organisation_inactive" };
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: execution.scope.placement,
    now: input.now,
  });
  // The owners expire a reservation at the time of the request.
  const settle = { ...request.settle, now: input.now };
  const answer = await organisation.settleCodeModeBudget(settle);
  if (!answer.ok) {
    const error = answer.error;
    if (error.code === "code_mode_reservation_expired")
      return { kind: "decided", outcome: "reservation_expired" };
    if (
      error.code === "code_mode_reservation_invalid_transition" &&
      "state" in error &&
      error.state === "cancelled"
    )
      return { kind: "decided", outcome: "reservation_cancelled" };
    return { kind: "undecided", reason: error.code };
  }
  if (answer.value.kind !== "settled")
    return { kind: "undecided", reason: `organisation_${answer.value.kind}` };
  const platform = await codeModePlatformGovernor(input.env).settle(settle);
  if (!platform.ok) return { kind: "undecided", reason: platform.error.code };
  return platform.value.kind === "settled"
    ? { kind: "decided", outcome: "settled" }
    : { kind: "undecided", reason: `platform_${platform.value.kind}` };
}

function commitQuarantinedSettlement(
  sql: SqlStorage,
  row: SettlementRow,
  outcome: Extract<
    QuarantinedSettlementDecision,
    { kind: "decided" }
  >["outcome"],
  now: number,
): boolean {
  const updated = sql.exec(
    `UPDATE actor_outbox SET state_kind = 'reconciled', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND organisation_id = ? AND request_envelope = ?
       AND state_kind = 'indeterminate'`,
    JSON.stringify({
      kind: "settlement_reconciled",
      outcome,
      reconciledAt: now,
    }),
    now,
    row.effect_id,
    row.organisation_id,
    row.request_envelope,
  );
  return updated.rowsWritten === 1;
}

/**
 * The open executions that no turn of this Session owns now. A Session that
 * changes its state, or that waits for an operator, releases nothing.
 */
function readEndedExecutions(sql: SqlStorage) {
  // Most Sessions hold no open execution. The lifecycle is read for the rest.
  if (readEndedCodeModeExecutions(sql, null).length === 0) return [];
  const row = sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM session_meta LIMIT 1",
    )
    .toArray()[0];
  if (row === undefined) return [];
  const session = readImportedCanonicalSession(sql, row.organisation_id);
  if (!session.ok) return [];
  const lifecycle = session.value.lifecycle;
  switch (lifecycle.kind) {
    case "sleeping":
    case "terminal":
      return readEndedCodeModeExecutions(sql, null);
    case "processing":
    case "recovering": {
      const turn = lifecycle.state.activeTurn;
      return readEndedCodeModeExecutions(
        sql,
        turn.kind === "awaiting_execution" ? turn.state.executionId : null,
      );
    }
    case "activating":
    case "checkpointing":
    case "cancelling":
    case "quarantined":
      return [];
    default:
      return lifecycle satisfies never;
  }
}

type OrganisationReservationOwner = {
  cancelCodeModeBudget(
    input: CodeModeOrganisationCancelInput,
  ): ReturnType<CodeModeReservationCancel>;
};

function cancelAtOrganisation(
  organisation: OrganisationReservationOwner,
  input: CodeModeOrganisationCancelInput,
) {
  return organisation.cancelCodeModeBudget(input);
}

function cancelAtPlatform(env: Env, input: CodeModeOrganisationCancelInput) {
  return codeModePlatformGovernor(env).cancel(input);
}

function isOrganisationSettlementEntry(entry: ActorRegistryEntry): boolean {
  return entry.identity.objectKind === "organisation";
}

function commitFrozenSettlement(
  sql: SqlStorage,
  row: SettlementRow,
  request: CodeModeSettlementRequest,
  input: RelocationSessionSettlementRequest,
): boolean {
  const updated = sql.exec(
    `UPDATE actor_outbox SET state_kind = 'reconciled', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND organisation_id = ? AND request_envelope = ?
       AND state_kind IN ('pending', 'dispatching', 'indeterminate')`,
    JSON.stringify({
      kind: "settlement_reconciled",
      receiptId: request.settle.receiptId,
      receiptDigest: request.settle.receiptDigest,
      relocationId: input.relocationId,
      reconciledAt: input.now,
    }),
    input.now,
    row.effect_id,
    row.organisation_id,
    row.request_envelope,
  );
  return updated.rowsWritten === 1;
}

function rejectedFrozenSettlement(): Result<never, RelocationReceiptError> {
  return { ok: false, error: { code: "relocation_receipt_rejected" } };
}

function unresolvedFrozenSettlement(
  operationId: string,
): Result<never, FrozenSessionSettlementError> {
  return {
    ok: false,
    error: { code: "relocation_provider_work_unresolved", operationId },
  };
}

type CodeModeSettlementRequest = {
  readonly kind: typeof SETTLEMENT_KIND;
  readonly settle: CodeModeOrganisationSettleInput;
  readonly lease: HarnessTurnLease;
  readonly receipt: CodeModeExecutionReceipt;
};

type SettlementRow = Record<string, SqlStorageValue> & {
  readonly effect_id: string;
  readonly organisation_id: string;
  readonly request_envelope: string;
  readonly state_kind: string;
  readonly state_projection: string;
};

type RecoverableSettlementProjection =
  | {
      readonly kind: "workspace_committed";
      readonly receiptId: string;
      readonly workspaceRevisionReceipt: CodeModeExecutionReceipt["workspaceRevisionReceipt"];
    }
  | {
      readonly kind: "dispatching";
      readonly receiptId: string;
    };

type CodeModeWorkspaceCommitRecord =
  | { readonly kind: "workspace_committed" }
  | { readonly kind: "already_settled" };

export type CodeModeSettlementStorage = ActorTransactionStorage & {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
};

type CodeModeSettlementError =
  | { readonly code: "code_mode_settlement_invalid" }
  | {
      readonly code: "code_mode_settlement_indeterminate";
      readonly reason: string;
    }
  | {
      readonly code: "code_mode_receipt_commit_failed";
      readonly reason: string;
    };

export function codeModeExecutionReceiptId(executionId: string): string {
  return `receipt-${executionId}`;
}

export async function settleCodeModeExecutionDurably(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly settle: CodeModeOrganisationSettleInput;
  readonly lease: HarnessTurnLease;
  readonly receipt: CodeModeExecutionReceipt;
}): Promise<Result<null, CodeModeSettlementError>> {
  const recorded = await recordCodeModeWorkspaceCommit(input);
  if (!recorded.ok) return recorded;
  if (recorded.value.kind === "already_settled")
    return { ok: true, value: null };
  const request = settlementRequest(input);
  const effectId = settlementEffectId(input.settle.executionId);
  return dispatchAsLiveTurn({
    env: input.env,
    storage: input.storage,
    organisationId: input.organisationId,
    effectId,
    request,
    authorizationLease: input.lease,
  });
}

export async function resumeCodeModeExecutionSettlement(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly lease: HarnessTurnLease;
  readonly executionLease: HarnessCodeModeExecutionLease;
  readonly outcome: HarnessCodeModeExecutionOutcome;
  readonly outputBytes: number;
}): Promise<
  Result<{ readonly kind: "not_started" | "settled" }, CodeModeSettlementError>
> {
  const effectId = settlementEffectId(input.executionLease.executionId);
  const row = input.storage.sql
    .exec<SettlementRow>(
      `SELECT effect_id, organisation_id, request_envelope, state_kind, state_projection
     FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      effectId,
    )
    .toArray()[0];
  const invalid: Result<never, CodeModeSettlementError> = {
    ok: false,
    error: { code: "code_mode_settlement_invalid" },
  };
  if (row === undefined || row.organisation_id !== input.organisationId)
    return invalid;
  const request = parseSettlementRequest(row.request_envelope);
  if (request === null) {
    const admitted = parseExecutionRequest(row.request_envelope);
    return admitted !== null &&
      admitted.organisationId === input.organisationId &&
      admitted.executionId === input.executionLease.executionId &&
      admitted.leaseId === input.executionLease.leaseId &&
      (row.state_kind === "pending" || row.state_kind === "dispatching")
      ? { ok: true, value: { kind: "not_started" } }
      : invalid;
  }
  const usage = request.receipt.workspaceExecutorUsage;
  const expectedOutcome =
    usage.kind === "settled" && usage.outcome !== "succeeded"
      ? usage.outcome
      : input.outcome;
  if (
    request.settle.organisationId !== input.organisationId ||
    request.settle.executionId !== input.executionLease.executionId ||
    request.settle.leaseId !== input.executionLease.leaseId ||
    request.receipt.outcome !== expectedOutcome ||
    request.receipt.rootOutputBytes !== input.outputBytes ||
    canonicalJson(request.lease.session) !==
      canonicalJson(input.lease.session) ||
    canonicalJson(request.lease.turn) !== canonicalJson(input.lease.turn) ||
    canonicalJson(request.lease.requestAuthority) !==
      canonicalJson(input.lease.requestAuthority) ||
    request.lease.authorityPartitionDigest !==
      input.lease.authorityPartitionDigest ||
    !preflightHarnessTurnLease(input.storage, input.lease, Date.now()).ok
  )
    return invalid;
  if (row.state_kind === "settled")
    return { ok: true, value: { kind: "settled" } };
  const projection = parseRecoverableSettlementProjection(row.state_projection);
  if (
    (row.state_kind !== "pending" && row.state_kind !== "dispatching") ||
    projection === null ||
    !projectionMatchesRequest(projection, request)
  )
    return invalid;
  const settled = await dispatchAsLiveTurn({
    env: input.env,
    storage: input.storage,
    organisationId: input.organisationId,
    effectId,
    request,
    authorizationLease: input.lease,
  });
  return settled.ok ? { ok: true, value: { kind: "settled" } } : settled;
}

export async function recordCodeModeWorkspaceCommit(input: {
  readonly storage: CodeModeSettlementStorage;
  readonly settle: CodeModeOrganisationSettleInput;
  readonly lease: HarnessTurnLease;
  readonly receipt: CodeModeExecutionReceipt;
}): Promise<Result<CodeModeWorkspaceCommitRecord, CodeModeSettlementError>> {
  const request = settlementRequest(input);
  if (!validSettlementRequest(request)) {
    return { ok: false, error: { code: "code_mode_settlement_invalid" } };
  }
  const effectId = settlementEffectId(input.settle.executionId);
  const prepared = input.storage.transactionSync(
    prepareWorkspaceCommittedSettlement.bind(
      null,
      input.storage.sql,
      effectId,
      request,
    ),
  );
  if (!prepared.ok || prepared.value.kind === "already_settled")
    return prepared;
  await scheduleSettlementRecovery(input.storage, Date.now());
  return prepared;
}

/**
 * Recovers the settlements that no live turn finishes (Refactor 15,
 * refactor 3). A settlement that a live turn of this isolate dispatches is
 * the turn's: the alarm looks at it again later. A dispatch that fails while
 * the Session still processes the turn stays open for the next try, because
 * the turn can still commit it; only a journaled quarantine, or a Session that
 * no longer processes the turn, leaves the settlement indeterminate.
 */
export async function reconcileCodeModeSettlements(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
}): Promise<void> {
  const rows = input.storage.sql
    .exec<SettlementRow>(
      `SELECT effect_id, organisation_id, request_envelope, state_kind, state_projection
     FROM actor_outbox
     WHERE state_kind IN ('pending', 'dispatching')
       AND json_extract(request_envelope, '$.kind') = ?
     ORDER BY updated_at ASC
     LIMIT 8`,
      SETTLEMENT_KIND,
    )
    .toArray();
  let open = rows.length === 8;
  for (const row of rows) {
    const organisationId = parseOrganisationId(row.organisation_id);
    const request = parseSettlementRequest(row.request_envelope);
    const projection = parseRecoverableSettlementProjection(
      row.state_projection,
    );
    if (
      !organisationId.ok ||
      request === null ||
      projection === null ||
      !projectionMatchesRequest(projection, request)
    ) {
      markSettlementIndeterminate(
        input.storage,
        row.effect_id,
        "invalid_persisted_request",
        Date.now(),
      );
      continue;
    }
    if (heldByLiveTurn(input.storage, row.effect_id, Date.now())) {
      open = true;
      continue;
    }
    const settled = await dispatchSettlement({
      env: input.env,
      storage: input.storage,
      organisationId: organisationId.value,
      effectId: row.effect_id,
      request,
      authorizationLease: request.lease,
    });
    if (settled.ok) continue;
    if (
      settled.error.code === "code_mode_settlement_indeterminate" ||
      !sessionProcessesTurn(input.storage.sql, request)
    ) {
      markSettlementIndeterminate(
        input.storage,
        row.effect_id,
        settlementFailureReason(settled.error),
        Date.now(),
      );
      continue;
    }
    open = true;
  }
  if (open)
    await armAlarmBy(input.storage, Date.now() + SETTLEMENT_RETRY_DELAY_MS);
}

/** True while the Session still processes the turn of a settlement. */
function sessionProcessesTurn(
  sql: SqlStorage,
  request: CodeModeSettlementRequest,
): boolean {
  // Storage that holds no Session lifecycle runs no turn.
  const lifecycle = sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_meta'",
    )
    .toArray();
  if (lifecycle.length === 0) return false;
  const current = readCanonicalSessionProjection(
    sql,
    request.lease.session.organisationId,
    request.lease.session.sessionId,
  );
  return current?.kind === "processing";
}

async function dispatchSettlement(input: {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly organisationId: OrganisationId;
  readonly effectId: string;
  readonly request: CodeModeSettlementRequest;
  readonly authorizationLease: HarnessTurnLease;
}): Promise<Result<null, CodeModeSettlementError>> {
  const authorized = preflightHarnessTurnLease(
    input.storage,
    input.authorizationLease,
    Date.now(),
  );
  if (!authorized.ok)
    return { ok: false, error: { code: "code_mode_settlement_invalid" } };
  const execution = await SessionExecutionAdmission.resolve(
    input.env,
    input.storage,
    input.organisationId,
  );
  if (execution === null || !(await execution.isActive()))
    return { ok: false, error: { code: "code_mode_settlement_invalid" } };
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env: input.env,
    organisationId: input.organisationId,
    placement: execution.scope.placement,
    now: input.request.settle.now,
  });
  const organisationSettled = await organisation.settleCodeModeBudget(
    input.request.settle,
  );
  if (!organisationSettled.ok || organisationSettled.value.kind !== "settled") {
    const reason = organisationSettled.ok
      ? organisationSettled.value.kind
      : organisationSettled.error.code;
    return acceptIndeterminateSettlement(input, reason);
  }
  input.storage.transactionSync(
    markSettlementDispatching.bind(
      null,
      input.storage.sql,
      input.effectId,
      input.request.settle.receiptId,
      input.request.settle.now,
    ),
  );
  const platformSettled = await codeModePlatformGovernor(input.env).settle(
    input.request.settle,
  );
  if (!platformSettled.ok || platformSettled.value.kind !== "settled") {
    const reason = platformSettled.ok
      ? platformSettled.value.kind
      : platformSettled.error.code;
    return acceptIndeterminateSettlement(input, reason);
  }
  // The turn and the alarm's recovery can dispatch one settlement at the same
  // time, and both owners answer a repeated settlement from the first. The
  // dispatch that ends second finds the settlement committed.
  if (isSettlementCommitted(input.storage.sql, input.effectId))
    return { ok: true, value: null };
  const current = readCanonicalSessionProjection(
    input.storage.sql,
    input.request.lease.session.organisationId,
    input.request.lease.session.sessionId,
  );
  if (current === null || current.kind !== "processing") {
    return { ok: false, error: { code: "code_mode_settlement_invalid" } };
  }
  const commit = buildExecutionSettledCommit({
    current,
    lease: input.authorizationLease,
    receipt: input.request.receipt,
    effectId: input.effectId,
    acceptedAt: input.request.settle.now,
  });
  if (!commit.ok) return commit;
  const accepted = commitExecutionSettledSession(input.storage, commit.value);
  return accepted.ok
    ? { ok: true, value: null }
    : {
        ok: false,
        error: {
          code: "code_mode_receipt_commit_failed",
          reason: accepted.error.code,
        },
      };
}

function acceptIndeterminateSettlement(
  input: {
    readonly storage: DurableObjectStorage;
    readonly effectId: string;
    readonly request: CodeModeSettlementRequest;
  },
  reason: string,
): Result<null, CodeModeSettlementError> {
  const current = readCanonicalSessionProjection(
    input.storage.sql,
    input.request.lease.session.organisationId,
    input.request.lease.session.sessionId,
  );
  if (current === null || current.kind !== "processing") {
    return { ok: false, error: { code: "code_mode_settlement_invalid" } };
  }
  const acceptedAt = Date.now();
  const state: QuarantinedSessionCommit["state"] = {
    kind: "quarantined",
    state: {
      identity: current.state.identity,
      contract: {
        ...current.state.contract,
        lastEventSequence: current.state.contract.lastEventSequence + 1,
      },
      reason: "effect_indeterminate",
      recovery: { kind: "terminate_only" },
    },
  };
  const transition: Variant<SessionTransition, "session_quarantined"> = {
    kind: "session_quarantined",
    state: state.state,
  };
  const commandId = `${input.request.receipt.executionId}:quarantine-indeterminate`;
  const commit: QuarantinedSessionCommit = {
    source: "harness",
    commandId,
    event: {
      envelopeVersion: "actor-envelope.v1",
      payloadVersion: "session-transition.v1",
      eventId: `${input.request.receipt.executionId}:execution-indeterminate`,
      organisationId: state.state.identity.organisationId,
      actorId: state.state.identity.sessionId,
      streamId: state.state.identity.streamId,
      sequence: state.state.contract.lastEventSequence,
      sourceTime: { kind: "satyr", issuedAt: acceptedAt },
      acceptedAt,
      correlationId: input.request.receipt.executionId,
      causation: { kind: "command", commandId },
      idempotencyKey: `${input.request.receipt.executionId}:execution-indeterminate`,
      runtimeRevision: state.state.contract.runtimeRevision,
      principal: { kind: "system", componentId: "agent_session_actor" },
      sensitivity: "organisation_private",
      retention: "audit_required",
      body: transition,
    },
    state,
    settlementEffectId: input.effectId,
    indeterminateReason: reason,
  };
  const valid = validateCanonicalSessionAdvance({
    current,
    command: { kind: "quarantine", reason: "effect_indeterminate" },
    transition,
    state,
  });
  if (!valid.ok) {
    return {
      ok: false,
      error: {
        code: "code_mode_receipt_commit_failed",
        reason: valid.error.code,
      },
    };
  }
  const committed = commitQuarantinedSession(input.storage, commit);
  return committed.ok
    ? {
        ok: false,
        error: { code: "code_mode_settlement_indeterminate", reason },
      }
    : {
        ok: false,
        error: {
          code: "code_mode_receipt_commit_failed",
          reason: committed.error.code,
        },
      };
}

function buildExecutionSettledCommit(input: {
  readonly current: Variant<AgentSessionLifecycle, "processing">;
  readonly lease: HarnessTurnLease;
  readonly receipt: CodeModeExecutionReceipt;
  readonly effectId: string;
  readonly acceptedAt: number;
}): Result<ExecutionSettledSessionCommit, CodeModeSettlementError> {
  const settledEffect = {
    effectId: `execution-${input.receipt.executionId}`,
    kind: "execution" as const,
    capability: "idempotent" as const,
    receiptId: codeModeExecutionReceiptId(input.receipt.executionId),
    receipt: { kind: "inline" as const, value: input.receipt },
    settledAt: input.acceptedAt,
  };
  const state: ExecutionSettledSessionCommit["state"] = {
    kind: "processing",
    state: {
      identity: input.current.state.identity,
      contract: {
        ...input.current.state.contract,
        lastEventSequence: input.current.state.contract.lastEventSequence + 1,
      },
      resumePoint: input.current.state.resumePoint,
      runtimeLease: input.current.state.runtimeLease,
      activeTurn: {
        kind: "reducing_result",
        state: {
          identity: input.receipt.turn,
          receiptId: settledEffect.receiptId,
          workspaceRevisionReceipt: input.receipt.workspaceRevisionReceipt,
        },
      },
    },
  };
  const transition: Variant<SessionTransition, "execution_settled"> = {
    kind: "execution_settled",
    receipt: settledEffect,
    state: state.state,
  };
  const commandId = `${input.receipt.executionId}:accept-receipt`;
  const event: EventEnvelope<typeof transition> = {
    envelopeVersion: "actor-envelope.v1",
    payloadVersion: "session-transition.v1",
    eventId: `${input.receipt.executionId}:execution-settled`,
    organisationId: state.state.identity.organisationId,
    actorId: state.state.identity.sessionId,
    streamId: state.state.identity.streamId,
    sequence: state.state.contract.lastEventSequence,
    sourceTime: { kind: "satyr", issuedAt: input.acceptedAt },
    acceptedAt: input.acceptedAt,
    correlationId: input.receipt.executionId,
    causation: { kind: "command", commandId },
    idempotencyKey: `${input.receipt.executionId}:execution-settled`,
    runtimeRevision: state.state.contract.runtimeRevision,
    principal: { kind: "system", componentId: "embedded_harness" },
    sensitivity: "organisation_private",
    retention: "session",
    body: transition,
  };
  const commit: ExecutionSettledSessionCommit = {
    source: "harness",
    commandId,
    event,
    state,
    harnessLease: input.lease,
    settlementEffectId: input.effectId,
  };
  const valid = validateCanonicalSessionAdvance({
    current: input.current,
    command: {
      kind: "accept_execution_receipt",
      runtimeLease: input.lease.runtimeLease,
      turnLeaseGeneration: input.lease.turn.turnLeaseGeneration,
      receipt: settledEffect,
    },
    transition,
    state,
  });
  return valid.ok
    ? { ok: true, value: commit }
    : {
        ok: false,
        error: {
          code: "code_mode_receipt_commit_failed",
          reason: valid.error.code,
        },
      };
}

function prepareWorkspaceCommittedSettlement(
  sql: SqlStorage,
  effectId: string,
  request: CodeModeSettlementRequest,
): Result<CodeModeWorkspaceCommitRecord, CodeModeSettlementError> {
  const existing = sql
    .exec<SettlementRow>(
      `SELECT effect_id, organisation_id, request_envelope, state_kind, state_projection
     FROM actor_outbox WHERE effect_id = ? LIMIT 1`,
      effectId,
    )
    .toArray()[0];
  const encoded = JSON.stringify(request);
  if (existing !== undefined) {
    if (existing.request_envelope === encoded) {
      const projection = parseRecoverableSettlementProjection(
        existing.state_projection,
      );
      return existing.state_kind === "settled"
        ? { ok: true, value: { kind: "already_settled" } }
        : (existing.state_kind === "pending" ||
              existing.state_kind === "dispatching") &&
            projection !== null &&
            projectionMatchesRequest(projection, request)
          ? { ok: true, value: { kind: "workspace_committed" } }
          : { ok: false, error: { code: "code_mode_settlement_invalid" } };
    }
    const admitted = parseExecutionRequest(existing.request_envelope);
    if (
      admitted === null ||
      admitted.executionId !== request.settle.executionId ||
      admitted.leaseId !== request.settle.leaseId ||
      admitted.organisationId !== request.settle.organisationId ||
      existing.state_kind === "settled" ||
      existing.state_kind === "indeterminate"
    ) {
      return { ok: false, error: { code: "code_mode_settlement_invalid" } };
    }
    sql.exec(
      `UPDATE actor_outbox
       SET request_envelope = ?, state_kind = 'pending', state_projection = ?, updated_at = ?
       WHERE effect_id = ? AND organisation_id = ? AND state_kind IN ('pending', 'dispatching')`,
      encoded,
      JSON.stringify(workspaceCommittedProjection(request)),
      request.settle.now,
      effectId,
      request.settle.organisationId,
    );
    return { ok: true, value: { kind: "workspace_committed" } };
  }
  return { ok: false, error: { code: "code_mode_settlement_invalid" } };
}

function settlementRequest(input: {
  readonly settle: CodeModeOrganisationSettleInput;
  readonly lease: HarnessTurnLease;
  readonly receipt: CodeModeExecutionReceipt;
}): CodeModeSettlementRequest {
  return {
    kind: SETTLEMENT_KIND,
    settle: input.settle,
    lease: input.lease,
    receipt: input.receipt,
  };
}

function workspaceCommittedProjection(
  request: CodeModeSettlementRequest,
): Variant<RecoverableSettlementProjection, "workspace_committed"> {
  return {
    kind: "workspace_committed",
    receiptId: request.settle.receiptId,
    workspaceRevisionReceipt: request.receipt.workspaceRevisionReceipt,
  };
}

function parseExecutionRequest(raw: string): {
  readonly executionId: string;
  readonly leaseId: string;
  readonly organisationId: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.kind !== "code_mode_execution.v1" ||
    typeof parsed.executionId !== "string" ||
    typeof parsed.leaseId !== "string" ||
    typeof parsed.organisationId !== "string"
  ) {
    return null;
  }
  return {
    executionId: parsed.executionId,
    leaseId: parsed.leaseId,
    organisationId: parsed.organisationId,
  };
}

function markSettlementDispatching(
  sql: SqlStorage,
  effectId: string,
  receiptId: string,
  now: number,
): void {
  sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'dispatching', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind IN ('pending', 'dispatching')`,
    JSON.stringify({ kind: "dispatching", receiptId }),
    now,
    effectId,
  );
}

/**
 * Marks a settlement that a dispatch could not finish. A settlement that
 * another dispatch committed stays settled.
 */
function markSettlementIndeterminate(
  storage: DurableObjectStorage,
  effectId: string,
  reason: string,
  now: number,
): void {
  storage.sql.exec(
    `UPDATE actor_outbox
     SET state_kind = 'indeterminate', state_projection = ?, updated_at = ?
     WHERE effect_id = ? AND state_kind IN ('pending', 'dispatching')`,
    JSON.stringify({ kind: "indeterminate", reason }),
    now,
    effectId,
  );
}

function isSettlementCommitted(sql: SqlStorage, effectId: string): boolean {
  return (
    sql
      .exec<{ state_kind: string }>(
        "SELECT state_kind FROM actor_outbox WHERE effect_id = ?",
        effectId,
      )
      .toArray()[0]?.state_kind === "settled"
  );
}

function parseSettlementRequest(raw: string): CodeModeSettlementRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.kind !== SETTLEMENT_KIND) return null;
  if (
    !isRecord(value.settle) ||
    !isRecord(value.lease) ||
    !isRecord(value.receipt)
  )
    return null;
  const settle = parsePersistedSettle(value.settle);
  const lease = parsePersistedHarnessTurnLease(value.lease);
  const receipt = parsePersistedReceipt(value.receipt);
  return settle === null || lease === null || receipt === null
    ? null
    : validSettlementRequest({ kind: SETTLEMENT_KIND, settle, lease, receipt })
      ? { kind: SETTLEMENT_KIND, settle, lease, receipt }
      : null;
}

function parseRecoverableSettlementProjection(
  raw: string,
): RecoverableSettlementProjection | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const receiptId = stringValue(value.receiptId);
  if (receiptId === null) return null;
  switch (value.kind) {
    case "workspace_committed": {
      const workspaceRevisionReceipt = parseWorkspaceReceipt(
        value.workspaceRevisionReceipt,
      );
      return workspaceRevisionReceipt === null
        ? null
        : { kind: "workspace_committed", receiptId, workspaceRevisionReceipt };
    }
    case "dispatching":
      return { kind: "dispatching", receiptId };
    default:
      return null;
  }
}

function projectionMatchesRequest(
  projection: RecoverableSettlementProjection,
  request: CodeModeSettlementRequest,
): boolean {
  if (projection.receiptId !== request.settle.receiptId) return false;
  switch (projection.kind) {
    case "workspace_committed":
      return (
        JSON.stringify(projection.workspaceRevisionReceipt) ===
        JSON.stringify(request.receipt.workspaceRevisionReceipt)
      );
    case "dispatching":
      return true;
  }
}

function validSettlementRequest(request: CodeModeSettlementRequest): boolean {
  return (
    request.settle.organisationId === request.lease.session.organisationId &&
    request.settle.executionId === request.receipt.executionId &&
    request.settle.receiptId ===
      codeModeExecutionReceiptId(request.receipt.executionId) &&
    request.settle.receiptDigest === request.receipt.receiptDigest &&
    request.settle.actualCostMicros === request.receipt.actualCostMicros &&
    request.settle.capabilityCalls === request.receipt.capabilityCalls &&
    request.settle.inputBytes === request.receipt.inputBytes &&
    request.settle.outputBytes === request.receipt.outputBytes &&
    request.settle.outcome === request.receipt.outcome &&
    validWorkspaceExecutorUsage(request.receipt) &&
    JSON.stringify(request.receipt.turn) === JSON.stringify(request.lease.turn)
  );
}

function validWorkspaceExecutorUsage(
  receipt: CodeModeExecutionReceipt,
): boolean {
  if (receipt.priceBookRevision !== CODE_MODE_PRICE_BOOK_REVISION_V2)
    return true;
  if (
    receipt.reservedCostMicros !==
    CODE_MODE_ENGINE_RESERVED_COST_MICROS +
      WORKSPACE_EXECUTOR_RESERVED_COST_MICROS
  )
    return false;
  const usage = receipt.workspaceExecutorUsage;
  if (usage.kind === "unused") {
    return receipt.actualCostMicros === CODE_MODE_ENGINE_RESERVED_COST_MICROS;
  }
  if (
    usage.reservedCostMicros !== WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
    usage.actualCostMicros > WORKSPACE_EXECUTOR_RESERVED_COST_MICROS ||
    receipt.actualCostMicros !==
      CODE_MODE_ENGINE_RESERVED_COST_MICROS + usage.actualCostMicros
  )
    return false;
  return usage.outcome === "succeeded" || receipt.outcome === usage.outcome;
}

function parsePersistedSettle(
  raw: Record<string, unknown>,
): CodeModeOrganisationSettleInput | null {
  const requestId = stringValue(raw.requestId);
  const organisationId = stringValue(raw.organisationId);
  const executionId = stringValue(raw.executionId);
  const leaseId = stringValue(raw.leaseId);
  const receiptId = stringValue(raw.receiptId);
  const receiptDigest = stringValue(raw.receiptDigest);
  const actualCostMicros = nonNegativeIntegerOrNull(raw.actualCostMicros);
  const capabilityCalls = nonNegativeIntegerOrNull(raw.capabilityCalls);
  const inputBytes = nonNegativeIntegerOrNull(raw.inputBytes);
  const outputBytes = nonNegativeIntegerOrNull(raw.outputBytes);
  const now = nonNegativeIntegerOrNull(raw.now);
  if (
    requestId === null ||
    organisationId === null ||
    executionId === null ||
    leaseId === null ||
    receiptId === null ||
    receiptDigest === null ||
    actualCostMicros === null ||
    capabilityCalls === null ||
    inputBytes === null ||
    outputBytes === null ||
    now === null
  )
    return null;
  const parsedRequestId = parseRequestId(requestId);
  const parsedOrganisationId = parseOrganisationId(organisationId);
  if (!parsedRequestId.ok || !parsedOrganisationId.ok) return null;
  if (
    raw.outcome !== "succeeded" &&
    raw.outcome !== "platform_failed" &&
    raw.outcome !== "organisation_failed"
  )
    return null;
  const parsed = parseCodeModeSettleInput({
    requestId: parsedRequestId.value,
    organisationId: parsedOrganisationId.value,
    executionId,
    leaseId,
    receiptId,
    receiptDigest,
    actualCostMicros,
    capabilityCalls,
    inputBytes,
    outputBytes,
    outcome: raw.outcome,
    now,
  });
  return parsed.ok ? parsed.value : null;
}

function parsePersistedReceipt(
  raw: Record<string, unknown>,
): CodeModeExecutionReceipt | null {
  if (!isRecord(raw.turn)) return null;
  const executionId = stringValue(raw.executionId);
  const admissionDigest = stringValue(raw.admissionDigest);
  const receiptDigest = stringValue(raw.receiptDigest);
  const priceBookRevision = stringValue(raw.priceBookRevision);
  const reservedCostMicros = nonNegativeIntegerOrNull(raw.reservedCostMicros);
  const actualCostMicros = nonNegativeIntegerOrNull(raw.actualCostMicros);
  const capabilityCalls = nonNegativeIntegerOrNull(raw.capabilityCalls);
  const inputBytes = nonNegativeIntegerOrNull(raw.inputBytes);
  const outputBytes = nonNegativeIntegerOrNull(raw.outputBytes);
  const rootOutputBytes = nonNegativeIntegerOrNull(raw.rootOutputBytes);
  const workspaceExecutorUsage = parseWorkspaceExecutorUsage(
    raw.workspaceExecutorUsage,
  );
  const workspaceRevisionReceipt = parseWorkspaceReceipt(
    raw.workspaceRevisionReceipt,
  );
  const turnId = stringValue(raw.turn.turnId);
  const inputId = stringValue(raw.turn.inputId);
  const budgetRevision = stringValue(raw.turn.budgetRevision);
  const turnLeaseGeneration = nonNegativeIntegerOrNull(
    raw.turn.turnLeaseGeneration,
  );
  if (
    executionId === null ||
    admissionDigest === null ||
    receiptDigest === null ||
    priceBookRevision === null ||
    reservedCostMicros === null ||
    actualCostMicros === null ||
    capabilityCalls === null ||
    inputBytes === null ||
    outputBytes === null ||
    rootOutputBytes === null ||
    turnId === null ||
    inputId === null ||
    budgetRevision === null ||
    turnLeaseGeneration === null ||
    workspaceRevisionReceipt === null ||
    workspaceExecutorUsage === null
  )
    return null;
  if (
    raw.outcome !== "succeeded" &&
    raw.outcome !== "platform_failed" &&
    raw.outcome !== "organisation_failed"
  )
    return null;
  return {
    executionId,
    turn: {
      turnId,
      inputId,
      turnLeaseGeneration,
      budgetRevision,
    },
    admissionDigest,
    receiptDigest,
    priceBookRevision,
    reservedCostMicros,
    actualCostMicros,
    capabilityCalls,
    inputBytes,
    outputBytes,
    rootOutputBytes,
    workspaceExecutorUsage,
    outcome: raw.outcome,
    workspaceRevisionReceipt,
  };
}

function parseWorkspaceExecutorUsage(
  raw: unknown,
): CodeModeExecutionReceipt["workspaceExecutorUsage"] | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "unused") return { kind: "unused" };
  if (raw.kind !== "settled") return null;
  const allocationId = stringValue(raw.allocationId);
  const allocationDigest = stringValue(raw.allocationDigest);
  const receiptId = stringValue(raw.receiptId);
  const receiptDigest = stringValue(raw.receiptDigest);
  const reservedCostMicros = nonNegativeIntegerOrNull(raw.reservedCostMicros);
  const actualCostMicros = nonNegativeIntegerOrNull(raw.actualCostMicros);
  const inputBytes = nonNegativeIntegerOrNull(raw.inputBytes);
  const outputBytes = nonNegativeIntegerOrNull(raw.outputBytes);
  const durationMs = nonNegativeIntegerOrNull(raw.durationMs);
  if (
    allocationId === null ||
    allocationDigest === null ||
    receiptId === null ||
    receiptDigest === null ||
    reservedCostMicros === null ||
    actualCostMicros === null ||
    inputBytes === null ||
    outputBytes === null ||
    durationMs === null ||
    (raw.outcome !== "succeeded" &&
      raw.outcome !== "platform_failed" &&
      raw.outcome !== "organisation_failed")
  )
    return null;
  return {
    kind: "settled",
    allocationId,
    allocationDigest,
    receiptId,
    receiptDigest,
    reservedCostMicros,
    actualCostMicros,
    inputBytes,
    outputBytes,
    durationMs,
    outcome: raw.outcome,
  };
}

async function scheduleSettlementRecovery(
  storage: Pick<CodeModeSettlementStorage, "getAlarm" | "setAlarm">,
  now: number,
): Promise<void> {
  await armAlarmBy(storage, now + SETTLEMENT_RECOVERY_DELAY_MS);
}

function settlementFailureReason(error: CodeModeSettlementError): string {
  switch (error.code) {
    case "code_mode_settlement_invalid":
      return error.code;
    case "code_mode_settlement_indeterminate":
    case "code_mode_receipt_commit_failed":
      return error.reason;
  }
}

function settlementEffectId(executionId: string): string {
  return `execution-${executionId}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
