import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import type {
  CaseExecutionToolAuthority,
  CaseExecutionTurnMemory,
} from "@purin-labs/control-api";
import {
  ExecutionLabelTable,
  MAX_EXECUTION_STORED_TEXT,
  MAX_EXECUTION_TOOL_OPERATIONS,
  MAX_EXECUTION_TURNS,
  type CaseExecutionSessionRecords,
  type CaseExecutionStoredContent,
  type SessionAttemptRecord,
  type SessionContextTurnRecord,
  type SessionExecutionContentTarget,
  type SessionToolOperationRecord,
  type SessionTurnRecord,
} from "../case-execution/records";

type Row = Record<string, SqlStorageValue>;

const MAX_JOURNAL_ROWS = 2_000;
const FAILURE_CODE = /^[a-z0-9_.:-]{1,120}$/u;
/** One run of a turn that keeps no turn record: `<turn>#<bundle digest>`. */
const CONTEXT_RUN = /^(.+)#[0-9a-f]{64}$/u;
const TOOL_AUTHORITIES: readonly CaseExecutionToolAuthority[] = [
  "read",
  "provider_effect",
  "surface_effect",
  "code_execution",
  "workspace_revision",
];

/**
 * The execution records of this Session, as its tables hold them.
 *
 * A turn is a row of the turn stream. The assignment it serves is the one
 * its accepted input names in the journal. An attempt is one runtime the
 * journal records for a turn: an activation or a resumption, with the
 * runtime generation it names. A recovery that fences that generation ends
 * the attempt as interrupted, at the time the recovery was accepted. No other
 * end has a time here: the journal's time for a completion is the one its
 * caller set when the turn was accepted, and the turn stream copies it. A
 * tool operation is a tool call of the
 * accepted history, joined to its result by the call identity. Each history
 * entry names the runtime generation that accepted it, so a call and its
 * result each name their attempt. An entry from before that record names
 * none.
 *
 * The Memory result of a turn is the outcome its accepted context records.
 * Only its kind, its reason and the count of its revisions leave this read.
 * A mail turn and an Eval turn keep no turn record. Such a turn is known by
 * the context its Session records for each run of it, and it is read from
 * the latest of those, with the stored label of each Memory revision in it.
 * A context row that does not have the stored shape is left out.
 */
