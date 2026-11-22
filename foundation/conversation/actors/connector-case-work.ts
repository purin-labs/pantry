import type { ConnectorIdentity } from "@purin-labs/contracts";

import {
  parseConnectorId,
  parseRequestId,
  parseOrganisationId,
  type OrganisationId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import { parseOrganisationPlacement } from "@purin-labs/tenancy/placement";
import type { Result } from "@purin-labs/kernel/result";
import type { SessionActorRoute } from "@purin-labs/actor-runtime/actors/actor-router";
import type { CountRow } from "@purin-labs/actor-runtime/actors/sql-rows";
import {
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";

/**
 * What the queue reads of a command. A command is stored as its JSON, and
 * the queue finds the Case of a stored command at `$.target.caseId`.
 */
export type CaseWorkCommand = Readonly<{
  requestId: RequestId;
  receivedAt: number;
  organisationId: OrganisationId;
  target: Readonly<{ caseId: string; connectorId: string }>;
}>;

/**
 * How the queue reads the commands of the channel whose messages are Case
 * work. The queue holds the rest of a command as an opaque value.
 */
export type CaseWorkCodec<Command extends CaseWorkCommand> = Readonly<{
  /** Parses a stored command, or one that a caller sent. */
  parse(value: unknown): Result<Command, unknown>;
  /** The event of the command. It names the command's work in the queue. */
  eventId(command: Command): string;
  /** The provider's message, the same for each delivery of that message. */
  nativeMessageId(command: Command): string;
  /** The parts of a command that a repeated delivery of it keeps. */
  stableJson(command: Command): string;
}>;

export type ConnectorCaseWorkRequest<Command extends CaseWorkCommand> = {
  readonly identity: ConnectorIdentity;
  readonly command: Command;
};

type ConnectorCaseWorkRecoveryRequest = {
  readonly identity: ConnectorIdentity;
  readonly requestId: RequestId;
};

/** How one run of a claimed item ended. */
export type CaseWorkOutcome =
  | { readonly kind: "completed" }
  | {
      readonly kind: "retry";
      readonly retryAt: number;
      readonly reason: string;
    }
  | { readonly kind: "rejected"; readonly reason: string };

export type ConnectorCaseWorkResult =
  | { readonly kind: "completed"; readonly completedAt: number }
  | {
      readonly kind: "retry";
      readonly reason: string;
      readonly retryAt: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly rejectedAt: number;
    };

export type ConnectorCaseWorkClaim<Command extends CaseWorkCommand> = {
  readonly command: Command;
  readonly attempt: number;
  /**
   * What this claim does. `turn` runs the message. `exhausted_notice` tells
   * the thread that the message used every attempt. `lastReason` is why the
   * claim before this one ended, or null when its lease ran out. `final` is
   * set on the last claim that may post the notice.
   */
  readonly work:
    | {
        readonly kind: "turn";
        readonly lastReason?: never;
        readonly final?: never;
      }
    | {
        readonly kind: "exhausted_notice";
        readonly lastReason: string | null;
        readonly final: boolean;
      };
};

/** The message used every attempt, and its thread was told. */
export const CASE_WORK_ATTEMPTS_EXHAUSTED =
  "connector_case_work_attempts_exhausted";
/** The message used every attempt, and the notice did not reach its thread. */
export const CASE_WORK_EXHAUSTED_NOTICE_UNDELIVERED =
  "connector_case_work_exhausted_notice_undelivered";

export type ConnectorCaseWorkAcceptance = {
  readonly kind: "accepted" | "duplicate";
  readonly eventId: string;
};

export type ConnectorCaseWorkError = { readonly code: string };

export type ConnectorCaseWorkEfficiency = {
  readonly activeRows: number;
  readonly receiptRows: number;
};

type ConnectorCaseWorkQuery<T> = {
  readonly result: T;
  readonly rowsRead: number;
};

type ConnectorCaseWorkState =
  | { readonly kind: "pending"; readonly dueAt: number }
  | {
      readonly kind: "running";
      readonly attempt: number;
      readonly leaseExpiresAt: number;
    }
  | {
      readonly kind: "retryable";
      readonly attempt: number;
      readonly reason: string;
      readonly retryAt: number;
    };

type ConnectorCaseWorkReceipt =
  | { readonly kind: "completed"; readonly settledAt: number }
  | {
      readonly kind: "rejected";
      readonly reason: string;
      readonly settledAt: number;
    };

type ConnectorCaseWorkRow = Record<string, SqlStorageValue> & {
  readonly event_id: string;
  readonly payload: string;
  readonly state_kind: string;
  readonly attempt: number;
  readonly due_at: number;
  readonly retry_reason: string | null;
  readonly created_at: number;
};

type ConnectorCaseWorkReceiptRow = Record<string, SqlStorageValue> & {
  readonly event_id: string;
  readonly stable_command: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly settled_at: number;
};
type TableInfoRow = Record<string, SqlStorageValue> & { readonly name: string };
type MinimumDueRow = Record<string, SqlStorageValue> & {
  readonly due_at: number | null;
};

const CASE_WORK_LEASE_MS = 120_000;
const CASE_WORK_MAX_ATTEMPTS = 5;
/** Claims that may post the notice after the attempts are used up. */
const CASE_WORK_NOTICE_ATTEMPTS = 3;

export function createConnectorCaseWorkSchema(sql: SqlStorage): void {
  const columns = connectorCaseWorkColumns(sql);
  if (columns.length === 0)
    createConnectorCaseWorkTable(sql, "connector_case_work");
  createConnectorCaseWorkReceiptTable(sql);
  createConnectorCaseNativeMessageTable(sql);
  createConnectorCaseSteeringTable(sql);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS connector_case_work_due
     ON connector_case_work (due_at, created_at)`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS connector_case_work_running_due
     ON connector_case_work (due_at)
     WHERE state_kind = 'running'`,
  );
}

export function parseConnectorCaseWorkRequest<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  value: unknown,
): ConnectorCaseWorkRequest<Command> | null {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    !isNonBlankString(value.identity.organisationId) ||
    !isNonBlankString(value.identity.connectorId)
  ) {
    return null;
  }
  const organisationId = parseOrganisationId(value.identity.organisationId);
  const connectorId = parseConnectorId(value.identity.connectorId);
  const parsed = codec.parse(value.command);
  if (!organisationId.ok || !connectorId.ok || !parsed.ok) return null;
  return {
    identity: {
      organisationId: organisationId.value,
      connectorId: connectorId.value,
    },
    command: parsed.value,
  };
}

