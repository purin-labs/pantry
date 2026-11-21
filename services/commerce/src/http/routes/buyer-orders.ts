import { createHash } from "node:crypto";
import {
  parseOpenBuyerOrderBalanceCommand,
  parseRequestBuyerReturnCommand,
} from "@purin-labs/commerce-client";
import type { BuyerRoute } from "../../http-routes.ts";
import { errorMessage } from "@purin-labs/std";
import {
  verifyDraftInvoiceAccess,
  verifyOrderRecoveryAccess,
} from "../buyer-access.ts";
import type { HttpRouteContext } from "../context.ts";
import { bearerToken, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

export async function openDraftInvoiceRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "open_draft_invoice">,
): Promise<Response> {
  const invoice = verifyDraftInvoiceAccess(ctx, request, route);
  if (!invoice.ok) return invoice.response;
  const { context } = invoice;
  const draft = ctx.authority.readInvoicedDraft(
    route.merchantId,
    route.storefrontId,
    route.draftOrderId,
    invoice.claims.draftRevision,
  );
  if (draft === undefined)
    return jsonResponse(410, { message: "Invoice is no longer open" });
  const activeCheckoutProfile = ctx.authority.readActiveCheckoutProfile(
    route.merchantId,
    route.storefrontId,
  );
  if (activeCheckoutProfile === undefined)
    return jsonResponse(409, {
      message: "Storefront checkout profile is not active",
    });
  // One invoice revision is one buyer session, so every opening of the
  // link reaches the same checkout.
  const session = ctx.buyerSessions.issue({
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    storefrontRevision: context.storefront.revision,
    checkoutProfile: {
      checkoutProfileId: activeCheckoutProfile.profile.checkoutProfileId,
      revision: activeCheckoutProfile.profile.revision,
    },
    buyer: { kind: "guest" },
    sessionId: `draft_invoice_${createHash("sha256")
      .update(JSON.stringify([route.merchantId, draft.id, draft.revision]))
      .digest("hex")}`,
  });
  const opened = ctx.authority.openDraftInvoice({
    claims: session.claims,
    draft,
  });
  return opened.kind === "rejected"
    ? jsonResponse(409, { outcome: "rejected", error: opened.error })
    : jsonResponse(200, {
        schemaVersion: "commerce.draft-invoice-checkout.v1",
        session: {
          token: session.token,
          expiresAt: session.claims.expiresAt,
        },
        checkout: opened.checkout,
      });
}

export async function requestBuyerReturnRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "request_buyer_return">,
): Promise<Response> {
  const recovery = verifyOrderRecoveryAccess(ctx, request, route);
  if (!recovery.ok) return recovery.response;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  let command;
  try {
    command = parseRequestBuyerReturnCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        route.merchantId,
        recovery.claims.orderId,
        command.idempotencyKey,
      ]),
    )
    .digest("hex");
  const returnId = `return_${identity}`;
  const result = ctx.authority.requestReturn(
    {
      schemaVersion: "commerce.request-return.v1",
      merchantId: route.merchantId,
      idempotencyKey: `buyer_return_${identity}`,
      requestedAt: ctx.authority.currentTime(),
      returnId,
      orderId: recovery.claims.orderId,
      lines: command.lines,
    },
    "buyer",
  );
  if (result.outcome === "rejected")
    return jsonResponse(409, {
      outcome: "rejected",
      error: result.error,
    });
  const record = ctx.authority
    .listOrderReturns(route.merchantId, recovery.claims.orderId)
    .find((candidate) => candidate.id === returnId);
  return record === undefined
    ? jsonResponse(500, { message: "Return was not recorded" })
    : jsonResponse(200, record);
}

export async function openBuyerOrderBalanceRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "open_buyer_order_balance">,
): Promise<Response> {
  const recovery = verifyOrderRecoveryAccess(ctx, request, route);
  if (!recovery.ok) return recovery.response;
  const { context } = recovery;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  try {
    parseOpenBuyerOrderBalanceCommand(body.value);
  } catch (error) {
    return jsonResponse(400, { message: errorMessage(error) });
  }
  const order = ctx.authority
    .readSnapshot(route.merchantId)
    ?.resources.orders.find(
      (candidate) => candidate.id === recovery.claims.orderId,
    );
  if (order === undefined)
    return jsonResponse(404, { message: "Order not found" });
  // One order revision is one buyer session, so every opening of the
  // order link reaches the same balance checkout.
  const session = ctx.buyerSessions.issue({
    merchantId: route.merchantId,
    storefrontId: route.storefrontId,
    storefrontRevision: context.storefront.revision,
    checkoutProfile: recovery.claims.checkoutProfile,
    buyer: { kind: "guest" },
    sessionId: `order_balance_${createHash("sha256")
      .update(JSON.stringify([route.merchantId, order.id, order.revision]))
      .digest("hex")}`,
  });
  const opened = ctx.authority.openOrderBalance({
    claims: session.claims,
    orderId: order.id,
  });
  return opened.kind === "rejected"
    ? jsonResponse(409, { outcome: "rejected", error: opened.error })
    : jsonResponse(200, {
        schemaVersion: "commerce.order-balance-checkout.v1",
        session: {
          token: session.token,
          expiresAt: session.claims.expiresAt,
        },
        checkout: opened.checkout,
      });
}

export async function readBuyerOrderRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<BuyerRoute, "read_buyer_order">,
): Promise<Response> {
  const context = ctx.authority.readBuyerStorefrontContext(
    route.merchantId,
    route.storefrontId,
  );
  if (context === undefined)
    return jsonResponse(404, { message: "Storefront not found" });
  const token = bearerToken(request);
  const sessionVerification =
    token === undefined
      ? { ok: false as const }
      : ctx.buyerSessions.verify(token, {
          merchantId: route.merchantId,
          storefrontId: route.storefrontId,
          storefrontRevision: context.storefront.revision,
        });
  const recoveryVerification =
    token === undefined || sessionVerification.ok
      ? { ok: false as const }
      : ctx.buyerSessions.verifyOrderRecovery(token, {
          merchantId: route.merchantId,
          storefrontId: route.storefrontId,
          storefrontRevision: context.storefront.revision,
          checkoutId: route.checkoutId,
        });
  let sessionId: string;
  if (sessionVerification.ok) {
    sessionId = sessionVerification.claims.sessionId;
  } else if (recoveryVerification.ok) {
    sessionId = recoveryVerification.claims.sessionId;
  } else {
    return jsonResponse(401, { message: "Unauthorized" });
  }
  const order = ctx.authority.readBuyerOrder(
    route.merchantId,
    route.storefrontId,
    route.checkoutId,
    sessionId,
  );
  const authorizedOrder =
    recoveryVerification.ok &&
    order?.orderId !== recoveryVerification.claims.orderId
      ? undefined
      : order;
  return authorizedOrder === undefined
    ? jsonResponse(404, { message: "Order not found" })
    : jsonResponse(200, authorizedOrder);
}