export function readSessionExecutionRecords(
  sql: SqlStorage,
  sessionId: string,
): CaseExecutionSessionRecords {
  const labels = new ExecutionLabelTable();
  let truncated = false;
  const parent = sql
    .exec<Row>("SELECT assignment_id FROM session_case_parent LIMIT 1")
    .toArray()[0];

  const journal = sql
    .exec<Row>(
      `SELECT sequence,
         json_extract(envelope, '$.acceptedAt') AS accepted_at,
         json_extract(envelope, '$.body.kind') AS kind,
         json_extract(envelope, '$.body.input.assignmentId') AS assignment_id,
         json_extract(envelope, '$.body.state.turnId') AS state_turn,
         json_extract(envelope, '$.body.state.runtimeLease.generation') AS generation,
         json_extract(envelope, '$.body.state.fencedRuntime.generation') AS fenced,
         json_extract(envelope, '$.body.state.activeTurn.state.identity.turnId') AS active_turn
       FROM actor_journal
       WHERE json_extract(envelope, '$.body.kind') IN (
         'input_accepted', 'runtime_activated', 'execution_resumed',
         'execution_recovery_started', 'checkpointing_started',
         'cancellation_started', 'session_quarantined', 'session_terminated'
       )
       ORDER BY stream_id, sequence
       LIMIT ?`,
      MAX_JOURNAL_ROWS + 1,
    )
    .toArray();
  if (journal.length > MAX_JOURNAL_ROWS) {
    truncated = true;
    journal.length = MAX_JOURNAL_ROWS;
  }
  const assignmentOfTurn = new Map<string, string>();
  const attempts: SessionAttemptRecord[] = [];
  let current: number | null = null;
  const end = (index: number | null, interruptedAt: number | null) => {
    if (index === null) return;
    const attempt = attempts[index];
    if (attempt === undefined || attempt.state !== "running") return;
    attempts[index] = {
      ...attempt,
      state: interruptedAt === null ? "ended" : "interrupted",
      interruptedAt,
    };
  };
  for (const row of journal) {
    const at = isNonNegativeInteger(row.accepted_at) ? row.accepted_at : null;
    if (at === null) continue;
    switch (row.kind) {
      case "input_accepted":
        if (
          typeof row.state_turn === "string" &&
          typeof row.assignment_id === "string"
        )
          assignmentOfTurn.set(row.state_turn, row.assignment_id);
        break;
      case "runtime_activated":
      case "execution_resumed":
        if (
          typeof row.active_turn === "string" &&
          isNonNegativeInteger(row.generation)
        ) {
          // A new runtime for the same Session ends the one before it.
          end(current, null);
          attempts.push({
            turnId: row.active_turn,
            generation: row.generation,
            state: "running",
            startedAt: at,
            interruptedAt: null,
          });
          current = attempts.length - 1;
        }
        break;
      case "execution_recovery_started": {
        // The recovery names the runtime it fences by its generation.
        let fenced: number | null = null;
        for (const [index, attempt] of attempts.entries())
          if (attempt.generation === row.fenced && attempt.state === "running")
            fenced = index;
        end(fenced, at);
        if (fenced === current) current = null;
        break;
      }
      case "checkpointing_started":
      case "cancellation_started":
      case "session_quarantined":
      case "session_terminated":
        end(current, null);
        current = null;
        break;
      default:
        break;
    }
  }

  const labelOfTurn = new Map<string, number | null>();
  for (const row of sql
    .exec<Row>(
      `SELECT turn_id, json_extract(binding_json, '$.flowLabel') AS label
       FROM session_information_flow_turn_binding
       WHERE session_id = ? AND turn_id IN (
         SELECT turn_id FROM session_turn_stream
         ORDER BY started_at DESC, turn_id LIMIT ?
       )`,
      sessionId,
      MAX_EXECUTION_TURNS,
    )
    .toArray())
    if (typeof row.turn_id === "string")
      labelOfTurn.set(
        row.turn_id,
        labels.intern(typeof row.label === "string" ? row.label : null),
      );

  const turnRows = sql
    .exec<Row>(
      `SELECT turn_id, state, started_at, error_detail
       FROM session_turn_stream ORDER BY started_at DESC, turn_id LIMIT ?`,
      MAX_EXECUTION_TURNS + 1,
    )
    .toArray();
  if (turnRows.length > MAX_EXECUTION_TURNS) {
    truncated = true;
    turnRows.length = MAX_EXECUTION_TURNS;
  }
  // The accepted context of a turn holds its Memory outcome. A turn with no
  // context row, or with one accepted before Memory admission, records none.
  const memoryOfTurn = new Map<string, CaseExecutionTurnMemory>();
  for (const row of sql
    .exec<Row>(
      `SELECT turn_id,
         CASE WHEN json_type(bundle_json, '$.bundle') = 'object'
           THEN json_extract(bundle_json, '$.bundle.memory')
           ELSE json_extract(bundle_json, '$.memory') END AS memory
       FROM session_turn_context
       WHERE session_id = ? AND turn_id IN (
         SELECT turn_id FROM session_turn_stream
         ORDER BY started_at DESC, turn_id LIMIT ?
       )`,
      sessionId,
      MAX_EXECUTION_TURNS,
    )
    .toArray()) {
    const memory = storedTurnMemory(row.memory);
    if (typeof row.turn_id === "string" && memory !== null)
      memoryOfTurn.set(row.turn_id, memory);
  }
  const turns: SessionTurnRecord[] = turnRows.reverse().flatMap((row) =>
    typeof row.turn_id === "string" &&
    (row.state === "running" ||
      row.state === "complete" ||
      row.state === "failed") &&
    isNonNegativeInteger(row.started_at)
      ? [
          {
            turnId: row.turn_id,
            assignmentId: assignmentOfTurn.get(row.turn_id) ?? null,
            state: row.state,
            startedAt: row.started_at,
            failureCode:
              row.state !== "failed"
                ? null
                : typeof row.error_detail === "string" &&
                    FAILURE_CODE.test(row.error_detail)
                  ? row.error_detail
                  : "turn_failed",
            label: labelOfTurn.get(row.turn_id) ?? null,
            memory: memoryOfTurn.get(row.turn_id) ?? { kind: "unrecorded" },
          },
        ]
      : [],
  );

  // Each run of a turn that keeps no turn record has its own context row.
  // The rows are read newest first, so the first row of a turn is its latest
  // run. A prompt that left out a revision for its byte limit records that
  // beside the context, and the result is then what the prompt carried.
  const runs = sql
    .exec<Row>(
      `SELECT turn_id,
         json_extract(bundle_json, '$.bundle.assignmentId') AS assignment_id,
         json_extract(bundle_json, '$.bundle.assembledAt') AS assembled_at,
         json_extract(bundle_json, '$.bundle.memory') AS memory,
         json_extract(bundle_json, '$.memoryRendering.omittedForBytes') AS omitted,
         json_array_length(bundle_json, '$.memoryRendering.revisions') AS rendered,
         (SELECT json_group_array(json_extract(item.value, '$.inputLabel'))
          FROM json_each(bundle_json, '$.bundle.items') item
          WHERE json_extract(item.value, '$.source.kind') = 'memory') AS labels
       FROM session_turn_context
       WHERE session_id = ? AND substr(turn_id, -65, 1) = '#'
         AND json_type(bundle_json, '$.memoryRendering') = 'object'
       ORDER BY assembled_at DESC, turn_id DESC
       LIMIT ?`,
      sessionId,
      MAX_EXECUTION_TURNS + 1,
    )
    .toArray();
  if (runs.length > MAX_EXECUTION_TURNS) {
    truncated = true;
    runs.length = MAX_EXECUTION_TURNS;
  }
  const latestRun = new Set<string>();
  const contextTurns: SessionContextTurnRecord[] = [];
  for (const row of runs) {
    const turnId =
      typeof row.turn_id === "string"
        ? CONTEXT_RUN.exec(row.turn_id)?.[1]
        : undefined;
    if (turnId === undefined || latestRun.has(turnId)) continue;
    latestRun.add(turnId);
    const accepted = storedTurnMemory(row.memory);
    const stored =
      typeof row.labels === "string" ? parseJsonOrNull(row.labels) : null;
    if (
      typeof row.assignment_id !== "string" ||
      accepted === null ||
      (row.omitted !== 0 && row.omitted !== 1) ||
      !isNonNegativeInteger(row.rendered) ||
      !Array.isArray(stored)
    )
      continue;
    const memoryLabels = stored.flatMap((label: unknown) => {
      const index = isRecord(label)
        ? labels.intern(JSON.stringify(label))
        : null;
      return index === null ? [] : [index];
    });
    // A Memory revision with no stored label has nothing to decide it by.
    if (memoryLabels.length !== stored.length) continue;
    contextTurns.push({
      turnId,
      assignmentId: row.assignment_id,
      memory:
        row.omitted === 1
          ? { kind: "limited", reason: "prompt_bytes", revisions: row.rendered }
          : accepted,
      labels: memoryLabels,
    });
  }
  // Oldest first, as the turns of the turn stream are.
  contextTurns.reverse();

  const results = sql
    .exec<Row>(
      `SELECT turn_id, accepted_at, runtime_generation,
         json_extract(payload, '$.entry.callId') AS call_id,
         json_extract(payload, '$.entry.outcome.kind') AS outcome,
         json_extract(payload, '$.entry.authority.kind') AS authority,
         json_extract(payload, '$.entry.authority.receiptId') AS receipt_id
       FROM session_harness_history
       WHERE session_id = ?
         AND json_extract(payload, '$.entry.kind') = 'tool_result'
       ORDER BY accepted_at, turn_id, sequence
       LIMIT ?`,
      sessionId,
      MAX_EXECUTION_TOOL_OPERATIONS + 1,
    )
    .toArray();
  // A result past the bound is not read. A call with no result here then has
  // an outcome that this read does not know, so the call is left out.
  const resultsCut = results.length > MAX_EXECUTION_TOOL_OPERATIONS;
  if (resultsCut) {
    truncated = true;
    results.length = MAX_EXECUTION_TOOL_OPERATIONS;
  }
  const settled = new Map<string, Row>();
  for (const row of results)
    if (typeof row.turn_id === "string" && typeof row.call_id === "string")
      settled.set(JSON.stringify([row.turn_id, row.call_id]), row);
  const calls = sql
    .exec<Row>(
      `SELECT h.turn_id, h.accepted_at, h.runtime_generation,
         json_extract(c.value, '$.callId') AS call_id,
         json_extract(c.value, '$.tool') AS tool
       FROM session_harness_history h, json_each(h.payload, '$.entry.content') c
       WHERE h.session_id = ?
         AND json_extract(h.payload, '$.entry.kind') = 'assistant_message'
         AND json_extract(c.value, '$.kind') = 'tool_call'
       ORDER BY h.accepted_at, h.turn_id, h.sequence, c.key
       LIMIT ?`,
      sessionId,
      MAX_EXECUTION_TOOL_OPERATIONS + 1,
    )
    .toArray();
  if (calls.length > MAX_EXECUTION_TOOL_OPERATIONS) {
    truncated = true;
    calls.length = MAX_EXECUTION_TOOL_OPERATIONS;
  }
  const toolOperations: SessionToolOperationRecord[] = calls.flatMap((row) => {
    if (
      typeof row.turn_id !== "string" ||
      typeof row.call_id !== "string" ||
      typeof row.tool !== "string" ||
      !isNonNegativeInteger(row.accepted_at)
    )
      return [];
    const result = settled.get(JSON.stringify([row.turn_id, row.call_id]));
    if (result === undefined && resultsCut) return [];
    const outcome = result?.outcome;
    const authority = TOOL_AUTHORITIES.find(
      (entry) => entry === result?.authority,
    );
    return [
      {
        turnId: row.turn_id,
        callId: row.call_id,
        tool: row.tool.slice(0, 200),
        state:
          outcome === "succeeded" || outcome === "failed" ? outcome : "started",
        startedAt: row.accepted_at,
        settledAt:
          result !== undefined && isNonNegativeInteger(result.accepted_at)
            ? result.accepted_at
            : null,
        authority: authority ?? null,
        receiptId:
          typeof result?.receipt_id === "string" ? result.receipt_id : null,
        generation: isPositiveInteger(row.runtime_generation)
          ? row.runtime_generation
          : null,
        settledGeneration: isPositiveInteger(result?.runtime_generation)
          ? result.runtime_generation
          : null,
      },
    ];
  });

  return {
    sessionId,
    assignmentId:
      typeof parent?.assignment_id === "string" ? parent.assignment_id : null,
    labels: labels.labels,
    turns,
    contextTurns,
    attempts,
    toolOperations,
    truncated,
  };
}

