import { RequestDeadline } from "../request-deadline";
import { runtimeFetch } from "../runtime-fetch";
import {
  LinkTransferLimitError,
  MESSAGE_LINK_POLICY,
  type MessageLinkEgress,
} from "./link-reader";
import type { OrganisationPlacement } from "../placement";
import type { Result } from "../result";
import { decodeCanonicalBase64, hasExactKeys, isRecord } from "@purin-labs/std";

/** Cloudflare's resolver, reached over DoH so no ambient DNS config applies. */
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5_000;
const MESSAGE_LINK_FETCH_ENDPOINT = "http://container/v1/fetch";
const MAX_FETCH_REQUEST_BYTES = 16 * 1024;
const MAX_FETCH_ENVELOPE_BYTES = 7 * 1024 * 1024;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;

/** A DoH answer type we can turn into an address. */
const RECORD_A = 1;
const RECORD_AAAA = 28;

export type MessageLinkFetchTransport = {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
};

export type MessageLinkFetchNamespace = {
  readonly getByName: (
    name: string,
    options?: { readonly locationHint?: OrganisationPlacement["locationHint"] },
  ) => MessageLinkFetchTransport;
};

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type MessageLinkFetchResponse = {
  readonly status: number;
  readonly contentType: string | null;
  readonly location: string | null;
  readonly body: Uint8Array;
};

type MessageLinkFetchResponseError = {
  readonly kind: "invalid_response";
  readonly field: string;
};

export function createWorkerMessageLinkEgress(
  namespace: MessageLinkFetchNamespace,
  placement: OrganisationPlacement,
  dohFetcher: Fetcher = runtimeFetch,
): MessageLinkEgress {
  return {
    resolve: resolveHostname.bind(undefined, dohFetcher),
    fetchValidated: fetchValidatedLink.bind(undefined, namespace, placement),
  };
}

/**
 * The name of the link-fetch Actor that serves the organisations of one
 * region. A Durable Object stays in the region where Cloudflare creates it,
 * and a location hint counts only on the first call of a name. So the name
 * holds the hint, and each hint has its own object next to the Sessions that
 * call it. The Actor stores nothing of an organisation.
 */
function messageLinkFetchObjectName(
  placement: Pick<OrganisationPlacement, "locationHint">,
): string {
  return `public-links:${placement.locationHint}`;
}

async function resolveHostname(
  fetcher: Fetcher,
  hostname: string,
  deadlineAtUnixMs: number,
): Promise<readonly string[]> {
  if (deadlineExpired(deadlineAtUnixMs)) {
    throw new Error("message_link_deadline_expired");
  }

  // A literal address needs no lookup, and asking a resolver for one would
  // invite an answer that disagrees with what was written.
  if (isAddressLiteral(hostname)) {
    return [stripBrackets(hostname)];
  }

  const answers = await Promise.all([
    resolveRecord(fetcher, hostname, "A", deadlineAtUnixMs),
    resolveRecord(fetcher, hostname, "AAAA", deadlineAtUnixMs),
  ]);

  if (deadlineExpired(deadlineAtUnixMs)) {
    throw new Error("message_link_deadline_expired");
  }

  return answers.flat();
}

async function fetchValidatedLink(
  namespace: MessageLinkFetchNamespace,
  placement: OrganisationPlacement,
  url: URL,
  address: string,
  deadlineAtUnixMs: number,
): Promise<Response> {
  const remainingMs = deadlineAtUnixMs - Date.now();

  if (remainingMs <= 0) {
    throw new Error("message_link_deadline_expired");
  }

  const container = namespace.getByName(messageLinkFetchObjectName(placement), {
    locationHint: placement.locationHint,
  });
  const requestBody = JSON.stringify({
    url: url.toString(),
    address,
    deadlineAtUnixMs,
    maxBytes: MESSAGE_LINK_POLICY.maxTransferBytes,
  });
  if (deadlineExpired(deadlineAtUnixMs)) {
    throw new Error("message_link_deadline_expired");
  }

  const requestBytes = new TextEncoder().encode(requestBody).byteLength;

  const timeout = new RequestDeadline(Math.max(1, remainingMs));
  let body: Uint8Array;
  try {
    const response = await container.fetch(MESSAGE_LINK_FETCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      redirect: "manual",
      signal: timeout.signal,
    });

    if (deadlineExpired(deadlineAtUnixMs)) {
      throw new Error("message_link_deadline_expired");
    }

    if (!response.ok) {
      // The service reserves 413 for a response that exceeded maxBytes. Its
      // separate request envelope limit is also 413, so retain request_failed
      // for an oversized request body instead of misreporting it as page data.
      if (response.status === 413 && requestBytes <= MAX_FETCH_REQUEST_BYTES) {
        throw new LinkTransferLimitError();
      }
      throw new Error("message_link_fetch_rejected");
    }

    body = await readBoundedResponseBody(response);
  } finally {
    timeout.end();
  }

  if (deadlineExpired(deadlineAtUnixMs)) {
    throw new Error("message_link_deadline_expired");
  }

  const decoded = decodeUtf8(body);

  if (deadlineExpired(deadlineAtUnixMs)) {
    throw new Error("message_link_deadline_expired");
  }

  const parsed = parseMessageLinkFetchResponse(decoded);

  if (deadlineExpired(deadlineAtUnixMs)) {
    throw new Error("message_link_deadline_expired");
  }

  if (!parsed.ok) {
    throw new Error(`message_link_fetch_${parsed.error.kind}`);
  }

  return reconstructResponse(parsed.value);
}

