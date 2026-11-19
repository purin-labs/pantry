// The routes of the media built-in plugin (Plan 77 step 3). The core's
// route table takes them from this plugin's index.ts.
import type { CommerceApiScope } from "@purin-labs/commerce-client";

import { routeFor, type RouteDefinition } from "../../route-definitions.ts";

export type MediaRoute =
  | Readonly<{
      kind: "read_storefront_media";
      merchantId: string;
      storefrontId: string;
      mediaId: string;
    }>
  | Readonly<{ kind: "upload_media"; merchantId: string }>
  | Readonly<{ kind: "create_media"; merchantId: string }>
  | Readonly<{ kind: "list_media"; merchantId: string }>
  | Readonly<{ kind: "read_media_content"; merchantId: string; mediaId: string }>
  | Readonly<{ kind: "update_media"; merchantId: string; mediaId: string }>
  | Readonly<{ kind: "delete_media"; merchantId: string; mediaId: string }>
  | Readonly<{
      kind: "set_product_media";
      merchantId: string;
      productId: string;
    }>;

const route = routeFor<MediaRoute>();

export const MEDIA_ROUTES: readonly RouteDefinition<MediaRoute>[] = [
  route(
    "GET",
    "/v1/public/merchants/:merchantId/storefronts/:storefrontId/media/:mediaId",
    "read_storefront_media",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/media-uploads",
    "upload_media",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/media",
    "create_media",
    "underclerk.create-media.v1",
  ),
  route("GET", "/v1/admin/merchants/:merchantId/media", "list_media"),
  route(
    "GET",
    "/v1/admin/merchants/:merchantId/media/:mediaId/content",
    "read_media_content",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/media/:mediaId",
    "update_media",
    "underclerk.update-media.v1",
  ),
  route(
    "POST",
    "/v1/admin/merchants/:merchantId/media/:mediaId/deletion",
    "delete_media",
    "underclerk.delete-media.v1",
  ),
  route(
    "PUT",
    "/v1/admin/merchants/:merchantId/products/:productId/media",
    "set_product_media",
    "underclerk.set-product-media.v1",
  ),
];

/** The routes a storefront buyer calls without the service token. */
export const MEDIA_BUYER_ROUTE_KINDS = [
  "read_storefront_media",
] as const satisfies readonly MediaRoute["kind"][];

/**
 * The scope each admin route needs; "operator" routes take only the operator
 * token.
 */
export const MEDIA_ROUTE_ACCESS: Readonly<
  Record<
    Exclude<MediaRoute["kind"], (typeof MEDIA_BUYER_ROUTE_KINDS)[number]>,
    CommerceApiScope | "operator"
  >
> = {
  upload_media: "catalog:write",
  create_media: "catalog:write",
  update_media: "catalog:write",
  delete_media: "catalog:write",
  set_product_media: "catalog:write",
  list_media: "catalog:read",
  read_media_content: "catalog:read",
};