export function parseConnectorCaseWorkRecoveryRequest(
  value: unknown,
): ConnectorCaseWorkRecoveryRequest | null {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    !isNonBlankString(value.identity.organisationId) ||
    !isNonBlankString(value.identity.connectorId) ||
    !isNonBlankString(value.requestId)
  ) {
    return null;
  }
  const organisationId = parseOrganisationId(value.identity.organisationId);
  const connectorId = parseConnectorId(value.identity.connectorId);
  const requestId = parseRequestId(value.requestId);
  return organisationId.ok && connectorId.ok && requestId.ok
    ? {
        identity: {
          organisationId: organisationId.value,
          connectorId: connectorId.value,
        },
        requestId: requestId.value,
      }
    : null;
}

export function parseIdentityRecord(value: unknown): ConnectorIdentity | null {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.organisationId) ||
    !isNonBlankString(value.connectorId)
  )
    return null;
  const organisationId = parseOrganisationId(value.organisationId);
  const connectorId = parseConnectorId(value.connectorId);
  if (!organisationId.ok || !connectorId.ok) return null;
  return {
    organisationId: organisationId.value,
    connectorId: connectorId.value,
  };
}

export function acceptConnectorCaseWork<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  input: ConnectorCaseWorkRequest<Command>,
):
  | { readonly ok: true; readonly value: ConnectorCaseWorkAcceptance }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  if (
    input.command.organisationId !== input.identity.organisationId ||
    input.command.target.connectorId !== input.identity.connectorId
  ) {
    return {
      ok: false,
      error: { code: "connector_case_work_identity_mismatch" },
    };
  }
  const eventId = codec.eventId(input.command);
  const nativeMessageId = codec.nativeMessageId(input.command);
  const mappedEventId = readConnectorCaseNativeEventId(sql, nativeMessageId);
  const persistedEventId = mappedEventId ?? eventId;
  const steered = readSteeredCaseWork(codec, sql, persistedEventId);
  if (steered !== null)
    return steered.command !== null &&
      codec.stableJson(steered.command) === codec.stableJson(input.command)
      ? duplicateAcceptance(eventId)
      : { ok: false, error: { code: "connector_case_work_conflict" } };
  const active = readConnectorCaseWork(sql, persistedEventId);
  const receipt = readConnectorCaseWorkReceipt(sql, persistedEventId);
  if (active !== undefined && receipt !== undefined) {
    return { ok: false, error: { code: "connector_case_work_conflict" } };
  }
  if (
    mappedEventId !== undefined &&
    active === undefined &&
    receipt === undefined
  ) {
    return { ok: false, error: { code: "connector_case_work_conflict" } };
  }
  if (active !== undefined) {
    const existingCommand = codec.parse(parseJsonOrNull(active.payload));
    return existingCommand.ok &&
      parseConnectorCaseWorkRow(active) !== null &&
      codec.stableJson(existingCommand.value) ===
        codec.stableJson(input.command)
      ? duplicateAcceptance(eventId)
      : { ok: false, error: { code: "connector_case_work_conflict" } };
  }
  if (receipt !== undefined) {
    return parseConnectorCaseWorkReceipt(receipt) !== null &&
      receipt.stable_command === codec.stableJson(input.command)
      ? duplicateAcceptance(eventId)
      : { ok: false, error: { code: "connector_case_work_conflict" } };
  }
  sql.exec(
    `INSERT INTO connector_case_work (
       event_id, payload, state_kind, attempt, due_at, retry_reason, created_at
     ) VALUES (?, ?, 'pending', 0, ?, NULL, ?)`,
    eventId,
    JSON.stringify(input.command),
    input.command.receivedAt,
    input.command.receivedAt,
  );
  sql.exec(
    `INSERT INTO connector_case_native_message (native_message_id, event_id)
     VALUES (?, ?)`,
    nativeMessageId,
    eventId,
  );
  return { ok: true, value: { kind: "accepted", eventId } };
}

