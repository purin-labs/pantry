import { memoryObservationRecordId } from "../context/assembly";
import { ObservationEvidence } from "@purin-labs/authority/policy/index";
import {
  replySourceReference,
  verifyReplySources,
  type EmailChatContext,
  type EmailChatSource,
  type EmailReplyCitation,
  type EmailReplySourceRecord,
  type EmailReplySources,
} from "../mail-inbox/reply-sources";
import {
  MAX_CHAT_CONTEXT_RECORDS,
  MAX_CHAT_SOURCES,
} from "./email-proposal-sources";

const COMMERCE_RESOURCE_PREFIX = "commerce:";
const MEMORY_RECORD_PREFIX = memoryObservationRecordId("");

type ChatSession = Readonly<{ organisationId: string; sessionId: string }>;

/**
 * What a reply that a Portal chat agent drafts rests on. A citation is kept
 * only when this chat's Session holds a record that it read the record: an
 * order that one of its commerce reads returned, or a Memory revision that
 * its accepted context showed the model. The cited words must be in the
 * body. The chat's model sees the whole conversation, so a record that an
 * earlier turn of the same chat read counts.
 *
 * Every source that the chat read covers the reply, cited or not, because
 * the reply's words can come from any of them: the commerce data, a file,
 * any other connector, a Memory or a Project that its context showed.
 */
export async function readChatReplyProvenance(
  sql: SqlStorage,
  input: ChatSession &
    Readonly<{
      body: string;
      citations: readonly EmailReplyCitation[];
      malformed: number;
    }>,
): Promise<
  Readonly<{
    sources: EmailReplySources;
    chatSources: readonly EmailChatSource[];
    chatContext: EmailChatContext;
  }>
> {
  const reads = new Map<string, EmailReplySourceRecord>();
  for (const citation of input.citations) {
    if (reads.has(citation.source)) continue;
    const record = await readCitedRecord(sql, input, citation.source);
    if (record !== null) reads.set(replySourceReference(record), record);
  }
  return {
    sources: await verifyReplySources({
      body: input.body,
      citations: input.citations,
      malformed: input.malformed,
      reads,
    }),
    chatSources: readChatSources(sql, input),
    chatContext: await readChatContext(sql, input),
  };
}

async function readCitedRecord(
  sql: SqlStorage,
  session: ChatSession,
  reference: string,
): Promise<EmailReplySourceRecord | null> {
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const id = reference.slice(separator + 1);
  if (separator <= 0 || id.length === 0 || id.trim() !== id) return null;
  switch (kind) {
    case "order":
      return readObservedOrder(sql, session, id);
    case "memory":
      return readShownMemory(sql, session, id);
    default:
      return null;
  }
}

/**
 * The latest revision of an order that one of this chat's committed commerce
 * reads returned, with the source that read used. A read of Commerce names
 * the order by its canonical identity, which ends in the reference the model
 * saw.
 */
async function readObservedOrder(
  sql: SqlStorage,
  session: ChatSession,
  orderId: string,
): Promise<EmailReplySourceRecord | null> {
  const rows = sql
    .exec<{ entityId: string; revision: number; evidenceJson: string }>(
      `SELECT entity.entity_id AS entityId, entity.revision AS revision,
              observation.evidence_json AS evidenceJson
         FROM session_commerce_observation_entity AS entity
         JOIN session_information_flow_observation AS observation
           ON observation.session_id = entity.session_id
          AND observation.evidence_digest = entity.evidence_digest
        WHERE entity.session_id = ? AND entity.organisation_id = ?
          AND observation.organisation_id = entity.organisation_id
          AND entity.entity_type = 'order'
          AND (entity.entity_id = ?
            OR (substr(entity.entity_id, 1, ?) = ?
              AND substr(entity.entity_id, -?) = ?))
        ORDER BY entity.observed_at DESC, observation.recorded_at DESC`,
      session.sessionId,
      session.organisationId,
      orderId,
      COMMERCE_RESOURCE_PREFIX.length,
      COMMERCE_RESOURCE_PREFIX,
      orderId.length + 1,
      `:${orderId}`,
    )
    .toArray();
  for (const row of rows) {
    if (!namesOrder(row.entityId, orderId)) continue;
    const evidence = await restoreObservation(row.evidenceJson);
    if (evidence?.source.kind !== "integration_resource") continue;
    return {
      kind: "chat_order",
      orderId,
      revision: row.revision,
      source: {
        integrationAccountId: evidence.source.integrationAccountId,
        resourceScope: evidence.source.resourceScope,
      },
    };
  }
  return null;
}

