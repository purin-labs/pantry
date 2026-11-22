import {
  GOAL_COMMAND_HELP,
  goalSnapshotMessage,
  goalCommandFailureMessage,
  type SlackGoalCommand,
} from "../../slack/goal-command";
import { readCaseGoal, applyCaseGoalCommand } from "../case-goals";
import type {
  CaseAssignment,
  CaseAssignmentLifecycle,
  CaseBinding,
  CaseContent,
  RequestAuthority,
} from "@purin-labs/contracts";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { FlowBinding, FlowLabel } from "@purin-labs/authority/policy/index";
import { sourceReaderForAuthority } from "@purin-labs/authority/policy/information-flow/source-readers";
import type { Variant } from "@purin-labs/type-utils";
import { isNonBlankString, isRecord, parseJsonOrNull } from "@purin-labs/std";
import {
  acceptedProposalBelongsTo,
  assignmentMatches,
  caseContentPreview,
  inspectStoredCase,
  readAssignmentLifecycle,
  readBindings,
  readMeta,
  readOutputLifecycle,
  replayAuthorityForFlowBinding,
  triggerAuthorityMatchesSource,
} from "./context-source";
import { machineTransition } from "@purin-labs/std/state-machine";
import { writeActorTransition } from "@purin-labs/actor-runtime/actors/lifecycle/state-transition";
import { CASE_ASSIGNMENT_MACHINE } from "./assignment.machine";
import {
  appendJournal,
  buildCaseOutput,
  persistPendingOutput,
} from "./outputs";
import { acceptCaseProposal } from "./proposals";
import {
  type GoalMessage,
  equal,
  integer,
  invalid,
  isOpen,
  parseCaseContent,
  parseCaseTrigger,
  parseLifecycle,
} from "./record-parsers";
import {
  type AbandonAssignmentRequest,
  type AcceptProposalRequest,
  type BeginAssignmentRequest,
  type CaseEnsureRequest,
  type CaseResult,
  type CaseTriggerRecord,
  type JsonRow,
  PARTITION_INDEPENDENT_REPLAY_AUTHORITY,
  type PrepareOngoingCaseTurnRequest,
  type RawCaseOutput,
  type RawCaseProposalAcceptance,
  type RawCaseSnapshot,
  type SettleAssignmentRequest,
} from "./types";

export function retainContextProjection(
  sql: SqlStorage,
  entryId: string,
): void {
  sql.exec(
    "INSERT OR IGNORE INTO case_context_projection_outbox (entry_id) VALUES (?)",
    entryId,
  );
}

export function ensureCase(
  sql: SqlStorage,
  input: CaseEnsureRequest,
): CaseResult<{ readonly kind: "ensured"; readonly revision: number }> {
  const current = readMeta(sql);
  if (current !== null) {
    return current.organisation_id === input.identity.organisationId &&
      current.case_id === input.identity.caseId &&
      current.purpose === input.purpose &&
      current.workspace_revision === input.workspaceRevision
      ? { ok: true, value: { kind: "ensured", revision: current.revision } }
      : invalid("case_identity_conflict");
  }
  sql.exec(
    `INSERT INTO case_meta (singleton, organisation_id, case_id, purpose, workspace_revision, revision, lifecycle_json)
    VALUES (1, ?, ?, ?, ?, 0, ?)`,
    input.identity.organisationId,
    input.identity.caseId,
    input.purpose,
    input.workspaceRevision,
    JSON.stringify(input.lifecycle),
  );
  return { ok: true, value: { kind: "ensured", revision: 0 } };
}

