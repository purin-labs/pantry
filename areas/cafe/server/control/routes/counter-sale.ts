import {
  isCounterRegisterPaymentMethod,
  type CounterRegisterPaymentMethod,
} from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";

import {
  cancelCounterSaleCollection,
  collectCounterSalePayment,
  loadCounterRegisterSnapshot,
  openCounterSale,
  readCounterSaleView,
  reconcileCounterSale,
  recordCounterSaleHandoffResult,
  type CounterSaleHandoffResult,
  type CounterSaleAfterSaleAction,
} from "../../counter-register";
import {
  recordCounterCashAndOpenDrawer,
  runCounterAfterSaleWithDrawer,
} from "../../counter-printing";
import type { Env } from "@purin-labs/kernel/env";
import { controlError, controlJson, type JsonRecord } from "@purin-labs/control/worker/http";
import {
  beginMutation,
  beginRead,
  decode,
  failureResponse,
  finishMutation,
  match,
} from "./counter-sale-support";
import {
  handleCounterReceiptControlRoute,
  matchCounterReceiptControlRoute,
  type CounterReceiptControlRoute,
} from "./counter-receipt";

export type CounterSaleControlRoute =
  | Readonly<{ kind: "counterRegister"; organisationIdRaw: string }>
  | Readonly<{ kind: "counterSales"; organisationIdRaw: string }>
  | Readonly<{
      kind: "counterSale";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind: "counterSaleCash";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind: "counterSaleCollection";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind: "counterSaleCancel";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind: "counterSaleReconciliation";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind: "counterSaleHandoffResult";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind:
        | "counterSalePickupReady"
        | "counterSaleHandover"
        | "counterSaleRefund"
        | "counterSaleManualCashRefund";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{ kind: "counterReceipt"; receipt: CounterReceiptControlRoute }>;

export function matchCounterSaleControlRoute(
  pathname: string,
): CounterSaleControlRoute | null {
  const receipt = matchCounterReceiptControlRoute(pathname);
  if (receipt !== null) return { kind: "counterReceipt", receipt };
  const register = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-register$/u,
  );
  if (register !== null) {
    return { kind: "counterRegister", organisationIdRaw: decode(register[0]) };
  }
  const afterSale = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/(ready|handover|refund|manual-cash-refund)$/u,
  );
  if (afterSale !== null) {
    return {
      kind: afterSaleKind(afterSale[2] ?? ""),
      organisationIdRaw: decode(afterSale[0]),
      checkoutIdRaw: decode(afterSale[1]),
    };
  }
  const subRoute = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/(cash|collection|cancel|reconciliation|handoff-result)$/u,
  );
  if (subRoute !== null) {
    const sub = subRoute[2];
    const kind =
      sub === "cash"
        ? "counterSaleCash"
        : sub === "collection"
          ? "counterSaleCollection"
          : sub === "cancel"
            ? "counterSaleCancel"
            : sub === "handoff-result"
              ? "counterSaleHandoffResult"
              : "counterSaleReconciliation";
    return {
      kind,
      organisationIdRaw: decode(subRoute[0]),
      checkoutIdRaw: decode(subRoute[1]),
    };
  }
  const sale = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)$/u,
  );
  if (sale !== null) {
    return {
      kind: "counterSale",
      organisationIdRaw: decode(sale[0]),
      checkoutIdRaw: decode(sale[1]),
    };
  }
  const sales = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales$/u,
  );
  return sales === null
    ? null
    : { kind: "counterSales", organisationIdRaw: decode(sales[0]) };
}

export function handleCounterSaleControlRoute(
  request: Request,
  env: Env,
  route: CounterSaleControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "counterRegister":
      return handleCounterRegisterRead(request, env, route.organisationIdRaw);
    case "counterSales":
      return handleCounterSaleOpen(request, env, route.organisationIdRaw);
    case "counterSale":
      return handleCounterSaleRead(request, env, route);
    case "counterSaleCash":
      return handleCounterSaleCash(request, env, route);
    case "counterSaleCollection":
      return handleCounterSaleCollection(request, env, route);
    case "counterSaleCancel":
      return handleCounterSaleCancel(request, env, route);
    case "counterSaleReconciliation":
      return handleCounterSaleReconciliation(request, env, route);
    case "counterSaleHandoffResult":
      return handleCounterSaleHandoffResult(request, env, route);
    case "counterSalePickupReady":
    case "counterSaleHandover":
    case "counterSaleRefund":
    case "counterSaleManualCashRefund":
      return handleCounterSaleAfterSale(request, env, route);
    case "counterReceipt":
      return handleCounterReceiptControlRoute(request, env, route.receipt);
  }
}

async function handleCounterRegisterRead(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const deps = await beginRead(request, env, organisationIdRaw, "operator");
  if (deps instanceof Response) return deps;
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const loaded = await loadCounterRegisterSnapshot(deps, locationId);
  return loaded.ok
    ? controlJson({ ok: true, register: loaded.value })
    : failureResponse(loaded.failure);
}

