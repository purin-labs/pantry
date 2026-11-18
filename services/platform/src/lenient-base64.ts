import { isRecord, parseJsonOrNull } from "@seams/std";

/**
 * Base64 from providers and configuration can use either alphabet and can
 * carry `=` padding: Gmail and Pub/Sub send padded base64. These helpers keep
 * that input valid for `atob` and `decodeBase64`. A value that Pantry encodes
 * itself goes through the strict `decodeBase64Url` from @seams/std instead.
 */

/** `value` with the URL-safe `-` and `_` written as `+` and `/`. */
export function standardBase64(value: string): string {
  return value.replaceAll("-", "+").replaceAll("_", "/");
}

/** {@link standardBase64}, padded with `=` to a multiple of four. */
export function paddedStandardBase64(value: string): string {
  const standard = standardBase64(value);
  return standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
}

/**
 * The payload claims of a JWT, or null. It does not check the signature, and
 * it reads the payload as one character for each byte, as `atob` returns it.
 */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const claims = parseJsonOrNull(atob(paddedStandardBase64(payload)));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}
