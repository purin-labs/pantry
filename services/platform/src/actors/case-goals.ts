import {
  parseCaseGoal as parseGoal,
  parseCaseGoalSnapshot as parseSnapshot,
} from "@seams/contracts";
import type {
  CaseGoal,
  CaseGoalCommand,
  CaseGoalOperationOutcome,
  CaseGoalSnapshot,
  CaseGoalState,
} from "@seams/contracts";
import {
  assertNever,
  canonicalJson,
  hasExactKeys,
  isRecord,
  parseJsonOrNull,
} from "@seams/std";
import type { Result } from "../result";

type Identity = { readonly organisationId: string; readonly caseId: string };
export type GoalCommandRequest = Identity & {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly command: CaseGoalCommand;
};
export type GoalAdmissionRequest = Identity & {
  readonly operationId: string;
  readonly sessionId: string;
  readonly expectedRevision: number;
};
export type GoalUsageRequest = Identity & {
  readonly operationId: string;
  readonly sessionId: string;
  readonly outcome: CaseGoalOperationOutcome;
};
export type GoalError = {
  readonly code:
    | "goal_execution_running"
    | "goal_execution_closed"
    | "goal_request_replaced"
    | "goal_request_invalid"
    | "goal_identity_mismatch"
    | "goal_revision_conflict"
    | "goal_command_conflict"
    | "goal_missing"
    | "goal_terminal"
    | "goal_budget_exhausted"
    | "goal_not_active"
    | "goal_usage_pending"
    | "goal_operation_conflict"
    | "goal_operation_missing"
    | "goal_usage_conflict"
    | "goal_storage_corrupt"
    | "goal_counter_overflow";
};
type GoalResult<T> = Result<T, GoalError>;
type Row = Record<string, SqlStorageValue> & { payload: string };
type Operation = {
  readonly goalId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly admittedRevision: number;
  readonly outcome: { readonly kind: "pending" } | CaseGoalOperationOutcome;
};
export type GoalAdmission = {
  readonly goalId: string;
  readonly operationId: string;
  readonly admittedRevision: number;
};
const MAX_COUNTER = 0xffff_ffff;

