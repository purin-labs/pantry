import { RequestDeadline } from "../request-deadline";
import { runtimeFetch } from "../runtime-fetch";
import type { Result } from "../result";
import type { OrganisationId } from "../ids";
import type { OrganisationPlacement } from "../placement";
import { CUSTOM_CONNECTOR_LIMITS } from "./limits";
import {
  decodeCanonicalBase64,
  encodeBase64,
  hasExactKeys,
  isRecord,
} from "@seams/std";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5_000;
const CUSTOM_CONNECTOR_FETCH_ENDPOINT = "http://container/v1/fetch";
const MAX_RESPONSE_BYTES = CUSTOM_CONNECTOR_LIMITS.wireBytes;
const MAX_RESPONSE_ENVELOPE_BYTES = 1_500_000;
const MAX_BODY_BASE64_CHARS = Math.ceil(MAX_RESPONSE_BYTES / 3) * 4;
const MAX_ATTEMPT_MS = CUSTOM_CONNECTOR_LIMITS.attemptTimeoutMs;
const RECORD_A = 1;
const RECORD_AAAA = 28;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CustomConnectorFetchTransport = {
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
};

/** The class binding of the fetch container, as the Worker holds it. */
type CustomConnectorFetchBinding = {
  readonly getByName: (
    name: string,
    options?: { readonly locationHint?: OrganisationPlacement["locationHint"] },
  ) => CustomConnectorFetchTransport;
};

/** The fetch container of each organisation of one placement. */
export type CustomConnectorFetchNamespace = {
  readonly containerOf: (
    organisationId: OrganisationId,
  ) => CustomConnectorFetchTransport;
};

/**
 * The fetch containers that the organisations of one placement use. Each
 * organisation has its own container Actor, so no container holds the
 * credentials of two organisations. A Durable Object stays in the region
 * where Cloudflare creates it, and a location hint counts only on the first
 * call of a name. So each call passes the hint of the organisation's
 * placement, and the first test of a credential creates the Actor next to
 * the organisation.
 */
export function customConnectorFetchOf(
  binding: CustomConnectorFetchBinding,
  placement: Pick<OrganisationPlacement, "locationHint">,
): CustomConnectorFetchNamespace {
  return {
    containerOf: placedFetchContainer.bind(undefined, binding, placement),
  };
}

/** The name of the fetch container Actor of one organisation. */
export function customConnectorFetchObjectName(
  organisationId: OrganisationId,
): string {
  return organisationId;
}

function placedFetchContainer(
  binding: CustomConnectorFetchBinding,
  placement: Pick<OrganisationPlacement, "locationHint">,
  organisationId: OrganisationId,
): CustomConnectorFetchTransport {
  return binding.getByName(customConnectorFetchObjectName(organisationId), {
    locationHint: placement.locationHint,
  });
}

export type CustomConnectorAuthentication =
  | { readonly kind: "bearer"; readonly value: string }
  | { readonly kind: "basic_api_key"; readonly value: string }
  | {
      readonly kind: "header";
      readonly name: string;
      readonly value: string;
    };

export type CustomConnectorOperationRequest =
  | { readonly kind: "get"; readonly url: URL }
  | {
      readonly kind: "post_json";
      readonly url: URL;
      readonly body: Uint8Array;
    }
  | {
      readonly kind: "mcp_post";
      readonly url: URL;
      readonly body: Uint8Array;
      readonly protocolVersion: string | null;
      readonly sessionId: string | null;
    }
  | {
      readonly kind: "mcp_delete";
      readonly url: URL;
      readonly protocolVersion: string | null;
      readonly sessionId: string | null;
      readonly body?: never;
    };

/** A provider idempotency key in the header that the reviewed write names. */
export type CustomConnectorIdempotency = {
  readonly header: string;
  readonly key: string;
};

export type CustomConnectorTransportRequest = {
  readonly organisationId: OrganisationId;
  readonly authentication: CustomConnectorAuthentication;
  readonly operation: CustomConnectorOperationRequest;
  readonly idempotency?: CustomConnectorIdempotency;
  readonly deadlineAtUnixMs: number;
  readonly maxWireBytes: number;
  readonly maxDecodedBytes: number;
};

export type CustomConnectorTransportResponse = {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  readonly sessionId: string | null;
};

