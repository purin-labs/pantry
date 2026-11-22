import {
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isSha256Hex,
  parseJson,
} from "@purin-labs/std";
import {
  MAX_REPLY_CITATIONS,
  type EmailChatContext,
  type EmailChatSource,
  type EmailReplySource,
  type EmailReplySourceRecord,
  type EmailReplySources,
  type EmailReplySpan,
} from "../mail-inbox/reply-sources";
import {
  MAX_EMAIL_COMMERCE_EVIDENCE,
  parseEmailCommerceEvidence,
} from "../mail-inbox/supplier-context";

/**
 * The records that a reply's draft cites, kept with the reply its turn
 * drafted. They are identities, read evidence and fingerprints of the cited
 * words, never the words: the body stays in Gmail. The count of refused
 * citations is kept beside them for the trace of the turn.
 */
export function createEmailProposalSourceSchema(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_source (
    proposal_id TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    spans_json TEXT NOT NULL CHECK (json_valid(spans_json)),
    PRIMARY KEY (proposal_id, number)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_source_outcome (
    proposal_id TEXT PRIMARY KEY,
    accepted INTEGER NOT NULL CHECK (accepted >= 0),
    dropped INTEGER NOT NULL CHECK (dropped >= 0)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_chat_source (
    proposal_id TEXT PRIMARY KEY,
    sources_json TEXT NOT NULL CHECK (json_valid(sources_json))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS email_proposal_chat_context (
    proposal_id TEXT PRIMARY KEY,
    context_json TEXT NOT NULL CHECK (json_valid(context_json))
  )`);
}

/** The most sources that one chat-drafted reply keeps. */
export const MAX_CHAT_SOURCES = 32;
/** The most Memories and Projects together that one chat-drafted reply keeps. */
export const MAX_CHAT_CONTEXT_RECORDS = 64;

const NO_CHAT_CONTEXT: EmailChatContext = { memory: [], projects: [] };

/**
 * Keeps what a Portal chat cited, every source that the chat read and the
 * Memories and Projects that its context showed, for a reply that has no
 * draft yet. A later attempt of the same turn replaces them all: it read at
 * least what the earlier one read.
 */
export function recordChatReplyProvenance(
  sql: SqlStorage,
  proposalId: string,
  provenance: Readonly<{
    sources: EmailReplySources;
    chatSources: readonly EmailChatSource[];
    chatContext: EmailChatContext;
  }>,
): void {
  clearEmailProposalSources(sql, proposalId);
  recordEmailProposalSources(sql, proposalId, provenance.sources);
  sql.exec(
    "INSERT INTO email_proposal_chat_source (proposal_id, sources_json) VALUES (?, ?)",
    proposalId,
    JSON.stringify(provenance.chatSources),
  );
  sql.exec(
    "INSERT INTO email_proposal_chat_context (proposal_id, context_json) VALUES (?, ?)",
    proposalId,
    JSON.stringify(provenance.chatContext),
  );
}

/**
 * Plan 40D: adds what a Portal chat that edits a reply's shared draft read
 * to the reply's chat sources and context. The reply's review then needs the
 * reader to read them too. False when the reply would keep more than the
 * limits allow; nothing changes then.
 */
export function recordChatEditProvenance(
  sql: SqlStorage,
  proposalId: string,
  provenance: Readonly<{
    chatSources: readonly EmailChatSource[];
    chatContext: EmailChatContext;
  }>,
): boolean {
  const current = readEmailProposalChatContext(sql, proposalId);
  const sources = new Map<string, EmailChatSource>();
  for (const source of [
    ...readEmailProposalChatSources(sql, proposalId),
    ...provenance.chatSources,
  ])
    sources.set(
      JSON.stringify([source.integrationAccountId, source.resourceScope]),
      source,
    );
  const memory = new Map<
    string,
    Readonly<{ memoryId: string; revision: number }>
  >();
  for (const shown of [...current.memory, ...provenance.chatContext.memory])
    memory.set(JSON.stringify([shown.memoryId, shown.revision]), shown);
  const projects = new Set([
    ...current.projects,
    ...provenance.chatContext.projects,
  ]);
  if (
    sources.size > MAX_CHAT_SOURCES ||
    memory.size + projects.size > MAX_CHAT_CONTEXT_RECORDS
  )
    return false;
  sql.exec(
    `INSERT INTO email_proposal_chat_source (proposal_id, sources_json) VALUES (?, ?)
     ON CONFLICT(proposal_id) DO UPDATE SET sources_json = excluded.sources_json`,
    proposalId,
    JSON.stringify([...sources.values()]),
  );
  sql.exec(
    `INSERT INTO email_proposal_chat_context (proposal_id, context_json) VALUES (?, ?)
     ON CONFLICT(proposal_id) DO UPDATE SET context_json = excluded.context_json`,
    proposalId,
    JSON.stringify({ memory: [...memory.values()], projects: [...projects] }),
  );
  return true;
}

/**
 * The Memories and Projects that the context of the chat which drafted a
 * reply showed. A mailbox reply has none: its turn admitted only what the
 * mailbox's readers may receive.
 */
export function readEmailProposalChatContext(
  sql: SqlStorage,
  proposalId: string,
): EmailChatContext {
  const row = sql
    .exec<{ context_json: string }>(
      "SELECT context_json FROM email_proposal_chat_context WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (row === undefined) return NO_CHAT_CONTEXT;
  const parsed = parseEmailChatContext(parseJson(row.context_json));
  if (parsed === null) throw corrupt();
  return parsed;
}

/** A Session's record of a chat's context, or null when malformed. */
export function parseEmailChatContext(raw: unknown): EmailChatContext | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 2 ||
    !Array.isArray(raw.memory) ||
    !Array.isArray(raw.projects) ||
    raw.memory.length + raw.projects.length > MAX_CHAT_CONTEXT_RECORDS
  )
    return null;
  const memory: { memoryId: string; revision: number }[] = [];
  for (const entry of raw.memory) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      !text(entry.memoryId) ||
      !isPositiveInteger(entry.revision)
    )
      return null;
    memory.push({ memoryId: entry.memoryId, revision: entry.revision });
  }
  const projects: string[] = [];
  for (const projectId of raw.projects) {
    if (!text(projectId)) return null;
    projects.push(projectId);
  }
  return { memory, projects };
}

/**
 * The sources that the chat which drafted a reply read. A mailbox reply has
 * none: its own commerce evidence covers it.
 */
export function readEmailProposalChatSources(
  sql: SqlStorage,
  proposalId: string,
): readonly EmailChatSource[] {
  const row = sql
    .exec<{ sources_json: string }>(
      "SELECT sources_json FROM email_proposal_chat_source WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  if (row === undefined) return [];
  const parsed = parseEmailChatSources(parseJson(row.sources_json));
  if (parsed === null) throw corrupt();
  return parsed;
}

/** A Session's list of a chat's sources, or null when malformed. */
export function parseEmailChatSources(
  raw: unknown,
): readonly EmailChatSource[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CHAT_SOURCES) return null;
  const sources: EmailChatSource[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      !text(entry.integrationAccountId) ||
      !text(entry.resourceScope)
    )
      return null;
    sources.push({
      integrationAccountId: entry.integrationAccountId,
      resourceScope: entry.resourceScope,
    });
  }
  return sources;
}

/** A Session's verified sources of a draft, or null when malformed. */
export function parseEmailReplySources(raw: unknown): EmailReplySources | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 2 ||
    !isNonNegativeInteger(raw.dropped) ||
    !Array.isArray(raw.sources) ||
    raw.sources.length > MAX_REPLY_CITATIONS
  )
    return null;
  try {
    const sources = raw.sources.map((source: unknown, index) => {
      if (
        !isRecord(source) ||
        Object.keys(source).length !== 3 ||
        source.number !== index + 1
      )
        throw corrupt();
      return {
        number: index + 1,
        record: parseSourceRecord(source.record),
        spans: parseSpans(source.spans),
      };
    });
    return { sources, dropped: raw.dropped };
  } catch {
    return null;
  }
}

/** Keeps what the turn cited. A repeat of the same turn keeps the first. */
export function recordEmailProposalSources(
  sql: SqlStorage,
  proposalId: string,
  outcome: EmailReplySources,
): void {
  const existing = sql
    .exec(
      "SELECT 1 FROM email_proposal_source_outcome WHERE proposal_id = ?",
      proposalId,
    )
    .toArray();
  if (existing.length > 0) return;
  sql.exec(
    "INSERT INTO email_proposal_source_outcome (proposal_id, accepted, dropped) VALUES (?, ?, ?)",
    proposalId,
    outcome.sources.length,
    outcome.dropped,
  );
  for (const source of outcome.sources)
    sql.exec(
      "INSERT INTO email_proposal_source (proposal_id, number, record_json, spans_json) VALUES (?, ?, ?, ?)",
      proposalId,
      source.number,
      JSON.stringify(source.record),
      JSON.stringify(source.spans),
    );
}

export function readEmailProposalSources(
  sql: SqlStorage,
  proposalId: string,
): readonly EmailReplySource[] {
  return sql
    .exec<{ number: number; record_json: string; spans_json: string }>(
      `SELECT number, record_json, spans_json FROM email_proposal_source
       WHERE proposal_id = ? ORDER BY number`,
      proposalId,
    )
    .toArray()
    .map((row) => ({
      number: row.number,
      record: parseSourceRecord(parseJson(row.record_json)),
      spans: parseSpans(parseJson(row.spans_json)),
    }));
}

/** How many citations the turn made that were refused, or null if none were recorded. */
export function readEmailProposalSourceOutcome(
  sql: SqlStorage,
  proposalId: string,
): Readonly<{ accepted: number; dropped: number }> | null {
  const row = sql
    .exec<{ accepted: number; dropped: number }>(
      "SELECT accepted, dropped FROM email_proposal_source_outcome WHERE proposal_id = ?",
      proposalId,
    )
    .toArray()[0];
  return row === undefined
    ? null
    : { accepted: row.accepted, dropped: row.dropped };
}

/**
 * A corrected purchasing link replaces the purchase request the reply rests
 * on, so the agent's citation of the earlier one no longer stands.
 */
export function dropEmailProposalPurchaseRequestSources(
  sql: SqlStorage,
  proposalId: string,
): void {
  sql.exec(
    "DELETE FROM email_proposal_source WHERE proposal_id = ? AND json_extract(record_json, '$.kind') = 'purchase_request'",
    proposalId,
  );
}

/** Removes the record of a proposal whose turn is to run afresh. */
export function clearEmailProposalSources(
  sql: SqlStorage,
  proposalId: string,
): void {
  sql.exec(
    "DELETE FROM email_proposal_source WHERE proposal_id = ?",
    proposalId,
  );
  sql.exec(
    "DELETE FROM email_proposal_source_outcome WHERE proposal_id = ?",
    proposalId,
  );
  sql.exec(
    "DELETE FROM email_proposal_chat_source WHERE proposal_id = ?",
    proposalId,
  );
  sql.exec(
    "DELETE FROM email_proposal_chat_context WHERE proposal_id = ?",
    proposalId,
  );
}

function parseSourceRecord(raw: unknown): EmailReplySourceRecord {
  if (!isRecord(raw)) throw corrupt();
  if (
    raw.kind === "memory" &&
    Object.keys(raw).length === 3 &&
    text(raw.memoryId) &&
    isPositiveInteger(raw.revision)
  )
    return { kind: "memory", memoryId: raw.memoryId, revision: raw.revision };
  if (
    raw.kind === "order" &&
    Object.keys(raw).length === 3 &&
    text(raw.orderId)
  )
    return {
      kind: "order",
      orderId: raw.orderId,
      evidence: parseEvidence(raw.evidence),
    };
  if (
    raw.kind === "chat_order" &&
    Object.keys(raw).length === 4 &&
    text(raw.orderId) &&
    isPositiveInteger(raw.revision)
  ) {
    const [source] = parseEmailChatSources([raw.source]) ?? [];
    if (source === undefined) throw corrupt();
    return {
      kind: "chat_order",
      orderId: raw.orderId,
      revision: raw.revision,
      source,
    };
  }
  if (
    raw.kind === "purchase_request" &&
    Object.keys(raw).length === 4 &&
    text(raw.purchaseRequestId) &&
    text(raw.supplierId)
  )
    return {
      kind: "purchase_request",
      purchaseRequestId: raw.purchaseRequestId,
      supplierId: raw.supplierId,
      evidence: parseEvidence(raw.evidence),
    };
  throw corrupt();
}

function parseEvidence(raw: unknown) {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_EMAIL_COMMERCE_EVIDENCE
  )
    throw corrupt();
  return raw.map(parseEmailCommerceEvidence);
}

function parseSpans(raw: unknown): readonly EmailReplySpan[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_REPLY_CITATIONS
  )
    throw corrupt();
  return raw.map((span: unknown) => {
    if (
      !isRecord(span) ||
      Object.keys(span).length !== 4 ||
      !isNonNegativeInteger(span.start) ||
      !isPositiveInteger(span.end) ||
      span.end <= span.start ||
      !isSha256Hex(span.digest) ||
      !isNonNegativeInteger(span.fingerprint) ||
      span.fingerprint > 0xffff_ffff
    )
      throw corrupt();
    return {
      start: span.start,
      end: span.end,
      digest: span.digest,
      fingerprint: span.fingerprint,
    };
  });
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value === value.trim()
  );
}

function corrupt(): Error {
  return new Error("email_proposal_source_corrupt");
}