/**
 * Where the work of an event is: in the queue with its due time, settled
 * with a receipt, or nowhere.
 */
export function caseWorkPresence(
  sql: SqlStorage,
  eventId: string,
):
  | Readonly<{ kind: "waiting"; dueAt: number }>
  | Readonly<{
      kind: "settled";
    }>
  | null {
  const waiting = readConnectorCaseWork(sql, eventId);
  if (waiting !== undefined) return { kind: "waiting", dueAt: waiting.due_at };
  return readConnectorCaseWorkReceipt(sql, eventId) === undefined
    ? null
    : { kind: "settled" };
}

/** The command of an event whose turn runs now, or null. */
export function readRunningCaseWorkCommand<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  eventId: string,
): Command | null {
  const row = readConnectorCaseWork(sql, eventId);
  if (row === undefined || parseConnectorCaseWorkRow(row)?.kind !== "running")
    return null;
  const command = codec.parse(parseJsonOrNull(row.payload));
  return command.ok ? command.value : null;
}

/** How many items of one Case wait in the queue under an event id prefix. */
export function countCaseWorkWithEventPrefix(
  sql: SqlStorage,
  prefix: string,
  caseId: string,
): number {
  const row = sql
    .exec<CountRow>(
      `SELECT COUNT(*) AS count FROM connector_case_work
       WHERE substr(event_id, 1, ?) = ?
         AND json_extract(payload, '$.target.caseId') = ?`,
      prefix.length,
      prefix,
      caseId,
    )
    .one();
  return row.count;
}