export type CustomConnectorTransportError =
  | { readonly code: "invalid_request" }
  | { readonly code: "destination_not_public" }
  | { readonly code: "deadline_expired" }
  | { readonly code: "execution_aborted" }
  | { readonly code: "response_too_large" }
  | { readonly code: "redirect_denied" }
  | { readonly code: "credential_exposed" }
  | { readonly code: "authority_expired" }
  | { readonly code: "mcp_auth_required" }
  | { readonly code: "mcp_tool_unavailable" }
  | { readonly code: "mcp_tool_error" }
  | { readonly code: "transport_unavailable" };

export async function executeCustomConnectorTransport(input: {
  readonly namespace: CustomConnectorFetchNamespace;
  readonly request: CustomConnectorTransportRequest;
  readonly signal: AbortSignal;
  readonly authorizeDispatch: () => Promise<boolean>;
  readonly onDispatch: () => void;
  readonly dohFetcher?: Fetcher;
}): Promise<
  Result<CustomConnectorTransportResponse, CustomConnectorTransportError>
> {
  const validRequest = validateTransportRequest(input.request);

  if (!validRequest.ok) {
    return validRequest;
  }

  // The attempt's deadline ends with the attempt, so it keeps no Actor awake.
  const deadline = new RequestDeadline(
    Math.max(1, validRequest.value.deadlineAtUnixMs - Date.now()),
    input.signal,
  );
  try {
    return await dispatchCustomConnectorTransport(
      input,
      validRequest.value,
      deadline.signal,
    );
  } finally {
    deadline.end();
  }
}

async function dispatchCustomConnectorTransport(
  input: Parameters<typeof executeCustomConnectorTransport>[0],
  request: CustomConnectorTransportRequest,
  signal: AbortSignal,
): Promise<
  Result<CustomConnectorTransportResponse, CustomConnectorTransportError>
> {
  if (signal.aborted) return abortedTransport(request.deadlineAtUnixMs);
  const dohFetcher = input.dohFetcher ?? runtimeFetch;
  const destination = await resolvePublicDestination(
    request.operation.url,
    request.deadlineAtUnixMs,
    dohFetcher,
    signal,
  );

  if (signal.aborted) return abortedTransport(request.deadlineAtUnixMs);
  if (!destination.ok) {
    return destination;
  }

  if (deadlineExpired(request.deadlineAtUnixMs)) {
    return { ok: false, error: { code: "deadline_expired" } };
  }
  if (!(await input.authorizeDispatch()))
    return { ok: false, error: { code: "authority_expired" } };
  if (signal.aborted) return abortedTransport(request.deadlineAtUnixMs);

  const remainingMs = request.deadlineAtUnixMs - Date.now();
  const requestBody = serializeContainerRequest(
    request,
    destination.value,
    remainingMs,
  );
  const container = input.namespace.containerOf(request.organisationId);
  let response: Response;

  try {
    input.onDispatch();
    response = await container.fetch(CUSTOM_CONNECTOR_FETCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
      redirect: "manual",
      signal,
    });
  } catch {
    if (signal.aborted) return abortedTransport(request.deadlineAtUnixMs);
    return { ok: false, error: { code: "transport_unavailable" } };
  }

  if (signal.aborted || deadlineExpired(request.deadlineAtUnixMs)) {
    await cancelResponse(response);
    return abortedTransport(request.deadlineAtUnixMs);
  }

  const envelope = await readBoundedEnvelope(response, signal);
  if (signal.aborted) return abortedTransport(request.deadlineAtUnixMs);

  if (!envelope.ok) {
    return envelope;
  }

  if (!response.ok) {
    return parseContainerError(envelope.value);
  }

  return parseContainerResponse(envelope.value);
}

function abortedTransport(
  deadlineAtUnixMs: number,
): Result<never, CustomConnectorTransportError> {
  return {
    ok: false,
    error: {
      code: deadlineExpired(deadlineAtUnixMs)
        ? "deadline_expired"
        : "execution_aborted",
    },
  };
}

