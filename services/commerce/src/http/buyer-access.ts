// The start of a buyer route: the storefront that the route names, and the
// buyer token that the request carries for it. A missing storefront answers
// 404, and a missing or wrong token 401.
import type { BuyerSessionClaims } from "../buyer-session.ts";
import type { BuyerStorefrontContext } from "../commerce-authority.ts";
import type { HttpRouteContext } from "./context.ts";
import { bearerToken } from "./request-body.ts";
import { jsonResponse } from "./responses.ts";

type BuyerStorefrontRoute = Readonly<{
  merchantId: string;
  storefrontId: string;
}>;

type TokenVerification<TClaims> =
  Readonly<{ ok: true; claims: TClaims }> | Readonly<{ ok: false }>;

type BuyerAccess<TClaims> =
  | Readonly<{ ok: true; context: BuyerStorefrontContext; claims: TClaims }>
  | Readonly<{ ok: false; response: Response }>;

/** A buyer session for the storefront's current revision. */
export function verifyBuyerAccess(
  ctx: HttpRouteContext,
  request: Request,
  route: BuyerStorefrontRoute,
): BuyerAccess<BuyerSessionClaims> {
  return storefrontAccess(ctx, request, route, (token, context) =>
    ctx.buyerSessions.verify(token, sessionScope(route, context)),
  );
}

/** The order recovery token of the route's checkout. */
export function verifyOrderRecoveryAccess(
  ctx: HttpRouteContext,
  request: Request,
  route: BuyerStorefrontRoute & Readonly<{ checkoutId: string }>,
) {
  return storefrontAccess(ctx, request, route, (token, context) =>
    ctx.buyerSessions.verifyOrderRecovery(token, {
      ...sessionScope(route, context),
      checkoutId: route.checkoutId,
    }),
  );
}

/** The invoice token of the route's draft order. */
export function verifyDraftInvoiceAccess(
  ctx: HttpRouteContext,
  request: Request,
  route: BuyerStorefrontRoute & Readonly<{ draftOrderId: string }>,
) {
  return storefrontAccess(ctx, request, route, (token) =>
    ctx.buyerSessions.verifyDraftInvoice(token, {
      merchantId: route.merchantId,
      storefrontId: route.storefrontId,
      draftOrderId: route.draftOrderId,
    }),
  );
}

/** The claims of the request's buyer session, or undefined without one. */
export function buyerSessionClaims(
  ctx: HttpRouteContext,
  request: Request,
  route: BuyerStorefrontRoute,
  context: BuyerStorefrontContext,
): BuyerSessionClaims | undefined {
  const token = bearerToken(request);
  if (token === undefined) {
    return undefined;
  }
  const verification = ctx.buyerSessions.verify(
    token,
    sessionScope(route, context),
  );
  return verification.ok ? verification.claims : undefined;
}

function storefrontAccess<TClaims>(
  ctx: HttpRouteContext,
  request: Request,
  route: BuyerStorefrontRoute,
  verify: (
    token: string,
    context: BuyerStorefrontContext,
  ) => TokenVerification<TClaims>,
): BuyerAccess<TClaims> {
  const context = ctx.authority.readBuyerStorefrontContext(
    route.merchantId,
    route.storefrontId,
  );
  if (context === undefined) {
    return {
      ok: false,
      response: jsonResponse(404, { message: "Storefront not found" }),
    };
  }
  const token = bearerToken(request);
  const verification =
    token === undefined ? { ok: false as const } : verify(token, context);
  return verification.ok
    ? { ok: true, context, claims: verification.claims }
    : { ok: false, response: jsonResponse(401, { message: "Unauthorized" }) };
}

function sessionScope(
  route: BuyerStorefrontRoute,
  context: BuyerStorefrontContext,
): Readonly<{
  merchantId: string;
  storefrontId: string;
  storefrontRevision: number;
}> {
  return {
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    storefrontRevision: context.storefront.revision,
  };
}
