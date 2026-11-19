import { RequestDeadline } from "../request-deadline";
import type { Result } from "../result";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppMessageId,
  parseWhatsAppPhoneNumberId,
  type E164PhoneNumber,
  type MetaBusinessPortfolioId,
  type WhatsAppBusinessAccountId,
  type WhatsAppCustomerId,
  type WhatsAppMessageId,
  type WhatsAppPhoneNumberId,
} from "./identifiers";
import { isNonEmptyString, isRecord } from "@purin-labs/std";

/**
 * The only place Pantry talks to Meta. Every call takes an explicit `fetcher`
 * so the deterministic sandbox can substitute a fake Graph API at exactly
 * this boundary without any sandbox branch inside domain code. Runtime tokens
 * stay in authorization headers and never enter logs, traces, or errors.
 *
 * The pinned version is deployment configuration, not a per-call option, so
 * a provider upgrade is one deliberate edit with one set of fixtures.
 */
export const WHATSAPP_GRAPH_API_VERSION = "v23.0";
const GRAPH_ORIGIN = "https://graph.facebook.com";
const SEND_TIMEOUT_MS = 20_000;
const DISCOVERY_TIMEOUT_MS = 15_000;

export type WhatsAppGraphError = {
  readonly code: string;
  /** Meta's numeric error code when one was returned. Never its message text. */
  readonly providerCode: string | null;
};

/**
 * The three outcomes a single send attempt can have. `indeterminate` means
 * Pantry cannot prove whether Meta accepted the message, so the Case is fenced
 * and never retried automatically.
 */
export type WhatsAppSendOutcome =
  | { readonly kind: "accepted"; readonly whatsappMessageId: WhatsAppMessageId }
  | { readonly kind: "rejected"; readonly error: WhatsAppGraphError }
  | { readonly kind: "indeterminate"; readonly reason: string };

type WhatsAppDiscoveredPhoneNumber = {
  readonly phoneNumberId: WhatsAppPhoneNumberId;
  readonly displayPhoneNumber: E164PhoneNumber;
  readonly verifiedName: string;
};

export type WhatsAppGrantedAssets = {
  readonly businessPortfolioId: MetaBusinessPortfolioId;
  readonly wabaId: WhatsAppBusinessAccountId;
  readonly grantedScopes: readonly string[];
};

export type WhatsAppSignupExchange = {
  readonly assets: WhatsAppGrantedAssets;
  readonly credential:
    | { readonly kind: "bearer"; readonly value: string }
    | {
        readonly kind: "expiring_bearer";
        readonly value: string;
        readonly expiresAt: number;
      };
};

/**
 * Exchanges the Embedded Signup authorization code for the customer business
 * token and validates the exact assets and lifetime form granted to it.
 */
