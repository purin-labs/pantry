import type { BankPayoutsWindow } from "@purin-labs/control-api";

import type { Env } from "@purin-labs/kernel/env";
import { resolveMerchantControlContext } from "@purin-labs/area-commerce-contract/server/merchant-control";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import { controlError, controlJson } from "@purin-labs/control/worker/http";

/**
 * The money that Stripe and Square send to the shop's bank. Commerce holds
 * the connections and the record; this route adds only who may read. Staff who
 * may read the failed payments may read it, and a viewer may not.
 */
export type BankPayoutsControlRoute = Readonly<{
  kind: "bankPayouts";
  organisationIdRaw: string;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest local month, in calendar days and with one day to spare. */
const MAX_WINDOW_DAYS = 32;

export function matchBankPayoutsControlRoute(
  pathname: string,
): BankPayoutsControlRoute | null {
  const route =
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/bank-payouts$/u.exec(
      pathname,
    );
  return route === null
    ? null
    : { kind: "bankPayouts", organisationIdRaw: route[1] ?? "" };
}

function dayStart(day: string | null): number | null {
  if (day === null || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) return null;
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(at) ? null : at;
}

export async function handleBankPayoutsControlRoute(
  request: Request,
  env: Env,
  route: BankPayoutsControlRoute,
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
  const start = query.get("from");
  const end = query.get("to");
  const from = dayStart(start);
  const to = dayStart(end);
  if (
    start === null ||
    end === null ||
    from === null ||
    to === null ||
    from >= to ||
    to - from > MAX_WINDOW_DAYS * DAY_MS
  )
    return controlError("bank_payouts_window_invalid", 422);
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const read = await context.client.readBankPayouts(context.merchantId, {
    start,
    end,
  });
  if (!read.ok) return controlError("commerce_unavailable", 503);
  const window: BankPayoutsWindow = {
    sources: read.value.sources,
    truncated: read.value.truncated,
    payouts: read.value.payouts,
  };
  return controlJson({ ok: true, ...window });
}
