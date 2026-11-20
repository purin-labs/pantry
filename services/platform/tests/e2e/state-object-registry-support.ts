import { env, exports } from "cloudflare:workers";

export const STATE_OBJECT_REGISTRY_ROUTE =
  "https://localhost/v1/admin/state-object-registry";

/** One operator command on the state object registry, with the admin token. */
export function stateObjectRegistryCommand(
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return exports.default.fetch(
    new Request(STATE_OBJECT_REGISTRY_ROUTE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}
