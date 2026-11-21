import {
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import {
  isIanaTimezone,
  isReviewedRecordId,
  parseMemoryEvidenceList,
  parseMemoryRevisionState,
} from "./memory.ts";
import type {
  MemoryEvidence,
  MemoryRevisionRef,
  MemoryRevisionState,
} from "./memory.ts";

/** One exact Eval revision. Runs and results cite this pair. */
export type EvalRevisionRef = Readonly<{
  evalId: string;
  revision: number;
}>;

/** What the agent under test concluded for one scenario. */
export type EvalReplyOutcome = "reply_now" | "approval_required" | "no_reply";

/**
 * One check on observable behaviour. Each is decided from the recorded
 * outcome and reply text alone, so the same record always scores the same.
 */
export type EvalCriterion = Readonly<{ criterionId: string }> &
  (
    | Readonly<{
        kind: "outcome";
        expected: EvalReplyOutcome;
        text?: never;
      }>
    | Readonly<{
        /** Whether the reply holds `text`, compared without case. */
        kind: "reply_includes" | "reply_excludes";
        text: string;
        expected?: never;
      }>
  );

/**
 * The verified contact a scenario's message is from, by exact verification
 * revision. A run derives the supplier, the sender's address and the reply
 * recipient from that verification as it stands. Once it is superseded or
 * revoked the scenario cannot run until a revision names a current one.
 */
export type EvalScenarioSender = Readonly<{
  verificationId: string;
  revision: number;
}>;

/**
 * A verified contact that a scenario can name as its sender: the exact
 * verification revision, and the address that a person recognises it by.
 */
export type EvalSenderChoice = EvalScenarioSender &
  Readonly<{ address: string }>;

/** A synthetic message the agent under test is asked to handle. */
export type EvalScenarioMessage = Readonly<{
  subject: string;
  body: string;
  /** When the message arrived, as epoch milliseconds. */
  receivedAt: number;
  /** IANA zone the arrival time is shown to the agent in. */
  timezone: string;
}>;

/**
 * One reviewed situation and the behaviour expected in it.
 *
 * A target shows the behaviour under test. A control is a situation the
 * change must leave alone, which detects a lesson applied too widely.
 */
export type EvalScenario = Readonly<{
  scenarioId: string;
  role: "target" | "control";
  title: string;
  sender: EvalScenarioSender;
  message: EvalScenarioMessage;
  criteria: readonly EvalCriterion[];
}>;

/** The agent behaviour an Eval tries. */
export type EvalSubject = Readonly<{
  kind: "mailbox_reply";
  integrationAccountId: string;
}>;

export type EvalContent = Readonly<{
  title: string;
  subject: EvalSubject;
  scenarios: readonly EvalScenario[];
  /** The records that justify the expected behaviour. */
  evidence: readonly MemoryEvidence[];
  /** The Case the proposal came from, so its origin stays inspectable. */
  sourceCaseId: string;
}>;

/**
 * Who wrote a revision. Pantry proposes an Eval from a Case it worked. A
 * person revises one only on its shared review surface, so their words go to
 * the audience of the revision they edit.
 */
export type EvalAuthor =
  | Readonly<{
      kind: "agent";
      caseId: string;
      assignmentId: string;
      sessionId: string;
      personId?: never;
    }>
  | Readonly<{
      kind: "operator";
      personId: string;
      caseId?: never;
      assignmentId?: never;
      sessionId?: never;
    }>;

/** An Eval revision is reviewed through the same lifecycle as a Memory one. */
export type EvalRevisionState = MemoryRevisionState;

export type EvalRevisionView = EvalContent &
  Readonly<{
    revision: number;
    proposedBy: EvalAuthor;
    proposedAt: number;
  }> &
  EvalRevisionState;

export type EvalView = Readonly<{
  evalId: string;
  /** The latest revision number. Commands name it as their expected revision. */
  headRevision: number;
  revisions: readonly EvalRevisionView[];
}>;

/**
 * One idempotent command a person sends about an existing Eval.
 *
 * `expectedRevision` is the head revision the sender last saw. A revision
 * edits the candidate under review, or proposes a replacement for the
 * accepted revision, which stays in force until the replacement is accepted.
 */
export type EvalCommand = Readonly<{
  commandId: string;
  evalId: string;
  expectedRevision: number;
}> &
  (
    | Readonly<{
        kind: "revise";
        content: EvalContent;
        revision?: never;
      }>
    | Readonly<{
        kind: "accept" | "reject" | "revoke";
        revision: number;
        content?: never;
      }>
  );

export type EvalCommandReceipt = Readonly<{
  commandId: string;
  evalId: string;
  /** The revision the command created or decided. */
  revision: number;
  headRevision: number;
  state: EvalRevisionState["kind"];
}>;

export type EvalCommandErrorCode =
  | "eval_invalid"
  | "eval_unavailable"
  /** The expected revision or the revision's state no longer matches. */
  | "eval_conflict"
  /** The command identity was already used for a different request. */
  | "eval_command_conflict"
  /** A decision or revision came from a principal that cannot review. */
  | "eval_reviewer_required"
  | "eval_capacity_exceeded";

/** How criteria are decided. A result names the scorer that produced it. */
export const EVAL_SCORER_VERSION = "pantry_eval_scorer_v1";

export const MAX_EVAL_SCENARIOS = 6;
/**
 * The latest arrival time a scenario may state: the start of the year 2100,
 * in milliseconds. A larger number is no date, and a date formatter throws
 * on it.
 */
export const MAX_EVAL_RECEIVED_AT = 4_102_444_800_000;
export const MAX_EVAL_CRITERIA = 6;

/**
 * The inference authority one task is pinned to: the organisation's Codex
 * subscription, its own OpenAI or Anthropic key, or Pantry's platform key. A
 * task that cannot use its authority is unavailable. It never moves to
 * another one.
 */
export type EvalRoute =
  | "claude_oauth"
  | "codex_subscription"
  | "organisation_openai_api_key"
  | "organisation_anthropic_api_key"
  | "organisation_google_api_key"
  | "pantry_platform";

/**
 * The knowledge the agent under test is given. `current` is the accepted
 * Memory an ordinary turn would load. `candidate` gives one Memory's
 * candidate revision in place of its accepted one, inside the run only.
 */
export type EvalConfiguration =
  | Readonly<{ kind: "current"; memory?: never }>
  | Readonly<{ kind: "candidate"; memory: MemoryRevisionRef }>;

/** One idempotent command about a run. A run tries one accepted revision. */
export type EvalRunCommand = Readonly<{ commandId: string }> &
  (
    | Readonly<{
        kind: "start";
        eval: EvalRevisionRef;
        routes: readonly EvalRoute[];
        configurations: readonly EvalConfiguration[];
        evalId?: never;
        runId?: never;
      }>
    | Readonly<{
        kind: "cancel";
        evalId: string;
        runId: string;
        eval?: never;
        routes?: never;
        configurations?: never;
      }>
  );

export type EvalRunCommandReceipt = Readonly<{
  commandId: string;
  runId: string;
  caseId: string;
}>;

export type EvalCriterionOutcome = Readonly<{
  criterionId: string;
  met: boolean;
}>;

/** What the agent under test did in one scenario. */
export type EvalObservation = Readonly<{
  outcome: EvalReplyOutcome;
  /** The reply it wrote, bounded. Null when it chose no reply. */
  reply: string | null;
  /** The Memory revisions its prompt carried. */
  memory: readonly MemoryRevisionRef[];
}>;

/** Why a task could not try the agent. None of these is a verdict. */
export type EvalUnavailableReason =
  /** The pinned inference authority has no usable credential or allowance. */
  | "authority_unavailable"
  /** The run or the mailbox had no token budget left for the task. */
  | "budget_exhausted"
  /** The mailbox agent the Eval tries is not installed or not active. */
  | "agent_unavailable"
  /** The Eval revision or its scenario could not be read for the task. */
  | "fixture_unavailable"
  /** The Memory the configuration names could not be established. */
  | "memory_unavailable";

/**
 * How one task ended. Only an assessed task carries a verdict. A task that
 * could not run, failed while running, was cancelled, or ended with an
 * unknown result says so and passes or fails nothing.
 */
export type EvalTaskOutcome =
  | Readonly<{
      kind: "assessed";
      verdict: "passed" | "failed";
      criteria: readonly EvalCriterionOutcome[];
      observation: EvalObservation;
      reason?: never;
      code?: never;
    }>
  | Readonly<{
      kind: "unavailable";
      reason: EvalUnavailableReason;
      verdict?: never;
      criteria?: never;
      observation?: never;
      code?: never;
    }>
  | Readonly<{
      kind: "failed" | "indeterminate";
      code: string;
      verdict?: never;
      criteria?: never;
      observation?: never;
      reason?: never;
    }>
  | Readonly<{
      kind: "cancelled";
      verdict?: never;
      criteria?: never;
      observation?: never;
      reason?: never;
      code?: never;
    }>;

/** The exact revisions one task ran against. */
export type EvalTaskPins = Readonly<{
  /** The effective model of the pinned route. */
  model: string;
  modelRouteDigest: string;
  /** The agent's instructions and skills as composed for the turn. */
  instructionDigest: string;
  toolCatalogDigest: string;
  contextBundleDigest: string;
  policyVersion: number;
}>;

/** Where one task ran, for inspection through the Case and its Session. */
export type EvalTaskExecution = Readonly<{
  assignmentId: string;
  sessionId: string;
  turnId: string;
}>;

export type EvalTaskKey = Readonly<{
  taskId: string;
  scenarioId: string;
  configuration: EvalConfiguration["kind"];
  route: EvalRoute;
}>;

export type EvalTaskProgress = EvalTaskKey &
  Readonly<{ state: "pending" | "running" | "settled" }>;

export type EvalTaskResult = EvalTaskKey &
  Readonly<{
    outcome: EvalTaskOutcome;
    /** Null when the task ended before an assignment was made for it. */
    execution: EvalTaskExecution | null;
    /** Null when the task ended before its turn was prepared. */
    pins: EvalTaskPins | null;
    /** Null when no usage is known for the task. */
    totalTokens: number | null;
  }>;

/**
 * A run is one Case. `pending` and `running` describe work in progress.
 * `completed` means every task was assessed or was unavailable. `failed`
 * means a task failed while running, and `indeterminate` that one ended with
 * an unknown result. Neither is a behaviour verdict.
 */
export type EvalRunState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

type EvalRunHeader = Readonly<{
  runId: string;
  eval: EvalRevisionRef;
  /** The Case that holds one assignment per task. */
  caseId: string;
  startedByPersonId: string;
  startedAt: number;
  routes: readonly EvalRoute[];
  configurations: readonly EvalConfiguration[];
  scorer: string;
}>;

/** A run still in progress. It shows how far it is and no result. */
export type EvalRunProgress = EvalRunHeader &
  Readonly<{
    state: "pending" | "running";
    tasks: readonly EvalTaskProgress[];
    settledAt?: never;
  }>;

/** The settled result of one run, kept against the exact revisions tried. */
export type EvalRunResult = EvalRunHeader &
  Readonly<{
    state: "completed" | "failed" | "cancelled" | "indeterminate";
    settledAt: number;
    tasks: readonly EvalTaskResult[];
  }>;

export type EvalRunView = EvalRunProgress | EvalRunResult;

/** One scenario on one route, under each configuration the run tried. */
export type EvalComparisonRow = Readonly<{
  scenarioId: string;
  route: EvalRoute;
  current: EvalTaskResult | null;
  candidate: EvalTaskResult | null;
}>;

export const MAX_EVAL_ROUTES = 3;
export const MAX_EVAL_REPLY_LENGTH = 2_000;

const EVAL_ROUTES: readonly EvalRoute[] = [
  "claude_oauth",
  "codex_subscription",
  "organisation_openai_api_key",
  "organisation_anthropic_api_key",
  "organisation_google_api_key",
  "pantry_platform",
];
const MAX_RUNS = 100;
const MAX_TITLE_LENGTH = 160;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 4_000;
const MAX_CRITERION_TEXT_LENGTH = 200;
const MAX_REVISIONS = 100;
const MAX_EVALS = 200;

export function parseEvalCommand(raw: unknown): EvalCommand | null {
  if (
    !isRecord(raw) ||
    !isReviewedRecordId(raw.commandId) ||
    !isReviewedRecordId(raw.evalId) ||
    !isPositiveInteger(raw.expectedRevision)
  )
    return null;
  const base = {
    commandId: raw.commandId,
    evalId: raw.evalId,
    expectedRevision: raw.expectedRevision,
  };
  if (raw.kind === "revise") {
    if (
      !hasExactKeys(raw, [
        "commandId",
        "evalId",
        "expectedRevision",
        "kind",
        "content",
      ])
    )
      return null;
    const content = parseEvalContent(raw.content);
    return content === null ? null : { ...base, kind: "revise", content };
  }
  if (
    (raw.kind !== "accept" && raw.kind !== "reject" && raw.kind !== "revoke") ||
    !hasExactKeys(raw, [
      "commandId",
      "evalId",
      "expectedRevision",
      "kind",
      "revision",
    ]) ||
    !isPositiveInteger(raw.revision) ||
    raw.revision > raw.expectedRevision
  )
    return null;
  return { ...base, kind: raw.kind, revision: raw.revision };
}

export function parseEvalContent(raw: unknown): EvalContent | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "title",
      "subject",
      "scenarios",
      "evidence",
      "sourceCaseId",
    ]) ||
    !boundedText(raw.title, MAX_TITLE_LENGTH) ||
    !isReviewedRecordId(raw.sourceCaseId) ||
    !Array.isArray(raw.scenarios) ||
    raw.scenarios.length === 0 ||
    raw.scenarios.length > MAX_EVAL_SCENARIOS
  )
    return null;
  const subject = parseSubject(raw.subject);
  const evidence = parseMemoryEvidenceList(raw.evidence);
  if (subject === null || evidence === null || evidence.length === 0)
    return null;
  const scenarios: EvalScenario[] = [];
  for (const entry of raw.scenarios) {
    const scenario = parseScenario(entry);
    if (
      scenario === null ||
      scenarios.some((earlier) => earlier.scenarioId === scenario.scenarioId)
    )
      return null;
    scenarios.push(scenario);
  }
  // Without a target there is no behaviour under test, only controls.
  if (!scenarios.some((scenario) => scenario.role === "target")) return null;
  return {
    title: raw.title,
    subject,
    scenarios,
    evidence,
    sourceCaseId: raw.sourceCaseId,
  };
}

