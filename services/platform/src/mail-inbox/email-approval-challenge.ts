import type { Env } from "../env";
import { digestCanonical } from "../policy/information-flow/digest";

/**
 * The approval challenge binds one rendered preview to one approver. It is a
 * keyed HMAC rather than a bare digest so a challenge can only originate from
 * a preview this Worker actually served: an approver who never loaded the
 * current draft cannot mint one from values they already know, and a replayed
 * challenge from an older version fails the comparison.
 */
export async function emailApprovalChallenge(
  input: Readonly<{
    secret: string;
    proposalId: string;
    version: number;
    snapshotDigest: string;
    userId: string;
  }>,
): Promise<string> {
  const key = await emailApprovalKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(emailApprovalChallengePayload(input)),
  );
  return base64UrlBytes(new Uint8Array(signature));
}

export async function verifyEmailApprovalChallenge(
  input: Readonly<{
    secret: string;
    proposalId: string;
    version: number;
    snapshotDigest: string;
    userId: string;
    challenge: string;
  }>,
): Promise<boolean> {
  const signature = decodeBase64UrlBytes(input.challenge);
  if (signature === null) return false;
  const key = await emailApprovalKey(input.secret, ["verify"]);
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(emailApprovalChallengePayload(input)),
  );
}

export function emailApprovalChallengePayload(
  input: Readonly<{
    proposalId: string;
    version: number;
    snapshotDigest: string;
    userId: string;
  }>,
): string {
  return JSON.stringify({
    kind: "satyr_email_approval_challenge_v1",
    proposalId: input.proposalId,
    version: input.version,
    snapshotDigest: input.snapshotDigest,
    userId: input.userId,
  });
}

export function emailApprovalKey(
  secret: string,
  usages: Array<"sign" | "verify">,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export function emailApprovalSecret(env: Env): string | null {
  const secret = env.SESSION_TOKEN_SECRET;
  return secret === undefined || secret.trim().length === 0 ? null : secret;
}

export function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodeBase64UrlBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/u.test(value)) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    );
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function relationshipChallengeDigest(
  snapshotDigest: string,
  relationshipDigest: string,
): Promise<string> {
  return digestCanonical({
    kind: "email_relationship_correction",
    snapshotDigest,
    relationshipDigest,
  });
}
