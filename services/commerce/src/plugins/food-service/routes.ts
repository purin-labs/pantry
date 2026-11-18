// The routes of the food service built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@seams/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type FoodServiceRoute =
  | Readonly<{ kind: "read_food_service_snapshot"; merchantId: string }>
  | Readonly<{
      kind: "read_preparation_ticket";
      merchantId: string;
      ticketId: string;
    }>
  | Readonly<{ kind: "read_pickup_queue"; merchantId: string }>
  | Readonly<{ kind: "read_sold_out_marks"; merchantId: string }>
  | Readonly<{ kind: "mark_sold_out"; merchantId: string }>
  | Readonly<{ kind: "create_preparation_station"; merchantId: string }>
  | Readonly<{ kind: "create_modifier_group_revision"; merchantId: string }>
  | Readonly<{ kind: "create_recipe_revision"; merchantId: string }>
  | Readonly<{ kind: "configure_stock_policy"; merchantId: string }>
  | Readonly<{ kind: "publish_menu"; merchantId: string }>
  | Readonly<{ kind: "manage_preparation_ticket"; merchantId: string }>
  | Readonly<{ kind: "complete_production_batch"; merchantId: string }>;

const route = routeFor<FoodServiceRoute>();

export const FOOD_SERVICE_ROUTES: readonly RouteDefinition<FoodServiceRoute>[] =
  [
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/preparation-stations",
      "create_preparation_station",
      "underclerk.create-preparation-station.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/modifier-groups",
      "create_modifier_group_revision",
      "underclerk.create-modifier-group-revision.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/recipes",
      "create_recipe_revision",
      "underclerk.create-recipe-revision.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/stock-policies",
      "configure_stock_policy",
      "underclerk.configure-stock-policy.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/menus",
      "publish_menu",
      "underclerk.publish-menu.v1",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/food-service/snapshot",
      "read_food_service_snapshot",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/food-service/preparation-tickets/:ticketId",
      "read_preparation_ticket",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/food-service/pickup-queue",
      "read_pickup_queue",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/food-service/sold-out-marks",
      "read_sold_out_marks",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/sold-out-marks",
      "mark_sold_out",
      "underclerk.mark-sold-out.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/preparation-tickets",
      "manage_preparation_ticket",
      "underclerk.manage-preparation-ticket.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/food-service/production-batches",
      "complete_production_batch",
      "underclerk.complete-production-batch.v1",
    ),
  ];

/** The routes a storefront buyer calls without the service token. */
export const FOOD_SERVICE_BUYER_ROUTE_KINDS =
  [] as const satisfies readonly FoodServiceRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const FOOD_SERVICE_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      FoodServiceRoute["kind"],
      (typeof FOOD_SERVICE_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  publish_menu: "catalog:write",
  create_modifier_group_revision: "catalog:write",
  read_food_service_snapshot: "catalog:read",
  configure_stock_policy: "inventory:write",
  create_recipe_revision: "inventory:write",
  complete_production_batch: "inventory:write",
  create_preparation_station: "orders:write",
  manage_preparation_ticket: "orders:write",
  read_preparation_ticket: "orders:read",
  read_pickup_queue: "orders:read",
  read_sold_out_marks: "catalog:read",
  mark_sold_out: "inventory:write",
};
