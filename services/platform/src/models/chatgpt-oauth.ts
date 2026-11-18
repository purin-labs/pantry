import { isRecord, parseJsonOrNull } from "@seams/std";
import type { CodexAllowance } from "@seams/control-api";
import { jwtClaims } from "../lenient-base64";
import type { Result } from "../result";
import { RequestDeadline } from "../request-deadline";

// The ChatGPT sign-in of the Codex CLI, which pi-ai's legacy `openai-codex`
// provider also uses. pi-ai keeps these flows internal, so Pantry owns them.
// Each request takes the `providerFetch` of the model exit Worker (Plan 73).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ORIGIN = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_ORIGIN}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URL = `${AUTH_ORIGIN}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_ORIGIN}/deviceauth/callback`;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * The tokens of a Codex `auth.json`. The profile in the Vault keeps that file
 * as it is; `file` is the parsed file, so a write keeps its other fields.
 */
export type ChatGptAuthProfile = Readonly<{
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  file: Readonly<Record<string, unknown>>;
}>;

export type ChatGptDeviceAuthorization = Readonly<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
}>;

export type ChatGptDeviceAuthorizationStatus =
  | Readonly<{ kind: "awaiting_user"; profile?: never }>
  | Readonly<{ kind: "failed"; profile?: never }>
  | Readonly<{ kind: "authorized"; profile: ChatGptAuthProfile }>;

/** What the ChatGPT backend reports about the included allowance. */
type ChatGptAllowanceObservation = Readonly<{
  planType: string | null;
  allowance: CodexAllowance;
  /** True when the backend refuses requests until a window resets. */
  limitReached: boolean;
}>;

type ChatGptOAuthError = Readonly<{
  code: "chatgpt_oauth_provider_unavailable";
}>;

export function parseChatGptAuthProfile(
  raw: string,
): ChatGptAuthProfile | null {
  const file = parseJsonOrNull(raw);
  if (!isRecord(file) || !isRecord(file.tokens)) return null;
  const tokens = file.tokens;
  if (
    typeof tokens.access_token !== "string" ||
    tokens.access_token.length === 0 ||
    typeof tokens.refresh_token !== "string" ||
    tokens.refresh_token.length === 0
  )
    return null;
  const accountId =
    typeof tokens.account_id === "string" && tokens.account_id.length > 0
      ? tokens.account_id
      : chatGptAccountId(tokens.access_token);
  if (accountId === null) return null;
  return {
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : "",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId,
    file,
  };
}

/** The profile as a Codex `auth.json`, with the file's other fields kept. */
export function serializeChatGptAuthProfile(
  profile: ChatGptAuthProfile,
  refreshedAt: number,
): string {
  const tokens = isRecord(profile.file.tokens) ? profile.file.tokens : {};
  return JSON.stringify({
    ...profile.file,
    tokens: {
      ...tokens,
      id_token: profile.idToken,
      access_token: profile.accessToken,
      refresh_token: profile.refreshToken,
      account_id: profile.accountId,
    },
    last_refresh: new Date(refreshedAt).toISOString(),
  });
}

/** When the access token expires, in Unix milliseconds; null if unknown. */
export function chatGptAccessTokenExpiry(accessToken: string): number | null {
  const claims = jwtClaims(accessToken);
  return claims !== null &&
    typeof claims.exp === "number" &&
    Number.isFinite(claims.exp)
    ? claims.exp * 1000
    : null;
}

/** The plan that the sign-in names, from the ID token or the access token. */
export function chatGptPlanType(profile: ChatGptAuthProfile): string | null {
  for (const token of [profile.idToken, profile.accessToken]) {
    const auth = jwtClaims(token)?.[JWT_AUTH_CLAIM];
    if (
      isRecord(auth) &&
      typeof auth.chatgpt_plan_type === "string" &&
      auth.chatgpt_plan_type.length > 0
    )
      return auth.chatgpt_plan_type;
  }
  return null;
}

