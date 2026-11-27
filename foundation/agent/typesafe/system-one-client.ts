import { RequestDeadline } from "@purin-labs/kernel/request-deadline";
import type { Result } from "@purin-labs/kernel/result";
import { retryAfterMs } from "@purin-labs/std";
import { parseSystemOneJson } from "./response-json";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_RESPONSE_BYTES = 32_768;
export const SYSTEM_ONE_MAX_REQUEST_BYTES = 24_576;

/**
 * What TypeSafe bills for one Jev call, in millionths of a dollar: the pinned
 * Jev 1.13 input costs $0.042 for each million tokens, and output is free.
 */
export function jevInputCostMicrousd(inputTokens: number): number {
  return Math.ceil(inputTokens * 0.042);
}

/** The wait after a TypeSafe 429 with no usable `Retry-After` header. */
const RATE_LIMIT_RETRY_MS = 60_000;

export type JevError = Readonly<{
  code:
    | "jev_credential_unavailable"
    | "jev_credential_rejected"
    | "jev_budget_exhausted"
    | "jev_input_invalid"
    | "jev_cancelled"
    | "jev_unavailable"
    | "jev_rate_limited"
    | "jev_response_invalid";
  /** With `jev_rate_limited`: the wait that TypeSafe asked for. */
  retryAfterMs?: number;
}>;

/** Transport only. The owning feature authorizes egress and builds/parses its contract. */
export async function postSystemOne(input: {
  readonly apiKey: string;
  readonly body: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly fetcher: typeof fetch;
}): Promise<Result<unknown, JevError>> {
  const apiKey = input.apiKey.trim();
  if (!validJevApiKey(apiKey)) return failure("jev_credential_unavailable");
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 10_000 ||
    new TextEncoder().encode(input.body).byteLength >
      SYSTEM_ONE_MAX_REQUEST_BYTES
  ) {
    return failure("jev_input_invalid");
  }
  if (input.signal.aborted) return failure("jev_cancelled");
  // The deadline ends with the request, so it keeps no Actor awake.
  const deadline = new RequestDeadline(input.timeoutMs, input.signal);
  const signal = deadline.signal;
  const fetcher = input.fetcher;
  try {
    const response = await fetcher(SYSTEM_ONE_URL, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: input.body,
    });
    if (!response.ok) {
      logProviderFailure({ kind: "http_error", status: response.status });
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        return failure("jev_credential_rejected");
      }
      if (response.status === 402) return failure("jev_budget_exhausted");
      // TypeSafe did not run the call: the caller may try it again later.
      if (response.status === 429)
        return {
          ok: false,
          error: {
            code: "jev_rate_limited",
            retryAfterMs: retryAfterMs(
              response.headers.get("retry-after"),
              RATE_LIMIT_RETRY_MS,
            ),
          },
        };
      return failure("jev_unavailable");
    }
    return await readResponse(response, signal);
  } catch {
    // Provider bodies and exception messages may contain input or credentials.
    logProviderFailure({ kind: signal.aborted ? "cancelled" : "fetch_error" });
    return failure(signal.aborted ? "jev_cancelled" : "jev_unavailable");
  } finally {
    deadline.end();
  }
}

type ProviderFailureDiagnostic =
  | Readonly<{ kind: "http_error"; status: number }>
  | Readonly<{ kind: "cancelled" | "fetch_error" }>;

function logProviderFailure(diagnostic: ProviderFailureDiagnostic): void {
  console.error(
    JSON.stringify({ event: "jev_provider_request_failed", ...diagnostic }),
  );
}

export function validJevApiKey(value: string): boolean {
  return /^[\x21-\x7e]{20,4096}$/.test(value);
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Result<unknown, JevError>> {
  if (response.body === null) return failure("jev_response_invalid");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return failure("jev_response_invalid");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: parseSystemOneJson(text) };
  } catch {
    return failure(signal.aborted ? "jev_cancelled" : "jev_response_invalid");
  } finally {
    await reader.cancel().catch(ignoreCancellationFailure);
    reader.releaseLock();
  }
}

function ignoreCancellationFailure(): void {}

function failure(code: JevError["code"]): Result<never, JevError> {
  return { ok: false, error: { code } };
}