export function acceptCaseTrigger(
  sql: SqlStorage,
  trigger: CaseTriggerRecord,
  contentDigest: string,
  inputLabel: FlowLabel,
): CaseResult<{
  readonly kind: "accepted" | "duplicate";
  readonly revision: number;
}> {
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.case_id !== trigger.caseId ||
    trigger.requestAuthority.organisationId !== meta.organisation_id ||
    !triggerAuthorityMatchesSource(trigger)
  )
    return invalid("case_identity_mismatch");
  const payload = JSON.stringify(trigger);
  const existing =
    sql
      .exec<JsonRow>(
        "SELECT payload FROM case_trigger WHERE trigger_id = ?",
        trigger.triggerId,
      )
      .toArray()[0] ?? null;
  if (existing !== null) {
    const parsed = parseCaseTrigger(JSON.parse(existing.payload));
    if (parsed === null) return invalid("case_trigger_conflict");
    // Retries retain the first acceptance time and the first title for the
    // same trigger, so a trigger stored before titles existed still matches.
    const retried: CaseTriggerRecord = {
      triggerId: trigger.triggerId,
      caseId: trigger.caseId,
      source: trigger.source,
      requestAuthority: trigger.requestAuthority,
      content: trigger.content,
      acceptedAt: parsed.acceptedAt,
      attachments: trigger.attachments,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
    };
    if (!equal(parsed, retried)) return invalid("case_trigger_conflict");
    retainContextProjection(sql, `trigger:${trigger.triggerId}`);
    return { ok: true, value: { kind: "duplicate", revision: meta.revision } };
  }
  if (!isOpen(meta.lifecycle_json)) {
    const lifecycle = parseLifecycle(meta.lifecycle_json);
    return invalid(
      lifecycle?.kind === "waiting" && lifecycle.wait.kind === "approval"
        ? "case_waiting_for_approval"
        : "case_not_open",
    );
  }
  const next = meta.revision + 1;
  sql.exec(
    "INSERT INTO case_trigger (trigger_id, payload) VALUES (?, ?)",
    trigger.triggerId,
    payload,
  );
  appendJournal(
    sql,
    `trigger:${trigger.triggerId}`,
    trigger.content,
    contentDigest,
    trigger.requestAuthority,
    sourceReaderForAuthority(trigger.requestAuthority),
    inputLabel,
    PARTITION_INDEPENDENT_REPLAY_AUTHORITY,
    trigger.acceptedAt,
  );
  retainContextProjection(sql, `trigger:${trigger.triggerId}`);
  sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  return { ok: true, value: { kind: "accepted", revision: next } };
}

type CaseSteeringInput = Readonly<{
  caseId: string;
  assignmentId: string;
  inputId: string;
  /** The journal entry of the turn's trigger, whose label the entry copies. */
  triggerEntryId: string;
  content: Variant<CaseContent, "user_message">;
  requestAuthority: RequestAuthority;
  acceptedAt: number;
}>;

export function parseCaseSteeringInput(
  value: unknown,
): CaseSteeringInput | null {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.caseId) ||
    !isNonBlankString(value.assignmentId) ||
    !isNonBlankString(value.inputId) ||
    !isNonBlankString(value.triggerEntryId) ||
    !value.triggerEntryId.startsWith("trigger:") ||
    !integer(value.acceptedAt)
  )
    return null;
  const content = parseCaseContent(value.content);
  const authority = parseStoredRequestAuthority(value.requestAuthority);
  return content?.kind !== "user_message" || !authority.ok
    ? null
    : {
        caseId: value.caseId,
        assignmentId: value.assignmentId,
        inputId: value.inputId,
        triggerEntryId: value.triggerEntryId,
        content,
        requestAuthority: authority.value.requestAuthority,
        acceptedAt: value.acceptedAt,
      };
}