export function parseEvalAuthor(raw: unknown): EvalAuthor | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "operator")
    return hasExactKeys(raw, ["kind", "personId"]) &&
      isReviewedRecordId(raw.personId)
      ? { kind: "operator", personId: raw.personId }
      : null;
  return raw.kind === "agent" &&
    hasExactKeys(raw, ["kind", "caseId", "assignmentId", "sessionId"]) &&
    isReviewedRecordId(raw.caseId) &&
    isReviewedRecordId(raw.assignmentId) &&
    isReviewedRecordId(raw.sessionId)
    ? {
        kind: "agent",
        caseId: raw.caseId,
        assignmentId: raw.assignmentId,
        sessionId: raw.sessionId,
      }
    : null;
}

export function parseEvalCommandReceipt(
  raw: unknown,
): EvalCommandReceipt | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "commandId",
      "evalId",
      "revision",
      "headRevision",
      "state",
    ]) ||
    !isReviewedRecordId(raw.commandId) ||
    !isReviewedRecordId(raw.evalId) ||
    !isPositiveInteger(raw.revision) ||
    !isPositiveInteger(raw.headRevision) ||
    raw.revision > raw.headRevision ||
    !revisionStateKind(raw.state)
  )
    return null;
  return {
    commandId: raw.commandId,
    evalId: raw.evalId,
    revision: raw.revision,
    headRevision: raw.headRevision,
    state: raw.state,
  };
}

