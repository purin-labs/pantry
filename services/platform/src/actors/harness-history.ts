import type {
  AcceptedInputRef,
  EmbeddedHarnessModelUsage,
  HarnessAssistantContent,
  HarnessEventSequence,
  HarnessHistoryContent,
  HarnessHistoryCursor,
  HarnessHistoryEntry,
  HarnessHistoryEntryEnvelope,
  HarnessOpaqueContinuation,
  HarnessStopReason,
  HarnessToolAuthority,
  HarnessToolOutcome,
  HarnessToolOutput,
  Sha256Digest,
  TurnIdentity,
} from "@seams/contracts";

import { parseStoredAttachment } from "../messages/stored-attachment";
import {
  assertNever,
  canonicalJson,
  hasExactKeys,
  isNonEmptyString,
  isRecord,
  nonNegativeIntegerOrNull,
  sha256Hex,
} from "@seams/std";

export type {
  HarnessHistoryContent,
  HarnessHistoryCursor,
  HarnessHistoryEntry,
} from "@seams/contracts";

export type HarnessHistoryAcceptance =
  | { readonly kind: "advanced"; readonly cursor: HarnessHistoryCursor }
  | { readonly kind: "duplicate"; readonly cursor: HarnessHistoryCursor };

export type HarnessHistoryRead = {
  readonly cursor: HarnessHistoryCursor | null;
  readonly entries: readonly HarnessHistoryEntry[];
};

export function encodeHarnessHistoryEntry(entry: HarnessHistoryEntry): string {
  return canonicalJson({
    version: 1,
    entry,
  } satisfies HarnessHistoryEntryEnvelope);
}

export async function digestHarnessHistoryEntry(input: {
  readonly sessionId: string;
  readonly sequence: HarnessEventSequence;
  readonly previousDigest: Sha256Digest | null;
  readonly entry: HarnessHistoryEntry;
}): Promise<Sha256Digest> {
  return sha256Hex(
    canonicalJson({
      kind: "satyr_harness_history_chain_v1",
      sessionId: input.sessionId,
      sequence: input.sequence,
      previousDigest: input.previousDigest,
      entry: {
        version: 1,
        entry: input.entry,
      } satisfies HarnessHistoryEntryEnvelope,
    }),
  );
}

export async function digestPersistedHarnessHistoryEnvelope(input: {
  readonly sessionId: string;
  readonly sequence: HarnessEventSequence;
  readonly previousDigest: Sha256Digest | null;
  readonly envelope: unknown;
}): Promise<Sha256Digest> {
  return sha256Hex(
    canonicalJson({
      kind: "satyr_harness_history_chain_v1",
      sessionId: input.sessionId,
      sequence: input.sequence,
      previousDigest: input.previousDigest,
      entry: input.envelope,
    }),
  );
}

export function parseHarnessHistoryEntry(
  value: unknown,
): HarnessHistoryEntry | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "entry"]) ||
    value.version !== 1
  ) {
    return null;
  }
  return parseEntry(value.entry);
}

function parseEntry(value: unknown): HarnessHistoryEntry | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const turn = parseTurnIdentity(value.turn);
  if (turn === null) return null;
  const acceptedAt = nonNegativeIntegerOrNull(value.acceptedAt);
  if (acceptedAt === null) return null;
  switch (value.kind) {
    case "user_input":
      return parseUserInput(value, turn, acceptedAt);
    case "assistant_message":
      return parseAssistantMessage(value, turn, acceptedAt);
    case "tool_result":
      return parseToolResult(value, turn, acceptedAt);
    default:
      return null;
  }
}

function parseUserInput(
  value: Record<string, unknown>,
  turn: TurnIdentity,
  acceptedAt: number,
): HarnessHistoryEntry | null {
  if (!hasExactKeys(value, ["kind", "turn", "input", "content", "acceptedAt"]))
    return null;
  const input = parseAcceptedInputRef(value.input);
  const content = parseHistoryContentList(value.content);
  return input === null || content === null || content.length === 0
    ? null
    : { kind: "user_input", turn, input, content, acceptedAt };
}

function parseAssistantMessage(
  value: Record<string, unknown>,
  turn: TurnIdentity,
  acceptedAt: number,
): HarnessHistoryEntry | null {
  if (
    !hasExactKeys(value, [
      "kind",
      "turn",
      "model",
      "content",
      "stopReason",
      "usage",
      "acceptedAt",
    ])
  )
    return null;
  const content = parseAssistantContentList(value.content);
  const stopReason = parseStopReason(value.stopReason);
  const usage = parseModelUsage(value.usage);
  return typeof value.model !== "string" ||
    value.model.length === 0 ||
    content === null ||
    content.length === 0 ||
    stopReason === null ||
    usage === null
    ? null
    : {
        kind: "assistant_message",
        turn,
        model: value.model,
        content,
        stopReason,
        usage,
        acceptedAt,
      };
}

