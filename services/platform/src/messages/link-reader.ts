import type { Result } from "../result";
import { sha256Hex } from "@seams/std";

/**
 * A bounded reader for public HTTP(S) links carried by a user message.
 *
 * Links are never fetched during ingress. The agent asks for a read explicitly,
 * under the current request authority, and this reader is the only path that
 * performs it.
 *
 * The reader sends no ambient credential, cookie, Slack token, or provider
 * token, and revalidates the destination on every hop so a redirect cannot
 * reach somewhere the first URL could not.
 *
 * The exact URL stays inside request-authorized message content. Query strings
 * and fragments routinely carry secrets, so every value this module puts into a
 * receipt is redacted to origin plus a path digest.
 */

export const MESSAGE_LINK_POLICY = {
  revision: "plan37.link.v1",
  maxRedirects: 3,
  maxTransferBytes: 5 * 1024 * 1024,
  maxTextChars: 32_768,
  timeoutMs: 10_000,
  allowedPorts: [80, 443],
} as const;

export type MessageLinkRejection =
  | { readonly code: "scheme_unsupported" }
  | { readonly code: "credentials_present" }
  | { readonly code: "port_not_allowed"; readonly port: number }
  | { readonly code: "destination_not_public"; readonly reason: string }
  /**
   * No pinning egress was supplied. The reader refuses rather than falling back
   * to an unpinned fetch, because a name that passes validation can answer
   * differently when the request is actually made.
   */
  | { readonly code: "destination_not_verifiable" }
  | { readonly code: "redirect_limit_exceeded" }
  | { readonly code: "redirect_target_rejected"; readonly rejection: string }
  | { readonly code: "response_too_large"; readonly limitBytes: number }
  | { readonly code: "request_failed" }
  | { readonly code: "status_not_ok"; readonly status: number };

export type MessageLinkContent =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly truncated: boolean;
    }
  /**
   * Binary bodies are reported, never decoded as text and never turned into an
   * attachment. Promoting one requires a later explicit user action.
   */
  | { readonly kind: "binary" };

export type MessageLinkReceipt = {
  /** Scheme, host, and port only. Never the path, query, or fragment. */
  readonly requestedOrigin: string;
  readonly finalOrigin: string;
  /** A digest of the path, so two reads can be compared without storing it. */
  readonly pathDigest: string;
  readonly redirectCount: number;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly contentDigest: string;
};

export type MessageLinkRead = {
  readonly content: MessageLinkContent;
  readonly receipt: MessageLinkReceipt;
};

/**
 * The egress boundary a read must go through. Its implementation must bind the
 * supplied address at connection time; the reader only supplies the address
 * that passed destination validation and cannot verify transport internals.
 */
export type MessageLinkEgress = {
  readonly resolve: (
    hostname: string,
    deadlineAtUnixMs: number,
  ) => Promise<readonly string[]>;
  readonly fetchValidated: (
    url: URL,
    address: string,
    deadlineAtUnixMs: number,
  ) => Promise<Response>;
};

export type MessageLinkReaderInput = {
  readonly url: string;
  readonly maxTextChars?: 32_768 | 65_536;
  /** Absent means refuse: there is no unpinned fallback. */
  readonly egress?: MessageLinkEgress;
};

const TEXTUAL_MEDIA_TYPES = new Set([
  "text/html",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/xml",
  "text/xml",
  "application/xhtml+xml",
]);