export const MAX_EVAL_SENDER_CHOICES = 50;

export function parseEvalSenderChoicesResponse(
  raw: unknown,
): readonly EvalSenderChoice[] {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !Array.isArray(raw.contacts) ||
    raw.contacts.length > MAX_EVAL_SENDER_CHOICES
  )
    throw new Error("The verified contacts are unavailable.");
  const contacts: EvalSenderChoice[] = [];
  for (const entry of raw.contacts) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["verificationId", "revision", "address"]) ||
      typeof entry.verificationId !== "string" ||
      entry.verificationId.length === 0 ||
      !isPositiveInteger(entry.revision) ||
      typeof entry.address !== "string" ||
      entry.address.length === 0
    )
      throw new Error("A verified contact is invalid.");
    contacts.push({
      verificationId: entry.verificationId,
      revision: entry.revision,
      address: entry.address,
    });
  }
  return contacts;
}

export function parseEvalListResponse(raw: unknown): readonly EvalView[] {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !Array.isArray(raw.evals) ||
    raw.evals.length > MAX_EVALS
  )
    throw new Error("Evals are unavailable.");
  const evals: EvalView[] = [];
  for (const entry of raw.evals) {
    const parsed = parseEvalView(entry);
    if (parsed === null) throw new Error("An Eval is invalid.");
    evals.push(parsed);
  }
  return evals;
}

