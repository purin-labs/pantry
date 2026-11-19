import { mediaObjectKey } from "../../plugins/media/index.ts";
import type { BuyerRoute } from "../../http-routes.ts";
import { catalogSearchRequest, searchCatalog } from "../../catalog-search.ts";
import { verifyBuyerAccess } from "../buyer-access.ts";
import type { HttpRouteContext } from "../context.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

// Serves an image only while this storefront's catalog shows it, so the
// images of a draft or archived product stay private.
export async function storefrontMedia(
  ctx: HttpRouteContext,
  request: Request,
  route: Readonly<{
    merchantId: string;
    storefrontId: string;
    mediaId: string;
  }>,
): Promise<Response> {
  const media =
    ctx.media === undefined
      ? undefined
      : ctx.authority.readStorefrontMedia(
          route.merchantId,
          route.storefrontId,
          route.mediaId,
        );
  if (ctx.media === undefined || media === undefined)
    return jsonResponse(404, { message: "Image not found" });
  const headers = {
    "cache-control": "public, max-age=3600",
    etag: `"${media.sha256}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (request.headers.get("if-none-match") === headers.etag)
    return new Response(null, { status: 304, headers });
  const object = await ctx.media.get(
    mediaObjectKey(route.merchantId, media.sha256),
  );
  if (object === null) return jsonResponse(404, { message: "Image not found" });
  return new Response(object.body, {
    status: 200,
    headers: {
      ...headers,
      "content-type": media.contentType,
      "content-length": String(object.size),
    },
  });
}

export function mediaBaseUrl(
  ctx: HttpRouteContext,
  origin: string,
  route: Readonly<{ merchantId: string; storefrontId: string }>,
): string | undefined {
  return ctx.media === undefined
    ? undefined
    : `${origin}/v1/public/merchants/${encodeURIComponent(route.merchantId)}/storefronts/${encodeURIComponent(route.storefrontId)}/media/`;
}

export async function buyerCatalogRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "read_buyer_catalog" | "search_buyer_catalog">,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const catalog = ctx.authority.readBuyerCatalog(
    route.merchantId,
    route.storefrontId,
    mediaBaseUrl(ctx, new URL(request.url).origin, route),
  );
  if (catalog === undefined)
    return jsonResponse(404, { message: "Storefront not found" });
  if (route.kind === "read_buyer_catalog") return jsonResponse(200, catalog);
  const search = catalogSearchRequest(request);
  return search === undefined
    ? jsonResponse(400, {
        message: "The search limit must be a whole number",
      })
    : jsonResponse(200, searchCatalog(catalog, search.query, search.limit));
}

export async function buyerCollectionsRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    BuyerRoute,
    "list_buyer_collections" | "read_buyer_collection"
  >,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const channel = access.context.storefront.salesChannelId;
  if (route.kind === "list_buyer_collections")
    return jsonResponse(200, {
      schemaVersion: "underclerk.buyer-collections.v1",
      collections: ctx.authority.readBuyerCollections(
        route.merchantId,
        channel,
      ),
    });
  const query = new URL(request.url).searchParams;
  const number = (name: string) => {
    const raw = query.get(name);
    return raw === null ? undefined : Number(raw);
  };
  const after = query.get("after");
  const limit = number("limit");
  const tag = query.get("tag");
  const minimumPrice = number("minimumPrice");
  const maximumPrice = number("maximumPrice");
  const page = ctx.authority.readBuyerCollectionPage(
    route.merchantId,
    channel,
    route.handle,
    {
      ...(after === null ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
      ...(tag === null ? {} : { tag }),
      ...(minimumPrice === undefined ? {} : { minimumPrice }),
      ...(maximumPrice === undefined ? {} : { maximumPrice }),
      ...(query.get("availableOnly") === "true" ? { availableOnly: true } : {}),
    },
  );
  return page === undefined
    ? jsonResponse(404, { message: "Collection not found" })
    : jsonResponse(200, page);
}