/**
 * The arguments and the result of one tool call of this Session. The caller
 * has already decided that its reader may see the turn. Model reasoning is
 * never read here.
 */
export function readSessionExecutionContent(
  sql: SqlStorage,
  sessionId: string,
  target: SessionExecutionContentTarget,
): readonly CaseExecutionStoredContent[] | null {
  const call = sql
    .exec<Row>(
      `SELECT json_extract(c.value, '$.arguments') AS arguments
       FROM session_harness_history h, json_each(h.payload, '$.entry.content') c
       WHERE h.session_id = ? AND h.turn_id = ?
         AND json_extract(h.payload, '$.entry.kind') = 'assistant_message'
         AND json_extract(c.value, '$.kind') = 'tool_call'
         AND json_extract(c.value, '$.callId') = ?
       LIMIT 1`,
      sessionId,
      target.turnId,
      target.callId,
    )
    .toArray()[0];
  if (call === undefined) return null;
  const content: CaseExecutionStoredContent[] = [
    {
      role: "arguments",
      text: bound(
        typeof call.arguments === "string"
          ? call.arguments
          : JSON.stringify(call.arguments ?? null),
      ),
    },
  ];
  const result = sql
    .exec<Row>(
      `SELECT json_extract(payload, '$.entry.outcome.output') AS output
       FROM session_harness_history
       WHERE session_id = ? AND turn_id = ?
         AND json_extract(payload, '$.entry.kind') = 'tool_result'
         AND json_extract(payload, '$.entry.callId') = ?
       LIMIT 1`,
      sessionId,
      target.turnId,
      target.callId,
    )
    .toArray()[0];
  const output =
    typeof result?.output === "string" ? parseJsonOrNull(result.output) : null;
  if (isRecord(output)) {
    if (output.kind === "inline" && Array.isArray(output.content))
      for (const part of output.content)
        if (isRecord(part) && typeof part.text === "string")
          content.push({ role: "result", text: bound(part.text) });
    if (output.kind === "artifact" && typeof output.preview === "string")
      content.push({ role: "result", text: bound(output.preview) });
  }
  return content;
}