export async function readMessageLink(
  input: MessageLinkReaderInput,
): Promise<Result<MessageLinkRead, MessageLinkRejection>> {
  const first = parseAdmissibleUrl(input.url);

  if (!first.ok) {
    return first;
  }

  if (input.egress === undefined) {
    return { ok: false, error: { code: "destination_not_verifiable" } };
  }

  const deadlineAtUnixMs = Date.now() + MESSAGE_LINK_POLICY.timeoutMs;
  const egress = input.egress;
  let current = first.value;
  let redirects = 0;

  for (;;) {
    if (deadlineExpired(deadlineAtUnixMs)) {
      return { ok: false, error: { code: "request_failed" } };
    }

    const destination = await validateDestination(
      current,
      egress.resolve,
      deadlineAtUnixMs,
    );

    if (deadlineExpired(deadlineAtUnixMs)) {
      return { ok: false, error: { code: "request_failed" } };
    }

    if (!destination.ok) {
      return redirects === 0
        ? destination
        : {
            ok: false,
            error: {
              code: "redirect_target_rejected",
              rejection: destination.error.code,
            },
          };
    }

    const address = destination.value[0];

    if (address === undefined) {
      return { ok: false, error: { code: "destination_not_verifiable" } };
    }

    let response: Response;

    try {
      // The request goes to the address that was just validated, not to the
      // name that produced it.
      response = await egress.fetchValidated(
        current,
        address,
        deadlineAtUnixMs,
      );
    } catch (error) {
      if (deadlineExpired(deadlineAtUnixMs)) {
        return { ok: false, error: { code: "request_failed" } };
      }

      if (error instanceof LinkTransferLimitError) {
        return {
          ok: false,
          error: {
            code: "response_too_large",
            limitBytes: MESSAGE_LINK_POLICY.maxTransferBytes,
          },
        };
      }
      return { ok: false, error: { code: "request_failed" } };
    }

    if (deadlineExpired(deadlineAtUnixMs)) {
      await cancelResponseBody(response);
      return { ok: false, error: { code: "request_failed" } };
    }

    if (!isRedirect(response.status)) {
      const result = await readBody(
        first.value,
        current,
        redirects,
        response,
        input.maxTextChars ?? MESSAGE_LINK_POLICY.maxTextChars,
      );

      return deadlineExpired(deadlineAtUnixMs)
        ? { ok: false, error: { code: "request_failed" } }
        : result;
    }

    const location = response.headers.get("location");

    await cancelResponseBody(response);

    if (deadlineExpired(deadlineAtUnixMs)) {
      return { ok: false, error: { code: "request_failed" } };
    }

    if (location === null) {
      return { ok: false, error: { code: "request_failed" } };
    }

    if (redirects >= MESSAGE_LINK_POLICY.maxRedirects) {
      return { ok: false, error: { code: "redirect_limit_exceeded" } };
    }

    let next: URL;

    try {
      next = new URL(location, current);
    } catch {
      return {
        ok: false,
        error: { code: "redirect_target_rejected", rejection: "unparseable" },
      };
    }

    const admissible = parseAdmissibleUrl(next.toString());

    if (!admissible.ok) {
      return {
        ok: false,
        error: {
          code: "redirect_target_rejected",
          rejection: admissible.error.code,
        },
      };
    }

    current = admissible.value;
    redirects += 1;
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body !== null) {
    await response.body.cancel().catch(ignoreBodyCancelFailure);
  }
}

function ignoreBodyCancelFailure(): void {
  // The redirect body is intentionally discarded.
}

/** Scheme, userinfo, and port checks that need no network. */
export function parseAdmissibleUrl(
  raw: string,
): Result<URL, MessageLinkRejection> {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: { code: "scheme_unsupported" } };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: { code: "scheme_unsupported" } };
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return { ok: false, error: { code: "credentials_present" } };
  }

  const port =
    url.port.length === 0
      ? url.protocol === "https:"
        ? 443
        : 80
      : Number(url.port);

  if (!MESSAGE_LINK_POLICY.allowedPorts.includes(port as 80 | 443)) {
    return { ok: false, error: { code: "port_not_allowed", port } };
  }

  return { ok: true, value: url };
}

/**
 * Rejects destinations that are not on the public internet.
 *
 * Resolution happens here rather than being left to the transport, so the
 * address that is checked is the address the request is pinned to. Without
 * that, a hostname could answer with a public address for the check and a
 * private one for the fetch.
 */
async function validateDestination(
  url: URL,
  resolve: MessageLinkEgress["resolve"],
  deadlineAtUnixMs: number,
): Promise<Result<readonly string[], MessageLinkRejection>> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");

  if (isBlockedHostname(hostname)) {
    return {
      ok: false,
      error: { code: "destination_not_public", reason: "blocked_name" },
    };
  }

  const literal = classifyAddress(hostname);

  if (literal !== null) {
    return literal === "public"
      ? { ok: true, value: [hostname] }
      : {
          ok: false,
          error: { code: "destination_not_public", reason: literal },
        };
  }

  let addresses: readonly string[];

  try {
    addresses = await resolve(hostname, deadlineAtUnixMs);
  } catch {
    return {
      ok: false,
      error: { code: "destination_not_public", reason: "unresolvable" },
    };
  }

  if (addresses.length === 0) {
    return {
      ok: false,
      error: { code: "destination_not_public", reason: "unresolvable" },
    };
  }

  for (const address of addresses) {
    const classification = classifyAddress(address);

    // Every answer must be public. One private address is enough to make the
    // name unsafe, because the transport may pick any of them.
    if (classification !== "public") {
      return {
        ok: false,
        error: {
          code: "destination_not_public",
          reason: classification ?? "unresolvable",
        },
      };
    }
  }

  return { ok: true, value: addresses };
}

function isBlockedHostname(hostname: string): boolean {
  const lowered = hostname.toLowerCase();

  return (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".internal") ||
    lowered.endsWith(".local") ||
    // The cloud metadata name, alongside its well-known address.
    lowered === "metadata.google.internal"
  );
}

/**
 * Classifies a literal address. Returns `null` when the value is a name rather
 * than an address.
 */
