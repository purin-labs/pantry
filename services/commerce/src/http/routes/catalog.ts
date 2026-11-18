import type { OfferPriceCommandResult } from "../../commerce-authority/offer-price-commands.ts";
import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { isRecord } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import {
  type ParsedBody,
  hasMerchantId,
  readJsonBody,
} from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import { mediaBaseUrl } from "./buyer-catalog.ts";

export async function readOfferPricePolicyRoute(
  ctx: HttpRouteContext,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "read_offer_price_policy" }
  >,
): Promise<Response> {
  return offerPriceResponse(
    ctx.authority.readOfferPricePolicy(route.merchantId, route.offerId),
  );
}

export async function setOfferPricePolicyRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "set_offer_price_policy" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const command = parseSetOfferPricePolicyBody(
    body.value,
    route.merchantId,
    route.offerId,
  );
  if (!command.ok) return command.response;
  return offerPriceResponse(ctx.authority.setOfferPricePolicy(command.value));
}

export async function disableOfferPricePolicyRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "disable_offer_price_policy" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const command = parseDisableOfferPricePolicyBody(
    body.value,
    route.merchantId,
    route.offerId,
  );
  if (!command.ok) return command.response;
  return offerPriceResponse(
    ctx.authority.disableOfferPricePolicy(command.value),
  );
}

export async function collectionCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "create_collection" | "update_collection" | "delete_collection" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind !== "create_collection" &&
      body.value.collectionId !== route.collectionId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "create_collection"
      ? ctx.authority.createCollection(body.value)
      : route.kind === "update_collection"
        ? ctx.authority.updateCollection(body.value)
        : ctx.authority.deleteCollection(body.value),
  );
}

export async function listCollectionsRoute(
  ctx: HttpRouteContext,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "list_collections" }
  >,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "underclerk.collections.v1",
    collections: ctx.authority.listCollections(route.merchantId),
  });
}

export async function readCatalogSnapshotRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "read_catalog_snapshot" }
  >,
): Promise<Response> {
  // What the Worker serves catalog reads from (catalog-snapshots.ts).
  const context = ctx.authority.readBuyerStorefrontContext(
    route.merchantId,
    route.storefrontId,
  );
  const catalog = ctx.authority.readBuyerCatalog(
    route.merchantId,
    route.storefrontId,
    mediaBaseUrl(
      ctx,
      request.headers.get("x-underclerk-public-origin") ??
        new URL(request.url).origin,
      route,
    ),
  );
  const profile = ctx.authority.readActiveCheckoutProfile(
    route.merchantId,
    route.storefrontId,
  )?.profile;
  return context === undefined || catalog === undefined
    ? jsonResponse(404, { message: "Storefront not found" })
    : jsonResponse(200, {
        schemaVersion: "underclerk.catalog-snapshot.v1",
        organisationId: context.organisationId,
        storefrontRevision: context.storefront.revision,
        builtAt: ctx.authority.currentTime(),
        checkoutProfile:
          profile === undefined
            ? null
            : {
                checkoutProfileId: profile.checkoutProfileId,
                revision: profile.revision,
                configuration: profile.configuration,
              },
        catalog,
      });
}

export async function catalogEditRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "update_product" | "update_variant" | "update_offer" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const [field, id] =
    route.kind === "update_product"
      ? (["productId", route.productId] as const)
      : route.kind === "update_variant"
        ? (["variantId", route.variantId] as const)
        : (["offerId", route.offerId] as const);
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value[field] !== id
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "update_product"
      ? ctx.authority.updateProduct(body.value)
      : route.kind === "update_variant"
        ? ctx.authority.updateVariant(body.value)
        : ctx.authority.updateOffer(body.value),
  );
}

export async function deleteProductRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "delete_product" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.productId !== route.productId
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(200, ctx.authority.deleteProduct(body.value));
}

export async function updateStorefrontTaxRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "update_storefront_tax" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.storefrontId !== route.storefrontId
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(200, ctx.authority.updateStorefrontTax(body.value));
}

export async function adjustOfferPriceRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "adjust_offer_price" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (!hasMerchantId(body.value, route.merchantId)) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  // A price change is an ordinary governed mutation: it returns the same
  // signed receipt every other command does, so the action path that
  // approved it gets the evidence it expects.
  return jsonResponse(200, ctx.authority.adjustOfferPrice(body.value));
}

/**
 * Maps one price command result onto a response.
 *
 * A refusal is 409 rather than 400: the request was well formed, and what it
 * asked for was refused by the merchant's own policy or by state that moved.
 */
export function offerPriceResponse(
  result: OfferPriceCommandResult<unknown>,
): Response {
  return result.ok
    ? jsonResponse(200, { outcome: "accepted", value: result.value })
    : jsonResponse(result.refusal.code === "offer_not_found" ? 404 : 409, {
        outcome: "rejected",
        refusal: result.refusal,
      });
}

export function offerPriceBadRequest<T>(message: string): ParsedBody<T> {
  return { ok: false, response: jsonResponse(400, { message }) };
}

export function parseSetOfferPricePolicyBody(
  body: unknown,
  merchantId: string,
  offerId: string,
): ParsedBody<
  Readonly<{
    merchantId: string;
    offerId: string;
    expectedRevision: number | null;
    maxMovementBps: number;
    occurredAt: string;
  }>
> {
  if (!isRecord(body)) return offerPriceBadRequest("Body must be an object");
  const { expectedRevision, maxMovementBps, occurredAt } = body;
  // Null expectedRevision means "no policy yet"; any other non-positive value
  // is a malformed claim about one.
  if (
    expectedRevision !== null &&
    (typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision <= 0)
  ) {
    return offerPriceBadRequest(
      "expectedRevision must be a positive integer or null",
    );
  }
  if (
    typeof maxMovementBps !== "number" ||
    !Number.isSafeInteger(maxMovementBps) ||
    maxMovementBps < 0 ||
    maxMovementBps > 10_000
  ) {
    return offerPriceBadRequest("maxMovementBps must be between 0 and 10000");
  }
  if (typeof occurredAt !== "string" || occurredAt.length === 0) {
    return offerPriceBadRequest("occurredAt must be a timestamp");
  }
  return {
    ok: true,
    value: {
      merchantId,
      offerId,
      expectedRevision,
      maxMovementBps,
      occurredAt,
    },
  };
}

export function parseDisableOfferPricePolicyBody(
  body: unknown,
  merchantId: string,
  offerId: string,
): ParsedBody<
  Readonly<{
    merchantId: string;
    offerId: string;
    expectedRevision: number;
    occurredAt: string;
  }>
> {
  if (!isRecord(body)) return offerPriceBadRequest("Body must be an object");
  const { expectedRevision, occurredAt } = body;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision <= 0
  ) {
    return offerPriceBadRequest("expectedRevision must be a positive integer");
  }
  if (typeof occurredAt !== "string" || occurredAt.length === 0) {
    return offerPriceBadRequest("occurredAt must be a timestamp");
  }
  return {
    ok: true,
    value: { merchantId, offerId, expectedRevision, occurredAt },
  };
}
