import type { StoredMessageAttachment } from "@seams/contracts";

import { validateStoredMessageAttachment } from "./message-wasm";
import type { Result } from "../result";

export type StoredAttachmentParseError = { code: "invalid_stored_attachment" };

/**
 * Revalidates one persisted attachment.
 *
 * Validation runs in Lexicon rather than here: a second hand-written checker
 * would drift from the contract, and the branded values it produces can only be
 * minted by the contract's own constructors.
 */
export function parseStoredAttachment(
  raw: unknown,
): Result<StoredMessageAttachment, StoredAttachmentParseError> {
  const validated = validateStoredMessageAttachment(raw);

  return validated.ok
    ? validated
    : { ok: false, error: { code: "invalid_stored_attachment" } };
}

export function parseStoredAttachmentList(
  raw: unknown,
): Result<readonly StoredMessageAttachment[], StoredAttachmentParseError> {
  if (!Array.isArray(raw)) {
    return { ok: false, error: { code: "invalid_stored_attachment" } };
  }

  const attachments: StoredMessageAttachment[] = [];

  for (const value of raw) {
    const parsed = parseStoredAttachment(value);

    if (!parsed.ok) {
      return parsed;
    }

    attachments.push(parsed.value);
  }

  return { ok: true, value: attachments };
}

export function parseStoredAttachmentJson(
  raw: string,
): Result<readonly StoredMessageAttachment[], StoredAttachmentParseError> {
  try {
    return parseStoredAttachmentList(JSON.parse(raw));
  } catch {
    return { ok: false, error: { code: "invalid_stored_attachment" } };
  }
}
