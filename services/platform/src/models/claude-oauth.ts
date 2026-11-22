import { pkceChallenge } from "../provider-adapters/authorization";
import { encodeBase64Url, isRecord } from "@purin-labs/std";
import type { Result } from "@purin-labs/kernel/result";
import { RequestDeadline } from "@purin-labs/kernel/request-deadline";

// Pi 1.1.0's copy-code OAuth protocol. This callback is hosted by Anthropic.
// Each token request takes the `providerFetch` of the model exit Worker
// (Plan 73).
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export type ClaudeTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}>;

type ClaudeOAuthError = Readonly<{
  code: "claude_oauth_code_invalid" | "claude_oauth_provider_unavailable";
}>;

export async function createClaudeAuthorization(): Promise<
  Readonly<{
    verifier: string;
    authorizationUrl: string;
  }>
> {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, authorizationUrl: await claudeAuthorizationUrl(verifier) };
}

export async function claudeAuthorizationUrl(
  verifier: string,
): Promise<string> {
  const challenge = await pkceChallenge(verifier);
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return `https://claude.ai/oauth/authorize?${params}`;
}

export function parseClaudeAuthorizationCode(raw: unknown): Result<
  Readonly<{
    code: string;
    state: string;
  }>,
  ClaudeOAuthError
> {
  if (typeof raw !== "string" || raw.length > 4096) {
    return { ok: false, error: { code: "claude_oauth_code_invalid" } };
  }
  const parts = raw.trim().split("#");
  const [code, state] = parts;
  if (parts.length !== 2 || !code || !state || /\s/.test(code + state)) {
    return { ok: false, error: { code: "claude_oauth_code_invalid" } };
  }
  return { ok: true, value: { code, state } };
}

export function exchangeClaudeAuthorizationCode(
  providerFetch: typeof fetch,
  code: string,
  verifier: string,
): Promise<Result<ClaudeTokens, ClaudeOAuthError>> {
  return requestClaudeTokens(providerFetch, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state: verifier,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

export function refreshClaudeTokens(
  providerFetch: typeof fetch,
  refreshToken: string,
): Promise<Result<ClaudeTokens, ClaudeOAuthError>> {
  return requestClaudeTokens(providerFetch, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
}

async function requestClaudeTokens(
  providerFetch: typeof fetch,
  body: Readonly<Record<string, string>>,
): Promise<Result<ClaudeTokens, ClaudeOAuthError>> {
  const deadline = new RequestDeadline(15_000);
  try {
    const response = await providerFetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: deadline.signal,
      redirect: "manual",
    });
    if (!response.ok)
      return {
        ok: false,
        error: { code: "claude_oauth_provider_unavailable" },
      };
    const raw: unknown = await response.json();
    if (
      !isRecord(raw) ||
      typeof raw.access_token !== "string" ||
      !raw.access_token.startsWith("sk-ant-oat") ||
      typeof raw.refresh_token !== "string" ||
      raw.refresh_token.length === 0 ||
      typeof raw.expires_in !== "number" ||
      !Number.isSafeInteger(raw.expires_in) ||
      raw.expires_in <= 300
    ) {
      return {
        ok: false,
        error: { code: "claude_oauth_provider_unavailable" },
      };
    }
    return {
      ok: true,
      value: {
        accessToken: raw.access_token,
        refreshToken: raw.refresh_token,
        expiresAt: Date.now() + (raw.expires_in - 300) * 1000,
      },
    };
  } catch {
    // Provider response bodies can contain credentials. Do not expose or log them.
    return { ok: false, error: { code: "claude_oauth_provider_unavailable" } };
  } finally {
    deadline.end();
  }
}