export async function exchangeWhatsAppSignupCode(
  input: Readonly<{
    appId: string;
    appSecret: string;
    code: string;
    redirectUri: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Result<WhatsAppSignupExchange, WhatsAppGraphError>> {
  const url = graphUrl("oauth/access_token", {
    client_id: input.appId,
    client_secret: input.appSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const exchanged = await graphJson(
    input.fetcher,
    url,
    { method: "GET" },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  if (!exchanged.ok) return exchanged;
  const accessToken =
    isRecord(exchanged.value) &&
    typeof exchanged.value.access_token === "string"
      ? exchanged.value.access_token
      : null;
  if (accessToken === null) {
    return {
      ok: false,
      error: { code: "whatsapp_signup_token_missing", providerCode: null },
    };
  }
  return inspectWhatsAppGrantedAssets({
    appId: input.appId,
    appSecret: input.appSecret,
    inputToken: accessToken,
    fetcher: input.fetcher,
    signal: input.signal,
  });
}

/**
 * Reads which WABA the owner actually granted. `granular_scopes` is the only
 * evidence of the grant; a token that names no WABA is not a usable
 * connection and must not create one.
 */
async function inspectWhatsAppGrantedAssets(
  input: Readonly<{
    appId: string;
    appSecret: string;
    inputToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Result<WhatsAppSignupExchange, WhatsAppGraphError>> {
  const url = graphUrl("debug_token", {
    input_token: input.inputToken,
    access_token: `${input.appId}|${input.appSecret}`,
  });
  const inspected = await graphJson(
    input.fetcher,
    url,
    { method: "GET" },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  if (!inspected.ok) return inspected;
  const data =
    isRecord(inspected.value) && isRecord(inspected.value.data)
      ? inspected.value.data
      : null;
  if (data === null || data.is_valid !== true) {
    return {
      ok: false,
      error: { code: "whatsapp_signup_token_invalid", providerCode: null },
    };
  }
  const credential = parseMetaBusinessToken(input.inputToken, data.expires_at);
  if (credential === null) {
    return {
      ok: false,
      error: {
        code: "whatsapp_signup_token_expiry_invalid",
        providerCode: null,
      },
    };
  }
  const scopes = Array.isArray(data.scopes)
    ? data.scopes.filter(isNonEmptyString)
    : [];
  const granular = Array.isArray(data.granular_scopes)
    ? data.granular_scopes
    : [];
  let wabaId: WhatsAppBusinessAccountId | null = null;
  let businessPortfolioId: MetaBusinessPortfolioId | null = null;
  for (const entry of granular) {
    if (!isRecord(entry) || !Array.isArray(entry.target_ids)) continue;
    const first = entry.target_ids.find(isNonEmptyString);
    if (first === undefined) continue;
    if (
      entry.scope === "whatsapp_business_messaging" ||
      entry.scope === "whatsapp_business_management"
    ) {
      const parsed = parseWhatsAppBusinessAccountId(first);
      if (parsed.ok && wabaId === null) wabaId = parsed.value;
    }
    if (entry.scope === "business_management") {
      const parsed = parseMetaBusinessPortfolioId(first);
      if (parsed.ok && businessPortfolioId === null)
        businessPortfolioId = parsed.value;
    }
  }
  if (wabaId === null) {
    return {
      ok: false,
      error: { code: "whatsapp_signup_waba_missing", providerCode: null },
    };
  }
  let owner: MetaBusinessPortfolioId | null;
  if (businessPortfolioId !== null) {
    owner = businessPortfolioId;
  } else {
    const discovered = await readWabaOwner({
      wabaId,
      accessToken: input.inputToken,
      fetcher: input.fetcher,
      signal: input.signal,
    });
    if (!discovered.ok) return discovered;
    owner = discovered.value;
  }
  if (owner === null) {
    return {
      ok: false,
      error: { code: "whatsapp_signup_portfolio_missing", providerCode: null },
    };
  }
  return {
    ok: true,
    value: {
      assets: { businessPortfolioId: owner, wabaId, grantedScopes: scopes },
      credential,
    },
  };
}

function parseMetaBusinessToken(
  value: string,
  rawExpiry: unknown,
): WhatsAppSignupExchange["credential"] | null {
  if (rawExpiry === 0) return { kind: "bearer", value };
  if (
    typeof rawExpiry !== "number" ||
    !Number.isSafeInteger(rawExpiry) ||
    rawExpiry < 0
  ) {
    return null;
  }
  const expiresAt = rawExpiry * 1_000;
  return Number.isSafeInteger(expiresAt)
    ? { kind: "expiring_bearer", value, expiresAt }
    : null;
}

export async function listWhatsAppPhoneNumbers(
  input: Readonly<{
    wabaId: WhatsAppBusinessAccountId;
    accessToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<
  Result<readonly WhatsAppDiscoveredPhoneNumber[], WhatsAppGraphError>
> {
  const url = graphUrl(`${input.wabaId}/phone_numbers`, {
    fields: "id,display_phone_number,verified_name",
  });
  const listed = await graphJson(
    input.fetcher,
    url,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  if (!listed.ok) return listed;
  const data =
    isRecord(listed.value) && Array.isArray(listed.value.data)
      ? listed.value.data
      : null;
  if (data === null) {
    return {
      ok: false,
      error: { code: "whatsapp_phone_numbers_unparseable", providerCode: null },
    };
  }
  const numbers: WhatsAppDiscoveredPhoneNumber[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const phoneNumberId = parseWhatsAppPhoneNumberId(entry.id);
    const displayPhoneNumber = parseE164PhoneNumber(entry.display_phone_number);
    if (!phoneNumberId.ok || !displayPhoneNumber.ok) continue;
    numbers.push({
      phoneNumberId: phoneNumberId.value,
      displayPhoneNumber: displayPhoneNumber.value,
      verifiedName: isNonEmptyString(entry.verified_name)
        ? entry.verified_name
        : "",
    });
  }
  return { ok: true, value: numbers };
}

export async function subscribeWhatsAppApp(
  input: Readonly<{
    wabaId: WhatsAppBusinessAccountId;
    accessToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Result<null, WhatsAppGraphError>> {
  const url = graphUrl(`${input.wabaId}/subscribed_apps`, {});
  const subscribed = await graphJson(
    input.fetcher,
    url,
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  return subscribed.ok ? { ok: true, value: null } : subscribed;
}

export async function unsubscribeWhatsAppApp(
  input: Readonly<{
    wabaId: WhatsAppBusinessAccountId;
    accessToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Result<null, WhatsAppGraphError>> {
  const url = graphUrl(`${input.wabaId}/subscribed_apps`, {});
  const removed = await graphJson(
    input.fetcher,
    url,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  return removed.ok ? { ok: true, value: null } : removed;
}

export async function readWhatsAppSubscribedApps(
  input: Readonly<{
    wabaId: WhatsAppBusinessAccountId;
    accessToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Result<readonly string[], WhatsAppGraphError>> {
  const url = graphUrl(`${input.wabaId}/subscribed_apps`, {});
  const read = await graphJson(
    input.fetcher,
    url,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  if (!read.ok) return read;
  const data =
    isRecord(read.value) && Array.isArray(read.value.data)
      ? read.value.data
      : [];
  const ids: string[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || !isRecord(entry.whatsapp_business_api_data))
      continue;
    const id = entry.whatsapp_business_api_data.id;
    if (isNonEmptyString(id)) ids.push(id);
  }
  return { ok: true, value: ids };
}

/**
 * The single send attempt. There is no retry here and no template path: v1
 * sends one free-form text inside the customer-service window. An outcome
 * that does not carry a WhatsApp message id is never treated as delivered.
 */
export async function sendWhatsAppText(
  input: Readonly<{
    phoneNumberId: WhatsAppPhoneNumberId;
    recipientWaId: WhatsAppCustomerId;
    body: string;
    accessToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<WhatsAppSendOutcome> {
  const url = graphUrl(`${input.phoneNumberId}/messages`, {});
  const payload = JSON.stringify({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.recipientWaId,
    type: "text",
    text: { preview_url: false, body: input.body },
  });
  const request = createRequestAbortSignals(input.signal, SEND_TIMEOUT_MS);
  try {
    const fetcher = input.fetcher;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
        },
        body: payload,
        signal: request.signal,
      });
    } catch (cause) {
      return requestTimedOut(request, cause)
        ? { kind: "indeterminate", reason: "whatsapp_send_timeout" }
        : { kind: "indeterminate", reason: "whatsapp_send_transport_failed" };
    }
    if (response.status >= 500) {
      return {
        kind: "indeterminate",
        reason: `whatsapp_send_http_${response.status}`,
      };
    }
    const body = await readJson(response);
    if (body.kind === "unreadable") {
      return requestTimedOut(request, body.cause)
        ? { kind: "indeterminate", reason: "whatsapp_send_timeout" }
        : { kind: "indeterminate", reason: "whatsapp_send_body_unreadable" };
    }
    if (body.value === undefined) {
      return { kind: "indeterminate", reason: "whatsapp_send_body_unreadable" };
    }
    if (!response.ok) {
      return {
        kind: "rejected",
        error: graphError(response.status, body.value),
      };
    }
    const messages =
      isRecord(body.value) && Array.isArray(body.value.messages)
        ? body.value.messages
        : null;
    const first = messages?.[0];
    const messageId = isRecord(first) ? parseWhatsAppMessageId(first.id) : null;
    return messageId !== null && messageId.ok
      ? { kind: "accepted", whatsappMessageId: messageId.value }
      : { kind: "indeterminate", reason: "whatsapp_send_message_id_missing" };
  } finally {
    request.deadline.end();
  }
}

async function readWabaOwner(
  input: Readonly<{
    wabaId: WhatsAppBusinessAccountId;
    accessToken: string;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>,
): Promise<Result<MetaBusinessPortfolioId | null, WhatsAppGraphError>> {
  const url = graphUrl(String(input.wabaId), {
    fields: "owner_business_info",
  });
  const read = await graphJson(
    input.fetcher,
    url,
    {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
    DISCOVERY_TIMEOUT_MS,
    input.signal,
  );
  if (!read.ok) return read;
  if (!isRecord(read.value) || !isRecord(read.value.owner_business_info)) {
    return { ok: true, value: null };
  }
  const parsed = parseMetaBusinessPortfolioId(
    read.value.owner_business_info.id,
  );
  return { ok: true, value: parsed.ok ? parsed.value : null };
}

async function graphJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Result<unknown, WhatsAppGraphError>> {
  const request = createRequestAbortSignals(callerSignal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetcher(url, { ...init, signal: request.signal });
    } catch (cause) {
      return {
        ok: false,
        error: requestTimedOut(request, cause)
          ? { code: "whatsapp_graph_timeout", providerCode: null }
          : { code: "whatsapp_graph_unreachable", providerCode: null },
      };
    }
    const body = await readJson(response);
    if (body.kind === "unreadable") {
      return {
        ok: false,
        error: requestTimedOut(request, body.cause)
          ? { code: "whatsapp_graph_timeout", providerCode: null }
          : { code: "whatsapp_graph_body_unreadable", providerCode: null },
      };
    }
    if (body.value === undefined) {
      return {
        ok: false,
        error: { code: "whatsapp_graph_body_unreadable", providerCode: null },
      };
    }
    return response.ok
      ? { ok: true, value: body.value }
      : { ok: false, error: graphError(response.status, body.value) };
  } finally {
    request.deadline.end();
  }
}

type RequestAbortSignals = {
  readonly signal: AbortSignal;
  readonly deadline: RequestDeadline;
  readonly callerSignal: AbortSignal | undefined;
};

type JsonReadResult =
  | { readonly kind: "read"; readonly value: unknown }
  | { readonly kind: "unreadable"; readonly cause: unknown };

function createRequestAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestAbortSignals {
  // The deadline ends with the request, so it keeps no Actor awake.
  const deadline = new RequestDeadline(timeoutMs, callerSignal);
  return { signal: deadline.signal, deadline, callerSignal };
}

function requestTimedOut(
  request: RequestAbortSignals,
  cause: unknown,
): boolean {
  // Fetch implementations may normalize a timeout rejection to AbortError.
  if (request.deadline.expired) return true;
  if (request.callerSignal?.aborted === true) return false;
  return isTimeoutError(cause);
}

function isTimeoutError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "TimeoutError";
}

function graphError(status: number, body: unknown): WhatsAppGraphError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const providerCode =
    error !== null && typeof error.code === "number"
      ? String(error.code)
      : null;
  return { code: `whatsapp_graph_http_${status}`, providerCode };
}

async function readJson(response: Response): Promise<JsonReadResult> {
  try {
    return { kind: "read", value: await response.json() };
  } catch (cause) {
    return { kind: "unreadable", cause };
  }
}

function graphUrl(
  path: string,
  query: Readonly<Record<string, string>>,
): string {
  const url = new URL(`${GRAPH_ORIGIN}/${WHATSAPP_GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
