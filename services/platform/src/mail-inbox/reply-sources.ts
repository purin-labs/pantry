import { assertNever, isRecord, sha256Hex } from "@seams/std";
import type { EmailCommerceEvidence } from "./supplier-context";

/** The most citations that one draft may carry. More are dropped. */
export const MAX_REPLY_CITATIONS = 12;
/** The longest run of the draft's words that one citation may name. */
const MAX_REPLY_SPAN_CHARS = 600;

/**
 * A source that a Portal chat read: a connector, a file or the commerce
 * data, named by the integration and the resource scope of the grant that
 * its read used. Its label is derived again from the source's current
 * policy at each surface.
 */
export type EmailChatSource = Readonly<{
  integrationAccountId: string;
  resourceScope: string;
}>;

/**
 * The Memory revisions and the Projects that a Portal chat's accepted
 * context showed its model before it drafted a reply, by identity only. A
 * Memory keeps the latest revision that the chat was shown.
 */
export type EmailChatContext = Readonly<{
  memory: readonly Readonly<{ memoryId: string; revision: number }>[];
  projects: readonly string[];
}>;

/**
 * A record that a turn read and that its draft may cite, by identity only.
 * A mailbox turn's commerce record keeps the evidence of its read, which
 * names the grant, the source and the digest of the source's label. An order
 * that a Portal chat read keeps the revision it read and its source. A Memory
 * revision's label stays with the revision in the OrganisationActor.
 */
export type EmailReplySourceRecord =
  | Readonly<{
      kind: "memory";
      memoryId: string;
      revision: number;
      orderId?: never;
      purchaseRequestId?: never;
      supplierId?: never;
      evidence?: never;
      source?: never;
    }>
  | Readonly<{
      kind: "order";
      orderId: string;
      evidence: readonly EmailCommerceEvidence[];
      memoryId?: never;
      revision?: never;
      purchaseRequestId?: never;
      supplierId?: never;
      source?: never;
    }>
  | Readonly<{
      kind: "chat_order";
      orderId: string;
      /** The order's revision that the chat read. */
      revision: number;
      source: EmailChatSource;
      memoryId?: never;
      purchaseRequestId?: never;
      supplierId?: never;
      evidence?: never;
    }>
  | Readonly<{
      kind: "purchase_request";
      purchaseRequestId: string;
      supplierId: string;
      evidence: readonly EmailCommerceEvidence[];
      memoryId?: never;
      revision?: never;
      orderId?: never;
      source?: never;
    }>;

/** What the model claims: a record it names and the words it supports. */
export type EmailReplyCitation = Readonly<{ source: string; text: string }>;

/**
 * One run of the draft's words that a record supports. The words are not
 * kept: the Connector stores no body. A digest and a rolling fingerprint find
 * the same words again in the body that Gmail holds.
 */
export type EmailReplySpan = Readonly<{
  start: number;
  end: number;
  digest: string;
  fingerprint: number;
}>;

/** One cited record and the runs of the draft that it supports. */
export type EmailReplySource = Readonly<{
  number: number;
  record: EmailReplySourceRecord;
  spans: readonly EmailReplySpan[];
}>;

/**
 * The sources that a draft keeps, and how many citations were refused: a
 * citation of a record that the turn did not read, of words that are not in
 * the draft, or one that was malformed.
 */
export type EmailReplySources = Readonly<{
  sources: readonly EmailReplySource[];
  dropped: number;
}>;

export const NO_REPLY_SOURCES: EmailReplySources = { sources: [], dropped: 0 };

/** A source as it stands in one body: its record and where its words are. */
export type LocatedReplySource = Readonly<{
  number: number;
  record: EmailReplySourceRecord;
  spans: readonly Readonly<{ start: number; end: number }>[];
}>;

/** The name by which the model cites a record. */
export function replySourceReference(record: EmailReplySourceRecord): string {
  switch (record.kind) {
    case "memory":
      return `memory:${record.memoryId}`;
    case "order":
    case "chat_order":
      return `order:${record.orderId}`;
    case "purchase_request":
      return `purchase_request:${record.purchaseRequestId}`;
    default:
      return assertNever(record);
  }
}

/**
 * The citations of a reply tool call. An absent list is empty. An entry that
 * is not a source and a text is counted as malformed, and so are entries
 * beyond the limit.
 */
export function parseReplyCitations(
  raw: unknown,
): Readonly<{ citations: readonly EmailReplyCitation[]; malformed: number }> {
  if (raw === undefined || raw === null) return { citations: [], malformed: 0 };
  if (!Array.isArray(raw)) return { citations: [], malformed: 1 };
  const citations: EmailReplyCitation[] = [];
  let malformed = 0;
  for (const entry of raw) {
    if (
      citations.length >= MAX_REPLY_CITATIONS ||
      !isRecord(entry) ||
      typeof entry.source !== "string" ||
      typeof entry.text !== "string"
    ) {
      malformed++;
      continue;
    }
    citations.push({ source: entry.source.trim(), text: entry.text.trim() });
  }
  return { citations, malformed };
}

