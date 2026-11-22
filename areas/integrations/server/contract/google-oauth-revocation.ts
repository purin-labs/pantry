import {
  providerHttpFailure,
  type ProviderCleanupResult,
} from "./provider-adapter";

/** What a person does when Purin cannot revoke the Gmail access. */
export const GMAIL_MANUAL_INSTRUCTION =
  "revoke_gmail_access_in_google" as const;

/** Revokes a Google OAuth grant by its refresh token. */
export async function revokeGoogleOAuthToken(
  refreshToken: string,
  fetcher: typeof fetch,
): Promise<ProviderCleanupResult> {
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    });
  } catch {
    return {
      kind: "retryable_failure",
      reason: "provider_cleanup_http_unavailable",
    };
  }
  return response.ok
    ? { kind: "removed" }
    : providerHttpFailure(response.status, GMAIL_MANUAL_INSTRUCTION);
}
