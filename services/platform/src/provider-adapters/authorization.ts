import { encodeBase64Url, isRecord } from "@purin-labs/std";

export const SHORT_PROVIDER_STATE_TTL_MS = 10 * 60 * 1_000;
export const STRIPE_PROVIDER_STATE_TTL_MS = 2 * 60 * 60 * 1_000;

export function configuredValue(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  return value.length === 0 ? null : value;
}

export function exactScopeIsGranted(
  requiredScope: string,
  grantedScopes: ReadonlySet<string>,
): boolean {
  return grantedScopes.has(requiredScope);
}

/** Whether the granted scopes hold each scope that the adapter requires. */
export function scopesAreComplete(
  adapter: Readonly<{
    requiredScopes: readonly string[];
    scopeIsGranted: (
      requiredScope: string,
      grantedScopes: ReadonlySet<string>,
    ) => boolean;
  }>,
  grantedScopes: readonly string[],
): boolean {
  const granted = new Set(grantedScopes);
  return adapter.requiredScopes.every((requiredScope) =>
    adapter.scopeIsGranted(requiredScope, granted),
  );
}

export function parseProviderOnlyStartContext<
  P extends
    | "airtable"
    | "dropbox"
    | "gmail"
    | "google_drive"
    | "notion"
    | "slack"
    | "square"
    | "stripe"
    | "whatsapp",
>(provider: P, raw: unknown): { readonly provider: P } | null {
  return isRecord(raw) && raw.provider === provider ? { provider } : null;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}
