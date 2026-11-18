import { terminalAssignmentPaymentBinding } from "@seams/contracts";
import type {
  CommerceAdminClient,
  CommerceClientError,
  CommerceCounterSaleV1,
  CommercePickupFulfillmentV1,
  CommerceMerchantSnapshotV1,
  CommerceOrderV1,
  CommercePaymentV1,
  CommercePickupCheckoutLineV1,
} from "@seams/commerce-client";

import type { Env } from "../../env";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
  type JsonRecord,
} from "../http";
import {
  parseControlMutationBoundary,
  readControlMutationReplay,
  type UnversionedControlMutationBoundary,
  type ControlMutationReceiptScope,
} from "../../data/control-mutation";
import { createCommerceClient } from "../../commerce/outbox-worker";
import { readActiveTerminalAssignment } from "../../data/terminal-assignment-store";
import { readCounterSale as readCounterSaleState } from "../../data/counter-sale-readback";
import type { CounterSaleReadback } from "../../data/counter-sale-readback";
import { readOrganisationEnvironment } from "../organisation-runtime";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { resolveUser } from "../../data/control-plane";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

/**
 * The walking sale: ring an order up at the counter and take the card.
 *
 * Two steps, because they fail differently. Opening the Checkout is ordinary
 * commerce and can simply be retried. Collecting is money movement against
 * hardware that is physically present, so it is idempotent on the operator's
 * key and never re-dispatched on a whim.
 *
 * Everything the sale is priced by — the counter policy revision and the
 * terminal assignment revision — is resolved here from what is actually in
 * force, never accepted from the caller. An operator's browser cannot name the
 * policy it wants to be charged under, and a counter sale pins no storefront
 * profile at all: it is priced by the counter's own published configuration.
 */
export type CounterSaleControlRoute =
  | Readonly<{ kind: "counterSales"; organisationIdRaw: string }>
  | Readonly<{
      kind: "counterSale";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>
  | Readonly<{
      kind: "counterSaleCollection";
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
        "counterSalePickupReady" | "counterSaleHandover" | "counterSaleRefund";
      organisationIdRaw: string;
      checkoutIdRaw: string;
    }>;

type CounterSaleAfterSale = Readonly<{
  order: Readonly<{
    id: string;
    revision: number;
    state: CommerceOrderV1["lifecycle"]["state"];
  }>;
  payment: Readonly<{
    id: string;
    revision: number;
    state: CommercePaymentV1["lifecycle"]["state"];
  }>;
  fulfillment: Readonly<{
    id: string;
    revision: number;
    state: CommercePickupFulfillmentV1["lifecycle"]["state"];
  }>;
  refundState: "none" | "pending" | "completed" | "failed";
}>;

type CounterSaleView = CounterSaleReadback &
  Readonly<{
    afterSale: CounterSaleAfterSale | null;
  }>;

type CounterSaleContext = Readonly<{
  merchantId: string;
  client: CommerceAdminClient;
}>;

type StartedMutation = Readonly<{
  authorized: AuthorizedOrganisationRequest;
  identity: Readonly<{
    issuer: string;
    subject: string;
    userId: string;
  }>;
  scope: ControlMutationReceiptScope;
  boundary: UnversionedControlMutationBoundary;
  context: CounterSaleContext;
  body: JsonRecord;
  now: number;
}>;

export function matchCounterSaleControlRoute(
  pathname: string,
): CounterSaleControlRoute | null {
  const afterSale = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/(ready|handover|refund)$/u,
  );
  if (afterSale !== null) {
    const action = afterSale[2];
    if (action === undefined) {
      throw new Error("Counter-sale after-sale action is missing");
    }
    return {
      kind: afterSaleKind(action),
      organisationIdRaw: decode(afterSale[0]),
      checkoutIdRaw: decode(afterSale[1]),
    };
  }
  const reconciliation = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/reconciliation$/u,
  );
  if (reconciliation !== null) {
    return {
      kind: "counterSaleReconciliation",
      organisationIdRaw: decode(reconciliation[0]),
      checkoutIdRaw: decode(reconciliation[1]),
    };
  }
  const collection = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/counter-sales\/([^/]+)\/collection$/u,
  );
  if (collection !== null) {
    return {
      kind: "counterSaleCollection",
      organisationIdRaw: decode(collection[0]),
      checkoutIdRaw: decode(collection[1]),
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
    case "counterSales":
      return handleCounterSaleOpen(request, env, route.organisationIdRaw);
    case "counterSale":
      return handleCounterSaleRead(request, env, route);
    case "counterSaleCollection":
      return handleCounterSaleCollection(request, env, route);
    case "counterSaleReconciliation":
      return handleCounterSaleReconciliation(request, env, route);
    case "counterSalePickupReady":
    case "counterSaleHandover":
    case "counterSaleRefund":
      return handleCounterSaleAfterSale(request, env, route);
  }
}