export function parseEvalView(raw: unknown): EvalView | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["evalId", "headRevision", "revisions"]) ||
    !isReviewedRecordId(raw.evalId) ||
    !isPositiveInteger(raw.headRevision) ||
    !Array.isArray(raw.revisions) ||
    raw.revisions.length === 0 ||
    raw.revisions.length > MAX_REVISIONS
  )
    return null;
  const revisions: EvalRevisionView[] = [];
  for (const entry of raw.revisions) {
    const revision = parseEvalRevisionView(entry);
    if (revision === null || revision.revision > raw.headRevision) return null;
    revisions.push(revision);
  }
  return { evalId: raw.evalId, headRevision: raw.headRevision, revisions };
}

export function parseEvalRevisionView(raw: unknown): EvalRevisionView | null {
  if (
    !isRecord(raw) ||
    !isPositiveInteger(raw.revision) ||
    !isNonNegativeInteger(raw.proposedAt)
  )
    return null;
  const {
    revision,
    proposedBy: rawAuthor,
    proposedAt,
    title,
    subject,
    scenarios,
    evidence,
    sourceCaseId,
    ...rawState
  } = raw;
  const content = parseEvalContent({
    title,
    subject,
    scenarios,
    evidence,
    sourceCaseId,
  });
  const proposedBy = parseEvalAuthor(rawAuthor);
  const state = parseMemoryRevisionState(rawState);
  return content === null || proposedBy === null || state === null
    ? null
    : { ...content, revision, proposedBy, proposedAt, ...state };
}