function validateTransportRequest(
  request: CustomConnectorTransportRequest,
): Result<CustomConnectorTransportRequest, CustomConnectorTransportError> {
  const now = Date.now();

  if (
    Number.isSafeInteger(request.deadlineAtUnixMs) &&
    request.deadlineAtUnixMs <= now
  ) {
    return { ok: false, error: { code: "deadline_expired" } };
  }

  if (
    !Number.isSafeInteger(request.deadlineAtUnixMs) ||
    request.deadlineAtUnixMs > now + MAX_ATTEMPT_MS ||
    !isResponseLimit(request.maxWireBytes) ||
    !isResponseLimit(request.maxDecodedBytes) ||
    request.operation.url.protocol !== "https:" ||
    request.operation.url.username.length > 0 ||
    request.operation.url.password.length > 0 ||
    request.operation.url.port.length > 0 ||
    request.operation.url.hash.length > 0 ||
    request.authentication.value.length === 0
  ) {
    return { ok: false, error: { code: "invalid_request" } };
  }

  if (
    request.idempotency !== undefined &&
    (request.operation.kind === "mcp_post" ||
      request.operation.kind === "mcp_delete" ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/u.test(request.idempotency.header) ||
      !/^[\x21-\x7e]{1,256}$/u.test(request.idempotency.key))
  ) {
    return { ok: false, error: { code: "invalid_request" } };
  }

  if (
    (request.operation.kind === "post_json" ||
      request.operation.kind === "mcp_post") &&
    request.operation.body.byteLength > CUSTOM_CONNECTOR_LIMITS.bodyBytes
  ) {
    return { ok: false, error: { code: "invalid_request" } };
  }

  return { ok: true, value: request };
}

function isResponseLimit(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value > 0 && value <= MAX_RESPONSE_BYTES
  );
}

async function resolvePublicDestination(
  url: URL,
  deadlineAtUnixMs: number,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<Result<string, CustomConnectorTransportError>> {
  const hostname = stripBrackets(url.hostname).toLowerCase();

  if (isBlockedHostname(hostname)) {
    return { ok: false, error: { code: "destination_not_public" } };
  }

  const literal = parseAddress(hostname);

  if (literal !== null) {
    return isPublicAddress(literal)
      ? { ok: true, value: hostname }
      : { ok: false, error: { code: "destination_not_public" } };
  }

  const answers = await Promise.all([
    resolveRecord(fetcher, hostname, "A", deadlineAtUnixMs, signal),
    resolveRecord(fetcher, hostname, "AAAA", deadlineAtUnixMs, signal),
  ]);
  const addresses = answers.flat();

  if (deadlineExpired(deadlineAtUnixMs)) {
    return { ok: false, error: { code: "deadline_expired" } };
  }

  if (addresses.length === 0 || addresses.some(answerIsUnsafe)) {
    return { ok: false, error: { code: "destination_not_public" } };
  }

  const selected = addresses[0];

  return selected === undefined
    ? { ok: false, error: { code: "destination_not_public" } }
    : { ok: true, value: selected };
}

function answerIsUnsafe(address: string): boolean {
  const parsed = parseAddress(address);
  return parsed === null || !isPublicAddress(parsed);
}

async function resolveRecord(
  fetcher: Fetcher,
  hostname: string,
  type: "A" | "AAAA",
  deadlineAtUnixMs: number,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const remainingMs = deadlineAtUnixMs - Date.now();

  if (remainingMs <= 0) {
    return [];
  }

  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);
  let response: Response;

  const timeout = new RequestDeadline(
    Math.min(DOH_TIMEOUT_MS, remainingMs),
    signal,
  );
  let raw: unknown;
  try {
    try {
      response = await fetcher(url, {
        headers: { accept: "application/dns-json" },
        signal: timeout.signal,
      });
    } catch {
      return [];
    }

    if (!response.ok) {
      return [];
    }

    try {
      raw = await response.json();
    } catch {
      return [];
    }
  } finally {
    timeout.end();
  }

  if (!isRecord(raw) || !Array.isArray(raw.Answer)) {
    return [];
  }

  const wanted = type === "A" ? RECORD_A : RECORD_AAAA;
  const addresses: string[] = [];

  for (const answer of raw.Answer) {
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

function serializeContainerRequest(
  request: CustomConnectorTransportRequest,
  address: string,
  timeoutMs: number,
): string {
  const operation = serializeOperation(request.operation);

  return JSON.stringify({
    address,
    authentication: request.authentication,
    operation,
    timeoutMs,
    maxWireBytes: request.maxWireBytes,
    maxDecodedBytes: request.maxDecodedBytes,
    ...(request.idempotency === undefined
      ? {}
      : { idempotency: request.idempotency }),
  });
}

function serializeOperation(
  operation: CustomConnectorOperationRequest,
): object {
  switch (operation.kind) {
    case "get":
      return { kind: "get", url: operation.url.toString() };
    case "post_json":
      return {
        kind: "post_json",
        url: operation.url.toString(),
        bodyBase64: encodeBase64(operation.body),
      };
    case "mcp_post":
      return {
        kind: "mcp_post",
        url: operation.url.toString(),
        bodyBase64: encodeBase64(operation.body),
        protocolVersion: operation.protocolVersion,
        sessionId: operation.sessionId,
      };
    case "mcp_delete":
      return {
        kind: "mcp_delete",
        url: operation.url.toString(),
        protocolVersion: operation.protocolVersion,
        sessionId: operation.sessionId,
      };
  }
}

async function readBoundedEnvelope(
  response: Response,
  signal: AbortSignal,
): Promise<Result<Uint8Array, CustomConnectorTransportError>> {
  if (response.body === null) {
    return { ok: true, value: new Uint8Array() };
  }

  const reader = response.body.getReader();
  const cancel = cancelEnvelopeReader.bind(null, reader);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) cancel();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;

      try {
        part = await reader.read();
      } catch {
        return { ok: false, error: { code: "transport_unavailable" } };
      }

      if (signal.aborted)
        return { ok: false, error: { code: "execution_aborted" } };
      if (part.done) {
        break;
      }

      total += part.value.byteLength;

      if (total > MAX_RESPONSE_ENVELOPE_BYTES) {
        await reader.cancel().catch(ignoreCancelFailure);
        return { ok: false, error: { code: "response_too_large" } };
      }

      chunks.push(part.value);
    }

    const body = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { ok: true, value: body };
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function cancelEnvelopeReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  void reader.cancel().catch(ignoreCancelFailure);
}

