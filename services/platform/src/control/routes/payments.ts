import type { PaymentsDay } from "@purin-labs/control-api";

import type { Env } from "@purin-labs/kernel/env";
import { resolveMerchantControlContext } from "../../commerce/contract/merchant-control";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import { readPaymentWindow } from "./failed-payments";

/**
 * The shop's payments of a window, paid and declined. Commerce holds the
 * attempts and joins a decline to the tries that followed it; this route adds
 * only who may read. Staff who work the order queue may read it, and a viewer
 * may not.
 */
export type CommercePaymentsControlRoute = Readonly<{
  kind: "commercePayments";
  organisationIdRaw: string;
}>;

export function matchCommercePaymentsControlRoute(
  pathname: string,
): CommercePaymentsControlRoute | null {
  const route =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/payments$/u.exec(
      pathname,
    );
  return route === null
    ? null
    : { kind: "commercePayments", organisationIdRaw: route[1] ?? "" };
}

export async function handleCommercePaymentsControlRoute(
  request: Request,
  env: Env,
  route: CommercePaymentsControlRoute,
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
  const window = readPaymentWindow(new URL(request.url).searchParams);
  if (window === null) return controlError("payments_window_invalid", 422);
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const payments = await context.client.readPayments(context.merchantId, {
    start: new Date(window.from).toISOString(),
    end: new Date(window.to).toISOString(),
  });
  if (!payments.ok) return controlError("commerce_unavailable", 503);
  const day: PaymentsDay = {
    truncated: payments.value.truncated,
    steps: payments.value.steps,
  };
  return controlJson({ ok: true, ...day });
}