/**
 * A reply that joined the running turn of its Case as a steering input
 * (Plan 71). It waits here, out of the work queue, until that turn ends.
 * The Session then says whether the turn read it: a placed reply settles as
 * completed, and a withdrawn one returns to the queue as the next turn.
 */
type SteeredCaseWork<Command extends CaseWorkCommand> = Readonly<{
  eventId: string;
  command: Command | null;
  runningEventId: string;
  sessionId: string;
  sessionRoute: SessionActorRoute | null;
}>;

type SteeredCaseWorkRow = Record<string, SqlStorageValue> & {
  readonly event_id: string;
  readonly payload: string;
  readonly running_event_id: string;
  readonly session_id: string;
  readonly session_route_json: string;
};

function createConnectorCaseSteeringTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_case_steering (
    event_id TEXT PRIMARY KEY CHECK (length(event_id) > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    running_event_id TEXT NOT NULL CHECK (length(running_event_id) > 0),
    session_id TEXT NOT NULL CHECK (length(session_id) > 0),
    session_route_json TEXT NOT NULL CHECK (json_valid(session_route_json)),
    steered_at INTEGER NOT NULL CHECK (steered_at >= 0)
  )`);
}

/** The pending replies of busy Cases, oldest first. */
export function pendingCaseWorkForCases<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  caseIds: readonly string[],
  now: number,
): readonly Readonly<{ eventId: string; command: Command }>[] {
  if (caseIds.length === 0) return [];
  return sql
    .exec<ConnectorCaseWorkRow>(
      `SELECT event_id, payload, state_kind, attempt, due_at, retry_reason, created_at
       FROM connector_case_work
       WHERE state_kind = 'pending' AND due_at <= ?
         AND json_extract(payload, '$.target.caseId') IN (${caseIds.map(placeholder).join(", ")})
       ORDER BY due_at, created_at`,
      now,
      ...caseIds,
    )
    .toArray()
    .flatMap(function pendingCommand(row) {
      const parsed = codec.parse(parseJsonOrNull(row.payload));
      return parsed.ok
        ? [{ eventId: row.event_id, command: parsed.value }]
        : [];
    });
}

/**
 * Move a pending reply out of the queue, before it is offered to its running
 * turn (Refactor 15, refactor 9). False when the reply is no longer pending.
 */
export function parkSteeredCaseWork(
  sql: SqlStorage,
  input: Readonly<{
    eventId: string;
    runningEventId: string;
    sessionId: string;
    sessionRoute: SessionActorRoute;
    steeredAt: number;
  }>,
): boolean {
  const row = readConnectorCaseWork(sql, input.eventId);
  if (row === undefined || parseConnectorCaseWorkRow(row)?.kind !== "pending")
    return false;
  sql.exec(
    `INSERT INTO connector_case_steering (
       event_id, payload, running_event_id, session_id, session_route_json,
       steered_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    input.eventId,
    row.payload,
    input.runningEventId,
    input.sessionId,
    JSON.stringify(input.sessionRoute),
    input.steeredAt,
  );
  sql.exec("DELETE FROM connector_case_work WHERE event_id = ?", input.eventId);
  return true;
}

/** The parked replies whose running turn has ended. */
export function steeredCaseWorkToSettle<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
): readonly SteeredCaseWork<Command>[] {
  return sql
    .exec<SteeredCaseWorkRow>(
      `SELECT steering.event_id, steering.payload, steering.running_event_id,
              steering.session_id, steering.session_route_json
       FROM connector_case_steering AS steering
       WHERE NOT EXISTS (
         SELECT 1 FROM connector_case_work AS work
         WHERE work.event_id = steering.running_event_id
           AND work.state_kind = 'running'
       )
       ORDER BY steering.steered_at, steering.event_id`,
    )
    .toArray()
    .map(function parseSteered(row): SteeredCaseWork<Command> {
      return parseSteeredCaseWorkRow(codec, row);
    });
}

