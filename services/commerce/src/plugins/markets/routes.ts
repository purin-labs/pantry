// The routes of the markets built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@seams/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type MarketsRoute =
  | Readonly<{ kind: "create_market"; merchantId: string }>
  | Readonly<{ kind: "list_markets"; merchantId: string }>
  | Readonly<{ kind: "update_market"; merchantId: string; marketId: string }>;

const route = routeFor<MarketsRoute>();

export const MARKETS_ROUTES: readonly RouteDefinition<MarketsRoute>[] = [
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/markets",
    "create_market",
    "underclerk.create-market.v1",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/markets", "list_markets"),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/markets/:marketId",
    "update_market",
    "underclerk.update-market.v1",
  ),
];

/** The routes a storefront buyer calls without the service token. */
export const MARKETS_BUYER_ROUTE_KINDS =
  [] as const satisfies readonly MarketsRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const MARKETS_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<MarketsRoute["kind"], (typeof MARKETS_BUYER_ROUTE_KINDS)[number]>,
    CommerceApiScope | "operator"
  >
> = {
  create_market: "settings:write",
  update_market: "settings:write",
  list_markets: "settings:read",
};
