import type { RequestAuthority } from "@seams/contracts";
import type {
  MailReplySource,
  MailReplySourceRecord,
  MemoryKind,
  MemoryView,
} from "@seams/control-api";
import { assertNever, sameJson } from "@seams/std";
import type { Variant } from "@seams/type-utils";
import { REPLENISHMENT_QUEUE_LIST_ID } from "@seams/commerce-client";
import type { Env } from "../env";
import { readMemoryViews, type ShownMemoryRevision } from "../memory/access";
import type { Result } from "../result";
import { authorizeEmailChatSourceDelivery } from "./chat-source-access";
import { isOrder, orderQuery, orderSummary } from "./order-context";
import type { LocatedReplySource } from "./reply-sources";
import {
  authorizeEmailCommerceDelivery,
  isReplyFact,
  purchasingQuery,
  readMailboxCommerceQuery,
  readReviewerCommerceQuery,
  replyFactDisplay,
  type EmailCommerceEvidence,
} from "./supplier-context";

type ControlAuthority = Variant<RequestAuthority, "control">;
type Shown = Readonly<{ title: string; detail: string }>;

/**
 * The sources of a reply draft that this person may read, for its review.
 * A Memory revision is shown only when they may inspect it. A commerce
 * record is shown only when their own grants read its source, and only while
 * a fresh read under the mailbox agent's grant gives the same evidence the
 * turn recorded. Anything else is left out, and nothing says that it was. The
 * Memory that the turn was shown and did not cite follows the cited sources.
 */
export async function readReplySourceViews(
  env: Env,
  input: Readonly<{
    viewer: ControlAuthority;
    memoryViewer: Parameters<typeof readMemoryViews>[1];
    caseId: string;
    sources: readonly LocatedReplySource[];
    memory: readonly ShownMemoryRevision[];
  }>,
): Promise<readonly MailReplySource[]> {
  const memoryViews =
    input.memory.length === 0 &&
    !input.sources.some((source) => source.record.kind === "memory")
      ? []
      : await readMemoryViews(env, input.memoryViewer).then((views) =>
          views.ok ? views.value : [],
        );
  const views: MailReplySource[] = [];
  for (const source of input.sources) {
    const shown =
      source.record.kind === "memory"
        ? shownMemory(memoryViews, source.record)
        : await shownCommerceRecord(env, input, source.record);
    if (shown === null) continue;
    views.push({
      number: views.length + 1,
      record: wireRecord(source.record),
      ...shown,
      spans: source.spans,
    });
  }
  for (const revision of input.memory) {
    const cited = input.sources.some(
      (source) =>
        source.record.kind === "memory" &&
        source.record.memoryId === revision.memoryId &&
        source.record.revision === revision.revision,
    );
    const shown = cited ? null : shownMemory(memoryViews, revision);
    if (shown !== null)
      views.push({
        number: null,
        record: {
          kind: "memory",
          memoryId: revision.memoryId,
          revision: revision.revision,
        },
        ...shown,
        spans: [],
      });
  }
  return views;
}

function shownMemory(
  views: readonly MemoryView[],
  shown: ShownMemoryRevision,
): Shown | null {
  const revision = views
    .find((view) => view.memoryId === shown.memoryId)
    ?.revisions.find((entry) => entry.revision === shown.revision);
  return revision === undefined
    ? null
    : {
        title: memoryKindTitle(revision.memoryKind),
        detail: revision.statement,
      };
}

function memoryKindTitle(kind: MemoryKind): string {
  switch (kind) {
    case "fact":
      return "Fact";
    case "preference":
      return "Preference";
    case "lesson":
      return "Lesson";
    default:
      return assertNever(kind);
  }
}

async function shownCommerceRecord(
  env: Env,
  input: Readonly<{ viewer: ControlAuthority; caseId: string }>,
  record: Exclude<LocatedReplySource["record"], { kind: "memory" }>,
): Promise<Shown | null> {
  if (record.kind === "chat_order") return shownChatOrder(env, input, record);
  // The person's own grants decide first, so nothing is read for a person
  // who may not read the record.
  const access = await authorizeEmailCommerceDelivery(
    env,
    input.viewer,
    record.evidence,
  );
  const mailbox = record.evidence[0]?.mailboxAuthority;
  if (!access.ok || mailbox === undefined) return null;
  switch (record.kind) {
    case "order": {
      const query = orderQuery(record.orderId);
      if (query === null) return null;
      const read = await readMailboxCommerceQuery(
        env,
        mailbox,
        input.caseId,
        query,
      );
      if (!sameRecordedRead(read, record.evidence)) return null;
      const entity = read.ok
        ? read.value.value.entities.find(isOrder.bind(null, record.orderId))
        : undefined;
      return entity === undefined ? null : orderSummary(entity);
    }
    case "purchase_request": {
      const read = await readMailboxCommerceQuery(
        env,
        mailbox,
        input.caseId,
        purchasingQuery(
          REPLENISHMENT_QUEUE_LIST_ID,
          "purchase_request_id",
          record.purchaseRequestId,
          record.supplierId,
        ),
      );
      if (!sameRecordedRead(read, record.evidence) || !read.ok) return null;
      const entries = read.value.value.listEntries;
      const entry = entries.length === 1 ? entries[0] : undefined;
      if (entry === undefined) return null;
      return {
        title: `Purchase request ${record.purchaseRequestId}`,
        detail: entry.attributeValues
          .filter(isReplyFact)
          .map(replyFactDisplay)
          .map((fact) => `${fact.label}: ${fact.value}`)
          .join(" · "),
      };
    }
    default:
      return assertNever(record);
  }
}

/**
 * An order that a Portal chat read. The person's own grants to its source
 * decide first. A fresh read under their grant must find the order at the
 * revision that the chat read; a changed order is left out.
 */
async function shownChatOrder(
  env: Env,
  input: Readonly<{ viewer: ControlAuthority; caseId: string }>,
  record: Variant<LocatedReplySource["record"], "chat_order">,
): Promise<Shown | null> {
  const access = await authorizeEmailChatSourceDelivery(env, input.viewer, [
    record.source,
  ]);
  const query = orderQuery(record.orderId);
  if (!access.ok || query === null) return null;
  const read = await readReviewerCommerceQuery(
    env,
    input.viewer,
    input.caseId,
    query,
  );
  const entity = read.ok
    ? read.value.entities.find(isOrder.bind(null, record.orderId))
    : undefined;
  return entity === undefined || Number(entity.revision) !== record.revision
    ? null
    : orderSummary(entity);
}

/** Whether a fresh read stands where the turn's read of the record stood. */
function sameRecordedRead(
  read: Result<{ evidence: EmailCommerceEvidence }, unknown>,
  recorded: readonly EmailCommerceEvidence[],
): boolean {
  return (
    read.ok &&
    recorded.some((receipt) => sameJson(receipt, read.value.evidence))
  );
}

function wireRecord(
  record: LocatedReplySource["record"],
): MailReplySourceRecord {
  switch (record.kind) {
    case "order":
    case "chat_order":
      return { kind: "order", orderId: record.orderId };
    case "purchase_request":
      return {
        kind: "purchase_request",
        purchaseRequestId: record.purchaseRequestId,
        supplierId: record.supplierId,
      };
    case "memory":
      return {
        kind: "memory",
        memoryId: record.memoryId,
        revision: record.revision,
      };
    default:
      return assertNever(record);
  }
}