export function acceptCaseSteeringInput(
  sql: SqlStorage,
  input: CaseSteeringInput,
  contentDigest: string,
): CaseResult<{ readonly kind: "accepted" | "duplicate" }> {
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.case_id !== input.caseId ||
    meta.organisation_id !== input.requestAuthority.organisationId
  )
    return invalid("case_identity_mismatch");
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");
  if (readAssignmentLifecycle(sql, input.assignmentId) === null)
    return invalid("case_assignment_missing");
  const entryId = `steer:${input.inputId}`;
  const existing = sql
    .exec<Record<string, SqlStorageValue> & { digest: string }>(
      "SELECT digest FROM case_journal WHERE entry_id = ?",
      entryId,
    )
    .toArray()[0];
  if (existing !== undefined)
    return existing.digest === contentDigest
      ? { ok: true, value: { kind: "duplicate" } }
      : invalid("case_steering_conflict");
  const trigger = sql
    .exec<Record<string, SqlStorageValue> & { request_authority_json: string }>(
      "SELECT request_authority_json FROM case_journal WHERE entry_id = ?",
      input.triggerEntryId,
    )
    .toArray()[0];
  const triggerAuthority =
    trigger === undefined
      ? null
      : parseStoredRequestAuthority(
          parseJsonOrNull(trigger.request_authority_json),
        );
  if (
    triggerAuthority === null ||
    !triggerAuthority.ok ||
    !equal(triggerAuthority.value.requestAuthority, input.requestAuthority)
  )
    return invalid("case_steering_requester_mismatch");
  sql.exec(
    `INSERT INTO case_journal (
       entry_id, digest, preview, payload, request_authority_json,
       visibility_json, visibility_key, flow_label_json, authority_scope_json,
       accepted_at
     )
     SELECT ?, ?, ?, ?, request_authority_json, visibility_json,
            visibility_key, flow_label_json, authority_scope_json, ?
     FROM case_journal WHERE entry_id = ?`,
    entryId,
    contentDigest,
    caseContentPreview(input.content).slice(0, 512),
    JSON.stringify(input.content),
    input.acceptedAt,
    input.triggerEntryId,
  );
  retainContextProjection(sql, entryId);
  return { ok: true, value: { kind: "accepted" } };
}

export function attachCaseBinding(
  sql: SqlStorage,
  binding: CaseBinding,
): CaseResult<{
  readonly kind: "attached" | "already_attached";
  readonly revision: number;
}> {
  const meta = readMeta(sql);
  if (meta === null || meta.case_id !== binding.caseId)
    return invalid("case_identity_mismatch");
  const payload = JSON.stringify(binding);
  const existing =
    sql
      .exec<JsonRow>(
        "SELECT payload FROM case_binding WHERE binding_id = ?",
        binding.bindingId,
      )
      .toArray()[0] ?? null;
  if (existing !== null)
    return existing.payload === payload
      ? {
          ok: true,
          value: { kind: "already_attached", revision: meta.revision },
        }
      : invalid("case_binding_conflict");
  sql.exec(
    "INSERT INTO case_binding (binding_id, payload) VALUES (?, ?)",
    binding.bindingId,
    payload,
  );
  return { ok: true, value: { kind: "attached", revision: meta.revision } };
}

export function prepareOngoingCaseTurn(
  sql: SqlStorage,
  input: PrepareOngoingCaseTurnRequest,
  contentDigest: string,
  inputLabel: FlowLabel,
): CaseResult<RawCaseSnapshot> {
  const current = inspectStoredCase(sql);
  if (!current.ok) {
    if (current.error.code !== "case_missing") return current;
    const ensured = ensureCase(sql, input.ensure);
    if (!ensured.ok) return ensured;
  } else if (
    current.value.identity.organisationId !==
      input.ensure.identity.organisationId ||
    current.value.identity.caseId !== input.ensure.identity.caseId
  ) {
    return invalid("case_identity_conflict");
  }
  const triggered = acceptCaseTrigger(
    sql,
    input.trigger,
    contentDigest,
    inputLabel,
  );
  if (!triggered.ok) return triggered;
  const bound = attachCaseBinding(sql, input.binding);
  if (!bound.ok) return bound;
  return inspectStoredCase(sql);
}