function parseSubject(raw: unknown): EvalSubject | null {
  return isRecord(raw) &&
    raw.kind === "mailbox_reply" &&
    hasExactKeys(raw, ["kind", "integrationAccountId"]) &&
    isReviewedRecordId(raw.integrationAccountId)
    ? { kind: "mailbox_reply", integrationAccountId: raw.integrationAccountId }
    : null;
}

function parseScenario(raw: unknown): EvalScenario | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "scenarioId",
      "role",
      "title",
      "sender",
      "message",
      "criteria",
    ]) ||
    !isReviewedRecordId(raw.scenarioId) ||
    (raw.role !== "target" && raw.role !== "control") ||
    !boundedText(raw.title, MAX_TITLE_LENGTH) ||
    !Array.isArray(raw.criteria) ||
    raw.criteria.length === 0 ||
    raw.criteria.length > MAX_EVAL_CRITERIA
  )
    return null;
  const sender = parseSender(raw.sender);
  const message = parseMessage(raw.message);
  if (sender === null || message === null) return null;
  const criteria: EvalCriterion[] = [];
  for (const entry of raw.criteria) {
    const criterion = parseCriterion(entry);
    if (
      criterion === null ||
      criteria.some((earlier) => earlier.criterionId === criterion.criterionId)
    )
      return null;
    criteria.push(criterion);
  }
  return {
    scenarioId: raw.scenarioId,
    role: raw.role,
    title: raw.title,
    sender,
    message,
    criteria,
  };
}

function parseSender(raw: unknown): EvalScenarioSender | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["verificationId", "revision"]) &&
    isReviewedRecordId(raw.verificationId) &&
    isPositiveInteger(raw.revision)
    ? { verificationId: raw.verificationId, revision: raw.revision }
    : null;
}

function parseMessage(raw: unknown): EvalScenarioMessage | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["subject", "body", "receivedAt", "timezone"]) &&
    boundedText(raw.subject, MAX_SUBJECT_LENGTH) &&
    boundedText(raw.body, MAX_BODY_LENGTH) &&
    isNonNegativeInteger(raw.receivedAt) &&
    raw.receivedAt <= MAX_EVAL_RECEIVED_AT &&
    isIanaTimezone(raw.timezone)
    ? {
        subject: raw.subject,
        body: raw.body,
        receivedAt: raw.receivedAt,
        timezone: raw.timezone,
      }
    : null;
}

function parseCriterion(raw: unknown): EvalCriterion | null {
  if (!isRecord(raw) || !isReviewedRecordId(raw.criterionId)) return null;
  switch (raw.kind) {
    case "outcome":
      return hasExactKeys(raw, ["criterionId", "kind", "expected"]) &&
        (raw.expected === "reply_now" ||
          raw.expected === "approval_required" ||
          raw.expected === "no_reply")
        ? {
            criterionId: raw.criterionId,
            kind: "outcome",
            expected: raw.expected,
          }
        : null;
    case "reply_includes":
    case "reply_excludes":
      return hasExactKeys(raw, ["criterionId", "kind", "text"]) &&
        boundedText(raw.text, MAX_CRITERION_TEXT_LENGTH)
        ? { criterionId: raw.criterionId, kind: raw.kind, text: raw.text }
        : null;
    default:
      return null;
  }
}

function boundedText(raw: unknown, limit: number): raw is string {
  return (
    typeof raw === "string" && raw.trim().length > 0 && raw.length <= limit
  );
}

function revisionStateKind(raw: unknown): raw is EvalRevisionState["kind"] {
  return (
    raw === "candidate" ||
    raw === "accepted" ||
    raw === "rejected" ||
    raw === "superseded" ||
    raw === "revoked"
  );
}

/** The identity of the task for one scenario, configuration and route. */
export function evalTaskId(
  scenarioId: string,
  configuration: EvalConfiguration["kind"],
  route: EvalRoute,
): string {
  return `${scenarioId}.${configuration}.${route}`;
}

/** The state of a settled run, decided from its task outcomes alone. */
export function settledEvalRunState(
  outcomes: readonly EvalTaskOutcome["kind"][],
  cancelled: boolean,
): EvalRunResult["state"] {
  if (cancelled) return "cancelled";
  if (outcomes.includes("indeterminate")) return "indeterminate";
  if (outcomes.includes("failed")) return "failed";
  return "completed";
}

/**
 * Sets each scenario's results under the two configurations side by side.
 * Provider output can differ between identical requests, so one row is one
 * observation of each configuration, not a proof of either.
 */