/**
 * Keeps a citation only when the turn read the record it names and its words
 * are in the body. The model's claim alone proves neither: `reads` holds the
 * records that the Session recorded for this turn. Sources are numbered in
 * the order in which their words first appear.
 */
export async function verifyReplySources(
  input: Readonly<{
    body: string;
    citations: readonly EmailReplyCitation[];
    malformed: number;
    reads: ReadonlyMap<string, EmailReplySourceRecord>;
  }>,
): Promise<EmailReplySources> {
  let dropped = input.malformed;
  const spans = new Map<string, EmailReplySpan[]>();
  for (const citation of input.citations) {
    const record = input.reads.get(citation.source);
    const start =
      citation.text.length === 0 || citation.text.length > MAX_REPLY_SPAN_CHARS
        ? -1
        : input.body.indexOf(citation.text);
    if (record === undefined || start < 0) {
      dropped++;
      continue;
    }
    const end = start + citation.text.length;
    const kept = spans.get(citation.source) ?? [];
    if (!kept.some((span) => span.start === start && span.end === end))
      kept.push({
        start,
        end,
        digest: await sha256Hex(citation.text),
        fingerprint: fingerprint(citation.text),
      });
    spans.set(citation.source, kept);
  }
  const cited = [...spans.entries()].flatMap(([reference, recorded]) => {
    const record = input.reads.get(reference);
    return record === undefined
      ? []
      : [{ record, spans: [...recorded].sort(byStart) }];
  });
  cited.sort((left, right) => firstStart(left.spans) - firstStart(right.spans));
  return {
    sources: cited.map((source, index) => ({ ...source, number: index + 1 })),
    dropped,
  };
}

/**
 * Where each source's words are in `body` now. A span whose words are gone
 * is left out, and so is a source with no span left: a person who removes
 * the words a record supports removes that source. The rest are numbered
 * again in the order of their words.
 */
export async function locateReplySources(
  body: string,
  sources: readonly EmailReplySource[],
): Promise<readonly LocatedReplySource[]> {
  const located: {
    record: EmailReplySourceRecord;
    spans: { start: number; end: number }[];
  }[] = [];
  for (const source of sources) {
    const spans: { start: number; end: number }[] = [];
    for (const span of source.spans) {
      const start = await findSpan(body, span);
      if (start !== null)
        spans.push({ start, end: start + (span.end - span.start) });
    }
    if (spans.length > 0)
      located.push({ record: source.record, spans: spans.sort(byStart) });
  }
  located.sort(
    (left, right) => firstStart(left.spans) - firstStart(right.spans),
  );
  return located.map((source, index) => ({ ...source, number: index + 1 }));
}

const FINGERPRINT_BASE = 31;

/** A polynomial hash of UTF-16 code units, modulo 2^32. */
function fingerprint(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index++)
    hash = (Math.imul(hash, FINGERPRINT_BASE) + text.charCodeAt(index)) >>> 0;
  return hash;
}

/**
 * The first place in `body` that holds the span's words. The span's own place
 * is tried first; otherwise a rolling fingerprint finds candidates, and the
 * digest confirms one.
 */
async function findSpan(
  body: string,
  span: EmailReplySpan,
): Promise<number | null> {
  const length = span.end - span.start;
  if (length <= 0 || length > body.length) return null;
  const own = body.slice(span.start, span.end);
  if (
    own.length === length &&
    fingerprint(own) === span.fingerprint &&
    (await sha256Hex(own)) === span.digest
  )
    return span.start;
  let power = 1;
  for (let index = 1; index < length; index++)
    power = Math.imul(power, FINGERPRINT_BASE) >>> 0;
  let hash = fingerprint(body.slice(0, length));
  for (let start = 0; start + length <= body.length; start++) {
    if (start > 0) {
      const leaving = Math.imul(body.charCodeAt(start - 1), power) >>> 0;
      hash =
        (Math.imul((hash - leaving) >>> 0, FINGERPRINT_BASE) +
          body.charCodeAt(start + length - 1)) >>>
        0;
    }
    if (
      hash === span.fingerprint &&
      (await sha256Hex(body.slice(start, start + length))) === span.digest
    )
      return start;
  }
  return null;
}

function byStart(
  left: Readonly<{ start: number }>,
  right: Readonly<{ start: number }>,
): number {
  return left.start - right.start;
}

function firstStart(spans: readonly Readonly<{ start: number }>[]): number {
  return spans[0]?.start ?? Number.MAX_SAFE_INTEGER;
}