async function handleCounterSaleRead(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSale">,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const deps = await beginRead(request, env, route.organisationIdRaw, "viewer");
  if (deps instanceof Response) return deps;
  const result = await readCounterSaleView(deps, route.checkoutIdRaw);
  return result.ok
    ? controlJson({ ok: true, counterSale: result.value })
    : failureResponse(result.failure);
}

async function handleCounterSaleOpen(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    organisationIdRaw,
    "counter_sale.open",
    "operator",
  );
  if (started instanceof Response) return started;
  const parsed = parseSaleRequest(started.body);
  if (parsed === null) return controlError("counter_sale_request_invalid", 422);
  const opened = await openCounterSale(started.deps, {
    ...parsed,
    operatorIdentity: started.identity.userId,
    idempotencyKey: started.boundary.idempotencyKey,
  });
  if (!opened.ok) return failureResponse(opened.failure);
  return finishMutation(request, started, { ok: true, counterSale: opened.value });
}

async function handleCounterSaleCash(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleCash">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.cash",
    "operator",
  );
  if (started instanceof Response) return started;
  const parsed = parseCashRequest(started.body);
  if (parsed === null) return controlError("counter_sale_request_invalid", 422);
  const settled = await recordCounterCashAndOpenDrawer(started.deps, {
    checkoutId: route.checkoutIdRaw,
    ...parsed,
    idempotencyKey: started.boundary.idempotencyKey,
  });
  if (!settled.ok) return failureResponse(settled.failure);
  return finishMutation(request, started, { ok: true, ...settled.value });
}

async function handleCounterSaleCollection(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleCollection">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.collect",
    "operator",
  );
  if (started instanceof Response) return started;
  const parsed = parseCollectionRequest(started.body);
  if (parsed === null) return controlError("counter_sale_request_invalid", 422);
  const collected = await collectCounterSalePayment(started.deps, {
    checkoutId: route.checkoutIdRaw,
    ...parsed,
    idempotencyKey: started.boundary.idempotencyKey,
  });
  if (!collected.ok) return failureResponse(collected.failure);
  return finishMutation(request, started, { ok: true, collection: collected.value });
}

async function handleCounterSaleCancel(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleCancel">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.cancel",
    "operator",
  );
  if (started instanceof Response) return started;
  const cancelled = await cancelCounterSaleCollection(started.deps, {
    checkoutId: route.checkoutIdRaw,
    idempotencyKey: started.boundary.idempotencyKey,
  });
  if (!cancelled.ok) return failureResponse(cancelled.failure);
  return finishMutation(request, started, { ok: true, counterSale: cancelled.value });
}

async function handleCounterSaleReconciliation(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleReconciliation">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.reconcile",
    "operator",
  );
  if (started instanceof Response) return started;
  const reconciled = await reconcileCounterSale(started.deps, {
    checkoutId: route.checkoutIdRaw,
    idempotencyKey: started.boundary.idempotencyKey,
  });
  if (!reconciled.ok) return failureResponse(reconciled.failure);
  return finishMutation(request, started, { ok: true, counterSale: reconciled.value });
}

/**
 * The Register's callback page sends the Square Point of Sale app's answer
 * here (Plan 90 Phase 3B). Commerce reads the payment from Square before it
 * places the order, so the answer is only a hint.
 */
async function handleCounterSaleHandoffResult(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleHandoffResult">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.handoff_result",
    "operator",
  );
  if (started instanceof Response) return started;
  const result = parseHandoffResultRequest(started.body);
  if (result === null) return controlError("counter_sale_request_invalid", 422);
  const recorded = await recordCounterSaleHandoffResult(started.deps, {
    checkoutId: route.checkoutIdRaw,
    result,
  });
  if (!recorded.ok) return failureResponse(recorded.failure);
  return finishMutation(request, started, { ok: true, counterSale: recorded.value });
}

async function handleCounterSaleAfterSale(
  request: Request,
  env: Env,
  route: Variant<
    CounterSaleControlRoute,
    | "counterSalePickupReady"
    | "counterSaleHandover"
    | "counterSaleRefund"
    | "counterSaleManualCashRefund"
  >,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const action = afterSaleAction(route.kind);
  const minRole = route.kind === "counterSaleManualCashRefund" ? "admin" : "operator";
  const started = await beginMutation(
    request,
    env,
    route.organisationIdRaw,
    `counter_sale.${action}`,
    minRole,
  );
  if (started instanceof Response) return started;
  const reason =
    typeof started.body.reason === "string" && started.body.reason.trim().length > 0
      ? started.body.reason.trim()
      : undefined;
  const mutated = await runCounterAfterSaleWithDrawer(started.deps, {
    checkoutId: route.checkoutIdRaw,
    action,
    idempotencyKey: started.boundary.idempotencyKey,
    reason,
  });
  if (!mutated.ok) return failureResponse(mutated.failure);
  return finishMutation(request, started, { ok: true, ...mutated.value });
}