/**
 * The Memory outcome a stored context holds, without its revisions. A
 * context with no such key recorded none. Null means that the stored value
 * is not an outcome.
 */
function storedTurnMemory(
  raw: SqlStorageValue | undefined,
): CaseExecutionTurnMemory | null {
  if (raw === null) return { kind: "unrecorded" };
  const stored = typeof raw === "string" ? parseJsonOrNull(raw) : null;
  if (!isRecord(stored)) return null;
  const revisions = Array.isArray(stored.revisions)
    ? stored.revisions.length
    : null;
  switch (stored.kind) {
    case "none":
      return { kind: "none" };
    case "admitted":
      return revisions !== null && revisions > 0
        ? { kind: "admitted", revisions }
        : null;
    case "limited":
      return revisions !== null &&
        (stored.reason === "items" || stored.reason === "tokens")
        ? { kind: "limited", reason: stored.reason, revisions }
        : null;
    case "unavailable":
      return stored.reason === "deadline" || stored.reason === "read_failed"
        ? { kind: "unavailable", reason: stored.reason }
        : null;
    default:
      return null;
  }
}

function bound(value: string): string {
  return value.length > MAX_EXECUTION_STORED_TEXT
    ? value.slice(0, MAX_EXECUTION_STORED_TEXT)
    : value;
}
