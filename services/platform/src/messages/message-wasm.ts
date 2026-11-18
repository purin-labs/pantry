import type {
  MessageAttachmentPreparationReceipt,
  MessageAttachmentPreparationState,
  StoredMessageAttachment,
  UserMessage,
  UserMessageViews,
} from "@seams/contracts";
import {
  buildStoredMessageAttachment as buildStoredMessageAttachmentTypescript,
  deriveUserMessageViews as deriveUserMessageViewsTypescript,
  parseStoredMessageAttachment as parseStoredMessageAttachmentTypescript,
} from "@seams/contracts/message";
import { parseMessageAttachmentPreparationState as parsePreparationTypescript } from "@seams/contracts/attachment-preparation";
import type { Result } from "../result";

/**
 * The untrusted claims a provider adapter collects, plus the facts the transfer
 * established.
 *
 * `header` carries only the leading bytes: identification happens in Lexicon so
 * the signature table has one authoritative definition, without moving the file
 * through the contract parser.
 */
type StoredMessageAttachmentCandidate = {
  readonly attachmentId: string;
  readonly displayName: string;
  readonly declaredMediaType: string | null;
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly header: readonly number[];
  readonly storedAt: number;
  readonly source:
    | {
        readonly kind: "portal";
        readonly userId: string;
        readonly conversationId: string;
        readonly uploadId: string;
      }
    | {
        readonly kind: "slack";
        readonly integrationAccountId: string;
        readonly workspaceId: string;
        readonly channelId: string;
        readonly messageTs: string;
        readonly fileId: string;
        readonly revision: string;
      };
};

export type MessageContractRejection = {
  readonly code: "message_contract_rejected";
  readonly reason: string;
  readonly field: string;
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Mints a committed attachment through Lexicon's own constructors.
 *
 * The Worker never assembles a `StoredMessageAttachment` itself: every branded
 * value, the media classification, and the trust order between signature and
 * provider claim live in the contracts package.
 */
export function buildStoredMessageAttachment(
  candidate: StoredMessageAttachmentCandidate,
): Result<StoredMessageAttachment, MessageContractRejection> {
  let encoded: Uint8Array;

  try {
    encoded = TEXT_ENCODER.encode(JSON.stringify(candidate));
  } catch {
    return {
      ok: false,
      error: {
        code: "message_contract_rejected",
        reason: "invalid_request",
        field: "candidate",
      },
    };
  }

  return decideMessage(encoded, buildStoredMessageAttachmentTypescript);
}

type MessageParser = (
  input: unknown,
) => Readonly<
  | { ok: true; value: unknown }
  | { ok: false; error: Readonly<{ code: string; reason: string }> }
>;

/** The message parser's result on the JSON request bytes. */
function decideMessage<TValue>(
  encoded: Uint8Array,
  typescript: MessageParser,
): Result<TValue, MessageContractRejection> {
  // Bytes that are not JSON refuse as invalid_request.
  const parsed = typescript(decodeJson(encoded));
  return parsed.ok
    ? { ok: true, value: parsed.value as TValue }
    : rejection(parsed.error.code, parsed.error.reason);
}

function decodeJson(raw: Uint8Array): unknown {
  try {
    return JSON.parse(TEXT_DECODER.decode(raw));
  } catch {
    return undefined;
  }
}

/** Revalidates the separate attachment-preparation lifecycle at the boundary. */
export function validateMessageAttachmentPreparationState(
  raw: unknown,
): Result<MessageAttachmentPreparationState, MessageContractRejection> {
  let encoded: Uint8Array;

  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined) return rejection("invalid_request", "state");
    encoded = TEXT_ENCODER.encode(serialized);
  } catch {
    return rejection("invalid_request", "state");
  }

  return decideMessage<MessageAttachmentPreparationState>(
    encoded,
    parsePreparationTypescript,
  );
}

/** Revalidates one immutable attachment-preparation receipt. */
export function validateMessageAttachmentPreparationReceipt(
  raw: unknown,
): Result<MessageAttachmentPreparationReceipt, MessageContractRejection> {
  const state = validateMessageAttachmentPreparationState({
    kind: "completed",
    receipt: raw,
  });

  if (!state.ok) return state;
  if (state.value.kind !== "completed")
    return rejection("response_invalid", "receipt");
  return { ok: true, value: state.value.receipt };
}

function rejection<TValue>(
  reason: string,
  field: string,
): Result<TValue, MessageContractRejection> {
  return {
    ok: false,
    error: { code: "message_contract_rejected", reason, field },
  };
}

/**
 * Revalidates a persisted attachment.
 *
 * A durable row is untrusted input like any other: it re-enters through the
 * same constructors, so a row that no longer satisfies the contract is refused
 * rather than trusted because it was once written.
 */
export function validateStoredMessageAttachment(
  raw: unknown,
): Result<StoredMessageAttachment, MessageContractRejection> {
  let encoded: Uint8Array;

  try {
    encoded = TEXT_ENCODER.encode(JSON.stringify(raw));
  } catch {
    return rejection("invalid_request", "record");
  }

  return decideMessage(encoded, parseStoredMessageAttachmentTypescript);
}

export type DerivedUserMessage = {
  readonly message: UserMessage;
  readonly views: UserMessageViews;
};

/**
 * Revalidates a message and derives every text view the Actor path needs.
 *
 * One call rather than four: the prompt, the purpose, the context query, and
 * the accepted digest come from a single traversal, so they cannot disagree
 * about what the message said or in what order.
 */
export function deriveUserMessageViews(
  message: unknown,
): Result<DerivedUserMessage, MessageContractRejection> {
  let encoded: Uint8Array;

  try {
    encoded = TEXT_ENCODER.encode(JSON.stringify(message));
  } catch {
    return {
      ok: false,
      error: {
        code: "message_contract_rejected",
        reason: "invalid_request",
        field: "message",
      },
    };
  }

  const decoded = decideMessage<DerivedUserMessage>(
    encoded,
    deriveUserMessageViewsTypescript,
  );

  return decoded.ok
    ? { ok: true, value: decoded.value as unknown as DerivedUserMessage }
    : decoded;
}