/**
 * Settle a parked reply: `placed` gives it a completed receipt, `withdrawn`
 * returns it to the queue, due now.
 */
export function settleSteeredCaseWork<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  eventId: string,
  outcome: "placed" | "withdrawn",
  now: number,
): void {
  const row = sql
    .exec<SteeredCaseWorkRow>(
      `SELECT event_id, payload, running_event_id, session_id, session_route_json
       FROM connector_case_steering WHERE event_id = ?`,
      eventId,
    )
    .toArray()[0];
  if (row === undefined) return;
  const command = codec.parse(parseJsonOrNull(row.payload));
  if (!command.ok) return;
  sql.exec("DELETE FROM connector_case_steering WHERE event_id = ?", eventId);
  if (outcome === "placed") {
    settleConnectorCaseWork(sql, eventId, codec.stableJson(command.value), {
      kind: "completed",
      settledAt: now,
    });
    return;
  }
  sql.exec(
    `INSERT INTO connector_case_work (
       event_id, payload, state_kind, attempt, due_at, retry_reason, created_at
     ) VALUES (?, ?, 'pending', 0, ?, NULL, ?)`,
    eventId,
    row.payload,
    now,
    now,
  );
}

/**
 * Return a reply whose steer the Session refused to its place in the queue:
 * it waits for the next turn, as it did before the offer.
 */
export function unparkRefusedSteer<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  eventId: string,
): void {
  const row = sql
    .exec<SteeredCaseWorkRow>(
      `SELECT event_id, payload, running_event_id, session_id, session_route_json
       FROM connector_case_steering WHERE event_id = ?`,
      eventId,
    )
    .toArray()[0];
  if (row === undefined) return;
  const command = codec.parse(parseJsonOrNull(row.payload));
  if (!command.ok) return;
  sql.exec("DELETE FROM connector_case_steering WHERE event_id = ?", eventId);
  sql.exec(
    `INSERT INTO connector_case_work (
       event_id, payload, state_kind, attempt, due_at, retry_reason, created_at
     ) VALUES (?, ?, 'pending', 0, ?, NULL, ?)`,
    eventId,
    row.payload,
    command.value.receivedAt,
    command.value.receivedAt,
  );
}

function readSteeredCaseWork<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  eventId: string,
): SteeredCaseWork<Command> | null {
  const row = sql
    .exec<SteeredCaseWorkRow>(
      `SELECT event_id, payload, running_event_id, session_id, session_route_json
       FROM connector_case_steering WHERE event_id = ?`,
      eventId,
    )
    .toArray()[0];
  return row === undefined ? null : parseSteeredCaseWorkRow(codec, row);
}

function parseSteeredCaseWorkRow<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  row: SteeredCaseWorkRow,
): SteeredCaseWork<Command> {
  const command = codec.parse(parseJsonOrNull(row.payload));
  const route = parseJsonOrNull(row.session_route_json);
  const placement = isRecord(route)
    ? parseOrganisationPlacement(route.placement)
    : null;
  return {
    eventId: row.event_id,
    command: command.ok ? command.value : null,
    runningEventId: row.running_event_id,
    sessionId: row.session_id,
    sessionRoute:
      isRecord(route) &&
      isNonBlankString(route.physicalObjectName) &&
      placement?.ok === true
        ? {
            physicalObjectName: route.physicalObjectName,
            placement: placement.value,
          }
        : null,
  };
}

/**
 * Claim the earliest due item. An item whose Case is listed as busy is left
 * for later, so the messages of one Case never run at the same time.
 */
