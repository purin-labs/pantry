// This built-in plugin's routes (Plan 77 step 3). The core's route table
// takes them from the plugin's index.ts.
import type { CommerceApiScope } from "@seams/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type ReturnsRoute =
  | Readonly<{ kind: "request_return"; merchantId: string; orderId: string }>
  | Readonly<{
      kind: "list_order_returns";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{
      kind: "exchange_order_lines";
      merchantId: string;
      orderId: string;
    }>
  | Readonly<{ kind: "authorize_return"; merchantId: string; returnId: string }>
  | Readonly<{ kind: "receive_return"; merchantId: string; returnId: string }>
  | Readonly<{ kind: "close_return"; merchantId: string; returnId: string }>
  | Readonly<{
      kind: "request_buyer_return";
      merchantId: string;
      storefrontId: string;
      checkoutId: string;
    }>;

const route = routeFor<ReturnsRoute>();

export const RETURNS_ROUTES: readonly RouteDefinition<ReturnsRoute>[] = [
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/returns",
    "request_return",
    "underclerk.request-return.v1",
  ),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/orders/:orderId/returns",
    "list_order_returns",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/orders/:orderId/exchanges",
    "exchange_order_lines",
    "underclerk.exchange-order-lines.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/returns/:returnId/authorization",
    "authorize_return",
    "underclerk.authorize-return.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/returns/:returnId/receipt",
    "receive_return",
    "underclerk.receive-return.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/returns/:returnId/closure",
    "close_return",
    "underclerk.close-return.v1",
  ),
  route(
    "POST",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/checkouts/:checkoutId/order/returns",
    "request_buyer_return",
  ),
];

/** The routes a storefront buyer calls without the service token. */
export const RETURNS_BUYER_ROUTE_KINDS = [
  "request_buyer_return",
] as const satisfies readonly ReturnsRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const RETURNS_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<ReturnsRoute["kind"], (typeof RETURNS_BUYER_ROUTE_KINDS)[number]>,
    CommerceApiScope | "operator"
  >
> = {
  exchange_order_lines: "orders:write",
  request_return: "orders:write",
  authorize_return: "orders:write",
  receive_return: "orders:write",
  close_return: "orders:write",
  list_order_returns: "orders:read",
};
