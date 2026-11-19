import { hasExactKeys, isPositiveInteger, isRecord } from "@purin-labs/std";

export type MailReplyEdit = Readonly<{
  version: number;
  snapshotDigest: string;
  challenge: string;
  body: string;
  to?: never;
  subject?: never;
  threadId?: never;
  raw?: never;
}>;

export function parseMailReplyEdit(raw: unknown): MailReplyEdit | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["version", "snapshotDigest", "challenge", "body"]) ||
    !isPositiveInteger(raw.version) ||
    typeof raw.snapshotDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.snapshotDigest) ||
    typeof raw.challenge !== "string" ||
    raw.challenge.length === 0 ||
    raw.challenge.length > 256 ||
    typeof raw.body !== "string" ||
    raw.body.trim().length === 0 ||
    raw.body.length > 20_000
  )
    return null;
  return {
    version: raw.version,
    snapshotDigest: raw.snapshotDigest,
    challenge: raw.challenge,
    body: raw.body,
  };
}

export type MailRelationshipLookup =
  | Readonly<{
      kind: "suppliers";
      supplierEntryId?: never;
      purchaseRequestId?: never;
    }>
  | Readonly<{
      kind: "purchase_request";
      supplierEntryId: string;
      purchaseRequestId: string;
    }>;

export type MailSupplierCandidate = Readonly<{
  entryId: string;
  supplierId: string;
  displayName: string;
}>;
export type MailRelationshipPreview = Readonly<{
  kind: "purchase_request";
  supplierEntryId: string;
  supplierId: string;
  supplierName: string;
  purchaseRequestEntryId: string;
  purchaseRequestId: string;
  merchantRevision: number;
  facts: readonly Readonly<{ label: string; value: string }>[];
  version: number;
  snapshotDigest: string;
  relationshipDigest: string;
  challenge: string;
}>;

export type MailReplyCorrection = MailReplyEdit &
  Readonly<{
    supplierEntryId: string;
    purchaseRequestId: string;
    relationshipDigest: string;
  }>;

export function parseMailRelationshipLookup(
  raw: unknown,
): MailRelationshipLookup | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "suppliers" && hasExactKeys(raw, ["kind"]))
    return { kind: "suppliers" };
  if (
    raw.kind !== "purchase_request" ||
    !hasExactKeys(raw, ["kind", "supplierEntryId", "purchaseRequestId"]) ||
    !relationshipReference(raw.supplierEntryId) ||
    !relationshipReference(raw.purchaseRequestId)
  )
    return null;
  return {
    kind: "purchase_request",
    supplierEntryId: raw.supplierEntryId,
    purchaseRequestId: raw.purchaseRequestId,
  };
}

export function parseMailReplyCorrection(
  raw: unknown,
): MailReplyCorrection | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "version",
      "snapshotDigest",
      "challenge",
      "body",
      "supplierEntryId",
      "purchaseRequestId",
      "relationshipDigest",
    ]) ||
    !relationshipReference(raw.supplierEntryId) ||
    !relationshipReference(raw.purchaseRequestId) ||
    typeof raw.relationshipDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.relationshipDigest)
  )
    return null;
  const edit = parseMailReplyEdit({
    version: raw.version,
    snapshotDigest: raw.snapshotDigest,
    challenge: raw.challenge,
    body: raw.body,
  });
  if (edit === null) return null;
  return {
    version: edit.version,
    snapshotDigest: edit.snapshotDigest,
    challenge: edit.challenge,
    body: edit.body,
    supplierEntryId: raw.supplierEntryId,
    purchaseRequestId: raw.purchaseRequestId,
    relationshipDigest: raw.relationshipDigest,
  };
}

function relationshipReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 256
  );
}

/**
 * The record behind one source of a reply draft, by identity. An order opens
 * its order page, a purchase request its supplier, a Memory the Brain page.
 */