type OpenSaleLines = Parameters<typeof openCounterSale>[1]["lines"];

function parseSaleRequest(body: JsonRecord): Readonly<{
  pantryLocationId: string;
  checkoutId: string;
  lines: OpenSaleLines;
  tenderMode?: "terminal" | "cash";
}> | null {
  const { pantryLocationId, checkoutId, lines, tenderMode } = body;
  if (typeof pantryLocationId !== "string" || pantryLocationId.length === 0) return null;
  if (typeof checkoutId !== "string" || checkoutId.length === 0) return null;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (
    tenderMode !== undefined &&
    tenderMode !== "terminal" &&
    tenderMode !== "cash"
  ) {
    return null;
  }
  return {
    pantryLocationId,
    checkoutId,
    lines: lines as OpenSaleLines,
    ...(tenderMode === undefined ? {} : { tenderMode }),
  };
}

function parseMoney(raw: unknown): Readonly<{ amountMinor: number; currency: string }> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const money = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(money.amountMinor) || Number(money.amountMinor) <= 0) return null;
  if (typeof money.currency !== "string" || !/^[A-Za-z]{3}$/u.test(money.currency)) return null;
  return { amountMinor: Number(money.amountMinor), currency: money.currency };
}

function parseCashRequest(body: JsonRecord): Readonly<{
  checkoutRevision: number;
  quoteDigest: string;
  cashReceived: Readonly<{ amountMinor: number; currency: string }>;
}> | null {
  const { checkoutRevision, quoteDigest, cashReceived } = body;
  if (!Number.isSafeInteger(checkoutRevision) || Number(checkoutRevision) <= 0) return null;
  if (typeof quoteDigest !== "string" || !/^quote_[a-f0-9]{64}$/u.test(quoteDigest)) return null;
  const parsedCash = parseMoney(cashReceived);
  if (parsedCash === null) return null;
  return {
    checkoutRevision: Number(checkoutRevision),
    quoteDigest,
    cashReceived: parsedCash,
  };
}

function parseCollectionRequest(body: JsonRecord): Readonly<{
  pantryLocationId: string;
  checkoutRevision: number;
  quoteDigest: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
  paymentMethod?: CounterRegisterPaymentMethod;
}> | null {
  const { pantryLocationId, checkoutRevision, quoteDigest, amount, paymentMethod } = body;
  if (typeof pantryLocationId !== "string" || pantryLocationId.length === 0) return null;
  if (!Number.isSafeInteger(checkoutRevision) || Number(checkoutRevision) <= 0) return null;
  if (typeof quoteDigest !== "string" || !/^quote_[a-f0-9]{64}$/u.test(quoteDigest)) return null;
  const parsedAmount = parseMoney(amount);
  if (parsedAmount === null) return null;
  if (paymentMethod !== undefined && !isCounterRegisterPaymentMethod(paymentMethod)) return null;
  return {
    pantryLocationId,
    checkoutRevision: Number(checkoutRevision),
    quoteDigest,
    amount: parsedAmount,
    ...(paymentMethod === undefined ? {} : { paymentMethod }),
  };
}

function parseHandoffResultRequest(
  body: JsonRecord,
): CounterSaleHandoffResult | null {
  const keys = Object.keys(body).sort().join(",");
  if (
    keys !==
    "clientTransactionId,errorCode,handoffReference,paymentAttemptId,status,transactionId"
  )
    return null;
  const text = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 255;
  const nullableText = (value: unknown): value is string | null =>
    value === null || text(value);
  const { paymentAttemptId, handoffReference, status, transactionId, clientTransactionId, errorCode } = body;
  if (
    !text(paymentAttemptId) ||
    !text(handoffReference) ||
    (status !== "ok" && status !== "error") ||
    !nullableText(transactionId) ||
    !nullableText(clientTransactionId) ||
    !nullableText(errorCode)
  )
    return null;
  return { paymentAttemptId, handoffReference, status, transactionId, clientTransactionId, errorCode };
}

function afterSaleKind(
  value: string,
):
  | "counterSalePickupReady"
  | "counterSaleHandover"
  | "counterSaleRefund"
  | "counterSaleManualCashRefund" {
  switch (value) {
    case "ready":
      return "counterSalePickupReady";
    case "handover":
      return "counterSaleHandover";
    case "refund":
      return "counterSaleRefund";
    case "manual-cash-refund":
      return "counterSaleManualCashRefund";
    default:
      throw new Error("Invalid counter-sale after-sale route");
  }
}

function afterSaleAction(
  kind:
    | "counterSalePickupReady"
    | "counterSaleHandover"
    | "counterSaleRefund"
    | "counterSaleManualCashRefund",
): CounterSaleAfterSaleAction {
  switch (kind) {
    case "counterSalePickupReady":
      return "ready";
    case "counterSaleHandover":
      return "handover";
    case "counterSaleRefund":
      return "refund";
    case "counterSaleManualCashRefund":
      return "manual_cash_refund";
  }
}
