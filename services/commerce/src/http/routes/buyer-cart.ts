import {
  parseCreateBuyerCartCommand,
  parseReplaceBuyerCartCommand,
  parseValidateBuyerShippingAddressCommand,
  type CommerceBuyerShippingDestinationV1,
} from "@purin-labs/commerce-client";
import type { BuyerRoute } from "../../http-routes.ts";
import {
  buyerSessionDigest,
  type BuyerSessionClaims,
} from "../../buyer-session.ts";
import type { BuyerAccountGateway } from "../../buyer-account.ts";
import type { BuyerShippingDestinationAuthority } from "../../commerce-authority/checkout-planning.ts";
import { ShippingAddressValidationService } from "../../shipping-address-validation.ts";
import { assertNever, errorMessage } from "@purin-labs/std";
import { buyerSessionClaims, verifyBuyerAccess } from "../buyer-access.ts";
import type { HttpRouteContext } from "../context.ts";
import { readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

export async function buyerCartRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    BuyerRoute,
    "create_buyer_cart" | "read_buyer_cart" | "replace_buyer_cart"
  >,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  if (route.kind === "read_buyer_cart") {
    const cart = ctx.authority.readBuyerCart(access.claims, route.cartId);
    return cart === undefined
      ? jsonResponse(404, { message: "Cart not found" })
      : jsonResponse(200, cart);
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    const mutation =
      route.kind === "create_buyer_cart"
        ? ctx.authority.createBuyerCart({
            claims: access.claims,
            command: parseCreateBuyerCartCommand(body.value),
          })
        : ctx.authority.replaceBuyerCart({
            claims: access.claims,
            cartId: route.cartId,
            command: parseReplaceBuyerCartCommand(body.value),
          });
    return mutation.kind === "resolved"
      ? jsonResponse(200, mutation.cart)
      : jsonResponse(409, { outcome: "rejected", error: mutation.error });
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
}

export async function validateBuyerShippingAddressRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "validate_buyer_shipping_address">,
): Promise<Response> {
  if (ctx.addressValidations === undefined) {
    return jsonResponse(503, {
      message: "Address validation is unavailable",
    });
  }
  const context = ctx.authority.readBuyerStorefrontContext(
    route.merchantId,
    route.storefrontId,
  );
  if (
    context === undefined ||
    context.storefront.fulfillment.kind !== "shipping"
  ) {
    return jsonResponse(404, {
      message: "Shipping storefront not found",
    });
  }
  const claims = buyerSessionClaims(ctx, request, route, context);
  if (claims === undefined)
    return jsonResponse(401, { message: "Unauthorized" });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseValidateBuyerShippingAddressCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const result = await ctx.addressValidations.validate({
    merchantId: claims.merchantId,
    storefrontId: claims.storefrontId,
    buyerSessionDigest: buyerSessionDigest(claims.sessionId),
    idempotencyKey: command.idempotencyKey,
    address: command.address,
  });
  return result.kind === "idempotency_conflict"
    ? jsonResponse(409, {
        message: "Address validation idempotency conflict",
      })
    : jsonResponse(200, result.value);
}

export async function resolveShippingDestination(
  gateway: BuyerAccountGateway,
  addressValidations: ShippingAddressValidationService | undefined,
  claims: BuyerSessionClaims,
  destination: CommerceBuyerShippingDestinationV1,
): Promise<BuyerShippingDestinationAuthority | undefined> {
  switch (destination.kind) {
    case "provided_address": {
      if (addressValidations === undefined) return undefined;
      const accepted = addressValidations.accept({
        merchantId: claims.merchantId,
        storefrontId: claims.storefrontId,
        buyerSessionDigest: buyerSessionDigest(claims.sessionId),
        address: destination.address,
        acceptance: destination.acceptance,
      });
      return accepted === undefined
        ? undefined
        : {
            kind: "provided_address",
            address: accepted.address,
            addressValidationReference: accepted.addressValidationReference,
          };
    }
    case "saved_address": {
      if (claims.buyer.kind !== "identified_customer") return undefined;
      const result = await gateway.resolveSavedAddress({
        merchantId: claims.merchantId,
        storefrontId: claims.storefrontId,
        protectedCustomerReference: claims.buyer.protectedCustomerReference,
        protectedCustomerSessionReference:
          claims.buyer.protectedCustomerSessionReference,
        savedAddressReference: destination.savedAddressReference,
        buyerSessionDigest: buyerSessionDigest(claims.sessionId),
      });
      return result.kind === "unavailable"
        ? undefined
        : {
            kind: "saved_address",
            savedAddressReference: destination.savedAddressReference,
            address: result.value.address,
            addressValidationReference: result.value.addressValidationReference,
          };
    }
    default:
      return assertNever(destination, "Unsupported buyer shipping destination");
  }
}
