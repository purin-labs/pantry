import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { isRecord } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import {
  hasMerchantId,
  hasOrderId,
  hasShipmentId,
  readJsonBody,
} from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@seams/type-utils";

export async function listInvoicesRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_invoices">,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "underclerk.company-invoices.v1",
    invoices: ctx.authority.listInvoices(route.merchantId),
  });
}

export async function invoiceCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "place_draft_order_on_terms" | "record_invoice_payment">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind === "place_draft_order_on_terms"
      ? body.value.draftOrderId !== route.draftOrderId
      : body.value.invoiceId !== route.invoiceId)
  )
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  return jsonResponse(
    200,
    route.kind === "place_draft_order_on_terms"
      ? ctx.authority.placeDraftOrderOnTerms(body.value)
      : ctx.authority.recordInvoicePayment(body.value),
  );
}

export async function readOrderChangesRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_order_changes">,
): Promise<Response> {
  const changes = ctx.authority.readOrderChanges(
    route.merchantId,
    route.orderId,
  );
  return changes === undefined
    ? jsonResponse(404, { message: "Order not found" })
    : jsonResponse(200, changes);
}

export async function orderEditRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "edit_order" | "record_order_manual_payment" | "exchange_order_lines">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    body.value.orderId !== route.orderId
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "edit_order"
      ? ctx.authority.editOrder(body.value)
      : route.kind === "record_order_manual_payment"
        ? ctx.authority.recordOrderManualPayment(body.value)
        : ctx.authority.exchangeOrderLines(body.value),
  );
}

export async function listOrderReturnsRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_order_returns">,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "underclerk.returns.v1",
    returns: ctx.authority.listOrderReturns(route.merchantId, route.orderId),
  });
}

export async function returnCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, | "request_return"
        | "authorize_return"
        | "receive_return"
        | "close_return">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind === "request_return"
      ? body.value.orderId !== route.orderId
      : body.value.returnId !== route.returnId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "request_return"
      ? ctx.authority.requestReturn(body.value)
      : route.kind === "authorize_return"
        ? ctx.authority.authorizeReturn(body.value)
        : route.kind === "receive_return"
          ? ctx.authority.receiveReturn(body.value)
          : ctx.authority.closeReturn(body.value),
  );
}

export async function readDraftOrderRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_draft_order">,
): Promise<Response> {
  const view = ctx.authority.readDraftOrderView(
    route.merchantId,
    route.draftOrderId,
  );
  return view === undefined
    ? jsonResponse(404, { message: "Draft order not found" })
    : jsonResponse(200, view);
}

export async function refundOrderTendersRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "refund_order_tenders">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !hasOrderId(body.value, route.orderId)
  )
    return jsonResponse(400, {
      message: "Merchant and order path and command must match",
    });
  return jsonResponse(200, await ctx.authority.refundOrderTenders(body.value));
}

export async function draftOrderCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, | "create_draft_order"
        | "update_draft_order"
        | "cancel_draft_order"
        | "mark_draft_order_paid"
        | "send_draft_invoice">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind !== "create_draft_order" &&
      body.value.draftOrderId !== route.draftOrderId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  if (route.kind === "create_draft_order")
    return jsonResponse(200, ctx.authority.createDraftOrder(body.value));
  if (route.kind === "update_draft_order")
    return jsonResponse(200, ctx.authority.updateDraftOrder(body.value));
  if (route.kind === "cancel_draft_order")
    return jsonResponse(200, ctx.authority.cancelDraftOrder(body.value));
  if (route.kind === "mark_draft_order_paid")
    return jsonResponse(200, ctx.authority.markDraftOrderPaid(body.value));
  const mutation = ctx.authority.sendDraftInvoice(body.value);
  const draft =
    mutation.outcome === "rejected"
      ? undefined
      : ctx.authority.readDraftOrderView(route.merchantId, route.draftOrderId)
          ?.draftOrder;
  const invoice =
    draft === undefined ||
    draft.lifecycle.state !== "invoiced" ||
    mutation.outcome === "rejected" ||
    mutation.receipt.resource.revision !== draft.revision
      ? null
      : ctx.buyerSessions.issueDraftInvoice({
          merchantId: route.merchantId,
          storefrontId: draft.storefrontId,
          draftOrderId: draft.id,
          draftRevision: draft.lifecycle.invoicedRevision,
          expiresAt: draft.lifecycle.expiresAt,
        });
  return jsonResponse(200, {
    schemaVersion: "underclerk.draft-invoice.v1",
    mutation,
    invoice:
      invoice === null
        ? null
        : { token: invoice.token, expiresAt: invoice.claims.expiresAt },
  });
}

export async function quoteShipmentLabelRateRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "quote_shipment_label_rate">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !hasShipmentId(body.value, route.shipmentId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  const result = ctx.authority.quoteShipmentLabelRate(body.value);
  return result.outcome === "rejected"
    ? jsonResponse(409, result)
    : jsonResponse(200, result);
}