function parseContainerResponse(
  bytes: Uint8Array,
): Result<CustomConnectorTransportResponse, CustomConnectorTransportError> {
  const parsed = parseJsonRecord(bytes);

  if (
    parsed === null ||
    !(
      hasExactKeys(parsed, ["status", "contentType", "bodyBase64"]) ||
      hasExactKeys(parsed, ["status", "contentType", "bodyBase64", "sessionId"])
    ) ||
    typeof parsed.status !== "number" ||
    !Number.isSafeInteger(parsed.status) ||
    parsed.status < 200 ||
    parsed.status > 599 ||
    !isNullableSafeString(parsed.contentType) ||
    typeof parsed.bodyBase64 !== "string" ||
    (parsed.sessionId !== undefined && !isNullableSafeString(parsed.sessionId))
  ) {
    return { ok: false, error: { code: "transport_unavailable" } };
  }

  if (
    parsed.bodyBase64.length > MAX_BODY_BASE64_CHARS ||
    decodedBase64Length(parsed.bodyBase64) > MAX_RESPONSE_BYTES
  ) {
    return { ok: false, error: { code: "response_too_large" } };
  }

  const body = decodeCanonicalBase64(parsed.bodyBase64, MAX_RESPONSE_BYTES);

  if (body === null || (parsed.status >= 300 && body.byteLength > 0)) {
    return { ok: false, error: { code: "transport_unavailable" } };
  }

  return {
    ok: true,
    value: {
      status: parsed.status,
      contentType: parsed.contentType,
      body,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
    },
  };
}

function decodedBase64Length(value: string): number {
  let padding = 0;

  if (value.endsWith("==")) {
    padding = 2;
  } else if (value.endsWith("=")) {
    padding = 1;
  }

  return (value.length / 4) * 3 - padding;
}

