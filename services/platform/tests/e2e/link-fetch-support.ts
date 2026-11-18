// Fetches that leave through the Organisation's fetch Actors (link reads and
// custom connectors): the public address that the fake resolver gives, the
// link-fetch binding of an Actor, and the operator's erase of a fetch Actor.
import { env, exports } from "cloudflare:workers";
import { HttpResponse, type HttpResponseResolver } from "msw";
import { isRecord } from "@seams/std";

const REGISTRY_ROUTE = "https://localhost/v1/admin/state-object-registry";

/** The resolver's answer: one public address for an A query, none for others. */
export function resolvePublicAddress({
  request,
}: Parameters<HttpResponseResolver>[0]): Response {
  return HttpResponse.json({
    Status: 0,
    Answer:
      new URL(request.url).searchParams.get("type") === "A"
        ? [{ type: 1, data: "93.184.216.34" }]
        : [],
  });
}

/** Points the Actor's link-fetch binding at `linkFetch`. */
export function bindLinkFetch(linkFetch: object, actor: object): void {
  const bindings = Reflect.get(actor, "env");
  if (!isRecord(bindings)) throw new Error("The Actor has no environment");
  Object.defineProperty(bindings, "MESSAGE_LINK_FETCH", {
    configurable: true,
    value: linkFetch,
  });
}

/** The status of an erase, and the code of its refusal. */
export async function erase(
  objectKind: string,
  objectId: string,
): Promise<{ status: number; code: unknown }> {
  const answered = await exports.default.fetch(
    new Request(REGISTRY_ROUTE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "erase_unregistered_actor",
        objectKind,
        objectId,
      }),
    }),
  );
  const body: unknown = await answered.json().catch(() => null);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  return { status: answered.status, code: error?.code ?? null };
}
