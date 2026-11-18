import type { VaultSecret } from "../credential-vault";

export function basicApiKeyVaultSecret(value: string): VaultSecret | null {
  if (!/^[\x21-\x39\x3b-\x7e]+$/u.test(value)) return null;
  return {
    kind: "header",
    header: "Authorization",
    value: `Basic ${btoa(`${value}:`)}`,
  };
}

export function basicApiKeyFromVault(secret: VaultSecret): string | null {
  if (
    secret.kind !== "header" ||
    secret.header !== "Authorization" ||
    !secret.value.startsWith("Basic ")
  )
    return null;
  try {
    const decoded = atob(secret.value.slice(6));
    if (!decoded.endsWith(":")) return null;
    const key = decoded.slice(0, -1);
    return basicApiKeyVaultSecret(key) === null ? null : key;
  } catch {
    return null;
  }
}