/** Whether a stored entity identity names the order that the model saw. */
function namesOrder(entityId: string, orderId: string): boolean {
  if (entityId === orderId) return true;
  if (!entityId.startsWith(COMMERCE_RESOURCE_PREFIX)) return false;
  const rest = entityId.slice(COMMERCE_RESOURCE_PREFIX.length);
  const merchantEnd = rest.indexOf(":");
  return merchantEnd > 0 && rest.slice(merchantEnd + 1) === orderId;
}

/** The latest revision of a Memory that this chat's accepted context showed. */
async function readShownMemory(
  sql: SqlStorage,
  session: ChatSession,
  memoryId: string,
): Promise<EmailReplySourceRecord | null> {
  const row = sql
    .exec<{ evidenceJson: string }>(
      `SELECT evidence_json AS evidenceJson
         FROM session_information_flow_observation
        WHERE session_id = ? AND organisation_id = ?
          AND json_extract(evidence_json, '$.source.kind') = 'organisation_record'
          AND json_extract(evidence_json, '$.source.recordId') = ?
        ORDER BY recorded_at DESC LIMIT 1`,
      session.sessionId,
      session.organisationId,
      memoryObservationRecordId(memoryId),
    )
    .toArray()[0];
  const evidence =
    row === undefined ? null : await restoreObservation(row.evidenceJson);
  return evidence?.source.kind === "organisation_record" &&
    evidence.source.recordId === memoryObservationRecordId(memoryId)
    ? { kind: "memory", memoryId, revision: evidence.sourceRevision }
    : null;
}

/**
 * Each connector, file or commerce source that this chat's accepted reads
 * used, once. Too many to keep fails the draft: a reply must not lose a
 * source that covers it.
 */
function readChatSources(
  sql: SqlStorage,
  session: ChatSession,
): readonly EmailChatSource[] {
  const rows = sql
    .exec<{
      integrationAccountId: SqlStorageValue;
      resourceScope: SqlStorageValue;
    }>(
      `SELECT DISTINCT
              json_extract(evidence_json, '$.source.integrationAccountId') AS integrationAccountId,
              json_extract(evidence_json, '$.source.resourceScope') AS resourceScope
         FROM session_information_flow_observation
        WHERE session_id = ? AND organisation_id = ?
          AND json_extract(evidence_json, '$.source.kind') = 'integration_resource'
        ORDER BY integrationAccountId, resourceScope`,
      session.sessionId,
      session.organisationId,
    )
    .toArray();
  const sources: EmailChatSource[] = [];
  for (const row of rows) {
    if (
      typeof row.integrationAccountId !== "string" ||
      row.integrationAccountId.length === 0 ||
      typeof row.resourceScope !== "string"
    )
      throw new Error("Chat source observation is invalid");
    sources.push({
      integrationAccountId: row.integrationAccountId,
      resourceScope: row.resourceScope,
    });
  }
  if (sources.length > MAX_CHAT_SOURCES)
    throw new Error("The chat read too many sources to draft a reply");
  return sources;
}

/**
 * The Memory revisions and the Projects that this chat's accepted context
 * showed its model. Too many to keep fails the draft, as for its sources.
 */
async function readChatContext(
  sql: SqlStorage,
  session: ChatSession,
): Promise<EmailChatContext> {
  const rows = sql
    .exec<{ evidenceJson: string }>(
      `SELECT evidence_json AS evidenceJson
         FROM session_information_flow_observation
        WHERE session_id = ? AND organisation_id = ?
          AND json_extract(evidence_json, '$.source.kind') IN ('organisation_record', 'project')
        ORDER BY recorded_at`,
      session.sessionId,
      session.organisationId,
    )
    .toArray();
  const memory = new Map<string, number>();
  const projects = new Set<string>();
  for (const row of rows) {
    const evidence = await restoreObservation(row.evidenceJson);
    if (evidence === null)
      throw new Error("Chat context observation is invalid");
    const source = evidence.source;
    if (source.kind === "project") projects.add(source.projectId);
    else if (
      source.kind === "organisation_record" &&
      source.recordId.startsWith(MEMORY_RECORD_PREFIX)
    ) {
      const memoryId = source.recordId.slice(MEMORY_RECORD_PREFIX.length);
      if (memoryId.length === 0)
        throw new Error("Chat context observation is invalid");
      memory.set(
        memoryId,
        Math.max(memory.get(memoryId) ?? 0, evidence.sourceRevision),
      );
    }
  }
  if (memory.size + projects.size > MAX_CHAT_CONTEXT_RECORDS)
    throw new Error("The chat's context held too much to draft a reply");
  return {
    memory: [...memory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([memoryId, revision]) => ({ memoryId, revision })),
    projects: [...projects].sort(),
  };
}

async function restoreObservation(
  json: string,
): Promise<ObservationEvidence | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const restored = await ObservationEvidence.restore(raw);
  return restored.ok ? restored.value : null;
}
