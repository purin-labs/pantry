import type { Result } from "../result";

/**
 * Branded Meta identifiers. Every value here is parsed once at the provider
 * boundary — webhook payload, Graph API response, or control request — so no
 * later code has to re-decide whether a bare string is a WABA, a phone-number
 * asset, a customer, or a delivered message.
 */

declare const metaBusinessPortfolioIdBrand: unique symbol;
declare const whatsAppBusinessAccountIdBrand: unique symbol;
declare const whatsAppPhoneNumberIdBrand: unique symbol;
declare const whatsAppCustomerIdBrand: unique symbol;
declare const whatsAppMessageIdBrand: unique symbol;
declare const e164PhoneNumberBrand: unique symbol;

export type MetaBusinessPortfolioId = string & {
  readonly [metaBusinessPortfolioIdBrand]: "MetaBusinessPortfolioId";
};
export type WhatsAppBusinessAccountId = string & {
  readonly [whatsAppBusinessAccountIdBrand]: "WhatsAppBusinessAccountId";
};
export type WhatsAppPhoneNumberId = string & {
  readonly [whatsAppPhoneNumberIdBrand]: "WhatsAppPhoneNumberId";
};
/** Meta's `wa_id`: the only value that identifies a customer conversation. */
export type WhatsAppCustomerId = string & {
  readonly [whatsAppCustomerIdBrand]: "WhatsAppCustomerId";
};
export type WhatsAppMessageId = string & {
  readonly [whatsAppMessageIdBrand]: "WhatsAppMessageId";
};
/** A display label only. It never selects an account, organisation, or recipient. */
export type E164PhoneNumber = string & {
  readonly [e164PhoneNumberBrand]: "E164PhoneNumber";
};

type MetaIdParseError = {
  readonly code: "invalid_meta_identifier";
  readonly field: string;
};

/** Meta node ids are decimal strings; wa_ids are digits without a leading `+`. */
const META_NODE_ID = /^[0-9]{1,32}$/u;
const WA_ID = /^[0-9]{5,20}$/u;
/** `wamid.` prefixed, base64url-ish body. Meta does not publish a length bound. */
const WHATSAPP_MESSAGE_ID = /^wamid\.[A-Za-z0-9_=-]{1,256}$/u;
const E164 = /^\+?[1-9][0-9]{4,17}$/u;

export function parseMetaBusinessPortfolioId(
  raw: unknown,
): Result<MetaBusinessPortfolioId, MetaIdParseError> {
  return parseMetaNodeId(raw, "businessPortfolioId");
}

export function parseWhatsAppBusinessAccountId(
  raw: unknown,
): Result<WhatsAppBusinessAccountId, MetaIdParseError> {
  return parseMetaNodeId(raw, "wabaId");
}

export function parseWhatsAppPhoneNumberId(
  raw: unknown,
): Result<WhatsAppPhoneNumberId, MetaIdParseError> {
  return parseMetaNodeId(raw, "phoneNumberId");
}

export function parseWhatsAppCustomerId(
  raw: unknown,
): Result<WhatsAppCustomerId, MetaIdParseError> {
  return typeof raw === "string" && WA_ID.test(raw)
    ? { ok: true, value: raw as WhatsAppCustomerId }
    : invalid("customerWaId");
}

export function parseWhatsAppMessageId(
  raw: unknown,
): Result<WhatsAppMessageId, MetaIdParseError> {
  return typeof raw === "string" && WHATSAPP_MESSAGE_ID.test(raw)
    ? { ok: true, value: raw as WhatsAppMessageId }
    : invalid("whatsappMessageId");
}

export function parseE164PhoneNumber(
  raw: unknown,
): Result<E164PhoneNumber, MetaIdParseError> {
  if (typeof raw !== "string") return invalid("displayPhoneNumber");
  const compact = raw.replaceAll(/[\s()-]/gu, "");
  return E164.test(compact)
    ? {
        ok: true,
        value: (compact.startsWith("+")
          ? compact
          : `+${compact}`) as E164PhoneNumber,
      }
    : invalid("displayPhoneNumber");
}

function parseMetaNodeId<T extends string>(
  raw: unknown,
  field: string,
): Result<T, MetaIdParseError> {
  return typeof raw === "string" && META_NODE_ID.test(raw)
    ? { ok: true, value: raw as T }
    : invalid(field);
}

function invalid(field: string): Result<never, MetaIdParseError> {
  return { ok: false, error: { code: "invalid_meta_identifier", field } };
}
