import type { AccessRouteTransport } from "@purin-labs/control-api/portal/access-models";

/** A page with no Access backend (a preview, or the public workflow demo):
 * a permission prompt opens in explain mode. */
export const UNAVAILABLE_ACCESS: Pick<AccessRouteTransport, "read" | "mutate"> =
  {
    read: unavailable,
    mutate: unavailable,
  };

function unavailable(): Promise<{
  readonly ok: false;
  readonly error: { readonly kind: "network"; readonly message: string };
}> {
  return Promise.resolve({
    ok: false,
    error: {
      kind: "network",
      message: "Access is not available in this preview.",
    },
  });
}
