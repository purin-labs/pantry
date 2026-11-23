import type { Result } from "@purin-labs/kernel/result";
import {
  parseE164PhoneNumber,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppCustomerId,
  parseWhatsAppMessageId,
  parseWhatsAppPhoneNumberId,
  type E164PhoneNumber,
  type WhatsAppBusinessAccountId,
  type WhatsAppCustomerId,
  type WhatsAppMessageId,
  type WhatsAppPhoneNumberId,
} from "@purin-labs/connections/whatsapp/identifiers";
import { bytesToHex, isRecord } from "@purin-labs/std";

/**
 * The Meta Cloud API webhook boundary. Raw provider JSON is parsed exactly
 * once, here, into a closed union. Nothing downstream sees a Meta-shaped
 * object, so adding a supported message type is a deliberate edit to this
 * union rather than an accidental widening somewhere in the runtime.
 */

export type WhatsAppWebhookEvent =
  | {
      readonly kind: "text_message";
      readonly wabaId: WhatsAppBusinessAccountId;
      readonly phoneNumberId: WhatsAppPhoneNumberId;
      readonly displayPhoneNumber: E164PhoneNumber;
      readonly customerWaId: WhatsAppCustomerId;
      readonly providerMessageId: WhatsAppMessageId;
      readonly providerTimestamp: number;
      readonly body: string;
    }
  /** Recorded content-free: the type name is diagnostics, the payload is dropped. */
  | {
      readonly kind: "unsupported_message";
      readonly wabaId: WhatsAppBusinessAccountId;
      readonly phoneNumberId: WhatsAppPhoneNumberId;
      readonly customerWaId: WhatsAppCustomerId;
      readonly providerMessageId: WhatsAppMessageId;
      readonly providerTimestamp: number;
      readonly messageType: string;
    }
  | {
      readonly kind: "status";
      readonly wabaId: WhatsAppBusinessAccountId;
      readonly phoneNumberId: WhatsAppPhoneNumberId;
      readonly whatsappMessageId: WhatsAppMessageId;
      readonly recipientWaId: WhatsAppCustomerId;
      readonly status: "sent" | "delivered" | "read" | "failed";
      readonly statusAt: number;
      readonly failureCode: string | null;
    };

type WhatsAppWebhookParseError = {
  readonly code: "whatsapp_webhook_unparseable";
  readonly field: string;
};

type WhatsAppWebhookChallenge = { readonly challenge: string };

type WhatsAppWebhookChallengeError = {
  readonly code:
    | "whatsapp_verify_token_missing"
    | "whatsapp_challenge_mode_invalid"
    | "whatsapp_challenge_token_invalid"
    | "whatsapp_challenge_missing";
};

type WhatsAppSignatureError = {
  readonly code:
    | "whatsapp_app_secret_missing"
    | "whatsapp_signature_missing"
    | "whatsapp_signature_malformed"
    | "whatsapp_signature_invalid";
};

const SIGNATURE_PREFIX = "sha256=";
const HEX_SIGNATURE = /^[0-9a-f]{64}$/u;
const UNIX_SECONDS = /^[0-9]{1,12}$/u;

/**
 * Meta's subscription handshake. The mode and verify token must both match
 * before the challenge is echoed; nothing about the request identifies a
 * organisation, so this proves only that the caller knows the deployment token.
 */
export function verifyWhatsAppWebhookChallenge(input: {
  readonly url: URL;
  readonly verifyToken: string | undefined;
}): Result<WhatsAppWebhookChallenge, WhatsAppWebhookChallengeError> {
  const expected = input.verifyToken?.trim() ?? "";
  if (expected.length === 0) {
    return { ok: false, error: { code: "whatsapp_verify_token_missing" } };
  }
  if (input.url.searchParams.get("hub.mode") !== "subscribe") {
    return { ok: false, error: { code: "whatsapp_challenge_mode_invalid" } };
  }
  const token = input.url.searchParams.get("hub.verify_token");
  if (token === null || !timingSafeEqual(token, expected)) {
    return { ok: false, error: { code: "whatsapp_challenge_token_invalid" } };
  }
  const challenge = input.url.searchParams.get("hub.challenge");
  return challenge === null || challenge.length === 0
    ? { ok: false, error: { code: "whatsapp_challenge_missing" } }
    : { ok: true, value: { challenge } };
}

