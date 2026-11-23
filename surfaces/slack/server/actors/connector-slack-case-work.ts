import { isSideCaseProposalId } from "@purin-labs/control-api";
import type { ConnectorIdentity } from "@purin-labs/contracts";

import {
  parseConnectorId,
  parseOrganisationId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import {
  parseSlackCaseCommand,
  type SlackCaseCommand,
} from "../case-command-message";
import { parseStoredRequestAuthority } from "@purin-labs/authority/request-authority/index";
import type { SlackEventId } from "../events";
import {
  acceptConnectorCaseWork,
  caseWorkPresence,
  countCaseWorkWithEventPrefix,
  parseIdentityRecord,
  readRunningCaseWorkCommand,
  type CaseWorkCodec,
  type ConnectorCaseWorkAcceptance,
  type ConnectorCaseWorkError,
  type ConnectorCaseWorkRequest,
} from "@purin-labs/conversation/actors/connector-case-work";
import { ensureConnectorIdentity } from "@purin-labs/conversation/actors/connector/ingress-parsers";
import type { ConnectorResult } from "@purin-labs/conversation/actors/connector/types";
import {
  isNonBlankString,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";

/**
 * Slack messages are the Case work of a Connector. The queue holds each one
 * as a `SlackCaseCommand`, and this codec reads it.
 */
export const SLACK_CASE_WORK: CaseWorkCodec<SlackCaseCommand> = {
  parse: parseSlackCaseCommand,
  eventId: slackCaseEventId,
  nativeMessageId: slackNativeMessageId,
  stableJson: stableSlackCaseCommandJson,
};

export type SlackCaseWorkRequest = ConnectorCaseWorkRequest<SlackCaseCommand>;

/** Creates the tables of the Slack work that waits outside the queue. */
export function createSlackCaseWorkSchema(sql: SqlStorage): void {
  createConnectorParkedCaseWorkTable(sql);
  createConnectorSideCaseTable(sql);
}

export function acceptCaseWorkTransaction(
  sql: SqlStorage,
  input: SlackCaseWorkRequest,
): ConnectorResult<{
  readonly kind: "accepted" | "duplicate";
  readonly eventId: string;
}> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return acceptConnectorCaseWork(SLACK_CASE_WORK, sql, input);
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

export function acceptSlackFollowUpTransaction(
  sql: SqlStorage,
  input: SlackFollowUpRequest,
): ConnectorResult<SlackFollowUpAcceptance> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return acceptSlackFollowUp(sql, input);
}

/**
 * Queue a follow-up turn for the thread of a running turn. The follow-up is
 * that turn's command again, with a new event and the follow-up message, due
 * at its time. It keeps the requester and the request authority, which the
 * turn checks again when it runs. It waits in the Connector's Case work like
 * any message: it runs once, after the Case's earlier work, with retries.
 */
function acceptSlackFollowUp(
  sql: SqlStorage,
  input: SlackFollowUpRequest,
):
  | { readonly ok: true; readonly value: SlackFollowUpAcceptance }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const eventId = `${FOLLOW_UP_EVENT_PREFIX}${input.followUpId}`;
  const present = caseWorkPresence(sql, eventId);
  if (present?.kind === "waiting")
    return { ok: true, value: { kind: "duplicate", dueAt: present.dueAt } };
  if (present?.kind === "settled")
    return { ok: true, value: { kind: "duplicate", dueAt: input.dueAt } };
  const sourceCommand = readRunningCaseWorkCommand(
    SLACK_CASE_WORK,
    sql,
    input.sourceEventId,
  );
  if (sourceCommand === null)
    return {
      ok: false,
      error: { code: "connector_follow_up_source_unavailable" },
    };
  if (
    countCaseWorkWithEventPrefix(
      sql,
      FOLLOW_UP_EVENT_PREFIX,
      sourceCommand.target.caseId,
    ) >= MAX_PENDING_FOLLOW_UPS
  )
    return { ok: true, value: { kind: "limit_reached" } };
  // The work is stored in the boundary parser's form, as admitted messages are.
  const followUp = parseSlackCaseCommand(
    parseJsonOrNull(
      JSON.stringify(
        slackFollowUpCommand(sourceCommand, eventId, input.dueAt, [
          { kind: "text", text: SLACK_FOLLOW_UP_TEXT },
        ]),
      ),
    ),
  );
  if (!followUp.ok)
    return { ok: false, error: { code: "connector_follow_up_invalid" } };
  const accepted = acceptConnectorCaseWork(SLACK_CASE_WORK, sql, {
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

type SlackPermissionParkRequest = {
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

type SlackPermissionRelease = {
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

export type SlackPermissionParked = Readonly<{
  caseId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string | null;
}>;

export function parkSlackPermissionTransaction(
  sql: SqlStorage,
  input: SlackPermissionParkRequest,
  now: number,
): ReturnType<typeof parkSlackPermissionRequest> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return parkSlackPermissionRequest(sql, input, now);
}

/**
 * Keep the command of a running Slack turn until a person decides on the
 * permission that it asks for. It returns that command, whose thread gets the
 * notice. A repeated call returns the first one.
 */
function parkSlackPermissionRequest(
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
  const sourceCommand = readRunningCaseWorkCommand(
    SLACK_CASE_WORK,
    sql,
    input.sourceEventId,
  );
  if (sourceCommand === null)
    return {
      ok: false,
      error: { code: "connector_permission_source_unavailable" },
    };
  if (
    sourceCommand.organisationId !== input.identity.organisationId ||
    sourceCommand.target.connectorId !== input.identity.connectorId
  )
    return {
      ok: false,
      error: { code: "connector_case_work_identity_mismatch" },
    };
  sql.exec(
    `INSERT INTO connector_parked_case_work (request_id, payload, created_at)
     VALUES (?, ?, ?)`,
    input.requestId,
    JSON.stringify(sourceCommand),
    now,
  );
  return { ok: true, value: { kind: "parked", command: sourceCommand } };
}

export function releaseSlackPermissionTransaction(
  sql: SqlStorage,
  input: SlackPermissionRelease,
  now: number,
): ReturnType<typeof releaseParkedSlackPermission> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return releaseParkedSlackPermission(sql, input, now);
}

/**
 * Settle a parked request. Allow queues the turn that continues it, due now;
 * deny keeps nothing to run. The first decision is stored, and a repeated
 * release queues the same work again, which the queue answers as a
 * duplicate. It returns the asking command, whose thread gets the answer.
 */
function releaseParkedSlackPermission(
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
  if (caseWorkPresence(sql, eventId) !== null)
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
    return {
      ok: false,
      error: { code: "connector_permission_authority_invalid" },
    };
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
  const accepted = acceptConnectorCaseWork(SLACK_CASE_WORK, sql, {
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

type SlackSideCaseParkRequest = {
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

export type SlackSideCaseParked = Readonly<{
  caseId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterPersonId: string;
}>;

export function parkSlackSideCaseTransaction(
  sql: SqlStorage,
  input: SlackSideCaseParkRequest,
  now: number,
): ReturnType<typeof parkSlackSideCaseCommand> {
  const identity = ensureConnectorIdentity(sql, input.identity);
  if (!identity.ok) return identity;
  return parkSlackSideCaseCommand(sql, input, now);
}

/**
 * Keep the command of a running Slack turn that proposes a side Case. It
 * returns that command, whose thread holds the proposal. A repeated call
 * returns the first one.
 */
function parkSlackSideCaseCommand(
  sql: SqlStorage,
  input: SlackSideCaseParkRequest,
  now: number,
):
  | { readonly ok: true; readonly value: SlackCaseCommand }
  | { readonly ok: false; readonly error: ConnectorCaseWorkError } {
  const parked = readParkedSlackSideCase(sql, input.proposalId);
  if (parked !== null) return { ok: true, value: parked.command };
  const sourceCommand = readRunningCaseWorkCommand(
    SLACK_CASE_WORK,
    sql,
    input.sourceEventId,
  );
  if (sourceCommand === null)
    return {
      ok: false,
      error: { code: "connector_side_case_source_unavailable" },
    };
  if (
    sourceCommand.organisationId !== input.identity.organisationId ||
    sourceCommand.target.connectorId !== input.identity.connectorId
  )
    return {
      ok: false,
      error: { code: "connector_case_work_identity_mismatch" },
    };
  sql.exec(
    `INSERT INTO connector_side_case (proposal_id, payload, created_at)
     VALUES (?, ?, ?)`,
    input.proposalId,
    JSON.stringify(sourceCommand),
    now,
  );
  return { ok: true, value: sourceCommand };
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
  const parsed = parseSlackCaseCommand(
    parseJsonOrNull(JSON.stringify(command)),
  );
  if (!parsed.ok)
    return { ok: false, error: { code: "connector_side_case_invalid" } };
  return acceptConnectorCaseWork(SLACK_CASE_WORK, sql, {
    identity,
    command: parsed.value,
  });
}

function slackCaseEventId(command: SlackCaseCommand): string {
  return command.event.eventId;
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