export async function startChatGptDeviceAuthorization(
  providerFetch: typeof fetch,
): Promise<Result<ChatGptDeviceAuthorization, ChatGptOAuthError>> {
  const raw = await requestJson(providerFetch, DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!raw.ok || raw.value.status !== 200) return unavailable();
  const body = raw.value.body;
  const userCode = isRecord(body)
    ? (body.user_code ?? body.usercode)
    : undefined;
  if (
    !isRecord(body) ||
    typeof body.device_auth_id !== "string" ||
    body.device_auth_id.length === 0 ||
    typeof userCode !== "string" ||
    userCode.length === 0
  )
    return unavailable();
  return {
    ok: true,
    value: {
      deviceAuthId: body.device_auth_id,
      userCode,
      verificationUrl: DEVICE_VERIFICATION_URL,
    },
  };
}

/**
 * One poll of a device authorization. When the person has approved it, the
 * authorization code is exchanged for tokens at once: the code works once.
 */
export async function pollChatGptDeviceAuthorization(
  providerFetch: typeof fetch,
  device: ChatGptDeviceAuthorization,
): Promise<Result<ChatGptDeviceAuthorizationStatus, ChatGptOAuthError>> {
  const polled = await requestJson(providerFetch, DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: device.deviceAuthId,
      user_code: device.userCode,
    }),
  });
  if (!polled.ok) return polled;
  const { status, body } = polled.value;
  if (status === 403 || status === 404)
    return { ok: true, value: { kind: "awaiting_user" } };
  if (status !== 200) {
    const error = isRecord(body) ? body.error : undefined;
    const code = isRecord(error) ? error.code : error;
    if (code === "deviceauth_authorization_pending" || code === "slow_down")
      return { ok: true, value: { kind: "awaiting_user" } };
    return status >= 500
      ? unavailable()
      : { ok: true, value: { kind: "failed" } };
  }
  if (
    !isRecord(body) ||
    typeof body.authorization_code !== "string" ||
    typeof body.code_verifier !== "string"
  )
    return { ok: true, value: { kind: "failed" } };
  const tokens = await requestTokens(providerFetch, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: body.authorization_code,
    code_verifier: body.code_verifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  });
  if (!tokens.ok) return { ok: true, value: { kind: "failed" } };
  if (tokens.value.idToken === null)
    return { ok: true, value: { kind: "failed" } };
  const accountId = chatGptAccountId(tokens.value.accessToken);
  if (accountId === null) return { ok: true, value: { kind: "failed" } };
  return {
    ok: true,
    value: {
      kind: "authorized",
      profile: {
        idToken: tokens.value.idToken,
        accessToken: tokens.value.accessToken,
        refreshToken: tokens.value.refreshToken,
        accountId,
        file: { OPENAI_API_KEY: null },
      },
    },
  };
}

/**
 * Exchange the refresh token once. OpenAI rotates the refresh token, so the
 * caller must hold the connection's refresh lease and must never repeat an
 * exchange whose answer it did not read.
 */
export async function refreshChatGptAuthProfile(
  providerFetch: typeof fetch,
  profile: ChatGptAuthProfile,
): Promise<Result<ChatGptAuthProfile, ChatGptOAuthError>> {
  const tokens = await requestTokens(providerFetch, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: profile.refreshToken,
  });
  if (!tokens.ok) return tokens;
  const accountId = chatGptAccountId(tokens.value.accessToken);
  if (accountId === null) return unavailable();
  return {
    ok: true,
    value: {
      idToken: tokens.value.idToken ?? profile.idToken,
      accessToken: tokens.value.accessToken,
      refreshToken: tokens.value.refreshToken,
      accountId,
      file: profile.file,
    },
  };
}

