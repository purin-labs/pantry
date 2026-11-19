import {
  mailIdentifier,
  mailRevision,
  type MailMatch,
} from "@purin-labs/control-api";
import { assertNever, isRecord } from "@purin-labs/std";
import { compareGmailHistoryIds } from "../mail/gmail-adapter";
import type { MailOrganizationHead } from "./types";
import type { Variant } from "@purin-labs/type-utils";

type InboxResponseState =
  | Readonly<{
      kind: "classifying" | "ready";
      caseId?: never;
      startedAt?: never;
      outcome?: never;
    }>
  | Readonly<{
      kind: "closed";
      outcome: "not_matched" | "needs_review" | "superseded";
      caseId?: never;
      startedAt?: never;
    }>
  | Readonly<{
      kind: "processing";
      caseId: string;
      startedAt: number;
      outcome?: never;
    }>
  | Readonly<{
      kind: "complete";
      caseId: string;
      outcome: "draft" | "no_reply" | "failed" | "interrupted";
      startedAt?: never;
    }>;

export type MailResponseOwner = Readonly<{
  messageId: string;
  threadId: string;
}> &
  (
    | Readonly<{
        kind: "cue";
        ruleRevision?: never;
        ruleId?: never;
        state?: never;
      }>
    | Readonly<{
        kind: "inbox";
        ruleRevision: number;
        ruleId: string;
        state: InboxResponseState;
      }>
  );
export type InboxResponseOwner = Variant<MailResponseOwner, "inbox">;
type ReadyInboxResponseOwner = InboxResponseOwner &
  Readonly<{ state: Readonly<{ kind: "ready" }> }>;

