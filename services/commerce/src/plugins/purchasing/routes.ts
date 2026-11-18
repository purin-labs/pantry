// The routes of the purchasing built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@seams/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type PurchasingRoute =
  | Readonly<{ kind: "entity_plane_purchasing_preset"; merchantId: string }>
  | Readonly<{ kind: "entity_plane_purchasing_reconcile"; merchantId: string }>;

const route = routeFor<PurchasingRoute>();

export const PURCHASING_ROUTES: readonly RouteDefinition<PurchasingRoute>[] = [
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/purchasing-preset",
    "entity_plane_purchasing_preset",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/entity-plane/purchasing-reconcile",
    "entity_plane_purchasing_reconcile",
  ),
];

/** The routes a storefront buyer calls without the service token. */
export const PURCHASING_BUYER_ROUTE_KINDS =
  [] as const satisfies readonly PurchasingRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const PURCHASING_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      PurchasingRoute["kind"],
      (typeof PURCHASING_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  entity_plane_purchasing_preset: "entity_plane:write",
  entity_plane_purchasing_reconcile: "entity_plane:write",
};