/**
 * Parses the only response shape accepted from the fetch service. The service
 * response is already bounded before this function is called.
 */
export function parseMessageLinkFetchResponse(
  rawBody: string,
): Result<MessageLinkFetchResponse, MessageLinkFetchResponseError> {
  let raw: unknown;

  try {
    raw = JSON.parse(rawBody);
  } catch {
    return invalidResponse("json");
  }

  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["status", "contentType", "location", "bodyBase64"])
  ) {
    return invalidResponse("response");
  }

  const status = raw.status;

  if (
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status < 200 ||
    status > 599
  ) {
    return invalidResponse("status");
  }

  const contentType = raw.contentType;
  const location = raw.location;

  if (!isNullableString(contentType)) {
    return invalidResponse("contentType");
  }

  if (!isSafeHeaderValue(contentType)) {
    return invalidResponse("contentType");
  }

  if (!isNullableString(location)) {
    return invalidResponse("location");
  }

  if (!isSafeHeaderValue(location)) {
    return invalidResponse("location");
  }

  if (typeof raw.bodyBase64 !== "string") {
    return invalidResponse("bodyBase64");
  }

  const body = decodeCanonicalBase64(
    raw.bodyBase64,
    MESSAGE_LINK_POLICY.maxTransferBytes,
  );

  if (body === null) {
    return invalidResponse("bodyBase64");
  }

  if (hasNullBodyStatus(status) && body.byteLength > 0) {
    return invalidResponse("bodyBase64");
  }

  return {
    ok: true,
    value: {
      status,
      contentType,
      location,
      body,
    },
  };
}

function reconstructResponse(response: MessageLinkFetchResponse): Response {
  const headers = new Headers();

  if (response.contentType !== null) {
    headers.set("content-type", response.contentType);
  }

  if (response.location !== null) {
    headers.set("location", response.location);
  }

  return new Response(
    hasNullBodyStatus(response.status) ? null : response.body,
    { status: response.status, headers },
  );
}

async function resolveRecord(
  fetcher: Fetcher,
  hostname: string,
  type: "A" | "AAAA",
  deadlineAtUnixMs: number,
): Promise<readonly string[]> {
  const url = new URL(DOH_ENDPOINT);

  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);

  let response: Response;
  const remainingMs = deadlineAtUnixMs - Date.now();

  if (remainingMs <= 0) {
    throw new Error("message_link_deadline_expired");
  }

  const timeout = new RequestDeadline(Math.min(DOH_TIMEOUT_MS, remainingMs));
  let parsed: unknown;
  try {
    try {
      response = await fetcher(url, {
        headers: { accept: "application/dns-json" },
        signal: timeout.signal,
      });
    } catch {
      // A resolver that did not answer is not evidence that a name is safe.
      return [];
    }

    if (!response.ok) {
      return [];
    }

    try {
      parsed = await response.json();
    } catch {
      return [];
    }
  } finally {
    timeout.end();
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.Answer)) {
    return [];
  }

  const wanted = type === "A" ? RECORD_A : RECORD_AAAA;
  const addresses: string[] = [];

  for (const answer of parsed.Answer) {
    if (
      isRecord(answer) &&
      answer.type === wanted &&
      typeof answer.data === "string"
    ) {
      addresses.push(answer.data);
    }
  }

  return addresses;
}

async function readBoundedResponseBody(
  response: Response,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value === undefined) {
      continue;
    }

    total += value.byteLength;

    if (total > MAX_FETCH_ENVELOPE_BYTES) {
      await reader.cancel().catch(ignoreCancelFailure);
      throw new Error("message_link_fetch_response_too_large");
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

function decodeUtf8(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    body,
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeHeaderValue(value: string | null): boolean {
  return (
    value === null ||
    (!value.includes("\r") &&
      !value.includes("\n") &&
      new TextEncoder().encode(value).byteLength <= MAX_HEADER_VALUE_BYTES)
  );
}

function hasNullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function deadlineExpired(deadlineAtUnixMs: number): boolean {
  return Date.now() >= deadlineAtUnixMs;
}

function invalidResponse(
  field: string,
): Result<never, MessageLinkFetchResponseError> {
  return { ok: false, error: { kind: "invalid_response", field } };
}

function isAddressLiteral(hostname: string): boolean {
  const bare = stripBrackets(hostname);

  return /^[0-9.]+$/u.test(bare) || bare.includes(":");
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ignoreCancelFailure(): void {
  // The body is already abandoned; a failed cancel changes nothing.
}
