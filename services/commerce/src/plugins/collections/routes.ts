// The routes of the collections built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@purin-labs/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type CollectionsRoute =
  | Readonly<{ kind: "create_collection"; merchantId: string }>
  | Readonly<{ kind: "list_collections"; merchantId: string }>
  | Readonly<{
      kind: "update_collection";
      merchantId: string;
      collectionId: string;
    }>
  | Readonly<{
      kind: "delete_collection";
      merchantId: string;
      collectionId: string;
    }>
  | Readonly<{
      kind: "list_buyer_collections";
      merchantId: string;
      storefrontId: string;
    }>
  | Readonly<{
      kind: "read_buyer_collection";
      merchantId: string;
      storefrontId: string;
      handle: string;
    }>;

const route = routeFor<CollectionsRoute>();

export const COLLECTIONS_ROUTES: readonly RouteDefinition<CollectionsRoute>[] =
  [
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/collections",
      "create_collection",
      "commerce.create-collection.v1",
    ),
    route(
      "GET",
      "/v1/admin/merchants/:merchantId/collections",
      "list_collections",
    ),
    route(
      "PUT",
      "/v1/admin/merchants/:merchantId/collections/:collectionId",
      "update_collection",
      "commerce.update-collection.v1",
    ),
    route(
      "POST",
      "/v1/admin/merchants/:merchantId/collections/:collectionId/deletion",
      "delete_collection",
      "commerce.delete-collection.v1",
    ),
    route(
      "GET",
      "/v1/public/merchants/:merchantId/storefronts/:storefrontId/collections",
      "list_buyer_collections",
    ),
    route(
      "GET",
      "/v1/public/merchants/:merchantId/storefronts/:storefrontId/collections/:handle",
      "read_buyer_collection",
    ),
  ];

/** The routes a storefront buyer calls without the service token. */
export const COLLECTIONS_BUYER_ROUTE_KINDS = [
  "list_buyer_collections",
  "read_buyer_collection",
] as const satisfies readonly CollectionsRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const COLLECTIONS_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<
      CollectionsRoute["kind"],
      (typeof COLLECTIONS_BUYER_ROUTE_KINDS)[number]
    >,
    CommerceApiScope | "operator"
  >
> = {
  create_collection: "catalog:write",
  update_collection: "catalog:write",
  delete_collection: "catalog:write",
  list_collections: "catalog:read",
};
