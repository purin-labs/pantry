import { isInvoiceRegistrationNumber } from "@purin-labs/control-api";

import {
  printCounterSaleReceipt,
  readCounterReceiptSettings,
  readCounterSaleReceipt,
  writeCounterReceiptSettings,
} from "../../commerce/counter-printing";
import { isTimeZone } from "../../commerce/counter-receipt";
import type { Env } from "../../env";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, type JsonRecord } from "../http";
import {
  beginMutation,
  beginRead,
  decode,
  failureResponse,
  finishMutation,
  match,
} from "./counter-sale-support";

/**
 * The receipt routes of a café counter (Plan 90 Phase 5): the printer and
 * tasks of one sale, a print on the bound printer, and the receipt settings.
 * The drawer has no route: it opens only with a cash sale or a cash refund.
 */

export type CounterReceiptControlRoute =
  | Readonly<{
      kind: "saleReceipt" | "saleReceiptPrint";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{ kind: "receiptSettings"; organisationIdRaw: string }>;

const SETTINGS_PATH = "commerce/counter-receipt-settings";

export function matchCounterReceiptControlRoute(
  pathname: string,
): CounterReceiptControlRoute | null {
  const sale = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/(receipt|receipt-print)$/u,
  );
  if (sale !== null)
    return {
      kind: sale[2] === "receipt" ? "saleReceipt" : "saleReceiptPrint",
      organisationIdRaw: decode(sale[0]),
      checkoutIdRaw: decode(sale[1]),
    };
  const settings = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-receipt-settings$/u,
  );
  return settings === null
    ? null
    : { kind: "receiptSettings", organisationIdRaw: decode(settings[0]) };
}

export function handleCounterReceiptControlRoute(
  request: Request,
  env: Env,
  route: CounterReceiptControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "saleReceipt":
      return handleSaleReceiptRead(request, env, route);
    case "saleReceiptPrint":
      return handleSaleReceiptPrint(request, env, route);
    case "receiptSettings":
      return request.method === "PUT"
        ? handleReceiptSettingsWrite(request, env, route.organisationIdRaw)
        : handleReceiptSettingsRead(request, env, route.organisationIdRaw);
  }
}

async function handleSaleReceiptRead(
  request: Request,
  env: Env,
  route: Readonly<{ organisationIdRaw: string; checkoutIdRaw: string }>,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const deps = await beginRead(
    request,
    env,
    route.organisationIdRaw,
    "operator",
  );
  if (deps instanceof Response) return deps;
  const result = await readCounterSaleReceipt(deps, route.checkoutIdRaw);
  return result.ok
    ? controlJson(result.value)
    : failureResponse(result.failure);
}

async function handleSaleReceiptPrint(
  request: Request,
  env: Env,
  route: Readonly<{ organisationIdRaw: string; checkoutIdRaw: string }>,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.receipt_print",
    "operator",
  );
  if (started instanceof Response) return started;
  const parsed = parsePrintRequest(started.body);
  if (parsed === null)
    return controlError("counter_receipt_request_invalid", 422);
  const printed = await printCounterSaleReceipt(started.deps, {
    checkoutId: route.checkoutIdRaw,
    requestId: `print_${started.boundary.idempotencyKey}`,
    ...parsed,
  });
  if (!printed.ok) return failureResponse(printed.failure);
  return finishMutation(request, started, { ok: true, job: printed.value });
}

async function handleReceiptSettingsRead(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const locationId = new URL(request.url).searchParams.get("locationId");
  if (locationId === null || locationId.length === 0)
    return controlError("counter_receipt_request_invalid", 422);
  const settings = await readCounterReceiptSettings(
    authorized.executionScope.database,
    authorized.organisationId,
    locationId,
  );
  return controlJson({ ok: true, settings });
}

async function handleReceiptSettingsWrite(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const started = await beginMutation(
    request,
    env,
    organisationIdRaw,
    "counter_receipt.settings",
    "admin",
    SETTINGS_PATH,
  );
  if (started instanceof Response) return started;
  const { pantryLocationId, invoiceRegistrationNumber } = started.body;
  if (
    typeof pantryLocationId !== "string" ||
    pantryLocationId.length === 0 ||
    pantryLocationId.length > 255 ||
    (invoiceRegistrationNumber !== null &&
      !isInvoiceRegistrationNumber(invoiceRegistrationNumber))
  )
    return controlError("counter_receipt_request_invalid", 422);
  const settings = await writeCounterReceiptSettings(
    started.authorized.executionScope.database,
    {
      organisationId: started.authorized.organisationId,
      settings: { pantryLocationId, invoiceRegistrationNumber },
      userId: started.identity.userId,
      now: started.now,
    },
  );
  return finishMutation(request, started, { ok: true, settings });
}

function parsePrintRequest(body: JsonRecord): Readonly<{
  timeZone: string | null;
  copy: "original" | "reprint";
}> | null {
  const { timeZone, copy } = body;
  if (timeZone !== undefined && !isTimeZone(timeZone)) return null;
  if (copy !== undefined && copy !== "original" && copy !== "reprint")
    return null;
  return {
    timeZone: timeZone === undefined ? null : timeZone,
    copy: copy ?? "original",
  };
}