/**
 * Read one sale back: the receipt, and what the payment is actually doing.
 *
 * This is the surface an operator uses when a collection did not visibly
 * finish — a reload mid-sale, a terminal that went quiet, a customer asking
 * whether they were charged. It answers from recorded state only, and it is
 * the same answer whichever till asks.
 */
async function handleCounterSaleRead(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSale">,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const context = await resolveCounterSaleContext(env, authorized);
  if (context instanceof Response) {
    return context;
  }
  const sale = await context.client.readCounterSale(
    context.merchantId,
    route.checkoutIdRaw,
  );
  if (!sale.ok) {
    return sale.error.kind === "http" && sale.error.status === 404
      ? controlError("counter_sale_not_found", 404)
      : commerceErrorResponse(sale.error);
  }
  const view = await buildCounterSaleView(context, sale.value);
  return view instanceof Response
    ? view
    : controlJson({ ok: true, counterSale: view });
}

async function handleCounterSaleOpen(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const started = await beginCounterSaleMutation(
    request,
    env,
    organisationIdRaw,
    "counter_sale.open",
  );
  if (started instanceof Response) {
    return started;
  }
  const sale = parseSaleRequest(started.body);
  if (sale === null) {
    return controlError("counter_sale_request_invalid", 422);
  }

  const resolved = await resolveCounterAuthority(
    started,
    sale.satyrLocationId,
  );
  if (resolved instanceof Response) {
    return resolved;
  }
  const snapshot = await started.context.client.readSnapshot(
    started.context.merchantId,
  );
  if (!snapshot.ok) {
    return commerceErrorResponse(snapshot.error);
  }

  const created = await started.context.client.createInPersonCheckout({
    merchantId: started.context.merchantId,
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: started.boundary.idempotencyKey,
    satyrLocationId: sale.satyrLocationId,
    posConfigurationRevision: resolved.posConfigurationRevision,
    // The operator is recorded on the sale itself: a counter sale has no buyer
    // identity to attribute it to, so who rang it up is the only attribution
    // there is.
    operatorIdentity: started.identity.userId,
    terminalAssignmentRevision: resolved.terminalAssignmentRevision,
    buyer: { kind: "anonymous" },
    checkoutId: sale.checkoutId,
    lines: sale.lines,
  });
  if (!created.ok) {
    return commerceErrorResponse(created.error);
  }
  if (created.value.outcome === "rejected") {
    console.warn("counter_sale.open_rejected", {
      code: created.value.error.code,
      field:
        "field" in created.value.error ? created.value.error.field : undefined,
    });
    return controlJson(
      { ok: false, error: "counter_sale_rejected", detail: created.value },
      409,
    );
  }
  const responseBody = { ok: true, counterSale: created.value };
  const recordedMutationReceipt = await completeCounterSaleMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

/**
 * Present the amount on the terminal.
 *
 * The payment binding comes from the assignment currently active at the
 * counter, not from the request: an operator cannot choose which terminal
 * takes the money. A retired assignment has no binding at all, which is what
 * stops a withdrawn counter from collecting.
 */
async function handleCounterSaleCollection(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleCollection">,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const started = await beginCounterSaleMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.collect",
  );
  if (started instanceof Response) {
    return started;
  }
  const collection = parseCollectionRequest(started.body);
  if (collection === null) {
    return controlError("counter_sale_request_invalid", 422);
  }

  const assignment = await readActiveTerminalAssignment(
    started.authorized.executionScope.database,
    started.authorized.organisationId,
    collection.satyrLocationId,
  );
  if (!assignment.ok) {
    return controlError("terminal_assignment_not_found", 409);
  }
  const binding = terminalAssignmentPaymentBinding(assignment.value);
  if (!binding.ok) {
    return controlError("terminal_assignment_retired", 409);
  }
  if (
    binding.value.account.currency !== collection.amount.currency.toUpperCase()
  ) {
    // The terminal settles in its account's currency. Presenting an amount in
    // another one would collect a number the buyer did not agree to.
    return controlError("counter_sale_currency_mismatch", 409);
  }

  // Never present an amount for a sale whose payment is already unresolved or
  // already settled. An indeterminate attempt has to be reconciled, and a
  // captured one has already taken the customer's money — collecting again
  // charges them twice for the same basket.
  const existing = await started.context.client.readCounterSale(
    started.context.merchantId,
    route.checkoutIdRaw,
  );
  if (!existing.ok) {
    return existing.error.kind === "http" && existing.error.status === 404
      ? controlError("counter_sale_not_found", 404)
      : commerceErrorResponse(existing.error);
  }
  const state = readCounterSaleState({
    checkout: existing.value.checkout,
    paymentAttempt: existing.value.paymentAttempt,
  });
  if (!state.collectable) {
    return controlJson(
      {
        ok: false,
        error: "counter_sale_not_collectable",
        counterSale: state,
      },
      409,
    );
  }

  const snapshot = await started.context.client.readSnapshot(
    started.context.merchantId,
  );
  if (!snapshot.ok) {
    return commerceErrorResponse(snapshot.error);
  }
  const collected = await started.context.client.collectInPersonCheckoutPayment(
    {
      merchantId: started.context.merchantId,
      expectedMerchantRevision: snapshot.value.merchantRevision,
      idempotencyKey: started.boundary.idempotencyKey,
      checkoutId: route.checkoutIdRaw,
      checkoutRevision: collection.checkoutRevision,
      quoteDigest: collection.quoteDigest,
      // Both identities are derived from the operator's idempotency key, so a
      // retried collection is the same attempt rather than a second charge.
      paymentAttemptId: `payment_attempt_${started.boundary.idempotencyKey}`,
      providerRequestId: `provider_request_${started.boundary.idempotencyKey}`,
      amount: collection.amount,
      paymentBinding: binding.value,
    },
  );
  if (!collected.ok) {
    return commerceErrorResponse(collected.error);
  }
  if (collected.value.outcome === "rejected") {
    return controlJson(
      { ok: false, error: "counter_sale_rejected", detail: collected.value },
      409,
    );
  }
  if (collected.value.outcome === "unavailable") {
    const responseBody = {
      ok: false,
      error: "counter_sale_collection_unavailable",
      retryAfter: collected.value.retryAfter,
    };
    return controlJson(responseBody, 503);
  }
  const responseBody = { ok: true, collection: collected.value };
  const recordedMutationReceipt = await completeCounterSaleMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function handleCounterSaleReconciliation(
  request: Request,
  env: Env,
  route: Variant<CounterSaleControlRoute, "counterSaleReconciliation">,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const started = await beginCounterSaleMutation(
    request,
    env,
    route.organisationIdRaw,
    "counter_sale.reconcile",
  );
  if (started instanceof Response) {
    return started;
  }
  const reconciled = await started.context.client.reconcileCounterSalePayment(
    started.context.merchantId,
    route.checkoutIdRaw,
  );
  if (!reconciled.ok) {
    return commerceErrorResponse(reconciled.error);
  }
  const view = await buildCounterSaleView(started.context, reconciled.value);
  if (view instanceof Response) {
    return view;
  }
  const responseBody = { ok: true, counterSale: view };
  const recordedMutationReceipt = await completeCounterSaleMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function handleCounterSaleAfterSale(
  request: Request,
  env: Env,
  route: Variant<
    CounterSaleControlRoute,
    "counterSalePickupReady" | "counterSaleHandover" | "counterSaleRefund"
  >,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const operation = afterSaleOperation(route.kind);
  const started = await beginCounterSaleMutation(
    request,
    env,
    route.organisationIdRaw,
    operation,
  );
  if (started instanceof Response) {
    return started;
  }
  const placed = await resolvePlacedCounterSale(
    started.context,
    route.checkoutIdRaw,
  );
  if (placed instanceof Response) {
    return placed;
  }
  if (
    route.kind === "counterSaleRefund" &&
    refundStateOf(placed.order) === "pending"
  ) {
    return reconcileCounterSaleRefund(
      request,
      env,
      started,
      route.checkoutIdRaw,
    );
  }
  const commandBase = {
    merchantId: started.context.merchantId,
    expectedMerchantRevision: placed.snapshot.merchantRevision,
    idempotencyKey: started.boundary.idempotencyKey,
  };
  let mutated: Awaited<ReturnType<typeof refundCounterSale>>;
  switch (route.kind) {
    case "counterSalePickupReady":
      mutated = await started.context.client.markPickupReady({
        ...commandBase,
        orderId: placed.order.id,
        orderRevision: placed.order.revision,
        fulfillmentId: placed.fulfillment.id,
        fulfillmentRevision: placed.fulfillment.revision,
      });
      break;
    case "counterSaleHandover":
      mutated = await started.context.client.completePickup({
        ...commandBase,
        orderId: placed.order.id,
        orderRevision: placed.order.revision,
        paymentId: placed.payment.id,
        paymentRevision: placed.payment.revision,
        fulfillmentId: placed.fulfillment.id,
        fulfillmentRevision: placed.fulfillment.revision,
      });
      break;
    case "counterSaleRefund":
      mutated = await refundCounterSale(started, placed);
      break;
    default:
      return assertNever(route.kind);
  }
  if (!mutated.ok) {
    return commerceErrorResponse(mutated.error);
  }
  if (mutated.value.outcome === "rejected") {
    console.warn("counter_sale.after_sale_rejected", {
      operation,
      code: mutated.value.error.code,
      field:
        "field" in mutated.value.error ? mutated.value.error.field : undefined,
    });
    return controlJson(
      { ok: false, error: "counter_sale_after_sale_rejected" },
      409,
    );
  }
  const sale = await started.context.client.readCounterSale(
    started.context.merchantId,
    route.checkoutIdRaw,
  );
  if (!sale.ok) {
    return commerceErrorResponse(sale.error);
  }
  const view = await buildCounterSaleView(started.context, sale.value);
  if (view instanceof Response) {
    return view;
  }
  if (
    route.kind === "counterSaleRefund" &&
    view.afterSale?.refundState === "pending"
  ) {
    return controlJson(
      {
        ok: false,
        error: "counter_sale_refund_processing",
        counterSale: view,
      },
      503,
    );
  }
  const responseBody = { ok: true, counterSale: view };
  const recordedMutationReceipt = await completeCounterSaleMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function reconcileCounterSaleRefund(
  request: Request,
  env: Env,
  started: StartedMutation,
  checkoutId: string,
): Promise<Response> {
  const reconciled = await started.context.client.reconcileCounterSaleRefund(
    started.context.merchantId,
    checkoutId,
  );
  if (!reconciled.ok) {
    return commerceErrorResponse(reconciled.error);
  }
  const view = await buildCounterSaleView(started.context, reconciled.value);
  if (view instanceof Response) {
    return view;
  }
  if (view.afterSale?.refundState === "pending") {
    return controlJson(
      {
        ok: false,
        error: "counter_sale_refund_processing",
        counterSale: view,
      },
      503,
    );
  }
  const responseBody = { ok: true, counterSale: view };
  const recordedMutationReceipt = await completeCounterSaleMutation(
    request,
    started,
    responseBody,
  );
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

async function refundCounterSale(
  started: StartedMutation,
  placed: PlacedCounterSale,
) {
  const configuration =
    await started.context.client.readPointOfSaleConfiguration(
      started.context.merchantId,
      placed.sale.checkout.source.kind === "point_of_sale"
        ? placed.sale.checkout.source.satyrLocationId
        : "",
    );
  if (!configuration.ok) {
    return configuration;
  }
  return started.context.client.refundOrder({
    merchantId: started.context.merchantId,
    expectedMerchantRevision: placed.snapshot.merchantRevision,
    idempotencyKey: started.boundary.idempotencyKey,
    orderId: placed.order.id,
    orderRevision: placed.order.revision,
    paymentId: placed.payment.id,
    paymentRevision: placed.payment.revision,
    refundAttemptId: `refund_${started.boundary.idempotencyKey}`,
    refundPolicyId: configuration.value.afterSalePolicy.refundPolicyId,
    amount: placed.payment.amount,
    allocation: fullRefundAllocation(placed.order),
    reason: "Counter sale returned in full",
  });
}

function fullRefundAllocation(order: CommerceOrderV1) {
  const lineAllocations = [];
  const taxAllocations = [];
  for (const line of order.lineItems) {
    lineAllocations.push({ orderLineId: line.id, amount: line.lineTotal });
    if (line.tax.amountMinor > 0) {
      taxAllocations.push({ orderLineId: line.id, amount: line.tax });
    }
  }
  return {
    lineAllocations,
    taxAllocations,
    dutyAllocations: [],
    shippingAllocation: order.totals.shipping,
  };
}

type PlacedCounterSale = Readonly<{
  sale: CommerceCounterSaleV1;
  snapshot: CommerceMerchantSnapshotV1;
  order: CommerceOrderV1;
  payment: CommercePaymentV1;
  fulfillment: CommercePickupFulfillmentV1;
}>;

async function resolvePlacedCounterSale(
  context: CounterSaleContext,
  checkoutId: string,
): Promise<PlacedCounterSale | Response> {
  const sale = await context.client.readCounterSale(
    context.merchantId,
    checkoutId,
  );
  if (!sale.ok) {
    return commerceErrorResponse(sale.error);
  }
  const state = readCounterSaleState(sale.value);
  if (state.orderId === null) {
    return controlError("counter_sale_order_not_found", 409);
  }
  const snapshot = await context.client.readSnapshot(context.merchantId);
  if (!snapshot.ok) {
    return commerceErrorResponse(snapshot.error);
  }
  const order = findOrder(snapshot.value, state.orderId);
  const payment = findPayment(snapshot.value, state.orderId);
  const fulfillment = findPickupFulfillment(snapshot.value, state.orderId);
  return order === undefined ||
    payment === undefined ||
    fulfillment === undefined
    ? controlError("counter_sale_after_sale_not_found", 409)
    : {
        sale: sale.value,
        snapshot: snapshot.value,
        order,
        payment,
        fulfillment,
      };
}

async function buildCounterSaleView(
  context: CounterSaleContext,
  sale: CommerceCounterSaleV1,
): Promise<CounterSaleView | Response> {
  const state = readCounterSaleState(sale);
  if (state.orderId === null) {
    return { ...state, afterSale: null };
  }
  const snapshot = await context.client.readSnapshot(context.merchantId);
  if (!snapshot.ok) {
    return commerceErrorResponse(snapshot.error);
  }
  const order = findOrder(snapshot.value, state.orderId);
  const payment = findPayment(snapshot.value, state.orderId);
  const fulfillment = findPickupFulfillment(snapshot.value, state.orderId);
  if (
    order === undefined ||
    payment === undefined ||
    fulfillment === undefined
  ) {
    return controlError("counter_sale_after_sale_not_found", 409);
  }
  return {
    ...state,
    afterSale: {
      order: {
        id: order.id,
        revision: order.revision,
        state: order.lifecycle.state,
      },
      payment: {
        id: payment.id,
        revision: payment.revision,
        state: payment.lifecycle.state,
      },
      fulfillment: {
        id: fulfillment.id,
        revision: fulfillment.revision,
        state: fulfillment.lifecycle.state,
      },
      refundState: refundStateOf(order),
    },
  };
}

function refundStateOf(
  order: CommerceOrderV1,
): "none" | "pending" | "completed" | "failed" {
  for (let index = order.adjustments.length - 1; index >= 0; index -= 1) {
    const adjustment = order.adjustments[index];
    if (adjustment?.kind === "refund") {
      return adjustment.status;
    }
  }
  return "none";
}

function findOrder(snapshot: CommerceMerchantSnapshotV1, orderId: string) {
  for (const order of snapshot.resources.orders) {
    if (order.id === orderId) {
      return order;
    }
  }
  return undefined;
}

function findPayment(snapshot: CommerceMerchantSnapshotV1, orderId: string) {
  for (const payment of snapshot.resources.payments) {
    if (payment.orderId === orderId) {
      return payment;
    }
  }
  return undefined;
}

function findPickupFulfillment(
  snapshot: CommerceMerchantSnapshotV1,
  orderId: string,
) {
  for (const fulfillment of snapshot.resources.fulfillments) {
    if (fulfillment.orderId === orderId && fulfillment.kind === "pickup") {
      return fulfillment;
    }
  }
  return undefined;
}

function afterSaleKind(
  value: string,
): "counterSalePickupReady" | "counterSaleHandover" | "counterSaleRefund" {
  switch (value) {
    case "ready":
      return "counterSalePickupReady";
    case "handover":
      return "counterSaleHandover";
    case "refund":
      return "counterSaleRefund";
    default:
      throw new Error("Invalid counter-sale after-sale route");
  }
}

function afterSaleOperation(
  kind: "counterSalePickupReady" | "counterSaleHandover" | "counterSaleRefund",
): string {
  switch (kind) {
    case "counterSalePickupReady":
      return "counter_sale.pickup_ready";
    case "counterSaleHandover":
      return "counter_sale.handover";
    case "counterSaleRefund":
      return "counter_sale.refund";
  }
}

/**
 * What the counter is currently authorized to sell and collect under.
 *
 * Both revisions are read rather than accepted, so a sale is always priced by
 * the policy in force and dispatched to the terminal in force.
 */
async function resolveCounterAuthority(
  started: StartedMutation,
  pantryLocationId: string,
): Promise<
  | Readonly<{
      posConfigurationRevision: number;
      terminalAssignmentRevision: number;
    }>
  | Response
> {
  const configuration =
    await started.context.client.readPointOfSaleConfiguration(
      started.context.merchantId,
      pantryLocationId,
    );
  if (!configuration.ok) {
    return configuration.error.kind === "http" &&
      configuration.error.status === 404
      ? controlError("counter_policy_not_found", 409)
      : commerceErrorResponse(configuration.error);
  }
  const assignment = await readActiveTerminalAssignment(
    started.authorized.executionScope.database,
    started.authorized.organisationId,
    pantryLocationId,
  );
  if (!assignment.ok) {
    return controlError("terminal_assignment_not_found", 409);
  }
  return {
    posConfigurationRevision: configuration.value.revision,
    terminalAssignmentRevision: assignment.value.revision,
  };
}

async function beginCounterSaleMutation(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  operation: string,
): Promise<StartedMutation | Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }
  const body = await readJsonRecord(request);
  if (!body.ok) {
    return controlError("counter_sale_request_invalid", 422);
  }
  const boundary = await parseControlMutationBoundary({
    request,
    body: body.value,
    requireConfigurationVersion: false,
  });
  if (!boundary.ok || boundary.value.kind !== "unversioned") {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  const identity = await resolveUser({
    db: env.DB,
    userId: authorized.authenticated.session.userId,
  });
  if (identity === null) {
    return controlError("app_user_missing", 401);
  }
  const scope: ControlMutationReceiptScope = {
    userId: identity.userId,
    organisationScope: authorized.organisationId,
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/counter-sales`,
    operation,
  };
  const replay = await readControlMutationReplay({
    db: authorized.executionScope.database,
    scope,
    boundary: boundary.value,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "replay") {
    return controlJson(
      replay.receipt.responseBody,
      replay.receipt.responseStatus,
    );
  }
  const context = await resolveCounterSaleContext(env, authorized);
  if (context instanceof Response) {
    return context;
  }
  return {
    authorized,
    identity,
    scope,
    boundary: boundary.value,
    context,
    body: body.value,
    now: Date.now(),
  };
}

function completeCounterSaleMutation(
  request: Request,
  started: StartedMutation,
  responseBody: unknown,
  responseStatus = 200,
): ReturnType<typeof recordCommerceMutationReceipt> {
  return recordCommerceMutationReceipt({
    authorized: started.authorized,
    identity: started.identity,
    scope: started.scope,
    boundary: started.boundary,
    request,
    responseBody,
    responseStatus,
    now: started.now,
  });
}

function parseSaleRequest(body: JsonRecord): Readonly<{
  satyrLocationId: string;
  checkoutId: string;
  lines: readonly CommercePickupCheckoutLineV1[];
}> | null {
  const { satyrLocationId: pantryLocationId, checkoutId, lines } = body;
  if (typeof pantryLocationId !== "string" || pantryLocationId.length === 0) {
    return null;
  }
  if (typeof checkoutId !== "string" || checkoutId.length === 0) {
    return null;
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }
  return {
    satyrLocationId: pantryLocationId,
    checkoutId,
    // Line shape is Commerce's to enforce: it owns what may be rung up under
    // the counter's published policy, and duplicating that judgement here would
    // let the two disagree.
    lines: lines as readonly CommercePickupCheckoutLineV1[],
  };
}

function parseCollectionRequest(body: JsonRecord): Readonly<{
  satyrLocationId: string;
  checkoutRevision: number;
  quoteDigest: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
}> | null {
  const { satyrLocationId: pantryLocationId, checkoutRevision, quoteDigest, amount } = body;
  if (typeof pantryLocationId !== "string" || pantryLocationId.length === 0) {
    return null;
  }
  if (
    !Number.isSafeInteger(checkoutRevision) ||
    Number(checkoutRevision) <= 0
  ) {
    return null;
  }
  if (
    typeof quoteDigest !== "string" ||
    !/^quote_[a-f0-9]{64}$/u.test(quoteDigest)
  ) {
    return null;
  }
  if (typeof amount !== "object" || amount === null || Array.isArray(amount)) {
    return null;
  }
  const money = amount as Record<string, unknown>;
  if (
    !Number.isSafeInteger(money.amountMinor) ||
    Number(money.amountMinor) <= 0
  ) {
    return null;
  }
  if (
    typeof money.currency !== "string" ||
    !/^[A-Za-z]{3}$/u.test(money.currency)
  ) {
    return null;
  }
  return {
    satyrLocationId: pantryLocationId,
    checkoutRevision: Number(checkoutRevision),
    quoteDigest,
    amount: {
      amountMinor: Number(money.amountMinor),
      currency: money.currency,
    },
  };
}

async function resolveCounterSaleContext(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<CounterSaleContext | Response> {
  const environment = await readOrganisationEnvironment(
    authorized.executionScope.database,
    authorized.organisationId,
  );
  if (environment === null) {
    return controlError("organisation_not_found", 404);
  }
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    environment,
  });
  if (!binding.ok) {
    return controlError("underclerk_binding_missing", 503);
  }
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(authorized.organisationId),
    actor: String(authorized.membership.personId),
  });
  if (client === null) {
    return controlError("underclerk_unavailable", 503);
  }
  return { merchantId: binding.value.merchantId, client };
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

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Counter sale route capture is missing");
  }
  return decodeURIComponent(value);
}
