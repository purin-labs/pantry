import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import type { SquareResult } from "../../payments/square/square-connection.ts";
import { assertNever } from "@purin-labs/std";
import type { HttpRouteContext } from "../context.ts";
import { readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";
import type { Variant } from "@purin-labs/type-utils";

/** A merchant's Square connection and what it reads (Plan 80 step 4). */
export async function squareConnectionRoute(
  ctx: HttpRouteContext,
  request: Request,
  url: URL,
  route: Variant<
    CommerceRoute,
    | "connect_square"
    | "read_square_connection"
    | "disconnect_square"
    | "list_square_locations"
    | "list_square_devices"
    | "create_square_device_code"
    | "read_square_device_code"
  >,
): Promise<Response> {
  const connections = ctx.squareAccounts?.connections;
  if (connections === undefined)
    return jsonResponse(409, { message: "Square is not configured" });
  const answer = <Value>(result: SquareResult<Value>): Response =>
    result.kind === "ok"
      ? jsonResponse(200, result.value)
      : jsonResponse(result.status, { message: result.message });
  switch (route.kind) {
    case "connect_square": {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      return answer(await connections.connect(route.merchantId, body.value));
    }
    case "read_square_connection": {
      const connection = connections.read(route.merchantId);
      return connection === undefined
        ? jsonResponse(404, { message: "Square is not connected" })
        : jsonResponse(200, connection);
    }
    case "disconnect_square": {
      const result = await connections.disconnect(route.merchantId);
      return result.kind === "ok"
        ? jsonResponse(200, { disconnected: true })
        : answer(result);
    }
    case "list_square_locations": {
      const result = await connections.locations(route.merchantId);
      return result.kind === "ok"
        ? jsonResponse(200, { locations: result.value })
        : answer(result);
    }
    case "list_square_devices": {
      const result = await connections.devices(
        route.merchantId,
        url.searchParams.get("locationId"),
      );
      return result.kind === "ok"
        ? jsonResponse(200, { devices: result.value })
        : answer(result);
    }
    case "create_square_device_code": {
      const key = request.headers.get("idempotency-key");
      if (key === null || key.length === 0 || key.length > 128)
        return jsonResponse(400, {
          message: "A device code needs an Idempotency-Key header",
          field: "Idempotency-Key",
        });
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      return answer(
        await connections.createDeviceCode(route.merchantId, body.value, key),
      );
    }
    case "read_square_device_code":
      return answer(
        await connections.deviceCode(route.merchantId, route.deviceCodeId),
      );
    default:
      return assertNever(route, "Unexpected Square route");
  }
}

export async function listPaymentAccountsRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_payment_accounts">,
): Promise<Response> {
  return jsonResponse(200, {
    accounts: [
      ...(ctx.paymentAccounts?.list(route.merchantId) ?? []),
      ...(ctx.squareAccounts?.list(route.merchantId) ?? []),
    ],
  });
}

export async function linkSquareAccountRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "link_square_account">,
): Promise<Response> {
  const accounts = ctx.squareAccounts;
  if (accounts === undefined)
    return jsonResponse(409, { message: "Square is not configured" });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const result = await accounts.link(route.merchantId, body.value);
  if (result.kind !== "ok")
    return jsonResponse(result.status, { message: result.message });
  followLinkedAccount(ctx, route.merchantId, result.value);
  return jsonResponse(200, result.value);
}

export async function stripeAccountRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    Exclude<CommerceRoute, BuyerRoute>,
    "link_stripe_account" | "start_stripe_onboarding"
  >,
): Promise<Response> {
  const accounts = ctx.paymentAccounts;
  if (accounts === undefined)
    return jsonResponse(409, { message: "Stripe is not configured" });
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const result =
    route.kind === "link_stripe_account"
      ? await accounts.link(route.merchantId, body.value)
      : await accounts.startOnboarding(route.merchantId, body.value);
  if (result.kind !== "ok")
    return jsonResponse(result.status, { message: result.message });
  if (route.kind === "link_stripe_account" && "state" in result.value)
    followLinkedAccount(ctx, route.merchantId, result.value);
  return jsonResponse(200, result.value);
}

/** A storefront that cannot charge starts to sell on an account that can. */
function followLinkedAccount(
  ctx: HttpRouteContext,
  merchantId: string,
  account: Readonly<{ paymentProviderBindingId: string; state: string }>,
): void {
  if (account.state === "active")
    ctx.authority.followWorkingPaymentBinding(
      merchantId,
      account.paymentProviderBindingId,
    );
}

export async function settleOnlinePaymentRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "settle_online_payment">,
): Promise<Response> {
  return jsonResponse(
    200,
    await ctx.authority.settleOnlineCheckoutPayment(
      route.merchantId,
      route.paymentAttemptId,
    ),
  );
}

export async function listUnplacedCapturesRoute(
  ctx: HttpRouteContext,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "list_unplaced_captures">,
): Promise<Response> {
  const captures = ctx.authority.listUnplacedCaptures(route.merchantId);
  return captures === undefined
    ? jsonResponse(404, { message: "Merchant not found" })
    : jsonResponse(200, captures);
}

export async function resolveUnplacedCaptureRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<
    Exclude<CommerceRoute, BuyerRoute>,
    "resolve_unplaced_capture"
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const result = ctx.authority.resolveUnplacedCapture(
    route.merchantId,
    route.paymentAttemptId,
    body.value,
  );
  switch (result.kind) {
    case "resolved":
      return jsonResponse(200, result.capture);
    case "invalid":
      return jsonResponse(422, { message: result.message });
    case "not_found":
      return jsonResponse(404, { message: "Unplaced capture not found" });
    case "stale":
      return jsonResponse(409, {
        message: "The capture changed",
        capture: result.capture,
      });
    case "refused":
      return jsonResponse(409, { error: result.refusal });
  }
}

export async function observeStripeDisputeRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Variant<Exclude<CommerceRoute, BuyerRoute>, "observe_stripe_dispute">,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  return jsonResponse(
    200,
    ctx.authority.observeStripeDispute(
      route.merchantId,
      route.paymentAttemptId,
      body.value,
    ),
  );
}