export function compareEvalRun(
  run: EvalRunResult,
): readonly EvalComparisonRow[] {
  const rows: EvalComparisonRow[] = [];
  for (const task of run.tasks) {
    if (
      rows.some(
        (row) => row.scenarioId === task.scenarioId && row.route === task.route,
      )
    )
      continue;
    const under = (kind: EvalConfiguration["kind"]) =>
      run.tasks.find(
        (other) =>
          other.scenarioId === task.scenarioId &&
          other.route === task.route &&
          other.configuration === kind,
      ) ?? null;
    rows.push({
      scenarioId: task.scenarioId,
      route: task.route,
      current: under("current"),
      candidate: under("candidate"),
    });
  }
  return rows;
}

/**
 * Whether every scenario passed under one configuration, on one route or on
 * every route the run tried. A task with no verdict leaves the answer
 * incomplete: it neither passes nor fails.
 */
export function evalConfigurationVerdict(
  run: EvalRunResult,
  configuration: EvalConfiguration["kind"],
  route: EvalRoute | null = null,
): "passed" | "failed" | "incomplete" {
  const tasks = run.tasks.filter(
    (task) =>
      task.configuration === configuration &&
      (route === null || task.route === route),
  );
  if (
    tasks.length === 0 ||
    tasks.some((task) => task.outcome.kind !== "assessed")
  )
    return "incomplete";
  return tasks.every((task) => task.outcome.verdict === "passed")
    ? "passed"
    : "failed";
}

export function parseEvalRunCommand(raw: unknown): EvalRunCommand | null {
  if (!isRecord(raw) || !isReviewedRecordId(raw.commandId)) return null;
  if (raw.kind === "cancel")
    return hasExactKeys(raw, ["commandId", "kind", "evalId", "runId"]) &&
      isReviewedRecordId(raw.evalId) &&
      isReviewedRecordId(raw.runId)
      ? {
          commandId: raw.commandId,
          kind: "cancel",
          evalId: raw.evalId,
          runId: raw.runId,
        }
      : null;
  if (
    raw.kind !== "start" ||
    !hasExactKeys(raw, [
      "commandId",
      "kind",
      "eval",
      "routes",
      "configurations",
    ])
  )
    return null;
  const target = parseEvalRevisionRef(raw.eval);
  const routes = parseEvalRoutes(raw.routes);
  const configurations = parseEvalConfigurations(raw.configurations);
  return target === null || routes === null || configurations === null
    ? null
    : {
        commandId: raw.commandId,
        kind: "start",
        eval: target,
        routes,
        configurations,
      };
}

export function parseEvalRunCommandReceipt(
  raw: unknown,
): EvalRunCommandReceipt | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["commandId", "runId", "caseId"]) &&
    isReviewedRecordId(raw.commandId) &&
    isReviewedRecordId(raw.runId) &&
    isReviewedRecordId(raw.caseId)
    ? { commandId: raw.commandId, runId: raw.runId, caseId: raw.caseId }
    : null;
}

export function parseEvalRunListResponse(raw: unknown): readonly EvalRunView[] {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !Array.isArray(raw.runs) ||
    raw.runs.length > MAX_RUNS
  )
    throw new Error("Eval runs are unavailable.");
  const runs: EvalRunView[] = [];
  for (const entry of raw.runs) {
    const run = parseEvalRunView(entry);
    if (run === null) throw new Error("An Eval run is invalid.");
    runs.push(run);
  }
  return runs;
}

export function parseEvalRunView(raw: unknown): EvalRunView | null {
  if (!isRecord(raw)) return null;
  const { state, tasks, settledAt, ...rawHeader } = raw;
  const header = parseRunHeader(rawHeader);
  if (header === null || !Array.isArray(tasks)) return null;
  const expected = header.routes.length * header.configurations.length;
  if (
    tasks.length === 0 ||
    tasks.length % expected !== 0 ||
    tasks.length > expected * MAX_EVAL_SCENARIOS
  )
    return null;
  if (state === "pending" || state === "running") {
    if (settledAt !== undefined) return null;
    const progress: EvalTaskProgress[] = [];
    for (const entry of tasks) {
      const task = parseTaskProgress(entry);
      if (task === null || taskRepeated(progress, task)) return null;
      progress.push(task);
    }
    return { ...header, state, tasks: progress };
  }
  if (
    (state !== "completed" &&
      state !== "failed" &&
      state !== "cancelled" &&
      state !== "indeterminate") ||
    !isNonNegativeInteger(settledAt)
  )
    return null;
  const results: EvalTaskResult[] = [];
  for (const entry of tasks) {
    const task = parseEvalTaskResult(entry);
    if (task === null || taskRepeated(results, task)) return null;
    results.push(task);
  }
  // The state is what the outcomes say, so a stored result cannot claim more.
  return settledEvalRunState(
    results.map((task) => task.outcome.kind),
    state === "cancelled",
  ) === state
    ? { ...header, state, settledAt, tasks: results }
    : null;
}

