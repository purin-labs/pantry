import {
  isCounterRegisterPaymentMethod,
  type CounterRegisterPaymentMethod,
} from "@purin-labs/control-api";
import type {
  CommerceClientError,
  CommercePickupCheckoutLineV1,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";

import {
  cancelCounterSaleCollection,
  collectCounterSalePayment,
  executeCounterSaleAfterSale,
  loadCounterRegisterSnapshot,
  openCounterSale,
  readCounterSaleView,
  reconcileCounterSale,
  recordCounterSaleCash,
  type CounterRegisterDeps,
  type CounterRegisterFailure,
  type CounterSaleAfterSaleAction,
} from "../../commerce/counter-register";
import type {
  ControlMutationReceiptScope,
  UnversionedControlMutationBoundary,
} from "../../data/control-mutation";
import type { Env } from "../../env";
import { admitUserMutation } from "../admission/control-mutation";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import {
  resolveMerchantControlContext,
  type MerchantControlContext,
} from "../commerce-merchant";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../http";
import { recordCommerceMutationReceipt } from "../mutation-receipt";

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
      kind:
        | "counterSalePickupReady"
        | "counterSaleHandover"
        | "counterSaleRefund"
        | "counterSaleManualCashRefund";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>;

type StartedMutation = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  identity: Readonly<{ issuer: string; subject: string; userId: string }>;
  scope: ControlMutationReceiptScope;
  boundary: UnversionedControlMutationBoundary;
  context: MerchantControlContext;
  deps: CounterRegisterDeps;
  body: JsonRecord;
  now: number;
}>;

export function matchCounterSaleControlRoute(
  pathname: string,
): CounterSaleControlRoute | null {
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
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/(cash|collection|cancel|reconciliation)$/u,
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
    case "counterSalePickupReady":
    case "counterSaleHandover":
    case "counterSaleRefund":
    case "counterSaleManualCashRefund":
      return handleCounterSaleAfterSale(request, env, route);
  }
}

async function handleCounterRegisterRead(
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
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const url = new URL(request.url);
  const locationId = url.searchParams.get("locationId");
  const loaded = await loadCounterRegisterSnapshot(
    makeDeps(env, authorized, context),
    locationId,
  );
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
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  const result = await readCounterSaleView(
    makeDeps(env, authorized, context),
    route.checkoutIdRaw,
  );
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
  const settled = await recordCounterSaleCash(started.deps, {
    checkoutId: route.checkoutIdRaw,
    ...parsed,
    idempotencyKey: started.boundary.idempotencyKey,
  });
  if (!settled.ok) return failureResponse(settled.failure);
  return finishMutation(request, started, { ok: true, counterSale: settled.value });
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
  const mutated = await executeCounterSaleAfterSale(started.deps, {
    checkoutId: route.checkoutIdRaw,
    action,
    idempotencyKey: started.boundary.idempotencyKey,
    reason,
  });
  if (!mutated.ok) return failureResponse(mutated.failure);
  return finishMutation(request, started, { ok: true, counterSale: mutated.value });
}

function makeDeps(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  context: MerchantControlContext,
): CounterRegisterDeps {
  return {
    env,
    scope: authorized.executionScope,
    organisationId: authorized.organisationId,
    merchantId: context.merchantId,
    client: context.client,
  };
}

async function beginMutation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  operation: string,
  role: "operator" | "admin",
): Promise<StartedMutation | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    role,
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("counter_sale_request_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/counter-sales`,
    operation,
  });
  if (admitted instanceof Response) return admitted;
  const context = await resolveMerchantControlContext(env, authorized);
  if (context instanceof Response) return context;
  return {
    authorized,
    identity: admitted.user,
    scope: admitted.scope,
    boundary: admitted.boundary,
    context,
    deps: makeDeps(env, authorized, context),
    body: body.value,
    now: Date.now(),
  };
}

async function finishMutation(
  request: Request,
  started: StartedMutation,
  responseBody: unknown,
): Promise<Response> {
  const recorded = await recordCommerceMutationReceipt({
    authorized: started.authorized,
    identity: started.identity,
    scope: started.scope,
    boundary: started.boundary,
    request,
    responseBody,
    responseStatus: 200,
    now: started.now,
  });
  return recorded.ok
    ? controlJson(responseBody)
    : controlError(recorded.error.code, 409);
}

function failureResponse(failure: CounterRegisterFailure): Response {
  if (failure.kind === "commerce") {
    return commerceErrorResponse(failure.error);
  }
  return controlJson(
    { ok: false, error: failure.code, ...(failure.extra ?? {}) },
    failure.status,
  );
}

function commerceErrorResponse(error: CommerceClientError): Response {
  if (error.kind === "rejected") {
    return controlJson(
      { ok: false, error: "counter_sale_rejected", detail: error.error },
      409,
    );
  }
  return error.kind === "http" && error.status >= 400 && error.status < 500
    ? controlJson(
        { ok: false, error: "counter_sale_rejected", detail: error.message },
        409,
      )
    : controlError("underclerk_unavailable", 503);
}

function parseSaleRequest(body: JsonRecord): Readonly<{
  satyrLocationId: string;
  checkoutId: string;
  lines: readonly CommercePickupCheckoutLineV1[];
  tenderMode?: "terminal" | "cash";
}> | null {
  const { satyrLocationId, checkoutId, lines, tenderMode } = body;
  if (typeof satyrLocationId !== "string" || satyrLocationId.length === 0) return null;
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
    satyrLocationId,
    checkoutId,
    lines: lines as readonly CommercePickupCheckoutLineV1[],
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
  satyrLocationId: string;
  checkoutRevision: number;
  quoteDigest: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
  paymentMethod?: CounterRegisterPaymentMethod;
}> | null {
  const { satyrLocationId, checkoutRevision, quoteDigest, amount, paymentMethod } = body;
  if (typeof satyrLocationId !== "string" || satyrLocationId.length === 0) return null;
  if (!Number.isSafeInteger(checkoutRevision) || Number(checkoutRevision) <= 0) return null;
  if (typeof quoteDigest !== "string" || !/^quote_[a-f0-9]{64}$/u.test(quoteDigest)) return null;
  const parsedAmount = parseMoney(amount);
  if (parsedAmount === null) return null;
  if (paymentMethod !== undefined && !isCounterRegisterPaymentMethod(paymentMethod)) return null;
  return {
    satyrLocationId,
    checkoutRevision: Number(checkoutRevision),
    quoteDigest,
    amount: parsedAmount,
    ...(paymentMethod === undefined ? {} : { paymentMethod }),
  };
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

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined) throw new Error("Counter sale route capture is missing");
  return decodeURIComponent(value);
}
