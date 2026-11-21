import { parseCreateBuyerSessionCommand } from "@purin-labs/commerce-client";
import type { BuyerRoute } from "../../http-routes.ts";
import { errorMessage } from "@purin-labs/std";
import type { HttpRouteContext } from "../context.ts";
import { readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import {
  buyerCustomerRoute,
  identifyBuyerAccount,
  requestCustomerSignInRoute,
  verifyCustomerSignInRoute,
} from "./buyer-account.ts";
import {
  buyerCartRoute,
  validateBuyerShippingAddressRoute,
} from "./buyer-cart.ts";
import {
  buyerCatalogRoute,
  buyerCollectionsRoute,
  storefrontMedia,
} from "./buyer-catalog.ts";
import {
  buyerStoredValueRoute,
  createBuyerCheckoutRoute,
  createBuyerPaymentSessionRoute,
  readBuyerCheckoutRoute,
  reconcileBuyerPaymentRoute,
  refreshBuyerCheckoutRoute,
} from "./buyer-checkout.ts";
import {
  openBuyerOrderBalanceRoute,
  openDraftInvoiceRoute,
  readBuyerOrderRoute,
  requestBuyerReturnRoute,
} from "./buyer-orders.ts";
import type { Variant } from "@purin-labs/type-utils";

async function createBuyerSessionRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "create_buyer_session">,
): Promise<Response> {
  const context = ctx.authority.readBuyerStorefrontContext(
    route.merchantId,
    route.storefrontId,
  );
  if (context === undefined)
    return jsonResponse(404, { message: "Storefront not found" });
  const activeCheckoutProfile = ctx.authority.readActiveCheckoutProfile(
    route.merchantId,
    route.storefrontId,
  );
  if (activeCheckoutProfile === undefined) {
    return jsonResponse(409, {
      message: "Storefront checkout profile is not active",
    });
  }
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseCreateBuyerSessionCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  if (
    command.buyer.kind === "identified_customer" &&
    activeCheckoutProfile.profile.configuration.buyerPolicy.kind !==
      "guest_or_account"
  ) {
    return jsonResponse(409, {
      message: "Customer accounts are disabled for this checkout",
    });
  }
  const buyer =
    command.buyer.kind === "guest"
      ? { kind: "guest" as const }
      : await identifyBuyerAccount(ctx.buyerAccounts, {
          organisationId: context.organisationId,
          merchantId: route.merchantId,
          storefrontId: route.storefrontId,
          customerAccessToken: command.buyer.customerAccessToken,
        });
  if (buyer.kind === "unavailable") {
    return jsonResponse(401, {
      message: "Customer account is unavailable",
    });
  }
  const issued = ctx.buyerSessions.issue({
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    storefrontRevision: context.storefront.revision,
    checkoutProfile: {
      checkoutProfileId: activeCheckoutProfile.profile.checkoutProfileId,
      revision: activeCheckoutProfile.profile.revision,
    },
    buyer,
  });
  return jsonResponse(200, {
    schemaVersion: "commerce.buyer-session.v4",
    token: issued.token,
    expiresAt: issued.claims.expiresAt,
    storefrontRevision: issued.claims.storefrontRevision,
    checkoutProfile: issued.claims.checkoutProfile,
    checkoutProfileConfiguration: activeCheckoutProfile.profile.configuration,
    buyer: { kind: issued.claims.buyer.kind },
  });
}

/** Storefront buyer routes, which need no service token. */
export async function handleBuyerRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: BuyerRoute,
): Promise<Response> {
  switch (route.kind) {
    case "create_buyer_session":
      return createBuyerSessionRoute(ctx, request, route);
    case "read_buyer_catalog":
    case "search_buyer_catalog":
      return buyerCatalogRoute(ctx, request, route);
    case "read_storefront_media":
      return storefrontMedia(ctx, request, route);
    case "create_buyer_cart":
    case "read_buyer_cart":
    case "replace_buyer_cart":
      return buyerCartRoute(ctx, request, route);
    case "validate_buyer_shipping_address":
      return validateBuyerShippingAddressRoute(ctx, request, route);
    case "create_buyer_checkout":
      return createBuyerCheckoutRoute(ctx, request, route);
    case "read_buyer_checkout":
      return readBuyerCheckoutRoute(ctx, request, route);
    case "create_buyer_payment_session":
      return createBuyerPaymentSessionRoute(ctx, request, route);
    case "reconcile_buyer_payment":
      return reconcileBuyerPaymentRoute(ctx, request, route);
    case "refresh_buyer_checkout":
      return refreshBuyerCheckoutRoute(ctx, request, route);
    case "open_draft_invoice":
      return openDraftInvoiceRoute(ctx, request, route);
    case "request_buyer_return":
      return requestBuyerReturnRoute(ctx, request, route);
    case "list_buyer_collections":
    case "read_buyer_collection":
      return buyerCollectionsRoute(ctx, request, route);
    case "request_customer_sign_in":
      return requestCustomerSignInRoute(ctx, request, route);
    case "verify_customer_sign_in":
      return verifyCustomerSignInRoute(ctx, request, route);
    case "read_buyer_customer":
    case "save_customer_address":
      return buyerCustomerRoute(ctx, request, route);
    case "open_buyer_order_balance":
      return openBuyerOrderBalanceRoute(ctx, request, route);
    case "read_gift_card_balance":
    case "place_buyer_stored_value_checkout":
      return buyerStoredValueRoute(ctx, request, route);
    case "read_buyer_order":
      return readBuyerOrderRoute(ctx, request, route);
  }
}
