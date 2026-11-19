import { isRecord } from "@purin-labs/std";

export type CommerceApiKey = Readonly<{
  credentialId: string;
  label: string;
  scopes: readonly string[];
  createdAt: string;
  revokedAt: string | null;
}>;

export function parseKey(raw: unknown): CommerceApiKey {
  if (
    !isRecord(raw) ||
    typeof raw.credentialId !== "string" ||
    typeof raw.label !== "string" ||
    !Array.isArray(raw.scopes) ||
    !raw.scopes.every((scope: unknown) => typeof scope === "string") ||
    typeof raw.createdAt !== "string" ||
    (raw.revokedAt !== null && typeof raw.revokedAt !== "string")
  )
    throw unexpected();
  return {
    credentialId: raw.credentialId,
    label: raw.label,
    scopes: raw.scopes as readonly string[],
    createdAt: raw.createdAt,
    revokedAt: raw.revokedAt,
  };
}

export function unexpected(): Error {
  return new Error("The server returned an unexpected response.");
}
