import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { isRecord } from "@purin-labs/std";
import type { HttpRouteContext } from "../context.ts";
import { hasMerchantId, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

export async function customerCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "create_customer" | "update_customer" | "erase_customer">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind !== "create_customer" &&
      body.value.customerId !== route.customerId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "create_customer"
      ? ctx.authority.createCustomer(body.value)
      : route.kind === "update_customer"
        ? ctx.authority.updateCustomer(body.value)
        : ctx.authority.eraseCustomer(body.value),
  );
}

export async function readCustomerRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "read_customer">,
): Promise<Response> {
  const customer = ctx.authority.readCustomer(
    route.merchantId,
    route.customerId,
  );
  return customer === undefined
    ? jsonResponse(404, { message: "Customer not found" })
    : jsonResponse(200, customer);
}

export async function exportCustomerRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "export_customer">,
): Promise<Response> {
  const exported = ctx.authority.exportCustomer(
    route.merchantId,
    route.customerId,
  );
  return exported === undefined
    ? jsonResponse(404, { message: "Customer not found" })
    : jsonResponse(200, exported);
}

export async function companyCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "create_company" | "update_company">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind === "update_company" &&
      body.value.companyId !== route.companyId)
  )
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  return jsonResponse(
    200,
    route.kind === "create_company"
      ? ctx.authority.createCompany(body.value)
      : ctx.authority.updateCompany(body.value),
  );
}

export async function marketCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "create_market" | "update_market">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    (route.kind === "update_market" && body.value.marketId !== route.marketId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(
    200,
    route.kind === "create_market"
      ? ctx.authority.createMarket(body.value)
      : ctx.authority.updateMarket(body.value),
  );
}

export async function listMarketsRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_markets">,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "commerce.markets.v1",
    markets: ctx.authority.listMarkets(route.merchantId),
  });
}

export async function listCompaniesRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_companies">,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "commerce.companies.v1",
    companies: ctx.authority.listCompanies(route.merchantId),
  });
}

export async function listNotificationsRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_notifications">,
): Promise<Response> {
  return jsonResponse(200, {
    schemaVersion: "commerce.notifications.v1",
    notifications: ctx.authority.listNotifications(route.merchantId),
  });
}
