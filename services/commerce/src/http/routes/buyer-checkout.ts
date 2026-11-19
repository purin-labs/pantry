import {
  parseCreateBuyerPickupCheckoutCommand,
  parseCreateBuyerPaymentSessionCommand,
  parseCreateBuyerShippingCheckoutCommand,
  parseReconcileBuyerPaymentCommand,
  normalizeGiftCardCode,
  parsePlaceBuyerStoredValueCheckoutCommand,
  parseRefreshBuyerPickupCheckoutCommand,
  parseRefreshBuyerShippingCheckoutCommand,
} from "@purin-labs/commerce-client";
import type { BuyerSessionClaims } from "../../buyer-session.ts";
import type { BuyerPaymentResult } from "../../commerce-authority.ts";
import type { BuyerRoute } from "../../http-routes.ts";
import { errorMessage, isRecord } from "@purin-labs/std";
import { verifyBuyerAccess } from "../buyer-access.ts";
import type { HttpRouteContext } from "../context.ts";
import { readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import { resolveShippingDestination } from "./buyer-cart.ts";
import type { Variant } from "@purin-labs/type-utils";

export async function createBuyerCheckoutRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "create_buyer_checkout">,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (access.context.storefront.fulfillment.kind === "pickup") {
    try {
      const command = parseCreateBuyerPickupCheckoutCommand(body.value);
      const creation = ctx.authority.createBuyerPickupCheckout({
        claims: access.claims,
        command: {
          schemaVersion: command.schemaVersion,
          idempotencyKey: command.idempotencyKey,
          cartId: command.cartId,
          cartRevision: command.cartRevision,
          buyer: command.buyer,
          ...(command.discountCodes === undefined
            ? {}
            : { discountCodes: command.discountCodes }),
          ...(command.marketId === undefined
            ? {}
            : { marketId: command.marketId }),
          ...(command.giftCardCodes === undefined
            ? {}
            : { giftCardCodes: command.giftCardCodes }),
          ...(command.storeCredit === undefined
            ? {}
            : { storeCredit: command.storeCredit }),
          ...(command.pickupAt === undefined
            ? {}
            : { pickupAt: command.pickupAt }),
        },
      });
      return creation.kind === "rejected"
        ? jsonResponse(409, {
            outcome: "rejected",
            error: creation.error,
          })
        : jsonResponse(200, creation.checkout);
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
  }
  let command;
  try {
    command = parseCreateBuyerShippingCheckoutCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const shippingDestination = await resolveShippingDestination(
    ctx.buyerAccounts,
    ctx.addressValidations,
    access.claims,
    command.shippingDestination,
  );
  if (shippingDestination === undefined) {
    return jsonResponse(409, {
      message: "Shipping address acceptance is unavailable",
    });
  }
  const creation = ctx.authority.createBuyerShippingCheckout({
    claims: access.claims,
    command: {
      schemaVersion: command.schemaVersion,
      idempotencyKey: command.idempotencyKey,
      cartId: command.cartId,
      cartRevision: command.cartRevision,
      buyer: command.buyer,
      shippingServiceCode: command.shippingServiceCode,
      shippingDestination,
      ...(command.discountCodes === undefined
        ? {}
        : { discountCodes: command.discountCodes }),
      ...(command.giftCardCodes === undefined
        ? {}
        : { giftCardCodes: command.giftCardCodes }),
      ...(command.storeCredit === true ? { storeCredit: true } : {}),
      ...(command.marketId === undefined ? {} : { marketId: command.marketId }),
    },
  });
  return creation.kind === "rejected"
    ? jsonResponse(409, { outcome: "rejected", error: creation.error })
    : jsonResponse(200, creation.checkout);
}

export async function readBuyerCheckoutRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "read_buyer_checkout">,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const checkout = ctx.authority.readBuyerRecoverableCheckout(
    access.claims,
    route.checkoutId,
  );
  return checkout === undefined
    ? jsonResponse(404, { message: "Checkout not found" })
    : jsonResponse(200, checkout);
}

export async function createBuyerPaymentSessionRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "create_buyer_payment_session">,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseCreateBuyerPaymentSessionCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const session = await ctx.authority.createBuyerPaymentSession({
    claims: access.claims,
    checkoutId: route.checkoutId,
    command,
  });
  return session.kind === "rejected"
    ? jsonResponse(409, { outcome: "rejected", error: session.error })
    : jsonResponse(200, session.result);
}

export async function reconcileBuyerPaymentRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "reconcile_buyer_payment">,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseReconcileBuyerPaymentCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const placement = await ctx.authority.reconcileBuyerCheckoutPayment({
    claims: access.claims,
    checkoutId: route.checkoutId,
    command,
  });
  return buyerPaymentResponse(ctx, access.claims, placement);
}

export async function refreshBuyerCheckoutRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "refresh_buyer_checkout">,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    if (access.context.storefront.fulfillment.kind === "pickup") {
      const command = parseRefreshBuyerPickupCheckoutCommand(body.value);
      const refreshed = ctx.authority.refreshBuyerPickupCheckout({
        claims: access.claims,
        checkoutId: route.checkoutId,
        command: {
          schemaVersion: command.schemaVersion,
          idempotencyKey: command.idempotencyKey,
          checkoutRevision: command.checkoutRevision,
          quoteDigest: command.quoteDigest,
          lines: command.lines,
        },
      });
      return refreshed.kind === "rejected"
        ? jsonResponse(409, {
            outcome: "rejected",
            error: refreshed.error,
          })
        : jsonResponse(200, refreshed.checkout);
    }
    const command = parseRefreshBuyerShippingCheckoutCommand(body.value);
    const shippingDestination = await resolveShippingDestination(
      ctx.buyerAccounts,
      ctx.addressValidations,
      access.claims,
      command.shippingDestination,
    );
    if (shippingDestination === undefined) {
      return jsonResponse(409, {
        message: "Shipping address acceptance is unavailable",
      });
    }
    const refreshed = ctx.authority.refreshBuyerShippingCheckout({
      claims: access.claims,
      checkoutId: route.checkoutId,
      command: {
        schemaVersion: command.schemaVersion,
        idempotencyKey: command.idempotencyKey,
        checkoutRevision: command.checkoutRevision,
        quoteDigest: command.quoteDigest,
        lines: command.lines,
        shippingServiceCode: command.shippingServiceCode,
        shippingDestination,
      },
    });
    return refreshed.kind === "rejected"
      ? jsonResponse(409, { outcome: "rejected", error: refreshed.error })
      : jsonResponse(200, refreshed.checkout);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
}

export async function buyerStoredValueRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    BuyerRoute,
    "read_gift_card_balance" | "place_buyer_stored_value_checkout"
  >,
): Promise<Response> {
  const access = verifyBuyerAccess(ctx, request, route);
  if (!access.ok) return access.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (route.kind === "read_gift_card_balance") {
    let code: string;
    try {
      if (!isRecord(body.value)) throw new Error("command must be an object");
      code = normalizeGiftCardCode(body.value.code, "code");
    } catch (error) {
      return jsonResponse(400, { message: errorMessage(error) });
    }
    const balance = ctx.authority.readGiftCardBalance(route.merchantId, code);
    return balance === undefined
      ? jsonResponse(404, { message: "Gift card not found" })
      : jsonResponse(200, balance);
  }
  let command;
  try {
    command = parsePlaceBuyerStoredValueCheckoutCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const placement = ctx.authority.placeBuyerStoredValueCheckout({
    claims: access.claims,
    checkoutId: route.checkoutId,
    command,
  });
  return buyerPaymentResponse(ctx, access.claims, placement);
}

// A placed checkout answers with an order recovery token for its buyer.
function buyerPaymentResponse(
  ctx: HttpRouteContext,
  claims: BuyerSessionClaims,
  placement: BuyerPaymentResult,
): Response {
  if (placement.kind === "rejected") {
    return jsonResponse(409, {
      outcome: "rejected",
      error: placement.error,
    });
  }
  if (placement.result.state !== "placed")
    return jsonResponse(200, placement.result);
  const recovery = ctx.buyerSessions.issueOrderRecovery({
    sessionId: claims.sessionId,
    merchantId: claims.merchantId,
    storefrontId: claims.storefrontId,
    storefrontRevision: claims.storefrontRevision,
    checkoutProfile: claims.checkoutProfile,
    checkoutId: placement.result.checkoutId,
    orderId: placement.result.orderId,
    issuedAt: placement.result.placedAt,
  });
  return jsonResponse(200, {
    ...placement.result,
    orderRecovery: {
      token: recovery.token,
      expiresAt: recovery.claims.expiresAt,
    },
  });
}
