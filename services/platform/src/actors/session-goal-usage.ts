import type {
  CaseAssignment,
  CaseGoalOperationOutcome,
  CaseGoalSnapshot,
  HarnessTurnLease,
} from "@purin-labs/contracts";
import {
  assertNever,
  canonicalJson,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import {
  parseCaseId,
  parseOrganisationId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { Env } from "@purin-labs/kernel/env";
import type { CaseActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import {
  findActiveCaseActorAtScope,
  resolveActiveCaseActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  preflightHarnessTurnLease,
  parsePersistedHarnessTurnLease,
} from "./agent-session-harness-authority";
import { readSessionBudgetAccount } from "./agent-session-budget";
import {
  parseGoalAdmissionRequest,
  parseGoalExecutionRequest,
  type GoalExecutionRequest,
  parseGoalUsageRequest,
  type GoalAdmissionRequest,
} from "./case-goals";
import type {
  GoalModelCallControl,
  GoalModelCallTicket,
  GoalModelStop,
} from "./goal-model-calls";
import { armAlarmBy } from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import type { Variant } from "@purin-labs/type-utils";

export type GoalUsageContext = {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly liveRuns: Set<string>;
};
export type GoalUsageAuthority =
  | {
      readonly kind: "canonical";
      readonly lease: HarnessTurnLease;
      readonly runId?: never;
      readonly tokenAllowance?: never;
    }
  | {
      readonly kind: "transient";
      readonly lease: HarnessTurnLease;
      readonly runId: string;
      readonly tokenAllowance: number;
    };
type Phase =
  | { readonly kind: "admitting" }
  | { readonly kind: "dispatched" }
  | { readonly kind: "settling"; readonly outcome: CaseGoalOperationOutcome }
  | { readonly kind: "settled"; readonly outcome: CaseGoalOperationOutcome };
type Intent = {
  readonly authority: GoalUsageAuthority;
  readonly goalId: string;
  readonly request: GoalAdmissionRequest;
  readonly startedAt: number;
};
type Pending = { readonly intent: Intent; readonly phase: Phase };
const PREFIX = "goal_model_call:";

export type GoalExecution = {
  readonly control: GoalModelCallControl;
  close(): Promise<void>;
};

/**
 * A goal execution whose bind started before its control is needed. The bind
 * never rejects here: a failure is the error of `bound`. The owner calls
 * `close` on every path. It waits for the bind, closes what the bind opened,
 * and gives the same close to every caller.
 */
export class StartedGoalExecution {
  private closing: Promise<void> | null = null;

  private constructor(readonly bound: Promise<Result<GoalExecution, string>>) {}

  static start(
    context: GoalUsageContext,
    lease: HarnessTurnLease,
    assignment: CaseAssignment,
    requestId: RequestId,
    servedCase: Promise<CaseActorStub | null>,
  ): StartedGoalExecution {
    return new StartedGoalExecution(
      servedCase
        .then(
          createSessionGoalExecution.bind(
            null,
            context,
            lease,
            assignment,
            requestId,
          ),
        )
        .then(boundGoalExecution, failedGoalBind),
    );
  }

  close(): Promise<void> {
    this.closing ??= this.bound.then(closeBoundGoalExecution);
    return this.closing;
  }
}

function boundGoalExecution(
  execution: GoalExecution,
): Result<GoalExecution, string> {
  return { ok: true, value: execution };
}

function failedGoalBind(error: unknown): Result<GoalExecution, string> {
  return {
    ok: false,
    error:
      error instanceof Error ? error.message : "goal_admission_unavailable",
  };
}

async function closeBoundGoalExecution(
  bound: Result<GoalExecution, string>,
): Promise<void> {
  if (bound.ok) await bound.value.close();
}
type ExecutionBinding = {
  readonly request: GoalExecutionRequest;
  readonly authority: GoalUsageAuthority;
};
const EXECUTION_PREFIX = "goal_execution:";

/**
 * The Case a Session serves, when the registry lists it as active at the
 * Session's admitted scope. The Case admits every call itself, so the row only
 * addresses it. Null leaves the lookup to the placement path.
 */
export async function findServedGoalCase(
  env: Env,
  scope: OrganisationExecutionScope,
  assignment: CaseAssignment,
): Promise<CaseActorStub | null> {
  const caseId = parseCaseId(assignment.caseId);
  if (
    !caseId.ok ||
    assignment.authorityPartition.key.organisationId !== scope.organisationId
  )
    return null;
  try {
    return await findActiveCaseActorAtScope({
      scope,
      namespace: env.CASE,
      caseId: caseId.value,
    });
  } catch {
    return null;
  }
}

export async function createSessionGoalExecution(
  context: GoalUsageContext,
  lease: HarnessTurnLease,
  assignment: CaseAssignment,
  requestId: RequestId,
  servedCase: CaseActorStub | null,
): Promise<GoalExecution> {
  if (
    assignment.sessionId !== lease.session.sessionId ||
    assignment.caseId !== assignment.context.caseId ||
    assignment.authorityPartition.key.organisationId !==
      lease.session.organisationId
  )
    throw new Error("goal_assignment_mismatch");
  await reconcileSessionGoalUsage(context);
  const authority: GoalUsageAuthority = { kind: "canonical", lease };
  const binding = executionBinding(authority, assignment.caseId, requestId);
  const owner =
    servedCase ??
    (await caseOwner(
      context.env,
      binding.request.organisationId,
      binding.request.caseId,
    ));
  const goal = await bindExecution(context, binding, owner);
  const control: GoalModelCallControl =
    goal.kind === "none"
      ? { kind: "untracked" }
      : {
          kind: "tracked",
          begin: begin.bind(
            null,
            context,
            authority,
            assignment.caseId,
            goal.goal.goalId,
          ),
          settle: settle.bind(null, context, owner),
        };
  return { control, close: closeExecution.bind(null, context, binding, owner) };
}

type TransientGoalExecution = {
  readonly control: GoalModelCallControl;
  readonly state: { stop: GoalModelStop | null };
  close(): Promise<void>;
};

export async function createTransientGoalExecution(
  context: GoalUsageContext,
  lease: HarnessTurnLease,
  caseId: string,
  tokenAllowance: number,
): Promise<TransientGoalExecution> {
  if (!Number.isSafeInteger(tokenAllowance) || tokenAllowance <= 0)
    throw new Error("goal_session_budget_invalid");
  await reconcileSessionGoalUsage(context);
  const authority: Variant<GoalUsageAuthority, "transient"> = {
    kind: "transient",
    lease,
    runId: crypto.randomUUID(),
    tokenAllowance,
  };
  const binding = executionBinding(authority, caseId, lease.turn.inputId);
  const owner = await caseOwner(
    context.env,
    binding.request.organisationId,
    binding.request.caseId,
  );
  const goal = await bindExecution(context, binding, owner);
  const state: TransientGoalExecution["state"] = { stop: null };
  const control: GoalModelCallControl =
    goal.kind === "none"
      ? { kind: "untracked" }
      : {
          kind: "tracked",
          begin: beginTransient.bind(
            null,
            context,
            authority,
            caseId,
            goal.goal.goalId,
            state,
          ),
          settle: settle.bind(null, context, owner),
        };
  return {
    control,
    state,
    close: closeTransient.bind(null, context, authority.runId, binding, owner),
  };
}

async function beginTransient(
  context: GoalUsageContext,
  authority: Variant<GoalUsageAuthority, "transient">,
  caseId: string,
  goalId: string,
  state: TransientGoalExecution["state"],
): Promise<Result<GoalModelCallTicket, GoalModelStop>> {
  const result = await begin(context, authority, caseId, goalId);
  if (!result.ok) state.stop = result.error;
  return result;
}

async function closeTransient(
  context: GoalUsageContext,
  runId: string,
  binding: ExecutionBinding,
  owner: CaseActorStub,
): Promise<void> {
  context.liveRuns.delete(runId);
  for (const operation of readIntents(context.storage.sql, {
    kind: "pending",
  })) {
    if (
      operation.phase.kind === "settled" ||
      operation.intent.authority.kind !== "transient" ||
      operation.intent.authority.runId !== runId
    )
      continue;
    await reconcileOperation(context, operation, false, owner);
  }
  await closeExecution(context, binding, owner);
}

export function readGoalTurnUsage(
  sql: SqlStorage,
  lease: HarnessTurnLease,
):
  | { kind: "untracked" }
  | { kind: "reported" | "unknown"; reportedTokens: number } {
  let found = false;
  let unknown = false;
  let reportedTokens = 0;
  for (const operation of readIntents(sql, {
    kind: "turn",
    turnId: lease.turn.turnId,
  })) {
    if (
      operation.intent.authority.kind !== "canonical" ||
      operation.intent.authority.lease.leaseId !== lease.leaseId
    )
      continue;
    found = true;
    switch (operation.phase.kind) {
      case "admitting":
        break;
      case "dispatched":
        unknown = true;
        break;
      case "settling":
      case "settled":
        if (operation.phase.outcome.kind === "unknown") unknown = true;
        else reportedTokens += operation.phase.outcome.tokens;
        break;
    }
  }
  if (!found) return { kind: "untracked" };
  return { kind: unknown ? "unknown" : "reported", reportedTokens };
}

async function begin(
  context: GoalUsageContext,
  authority: GoalUsageAuthority,
  caseId: string,
  goalId: string,
): Promise<Result<GoalModelCallTicket, GoalModelStop>> {
  const lease = authority.lease;
  checkAdmission(context, authority);
  await reconcileSessionGoalUsage(context);
  for (const operation of readIntents(context.storage.sql, {
    kind: "admission",
    turnId: lease.turn.turnId,
  })) {
    if (
      operation.intent.authority.lease.turn.turnId === lease.turn.turnId &&
      operation.intent.goalId !== goalId
    )
      throw new Error("goal_changed_during_turn");
    if (operation.phase.kind !== "settled")
      throw new Error("goal_usage_pending");
  }
  const owner = await caseOwner(
    context.env,
    lease.session.organisationId,
    caseId,
  );
  const current = await owner.readGoal({
    organisationId: lease.session.organisationId,
    caseId,
  });
  if (!current.ok) throw new Error(current.error.code);
  const stop = goalStopForSnapshot(current.value, goalId);
  if (stop !== null) return { ok: false, error: stop };
  if (current.value.kind !== "present") throw new Error("goal_missing");
  const intent: Intent = {
    authority,
    goalId,
    request: {
      organisationId: lease.session.organisationId,
      caseId,
      sessionId: lease.session.sessionId,
      operationId: crypto.randomUUID(),
      expectedRevision: current.value.revision,
    },
    startedAt: Date.now(),
  };
  writeIntent(context.storage.sql, intent, { kind: "admitting" });
  await scheduleGoalUsage(context.storage, lease.expiresAt);
  const admitted = await owner.admitGoalOperation(intent.request);
  if (!admitted.ok) {
    await reconcileOperation(
      context,
      { intent, phase: { kind: "admitting" } },
      true,
      owner,
    );
    const latest = await owner.readGoal({
      organisationId: lease.session.organisationId,
      caseId,
    });
    if (!latest.ok) throw new Error(latest.error.code);
    const stop = goalStopForSnapshot(latest.value, goalId);
    if (stop !== null) return { ok: false, error: stop };
    throw new Error(admitted.error.code);
  }
  checkAdmission(context, authority);
  writeIntent(context.storage.sql, intent, { kind: "dispatched" });
  return {
    ok: true,
    value: {
      operationId: intent.request.operationId,
      startedAt: intent.startedAt,
      goalId,
      objective: current.value.goal.objective,
      remainingTokens:
        current.value.goal.tokenBudget - current.value.goal.tokensUsed,
    },
  };
}

function goalStopForSnapshot(
  snapshot: CaseGoalSnapshot,
  goalId: string,
): GoalModelStop | null {
  if (snapshot.kind === "none") return { kind: "cleared", goalId };
  if (snapshot.goal.goalId !== goalId) return { kind: "replaced", goalId };
  if (snapshot.goal.unknownOperations > 0)
    throw new Error("goal_usage_pending");
  if (snapshot.goal.state.kind === "active") return null;
  return { kind: snapshot.goal.state.kind, goalId };
}

async function settle(
  context: GoalUsageContext,
  owner: CaseActorStub,
  ticket: GoalModelCallTicket,
  outcome: CaseGoalOperationOutcome,
): Promise<void> {
  const operation = readIntent(context.storage.sql, ticket.operationId);
  if (
    operation === null ||
    operation.intent.startedAt !== ticket.startedAt ||
    operation.phase.kind === "admitting"
  )
    throw new Error("goal_operation_conflict");
  const receipt = parseGoalUsageRequest({
    organisationId: operation.intent.request.organisationId,
    caseId: operation.intent.request.caseId,
    sessionId: operation.intent.request.sessionId,
    operationId: ticket.operationId,
    outcome,
  });
  if (receipt === null) throw new Error("goal_usage_invalid");
  if (
    operation.phase.kind === "settling" ||
    operation.phase.kind === "settled"
  ) {
    const sameOutcome =
      canonicalJson(operation.phase.outcome) === canonicalJson(receipt.outcome);
    if (sameOutcome && operation.phase.kind === "settled") return;
    if (!sameOutcome && operation.phase.outcome.kind === "reported")
      throw new Error("goal_usage_conflict");
  }
  // The admitted operation owns its receipt even after execution authority expires.
  const phase: Phase = { kind: "settling", outcome: receipt.outcome };
  writeIntent(context.storage.sql, operation.intent, phase);
  await scheduleGoalUsage(context.storage, Date.now() + 1000);
  await reconcileOperation(
    context,
    { intent: operation.intent, phase },
    false,
    owner,
  );
}

export async function reconcileSessionGoalUsage(
  context: GoalUsageContext,
): Promise<void> {
  for (const operation of readIntents(context.storage.sql, {
    kind: "pending",
  })) {
    if (operation.phase.kind === "settled") continue;
    const active = authorityActive(context, operation.intent.authority);
    if (operation.phase.kind !== "settling" && active) {
      await scheduleGoalUsage(
        context.storage,
        operation.intent.authority.lease.expiresAt,
      );
      continue;
    }
    try {
      const owner = await caseOwner(
        context.env,
        operation.intent.request.organisationId,
        operation.intent.request.caseId,
      );
      await reconcileOperation(context, operation, false, owner);
    } catch (error) {
      await scheduleGoalUsage(context.storage, Date.now() + 5000);
      throw error;
    }
  }
  await reconcileExecutionBindings(context);
}
function executionBinding(
  authority: GoalUsageAuthority,
  caseId: string,
  requestId: string,
): ExecutionBinding {
  return {
    request: {
      organisationId: authority.lease.session.organisationId,
      caseId,
      requestId,
      executionId:
        authority.kind === "transient" ? authority.runId : crypto.randomUUID(),
    },
    authority,
  };
}

async function bindExecution(
  context: GoalUsageContext,
  binding: ExecutionBinding,
  owner: CaseActorStub,
): Promise<CaseGoalSnapshot> {
  context.liveRuns.add(binding.request.executionId);
  try {
    await context.storage.put(
      EXECUTION_PREFIX + binding.request.executionId,
      binding,
    );
    await scheduleGoalUsage(context.storage, binding.authority.lease.expiresAt);
    const result = await owner.bindGoalExecution(binding.request);
    if (!result.ok) throw new Error(result.error.code);
    if (!authorityActive(context, binding.authority))
      throw new Error("goal_operation_lease_expired");
    return result.value;
  } catch (error) {
    context.liveRuns.delete(binding.request.executionId);
    await scheduleGoalUsage(context.storage, Date.now() + 1000);
    throw error;
  }
}

async function closeExecution(
  context: GoalUsageContext,
  binding: ExecutionBinding,
  owner: CaseActorStub,
): Promise<void> {
  context.liveRuns.delete(binding.request.executionId);
  await scheduleGoalUsage(context.storage, Date.now() + 1000);
  const result = await owner.closeGoalExecution(binding.request);
  if (!result.ok) throw new Error(result.error.code);
  await context.storage.delete(EXECUTION_PREFIX + binding.request.executionId);
}

async function reconcileExecutionBindings(
  context: GoalUsageContext,
): Promise<void> {
  const records = await context.storage.list<unknown>({
    prefix: EXECUTION_PREFIX,
  });
  for (const raw of records.values()) {
    const binding = parseExecutionBinding(raw);
    if (context.liveRuns.has(binding.request.executionId)) {
      await scheduleGoalUsage(
        context.storage,
        Math.max(Date.now() + 1000, binding.authority.lease.expiresAt),
      );
    } else {
      const owner = await caseOwner(
        context.env,
        binding.request.organisationId,
        binding.request.caseId,
      );
      await closeExecution(context, binding, owner);
    }
  }
}

function parseExecutionBinding(raw: unknown): ExecutionBinding {
  if (!isRecord(raw) || !isRecord(raw.authority))
    throw new Error("goal_execution_corrupt");
  const request = parseGoalExecutionRequest(raw.request);
  const lease = parsePersistedHarnessTurnLease(raw.authority.lease);
  if (
    request === null ||
    lease === null ||
    request.organisationId !== lease.session.organisationId
  )
    throw new Error("goal_execution_corrupt");
  if (raw.authority.kind === "canonical")
    return { request, authority: { kind: "canonical", lease } };
  if (
    raw.authority.kind === "transient" &&
    typeof raw.authority.runId === "string" &&
    raw.authority.runId.length > 0 &&
    typeof raw.authority.tokenAllowance === "number" &&
    Number.isSafeInteger(raw.authority.tokenAllowance) &&
    raw.authority.tokenAllowance > 0
  )
    return {
      request,
      authority: {
        kind: "transient",
        lease,
        runId: raw.authority.runId,
        tokenAllowance: raw.authority.tokenAllowance,
      },
    };
  throw new Error("goal_execution_corrupt");
}

async function reconcileOperation(
  context: GoalUsageContext,
  operation: Pending,
  forceAdmission: boolean,
  owner: CaseActorStub,
): Promise<void> {
  const { intent, phase } = operation;
  if (phase.kind === "settled") return;
  let outcome: CaseGoalOperationOutcome;
  let admissionDenied = false;
  if (phase.kind === "admitting") {
    if (!forceAdmission && authorityActive(context, intent.authority)) return;
    // No provider dispatch can precede the durable dispatched phase.
    const admission = await owner.admitGoalOperation(intent.request);
    admissionDenied = !admission.ok;
    outcome = { kind: "reported", tokens: 0, activeTimeMs: 0 };
  } else if (phase.kind === "dispatched") {
    outcome = { kind: "unknown" };
  } else {
    outcome = phase.outcome;
  }
  const result = await owner.acceptGoalUsage({
    organisationId: intent.request.organisationId,
    caseId: intent.request.caseId,
    sessionId: intent.request.sessionId,
    operationId: intent.request.operationId,
    outcome,
  });
  if (
    !result.ok &&
    !(admissionDenied && result.error.code === "goal_operation_missing")
  )
    throw new Error(result.error.code);
  // A late alarm receipt must not replace a newer, persisted usage receipt.
  const latest = readIntent(context.storage.sql, intent.request.operationId);
  if (
    latest !== null &&
    JSON.stringify(latest.phase) === JSON.stringify(phase)
  ) {
    writeIntent(context.storage.sql, intent, { kind: "settled", outcome });
  }
}

function authorityActive(
  context: GoalUsageContext,
  authority: GoalUsageAuthority,
): boolean {
  if (authority.kind === "canonical")
    return preflightHarnessTurnLease(
      context.storage,
      authority.lease,
      Date.now(),
    ).ok;
  return (
    context.liveRuns.has(authority.runId) &&
    authority.lease.expiresAt > Date.now()
  );
}

function checkAdmission(
  context: GoalUsageContext,
  authority: GoalUsageAuthority,
): void {
  if (authority.kind === "canonical") {
    checkSessionAdmission(context.storage, authority.lease);
    return;
  }
  if (!authorityActive(context, authority))
    throw new Error("goal_operation_lease_expired");
  let tokens = 0;
  for (const operation of readIntents(context.storage.sql, {
    kind: "run",
    runId: authority.runId,
  })) {
    const source = operation.intent.authority;
    if (source.kind !== "transient" || source.runId !== authority.runId)
      continue;
    if (
      (operation.phase.kind === "settled" ||
        operation.phase.kind === "settling") &&
      operation.phase.outcome.kind === "reported"
    )
      tokens += operation.phase.outcome.tokens;
  }
  if (tokens >= authority.tokenAllowance)
    throw new Error("goal_session_budget_unavailable");
}

function checkSessionAdmission(
  storage: DurableObjectStorage,
  lease: HarnessTurnLease,
): void {
  const preflight = preflightHarnessTurnLease(storage, lease, Date.now());
  if (!preflight.ok) throw new Error(preflight.error.code);
  const budget = readSessionBudgetAccount(storage.sql, lease.session);
  if (!budget.ok) throw new Error(budget.error.code);
  if (
    budget.value.kind !== "open" ||
    budget.value.reservation.kind !== "active"
  )
    throw new Error("goal_session_budget_unavailable");
  const reservation = budget.value.reservation;
  if (
    reservation.reservation.runtimeGeneration !==
      lease.runtimeLease.generation ||
    reservation.reservation.turnLeaseGeneration !==
      lease.turn.turnLeaseGeneration ||
    reservation.reservation.budgetRevision !== lease.turn.budgetRevision ||
    reservation.reservation.deadlineAt <= Date.now() ||
    reservation.acceptedUsage.tokens >= reservation.reservation.allowance.tokens
  )
    throw new Error("goal_session_budget_unavailable");
}

async function caseOwner(
  env: Env,
  rawOrganisationId: string,
  rawCaseId: string,
): Promise<CaseActorStub> {
  const organisationId = parseOrganisationId(rawOrganisationId);
  const caseId = parseCaseId(rawCaseId);
  if (!organisationId.ok || !caseId.ok)
    throw new Error("goal_identity_mismatch");
  const owner = await resolveActiveCaseActor({
    env: env,
    namespace: env.CASE,
    organisationId: organisationId.value,
    caseId: caseId.value,
    now: Date.now(),
  });
  if (!owner.ok) throw new Error(owner.error.code);
  return owner.value;
}
async function scheduleGoalUsage(
  storage: DurableObjectStorage,
  deadline: number,
): Promise<void> {
  await armAlarmBy(storage, deadline);
}
function writeIntent(sql: SqlStorage, intent: Intent, phase: Phase): void {
  sql.exec(
    `INSERT INTO actor_outbox (effect_id, organisation_id, originating_event_id, request_envelope, state_kind, state_projection, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (effect_id) DO UPDATE SET state_kind = excluded.state_kind, state_projection = excluded.state_projection, updated_at = excluded.updated_at`,
    PREFIX + intent.request.operationId,
    intent.request.organisationId,
    intent.authority.lease.turn.turnId,
    JSON.stringify(persistedIntent(intent)),
    phase.kind === "settled" ? "settled" : "pending",
    JSON.stringify(phase),
    Date.now(),
  );
}
function persistedIntent(intent: Intent): object {
  const { authority } = intent;
  if (authority.kind === "canonical")
    return {
      kind: "goal_model_call.v1",
      goalId: intent.goalId,
      request: intent.request,
      lease: authority.lease,
      startedAt: intent.startedAt,
    };
  return {
    kind: "transient_goal_model_call.v1",
    goalId: intent.goalId,
    request: intent.request,
    lease: authority.lease,
    startedAt: intent.startedAt,
    runId: authority.runId,
    tokenAllowance: authority.tokenAllowance,
  };
}

type IntentQuery =
  | { kind: "pending" }
  | { kind: "turn" | "admission"; turnId: string }
  | { kind: "run"; runId: string };

function intentFilter(query: IntentQuery): {
  predicate: string;
  bindings: string[];
} {
  switch (query.kind) {
    case "pending":
      return { predicate: "state_kind = 'pending'", bindings: [] };
    case "turn":
      return {
        predicate: "originating_event_id = ?",
        bindings: [query.turnId],
      };
    case "admission":
      return {
        predicate: "(state_kind = 'pending' OR originating_event_id = ?)",
        bindings: [query.turnId],
      };
    case "run":
      return {
        predicate: "json_extract(request_envelope, '$.runId') = ?",
        bindings: [query.runId],
      };
    default:
      return assertNever(query);
  }
}

function readIntents(sql: SqlStorage, query: IntentQuery): Pending[] {
  const { predicate, bindings } = intentFilter(query);
  const records = sql
    .exec<{ request_envelope: string; state_projection: string }>(
      `SELECT request_envelope, state_projection FROM actor_outbox WHERE effect_id LIKE 'goal_model_call:%' AND ${predicate} ORDER BY rowid`,
      ...bindings,
    )
    .toArray();
  return records.map(parseStoredIntent);
}
function readIntent(sql: SqlStorage, operationId: string): Pending | null {
  const row = sql
    .exec<{ request_envelope: string; state_projection: string }>(
      "SELECT request_envelope, state_projection FROM actor_outbox WHERE effect_id = ?",
      PREFIX + operationId,
    )
    .toArray()[0];
  return row === undefined ? null : parseStoredIntent(row);
}
function parseStoredIntent(row: {
  request_envelope: string;
  state_projection: string;
}): Pending {
  const raw = parseJsonOrNull(row.request_envelope);
  const phase = parseJsonOrNull(row.state_projection);
  if (
    !isRecord(raw) ||
    (raw.kind !== "goal_model_call.v1" &&
      raw.kind !== "transient_goal_model_call.v1") ||
    typeof raw.goalId !== "string" ||
    raw.goalId.length === 0 ||
    typeof raw.startedAt !== "number" ||
    !Number.isSafeInteger(raw.startedAt) ||
    !isRecord(phase)
  )
    throw new Error("goal_outbox_corrupt");
  const request = parseGoalAdmissionRequest(raw.request);
  const lease = parsePersistedHarnessTurnLease(raw.lease);
  if (
    request === null ||
    lease === null ||
    request.organisationId !== lease.session.organisationId ||
    request.sessionId !== lease.session.sessionId
  )
    throw new Error("goal_outbox_corrupt");
  let authority: GoalUsageAuthority;
  if (raw.kind === "goal_model_call.v1")
    authority = { kind: "canonical", lease };
  else {
    if (
      typeof raw.runId !== "string" ||
      raw.runId.length === 0 ||
      typeof raw.tokenAllowance !== "number" ||
      !Number.isSafeInteger(raw.tokenAllowance) ||
      raw.tokenAllowance <= 0
    )
      throw new Error("goal_outbox_corrupt");
    authority = {
      kind: "transient",
      lease,
      runId: raw.runId,
      tokenAllowance: raw.tokenAllowance,
    };
  }
  const intent: Intent = {
    authority,
    goalId: raw.goalId,
    request,
    startedAt: raw.startedAt,
  };
  if (phase.kind === "admitting" || phase.kind === "dispatched")
    return { intent, phase: { kind: phase.kind } };
  if (phase.kind === "settling" || phase.kind === "settled") {
    const usage = parseGoalUsageRequest({
      organisationId: request.organisationId,
      caseId: request.caseId,
      sessionId: request.sessionId,
      operationId: request.operationId,
      outcome: phase.outcome,
    });
    if (usage !== null)
      return { intent, phase: { kind: phase.kind, outcome: usage.outcome } };
  }
  throw new Error("goal_outbox_corrupt");
}