function parseToolResult(
  value: Record<string, unknown>,
  turn: TurnIdentity,
  acceptedAt: number,
): HarnessHistoryEntry | null {
  if (
    !hasExactKeys(value, [
      "kind",
      "turn",
      "callId",
      "tool",
      "outcome",
      "authority",
      "acceptedAt",
    ])
  )
    return null;
  const outcome = parseToolOutcome(value.outcome);
  const authority = parseToolAuthority(value.authority);
  return typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    typeof value.tool !== "string" ||
    value.tool.length === 0 ||
    outcome === null ||
    authority === null ||
    outcome.output.digest !== authority.resultDigest
    ? null
    : {
        kind: "tool_result",
        turn,
        callId: value.callId,
        tool: value.tool,
        outcome,
        authority,
        acceptedAt,
      };
}

function parseAcceptedInputRef(value: unknown): AcceptedInputRef | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (!isSha256Digest(value.contextBundleDigest)) return null;
  if (value.kind === "case") {
    return hasExactKeys(value, [
      "kind",
      "inputId",
      "caseId",
      "assignmentId",
      "caseRevision",
      "contentDigest",
      "workspaceRevision",
      "contextBundleDigest",
    ]) &&
      isNonEmptyString(value.inputId) &&
      isNonEmptyString(value.caseId) &&
      isNonEmptyString(value.assignmentId) &&
      Number.isSafeInteger(value.caseRevision) &&
      Number(value.caseRevision) >= 0 &&
      isSha256Digest(value.contentDigest) &&
      isNonEmptyString(value.workspaceRevision)
      ? {
          kind: "case",
          inputId: value.inputId,
          caseId: value.caseId,
          assignmentId: value.assignmentId,
          caseRevision: Number(value.caseRevision),
          contentDigest: value.contentDigest,
          workspaceRevision: value.workspaceRevision,
          contextBundleDigest: value.contextBundleDigest,
        }
      : null;
  }
  return null;
}

function parseHistoryContentList(
  value: unknown,
): HarnessHistoryContent[] | null {
  if (!Array.isArray(value)) return null;
  const content: HarnessHistoryContent[] = [];
  for (const raw of value) {
    const parsed = parseHistoryContent(raw);
    if (parsed === null) return null;
    content.push(parsed);
  }
  return content;
}

function parseHistoryContent(value: unknown): HarnessHistoryContent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "project_context") {
    return hasExactKeys(value, ["kind", "snapshotDigest", "text"]) &&
      typeof value.snapshotDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(value.snapshotDigest) &&
      typeof value.text === "string"
      ? {
          kind: "project_context",
          snapshotDigest: value.snapshotDigest,
          text: value.text,
        }
      : null;
  }
  if (value.kind === "text") {
    return hasExactKeys(value, ["kind", "text"]) &&
      typeof value.text === "string"
      ? { kind: "text", text: value.text }
      : null;
  }
  if (
    value.kind !== "attachment" ||
    !hasExactKeys(value, ["kind", "attachment"])
  )
    return null;
  const attachment = parseStoredAttachment(value.attachment);
  return attachment.ok
    ? { kind: "attachment", attachment: attachment.value }
    : null;
}

function parseAssistantContentList(
  value: unknown,
): HarnessAssistantContent[] | null {
  if (!Array.isArray(value)) return null;
  const content: HarnessAssistantContent[] = [];
  for (const raw of value) {
    const parsed = parseAssistantContent(raw);
    if (parsed === null) return null;
    content.push(parsed);
  }
  return content;
}

function parseAssistantContent(value: unknown): HarnessAssistantContent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const continuation = parseContinuation(value.continuation);
  if (continuation === null) return null;
  switch (value.kind) {
    case "text":
      return hasExactKeys(value, ["kind", "text", "continuation"]) &&
        typeof value.text === "string"
        ? { kind: "text", text: value.text, continuation }
        : null;
    case "thinking":
      return hasExactKeys(value, [
        "kind",
        "text",
        "redacted",
        "continuation",
      ]) &&
        typeof value.text === "string" &&
        typeof value.redacted === "boolean"
        ? {
            kind: "thinking",
            text: value.text,
            redacted: value.redacted,
            continuation,
          }
        : null;
    case "tool_call":
      return hasExactKeys(value, [
        "kind",
        "callId",
        "tool",
        "arguments",
        "continuation",
      ]) &&
        isNonEmptyString(value.callId) &&
        isNonEmptyString(value.tool) &&
        isJsonValue(value.arguments)
        ? {
            kind: "tool_call",
            callId: value.callId,
            tool: value.tool,
            arguments: value.arguments,
            continuation,
          }
        : null;
    default:
      return null;
  }
}

