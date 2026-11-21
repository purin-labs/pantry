import type { OrderTimesWindow } from "@purin-labs/control-api";

import type { Env } from "../../env";
import { resolveMerchantControlContext } from "../../commerce/contract/merchant-control";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";

/**
 * How long the shop's orders of a window took. Commerce holds the orders and
 * their promised times; this route adds only who may read. Staff who work the
 * order queue may read it, and a viewer may not.
 */
export type OrderTimesControlRoute = Readonly<{
  kind: "orderTimes";
  organisationIdRaw: string;
}>;

/** A local month is at most 31 days and one hour. */
const MAX_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

export function matchOrderTimesControlRoute(
  pathname: string,
): OrderTimesControlRoute | null {
  const route =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/order-times$/u.exec(
      pathname,
    );
  return route === null
    ? null
    : { kind: "orderTimes", organisationIdRaw: route[1] ?? "" };
}

export async function handleOrderTimesControlRoute(
  request: Request,
  env: Env,
  route: OrderTimesControlRoute,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "operator",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const query = new URL(request.url).searchParams;
  const from = Number(query.get("from"));
  const to = Number(query.get("to"));
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from >= to ||
    to - from > MAX_WINDOW_MS
  )
    return controlError("order_times_window_invalid", 422);
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const times = await context.client.readOrderTimes(context.merchantId, {
    start: new Date(from).toISOString(),
    end: new Date(to).toISOString(),
  });
  if (!times.ok) return controlError("underclerk_unavailable", 503);
  const window: OrderTimesWindow = {
    truncated: times.value.truncated,
    orders: times.value.orders,
  };
  return controlJson({ ok: true, ...window });
}
