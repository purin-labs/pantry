// The routes of the draft orders built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@purin-labs/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type DraftOrdersRoute =
  | Readonly<{ kind: "create_draft_order"; merchantId: string }>
  | Readonly<{
      kind: "read_draft_order";
      merchantId: string;
      draftOrderId: string;
    }>
  | Readonly<{
      kind: "update_draft_order";
      merchantId: string;
      draftOrderId: string;
    }>
  | Readonly<{
      kind: "send_draft_invoice";
      merchantId: string;
      draftOrderId: string;
    }>
  | Readonly<{
      kind: "cancel_draft_order";
      merchantId: string;
      draftOrderId: string;
    }>
  | Readonly<{
      kind: "mark_draft_order_paid";
      merchantId: string;
      draftOrderId: string;
    }>
  | Readonly<{
      kind: "open_draft_invoice";
      merchantId: string;
      storefrontId: string;
      draftOrderId: string;
    }>;

const route = routeFor<DraftOrdersRoute>();

export const DRAFT_ORDERS_ROUTES: readonly RouteDefinition<DraftOrdersRoute>[] =
  [
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/draft-orders",
      "create_draft_order",
      "commerce.create-draft-order.v1",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/draft-orders/:draftOrderId",
      "read_draft_order",
    ),
    route(
      "PUT",
      "/v1/admin/merchants/:merchantId/draft-orders/:draftOrderId",
      "update_draft_order",
      "commerce.update-draft-order.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/draft-orders/:draftOrderId/invoice",
      "send_draft_invoice",
      "commerce.send-draft-invoice.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/draft-orders/:draftOrderId/cancellation",
      "cancel_draft_order",
      "commerce.cancel-draft-order.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/draft-orders/:draftOrderId/manual-payment",
      "mark_draft_order_paid",
      "commerce.mark-draft-order-paid.v1",
    ),
    route(
      "POST",
      "/v1/public/merchants/:merchantId/storefronts/:storefrontId/draft-orders/:draftOrderId/checkouts",
      "open_draft_invoice",
    ),
  ];

/** The routes a storefront buyer calls without the service token. */
export const DRAFT_ORDERS_BUYER_ROUTE_KINDS = [
  "open_draft_invoice",
] as const satisfies readonly DraftOrdersRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const DRAFT_ORDERS_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      DraftOrdersRoute["kind"],
      (typeof DRAFT_ORDERS_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  create_draft_order: "orders:write",
  update_draft_order: "orders:write",
  cancel_draft_order: "orders:write",
  mark_draft_order_paid: "orders:write",
  send_draft_invoice: "orders:write",
  read_draft_order: "orders:read",
};