export function createCaseGoalSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS case_goal_request (
    request_id TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_goal_execution (
    execution_id TEXT PRIMARY KEY, state TEXT NOT NULL,
    snapshot TEXT CHECK (snapshot IS NULL OR json_valid(snapshot))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_goal_head (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL, goal_id TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_goal (
    goal_id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK (json_valid(payload))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_goal_command (
    command_id TEXT PRIMARY KEY, request TEXT NOT NULL CHECK (json_valid(request)),
    payload TEXT NOT NULL CHECK (json_valid(payload))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS case_goal_operation (
    operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload))
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS case_goal_operation_session ON case_goal_operation (session_id)",
  );
}

export function readCaseGoal(
  sql: SqlStorage,
  identity: Identity,
): GoalResult<CaseGoalSnapshot> {
  if (!matchesCase(sql, identity)) return failure("goal_identity_mismatch");
  const head = sql
    .exec<{ revision: number; goal_id: string | null }>(
      "SELECT revision, goal_id FROM case_goal_head WHERE singleton = 1",
    )
    .toArray()[0];
  if (head === undefined) return success({ kind: "none", revision: 0 });
  if (!counter(head.revision)) return failure("goal_storage_corrupt");
  if (head.goal_id === null)
    return success({ kind: "none", revision: head.revision });
  const goal = readGoal(sql, head.goal_id);
  if (
    goal === null ||
    goal.organisationId !== identity.organisationId ||
    goal.caseId !== identity.caseId
  )
    return failure("goal_storage_corrupt");
  return success({ kind: "present", revision: head.revision, goal });
}

export type GoalExecutionRequest = Identity & {
  readonly executionId: string;
  readonly requestId: string;
};

export function parseGoalExecutionRequest(
  raw: unknown,
): GoalExecutionRequest | null {
  const identity = parseGoalIdentity(raw);
  if (
    identity === null ||
    !isRecord(raw) ||
    !identifier(raw.executionId) ||
    !identifier(raw.requestId)
  )
    return null;
  return {
    ...identity,
    executionId: raw.executionId,
    requestId: raw.requestId,
  };
}

export function bindCaseGoalExecution(
  sql: SqlStorage,
  request: GoalExecutionRequest,
): GoalResult<CaseGoalSnapshot> {
  const current = readCaseGoal(sql, request);
  if (!current.ok) return current;
  const existing = sql
    .exec<{ state: string; snapshot: string | null }>(
      "SELECT state, snapshot FROM case_goal_execution WHERE execution_id = ?",
      request.executionId,
    )
    .toArray()[0];
  if (existing !== undefined) {
    if (existing.state === "closed") return failure("goal_execution_closed");
    if (existing.state !== "open") return failure("goal_storage_corrupt");
    const snapshot =
      existing.snapshot === null
        ? null
        : parseSnapshot(parseJsonOrNull(existing.snapshot));
    return snapshot === null
      ? failure("goal_storage_corrupt")
      : success(snapshot);
  }
  const enrolled = sql
    .exec<{ snapshot: string }>(
      "SELECT snapshot FROM case_goal_request WHERE request_id = ?",
      request.requestId,
    )
    .toArray()[0];
  const snapshot =
    enrolled === undefined
      ? current.value
      : parseSnapshot(parseJsonOrNull(enrolled.snapshot));
  if (snapshot === null) return failure("goal_storage_corrupt");
  // A previously untracked request must not bypass a later goal's controls.
  if (snapshot.kind === "none" && snapshot.revision !== current.value.revision)
    return failure("goal_request_replaced");
  if (enrolled === undefined) {
    sql.exec(
      "INSERT INTO case_goal_request VALUES (?, ?)",
      request.requestId,
      JSON.stringify(snapshot),
    );
  }
  sql.exec(
    "INSERT INTO case_goal_execution VALUES (?, 'open', ?)",
    request.executionId,
    JSON.stringify(snapshot),
  );
  return success(snapshot);
}

export function closeCaseGoalExecution(
  sql: SqlStorage,
  request: GoalExecutionRequest,
): GoalResult<CaseGoalSnapshot> {
  const current = readCaseGoal(sql, request);
  if (!current.ok) return current;
  // Retain the closed identity so a delayed bind cannot reopen the turn.
  sql.exec(
    "INSERT INTO case_goal_execution VALUES (?, 'closed', NULL) ON CONFLICT (execution_id) DO UPDATE SET state = 'closed', snapshot = NULL",
    request.executionId,
  );
  return current;
}

export function applyCaseGoalCommand(
  sql: SqlStorage,
  request: GoalCommandRequest,
): GoalResult<CaseGoalSnapshot> {
  const current = readCaseGoal(sql, request);
  if (!current.ok) return current;
  const encoded = canonicalJson(request);
  const duplicate = sql
    .exec<Row & { request: string }>(
      "SELECT request, payload FROM case_goal_command WHERE command_id = ?",
      request.commandId,
    )
    .toArray()[0];
  if (duplicate !== undefined) {
    if (duplicate.request !== encoded) return failure("goal_command_conflict");
    const snapshot = parseSnapshot(parseJsonOrNull(duplicate.payload));
    return snapshot === null
      ? failure("goal_storage_corrupt")
      : success(snapshot);
  }
  if (current.value.revision !== request.expectedRevision)
    return failure("goal_revision_conflict");
  if (current.value.revision === MAX_COUNTER)
    return failure("goal_counter_overflow");
  if (
    request.command.kind === "set" &&
    current.value.kind === "none" &&
    sql
      .exec(
        "SELECT 1 FROM case_goal_execution WHERE state = 'open' AND json_extract(snapshot, '$.kind') = 'none' LIMIT 1",
      )
      .toArray().length > 0
  )
    return failure("goal_execution_running");
  const revision = current.value.revision + 1;
  const transitioned = transitionGoal(current.value, request);
  if (!transitioned.ok) return transitioned;
  const goal = transitioned.value;
  if (
    current.value.kind === "present" &&
    current.value.goal.goalId !== goal.goalId &&
    !terminal(current.value.goal.state)
  )
    saveGoal(sql, withState(current.value.goal, { kind: "cleared" }));
  saveGoal(sql, goal);
  const cleared = goal.state.kind === "cleared";
  sql.exec(
    "INSERT INTO case_goal_head VALUES (1, ?, ?) ON CONFLICT (singleton) DO UPDATE SET revision = excluded.revision, goal_id = excluded.goal_id",
    revision,
    cleared ? null : goal.goalId,
  );
  const snapshot: CaseGoalSnapshot = cleared
    ? { kind: "none", revision }
    : { kind: "present", revision, goal };
  sql.exec(
    "INSERT INTO case_goal_command VALUES (?, ?, ?)",
    request.commandId,
    encoded,
    JSON.stringify(snapshot),
  );
  return success(snapshot);
}

function transitionGoal(
  current: CaseGoalSnapshot,
  request: GoalCommandRequest,
): GoalResult<CaseGoal> {
  const command = request.command;
  if (command.kind === "set") {
    if (
      current.kind === "present" &&
      current.goal.objective === command.objective &&
      !terminal(current.goal.state)
    ) {
      return success(withBudget(current.goal, command.tokenBudget));
    }
    return success({
      goalId: request.commandId,
      organisationId: request.organisationId,
      caseId: request.caseId,
      objective: command.objective,
      tokenBudget: command.tokenBudget,
      tokensUsed: 0,
      activeTimeMs: 0,
      unknownOperations: 0,
      state: { kind: "active" },
    });
  }
  if (current.kind === "none") return failure("goal_missing");
  const goal = current.goal;
  if (command.kind === "clear")
    return success(withState(goal, { kind: "cleared" }));
  if (terminal(goal.state)) return failure("goal_terminal");
  switch (command.kind) {
    case "update_budget":
      return success(withBudget(goal, command.tokenBudget));
    case "pause":
      return success(withState(goal, { kind: "paused" }));
    case "resume":
      if (goal.tokensUsed >= goal.tokenBudget)
        return failure("goal_budget_exhausted");
      if (goal.unknownOperations > 0) return failure("goal_usage_pending");
      return success(withState(goal, { kind: "active" }));
    case "complete":
      return success(
        withState(goal, { kind: "completed", evidence: command.evidence }),
      );
    default:
      return assertNever(command);
  }
}

export function admitCaseGoalOperation(
  sql: SqlStorage,
  request: GoalAdmissionRequest,
): GoalResult<GoalAdmission> {
  const current = readCaseGoal(sql, request);
  if (!current.ok) return current;
  if (current.value.revision !== request.expectedRevision)
    return failure("goal_revision_conflict");
  if (current.value.kind === "none") return failure("goal_missing");
  const goal = current.value.goal;
  if (goal.state.kind !== "active") return failure("goal_not_active");
  if (goal.tokensUsed >= goal.tokenBudget)
    return failure("goal_budget_exhausted");
  if (goal.unknownOperations > 0) return failure("goal_usage_pending");
  const existing = readOperation(sql, request.operationId);
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    const operation = existing.value;
    if (
      operation.sessionId !== request.sessionId ||
      operation.goalId !== goal.goalId ||
      operation.admittedRevision !== request.expectedRevision ||
      operation.outcome.kind !== "pending"
    )
      return failure("goal_operation_conflict");
    return success(admission(operation));
  }
  const operations = sql
    .exec<Row>(
      "SELECT payload FROM case_goal_operation WHERE session_id = ? AND json_extract(payload, '$.outcome.kind') != 'reported' LIMIT 1",
      request.sessionId,
    )
    .toArray();
  for (const row of operations) {
    const operation = parseOperation(parseJsonOrNull(row.payload));
    if (operation === null) return failure("goal_storage_corrupt");
    if (operation.outcome.kind !== "reported")
      return failure("goal_usage_pending");
  }
  const operation: Operation = {
    goalId: goal.goalId,
    operationId: request.operationId,
    sessionId: request.sessionId,
    admittedRevision: current.value.revision,
    outcome: { kind: "pending" },
  };
  sql.exec(
    "INSERT INTO case_goal_operation VALUES (?, ?, ?)",
    operation.operationId,
    operation.sessionId,
    JSON.stringify(operation),
  );
  return success(admission(operation));
}

export function acceptCaseGoalUsage(
  sql: SqlStorage,
  request: GoalUsageRequest,
): GoalResult<CaseGoalSnapshot> {
  const current = readCaseGoal(sql, request);
  if (!current.ok) return current;
  const existing = readOperation(sql, request.operationId);
  if (!existing.ok) return existing;
  const operation = existing.value;
  if (operation === null) return failure("goal_operation_missing");
  if (operation.sessionId !== request.sessionId)
    return failure("goal_operation_conflict");
  if (canonicalJson(operation.outcome) === canonicalJson(request.outcome))
    return current;
  if (operation.outcome.kind === "reported")
    return failure("goal_usage_conflict");
  const goal = readGoal(sql, operation.goalId);
  if (
    goal === null ||
    goal.organisationId !== request.organisationId ||
    goal.caseId !== request.caseId
  )
    return failure("goal_storage_corrupt");
  const tokens =
    request.outcome.kind === "reported" ? request.outcome.tokens : 0;
  const time =
    request.outcome.kind === "reported" ? request.outcome.activeTimeMs : 0;
  const unknown =
    goal.unknownOperations +
    (request.outcome.kind === "unknown" ? 1 : 0) -
    (operation.outcome.kind === "unknown" ? 1 : 0);
  if (
    !counter(goal.tokensUsed + tokens) ||
    !counter(goal.activeTimeMs + time) ||
    !counter(unknown) ||
    current.value.revision === MAX_COUNTER
  )
    return failure("goal_counter_overflow");
  const next: CaseGoal = {
    goalId: goal.goalId,
    organisationId: goal.organisationId,
    caseId: goal.caseId,
    objective: goal.objective,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed + tokens,
    activeTimeMs: goal.activeTimeMs + time,
    unknownOperations: unknown,
    state: stateAfterUsage(goal, tokens),
  };
  saveGoal(sql, next);
  const settled: Operation = {
    goalId: operation.goalId,
    operationId: operation.operationId,
    sessionId: operation.sessionId,
    admittedRevision: operation.admittedRevision,
    outcome: request.outcome,
  };
  sql.exec(
    "UPDATE case_goal_operation SET payload = ? WHERE operation_id = ?",
    JSON.stringify(settled),
    operation.operationId,
  );
  // Late results update their original goal without invalidating a replacement's revision.
  if (
    current.value.kind === "present" &&
    current.value.goal.goalId === goal.goalId
  )
    sql.exec(
      "UPDATE case_goal_head SET revision = revision + 1 WHERE singleton = 1",
    );
  return readCaseGoal(sql, request);
}

function stateAfterUsage(goal: CaseGoal, tokens: number): CaseGoalState {
  if (terminal(goal.state)) return goal.state;
  if (goal.tokensUsed + tokens >= goal.tokenBudget)
    return { kind: "budget_limited" };
  return goal.state;
}

function withBudget(goal: CaseGoal, tokenBudget: number): CaseGoal {
  const updated = withState(
    goal,
    goal.tokensUsed >= tokenBudget ? { kind: "budget_limited" } : goal.state,
  );
  return {
    goalId: updated.goalId,
    organisationId: updated.organisationId,
    caseId: updated.caseId,
    objective: updated.objective,
    tokenBudget,
    tokensUsed: updated.tokensUsed,
    activeTimeMs: updated.activeTimeMs,
    unknownOperations: updated.unknownOperations,
    state: updated.state,
  };
}
function withState(goal: CaseGoal, state: CaseGoalState): CaseGoal {
  return {
    goalId: goal.goalId,
    organisationId: goal.organisationId,
    caseId: goal.caseId,
    objective: goal.objective,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    activeTimeMs: goal.activeTimeMs,
    unknownOperations: goal.unknownOperations,
    state,
  };
}
function terminal(state: CaseGoalState): boolean {
  switch (state.kind) {
    case "completed":
    case "cleared":
      return true;
    case "active":
    case "paused":
    case "budget_limited":
      return false;
    default:
      return assertNever(state);
  }
}
function admission(operation: Operation): GoalAdmission {
  return {
    goalId: operation.goalId,
    operationId: operation.operationId,
    admittedRevision: operation.admittedRevision,
  };
}
function saveGoal(sql: SqlStorage, goal: CaseGoal): void {
  sql.exec(
    "INSERT INTO case_goal VALUES (?, ?) ON CONFLICT (goal_id) DO UPDATE SET payload = excluded.payload",
    goal.goalId,
    JSON.stringify(goal),
  );
}
function readGoal(sql: SqlStorage, goalId: string): CaseGoal | null {
  const row = sql
    .exec<Row>("SELECT payload FROM case_goal WHERE goal_id = ?", goalId)
    .toArray()[0];
  return row === undefined ? null : parseGoal(parseJsonOrNull(row.payload));
}
function readOperation(
  sql: SqlStorage,
  operationId: string,
): GoalResult<Operation | null> {
  const row = sql
    .exec<Row>(
      "SELECT payload FROM case_goal_operation WHERE operation_id = ?",
      operationId,
    )
    .toArray()[0];
  if (row === undefined) return success(null);
  const operation = parseOperation(parseJsonOrNull(row.payload));
  return operation === null
    ? failure("goal_storage_corrupt")
    : success(operation);
}
function matchesCase(sql: SqlStorage, identity: Identity): boolean {
  const row = sql
    .exec<{ organisation_id: string; case_id: string }>(
      "SELECT organisation_id, case_id FROM case_meta WHERE singleton = 1",
    )
    .toArray()[0];
  return (
    row?.organisation_id === identity.organisationId &&
    row.case_id === identity.caseId
  );
}
function success<T>(value: T): GoalResult<T> {
  return { ok: true, value };
}
function failure(code: GoalError["code"]): { ok: false; error: GoalError } {
  return { ok: false, error: { code } };
}
function counter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNTER
  );
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 4000
  );
}