export function claimConnectorCaseWork<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  now: number,
  busyCaseIds: readonly string[] = [],
):
  | {
      readonly ok: true;
      readonly value: ConnectorCaseWorkQuery<ConnectorCaseWorkClaim<Command> | null>;
    }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  let rowsRead = 0;
  const idleCase =
    busyCaseIds.length === 0
      ? ""
      : `AND json_extract(payload, '$.target.caseId') NOT IN (${busyCaseIds.map(placeholder).join(", ")})`;
  for (;;) {
    const cursor = sql.exec<ConnectorCaseWorkRow>(
      `SELECT event_id, payload, state_kind, attempt, due_at, retry_reason, created_at
       FROM connector_case_work
       WHERE due_at <= ? ${idleCase}
       ORDER BY due_at, created_at
      LIMIT 1`,
      now,
      ...busyCaseIds,
    );
    const row = cursor.toArray()[0];
    rowsRead += cursor.rowsRead;
    if (row === undefined)
      return { ok: true, value: { result: null, rowsRead } };
    const state = parseConnectorCaseWorkRow(row);
    if (state === null)
      return { ok: false, error: { code: "connector_case_work_corrupt" } };
    const attempt = previousAttempt(state) + 1;
    const parsed = codec.parse(parseJsonOrNull(row.payload));
    if (!parsed.ok)
      return { ok: false, error: { code: "connector_case_work_corrupt" } };
    const canonicalEventId = readConnectorCaseNativeEventId(
      sql,
      codec.nativeMessageId(parsed.value),
    );
    if (canonicalEventId !== undefined && canonicalEventId !== row.event_id) {
      settleConnectorCaseWork(
        sql,
        row.event_id,
        codec.stableJson(parsed.value),
        {
          kind: "rejected",
          reason: "connector_case_work_duplicate_native_message",
          settledAt: now,
        },
      );
      continue;
    }
    // Only a notice claim whose lease ran out comes this far. Its post has
    // no known result, so the receipt says that the thread was not told.
    if (attempt > CASE_WORK_MAX_ATTEMPTS + CASE_WORK_NOTICE_ATTEMPTS) {
      settleConnectorCaseWork(
        sql,
        row.event_id,
        codec.stableJson(parsed.value),
        {
          kind: "rejected",
          reason: CASE_WORK_EXHAUSTED_NOTICE_UNDELIVERED,
          settledAt: now,
        },
      );
      continue;
    }
    sql.exec(
      `UPDATE connector_case_work
       SET state_kind = 'running', attempt = ?, due_at = ?, retry_reason = NULL
       WHERE event_id = ?`,
      attempt,
      now + CASE_WORK_LEASE_MS,
      row.event_id,
    );
    return {
      ok: true,
      value: {
        result: {
          command: parsed.value,
          attempt,
          work:
            attempt > CASE_WORK_MAX_ATTEMPTS
              ? {
                  kind: "exhausted_notice",
                  lastReason: state.kind === "retryable" ? state.reason : null,
                  final:
                    attempt ===
                    CASE_WORK_MAX_ATTEMPTS + CASE_WORK_NOTICE_ATTEMPTS,
                }
              : { kind: "turn" },
        },
        rowsRead,
      },
    };
  }
}

function placeholder(): string {
  return "?";
}

export function finalizeConnectorCaseWork<Command extends CaseWorkCommand>(
  codec: CaseWorkCodec<Command>,
  sql: SqlStorage,
  claim: ConnectorCaseWorkClaim<Command>,
  result: ConnectorCaseWorkResult,
):
  | { readonly ok: true; readonly value: null }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const eventId = codec.eventId(claim.command);
  const row = readConnectorCaseWork(sql, eventId);
  const state = row === undefined ? null : parseConnectorCaseWorkRow(row);
  if (
    row === undefined ||
    row.payload !== JSON.stringify(claim.command) ||
    state?.kind !== "running" ||
    state.attempt !== claim.attempt
  ) {
    return { ok: false, error: { code: "connector_case_work_claim_lost" } };
  }
  switch (result.kind) {
    case "retry":
      sql.exec(
        `UPDATE connector_case_work
         SET state_kind = 'retryable', due_at = ?, retry_reason = ?
         WHERE event_id = ?`,
        result.retryAt,
        result.reason,
        eventId,
      );
      return { ok: true, value: null };
    case "completed":
      settleConnectorCaseWork(
        sql,
        row.event_id,
        codec.stableJson(claim.command),
        {
          kind: "completed",
          settledAt: result.completedAt,
        },
      );
      return { ok: true, value: null };
    case "rejected":
      settleConnectorCaseWork(
        sql,
        row.event_id,
        codec.stableJson(claim.command),
        {
          kind: "rejected",
          reason: result.reason,
          settledAt: result.rejectedAt,
        },
      );
      return { ok: true, value: null };
  }
}

