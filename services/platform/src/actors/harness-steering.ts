import type {
  AcceptedInputRef,
  HarnessHistoryContent,
  RequestAuthority,
  UserMessage,
  UserMessagePart,
} from "@seams/contracts";
import {
  assertNever,
  canonicalJson,
  isRecord,
  parseJsonOrNull,
} from "@seams/std";

/**
 * The steering inputs of a Session's turns (Plan 71). A steering input is a
 * message from the turn's requester that joins the running turn. The Session
 * admits it here before the harness sees it, and the history authority
 * accepts a later user input of a turn only when it names an admitted
 * steering input with the same content. When the turn ends, the Session
 * journals each placed input in the Case, so the Case records only the
 * messages that reached a turn.
 *
 * States: `admitted` (recorded, not yet with the harness), `queued` (the
 * harness holds it for the next boundary), `placed` (in the transcript), and
 * `withdrawn` (the turn ended first; the surface runs it as the next turn).
 */
/** The longest steering text: the limit of a Portal chat message. */
export const MAX_STEERING_TEXT_CHARS = 8_000;

/** Who sends a steering input: a Portal user, or a person in a Slack thread. */
export type SteeringRequester =
  | Readonly<{ kind: "user"; userId: string; personId?: never }>
  | Readonly<{ kind: "person"; personId: string; userId?: never }>;

/** Only the turn's own requester may steer it. */
export function steeringRequesterMatches(
  authority: RequestAuthority,
  requester: SteeringRequester,
): boolean {
  switch (requester.kind) {
    case "user":
      return (
        authority.kind === "control" && authority.userId === requester.userId
      );
    case "person":
      return (
        (authority.kind === "direct_conversation" ||
          authority.kind === "shared_conversation") &&
        String(authority.requesterPersonId) === requester.personId
      );
    default:
      return assertNever(requester);
  }
}

/** A steering message has text and links, and no files. */
export function steeringMessageHasNoFiles(message: UserMessage): boolean {
  return (
    isRecord(message) &&
    Array.isArray(message.remainingParts) &&
    [message.firstPart, ...message.remainingParts].every(isTextOrLinkPart)
  );
}

function isTextOrLinkPart(part: UserMessagePart): boolean {
  return isRecord(part) && (part.kind === "text" || part.kind === "link");
}

/**
 * The journal entry of the trigger that started a turn. A Portal turn
 * (`turn_trigger_…`) and a Slack turn (`turn_ingress_slack_…`) name their
 * triggers from the turn id. Other turns cannot be steered.
 */
export function turnTriggerEntryId(turnId: string): string | null {
  if (turnId.startsWith("turn_trigger_"))
    return `trigger:${turnId.slice("turn_".length)}`;
  if (turnId.startsWith("turn_ingress_slack_"))
    return `trigger:trigger_${turnId.slice("turn_".length)}`;
  return null;
}

export type SteeringInputState = "admitted" | "queued" | "placed" | "withdrawn";

export type SteeringInput = Readonly<{
  sessionId: string;
  turnId: string;
  inputId: string;
  requestId: string;
  inputRef: AcceptedInputRef;
  content: readonly HarnessHistoryContent[];
  state: SteeringInputState;
  harnessSubmissionId: string | null;
}>;

type SteeringInputRow = Record<string, SqlStorageValue> & {
  readonly session_id: string;
  readonly turn_id: string;
  readonly input_id: string;
  readonly request_id: string;
  readonly input_ref_json: string;
  readonly content_json: string;
  readonly state: string;
  readonly harness_submission_id: string | null;
};

