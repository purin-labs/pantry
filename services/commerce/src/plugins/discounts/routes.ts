// The routes of the discounts built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@purin-labs/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type DiscountsRoute =
  | Readonly<{ kind: "create_discount"; merchantId: string }>
  | Readonly<{ kind: "list_discounts"; merchantId: string }>
  | Readonly<{
      kind: "deactivate_discount";
      merchantId: string;
      discountId: string;
    }>;

const route = routeFor<DiscountsRoute>();

export const DISCOUNTS_ROUTES: readonly RouteDefinition<DiscountsRoute>[] = [
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/discounts",
    "create_discount",
    "commerce.create-discount.v1",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/discounts", "list_discounts"),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/discounts/:discountId/deactivation",
    "deactivate_discount",
    "commerce.deactivate-discount.v1",
  ),
];

/** The routes a storefront buyer calls without the service token. */
export const DISCOUNTS_BUYER_ROUTE_KINDS =
  [] as const satisfies readonly DiscountsRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const DISCOUNTS_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      DiscountsRoute["kind"],
      (typeof DISCOUNTS_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  create_discount: "discounts:write",
  deactivate_discount: "discounts:write",
  list_discounts: "discounts:read",
};