export function parseGoalIdentity(value: unknown): Identity | null {
  if (
    !isRecord(value) ||
    !identifier(value.organisationId) ||
    !identifier(value.caseId)
  )
    return null;
  return { organisationId: value.organisationId, caseId: value.caseId };
}
export function parseGoalCommandRequest(
  value: unknown,
): GoalCommandRequest | null {
  const identity = parseGoalIdentity(value);
  if (
    identity === null ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "organisationId",
      "caseId",
      "commandId",
      "expectedRevision",
      "command",
    ]) ||
    !identifier(value.commandId) ||
    !counter(value.expectedRevision)
  )
    return null;
  const command = parseCaseGoalCommand(value.command);
  if (command === null) return null;
  return {
    organisationId: identity.organisationId,
    caseId: identity.caseId,
    commandId: value.commandId,
    expectedRevision: value.expectedRevision,
    command,
  };
}
export function parseGoalAdmissionRequest(
  value: unknown,
): GoalAdmissionRequest | null {
  const identity = parseGoalIdentity(value);
  if (
    identity === null ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "organisationId",
      "caseId",
      "sessionId",
      "operationId",
      "expectedRevision",
    ]) ||
    !identifier(value.sessionId) ||
    !identifier(value.operationId) ||
    !counter(value.expectedRevision)
  )
    return null;
  return {
    organisationId: identity.organisationId,
    caseId: identity.caseId,
    sessionId: value.sessionId,
    operationId: value.operationId,
    expectedRevision: value.expectedRevision,
  };
}
export function parseGoalUsageRequest(value: unknown): GoalUsageRequest | null {
  const identity = parseGoalIdentity(value);
  if (
    identity === null ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      "organisationId",
      "caseId",
      "sessionId",
      "operationId",
      "outcome",
    ]) ||
    !identifier(value.sessionId) ||
    !identifier(value.operationId)
  )
    return null;
  const outcome = parseOutcome(value.outcome);
  if (outcome === null) return null;
  return {
    organisationId: identity.organisationId,
    caseId: identity.caseId,
    sessionId: value.sessionId,
    operationId: value.operationId,
    outcome,
  };
}
export function parseCaseGoalCommand(value: unknown): CaseGoalCommand | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case "set":
      return hasExactKeys(value, ["kind", "objective", "tokenBudget"]) &&
        text(value.objective) &&
        counter(value.tokenBudget) &&
        value.tokenBudget > 0
        ? {
            kind: "set",
            objective: value.objective.trim(),
            tokenBudget: value.tokenBudget,
          }
        : null;
    case "update_budget":
      return hasExactKeys(value, ["kind", "tokenBudget"]) &&
        counter(value.tokenBudget) &&
        value.tokenBudget > 0
        ? { kind: "update_budget", tokenBudget: value.tokenBudget }
        : null;
    case "complete":
      return hasExactKeys(value, ["kind", "evidence"]) && text(value.evidence)
        ? { kind: "complete", evidence: value.evidence.trim() }
        : null;
    case "pause":
    case "resume":
    case "clear":
      return hasExactKeys(value, ["kind"]) ? { kind: value.kind } : null;
    default:
      return null;
  }
}
function parseOutcome(value: unknown): CaseGoalOperationOutcome | null {
  if (!isRecord(value)) return null;
  if (value.kind === "unknown" && hasExactKeys(value, ["kind"]))
    return { kind: "unknown" };
  if (
    value.kind === "reported" &&
    hasExactKeys(value, ["kind", "tokens", "activeTimeMs"]) &&
    counter(value.tokens) &&
    counter(value.activeTimeMs)
  )
    return {
      kind: "reported",
      tokens: value.tokens,
      activeTimeMs: value.activeTimeMs,
    };
  return null;
}
function parseOperation(value: unknown): Operation | null {
  if (
    !isRecord(value) ||
    !identifier(value.goalId) ||
    !identifier(value.operationId) ||
    !identifier(value.sessionId) ||
    !counter(value.admittedRevision)
  )
    return null;
  const outcome =
    isRecord(value.outcome) &&
    value.outcome.kind === "pending" &&
    hasExactKeys(value.outcome, ["kind"])
      ? ({ kind: "pending" } as const)
      : parseOutcome(value.outcome);
  if (outcome === null) return null;
  return {
    goalId: value.goalId,
    operationId: value.operationId,
    sessionId: value.sessionId,
    admittedRevision: value.admittedRevision,
    outcome,
  };
}