export function createSessionTurnSteeringSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_turn_steering_input (
      session_id TEXT NOT NULL CHECK (length(session_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      input_id TEXT NOT NULL CHECK (length(input_id) > 0),
      request_id TEXT NOT NULL CHECK (length(request_id) > 0),
      input_ref_json TEXT NOT NULL CHECK (json_valid(input_ref_json)),
      content_json TEXT NOT NULL CHECK (json_valid(content_json)),
      state TEXT NOT NULL CHECK (
        state IN ('admitted', 'queued', 'placed', 'withdrawn')
      ),
      harness_submission_id TEXT,
      case_message_json TEXT NOT NULL CHECK (json_valid(case_message_json)),
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      journaled_at INTEGER CHECK (journaled_at IS NULL OR journaled_at >= 0),
      PRIMARY KEY (session_id, input_id),
      UNIQUE (session_id, request_id)
    )`,
  );
}

/**
 * Record a steering input, or return the input that the same request
 * admitted before. A different input under a known request id is a conflict.
 */
export function admitSteeringInput(
  sql: SqlStorage,
  input: Readonly<{
    sessionId: string;
    turnId: string;
    inputId: string;
    requestId: string;
    inputRef: AcceptedInputRef;
    content: readonly HarnessHistoryContent[];
    message: UserMessage;
    admittedAt: number;
  }>,
):
  | Readonly<{ kind: "admitted"; input: SteeringInput }>
  | Readonly<{ kind: "duplicate"; input: SteeringInput }>
  | Readonly<{ kind: "conflict" }> {
  const known = readSteeringInputByRequest(
    sql,
    input.sessionId,
    input.requestId,
  );
  if (known !== null)
    return known.turnId === input.turnId &&
      known.inputId === input.inputId &&
      canonicalJson(known.content) === canonicalJson(input.content)
      ? { kind: "duplicate", input: known }
      : { kind: "conflict" };
  sql.exec(
    `INSERT INTO session_turn_steering_input (
       session_id, turn_id, input_id, request_id, input_ref_json, content_json,
       state, harness_submission_id, case_message_json, admitted_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'admitted', NULL, ?, ?)`,
    input.sessionId,
    input.turnId,
    input.inputId,
    input.requestId,
    JSON.stringify(input.inputRef),
    canonicalJson(input.content),
    JSON.stringify(input.message),
    input.admittedAt,
  );
  return {
    kind: "admitted",
    input: {
      sessionId: input.sessionId,
      turnId: input.turnId,
      inputId: input.inputId,
      requestId: input.requestId,
      inputRef: input.inputRef,
      content: input.content,
      state: "admitted",
      harnessSubmissionId: null,
    },
  };
}

export function readSteeringInput(
  sql: SqlStorage,
  sessionId: string,
  inputId: string,
): SteeringInput | null {
  return parseSteeringInputRow(
    sql
      .exec<SteeringInputRow>(
        `SELECT session_id, turn_id, input_id, request_id, input_ref_json,
                content_json, state, harness_submission_id
         FROM session_turn_steering_input
         WHERE session_id = ? AND input_id = ?`,
        sessionId,
        inputId,
      )
      .toArray()[0],
  );
}

export function readSteeringInputByRequest(
  sql: SqlStorage,
  sessionId: string,
  requestId: string,
): SteeringInput | null {
  return parseSteeringInputRow(
    sql
      .exec<SteeringInputRow>(
        `SELECT session_id, turn_id, input_id, request_id, input_ref_json,
                content_json, state, harness_submission_id
         FROM session_turn_steering_input
         WHERE session_id = ? AND request_id = ?`,
        sessionId,
        requestId,
      )
      .toArray()[0],
  );
}

/** The inputs of a turn that the harness has not placed yet. */
export function unplacedSteeringInputs(
  sql: SqlStorage,
  sessionId: string,
  turnId: string,
): readonly SteeringInput[] {
  return sql
    .exec<SteeringInputRow>(
      `SELECT session_id, turn_id, input_id, request_id, input_ref_json,
              content_json, state, harness_submission_id
       FROM session_turn_steering_input
       WHERE session_id = ? AND turn_id = ? AND state IN ('admitted', 'queued')
       ORDER BY admitted_at, input_id`,
      sessionId,
      turnId,
    )
    .toArray()
    .map(parseSteeringInputRow)
    .filter(isSteeringInput);
}

export function markSteeringInputQueued(
  sql: SqlStorage,
  sessionId: string,
  inputId: string,
  harnessSubmissionId: string,
): void {
  sql.exec(
    `UPDATE session_turn_steering_input
     SET state = 'queued', harness_submission_id = ?
     WHERE session_id = ? AND input_id = ? AND state = 'admitted'`,
    harnessSubmissionId,
    sessionId,
    inputId,
  );
}

export function markSteeringInputPlaced(
  sql: SqlStorage,
  sessionId: string,
  inputId: string,
): void {
  sql.exec(
    `UPDATE session_turn_steering_input
     SET state = 'placed'
     WHERE session_id = ? AND input_id = ? AND state = 'queued'`,
    sessionId,
    inputId,
  );
}

export function markSteeringInputWithdrawn(
  sql: SqlStorage,
  sessionId: string,
  inputId: string,
): void {
  sql.exec(
    `UPDATE session_turn_steering_input
     SET state = 'withdrawn'
     WHERE session_id = ? AND input_id = ? AND state IN ('admitted', 'queued')`,
    sessionId,
    inputId,
  );
}

/**
 * The state of a steering input as a surface must see it. An input that is
 * still `admitted` or `queued` after its turn has ended can no longer be
 * placed, whatever ended the turn: a failure, a cancel, a process loss that
 * the recovery quarantined, or a recovery that cancelled it. Only a live
 * runtime's close withdraws inputs, so the read withdraws them here. A turn
 * that can still place an input holds the Session's harness lease: the live
 * turn, or a turn that a process lost and that the recovery resumes with a
 * fresh lease. Every turn end deletes that lease.
 */
export function settledSteeringInput(
  sql: SqlStorage,
  input: SteeringInput,
  liveTurnId: string | null,
): SteeringInput {
  if (input.state !== "admitted" && input.state !== "queued") return input;
  if (liveTurnId === input.turnId) return input;
  const lease = sql
    .exec<{ turn_id: string | null }>(
      `SELECT json_extract(lease_projection, '$.turn.turnId') AS turn_id
       FROM session_harness_lease
       WHERE session_id = ?
       LIMIT 1`,
      input.sessionId,
    )
    .toArray()[0];
  if (lease !== undefined && lease.turn_id === input.turnId) return input;
  markSteeringInputWithdrawn(sql, input.sessionId, input.inputId);
  return { ...input, state: "withdrawn" };
}

/** A placed input of a turn that the Case has not journaled yet. */
export type SteeringInputToJournal = Readonly<{
  inputId: string;
  inputRef: AcceptedInputRef;
  message: UserMessage;
  admittedAt: number;
}>;

export function steeringInputsToJournal(
  sql: SqlStorage,
  sessionId: string,
  turnId: string,
): readonly SteeringInputToJournal[] {
  const inputs: SteeringInputToJournal[] = [];
  const rows = sql
    .exec<
      Record<string, SqlStorageValue> & {
        input_id: string;
        input_ref_json: string;
        case_message_json: string;
        admitted_at: number;
      }
    >(
      `SELECT input_id, input_ref_json, case_message_json, admitted_at
       FROM session_turn_steering_input
       WHERE session_id = ? AND turn_id = ? AND state = 'placed'
         AND journaled_at IS NULL
       ORDER BY admitted_at, input_id`,
      sessionId,
      turnId,
    )
    .toArray();
  for (const row of rows) {
    const inputRef = parseJsonOrNull(row.input_ref_json);
    const message = parseJsonOrNull(row.case_message_json);
    if (!isRecord(inputRef) || !isRecord(message)) continue;
    // The row was written from these types; the casts only restore them.
    inputs.push({
      inputId: row.input_id,
      inputRef: inputRef as AcceptedInputRef,
      message: message as UserMessage,
      admittedAt: row.admitted_at,
    });
  }
  return inputs;
}

export function markSteeringInputJournaled(
  sql: SqlStorage,
  sessionId: string,
  inputId: string,
  journaledAt: number,
): void {
  sql.exec(
    `UPDATE session_turn_steering_input
     SET journaled_at = ?
     WHERE session_id = ? AND input_id = ? AND journaled_at IS NULL`,
    journaledAt,
    sessionId,
    inputId,
  );
}

/**
 * Whether a later user input of a turn is a steering input that the harness
 * queued or placed, with the content that the Session admitted.
 */
export function steeringInputAccepts(
  sql: SqlStorage,
  input: Readonly<{
    sessionId: string;
    turnId: string;
    inputId: string;
    content: readonly HarnessHistoryContent[];
  }>,
): boolean {
  const admitted = readSteeringInput(sql, input.sessionId, input.inputId);
  return (
    admitted !== null &&
    admitted.turnId === input.turnId &&
    (admitted.state === "queued" || admitted.state === "placed") &&
    canonicalJson(admitted.content) === canonicalJson(input.content)
  );
}

export function deleteSessionSteeringInputs(
  sql: SqlStorage,
  sessionId: string,
): void {
  sql.exec(
    "DELETE FROM session_turn_steering_input WHERE session_id = ?",
    sessionId,
  );
}

function parseSteeringInputRow(
  row: SteeringInputRow | undefined,
): SteeringInput | null {
  if (row === undefined) return null;
  const inputRef = parseJsonOrNull(row.input_ref_json);
  const content = parseJsonOrNull(row.content_json);
  if (
    !isRecord(inputRef) ||
    !Array.isArray(content) ||
    !isSteeringInputState(row.state)
  )
    return null;
  // The row was written from these types; the generic casts only restore them.
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    inputId: row.input_id,
    requestId: row.request_id,
    inputRef: inputRef as AcceptedInputRef,
    content: content as HarnessHistoryContent[],
    state: row.state,
    harnessSubmissionId: row.harness_submission_id,
  };
}

function isSteeringInputState(value: string): value is SteeringInputState {
  return (
    value === "admitted" ||
    value === "queued" ||
    value === "placed" ||
    value === "withdrawn"
  );
}

function isSteeringInput(value: SteeringInput | null): value is SteeringInput {
  return value !== null;
}