export type MailReplySourceRecord =
  | Readonly<{
      kind: "order";
      orderId: string;
      purchaseRequestId?: never;
      supplierId?: never;
      memoryId?: never;
      revision?: never;
    }>
  | Readonly<{
      kind: "purchase_request";
      purchaseRequestId: string;
      supplierId: string;
      orderId?: never;
      memoryId?: never;
      revision?: never;
    }>
  | Readonly<{
      kind: "memory";
      memoryId: string;
      revision: number;
      orderId?: never;
      purchaseRequestId?: never;
      supplierId?: never;
    }>;

/** Where a source's words are in the draft body, as UTF-16 offsets. */
export type MailReplySpan = Readonly<{ start: number; end: number }>;

/**
 * One record that the agent checked for a reply draft, as far as the person
 * who reads the draft may read it. A cited source has a number and the spans
 * of the body that it supports. A Memory that the agent was shown and did
 * not cite has no number and no spans.
 */
export type MailReplySource = Readonly<{
  number: number | null;
  record: MailReplySourceRecord;
  title: string;
  /** One line about the record. */
  detail: string;
  spans: readonly MailReplySpan[];
}>;

const MAX_REPLY_SOURCES = 32;
const MAX_REPLY_SOURCE_SPANS = 12;

/**
 * The sources of a reply preview. An absent list is empty. Each span must lie
 * in a body of `bodyLength` UTF-16 code units, and a source with a number
 * must have a span.
 */
export function parseMailReplySources(
  raw: unknown,
  bodyLength: number,
): readonly MailReplySource[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_REPLY_SOURCES) return null;
  const sources: MailReplySource[] = [];
  for (const entry of raw) {
    const source = parseMailReplySource(entry, bodyLength);
    if (source === null) return null;
    sources.push(source);
  }
  return sources;
}

function parseMailReplySource(
  raw: unknown,
  bodyLength: number,
): MailReplySource | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["number", "record", "title", "detail", "spans"]) ||
    (raw.number !== null && !isPositiveInteger(raw.number)) ||
    typeof raw.title !== "string" ||
    raw.title.length === 0 ||
    raw.title.length > 300 ||
    typeof raw.detail !== "string" ||
    raw.detail.length > 2_000 ||
    !Array.isArray(raw.spans) ||
    raw.spans.length > MAX_REPLY_SOURCE_SPANS ||
    (raw.number === null) !== (raw.spans.length === 0)
  )
    return null;
  const record = parseMailReplySourceRecord(raw.record);
  if (record === null) return null;
  const spans: MailReplySpan[] = [];
  for (const span of raw.spans) {
    if (
      !isRecord(span) ||
      !hasExactKeys(span, ["start", "end"]) ||
      typeof span.start !== "number" ||
      typeof span.end !== "number" ||
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > bodyLength
    )
      return null;
    spans.push({ start: span.start, end: span.end });
  }
  return {
    number: raw.number,
    record,
    title: raw.title,
    detail: raw.detail,
    spans,
  };
}

function parseMailReplySourceRecord(
  raw: unknown,
): MailReplySourceRecord | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "order":
      return hasExactKeys(raw, ["kind", "orderId"]) &&
        relationshipReference(raw.orderId)
        ? { kind: "order", orderId: raw.orderId }
        : null;
    case "purchase_request":
      return hasExactKeys(raw, ["kind", "purchaseRequestId", "supplierId"]) &&
        relationshipReference(raw.purchaseRequestId) &&
        relationshipReference(raw.supplierId)
        ? {
            kind: "purchase_request",
            purchaseRequestId: raw.purchaseRequestId,
            supplierId: raw.supplierId,
          }
        : null;
    case "memory":
      return hasExactKeys(raw, ["kind", "memoryId", "revision"]) &&
        relationshipReference(raw.memoryId) &&
        isPositiveInteger(raw.revision)
        ? { kind: "memory", memoryId: raw.memoryId, revision: raw.revision }
        : null;
    default:
      return null;
  }
}
