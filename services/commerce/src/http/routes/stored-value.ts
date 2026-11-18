import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { isRecord } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import { hasMerchantId, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";

export async function discountCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "create_discount" | "deactivate_discount" }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind === "deactivate_discount" &&
      body.value.discountId !== route.discountId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "create_discount"
      ? ctx.authority.createDiscount(body.value)
      : ctx.authority.deactivateDiscount(body.value),
  );
}

export async function listDiscountsRoute(
  ctx: HttpRouteContext,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "list_discounts" }
  >,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "underclerk.discounts.v1",
    discounts: ctx.authority.listDiscounts(route.merchantId),
  });
}

export async function storedValueCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    {
      kind:
        | "issue_gift_card"
        | "credit_store_credit"
        | "disable_stored_value_account";
    }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind === "disable_stored_value_account" &&
      body.value.accountId !== route.accountId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "issue_gift_card"
      ? ctx.authority.issueGiftCard(body.value)
      : route.kind === "credit_store_credit"
        ? ctx.authority.creditStoreCredit(body.value)
        : ctx.authority.disableStoredValueAccount(body.value),
  );
}

export async function listStoredValueAccountsRoute(
  ctx: HttpRouteContext,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "list_stored_value_accounts" }
  >,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "underclerk.stored-value-accounts.v1",
    accounts: ctx.authority.listStoredValueAccounts(route.merchantId),
  });
}

export async function readStoredValueLiabilityRoute(
  ctx: HttpRouteContext,
  url: URL,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "read_stored_value_liability" }
  >,
): Promise<Response> {
  const at = url.searchParams.get("at") ?? ctx.authority.currentTime();
  if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at)
    return jsonResponse(400, { message: "at must be an ISO timestamp" });
  return jsonResponse(
    200,
    ctx.authority.readStoredValueLiability(route.merchantId, at),
  );
}