export function nextConnectorCaseWorkAlarm(
  sql: SqlStorage,
): ConnectorCaseWorkQuery<number | null> {
  const runningCursor = sql.exec<MinimumDueRow>(
    `SELECT MIN(due_at) AS due_at
     FROM connector_case_work
     WHERE state_kind = 'running'`,
  );
  const running = runningCursor.toArray()[0];
  if (running !== undefined && isNonNegativeInteger(running.due_at)) {
    return { result: running.due_at, rowsRead: runningCursor.rowsRead };
  }
  const cursor = sql.exec<MinimumDueRow>(
    "SELECT MIN(due_at) AS due_at FROM connector_case_work",
  );
  const row = cursor.toArray()[0];
  return {
    result:
      row !== undefined && isNonNegativeInteger(row.due_at) ? row.due_at : null,
    rowsRead: runningCursor.rowsRead + cursor.rowsRead,
  };
}

export function renewRunningConnectorCaseWorkLeases(
  sql: SqlStorage,
  now: number,
): void {
  sql.exec(
    `UPDATE connector_case_work
     SET due_at = ?
     WHERE state_kind = 'running' AND due_at <= ?`,
    now + CASE_WORK_LEASE_MS,
    now,
  );
}

export function inspectConnectorCaseWorkEfficiency(
  sql: SqlStorage,
): ConnectorCaseWorkEfficiency {
  return {
    activeRows: countRows(sql, "connector_case_work"),
    receiptRows: countRows(sql, "connector_case_work_receipt"),
  };
}

function duplicateAcceptance(eventId: string): {
  readonly ok: true;
  readonly value: ConnectorCaseWorkAcceptance;
} {
  return { ok: true, value: { kind: "duplicate", eventId } };
}

function settleConnectorCaseWork(
  sql: SqlStorage,
  eventId: string,
  stableCommand: string,
  receipt: ConnectorCaseWorkReceipt,
): void {
  sql.exec(
    `INSERT INTO connector_case_work_receipt (
       event_id, stable_command, outcome, reason, settled_at
     ) VALUES (?, ?, ?, ?, ?)`,
    eventId,
    stableCommand,
    receipt.kind,
    receipt.kind === "rejected" ? receipt.reason : null,
    receipt.settledAt,
  );
  sql.exec("DELETE FROM connector_case_work WHERE event_id = ?", eventId);
}

function previousAttempt(state: ConnectorCaseWorkState): number {
  switch (state.kind) {
    case "pending":
      return 0;
    case "running":
    case "retryable":
      return state.attempt;
  }
}

function parseConnectorCaseWorkRow(
  row: ConnectorCaseWorkRow,
): ConnectorCaseWorkState | null {
  if (!isNonNegativeInteger(row.due_at) || !isNonNegativeInteger(row.attempt))
    return null;
  switch (row.state_kind) {
    case "pending":
      return row.attempt === 0 && row.retry_reason === null
        ? { kind: "pending", dueAt: row.due_at }
        : null;
    case "running":
      return row.attempt > 0 && row.retry_reason === null
        ? { kind: "running", attempt: row.attempt, leaseExpiresAt: row.due_at }
        : null;
    case "retryable":
      return row.attempt > 0 && isNonBlankString(row.retry_reason)
        ? {
            kind: "retryable",
            attempt: row.attempt,
            reason: row.retry_reason,
            retryAt: row.due_at,
          }
        : null;
    default:
      return null;
  }
}

