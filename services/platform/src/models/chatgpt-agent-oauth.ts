import { encodeBase64Url, isRecord, parseJsonOrNull } from "@seams/std";
import { jwtClaims } from "../lenient-base64";
import { pkceChallenge } from "../provider-adapters/authorization";
import type { Result } from "../result";
import { RequestDeadline } from "../request-deadline";

// "Sign in with ChatGPT" for agents of other companies (Plan 74B): OpenAI's
// public route that lets the ChatGPT plan pay for requests to
// api.openai.com. pi-ai 1.1.0 implements it for a local CLI and keeps it
// internal, so Pantry owns its own copy. Each token request takes the
// `providerFetch` of the model exit Worker (Plan 73).
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
/** The first sign-in registers a client; OpenAI returns its issued id. */
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME = "Seams Sous Chef";
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
/**
 * OpenAI accepts a loopback callback only. Nothing listens there: the
 * person copies the address of the page that does not load into Portal.
 */
const CHATGPT_AGENT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_PASTED_ADDRESS_LENGTH = 8_192;

/**
 * One open sign-in. `clientId` is the issued client of an earlier sign-in
 * of this organisation, or null for the first one. `hostId` names Pantry's
 * deployment for this organisation and stays the same across sign-ins.
 * `authorizationUrl` is the address that the person opens.
 */
export type ChatGptAgentSignIn = Readonly<{
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  clientId: string | null;
  hostId: string;
}>;

/** The tokens of one sign-in and the client that OpenAI issued for it. */
export type ChatGptAgentProfile = Readonly<{
  clientId: string;
  hostId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token expires, in Unix milliseconds. */
  expiresAt: number;
  scopes: readonly string[];
}>;

/** What an earlier sign-in of the organisation lets a new one reuse. */
export type ChatGptAgentReuse = Pick<
  ChatGptAgentProfile,
  "clientId" | "hostId" | "idToken"
>;

type ChatGptAgentCallbackError = Readonly<{
  code:
    | "chatgpt_sign_in_address_invalid"
    | "chatgpt_sign_in_denied"
    | "chatgpt_sign_in_client_mismatch";
}>;

type ChatGptAgentTokenError = Readonly<{
  code:
    | "chatgpt_oauth_provider_unavailable"
    | "chatgpt_oauth_grant_refused"
    | "chatgpt_oauth_scope_missing";
}>;

/** Start a sign-in and build the address that the person opens. */
export async function startChatGptAgentSignIn(
  reuse: ChatGptAgentReuse | null,
): Promise<Readonly<{ signIn: ChatGptAgentSignIn }>> {
  const signIn = {
    state: randomValue(),
    nonce: randomValue(),
    codeVerifier: randomValue(),
    clientId: reuse?.clientId ?? null,
    hostId: reuse?.hostId ?? `urn:uuid:${crypto.randomUUID()}`,
  };
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: signIn.clientId ?? DYNAMIC_CLIENT_ID,
    // A known client skips the account and consent screens.
    ...(reuse === null
      ? { agent_name_hint: AGENT_NAME }
      : { id_token_hint: reuse.idToken }),
    ext_agent_host_id: signIn.hostId,
    response_type: "code",
    redirect_uri: CHATGPT_AGENT_REDIRECT_URI,
    resource: RESOURCE,
    scope: SCOPE,
    state: signIn.state,
    nonce: signIn.nonce,
    code_challenge: await pkceChallenge(signIn.codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return { signIn: { ...signIn, authorizationUrl: url.toString() } };
}

/**
 * The code and the client in the address that the person pasted. The
 * address must be the callback of this sign-in, with its state.
 */
export function parseChatGptAgentCallback(
  pasted: unknown,
  signIn: ChatGptAgentSignIn,
): Result<
  Readonly<{ code: string; clientId: string }>,
  ChatGptAgentCallbackError
> {
  const invalid = {
    ok: false,
    error: { code: "chatgpt_sign_in_address_invalid" },
  } as const;
  if (typeof pasted !== "string" || pasted.length > MAX_PASTED_ADDRESS_LENGTH)
    return invalid;
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return invalid;
  }
  const expected = new URL(CHATGPT_AGENT_REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname)
    return invalid;
  if (url.searchParams.get("state") !== signIn.state) return invalid;
  if (url.searchParams.get("error") !== null)
    return { ok: false, error: { code: "chatgpt_sign_in_denied" } };
  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) return invalid;
  // A new registration names its client. A later sign-in may omit it, and
  // must not name another one.
  const named = url.searchParams.get("client_id")?.trim() || null;
  const clientId = named ?? signIn.clientId;
  if (clientId === null) return invalid;
  if (signIn.clientId !== null && clientId !== signIn.clientId)
    return { ok: false, error: { code: "chatgpt_sign_in_client_mismatch" } };
  return { ok: true, value: { code, clientId } };
}

/** Exchange the code once, for the client that OpenAI issued. */
export async function exchangeChatGptAgentCode(
  providerFetch: typeof fetch,
  signIn: ChatGptAgentSignIn,
  callback: Readonly<{ code: string; clientId: string }>,
): Promise<Result<ChatGptAgentProfile, ChatGptAgentTokenError>> {
  const tokens = await requestTokens(providerFetch, {
    grant_type: "authorization_code",
    client_id: callback.clientId,
    code: callback.code,
    code_verifier: signIn.codeVerifier,
    redirect_uri: CHATGPT_AGENT_REDIRECT_URI,
    resource: RESOURCE,
  });
  if (!tokens.ok) return tokens;
  // The ID token must answer this sign-in. It came straight from OpenAI's
  // token endpoint over TLS, so Pantry reads its claims without a signature
  // check, as pi-ai does.
  const idToken = tokens.value.idToken;
  if (idToken === null || jwtClaims(idToken)?.nonce !== signIn.nonce)
    return unavailable();
  return {
    ok: true,
    value: {
      clientId: callback.clientId,
      hostId: signIn.hostId,
      idToken,
      accessToken: tokens.value.accessToken,
      refreshToken: tokens.value.refreshToken,
      expiresAt: tokens.value.expiresAt,
      scopes: tokens.value.scopes,
    },
  };
}

