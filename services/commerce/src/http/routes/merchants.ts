import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { parseSetCommerceStorefrontShopNameV1 } from "@seams/commerce-contracts/records/api-shop-names";
import { errorMessage } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import {
  hasDeliveryId,
  hasDemoProfile,
  hasMerchantId,
  readJsonBody,
} from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@seams/type-utils";

/** A storefront's shop name: read it, or take a new one. */
export async function handleShopName(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    CommerceRoute,
    "read_storefront_shop_name" | "set_storefront_shop_name"
  >,
): Promise<Response> {
  if (ctx.shopNames === undefined)
    return jsonResponse(503, { message: "Shop names are unavailable" });
  if (
    ctx.authority.readStorefront(route.merchantId, route.storefrontId) ===
    undefined
  )
    return jsonResponse(404, { message: "Storefront not found" });
  if (route.kind === "read_storefront_shop_name")
    return jsonResponse(
      200,
      await ctx.shopNames.read(route.merchantId, route.storefrontId),
    );
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const input = parseSetCommerceStorefrontShopNameV1(body.value);
  if (!input.ok)
    return jsonResponse(400, { message: "Shop name body is invalid" });
  const change = await ctx.shopNames.set(
    route.merchantId,
    route.storefrontId,
    input.value.name,
  );
  // A refused name is an answer for the caller to show, not an error.
  return jsonResponse(200, change);
}

export async function closeMerchantRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "close_merchant">,
): Promise<Response> {
  if (ctx.access === undefined)
    return jsonResponse(409, {
      message: "API credentials are not available",
    });
  const result = await ctx.authority.closeMerchant(
    route.merchantId,
    ctx.access,
    ctx.squareAccounts?.connections,
  );
  return result.kind === "closed"
    ? jsonResponse(200, result.closure)
    : jsonResponse(404, { message: "Merchant not found" });
}

export async function provisionMerchantRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "provision_merchant">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!hasMerchantId(body.value, route.merchantId)) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  try {
    return jsonResponse(200, ctx.authority.provisionMerchant(body.value));
  } catch (error) {
    return jsonResponse(409, { message: errorMessage(error) });
  }
}

export async function provisionDemoRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "provision_demo">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !hasDemoProfile(body.value, route.profile)
  ) {
    return jsonResponse(400, {
      message: "Demo profile path and command must match",
    });
  }
  try {
    return jsonResponse(200, ctx.authority.provisionDemo(body.value));
  } catch (error) {
    return jsonResponse(409, { message: errorMessage(error) });
  }
}

export async function acknowledgeDeliveryRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "acknowledge_delivery">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !hasDeliveryId(body.value, route.deliveryId)
  ) {
    return jsonResponse(400, {
      message: "Delivery path and command must match",
    });
  }
  try {
    return jsonResponse(200, ctx.authority.acknowledgeDelivery(body.value));
  } catch (error) {
    return jsonResponse(409, { message: errorMessage(error) });
  }
}

export async function runArchiveRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "run_archive">,
): Promise<Response> {
  if (ctx.archive === undefined)
    return jsonResponse(409, {
      message: "No archive store is configured",
    });
  return jsonResponse(
    200,
    await ctx.authority.runArchive(route.merchantId, ctx.archive),
  );
}