function parseConnectorCaseWorkReceipt(
  row: ConnectorCaseWorkReceiptRow,
): ConnectorCaseWorkReceipt | null {
  if (
    !isNonNegativeInteger(row.settled_at) ||
    !isNonBlankString(row.stable_command)
  )
    return null;
  switch (row.outcome) {
    case "completed":
      return row.reason === null
        ? { kind: "completed", settledAt: row.settled_at }
        : null;
    case "rejected":
      return isNonBlankString(row.reason)
        ? { kind: "rejected", reason: row.reason, settledAt: row.settled_at }
        : null;
    default:
      return null;
  }
}

function createConnectorCaseWorkTable(
  sql: SqlStorage,
  table: "connector_case_work" | "connector_case_work_next",
): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    event_id TEXT PRIMARY KEY CHECK (length(event_id) > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    state_kind TEXT NOT NULL CHECK (state_kind IN ('pending', 'running', 'retryable')),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    due_at INTEGER NOT NULL CHECK (due_at >= 0),
    retry_reason TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK (
      (state_kind = 'pending' AND attempt = 0 AND retry_reason IS NULL)
      OR (state_kind = 'running' AND attempt > 0 AND retry_reason IS NULL)
      OR (state_kind = 'retryable' AND attempt > 0 AND length(retry_reason) > 0)
    )
  )`);
}

function createConnectorCaseWorkReceiptTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_case_work_receipt (
    event_id TEXT PRIMARY KEY CHECK (length(event_id) > 0),
    stable_command TEXT NOT NULL CHECK (json_valid(stable_command)),
    outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'rejected')),
    reason TEXT,
    settled_at INTEGER NOT NULL CHECK (settled_at >= 0),
    CHECK (
      (outcome = 'completed' AND reason IS NULL)
      OR (outcome = 'rejected' AND length(reason) > 0)
    )
  )`);
}

function createConnectorCaseNativeMessageTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_case_native_message (
    native_message_id TEXT PRIMARY KEY CHECK (length(native_message_id) > 0),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) > 0)
  )`);
}

function readConnectorCaseWork(
  sql: SqlStorage,
  eventId: string,
): ConnectorCaseWorkRow | undefined {
  return sql
    .exec<ConnectorCaseWorkRow>(
      `SELECT event_id, payload, state_kind, attempt, due_at, retry_reason, created_at
     FROM connector_case_work
     WHERE event_id = ?
     LIMIT 2`,
      eventId,
    )
    .toArray()[0];
}

function readConnectorCaseWorkReceipt(
  sql: SqlStorage,
  eventId: string,
): ConnectorCaseWorkReceiptRow | undefined {
  return sql
    .exec<ConnectorCaseWorkReceiptRow>(
      `SELECT event_id, stable_command, outcome, reason, settled_at
     FROM connector_case_work_receipt
     WHERE event_id = ?
     LIMIT 2`,
      eventId,
    )
    .toArray()[0];
}

function readConnectorCaseNativeEventId(
  sql: SqlStorage,
  nativeMessageId: string,
): string | undefined {
  return sql
    .exec<Record<string, SqlStorageValue> & { readonly event_id: string }>(
      `SELECT event_id
     FROM connector_case_native_message
     WHERE native_message_id = ?
     LIMIT 2`,
      nativeMessageId,
    )
    .toArray()[0]?.event_id;
}

function connectorCaseWorkColumns(sql: SqlStorage): readonly string[] {
  return sql
    .exec<TableInfoRow>("PRAGMA table_info(connector_case_work)")
    .toArray()
    .map(readColumnName);
}

function readColumnName(row: TableInfoRow): string {
  return row.name;
}

function countRows(
  sql: SqlStorage,
  table:
    | "connector_case_work"
    | "connector_case_work_next"
    | "connector_case_work_receipt",
): number {
  const row = sql
    .exec<CountRow>(`SELECT COUNT(*) AS count FROM ${table}`)
    .toArray()[0];
  return typeof row?.count === "number" ? row.count : 0;
}