export function assignCaseSession(
  sql: SqlStorage,
  assignment: CaseAssignment,
  assignedAt: number,
): CaseResult<{
  readonly kind: "assigned" | "already_assigned";
  readonly revision: number;
}> {
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.case_id !== assignment.caseId ||
    assignment.caseRevision !== meta.revision ||
    assignment.authorityPartition.key.organisationId !== meta.organisation_id ||
    assignment.context.caseId !== assignment.caseId ||
    assignment.context.revision !== meta.revision ||
    assignment.context.workspaceRevision !== meta.workspace_revision
  )
    return invalid("case_assignment_mismatch");
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");
  const lifecycle: CaseAssignmentLifecycle = { kind: "assigned", assignment };
  const payload = JSON.stringify(lifecycle);
  const existing = readAssignmentLifecycle(sql, assignment.assignmentId);
  if (existing !== null)
    return JSON.stringify(existing) === payload
      ? {
          ok: true,
          value: { kind: "already_assigned", revision: meta.revision },
        }
      : invalid("case_assignment_conflict");
  sql.exec(
    "INSERT INTO case_assignment (assignment_id, session_id, lifecycle_json, assigned_at) VALUES (?, ?, ?, ?)",
    assignment.assignmentId,
    assignment.sessionId,
    payload,
    assignedAt,
  );
  return { ok: true, value: { kind: "assigned", revision: meta.revision } };
}

export function beginCaseAssignment(
  sql: SqlStorage,
  input: BeginAssignmentRequest,
): CaseResult<{
  readonly kind: "running" | "already_running";
  readonly lifecycle: CaseAssignmentLifecycle;
}> {
  const lifecycle = readAssignmentLifecycle(sql, input.assignmentId);
  if (lifecycle === null) return invalid("case_assignment_missing");
  const assignment = lifecycle.assignment;
  if (
    !assignmentMatches(
      assignment,
      input.caseId,
      input.assignmentId,
      input.sessionId,
      input.expectedCaseRevision,
    ) ||
    input.start.sessionId !== input.sessionId
  )
    return invalid("case_assignment_mismatch");
  if (lifecycle.kind === "settled") return invalid("case_assignment_settled");
  if (lifecycle.kind === "running") {
    return equal(lifecycle.start, input.start)
      ? { ok: true, value: { kind: "already_running", lifecycle } }
      : invalid("case_assignment_start_conflict");
  }
  const running: CaseAssignmentLifecycle = {
    kind: "running",
    assignment,
    start: input.start,
  };
  if (!writeAssignmentMove(sql, "assigned", running))
    return invalid("case_assignment_moved");
  return { ok: true, value: { kind: "running", lifecycle: running } };
}

export function settleCaseAssignment(
  sql: SqlStorage,
  input: SettleAssignmentRequest,
): CaseResult<{
  readonly kind: "settled" | "already_settled";
  readonly lifecycle: CaseAssignmentLifecycle;
}> {
  const lifecycle = readAssignmentLifecycle(sql, input.assignmentId);
  if (lifecycle === null) return invalid("case_assignment_missing");
  const assignment = lifecycle.assignment;
  if (
    !assignmentMatches(
      assignment,
      input.caseId,
      input.assignmentId,
      input.sessionId,
      input.expectedCaseRevision,
    )
  ) {
    return invalid("case_assignment_mismatch");
  }
  if (lifecycle.kind === "assigned")
    return invalid("case_assignment_not_running");
  // Only the abandon move ends an assignment as abandoned.
  if (input.disposition.kind === "abandoned")
    return invalid("case_assignment_settlement_invalid");
  if (lifecycle.start.startId !== input.expectedStartId)
    return invalid("case_assignment_start_mismatch");
  if (lifecycle.kind === "settled") {
    return equal(lifecycle.disposition, input.disposition)
      ? { ok: true, value: { kind: "already_settled", lifecycle } }
      : invalid("case_assignment_settlement_conflict");
  }
  if (
    input.disposition.kind === "completed" &&
    !acceptedProposalBelongsTo(sql, input.disposition.proposalId, assignment)
  ) {
    return invalid("case_assignment_proposal_unaccepted");
  }
  const settled: CaseAssignmentLifecycle = {
    kind: "settled",
    assignment,
    start: lifecycle.start,
    disposition: input.disposition,
  };
  if (!writeAssignmentMove(sql, "running", settled))
    return invalid("case_assignment_moved");
  return { ok: true, value: { kind: "settled", lifecycle: settled } };
}

