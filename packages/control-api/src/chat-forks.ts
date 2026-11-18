import { isConversationId, type ConversationId } from "./ids";
import { isRecord } from "@seams/std";
import { isSideCaseProposalId } from "./chat-side-cases";

export type ChatThreadLineage =
  | Readonly<{
      kind: "original";
      sourceConversationId?: never;
      sourceMessageId?: never;
      operationId?: never;
      throughSequence?: never;
      digest?: never;
    }>
  | Readonly<{
      kind: "fork";
      sourceConversationId: ConversationId;
      sourceMessageId: string;
      operationId: string;
      throughSequence: number;
      digest: string;
      proposalId?: never;
    }>
  /** A side Case: an agent proposed it in the source chat, and a person started it (Plan 74). */
  | Readonly<{
      kind: "side_case";
      sourceConversationId: ConversationId;
      proposalId: string;
      sourceMessageId?: never;
      operationId?: never;
      throughSequence?: never;
      digest?: never;
    }>;

export type ChatDerivedThread = Readonly<{
  id: ConversationId;
  title: string;
  sourceMessageId: string;
}>;

export function parseChatThreadLineage(raw: unknown): ChatThreadLineage | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "original" && Object.keys(raw).length === 1)
    return { kind: "original" };
  if (raw.kind === "side_case")
    return Object.keys(raw).length === 3 &&
      isConversationId(raw.sourceConversationId) &&
      isSideCaseProposalId(raw.proposalId)
      ? {
          kind: "side_case",
          sourceConversationId: raw.sourceConversationId,
          proposalId: raw.proposalId,
        }
      : null;
  if (
    raw.kind !== "fork" ||
    Object.keys(raw).length !== 6 ||
    !isConversationId(raw.sourceConversationId) ||
    typeof raw.sourceMessageId !== "string" ||
    typeof raw.operationId !== "string" ||
    typeof raw.throughSequence !== "number" ||
    !Number.isSafeInteger(raw.throughSequence) ||
    raw.throughSequence < 1 ||
    typeof raw.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.digest)
  )
    return null;
  return {
    kind: "fork",
    sourceConversationId: raw.sourceConversationId,
    sourceMessageId: raw.sourceMessageId,
    operationId: raw.operationId,
    throughSequence: raw.throughSequence,
    digest: raw.digest,
  };
}
