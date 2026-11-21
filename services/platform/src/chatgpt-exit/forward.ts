/**
 * The forwarding step of the ChatGPT exit (Plan 75).
 *
 * chatgpt.com refuses requests that leave Cloudflare from a Worker: it
 * answers them with an HTML block page (403). It accepts the same requests
 * from a Cloudflare container. So the Platform sends each chatgpt.com
 * request of the ChatGPT subscription route to the ChatGPT exit Worker, and
 * that Worker hands it to one container, which runs this function.
 *
 * The file runs in two places: the container runs it with Node's own type
 * stripping, and the E2E runtime runs it in place of the container. So it
 * uses only web APIs and only erasable TypeScript syntax.
 *
 * The function never logs a header, a body or a token, and it does not
 * retry.
 */

/** The request header that names the provider URL to forward to. */
const CHATGPT_EXIT_UPSTREAM_HEADER = "x-pantry-upstream-url";

/** The response header that names the data centre of the exit. */
const CHATGPT_EXIT_COLO_HEADER = "x-pantry-exit-colo";

/** Request headers that belong to one connection and are never forwarded. */
const CONNECTION_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The ChatGPT exit Worker's step: the request for the container, with the
 * provider URL in a header. Null for a host other than chatgpt.com.
 */
export function containerRequest(request: Request): Request | null {
  const url = new URL(request.url);
  if (url.hostname !== "chatgpt.com") return null;
  const headers = new Headers(request.headers);
  headers.set(CHATGPT_EXIT_UPSTREAM_HEADER, url.toString());
  return new Request(`http://chatgpt-exit${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.body,
  });
}

type ChatGptExitContext = {
  readonly fetch: typeof fetch;
  /** The data-centre code of the exit, or null when it is not known. */
  readonly colo: string | null;
};

export async function forwardChatGptRequest(
  request: Request,
  context: ChatGptExitContext,
): Promise<Response> {
  const target = chatGptUpstreamUrl(
    request.headers.get(CHATGPT_EXIT_UPSTREAM_HEADER),
  );
  if (target === null)
    return exitRefusal(403, "chatgpt_exit_host_refused", context.colo);
  const headers = new Headers();
  for (const [name, value] of request.headers)
    if (isForwardedHeader(name)) headers.set(name, value);
  // Request bodies are small JSON documents; a whole body avoids the
  // different stream rules of Node and the Workers runtime.
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  const upstream = await context.fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  // The runtime's fetch has already decoded a compressed body.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set(CHATGPT_EXIT_COLO_HEADER, context.colo ?? "unknown");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** The answer of the exit when it does not forward a request. */
export function exitRefusal(
  status: number,
  error: string,
  colo: string | null,
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
      [CHATGPT_EXIT_COLO_HEADER]: colo ?? "unknown",
    },
  });
}

/** An https URL on chatgpt.com's backend, and nothing else. */
function chatGptUpstreamUrl(raw: string | null): string | null {
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "https:" &&
    url.hostname === "chatgpt.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname.startsWith("/backend-api/")
    ? url.toString()
    : null;
}

function isForwardedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    !CONNECTION_HEADERS.has(lower) &&
    !lower.startsWith("x-pantry-") &&
    !lower.startsWith("cf-")
  );
}
