import type { FailedPaymentsDay } from "@purin-labs/control-api";

import type { Env } from "../../env";
import { resolveMerchantControlContext } from "../commerce-merchant";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import { isPaymentWindow } from "../../commerce/payments-read";

/**
 * The shop's failed payments of a window, with the retries that followed them.
 * Commerce holds the attempts and joins them; this route adds only who may
 * read. Staff who work the order queue may read it, and a viewer may not.
 */
export type FailedPaymentsControlRoute = Readonly<{
  kind: "failedPayments";
  organisationIdRaw: string;
}>;

/** The window that the query names, or null when it is not a valid one. */
export function readPaymentWindow(
  query: URLSearchParams,
): Readonly<{ from: number; to: number }> | null {
  const from = Number(query.get("from"));
  const to = Number(query.get("to"));
  return isPaymentWindow(from, to) ? { from, to } : null;
}

export function matchFailedPaymentsControlRoute(
  pathname: string,
): FailedPaymentsControlRoute | null {
  const route =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/failed-payments$/u.exec(
      pathname,
    );
  return route === null
    ? null
    : { kind: "failedPayments", organisationIdRaw: route[1] ?? "" };
}

export async function handleFailedPaymentsControlRoute(
  request: Request,
  env: Env,
  route: FailedPaymentsControlRoute,
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
  if (window === null)
    return controlError("failed_payments_window_invalid", 422);
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const failed = await context.client.readFailedPayments(context.merchantId, {
    start: new Date(window.from).toISOString(),
    end: new Date(window.to).toISOString(),
  });
  if (!failed.ok) return controlError("underclerk_unavailable", 503);
  const day: FailedPaymentsDay = {
    truncated: failed.value.truncated,
    steps: failed.value.steps,
  };
  return controlJson({ ok: true, ...day });
}