/**
 * Ends an assignment that no live turn will finish (Refactor 15, refactor
 * 9). The caller brings the Session's proof that it runs no turn, read after
 * the assignment began. The assignment must also be older than the caller's
 * wait. A caller that holds the claim of the work waits for nothing; another
 * waits, so a delivery that is between its assignment and its turn's start
 * keeps its assignment. Only the state that the caller read is moved.
 */
export function abandonCaseAssignment(
  sql: SqlStorage,
  input: AbandonAssignmentRequest,
): CaseResult<{
  readonly kind: "abandoned" | "already_abandoned";
  readonly lifecycle: CaseAssignmentLifecycle;
}> {
  const lifecycle = readAssignmentLifecycle(sql, input.assignmentId);
  if (lifecycle === null) return invalid("case_assignment_missing");
  const assignment = lifecycle.assignment;
  if (
    !assignmentMatches(
      assignment,
      input.caseId,
      input.assignmentId,
      input.sessionId,
      input.expectedCaseRevision,
    ) ||
    input.proof.sessionId !== assignment.sessionId
  )
    return invalid("case_assignment_mismatch");
  if (lifecycle.kind === "settled")
    return lifecycle.disposition.kind === "abandoned"
      ? { ok: true, value: { kind: "already_abandoned", lifecycle } }
      : invalid("case_assignment_settled");
  if (
    lifecycle.kind !== input.expectedState ||
    (lifecycle.kind === "running" &&
      lifecycle.start.startId !== input.expectedStartId)
  )
    return invalid("case_assignment_moved");
  const since =
    lifecycle.kind === "running"
      ? Number(lifecycle.start.acceptedAt)
      : readAssignedAt(sql, input.assignmentId);
  if (input.abandonedAt < since + input.minimumAgeMs)
    return invalid("case_assignment_too_recent");
  const move = machineTransition(
    CASE_ASSIGNMENT_MACHINE,
    lifecycle.kind,
    "abandon",
    { session_quiescent: () => input.proof.inspectedAt >= since },
  );
  if (!move.allowed) return invalid(move.refusal.code);
  const settled: CaseAssignmentLifecycle = {
    kind: "settled",
    assignment,
    start:
      lifecycle.kind === "running"
        ? lifecycle.start
        : {
            startId: `${ABANDONED_START_PREFIX}${assignment.assignmentId}`,
            sessionId: assignment.sessionId,
            acceptedAt: input.abandonedAt,
          },
    disposition: {
      kind: "abandoned",
      reason:
        lifecycle.kind === "running" ? "session_quiescent" : "never_started",
      settledAt: input.abandonedAt,
    },
  };
  if (!writeAssignmentMove(sql, lifecycle.kind, settled))
    return invalid("case_assignment_moved");
  return { ok: true, value: { kind: "abandoned", lifecycle: settled } };
}

/** The start that an abandon move writes for an assignment that never began. */
export const ABANDONED_START_PREFIX = "start_abandoned_";

/** When the Case made the assignment. */
function readAssignedAt(sql: SqlStorage, assignmentId: string): number {
  return sql
    .exec<{ assigned_at: number }>(
      "SELECT assigned_at FROM case_assignment WHERE assignment_id = ?",
      assignmentId,
    )
    .one().assigned_at;
}

/** When each active assignment began, or was made if it has not begun. */
export function activeAssignmentTimes(sql: SqlStorage): readonly number[] {
  return sql
    .exec<{
      started_at: number | null;
      assigned_at: number;
    }>(
      `SELECT json_extract(lifecycle_json, '$.start.acceptedAt') AS started_at,
              assigned_at
       FROM case_assignment
       WHERE json_extract(lifecycle_json, '$.kind') IN ('assigned', 'running')`,
    )
    .toArray()
    .map(function assignmentTime(row) {
      return row.started_at ?? row.assigned_at;
    });
}

