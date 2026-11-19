import { isSideCaseProposalId } from "@purin-labs/control-api";
import type { ConnectorIdentity } from "@purin-labs/contracts";

import {
  parseConnectorId,
  parseRequestId,
  parseOrganisationId,
  type RequestId,
} from "../ids";
import {
  parseSlackCaseCommand,
  type SlackCaseCommand,
} from "../ingress-queue";
import { parseStoredRequestAuthority } from "../request-authority";
import type { SlackEventId } from "../slack/events";
import { parseOrganisationPlacement } from "../placement";
import type { SessionActorRoute } from "./actor-router";
import type { CountRow } from "./sql-rows";
import {
  isNonBlankString,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";

export type ConnectorCaseWorkRequest = {
  readonly identity: ConnectorIdentity;
  readonly command: SlackCaseCommand;
};

type ConnectorCaseWorkRecoveryRequest = {
  readonly identity: ConnectorIdentity;
  readonly requestId: RequestId;
};

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

export type ConnectorCaseWorkClaim = {
  readonly command: SlackCaseCommand;
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

type ConnectorCaseWorkAcceptance = {
  readonly kind: "accepted" | "duplicate";
  readonly eventId: string;
};

type ConnectorCaseWorkError = { readonly code: string };

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
  createConnectorParkedCaseWorkTable(sql);
  createConnectorSideCaseTable(sql);
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

export function parseConnectorCaseWorkRequest(
  value: unknown,
): ConnectorCaseWorkRequest | null {
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
  const parsed = parseSlackCaseCommand(value.command);
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

export function acceptConnectorCaseWork(
  sql: SqlStorage,
  input: ConnectorCaseWorkRequest,
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
  const eventId = input.command.event.eventId;
  const nativeMessageId = slackNativeMessageId(input.command);
  const mappedEventId = readConnectorCaseNativeEventId(sql, nativeMessageId);
  const persistedEventId = mappedEventId ?? eventId;
  const steered = readSteeredCaseWork(sql, persistedEventId);
  if (steered !== null)
    return steered.command !== null &&
      sameSlackCaseCommand(steered.command, input.command)
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
    const existingCommand = parseSlackCaseCommand(
      parseJsonOrNull(active.payload),
    );
    return existingCommand.ok &&
      parseConnectorCaseWorkRow(active) !== null &&
      sameSlackCaseCommand(existingCommand.value, input.command)
      ? duplicateAcceptance(eventId)
      : { ok: false, error: { code: "connector_case_work_conflict" } };
  }
  if (receipt !== undefined) {
    return parseConnectorCaseWorkReceipt(receipt) !== null &&
      receipt.stable_command === stableSlackCaseCommandJson(input.command)
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
 * A reply that joined the running turn of its Case as a steering input
 * (Plan 71). It waits here, out of the work queue, until that turn ends.
 * The Session then says whether the turn read it: a placed reply settles as
 * completed, and a withdrawn one returns to the queue as the next turn.
 */
type SteeredCaseWork = Readonly<{
  eventId: string;
  command: SlackCaseCommand | null;
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
export function pendingCaseWorkForCases(
  sql: SqlStorage,
  caseIds: readonly string[],
  now: number,
): readonly Readonly<{ eventId: string; command: SlackCaseCommand }>[] {
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
      const parsed = parseSlackCaseCommand(parseJsonOrNull(row.payload));
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
export function steeredCaseWorkToSettle(
  sql: SqlStorage,
): readonly SteeredCaseWork[] {
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
    .map(parseSteeredCaseWorkRow);
}

/**
 * Settle a parked reply: `placed` gives it a completed receipt, `withdrawn`
 * returns it to the queue, due now.
 */
export function settleSteeredCaseWork(
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
  const command = parseSlackCaseCommand(parseJsonOrNull(row.payload));
  if (!command.ok) return;
  sql.exec("DELETE FROM connector_case_steering WHERE event_id = ?", eventId);
  if (outcome === "placed") {
    settleConnectorCaseWork(sql, eventId, command.value, {
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
export function unparkRefusedSteer(sql: SqlStorage, eventId: string): void {
  const row = sql
    .exec<SteeredCaseWorkRow>(
      `SELECT event_id, payload, running_event_id, session_id, session_route_json
       FROM connector_case_steering WHERE event_id = ?`,
      eventId,
    )
    .toArray()[0];
  if (row === undefined) return;
  const command = parseSlackCaseCommand(parseJsonOrNull(row.payload));
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

function readSteeredCaseWork(
  sql: SqlStorage,
  eventId: string,
): SteeredCaseWork | null {
  const row = sql
    .exec<SteeredCaseWorkRow>(
      `SELECT event_id, payload, running_event_id, session_id, session_route_json
       FROM connector_case_steering WHERE event_id = ?`,
      eventId,
    )
    .toArray()[0];
  return row === undefined ? null : parseSteeredCaseWorkRow(row);
}

function parseSteeredCaseWorkRow(row: SteeredCaseWorkRow): SteeredCaseWork {
  const command = parseSlackCaseCommand(parseJsonOrNull(row.payload));
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
 * The message of a follow-up turn. The agent's note is not in it: the note
 * stays in the Session's history of the turn that scheduled it, under that
 * turn's label, and the follow-up turn reads it there. An Access change in
 * between gives the person a new Session without that history; the turn then
 * works from the person's earlier request in the thread.
 */
export const SLACK_FOLLOW_UP_TEXT =
  "Scheduled follow-up. Earlier in this thread you called schedule_follow_up, and its time has come. Read the note of that call, do the follow-up now and answer in this thread. If that call is not in your history, do what the person asked earlier in this thread.";

/** A Case holds at most this many follow-ups that wait for their time. */
const MAX_PENDING_FOLLOW_UPS = 3;

const FOLLOW_UP_EVENT_PREFIX = "followup_";

/**
 * Work that Pantry queued for a person instead of a message of that person: a
 * follow-up, a request that continues after a permission was allowed, or the
 * first work of a side Case that a person started. Its requester's authority
 * is read again when it runs.
 */
export function isDeferredSlackCaseWork(eventId: string): boolean {
  return (
    eventId.startsWith(FOLLOW_UP_EVENT_PREFIX) ||
    eventId.startsWith(PERMISSION_EVENT_PREFIX) ||
    isSlackSideCaseWork(eventId)
  );
}

export type SlackFollowUpRequest = {
  readonly identity: ConnectorIdentity;
  /** The Slack event of the running turn that schedules the follow-up. */
  readonly sourceEventId: string;
  /** Stable for one call of the tool, so a replayed call schedules nothing more. */
  readonly followUpId: string;
  readonly dueAt: number;
};

export type SlackFollowUpAcceptance =
  | { readonly kind: "scheduled" | "duplicate"; readonly dueAt: number }
  | { readonly kind: "limit_reached"; readonly dueAt?: never };

export function parseSlackFollowUpRequest(
  value: unknown,
): SlackFollowUpRequest | null {
  if (
    !isRecord(value) ||
    !isRecord(value.identity) ||
    !isNonBlankString(value.identity.organisationId) ||
    !isNonBlankString(value.identity.connectorId) ||
    !isNonBlankString(value.sourceEventId) ||
    typeof value.followUpId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.followUpId) ||
    !isPositiveInteger(value.dueAt)
  )
    return null;
  const organisationId = parseOrganisationId(value.identity.organisationId);
  const connectorId = parseConnectorId(value.identity.connectorId);
  if (!organisationId.ok || !connectorId.ok) return null;
  return {
    identity: {
      organisationId: organisationId.value,
      connectorId: connectorId.value,
    },
    sourceEventId: value.sourceEventId,
    followUpId: value.followUpId,
    dueAt: value.dueAt,
  };
}

/**
 * Queue a follow-up turn for the thread of a running turn. The follow-up is
 * that turn's command again, with a new event and the follow-up message, due
 * at its time. It keeps the requester and the request authority, which the
 * turn checks again when it runs. It waits in the Connector's Case work like
 * any message: it runs once, after the Case's earlier work, with retries.
 */
export function acceptSlackFollowUp(
  sql: SqlStorage,
  input: SlackFollowUpRequest,
):
  | { readonly ok: true; readonly value: SlackFollowUpAcceptance }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const eventId = `${FOLLOW_UP_EVENT_PREFIX}${input.followUpId}`;
  const waiting = readConnectorCaseWork(sql, eventId);
  if (waiting !== undefined)
    return { ok: true, value: { kind: "duplicate", dueAt: waiting.due_at } };
  if (readConnectorCaseWorkReceipt(sql, eventId) !== undefined)
    return { ok: true, value: { kind: "duplicate", dueAt: input.dueAt } };
  const source = readConnectorCaseWork(sql, input.sourceEventId);
  const sourceCommand =
    source !== undefined &&
    parseConnectorCaseWorkRow(source)?.kind === "running"
      ? parseSlackCaseCommand(parseJsonOrNull(source.payload))
      : null;
  if (sourceCommand === null || !sourceCommand.ok)
    return {
      ok: false,
      error: { code: "connector_follow_up_source_unavailable" },
    };
  if (
    pendingFollowUpCount(sql, sourceCommand.value.target.caseId) >=
    MAX_PENDING_FOLLOW_UPS
  )
    return { ok: true, value: { kind: "limit_reached" } };
  // The work is stored in the boundary parser's form, as admitted messages are.
  const followUp = parseSlackCaseCommand(
    parseJsonOrNull(
      JSON.stringify(
        slackFollowUpCommand(sourceCommand.value, eventId, input.dueAt, [
          { kind: "text", text: SLACK_FOLLOW_UP_TEXT },
        ]),
      ),
    ),
  );
  if (!followUp.ok)
    return { ok: false, error: { code: "connector_follow_up_invalid" } };
  const accepted = acceptConnectorCaseWork(sql, {
    identity: input.identity,
    command: followUp.value,
  });
  if (!accepted.ok) return accepted;
  return {
    ok: true,
    value: {
      kind: accepted.value.kind === "accepted" ? "scheduled" : "duplicate",
      dueAt: input.dueAt,
    },
  };
}

function slackFollowUpCommand(
  source: SlackCaseCommand,
  eventId: string,
  dueAt: number,
  authored: SlackCaseCommand["event"]["authored"],
): SlackCaseCommand {
  // A Slack timestamp of the due second. Its fraction makes it differ from the
  // thread's root, so the turn finds the thread's Case.
  const ts = `${Math.floor(dueAt / 1_000)}.${eventId.slice(-6).replace(/[^0-9]/gu, "0")}`;
  // The parser checks both identifiers when the work is stored.
  return {
    ...source,
    requestId: eventId as RequestId,
    receivedAt: dueAt,
    event: {
      ...source.event,
      trigger: "mention",
      eventId: eventId as SlackEventId,
      eventTs: ts,
      messageTs: ts,
      authored,
      files: [],
    },
  };
}

/**
 * The message of the turn that continues a request after a person allowed
 * the permission it needed. The new turn may run in a new Session, so the
 * person's own words follow the notice instead of a reference to the call.
 */
export const SLACK_PERMISSION_RESUME_TEXT =
  "Permission allowed. Earlier in this thread you asked an owner or admin for permission, and they allowed it. Do the person's request below now and answer in this thread. The request was:";

const PERMISSION_EVENT_PREFIX = "permission_";

export type SlackPermissionParkRequest = {
  readonly identity: ConnectorIdentity;
  /** The Slack event of the running turn that asks for the permission. */
  readonly sourceEventId: string;
  /** Stable for one call of the tool, so a replayed call parks nothing more. */
  readonly requestId: string;
};

type SlackPermissionNotice = {
  readonly identity: ConnectorIdentity;
  readonly requestId: string;
  /** Fixed platform text for the thread; it holds no model output. */
  readonly noticeText: string;
  /** A permission request's card. A held step's notice stays plain text. */
  readonly card: boolean;
};

export type SlackPermissionRelease = {
  readonly identity: ConnectorIdentity;
  readonly requestId: string;
  readonly decision: "allow" | "deny";
  /**
   * For an allow: the requester's authority now. An Access change supersedes
   * the authority of the asking turn, so the continued turn carries this one.
   */
  readonly requestAuthority: SlackCaseCommand["requestAuthority"] | null;
  /** Fixed platform text for the thread; it holds no model output. */
  readonly noticeText: string;
  /** The decision updates a permission request's card. */
  readonly card: boolean;
};

export function parseSlackPermissionParkRequest(
  value: unknown,
): SlackPermissionParkRequest | null {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.sourceEventId) ||
    !isPermissionRequestId(value.requestId)
  )
    return null;
  const identity = parseIdentityRecord(value.identity);
  if (identity === null) return null;
  return {
    identity,
    sourceEventId: value.sourceEventId,
    requestId: value.requestId,
  };
}

export function parseSlackPermissionNotice(
  value: unknown,
): SlackPermissionNotice | null {
  if (
    !isRecord(value) ||
    !isPermissionRequestId(value.requestId) ||
    !isPermissionNoticeText(value.noticeText)
  )
    return null;
  const identity = parseIdentityRecord(value.identity);
  if (identity === null) return null;
  return {
    identity,
    requestId: value.requestId,
    noticeText: value.noticeText,
    card: value.card === true,
  };
}

export function parseSlackPermissionRelease(
  value: unknown,
): SlackPermissionRelease | null {
  if (
    !isRecord(value) ||
    !isPermissionRequestId(value.requestId) ||
    (value.decision !== "allow" && value.decision !== "deny") ||
    !isPermissionNoticeText(value.noticeText)
  )
    return null;
  const identity = parseIdentityRecord(value.identity);
  if (identity === null) return null;
  const requestAuthority = parseSlackRequestAuthority(value.requestAuthority);
  if ((value.decision === "allow") !== (requestAuthority !== null)) return null;
  return {
    identity,
    requestId: value.requestId,
    decision: value.decision,
    requestAuthority,
    noticeText: value.noticeText,
    card: value.card === true,
  };
}

function parseSlackRequestAuthority(
  value: unknown,
): SlackCaseCommand["requestAuthority"] | null {
  const parsed = parseStoredRequestAuthority(value);
  if (!parsed.ok) return null;
  const authority = parsed.value.requestAuthority;
  return authority.kind === "direct_conversation" ||
    authority.kind === "shared_conversation"
    ? authority
    : null;
}

function isPermissionRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

function isPermissionNoticeText(value: unknown): value is string {
  return isNonBlankString(value) && value.length <= 1_000;
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
  return { organisationId: organisationId.value, connectorId: connectorId.value };
}

/**
 * Requests that wait for a person's decision. Each keeps the command of the
 * turn that asked, outside the work queue, so it never runs by itself. A
 * decision is stored once: a repeated release answers from it.
 */
function createConnectorParkedCaseWorkTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_parked_case_work (
    request_id TEXT PRIMARY KEY CHECK (length(request_id) = 32),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    decision TEXT CHECK (decision IS NULL OR decision IN ('allow', 'deny')),
    decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= created_at),
    CHECK ((decision IS NULL) = (decided_at IS NULL))
  )`);
}

type ParkedCaseWorkRow = {
  readonly payload: string;
  readonly decision: string | null;
  readonly decided_at: number | null;
};

/**
 * Keep the command of a running Slack turn until a person decides on the
 * permission that it asks for. It returns that command, whose thread gets the
 * notice. A repeated call returns the first one.
 */
export function parkSlackPermissionRequest(
  sql: SqlStorage,
  input: SlackPermissionParkRequest,
  now: number,
):
  | {
      readonly ok: true;
      readonly value: Readonly<{
        kind: "parked" | "duplicate";
        command: SlackCaseCommand;
      }>;
    }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const parked = readParkedCaseWork(sql, input.requestId);
  if (parked !== undefined) {
    const command = parseSlackCaseCommand(parseJsonOrNull(parked.payload));
    return command.ok
      ? { ok: true, value: { kind: "duplicate", command: command.value } }
      : { ok: false, error: { code: "connector_permission_invalid" } };
  }
  const source = readConnectorCaseWork(sql, input.sourceEventId);
  const sourceCommand =
    source !== undefined &&
    parseConnectorCaseWorkRow(source)?.kind === "running"
      ? parseSlackCaseCommand(parseJsonOrNull(source.payload))
      : null;
  if (sourceCommand === null || !sourceCommand.ok)
    return {
      ok: false,
      error: { code: "connector_permission_source_unavailable" },
    };
  if (
    sourceCommand.value.organisationId !== input.identity.organisationId ||
    sourceCommand.value.target.connectorId !== input.identity.connectorId
  )
    return {
      ok: false,
      error: { code: "connector_case_work_identity_mismatch" },
    };
  sql.exec(
    `INSERT INTO connector_parked_case_work (request_id, payload, created_at)
     VALUES (?, ?, ?)`,
    input.requestId,
    JSON.stringify(sourceCommand.value),
    now,
  );
  return { ok: true, value: { kind: "parked", command: sourceCommand.value } };
}

/**
 * Settle a parked request. Allow queues the turn that continues it, due now;
 * deny keeps nothing to run. The first decision is stored, and a repeated
 * release queues the same work again, which the queue answers as a
 * duplicate. It returns the asking command, whose thread gets the answer.
 */
export function releaseParkedSlackPermission(
  sql: SqlStorage,
  input: SlackPermissionRelease,
  now: number,
):
  | {
      readonly ok: true;
      readonly value: Readonly<{
        kind: "allowed" | "denied";
        command: SlackCaseCommand;
      }>;
    }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const parked = readParkedCaseWork(sql, input.requestId);
  if (parked === undefined)
    return { ok: false, error: { code: "connector_permission_not_found" } };
  const source = parseSlackCaseCommand(parseJsonOrNull(parked.payload));
  if (!source.ok)
    return { ok: false, error: { code: "connector_permission_invalid" } };
  let decision = parked.decision;
  let decidedAt = parked.decided_at;
  if (decision === null || decidedAt === null) {
    decision = input.decision;
    decidedAt = now;
    sql.exec(
      `UPDATE connector_parked_case_work SET decision = ?, decided_at = ?
       WHERE request_id = ? AND decision IS NULL`,
      decision,
      decidedAt,
      input.requestId,
    );
  }
  if (decision !== input.decision)
    return { ok: false, error: { code: "connector_permission_decided" } };
  if (decision === "deny")
    return { ok: true, value: { kind: "denied", command: source.value } };
  const eventId = `${PERMISSION_EVENT_PREFIX}${input.requestId}`;
  // The continued turn is queued once; a repeated release finds it.
  if (
    readConnectorCaseWork(sql, eventId) !== undefined ||
    readConnectorCaseWorkReceipt(sql, eventId) !== undefined
  )
    return { ok: true, value: { kind: "allowed", command: source.value } };
  const authority = input.requestAuthority;
  if (
    authority === null ||
    authority.kind !== source.value.requestAuthority.kind ||
    authority.requesterPersonId !==
      source.value.requestAuthority.requesterPersonId ||
    authority.connectorId !== source.value.requestAuthority.connectorId ||
    authority.integrationAccountId !==
      source.value.requestAuthority.integrationAccountId ||
    authority.conversationId !== source.value.requestAuthority.conversationId
  )
    return { ok: false, error: { code: "connector_permission_authority_invalid" } };
  const resumed = parseSlackCaseCommand(
    parseJsonOrNull(
      JSON.stringify({
        ...slackFollowUpCommand(source.value, eventId, decidedAt, [
          { kind: "text", text: SLACK_PERMISSION_RESUME_TEXT },
          ...source.value.event.authored,
        ]),
        requestAuthority: authority,
      }),
    ),
  );
  if (!resumed.ok)
    return { ok: false, error: { code: "connector_permission_invalid" } };
  const accepted = acceptConnectorCaseWork(sql, {
    identity: input.identity,
    command: resumed.value,
  });
  if (!accepted.ok) return accepted;
  return { ok: true, value: { kind: "allowed", command: source.value } };
}

/** The command of the turn that asked, or null when nothing is parked. */
export function readParkedSlackPermission(
  sql: SqlStorage,
  requestId: string,
): SlackCaseCommand | null {
  const parked = readParkedCaseWork(sql, requestId);
  if (parked === undefined) return null;
  const command = parseSlackCaseCommand(parseJsonOrNull(parked.payload));
  return command.ok ? command.value : null;
}

function readParkedCaseWork(
  sql: SqlStorage,
  requestId: string,
): ParkedCaseWorkRow | undefined {
  return sql
    .exec<ParkedCaseWorkRow>(
      `SELECT payload, decision, decided_at FROM connector_parked_case_work
       WHERE request_id = ?`,
      requestId,
    )
    .toArray()[0];
}

const SIDE_CASE_EVENT_PREFIX = "sidecase_";

/**
 * The first work of a side Case (Plan 74): its brief, which the agent wrote.
 * It is not a person's message, so it is never read as a command.
 */
export function isSlackSideCaseWork(eventId: string): boolean {
  return eventId.startsWith(SIDE_CASE_EVENT_PREFIX);
}

/**
 * Side Cases that an agent proposed in a thread of this Connector. Each keeps
 * the command of the proposing turn, outside the work queue: a start copies
 * it for the new thread. The Slack timestamps of the three posts of a side
 * Case are kept here, so a repeated step posts nothing more.
 */
function createConnectorSideCaseTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS connector_side_case (
    proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) = 32),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    proposal_ts TEXT,
    thread_ts TEXT,
    link_ts TEXT
  )`);
}

export type SlackSideCaseParkRequest = {
  readonly identity: ConnectorIdentity;
  /** The Slack event of the running turn that proposes the side Case. */
  readonly sourceEventId: string;
  /** Stable for one call of the tool, so a replayed call parks nothing more. */
  readonly proposalId: string;
};

export function parseSlackSideCaseParkRequest(
  value: unknown,
): SlackSideCaseParkRequest | null {
  if (
    !isRecord(value) ||
    !isNonBlankString(value.sourceEventId) ||
    !isSideCaseProposalId(value.proposalId)
  )
    return null;
  const identity = parseIdentityRecord(value.identity);
  if (identity === null) return null;
  return {
    identity,
    sourceEventId: value.sourceEventId,
    proposalId: value.proposalId,
  };
}

/**
 * Keep the command of a running Slack turn that proposes a side Case. It
 * returns that command, whose thread holds the proposal. A repeated call
 * returns the first one.
 */
export function parkSlackSideCaseCommand(
  sql: SqlStorage,
  input: SlackSideCaseParkRequest,
  now: number,
):
  | { readonly ok: true; readonly value: SlackCaseCommand }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const parked = readParkedSlackSideCase(sql, input.proposalId);
  if (parked !== null) return { ok: true, value: parked.command };
  const source = readConnectorCaseWork(sql, input.sourceEventId);
  const sourceCommand =
    source !== undefined &&
    parseConnectorCaseWorkRow(source)?.kind === "running"
      ? parseSlackCaseCommand(parseJsonOrNull(source.payload))
      : null;
  if (sourceCommand === null || !sourceCommand.ok)
    return {
      ok: false,
      error: { code: "connector_side_case_source_unavailable" },
    };
  if (
    sourceCommand.value.organisationId !== input.identity.organisationId ||
    sourceCommand.value.target.connectorId !== input.identity.connectorId
  )
    return {
      ok: false,
      error: { code: "connector_case_work_identity_mismatch" },
    };
  sql.exec(
    `INSERT INTO connector_side_case (proposal_id, payload, created_at)
     VALUES (?, ?, ?)`,
    input.proposalId,
    JSON.stringify(sourceCommand.value),
    now,
  );
  return { ok: true, value: sourceCommand.value };
}

export type ParkedSlackSideCase = Readonly<{
  command: SlackCaseCommand;
  /** The proposal message in the proposing thread. */
  proposalTs: string | null;
  /** The root of the side Case's own thread. */
  threadTs: string | null;
  /** The line in the proposing thread that links to the new thread. */
  linkTs: string | null;
}>;

type SlackSideCasePost = "proposal" | "thread" | "link";

type ConnectorSideCaseRow = Record<string, SqlStorageValue> & {
  readonly payload: string;
  readonly proposal_ts: string | null;
  readonly thread_ts: string | null;
  readonly link_ts: string | null;
};

export function readParkedSlackSideCase(
  sql: SqlStorage,
  proposalId: string,
): ParkedSlackSideCase | null {
  const row = sql
    .exec<ConnectorSideCaseRow>(
      `SELECT payload, proposal_ts, thread_ts, link_ts FROM connector_side_case
       WHERE proposal_id = ?`,
      proposalId,
    )
    .toArray()[0];
  if (row === undefined) return null;
  const command = parseSlackCaseCommand(parseJsonOrNull(row.payload));
  if (!command.ok) throw new Error("connector_side_case_corrupt");
  return {
    command: command.value,
    proposalTs: row.proposal_ts,
    threadTs: row.thread_ts,
    linkTs: row.link_ts,
  };
}

/** Keep the timestamp of one post of a side Case. The first one stays. */
export function recordSlackSideCasePost(
  sql: SqlStorage,
  proposalId: string,
  post: SlackSideCasePost,
  ts: string,
): void {
  const column = SIDE_CASE_POST_COLUMNS[post];
  sql.exec(
    `UPDATE connector_side_case SET ${column} = ?
     WHERE proposal_id = ? AND ${column} IS NULL`,
    ts,
    proposalId,
  );
}

const SIDE_CASE_POST_COLUMNS: Readonly<Record<SlackSideCasePost, string>> = {
  proposal: "proposal_ts",
  thread: "thread_ts",
  link: "link_ts",
};

/**
 * The first work of a side Case: the proposing turn's command, copied to the
 * new thread. Its message is the brief, its requester is the person who
 * started the side Case, and its event is named by the proposal, so a
 * repeated start queues it once. The requester's authority is read again
 * when it runs, as for a follow-up.
 */
export function slackSideCaseCommand(
  source: SlackCaseCommand,
  input: Readonly<{
    proposalId: string;
    brief: string;
    receivedAt: number;
    threadTs: string;
    thread: Pick<SlackCaseCommand["event"], "sessionId" | "threadKey">;
    starter: Pick<
      SlackCaseCommand,
      "principalId" | "userId" | "requestAuthority"
    > &
      Readonly<{ author: SlackCaseCommand["event"]["author"] }>;
    target: SlackCaseCommand["target"];
  }>,
): SlackCaseCommand {
  const eventId = `${SIDE_CASE_EVENT_PREFIX}${input.proposalId}`;
  // The parser checks both identifiers when the work is stored.
  return {
    ...source,
    requestId: eventId as RequestId,
    receivedAt: input.receivedAt,
    principalId: input.starter.principalId,
    userId: input.starter.userId,
    requestAuthority: input.starter.requestAuthority,
    event: {
      ...source.event,
      trigger: "mention",
      sessionId: input.thread.sessionId,
      threadKey: input.thread.threadKey,
      eventId: eventId as SlackEventId,
      eventTs: input.threadTs,
      messageTs: input.threadTs,
      threadTs: input.threadTs,
      author: input.starter.author,
      authored: [{ kind: "text", text: input.brief }],
      files: [],
    },
    target: input.target,
  };
}

/**
 * Queue the first work of a side Case in the boundary parser's form, as
 * admitted messages are stored. A repeated call answers as a duplicate.
 */
export function acceptSlackSideCaseWork(
  sql: SqlStorage,
  identity: ConnectorIdentity,
  command: SlackCaseCommand,
):
  | { readonly ok: true; readonly value: ConnectorCaseWorkAcceptance }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  if (!isSlackSideCaseWork(String(command.event.eventId)))
    return { ok: false, error: { code: "connector_side_case_invalid" } };
  const parsed = parseSlackCaseCommand(parseJsonOrNull(JSON.stringify(command)));
  if (!parsed.ok)
    return { ok: false, error: { code: "connector_side_case_invalid" } };
  return acceptConnectorCaseWork(sql, { identity, command: parsed.value });
}

function pendingFollowUpCount(sql: SqlStorage, caseId: string): number {
  const row = sql
    .exec<CountRow>(
      `SELECT COUNT(*) AS count FROM connector_case_work
       WHERE substr(event_id, 1, ?) = ?
         AND json_extract(payload, '$.target.caseId') = ?`,
      FOLLOW_UP_EVENT_PREFIX.length,
      FOLLOW_UP_EVENT_PREFIX,
      caseId,
    )
    .one();
  return row.count;
}

/**
 * Claim the earliest due item. An item whose Case is listed as busy is left
 * for later, so the messages of one Case never run at the same time.
 */
export function claimConnectorCaseWork(
  sql: SqlStorage,
  now: number,
  busyCaseIds: readonly string[] = [],
):
  | {
      readonly ok: true;
      readonly value: ConnectorCaseWorkQuery<ConnectorCaseWorkClaim | null>;
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
    const parsed = parseSlackCaseCommand(parseJsonOrNull(row.payload));
    if (!parsed.ok)
      return { ok: false, error: { code: "connector_case_work_corrupt" } };
    const canonicalEventId = readConnectorCaseNativeEventId(
      sql,
      slackNativeMessageId(parsed.value),
    );
    if (canonicalEventId !== undefined && canonicalEventId !== row.event_id) {
      settleConnectorCaseWork(sql, row.event_id, parsed.value, {
        kind: "rejected",
        reason: "connector_case_work_duplicate_native_message",
        settledAt: now,
      });
      continue;
    }
    // Only a notice claim whose lease ran out comes this far. Its post has
    // no known result, so the receipt says that the thread was not told.
    if (attempt > CASE_WORK_MAX_ATTEMPTS + CASE_WORK_NOTICE_ATTEMPTS) {
      settleConnectorCaseWork(sql, row.event_id, parsed.value, {
        kind: "rejected",
        reason: CASE_WORK_EXHAUSTED_NOTICE_UNDELIVERED,
        settledAt: now,
      });
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

export function finalizeConnectorCaseWork(
  sql: SqlStorage,
  claim: ConnectorCaseWorkClaim,
  result: ConnectorCaseWorkResult,
):
  | { readonly ok: true; readonly value: null }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const row = readConnectorCaseWork(sql, claim.command.event.eventId);
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
        claim.command.event.eventId,
      );
      return { ok: true, value: null };
    case "completed":
      settleConnectorCaseWork(sql, row.event_id, claim.command, {
        kind: "completed",
        settledAt: result.completedAt,
      });
      return { ok: true, value: null };
    case "rejected":
      settleConnectorCaseWork(sql, row.event_id, claim.command, {
        kind: "rejected",
        reason: result.reason,
        settledAt: result.rejectedAt,
      });
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
  command: SlackCaseCommand,
  receipt: ConnectorCaseWorkReceipt,
): void {
  sql.exec(
    `INSERT INTO connector_case_work_receipt (
       event_id, stable_command, outcome, reason, settled_at
     ) VALUES (?, ?, ?, ?, ?)`,
    eventId,
    stableSlackCaseCommandJson(command),
    receipt.kind,
    receipt.kind === "rejected" ? receipt.reason : null,
    receipt.settledAt,
  );
  sql.exec("DELETE FROM connector_case_work WHERE event_id = ?", eventId);
}

function sameSlackCaseCommand(
  left: SlackCaseCommand,
  right: SlackCaseCommand,
): boolean {
  return stableSlackCaseCommandJson(left) === stableSlackCaseCommandJson(right);
}

function stableSlackCaseCommandJson(command: SlackCaseCommand): string {
  return JSON.stringify({
    type: command.type,
    organisationId: command.organisationId,
    integrationAccountId: command.integrationAccountId,
    event: stableSlackCaseEvent(command),
    principalId: command.principalId,
    requestAuthority: command.requestAuthority,
    target: {
      caseId: command.target.caseId,
      connectorId: command.target.connectorId,
      sessionId: command.target.sessionId,
      assignmentId: command.target.assignmentId,
    },
  });
}

function slackNativeMessageId(command: SlackCaseCommand): string {
  const event = command.event;
  return `slack_message:${event.workspaceId}:${event.channelId}:${event.messageTs}`;
}

function stableSlackCaseEvent(
  command: SlackCaseCommand,
): Omit<SlackCaseCommand["event"], "eventId" | "trigger"> {
  const event = command.event;
  return {
    surfaceKind: event.surfaceKind,
    appId: event.appId,
    workspaceId: event.workspaceId,
    channelId: event.channelId,
    sessionId: event.sessionId,
    threadKey: event.threadKey,
    eventTs: event.eventTs,
    messageTs: event.messageTs,
    threadTs: event.threadTs,
    author: event.author,
    authored: event.authored,
    files: event.files,
  };
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