/** The allowance read with no turn (`wham/usage`). */
export async function readChatGptAllowance(
  providerFetch: typeof fetch,
  profile: Pick<ChatGptAuthProfile, "accessToken" | "accountId">,
): Promise<Result<ChatGptAllowanceObservation, ChatGptOAuthError>> {
  const read = await requestJson(providerFetch, USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${profile.accessToken}`,
      "chatgpt-account-id": profile.accountId,
      originator: "pi",
      Accept: "application/json",
    },
  });
  if (!read.ok || read.value.status !== 200 || !isRecord(read.value.body))
    return unavailable();
  const body = read.value.body;
  const limits = isRecord(body.rate_limit) ? body.rate_limit : {};
  const primary = isRecord(limits.primary_window) ? limits.primary_window : {};
  const secondary = isRecord(limits.secondary_window)
    ? limits.secondary_window
    : null;
  const credits = isRecord(body.credits) ? body.credits : {};
  const usedPercent = finiteNumber(primary.used_percent);
  return {
    ok: true,
    value: {
      planType: typeof body.plan_type === "string" ? body.plan_type : null,
      allowance:
        usedPercent === null
          ? { kind: "unavailable" }
          : {
              kind: "available",
              usedPercent,
              resetsAt: unixMillis(primary.reset_at),
              secondaryUsedPercent:
                secondary === null
                  ? null
                  : finiteNumber(secondary.used_percent),
              secondaryResetsAt:
                secondary === null ? null : unixMillis(secondary.reset_at),
              credits:
                credits.unlimited === true || credits.has_credits === true
                  ? "available"
                  : credits.has_credits === false
                    ? "exhausted"
                    : "unknown",
            },
      limitReached: limits.limit_reached === true,
    },
  };
}

/**
 * The allowance in the `x-codex-*` headers of a model response, or null when
 * the response carries none.
 */
export function chatGptAllowanceFromHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<{ planType: string | null; allowance: CodexAllowance }> | null {
  const header = (name: string): string | undefined =>
    headers[`x-codex-${name}`];
  const usedPercent = finiteNumber(header("primary-used-percent"));
  if (usedPercent === null) return null;
  const secondaryWindow = finiteNumber(header("secondary-window-minutes"));
  const hasSecondary = secondaryWindow !== null && secondaryWindow > 0;
  const planType = header("plan-type");
  return {
    planType: planType !== undefined && planType.length > 0 ? planType : null,
    allowance: {
      kind: "available",
      usedPercent,
      resetsAt: unixMillis(header("primary-reset-at")),
      secondaryUsedPercent: hasSecondary
        ? finiteNumber(header("secondary-used-percent"))
        : null,
      secondaryResetsAt: hasSecondary
        ? unixMillis(header("secondary-reset-at"))
        : null,
      credits:
        headerFlag(header("credits-unlimited")) ||
        headerFlag(header("credits-has-credits"))
          ? "available"
          : "exhausted",
    },
  };
}

type TokenResponse = Readonly<{
  idToken: string | null;
  accessToken: string;
  refreshToken: string;
}>;

async function requestTokens(
  providerFetch: typeof fetch,
  body: Readonly<Record<string, string>>,
): Promise<Result<TokenResponse, ChatGptOAuthError>> {
  const answered = await requestJson(providerFetch, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!answered.ok || answered.value.status !== 200) return unavailable();
  const raw = answered.value.body;
  if (
    !isRecord(raw) ||
    typeof raw.access_token !== "string" ||
    raw.access_token.length === 0 ||
    typeof raw.refresh_token !== "string" ||
    raw.refresh_token.length === 0
  )
    return unavailable();
  return {
    ok: true,
    value: {
      idToken:
        typeof raw.id_token === "string" && raw.id_token.length > 0
          ? raw.id_token
          : null,
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
    },
  };
}

async function requestJson(
  providerFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<
  Result<Readonly<{ status: number; body: unknown }>, ChatGptOAuthError>
> {
  const deadline = new RequestDeadline(15_000);
  try {
    const response = await providerFetch(url, {
      ...init,
      signal: deadline.signal,
      redirect: "manual",
    });
    const text = await response.text();
    return {
      ok: true,
      value: { status: response.status, body: parseJsonOrNull(text) },
    };
  } catch {
    // Provider response bodies can contain credentials. Do not expose or log them.
    return unavailable();
  } finally {
    deadline.end();
  }
}

function chatGptAccountId(accessToken: string): string | null {
  const auth = jwtClaims(accessToken)?.[JWT_AUTH_CLAIM];
  return isRecord(auth) &&
    typeof auth.chatgpt_account_id === "string" &&
    auth.chatgpt_account_id.length > 0
    ? auth.chatgpt_account_id
    : null;
}

function finiteNumber(raw: unknown): number | null {
  const value =
    typeof raw === "string" && raw.trim().length > 0 ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unixMillis(raw: unknown): number | null {
  const seconds = finiteNumber(raw);
  return seconds === null || seconds <= 0 ? null : seconds * 1000;
}

/** The backend writes these flags as `True` and `False`. */
function headerFlag(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

function unavailable(): Readonly<{ ok: false; error: ChatGptOAuthError }> {
  return { ok: false, error: { code: "chatgpt_oauth_provider_unavailable" } };
}