export function isSettledEvalRun(run: EvalRunView): run is EvalRunResult {
  return run.state !== "pending" && run.state !== "running";
}

export function parseEvalRunResult(raw: unknown): EvalRunResult | null {
  const run = parseEvalRunView(raw);
  return run !== null && isSettledEvalRun(run) ? run : null;
}

export function parseEvalRevisionRef(raw: unknown): EvalRevisionRef | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["evalId", "revision"]) &&
    isReviewedRecordId(raw.evalId) &&
    isPositiveInteger(raw.revision)
    ? { evalId: raw.evalId, revision: raw.revision }
    : null;
}

export function parseEvalTaskOutcome(raw: unknown): EvalTaskOutcome | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "assessed": {
      if (
        !hasExactKeys(raw, ["kind", "verdict", "criteria", "observation"]) ||
        (raw.verdict !== "passed" && raw.verdict !== "failed") ||
        !Array.isArray(raw.criteria) ||
        raw.criteria.length === 0 ||
        raw.criteria.length > MAX_EVAL_CRITERIA
      )
        return null;
      const criteria: EvalCriterionOutcome[] = [];
      for (const entry of raw.criteria) {
        if (
          !isRecord(entry) ||
          !hasExactKeys(entry, ["criterionId", "met"]) ||
          !isReviewedRecordId(entry.criterionId) ||
          typeof entry.met !== "boolean"
        )
          return null;
        criteria.push({ criterionId: entry.criterionId, met: entry.met });
      }
      const observation = parseObservation(raw.observation);
      // A verdict is what its criteria say. One unmet criterion fails it.
      return observation === null ||
        (raw.verdict === "passed") !==
          criteria.every((criterion) => criterion.met)
        ? null
        : { kind: "assessed", verdict: raw.verdict, criteria, observation };
    }
    case "unavailable":
      return hasExactKeys(raw, ["kind", "reason"]) &&
        (raw.reason === "authority_unavailable" ||
          raw.reason === "budget_exhausted" ||
          raw.reason === "agent_unavailable" ||
          raw.reason === "fixture_unavailable" ||
          raw.reason === "memory_unavailable")
        ? { kind: "unavailable", reason: raw.reason }
        : null;
    case "failed":
    case "indeterminate":
      return hasExactKeys(raw, ["kind", "code"]) &&
        typeof raw.code === "string" &&
        /^[a-z0-9_:.-]{1,120}$/u.test(raw.code)
        ? { kind: raw.kind, code: raw.code }
        : null;
    case "cancelled":
      return hasExactKeys(raw, ["kind"]) ? { kind: "cancelled" } : null;
    default:
      return null;
  }
}

function parseRunHeader(raw: Record<string, unknown>): EvalRunHeader | null {
  if (
    !hasExactKeys(raw, [
      "runId",
      "eval",
      "caseId",
      "startedByPersonId",
      "startedAt",
      "routes",
      "configurations",
      "scorer",
    ]) ||
    !isReviewedRecordId(raw.runId) ||
    !isReviewedRecordId(raw.caseId) ||
    !isReviewedRecordId(raw.startedByPersonId) ||
    !isNonNegativeInteger(raw.startedAt) ||
    !isReviewedRecordId(raw.scorer)
  )
    return null;
  const target = parseEvalRevisionRef(raw.eval);
  const routes = parseEvalRoutes(raw.routes);
  const configurations = parseEvalConfigurations(raw.configurations);
  return target === null || routes === null || configurations === null
    ? null
    : {
        runId: raw.runId,
        eval: target,
        caseId: raw.caseId,
        startedByPersonId: raw.startedByPersonId,
        startedAt: raw.startedAt,
        routes,
        configurations,
        scorer: raw.scorer,
      };
}

export function parseEvalRoutes(raw: unknown): readonly EvalRoute[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVAL_ROUTES)
    return null;
  const routes: EvalRoute[] = [];
  for (const entry of raw) {
    const route = EVAL_ROUTES.find((known) => known === entry);
    if (route === undefined || routes.includes(route)) return null;
    routes.push(route);
  }
  return routes;
}

export function parseEvalConfigurations(
  raw: unknown,
): readonly EvalConfiguration[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2) return null;
  const configurations: EvalConfiguration[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      configurations.some((earlier) => earlier.kind === entry.kind)
    )
      return null;
    if (entry.kind === "current") {
      if (!hasExactKeys(entry, ["kind"])) return null;
      configurations.push({ kind: "current" });
      continue;
    }
    const memory = entry.memory;
    if (
      entry.kind !== "candidate" ||
      !hasExactKeys(entry, ["kind", "memory"]) ||
      !isRecord(memory) ||
      !hasExactKeys(memory, ["memoryId", "revision"]) ||
      !isReviewedRecordId(memory.memoryId) ||
      !isPositiveInteger(memory.revision)
    )
      return null;
    configurations.push({
      kind: "candidate",
      memory: { memoryId: memory.memoryId, revision: memory.revision },
    });
  }
  return configurations;
}