/**
 * Exchange the refresh token once. OpenAI rotates the refresh token, so the
 * caller must hold the connection's refresh lease and must never repeat an
 * exchange whose answer it did not read.
 */
export async function refreshChatGptAgentProfile(
  providerFetch: typeof fetch,
  profile: ChatGptAgentProfile,
): Promise<Result<ChatGptAgentProfile, ChatGptAgentTokenError>> {
  const tokens = await requestTokens(providerFetch, {
    grant_type: "refresh_token",
    client_id: profile.clientId,
    refresh_token: profile.refreshToken,
    resource: RESOURCE,
  });
  if (!tokens.ok) return tokens;
  return {
    ok: true,
    value: {
      ...profile,
      idToken: tokens.value.idToken ?? profile.idToken,
      accessToken: tokens.value.accessToken,
      refreshToken: tokens.value.refreshToken,
      expiresAt: tokens.value.expiresAt,
      scopes: tokens.value.scopes,
    },
  };
}

/** The ChatGPT plan that the ID token names, if it names one. */
export function chatGptAgentPlanType(
  profile: ChatGptAgentProfile,
): string | null {
  const auth = jwtClaims(profile.idToken)?.[JWT_AUTH_CLAIM];
  return isRecord(auth) &&
    typeof auth.chatgpt_plan_type === "string" &&
    auth.chatgpt_plan_type.length > 0
    ? auth.chatgpt_plan_type
    : null;
}

export function serializeChatGptAgentSignIn(
  signIn: ChatGptAgentSignIn,
): string {
  return JSON.stringify(signIn);
}

export function parseChatGptAgentSignIn(
  raw: string,
): ChatGptAgentSignIn | null {
  const value = parseJsonOrNull(raw);
  return isRecord(value) &&
    nonEmptyString(value.authorizationUrl) &&
    nonEmptyString(value.state) &&
    nonEmptyString(value.nonce) &&
    nonEmptyString(value.codeVerifier) &&
    (value.clientId === null || nonEmptyString(value.clientId)) &&
    nonEmptyString(value.hostId)
    ? {
        authorizationUrl: value.authorizationUrl,
        state: value.state,
        nonce: value.nonce,
        codeVerifier: value.codeVerifier,
        clientId: value.clientId,
        hostId: value.hostId,
      }
    : null;
}

export function serializeChatGptAgentProfile(
  profile: ChatGptAgentProfile,
): string {
  return JSON.stringify(profile);
}

export function parseChatGptAgentProfile(
  raw: string,
): ChatGptAgentProfile | null {
  const value = parseJsonOrNull(raw);
  return isRecord(value) &&
    nonEmptyString(value.clientId) &&
    nonEmptyString(value.hostId) &&
    nonEmptyString(value.idToken) &&
    nonEmptyString(value.accessToken) &&
    nonEmptyString(value.refreshToken) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    Array.isArray(value.scopes) &&
    value.scopes.every(nonEmptyString)
    ? {
        clientId: value.clientId,
        hostId: value.hostId,
        idToken: value.idToken,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
        scopes: value.scopes,
      }
    : null;
}

type TokenResponse = Readonly<{
  idToken: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: readonly string[];
}>;

async function requestTokens(
  providerFetch: typeof fetch,
  body: Readonly<Record<string, string>>,
): Promise<Result<TokenResponse, ChatGptAgentTokenError>> {
  const deadline = new RequestDeadline(15_000);
  let status: number;
  let raw: unknown;
  try {
    const response = await providerFetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      signal: deadline.signal,
      redirect: "manual",
    });
    status = response.status;
    raw = parseJsonOrNull(await response.text());
  } catch {
    // Token response bodies hold credentials. Do not expose or log them.
    return unavailable();
  } finally {
    deadline.end();
  }
  // OpenAI answers a used, expired or revoked grant with a 4xx OAuth error.
  if (
    status >= 400 &&
    status < 500 &&
    isRecord(raw) &&
    typeof raw.error === "string"
  )
    return { ok: false, error: { code: "chatgpt_oauth_grant_refused" } };
  if (
    status !== 200 ||
    !isRecord(raw) ||
    !nonEmptyString(raw.access_token) ||
    !nonEmptyString(raw.refresh_token) ||
    typeof raw.expires_in !== "number" ||
    !Number.isFinite(raw.expires_in) ||
    raw.expires_in <= 0 ||
    typeof raw.scope !== "string"
  )
    return unavailable();
  const scopes = raw.scope.trim().split(/\s+/u).filter(nonEmptyString);
  if (!scopes.includes(DIRECT_TOKEN_SCOPE))
    return { ok: false, error: { code: "chatgpt_oauth_scope_missing" } };
  return {
    ok: true,
    value: {
      idToken: nonEmptyString(raw.id_token) ? raw.id_token : null,
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      expiresAt: Date.now() + raw.expires_in * 1000,
      scopes,
    },
  };
}

function randomValue(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unavailable(): Readonly<{ ok: false; error: ChatGptAgentTokenError }> {
  return { ok: false, error: { code: "chatgpt_oauth_provider_unavailable" } };
}