export function classifyAddress(value: string): string | null {
  const ipv4 = parseIpv4(value);

  if (ipv4 !== null) {
    return classifyIpv4(ipv4);
  }

  if (!value.includes(":")) {
    return null;
  }

  return classifyIpv6(value.toLowerCase());
}

function parseIpv4(value: string): readonly number[] | null {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return null;
  }

  const octets: number[] = [];

  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) {
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

function classifyIpv4(octets: readonly number[]): string {
  const [a = 0, b = 0] = octets;

  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 127) return "loopback";
  if (a === 100 && b >= 64 && b <= 127) return "carrier_grade_nat";
  if (a === 169 && b === 254) return "link_local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 192 && b === 0) return "special";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark";
  if (a >= 224) return "multicast_or_reserved";

  return "public";
}

function classifyIpv6(value: string): string {
  if (value === "::") return "unspecified";
  if (value === "::1") return "loopback";
  // IPv4-mapped addresses inherit the IPv4 classification.
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);

  if (mapped?.[1] !== undefined) {
    const octets = parseIpv4(mapped[1]);
    return octets === null ? "malformed" : classifyIpv4(octets);
  }

  if (value.startsWith("fe80")) return "link_local";
  if (/^f[cd]/u.test(value)) return "unique_local";
  if (value.startsWith("ff")) return "multicast";

  return "public";
}

async function readBody(
  requested: URL,
  final: URL,
  redirects: number,
  response: Response,
  maxTextChars: number,
): Promise<Result<MessageLinkRead, MessageLinkRejection>> {
  if (!response.ok) {
    return {
      ok: false,
      error: { code: "status_not_ok", status: response.status },
    };
  }

  const declared = response.headers.get("content-length");

  if (
    declared !== null &&
    /^\d+$/u.test(declared) &&
    Number(declared) > MESSAGE_LINK_POLICY.maxTransferBytes
  ) {
    return {
      ok: false,
      error: {
        code: "response_too_large",
        limitBytes: MESSAGE_LINK_POLICY.maxTransferBytes,
      },
    };
  }

  let bytes: Uint8Array;

  try {
    bytes = await readBoundedBody(response);
  } catch (error) {
    return error instanceof LinkTransferLimitError
      ? {
          ok: false,
          error: {
            code: "response_too_large",
            limitBytes: MESSAGE_LINK_POLICY.maxTransferBytes,
          },
        }
      : { ok: false, error: { code: "request_failed" } };
  }

  const mediaType = essenceMediaType(response.headers.get("content-type"));
  const pathDigest = await sha256Hex(new TextEncoder().encode(final.pathname));
  const contentDigest = await sha256Hex(bytes);

  const receipt: MessageLinkReceipt = {
    requestedOrigin: requested.origin,
    finalOrigin: final.origin,
    pathDigest,
    redirectCount: redirects,
    mediaType,
    byteLength: bytes.byteLength,
    contentDigest,
  };

  if (!TEXTUAL_MEDIA_TYPES.has(mediaType)) {
    return { ok: true, value: { content: { kind: "binary" }, receipt } };
  }

  const decoded = new TextDecoder("utf-8").decode(bytes);
  const normalized = normalizeLinkText(decoded, mediaType);
  const truncated = normalized.length > maxTextChars;

  return {
    ok: true,
    value: {
      content: {
        kind: "text",
        text: truncated ? normalized.slice(0, maxTextChars) : normalized,
        truncated,
      },
      receipt,
    },
  };
}

/**
 * The decoded-byte limit, applied to the body the transport actually delivers.
 *
 * A compressed response is bounded here rather than by its declared length, so
 * a small compressed body cannot expand past the cap unnoticed.
 */
async function readBoundedBody(response: Response): Promise<Uint8Array> {
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

    if (total > MESSAGE_LINK_POLICY.maxTransferBytes) {
      await reader.cancel().catch(ignoreCancelFailure);
      throw new LinkTransferLimitError();
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function ignoreCancelFailure(): void {
  // The body is already abandoned; a failed cancel changes nothing.
}

export class LinkTransferLimitError extends Error {}

function essenceMediaType(raw: string | null): string {
  if (raw === null) {
    return "application/octet-stream";
  }

  return raw.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream";
}

/** Strips markup and collapses whitespace so the model sees readable prose. */
export function normalizeLinkText(value: string, mediaType: string): string {
  const stripped =
    mediaType === "text/html" || mediaType === "application/xhtml+xml"
      ? value
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
          .replace(/<!--[\s\S]*?-->/gu, " ")
          .replace(
            /<a\b[^>]*\bhref=["']([^"']{1,2048})["'][^>]*>/giu,
            " [link: $1] ",
          )
          .replace(/<[^>]+>/gu, " ")
      : value;

  return stripped.replace(/\s+/gu, " ").trim();
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function deadlineExpired(deadlineAtUnixMs: number): boolean {
  return Date.now() >= deadlineAtUnixMs;
}