function parseTaskKey(raw: Record<string, unknown>): EvalTaskKey | null {
  const route = EVAL_ROUTES.find((known) => known === raw.route);
  return isReviewedRecordId(raw.scenarioId) &&
    (raw.configuration === "current" || raw.configuration === "candidate") &&
    route !== undefined &&
    raw.taskId === evalTaskId(raw.scenarioId, raw.configuration, route)
    ? {
        taskId: raw.taskId,
        scenarioId: raw.scenarioId,
        configuration: raw.configuration,
        route,
      }
    : null;
}

function parseTaskProgress(raw: unknown): EvalTaskProgress | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "taskId",
      "scenarioId",
      "configuration",
      "route",
      "state",
    ]) ||
    (raw.state !== "pending" &&
      raw.state !== "running" &&
      raw.state !== "settled")
  )
    return null;
  const key = parseTaskKey(raw);
  return key === null ? null : { ...key, state: raw.state };
}

export function parseEvalTaskResult(raw: unknown): EvalTaskResult | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "taskId",
      "scenarioId",
      "configuration",
      "route",
      "outcome",
      "execution",
      "pins",
      "totalTokens",
    ]) ||
    (raw.totalTokens !== null && !isNonNegativeInteger(raw.totalTokens))
  )
    return null;
  const key = parseTaskKey(raw);
  const outcome = parseEvalTaskOutcome(raw.outcome);
  const execution =
    raw.execution === null ? null : parseExecution(raw.execution);
  const pins = raw.pins === null ? null : parsePins(raw.pins);
  return key === null ||
    outcome === null ||
    (raw.execution !== null && execution === null) ||
    (raw.pins !== null && pins === null)
    ? null
    : { ...key, outcome, execution, pins, totalTokens: raw.totalTokens };
}

function parseExecution(raw: unknown): EvalTaskExecution | null {
  return isRecord(raw) &&
    hasExactKeys(raw, ["assignmentId", "sessionId", "turnId"]) &&
    isReviewedRecordId(raw.assignmentId) &&
    isReviewedRecordId(raw.sessionId) &&
    isReviewedRecordId(raw.turnId)
    ? {
        assignmentId: raw.assignmentId,
        sessionId: raw.sessionId,
        turnId: raw.turnId,
      }
    : null;
}

function parsePins(raw: unknown): EvalTaskPins | null {
  return isRecord(raw) &&
    hasExactKeys(raw, [
      "model",
      "modelRouteDigest",
      "instructionDigest",
      "toolCatalogDigest",
      "contextBundleDigest",
      "policyVersion",
    ]) &&
    boundedText(raw.model, 200) &&
    digest(raw.modelRouteDigest) &&
    digest(raw.instructionDigest) &&
    digest(raw.toolCatalogDigest) &&
    digest(raw.contextBundleDigest) &&
    isNonNegativeInteger(raw.policyVersion)
    ? {
        model: raw.model,
        modelRouteDigest: raw.modelRouteDigest,
        instructionDigest: raw.instructionDigest,
        toolCatalogDigest: raw.toolCatalogDigest,
        contextBundleDigest: raw.contextBundleDigest,
        policyVersion: raw.policyVersion,
      }
    : null;
}

function parseObservation(raw: unknown): EvalObservation | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["outcome", "reply", "memory"]) ||
    (raw.outcome !== "reply_now" &&
      raw.outcome !== "approval_required" &&
      raw.outcome !== "no_reply") ||
    // A reply exists exactly when the agent chose to write one.
    (raw.reply === null) !== (raw.outcome === "no_reply") ||
    (raw.reply !== null && !boundedText(raw.reply, MAX_EVAL_REPLY_LENGTH)) ||
    !Array.isArray(raw.memory) ||
    raw.memory.length > 64
  )
    return null;
  const memory: MemoryRevisionRef[] = [];
  for (const entry of raw.memory) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["memoryId", "revision"]) ||
      !isReviewedRecordId(entry.memoryId) ||
      !isPositiveInteger(entry.revision)
    )
      return null;
    memory.push({ memoryId: entry.memoryId, revision: entry.revision });
  }
  return { outcome: raw.outcome, reply: raw.reply, memory };
}

function taskRepeated(
  earlier: readonly EvalTaskKey[],
  task: EvalTaskKey,
): boolean {
  return earlier.some((other) => other.taskId === task.taskId);
}

function digest(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw);
}
