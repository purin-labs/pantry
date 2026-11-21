// Field rules of the Commerce wire records (Plan 78 step 2). They are the
// rules of the hand-written client readers in
// packages/commerce-client/src/wire-readers.ts, written as schemas.
import { Type, type Static } from "typebox";

// The runtime global used below; the package compiles with ES types only.
declare const URL: new (input: string) => { protocol: string };

/** Non-empty text with no leading or trailing white space (`requireText`). */
export const normalizedTextSchema = Type.String({
  minLength: 1,
  pattern: "^(?!\\s)[\\s\\S]*(?<!\\s)$",
});
export type NormalizedText = Static<typeof normalizedTextSchema>;

/**
 * Normalized text of at most `maxLength` UTF-16 code units, as `text.length`
 * counts them. A JSON Schema `maxLength` counts code points, so it is not used
 * here.
 */
export function boundedTextSchema(maxLength: number) {
  return Type.Refine(
    normalizedTextSchema,
    fitsUtf16Length.bind(null, maxLength),
    tooLongError.bind(null, maxLength),
  );
}

function fitsUtf16Length(maxLength: number, value: string): boolean {
  return value.length <= maxLength;
}

function tooLongError(maxLength: number): string {
  return `must be at most ${maxLength} characters`;
}

/** Lowercase SHA-256 hex (`requireSha256Digest`). */
export const sha256HexSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });

/** Three uppercase letters (`requireCurrency`). */
export const currencyCodeTextSchema = Type.String({ pattern: "^[A-Z]{3}$" });

/** Two uppercase letters (`requireCountryCode`). */
export const countryCodeTextSchema = Type.String({ pattern: "^[A-Z]{2}$" });

/** Six to ten digits (`requireHsCode`). */
export const hsCodeSchema = Type.String({ pattern: "^\\d{6,10}$" });

/**
 * An RFC 3339 UTC timestamp (`requireTimestamp`). The text keeps its own
 * precision; it never passes through `Date` to be stored.
 */
export const utcTimestampSchema = Type.Refine(
  normalizedTextSchema,
  isUtcTimestamp,
  utcTimestampError,
);

/** An HTTPS URL (`requireUrl`). */
export const httpsUrlSchema = Type.Refine(
  normalizedTextSchema,
  isHttpsUrl,
  httpsUrlError,
);

function isUtcTimestamp(value: string): boolean {
  return value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function utcTimestampError(): string {
  return "must be an RFC 3339 UTC timestamp";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function httpsUrlError(): string {
  return "must be an HTTPS URL";
}