function parseContinuation(value: unknown): HarnessOpaqueContinuation | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "none") {
    return hasExactKeys(value, ["kind"]) ? { kind: "none" } : null;
  }
  return value.kind === "opaque" &&
    hasExactKeys(value, ["kind", "value"]) &&
    isNonEmptyString(value.value)
    ? { kind: "opaque", value: value.value }
    : null;
}

function parseToolOutcome(value: unknown): HarnessToolOutcome | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "output"]) ||
    (value.kind !== "succeeded" && value.kind !== "failed")
  )
    return null;
  const output = parseToolOutput(value.output);
  return output === null ? null : { kind: value.kind, output };
}

function parseToolOutput(value: unknown): HarnessToolOutput | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "inline") {
    if (
      !hasExactKeys(value, ["kind", "content", "digest"]) ||
      !isSha256Digest(value.digest)
    )
      return null;
    const content = parseHistoryContentList(value.content);
    return content === null
      ? null
      : { kind: "inline", content, digest: value.digest };
  }
  if (
    value.kind !== "artifact" ||
    !hasExactKeys(value, ["kind", "artifact", "preview", "digest"]) ||
    !isRecord(value.artifact) ||
    !hasExactKeys(value.artifact, ["id", "kind", "url"]) ||
    !isNonEmptyString(value.artifact.id) ||
    !isNonEmptyString(value.artifact.kind) ||
    (value.artifact.url !== null && typeof value.artifact.url !== "string") ||
    typeof value.preview !== "string" ||
    !isSha256Digest(value.digest)
  )
    return null;
  return {
    kind: "artifact",
    artifact: {
      id: value.artifact.id,
      kind: value.artifact.kind,
      url: value.artifact.url,
    },
    preview: value.preview,
    digest: value.digest,
  };
}

function parseToolAuthority(value: unknown): HarnessToolAuthority | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !isSha256Digest(value.resultDigest)
  )
    return null;
  switch (value.kind) {
    case "read":
      return hasExactKeys(value, ["kind", "resultDigest"])
        ? { kind: "read", resultDigest: value.resultDigest }
        : null;
    case "provider_effect":
    case "surface_effect":
    case "code_execution":
      return hasExactKeys(value, ["kind", "receiptId", "resultDigest"]) &&
        isNonEmptyString(value.receiptId)
        ? {
            kind: value.kind,
            receiptId: value.receiptId,
            resultDigest: value.resultDigest,
          }
        : null;
    case "workspace_revision":
      return hasExactKeys(value, [
        "kind",
        "receiptId",
        "revision",
        "resultDigest",
      ]) &&
        isNonEmptyString(value.receiptId) &&
        isNonEmptyString(value.revision)
        ? {
            kind: "workspace_revision",
            receiptId: value.receiptId,
            revision: value.revision,
            resultDigest: value.resultDigest,
          }
        : null;
    default:
      return null;
  }
}

export function parseModelUsage(
  value: unknown,
): EmbeddedHarnessModelUsage | null {
  const keys = [
    "modelCalls",
    "callsWithUsage",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  for (const key of keys)
    if (nonNegativeIntegerOrNull(value[key]) === null) return null;
  return {
    modelCalls: Number(value.modelCalls),
    callsWithUsage: Number(value.callsWithUsage),
    inputTokens: Number(value.inputTokens),
    cachedInputTokens: Number(value.cachedInputTokens),
    outputTokens: Number(value.outputTokens),
    reasoningTokens: Number(value.reasoningTokens),
    totalTokens: Number(value.totalTokens),
  };
}

function parseStopReason(value: unknown): HarnessStopReason | null {
  return value === "completed" ||
    value === "length" ||
    value === "tool_use" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : null;
}

function parseTurnIdentity(value: unknown): TurnIdentity | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "turnId",
      "inputId",
      "turnLeaseGeneration",
      "budgetRevision",
    ]) ||
    !isNonEmptyString(value.turnId) ||
    !isNonEmptyString(value.inputId) ||
    !isNonEmptyString(value.budgetRevision) ||
    !Number.isSafeInteger(value.turnLeaseGeneration) ||
    Number(value.turnLeaseGeneration) <= 0
  )
    return null;
  return {
    turnId: value.turnId,
    inputId: value.inputId,
    turnLeaseGeneration: Number(value.turnLeaseGeneration),
    budgetRevision: value.budgetRevision,
  };
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

/**
 * Renders one history entry as text for an adapter that has no richer form.
 *
 * Every branch is named so a new content kind cannot be silently dropped into
 * an empty string.
 */
export function renderHarnessHistoryContent(
  content: HarnessHistoryContent,
): string {
  switch (content.kind) {
    case "project_context":
    case "text":
      return content.text;
    case "link":
      return content.link.presentation.kind === "label"
        ? `[link:${content.link.presentation.label}](${content.link.url})`
        : `[link](${content.link.url})`;
    case "attachment":
      return `[attachment:${content.attachment.id}]`;
    default:
      return assertNever(content, "Unhandled harness history content");
  }
}
