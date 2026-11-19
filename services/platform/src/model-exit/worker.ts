import { newRequestId } from "../ids";
import { readIsolateLocation } from "../isolate-location";
import { traceLog, traceWarn } from "../observability";
import { MODEL_EXIT_COLO_HEADER } from "./protocol";

/**
 * The model exit Worker (Plan 73). It sends each direct request of the
 * Platform to a model provider on from a data centre near AWS Tokyo, so the
 * provider sees a Japanese address wherever the Session or the cron runs.
 *
 * Placement applies to the `fetch` handler only, not to RPC methods, so the
 * Platform calls this handler through its service binding. The Worker holds
 * no credential and keeps no state. It never logs a header, a body or a
 * token, and it does not retry.
 */
export default {
  fetch: forwardModelProviderRequest,
} satisfies ExportedHandler<ModelExitEnv>;

type ModelExitEnv = { readonly PANTRY_DEPLOYMENT_PROFILE: string };

/**
 * The provider hosts of the direct model routes, and nothing else.
 * chatgpt.com is not here: it refuses requests from a Worker, so its
 * requests go through the ChatGPT exit container (Plan 75).
 */
const MODEL_PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  // ChatGPT subscription: device-code sign-in and token refresh.
  "auth.openai.com",
  // BYO OpenAI route.
  "api.openai.com",
  // Claude account route and BYO Anthropic route.
  "api.anthropic.com",
  // Claude account route: sign-in and token refresh.
  "platform.claude.com",
]);

async function forwardModelProviderRequest(
  request: Request,
  env: ModelExitEnv,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  // The location read runs beside the provider request; it ends first. It
  // must outlive a request whose provider fetch throws: the read is shared
  // by the isolate, and a cancelled read would hold every later request.
  const colo = readIsolateLocation(env);
  context.waitUntil(colo);
  if (!isModelProviderUrl(url)) {
    traceWarn("model_exit.host_refused", {
      requestId: newRequestId(),
      host: url.host,
    });
    return withExitColo(
      Response.json({ error: "model_exit_host_refused" }, { status: 403 }),
      await colo,
    );
  }
  const headers = new Headers(request.headers);
  // Cloudflare's own request headers, such as cf-placement, stay here.
  for (const name of [...headers.keys()])
    if (name.startsWith("cf-")) headers.delete(name);
  const upstream = await fetch(
    new Request(request, { headers, redirect: "manual" }),
  );
  traceLog("model_exit.forwarded", {
    requestId: newRequestId(),
    host: url.host,
    status: upstream.status,
    // Where the provider's network received the request.
    provider_colo: rayColo(upstream.headers.get("cf-ray")),
  });
  return withExitColo(new Response(upstream.body, upstream), await colo);
}

function isModelProviderUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    MODEL_PROVIDER_HOSTS.has(url.hostname)
  );
}

function withExitColo(response: Response, colo: string | null): Response {
  response.headers.set(MODEL_EXIT_COLO_HEADER, colo ?? "unknown");
  return response;
}

/** The data-centre code at the end of a `cf-ray` value. */
function rayColo(ray: string | null): string | null {
  return ray === null ? null : (/-([A-Z]{3})$/u.exec(ray)?.[1] ?? null);
}
