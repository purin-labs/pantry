import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { canonicalJson, isRecord, sha256Hex } from "@purin-labs/std";
import type {
  ModelRoute,
  StoredMessageAttachment,
  HarnessHistoryContent,
} from "@purin-labs/contracts";
import { parseSessionModelRoute } from "@purin-labs/authority/policy-snapshot";
import { parseSessionId, type OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import {
  parseHarnessHistoryEntry,
  type HarnessHistoryCursor,
  type HarnessHistoryEntry,
} from "../actors/harness-history";
import {
  FlowBinding,
  type SerializedFlowBinding,
} from "@purin-labs/authority/policy/information-flow/index";

export type { ChatThreadLineage } from "@purin-labs/control-api";
import {
  parseChatThreadLineage as parseLineage,
  type ChatThreadLineage,
} from "@purin-labs/control-api";

export type ChatHistoryBinding = Readonly<{
  requestId: string;
  responseId: string | null;
  throughSequence: number;
  sessionId: string;
  turnId: string;
  cursor: HarnessHistoryCursor;
  modelRoute: ModelRoute;
}>;

export type ChatForkHistory = Readonly<{
  entries: readonly HarnessHistoryEntry[];
  bindings: readonly SerializedFlowBinding[];
}>;

export function parseChatThreadLineage(raw: unknown): ChatThreadLineage {
  const lineage = parseLineage(raw === undefined ? { kind: "original" } : raw);
  if (lineage === null) throw new Error("chat_lineage_invalid");
  return lineage;
}

export function parseChatHistoryBindings(
  raw: unknown,
): readonly ChatHistoryBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("chat_history_binding_invalid");
  return raw.map(parseChatHistoryBinding);
}

function parseChatHistoryBinding(raw: unknown): ChatHistoryBinding {
  if (
    !isRecord(raw) ||
    typeof raw.requestId !== "string" ||
    (raw.responseId !== null && typeof raw.responseId !== "string") ||
    !positiveInteger(raw.throughSequence) ||
    typeof raw.sessionId !== "string" ||
    !parseSessionId(raw.sessionId).ok ||
    typeof raw.turnId !== "string" ||
    !isRecord(raw.cursor) ||
    !positiveInteger(raw.cursor.lastSequence) ||
    typeof raw.cursor.lastEntryDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.cursor.lastEntryDigest)
  )
    throw new Error("chat_history_binding_invalid");
  const modelRoute = parseSessionModelRoute(raw.modelRoute);
  if (!modelRoute.ok) throw new Error("chat_history_binding_invalid");
  return {
    requestId: raw.requestId,
    responseId: raw.responseId,
    throughSequence: raw.throughSequence,
    sessionId: raw.sessionId,
    turnId: raw.turnId,
    cursor: {
      lastSequence: raw.cursor.lastSequence,
      lastEntryDigest: raw.cursor.lastEntryDigest,
    },
    modelRoute: modelRoute.value,
  };
}

export async function parseChatForkHistory(
  raw: unknown,
): Promise<ChatForkHistory> {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.entries) ||
    !Array.isArray(raw.bindings)
  )
    throw new Error("chat_fork_history_invalid");
  const entries: HarnessHistoryEntry[] = [];
  for (const rawEntry of raw.entries) {
    const entry = parseHarnessHistoryEntry({ version: 1, entry: rawEntry });
    if (entry === null) throw new Error("chat_fork_history_invalid");
    entries.push(entry);
  }
  assertCompletedHistory(entries);
  const bindings: SerializedFlowBinding[] = [];
  for (const rawBinding of raw.bindings) {
    const binding = await FlowBinding.restore(rawBinding);
    if (!binding.ok) throw new Error("chat_fork_flow_invalid");
    bindings.push(binding.value.toJSON());
  }
  return { entries, bindings };
}

export function assertCompletedHistory(
  entries: readonly HarnessHistoryEntry[],
): void {
  const pending = new Set<string>();
  for (const entry of entries) {
    switch (entry.kind) {
      case "user_input":
        if (pending.size > 0) throw new Error("chat_fork_unsettled_tools");
        break;
      case "assistant_message":
        if (pending.size > 0) throw new Error("chat_fork_unsettled_tools");
        for (const content of entry.content)
          if (content.kind === "tool_call") pending.add(content.callId);
        break;
      case "tool_result":
        if (!pending.delete(entry.callId))
          throw new Error("chat_fork_tool_result_invalid");
        break;
    }
  }
  if (pending.size > 0 || entries.at(-1)?.kind !== "assistant_message")
    throw new Error("chat_fork_boundary_unavailable");
}

export async function chatForkHistoryDigest(
  history: ChatForkHistory,
): Promise<string> {
  return sha256Hex(canonicalJson(history));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function parseChatHistorySnapshot(
  serialized: string,
): Promise<ChatForkHistory & { cursor: HarnessHistoryCursor }> {
  const raw: unknown = JSON.parse(serialized);
  if (
    !isRecord(raw) ||
    !isRecord(raw.cursor) ||
    !positiveInteger(raw.cursor.lastSequence) ||
    typeof raw.cursor.lastEntryDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.cursor.lastEntryDigest)
  )
    throw new Error("chat_fork_history_invalid");
  const history = await parseChatForkHistory(raw);
  return {
    entries: history.entries,
    bindings: history.bindings,
    cursor: {
      lastSequence: raw.cursor.lastSequence,
      lastEntryDigest: raw.cursor.lastEntryDigest,
    },
  };
}

/**
 * The stored histories of the chat forks of an Organisation that are
 * prepared or ready (Refactor 17). The conversation module owns the forks,
 * and the Worker registers its read (`worker-ports.ts`).
 */
export type ChatForkHistoryReads = Readonly<{
  /** The history and its digest of each prepared or ready fork. One D1 read. */
  listOpenChatForkHistories(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<readonly Readonly<{ historyJson: string; digest: string }>[]>;
}>;

export const chatForkHistoryReads = definePort<ChatForkHistoryReads>(
  "chat_fork_history_reads",
);

export async function readChatForkAttachmentKeys(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const rows = await chatForkHistoryReads
    .use()
    .listOpenChatForkHistories(db, organisationId);
  const keys = new Set<string>();
  for (const row of rows) {
    const history = await parseChatForkHistory(JSON.parse(row.historyJson));
    if ((await chatForkHistoryDigest(history)) !== row.digest)
      throw new Error("chat_fork_history_digest_mismatch");
    for (const attachment of chatForkAttachments(history)) {
      if (!attachment.objectKey.startsWith(`attachments/${organisationId}/`))
        throw new Error("chat_fork_attachment_forbidden");
      keys.add(attachment.objectKey);
    }
  }
  return [...keys];
}

export function chatForkAttachments(
  history: ChatForkHistory,
): readonly StoredMessageAttachment[] {
  const attachments: StoredMessageAttachment[] = [];
  for (const entry of history.entries) {
    if (entry.kind === "assistant_message") continue;
    let content: readonly HarnessHistoryContent[] = [];
    if (entry.kind === "user_input") content = entry.content;
    else if (entry.outcome.output.kind === "inline")
      content = entry.outcome.output.content;
    for (const item of content)
      if (item.kind === "attachment") attachments.push(item.attachment);
  }
  return attachments;
}