/**
 * `X-Hub-Signature-256` over the exact bytes Meta sent. The caller must pass
 * the unmodified request body; re-serializing parsed JSON would change the
 * bytes and make every signature fail.
 */
export async function verifyWhatsAppWebhookSignature(input: {
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly appSecret: string | undefined;
}): Promise<Result<null, WhatsAppSignatureError>> {
  const secret = input.appSecret?.trim() ?? "";
  if (secret.length === 0) {
    return { ok: false, error: { code: "whatsapp_app_secret_missing" } };
  }
  if (input.signatureHeader === null) {
    return { ok: false, error: { code: "whatsapp_signature_missing" } };
  }
  if (!input.signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, error: { code: "whatsapp_signature_malformed" } };
  }
  const provided = input.signatureHeader
    .slice(SIGNATURE_PREFIX.length)
    .toLowerCase();
  if (!HEX_SIGNATURE.test(provided)) {
    return { ok: false, error: { code: "whatsapp_signature_malformed" } };
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input.rawBody),
  );
  const expected = bytesToHex(new Uint8Array(signed));
  return timingSafeEqual(provided, expected)
    ? { ok: true, value: null }
    : { ok: false, error: { code: "whatsapp_signature_invalid" } };
}

/**
 * Parses one webhook body into zero or more closed-union events. A payload
 * whose envelope is wrong fails; individual entries that carry fields this
 * version does not support are dropped without failing the delivery, so Meta
 * is not asked to retry an event Pantry will never accept.
 */
export function parseWhatsAppWebhookBody(
  raw: unknown,
): Result<readonly WhatsAppWebhookEvent[], WhatsAppWebhookParseError> {
  if (!isRecord(raw)) return unparseable("body");
  if (raw.object !== "whatsapp_business_account") return unparseable("object");
  if (!Array.isArray(raw.entry)) return unparseable("entry");
  const events: WhatsAppWebhookEvent[] = [];
  for (const entry of raw.entry) {
    if (!isRecord(entry)) return unparseable("entry[]");
    const wabaId = parseWhatsAppBusinessAccountId(entry.id);
    if (!wabaId.ok) return unparseable("entry[].id");
    if (!Array.isArray(entry.changes)) return unparseable("entry[].changes");
    for (const change of entry.changes) {
      if (!isRecord(change)) return unparseable("changes[]");
      if (change.field !== "messages") continue;
      const parsed = parseMessagesChange(wabaId.value, change.value);
      if (!parsed.ok) return parsed;
      events.push(...parsed.value);
    }
  }
  return { ok: true, value: events };
}

function parseMessagesChange(
  wabaId: WhatsAppBusinessAccountId,
  value: unknown,
): Result<readonly WhatsAppWebhookEvent[], WhatsAppWebhookParseError> {
  if (!isRecord(value)) return unparseable("value");
  if (value.messaging_product !== "whatsapp")
    return unparseable("messaging_product");
  if (!isRecord(value.metadata)) return unparseable("metadata");
  const phoneNumberId = parseWhatsAppPhoneNumberId(
    value.metadata.phone_number_id,
  );
  if (!phoneNumberId.ok) return unparseable("metadata.phone_number_id");
  const displayPhoneNumber = parseE164PhoneNumber(
    value.metadata.display_phone_number,
  );
  if (!displayPhoneNumber.ok)
    return unparseable("metadata.display_phone_number");
  const events: WhatsAppWebhookEvent[] = [];
  if (value.messages !== undefined) {
    if (!Array.isArray(value.messages)) return unparseable("messages");
    for (const message of value.messages) {
      const parsed = parseMessage(
        wabaId,
        phoneNumberId.value,
        displayPhoneNumber.value,
        message,
      );
      if (!parsed.ok) return parsed;
      if (parsed.value !== null) events.push(parsed.value);
    }
  }
  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses)) return unparseable("statuses");
    for (const status of value.statuses) {
      const parsed = parseStatus(wabaId, phoneNumberId.value, status);
      if (!parsed.ok) return parsed;
      if (parsed.value !== null) events.push(parsed.value);
    }
  }
  return { ok: true, value: events };
}

