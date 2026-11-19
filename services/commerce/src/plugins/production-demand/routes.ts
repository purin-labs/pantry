// This built-in plugin's routes (Plan 77 step 3). The core's route table
// takes them from the plugin's index.ts.
import type { CommerceApiScope } from "@purin-labs/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type ProductionDemandRoute = Readonly<{
  kind: "publish_production_demand_preset";
  merchantId: string;
}>;

const route = routeFor<ProductionDemandRoute>();

export const PRODUCTION_DEMAND_ROUTES: readonly RouteDefinition<ProductionDemandRoute>[] =
  [
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/entity-plane/production-demand-preset",
      "publish_production_demand_preset",
    ),
  ];

/** The routes a storefront buyer calls without the service token. */
export const PRODUCTION_DEMAND_BUYER_ROUTE_KINDS =
  [] as const satisfies readonly ProductionDemandRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const PRODUCTION_DEMAND_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      ProductionDemandRoute["kind"],
      (typeof PRODUCTION_DEMAND_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  publish_production_demand_preset: "entity_plane:write",
};