function parseContainerError(
  bytes: Uint8Array,
): Result<never, CustomConnectorTransportError> {
  const parsed = parseJsonRecord(bytes);

  if (
    parsed === null ||
    !hasExactKeys(parsed, ["error"]) ||
    typeof parsed.error !== "string"
  ) {
    return { ok: false, error: { code: "transport_unavailable" } };
  }

  switch (parsed.error) {
    case "invalid_request":
      return { ok: false, error: { code: "invalid_request" } };
    case "destination_not_public":
      return { ok: false, error: { code: "destination_not_public" } };
    case "deadline_expired":
      return { ok: false, error: { code: "deadline_expired" } };
    case "response_too_large":
      return { ok: false, error: { code: "response_too_large" } };
    case "redirect_denied":
      return { ok: false, error: { code: "redirect_denied" } };
    case "credential_exposed":
      return { ok: false, error: { code: "credential_exposed" } };
    case "request_too_large":
    case "deadline_too_far_ahead":
    case "busy":
    case "transport_unavailable":
      return { ok: false, error: { code: "transport_unavailable" } };
    default:
      return { ok: false, error: { code: "transport_unavailable" } };
  }
}

function parseJsonRecord(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

type ParsedAddress =
  | { readonly kind: "ipv4"; readonly octets: readonly number[] }
  | { readonly kind: "ipv6"; readonly segments: readonly number[] };

function parseAddress(value: string): ParsedAddress | null {
  const ipv4 = parseIpv4(value);

  if (ipv4 !== null) {
    return { kind: "ipv4", octets: ipv4 };
  }

  const ipv6 = parseIpv6(value);

  return ipv6 === null ? null : { kind: "ipv6", segments: ipv6 };
}

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];

  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part)) {
      return null;
    }
    const octet = Number(part);

    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }

  return octets;
}

function parseIpv6(value: string): readonly number[] | null {
  if (!value.includes(":")) {
    return null;
  }

  const halves = value.split("::");

  if (halves.length > 2) {
    return null;
  }

  const left = parseIpv6Side(halves[0] ?? "");
  const right = parseIpv6Side(halves[1] ?? "");

  if (left === null || right === null) {
    return null;
  }

  const omitted = 8 - left.length - right.length;

  if (
    (halves.length === 1 && omitted !== 0) ||
    (halves.length === 2 && omitted < 1)
  ) {
    return null;
  }

  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function parseIpv6Side(value: string): readonly number[] | null {
  if (value.length === 0) {
    return [];
  }

  const segments: number[] = [];

  for (const part of value.split(":")) {
    if (!/^[0-9a-f]{1,4}$/iu.test(part)) {
      return null;
    }
    segments.push(Number.parseInt(part, 16));
  }

  return segments;
}

function isPublicAddress(address: ParsedAddress): boolean {
  return address.kind === "ipv4"
    ? isPublicIpv4(address.octets)
    : isPublicIpv6(address.segments);
}

function isPublicIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || (b === 88 && c === 99) || b === 168)) {
    return false;
  }
  if (a === 198 && ((b >= 18 && b <= 19) || (b === 51 && c === 100))) {
    return false;
  }
  if (a === 203 && b === 0 && c === 113) return false;

  return true;
}

function isPublicIpv6(segments: readonly number[]): boolean {
  const [s0 = 0, s1 = 0, s2 = 0] = segments;

  if ((s0 & 0xe000) !== 0x2000) return false;
  if (s0 === 0x2002 || (s0 === 0x2001 && s1 === 0)) return false;
  if (s0 === 0x2001 && s1 === 2 && s2 === 0) return false;
  if (s0 === 0x2001 && (s1 & 0xfff0) === 0x0010) return false;
  if (s0 === 0x2001 && (s1 & 0xfff0) === 0x0020) return false;
  if (s0 === 0x2001 && s1 === 0x0db8) return false;
  if ((s0 & 0xfff0) === 0x3ff0 || s0 === 0x3ffe) return false;

  return true;
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "metadata.google.internal" ||
    hostname === "invalid" ||
    hostname.endsWith(".invalid") ||
    hostname === "test" ||
    hostname.endsWith(".test") ||
    hostname === "example" ||
    hostname.endsWith(".example")
  );
}

function stripBrackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function isNullableSafeString(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length <= 8 * 1024 &&
      !value.includes("\r") &&
      !value.includes("\n"))
  );
}

function deadlineExpired(deadlineAtUnixMs: number): boolean {
  return Date.now() >= deadlineAtUnixMs;
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(ignoreCancelFailure);
  }
}

function ignoreCancelFailure(): void {
  // The caller has already abandoned the bounded response body.
}