function parseMessage(
  wabaId: WhatsAppBusinessAccountId,
  phoneNumberId: WhatsAppPhoneNumberId,
  displayPhoneNumber: E164PhoneNumber,
  raw: unknown,
): Result<WhatsAppWebhookEvent | null, WhatsAppWebhookParseError> {
  if (!isRecord(raw)) return unparseable("messages[]");
  const providerMessageId = parseWhatsAppMessageId(raw.id);
  const customerWaId = parseWhatsAppCustomerId(raw.from);
  const providerTimestamp = parseUnixSeconds(raw.timestamp);
  if (!providerMessageId.ok) return unparseable("messages[].id");
  if (!customerWaId.ok) return unparseable("messages[].from");
  if (providerTimestamp === null) return unparseable("messages[].timestamp");
  if (typeof raw.type !== "string" || raw.type.length === 0) {
    return unparseable("messages[].type");
  }
  if (raw.type !== "text") {
    return {
      ok: true,
      value: {
        kind: "unsupported_message",
        wabaId,
        phoneNumberId,
        customerWaId: customerWaId.value,
        providerMessageId: providerMessageId.value,
        providerTimestamp,
        messageType: raw.type,
      },
    };
  }
  if (!isRecord(raw.text) || typeof raw.text.body !== "string") {
    return unparseable("messages[].text.body");
  }
  return {
    ok: true,
    value: {
      kind: "text_message",
      wabaId,
      phoneNumberId,
      displayPhoneNumber,
      customerWaId: customerWaId.value,
      providerMessageId: providerMessageId.value,
      providerTimestamp,
      body: raw.text.body,
    },
  };
}

function parseStatus(
  wabaId: WhatsAppBusinessAccountId,
  phoneNumberId: WhatsAppPhoneNumberId,
  raw: unknown,
): Result<WhatsAppWebhookEvent | null, WhatsAppWebhookParseError> {
  if (!isRecord(raw)) return unparseable("statuses[]");
  const whatsappMessageId = parseWhatsAppMessageId(raw.id);
  const recipientWaId = parseWhatsAppCustomerId(raw.recipient_id);
  const statusAt = parseUnixSeconds(raw.timestamp);
  if (!whatsappMessageId.ok) return unparseable("statuses[].id");
  if (!recipientWaId.ok) return unparseable("statuses[].recipient_id");
  if (statusAt === null) return unparseable("statuses[].timestamp");
  if (
    raw.status !== "sent" &&
    raw.status !== "delivered" &&
    raw.status !== "read" &&
    raw.status !== "failed"
  ) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: {
      kind: "status",
      wabaId,
      phoneNumberId,
      whatsappMessageId: whatsappMessageId.value,
      recipientWaId: recipientWaId.value,
      status: raw.status,
      statusAt,
      failureCode:
        raw.status === "failed" ? parseFailureCode(raw.errors) : null,
    },
  };
}

/** Only the numeric code travels onward; Meta's message text is not retained. */
function parseFailureCode(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const first = raw[0];
  if (!isRecord(first)) return null;
  if (typeof first.code === "number" && Number.isSafeInteger(first.code)) {
    return String(first.code);
  }
  return typeof first.code === "string" && /^[0-9]{1,10}$/u.test(first.code)
    ? first.code
    : null;
}

function parseUnixSeconds(raw: unknown): number | null {
  const value =
    typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  return typeof value === "string" && UNIX_SECONDS.test(value)
    ? Number.parseInt(value, 10) * 1000
    : null;
}

function unparseable(field: string): Result<never, WhatsAppWebhookParseError> {
  return { ok: false, error: { code: "whatsapp_webhook_unparseable", field } };
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
