import type { CountryCode } from "@seams/commerce-contracts";

export function requireObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

export function requireExactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== expected.size ||
    actual.some((key) => !expected.has(key))
  ) {
    throw new Error(`${field} fields are invalid`);
  }
}

export function requireArray(
  value: unknown,
  field: string,
): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

export function requireText(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (text.length === 0 || text !== text.trim())
    throw new Error(`${field} must be normalized text`);
  return text;
}

export function requireBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const text = requireText(value, field);
  if (text.length > maxLength) throw new Error(`${field} is too long`);
  return text;
}

export function requireSha256Digest(value: unknown, field: string): string {
  const digest = requireText(value, field);
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

export function requireCountryCode(value: unknown, field: string): CountryCode {
  const text = requireText(value, field);
  if (!/^[A-Z]{2}$/u.test(text)) {
    throw new Error(`${field} must be a two-letter uppercase country code`);
  }
  return text;
}

export function requireHsCode(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!/^\d{6,10}$/u.test(text))
    throw new Error(`${field} must contain 6 to 10 digits`);
  return text;
}

export function requireSha256(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!/^[a-f0-9]{64}$/u.test(text))
    throw new Error(`${field} must be a SHA-256 digest`);
  return text;
}

export function requireTimestamp(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!text.endsWith("Z") || Number.isNaN(Date.parse(text))) {
    throw new Error(`${field} must be an RFC 3339 UTC timestamp`);
  }
  return text;
}

export function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export function requireNonNegativeInteger(
  value: unknown,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

export function requireCurrency(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!/^[A-Z]{3}$/u.test(text))
    throw new Error(`${field} must be an ISO-style currency code`);
  return text;
}

export function requireUrl(value: unknown, field: string): string {
  const text = requireText(value, field);
  const parsed = new URL(text);
  if (parsed.protocol !== "https:") throw new Error(`${field} must use HTTPS`);
  return text;
}

export function requireEnum<const T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T {
  const text = requireText(value, field);
  const match = values.find((candidate) => candidate === text);
  if (match === undefined) throw new Error(`${field} is unsupported`);
  return match;
}

export function requireBaseUrl(value: string): string {
  const parsed = new URL(requireText(value, "baseUrl"));
  return parsed.toString().replace(/\/$/u, "");
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function responseMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return "Underclerk request failed";
}
