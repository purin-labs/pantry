import { decodeBase64, encodeBase64, isRecord } from "@seams/std";

type CursorBinding = Readonly<{
  sessionToken: string;
  organisationId: string;
  integrationAccountId: string;
  query: string;
}>;

// Session-bound encryption keeps provider tokens and search text out of cursors.
export async function sealMailInboxCursor(
  binding: CursorBinding,
  pageToken: string,
): Promise<string> {
  const key = await cursorKey(binding.sessionToken);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(
    JSON.stringify({ pageToken, expiresAt: Date.now() + 15 * 60_000 }),
  );
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: cursorAudience(binding) },
    key,
    body,
  );
  return `${encodeBase64(iv)}.${encodeBase64(new Uint8Array(sealed))}`;
}

export async function openMailInboxCursor(
  binding: CursorBinding,
  cursor: string,
): Promise<string | null> {
  try {
    const parts = cursor.split(".");
    if (parts.length !== 2) return null;
    const iv = decodeBase64(parts[0] ?? "");
    const body = decodeBase64(parts[1] ?? "");
    if (iv === null || iv.length !== 12 || body === null) return null;
    const key = await cursorKey(binding.sessionToken);
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: cursorAudience(binding) },
      key,
      body,
    );
    const raw: unknown = JSON.parse(new TextDecoder().decode(opened));
    if (
      !isRecord(raw) ||
      typeof raw.pageToken !== "string" ||
      raw.pageToken.length === 0 ||
      raw.pageToken.length > 2048 ||
      typeof raw.expiresAt !== "number" ||
      raw.expiresAt <= Date.now()
    )
      return null;
    return raw.pageToken;
  } catch {
    return null;
  }
}

async function cursorKey(sessionToken: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`satyr-mail-inbox-cursor-v1:${sessionToken}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function cursorAudience(binding: CursorBinding): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      binding.organisationId,
      binding.integrationAccountId,
      binding.query,
    ]),
  );
}
