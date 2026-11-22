import {
  parseHarnessHistoryEntry,
  type HarnessHistoryEntry,
} from "./harness-history";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";

export type MessageLinkReceiptInspection =
  | { readonly kind: "none" }
  | {
      readonly kind: "accepted";
      readonly turnId: string;
      readonly callId: string;
      readonly sequence: number;
      readonly entryDigest: string;
      readonly acceptedAt: number;
      readonly toolStatus: "succeeded" | "failed";
      readonly authority: {
        readonly kind: "read";
        readonly resultDigest: string;
      };
      readonly result:
        | {
            readonly kind: "refused";
            readonly code: string;
            readonly reason: string;
          }
        | { readonly kind: "other" };
    };

type MessageLinkReceiptRow = Record<string, SqlStorageValue> & {
  readonly sequence: number;
  readonly entry_digest: string;
  readonly payload: string;
  readonly accepted_at: number;
};

export function inspectLatestMessageLinkReceipt(
  sql: SqlStorage,
  sessionId: string,
): MessageLinkReceiptInspection {
  const rows = sql
    .exec<MessageLinkReceiptRow>(
      `SELECT sequence, entry_digest, payload, accepted_at
     FROM session_harness_history
     WHERE session_id = ?
     ORDER BY sequence DESC`,
      sessionId,
    )
    .toArray();

  for (const row of rows) {
    const entry = parsePersistedEntry(row.payload);
    if (entry?.kind !== "tool_result" || entry.tool !== "read_message_link")
      continue;
    if (entry.authority.kind !== "read") return { kind: "none" };
    return {
      kind: "accepted",
      turnId: entry.turn.turnId,
      callId: entry.callId,
      sequence: row.sequence,
      entryDigest: row.entry_digest,
      acceptedAt: row.accepted_at,
      toolStatus: entry.outcome.kind,
      authority: entry.authority,
      result: sanitizedMessageLinkResult(entry.outcome.output),
    };
  }

  return { kind: "none" };
}

function parsePersistedEntry(payload: string) {
  try {
    return parseHarnessHistoryEntry(JSON.parse(payload));
  } catch {
    return null;
  }
}

function sanitizedMessageLinkResult(
  output: Variant<HarnessHistoryEntry, "tool_result">["outcome"]["output"],
): Variant<MessageLinkReceiptInspection, "accepted">["result"] {
  if (
    output.kind !== "inline" ||
    output.content.length !== 1 ||
    output.content[0]?.kind !== "text"
  ) {
    return { kind: "other" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(output.content[0].text);
  } catch {
    return { kind: "other" };
  }
  if (!isRecord(raw) || !isRecord(raw.code_mode_value))
    return { kind: "other" };
  const value = raw.code_mode_value;
  if (value.outcome !== "refused" || !isRecord(value.reason))
    return { kind: "other" };
  const code = boundedIdentifier(value.reason.code);
  const reason = boundedIdentifier(value.reason.reason);
  return code === null || reason === null
    ? { kind: "other" }
    : { kind: "refused", code, reason };
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,120}$/u.test(value)
    ? value
    : null;
}