export function createMailResponseSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS mail_response_owner (
    message_id TEXT PRIMARY KEY, body TEXT NOT NULL, phase TEXT NOT NULL
  )`);
  sql.exec(
    "CREATE INDEX IF NOT EXISTS mail_response_phase ON mail_response_owner (phase)",
  );
}

export function readMailResponseOwner(
  sql: SqlStorage,
  messageId: string,
): MailResponseOwner | null {
  const row = sql
    .exec<{ body: string }>(
      "SELECT body FROM mail_response_owner WHERE message_id = ?",
      messageId,
    )
    .toArray()[0];
  return row === undefined ? null : parseStoredOwner(row.body);
}

export function claimMailResponseOwner(
  sql: SqlStorage,
  head: MailOrganizationHead | null,
  message: Readonly<{ messageId: string; threadId: string; historyId: string }>,
): MailResponseOwner {
  const existing = readMailResponseOwner(sql, message.messageId);
  if (existing !== null) return existing;
  const owner: MailResponseOwner =
    head !== null &&
    head.view.kind === "published" &&
    head.action.kind === "supplier_delay" &&
    compareGmailHistoryIds(message.historyId, head.action.historyFloor) > 0
      ? {
          kind: "inbox",
          messageId: message.messageId,
          threadId: message.threadId,
          ruleRevision: head.view.revision,
          ruleId: head.action.ruleId,
          state: { kind: "classifying" },
        }
      : {
          kind: "cue",
          messageId: message.messageId,
          threadId: message.threadId,
        };
  writeOwner(sql, owner);
  return owner;
}

export function decideInboxResponse(
  sql: SqlStorage,
  messageId: string,
  revision: number,
  outcome: MailMatch,
): void {
  const owner = readMailResponseOwner(sql, messageId);
  if (
    owner === null ||
    owner.kind !== "inbox" ||
    owner.ruleRevision !== revision ||
    (owner.state.kind !== "classifying" &&
      !(owner.state.kind === "ready" && outcome === "needs_review"))
  )
    return;
  writeInboxState(
    sql,
    owner,
    outcome === "matched" ? { kind: "ready" } : { kind: "closed", outcome },
  );
}

export function readyInboxResponses(
  sql: SqlStorage,
  revision: number,
): readonly ReadyInboxResponseOwner[] {
  const owners: ReadyInboxResponseOwner[] = [];
  for (const row of sql.exec<{ body: string }>(
    `SELECT owner.body FROM mail_response_owner AS owner
    WHERE owner.phase = 'ready' AND NOT EXISTS (
      SELECT 1 FROM mail_classification_work AS work
      WHERE work.thread_id = json_extract(owner.body, '$.threadId') AND work.revision = ?
        AND work.origin = 'arrival' AND work.state IN ('pending','evaluating','budget_paused')
    ) ORDER BY owner.message_id LIMIT 50`,
    revision,
  )) {
    const owner = parseStoredOwner(row.body);
    if (
      owner.kind === "inbox" &&
      owner.ruleRevision === revision &&
      owner.state.kind === "ready"
    )
      owners.push({
        kind: "inbox",
        messageId: owner.messageId,
        threadId: owner.threadId,
        ruleRevision: owner.ruleRevision,
        ruleId: owner.ruleId,
        state: { kind: "ready" },
      });
  }
  return owners;
}

export function startInboxResponse(
  sql: SqlStorage,
  owners: readonly ReadyInboxResponseOwner[],
  caseId: string,
  now: number,
): boolean {
  for (const owner of owners) {
    const current = readMailResponseOwner(sql, owner.messageId);
    if (
      current === null ||
      current.kind !== "inbox" ||
      current.ruleRevision !== owner.ruleRevision ||
      current.state.kind !== "ready"
    )
      return false;
  }
  for (const owner of owners)
    writeInboxState(sql, owner, { kind: "processing", caseId, startedAt: now });
  return true;
}

export type InboxResponseSettlement =
  | Readonly<{ kind: "retry"; outcome?: never }>
  | Readonly<{
      kind: "complete";
      outcome: Variant<InboxResponseState, "complete">["outcome"];
    }>;

export function settleInboxResponse(
  sql: SqlStorage,
  owners: readonly ReadyInboxResponseOwner[],
  caseId: string,
  settlement: InboxResponseSettlement,
): void {
  for (const owner of owners) {
    const current = readMailResponseOwner(sql, owner.messageId);
    if (
      current?.kind === "inbox" &&
      current.state.kind === "processing" &&
      current.state.caseId === caseId
    ) {
      switch (settlement.kind) {
        case "retry":
          writeInboxState(sql, current, { kind: "ready" });
          break;
        case "complete":
          writeInboxState(sql, current, {
            kind: "complete",
            caseId,
            outcome: settlement.outcome,
          });
          break;
        default:
          assertNever(settlement);
      }
    }
  }
}

export function closeSupersededInboxResponses(
  sql: SqlStorage,
  head: MailOrganizationHead,
): void {
  for (const row of sql.exec<{ body: string }>(
    "SELECT body FROM mail_response_owner WHERE phase IN ('classifying', 'ready')",
  )) {
    const owner = parseStoredOwner(row.body);
    if (
      owner.kind === "inbox" &&
      (head.view.kind === "paused" || owner.ruleRevision !== head.view.revision)
    )
      writeInboxState(sql, owner, { kind: "closed", outcome: "superseded" });
  }
}

export function recoverInterruptedInboxResponses(
  sql: SqlStorage,
  now: number,
): void {
  // A draft POST may have succeeded without a receipt. Recovery never repeats it.
  for (const row of sql.exec<{ body: string }>(
    "SELECT body FROM mail_response_owner WHERE phase = 'processing'",
  )) {
    const owner = parseStoredOwner(row.body);
    if (
      owner.kind === "inbox" &&
      owner.state.kind === "processing" &&
      owner.state.startedAt + 6 * 60_000 <= now
    )
      writeInboxState(sql, owner, {
        kind: "complete",
        caseId: owner.state.caseId,
        outcome: "interrupted",
      });
  }
}

export function failedInboxResponseCount(
  sql: SqlStorage,
  classificationRevision: number,
): number {
  let count = 0;
  for (const row of sql.exec<{ body: string }>(
    "SELECT body FROM mail_response_owner WHERE phase = 'complete'",
  )) {
    const owner = parseStoredOwner(row.body);
    if (
      owner.kind === "inbox" &&
      owner.ruleRevision >= classificationRevision &&
      owner.state.kind === "complete" &&
      (owner.state.outcome === "failed" ||
        owner.state.outcome === "interrupted")
    )
      count++;
  }
  return count;
}
export function pendingInboxResponseCount(sql: SqlStorage): number {
  return (
    sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM mail_response_owner WHERE phase IN ('ready', 'processing')",
      )
      .toArray()[0]?.count ?? 0
  );
}

function writeInboxState(
  sql: SqlStorage,
  owner: InboxResponseOwner,
  state: InboxResponseState,
): void {
  writeOwner(sql, {
    kind: "inbox",
    messageId: owner.messageId,
    threadId: owner.threadId,
    ruleRevision: owner.ruleRevision,
    ruleId: owner.ruleId,
    state,
  });
}
function writeOwner(sql: SqlStorage, owner: MailResponseOwner): void {
  sql.exec(
    "INSERT INTO mail_response_owner (message_id, body, phase) VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET body = excluded.body, phase = excluded.phase",
    owner.messageId,
    JSON.stringify(owner),
    owner.kind === "cue" ? "cue" : owner.state.kind,
  );
}
function parseStoredOwner(body: string): MailResponseOwner {
  const raw: unknown = JSON.parse(body);
  if (
    !isRecord(raw) ||
    !mailIdentifier(raw.messageId) ||
    !mailIdentifier(raw.threadId)
  )
    throw new Error("mail_response_owner_corrupt");
  if (raw.kind === "cue" && Object.keys(raw).length === 3)
    return { kind: "cue", messageId: raw.messageId, threadId: raw.threadId };
  if (
    raw.kind !== "inbox" ||
    Object.keys(raw).length !== 6 ||
    !mailRevision(raw.ruleRevision) ||
    raw.ruleRevision === 0 ||
    !mailIdentifier(raw.ruleId)
  )
    throw new Error("mail_response_owner_corrupt");
  const state = parseInboxState(raw.state);
  if (state === null) throw new Error("mail_response_owner_corrupt");
  return {
    kind: "inbox",
    messageId: raw.messageId,
    threadId: raw.threadId,
    ruleRevision: raw.ruleRevision,
    ruleId: raw.ruleId,
    state,
  };
}
function parseInboxState(raw: unknown): InboxResponseState | null {
  if (!isRecord(raw)) return null;
  if (
    (raw.kind === "classifying" || raw.kind === "ready") &&
    Object.keys(raw).length === 1
  )
    return { kind: raw.kind };
  if (
    raw.kind === "closed" &&
    Object.keys(raw).length === 2 &&
    (raw.outcome === "not_matched" ||
      raw.outcome === "needs_review" ||
      raw.outcome === "superseded")
  )
    return { kind: "closed", outcome: raw.outcome };
  if (!mailIdentifier(raw.caseId) || Object.keys(raw).length !== 3) return null;
  if (raw.kind === "processing" && mailRevision(raw.startedAt))
    return { kind: "processing", caseId: raw.caseId, startedAt: raw.startedAt };
  if (
    raw.kind === "complete" &&
    (raw.outcome === "draft" ||
      raw.outcome === "no_reply" ||
      raw.outcome === "failed" ||
      raw.outcome === "interrupted")
  )
    return { kind: "complete", caseId: raw.caseId, outcome: raw.outcome };
  return null;
}
