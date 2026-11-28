import type { Env } from "@purin-labs/kernel/env";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";
import {
  openBillingPaymentPortal,
  startBillingPaymentSetup,
  type BillingSetupError,
} from "../../billing/payment-setup";
import { readBillingView } from "../../billing/view";

/**
 * Settings › Billing (Plan 95 step 6). The owner and an admin read the
 * billing state (`billing.account.read`). Only the owner opens Stripe
 * Checkout or the Stripe Customer Portal (`billing.account.manage`).
 */
export type BillingRoute = Readonly<{
  kind: "billing";
  organisationIdRaw: string;
  operation: "view" | "checkout" | "portal";
}>;

const BILLING_PATH =
  /^\/v1\/control\/organisations\/([^/]+)\/billing(?:\/(checkout|portal))?$/u;

/** A Portal address, which Stripe returns the owner to. */
const RETURN_PATH = /^\/portal\/[A-Za-z0-9/_?=&.-]{0,500}$/u;

export function matchBillingRoute(pathname: string): BillingRoute | null {
  const match = BILLING_PATH.exec(pathname);
  if (match?.[1] === undefined) return null;
  try {
    return {
      kind: "billing",
      organisationIdRaw: decodeURIComponent(match[1]),
      operation:
        match[2] === "checkout" || match[2] === "portal" ? match[2] : "view",
    };
  } catch {
    return null;
  }
}

export async function handleBillingRoute(
  request: Request,
  env: Env,
  route: BillingRoute,
): Promise<Response> {
  if (route.operation === "view") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const authorized = await authorizeOrganisationRequest(
      request,
      env,
      route.organisationIdRaw,
      "admin",
      false,
    );
    if (!authorized.ok) return authorized.response;
    try {
      const view = await readBillingView({
        env,
        scope: authorized.executionScope,
        now: Date.now(),
      });
      return view.ok
        ? controlJson({ ok: true, value: view.value })
        : controlError(view.error.code, 409);
    } catch {
      return controlError("billing_unavailable", 503);
    }
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  // The role check hides the route from a member who is not the owner.
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "owner",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readBoundedJsonRecord(request, 4_096);
  const returnPath = body?.returnPath;
  if (typeof returnPath !== "string" || !RETURN_PATH.test(returnPath))
    return controlError("billing_request_invalid", 422);
  const origin = env.PANTRY_PUBLIC_ORIGIN.replace(/\/$/u, "");
  if (!origin.startsWith("https://"))
    return controlError("public_origin_missing", 503);
  const input = {
    env,
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    returnUrl: `${origin}${returnPath}`,
    now: Date.now(),
  };
  try {
    const opened =
      route.operation === "checkout"
        ? await startBillingPaymentSetup(input)
        : await openBillingPaymentPortal(input);
    return opened.ok
      ? controlJson({ ok: true, url: opened.value.url })
      : controlError(opened.error.code, setupErrorStatus(opened.error));
  } catch {
    return controlError("billing_unavailable", 503);
  }
}

function setupErrorStatus(error: BillingSetupError): number {
  switch (error.code) {
    case "billing_organisation_not_found":
      return 404;
    case "billing_closed":
    case "billing_payment_already_set_up":
    case "billing_account_missing":
      return 409;
    case "billing_provider_refused":
      return 502;
    case "billing_provider_unavailable":
      return 503;
  }
}
