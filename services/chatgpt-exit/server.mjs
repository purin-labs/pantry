// The container of the ChatGPT exit (Plan 75). It forwards the chatgpt.com
// requests of the ChatGPT subscription route, because chatgpt.com refuses
// them from a Worker and accepts them from a container.
//
// The image places foundation/agent/chatgpt-exit/forward.ts next to this
// file, and Node runs it with its own type stripping. The server never logs a
// header, a body or a token.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { exitRefusal, forwardChatGptRequest } from "./forward.ts";

const PORT = 8080;
/** OpenAI refuses requests from these locations. */
const REFUSED_LOCATIONS = new Set(["CN", "HK", "MO"]);

let location = null;

createServer((incoming, outgoing) => {
  serve(incoming, outgoing).catch(() => {
    if (!outgoing.headersSent)
      outgoing.writeHead(502, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "chatgpt_exit_upstream_failed" }));
  });
}).listen(PORT);

async function serve(incoming, outgoing) {
  if (incoming.url === "/health") {
    outgoing.writeHead(200).end("ok");
    return;
  }
  const { colo, loc } = await readLocation();
  // An unknown location is refused too: the refusal must not depend on a
  // trace read that worked. The next request reads the location again.
  const response =
    loc === null
      ? exitRefusal(503, "chatgpt_exit_location_unknown", colo)
      : REFUSED_LOCATIONS.has(loc)
        ? exitRefusal(503, "chatgpt_exit_location_refused", colo)
        : await forwardChatGptRequest(await toRequest(incoming), {
            fetch,
            colo,
          });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body === null) outgoing.end();
  else Readable.fromWeb(response.body).pipe(outgoing);
}

async function toRequest(incoming) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers))
    if (typeof value === "string") headers.set(name, value);
  const body =
    incoming.method === "GET" || incoming.method === "HEAD"
      ? undefined
      : Buffer.concat(await Array.fromAsync(incoming));
  return new Request(`http://chatgpt-exit${incoming.url}`, {
    method: incoming.method,
    headers,
    body,
  });
}

/**
 * The data centre and country that the provider sees. A read that names a
 * country is kept; a failed read or a trace with no country is tried again
 * with the next request.
 */
async function readLocation() {
  if (location !== null) return location;
  try {
    const trace = await (
      await fetch("https://cloudflare.com/cdn-cgi/trace")
    ).text();
    const fields = Object.fromEntries(
      trace
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    const read = {
      colo: fields.colo || null,
      loc: /^[A-Z]{2}$/u.test(fields.loc ?? "") ? fields.loc : null,
    };
    if (read.loc === null) return read;
    location = read;
    console.log(
      JSON.stringify({
        event: "chatgpt_exit.location",
        colo: location.colo,
        loc: location.loc,
      }),
    );
    return location;
  } catch {
    return { colo: null, loc: null };
  }
}