/** One move of `CASE_ASSIGNMENT_MACHINE`, as a compare-and-set on its state. */
function writeAssignmentMove(
  sql: SqlStorage,
  from: "assigned" | "running",
  lifecycle: CaseAssignmentLifecycle,
): boolean {
  return writeActorTransition(sql, CASE_ASSIGNMENT_MACHINE.store, {
    key: lifecycle.assignment.assignmentId,
    from,
    value: JSON.stringify(lifecycle),
  });
}

export function acceptCaseProposalWithProjections(
  sql: SqlStorage,
  input: AcceptProposalRequest,
  entryDigests: readonly string[],
): CaseResult<RawCaseProposalAcceptance> {
  const result = acceptCaseProposal(sql, input, entryDigests);
  if (result.ok && result.value.disposition.kind === "accepted") {
    for (const entry of input.proposal.entries)
      retainContextProjection(sql, entry.entryId);
  }
  return result;
}

export function acceptGoalMessage(
  sql: SqlStorage,
  input: GoalMessage,
  command: Exclude<SlackGoalCommand, { kind: "ordinary" }>,
  digest: string,
  contentDigest: string,
  binding: FlowBinding,
): CaseResult<RawCaseOutput> {
  const meta = readMeta(sql);
  if (
    meta === null ||
    meta.organisation_id !== input.organisationId ||
    meta.case_id !== input.caseId
  )
    return invalid("case_identity_mismatch");
  const outputId = `output_goal_${input.commandId}`;
  const existing = readOutputLifecycle(sql, outputId);
  if (existing !== null) {
    return existing.output.source.kind === "operator_command" &&
      existing.output.source.requestDigest === digest
      ? { ok: true, value: existing.output }
      : invalid("goal_command_conflict");
  }
  const bindings = readBindings(sql);
  if (bindings === null || bindings.length !== 1)
    return invalid("case_output_binding_invalid");
  if (!isOpen(meta.lifecycle_json)) return invalid("case_not_open");
  const current = readCaseGoal(sql, input);
  if (!current.ok) return current;
  let text: string;
  if (
    input.requestAuthority.role !== "owner" &&
    input.requestAuthority.role !== "admin"
  ) {
    text = "A workspace owner or admin must manage goals.";
  } else if (command.kind === "help") {
    text = GOAL_COMMAND_HELP;
  } else if (command.kind === "status") {
    text = goalSnapshotMessage(current.value);
  } else if (
    (command.command.kind === "set" || command.command.kind === "resume") &&
    input.support !== "pi"
  ) {
    text =
      "Inference is unavailable. Restore the connection before setting or resuming a goal.";
  } else {
    const changed = applyCaseGoalCommand(sql, {
      organisationId: input.organisationId,
      caseId: input.caseId,
      commandId: input.commandId,
      expectedRevision: current.value.revision,
      command: command.command,
    });
    text = changed.ok
      ? goalSnapshotMessage(changed.value)
      : goalCommandFailureMessage(changed.error.code);
    if (changed.ok && command.command.kind === "resume")
      text += " Send another message to continue.";
  }
  const entryId = `goal_command:${input.commandId}`;
  const next = meta.revision + 1;
  const output = buildCaseOutput(sql, {
    outputId,
    source: {
      kind: "operator_command",
      commandId: input.commandId,
      requestDigest: digest,
    },
    entryId,
    caseId: input.caseId,
    content: { kind: "text", text },
    revision: next,
    addressedAt: input.acceptedAt,
    deliveryId: `delivery_goal_${input.commandId}`,
    idempotencyKey: `goal_reply_${input.commandId}`,
    flowBinding: binding.toJSON(),
  });
  if (!output.ok || output.value === null)
    throw new Error("case_output_binding_invalid");
  appendJournal(
    sql,
    entryId,
    { kind: "text", text: input.text },
    contentDigest,
    input.requestAuthority,
    sourceReaderForAuthority(input.requestAuthority),
    binding.flowLabel,
    replayAuthorityForFlowBinding(binding),
    input.acceptedAt,
  );
  sql.exec("UPDATE case_meta SET revision = ? WHERE singleton = 1", next);
  persistPendingOutput(sql, output.value);
  return { ok: true, value: output.value };
}
