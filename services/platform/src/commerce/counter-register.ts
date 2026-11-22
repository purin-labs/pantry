import {
  terminalAssignmentPaymentBinding,
  terminalTargetDeviceId,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";
import type {
  CommerceAdminClient,
  CommerceClientError,
  CommerceCounterSaleV1,
  CommerceMerchantSnapshotV1,
  CommerceOrderV1,
  CommercePaymentV1,
  CommercePickupCheckoutLineV1,
  CommercePickupFulfillmentV1,
  CommerceSoldOutMarksV1,
  CommerceStockSnapshot,
} from "@purin-labs/commerce-client";
import type {
  CounterRegisterMenu,
  CounterRegisterMenuEntry,
  CounterRegisterMenuSection,
  CounterRegisterModifierGroup,
  CounterRegisterPaymentMethod,
  CounterRegisterPolicy,
  CounterRegisterSnapshot,
  CounterRegisterTerminal,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import { deviceFleetStub } from "../devices/contract/fleet-stub";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  readCounterSale as readCounterSaleState,
  type CounterSaleReadback,
} from "../data/counter-sale-readback";
import { readActiveTerminalAssignment } from "../data/terminal-assignment-store";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { presentOrderQueueEntry } from "../cafe/contract/order-queue-commands";

const DEFAULT_CAFE_MENU_ID = "menu_cafe_main";
const ALL_JAPAN_METHODS: readonly CounterRegisterPaymentMethod[] = [
  "card",
  "felica",
  "qr_code",
];

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

export type CounterSaleView = CounterSaleReadback &
  Readonly<{
    afterSale: CounterSaleAfterSale | null;
  }>;

export type CounterRegisterDeps = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  organisationId: OrganisationId;
  merchantId: string;
  client: CommerceAdminClient;
}>;

export type CounterRegisterFailure =
  | Readonly<{ kind: "commerce"; error: CommerceClientError }>
  | Readonly<{ kind: "error"; code: string; status: number; extra?: Record<string, unknown> }>;

export type CounterRegisterResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: CounterRegisterFailure }>;

function ok<T>(value: T): CounterRegisterResult<T> {
  return { ok: true, value };
}

function fail(
  code: string,
  status: number,
  extra?: Record<string, unknown>,
): CounterRegisterResult<never> {
  return { ok: false, failure: { kind: "error", code, status, extra } };
}

function commerceFail(error: CommerceClientError): CounterRegisterResult<never> {
  return { ok: false, failure: { kind: "commerce", error } };
}

/** The DeviceFleetActor of one counter location: its terminal and printer. */
export function counterLocationFleet(
  deps: CounterRegisterDeps,
  locationId: string,
) {
  return deviceFleetStub(deps.env, deps.scope, locationId);
}

/**
 * Load everything the Café › Register screen needs in one round trip:
 * published menu sections/items/modifiers, active counter POS policy,
 * bound terminal readiness (Square or GMO stera), and open pickup queue.
 */
export async function loadCounterRegisterSnapshot(
  deps: CounterRegisterDeps,
  requestedLocationId?: string | null,
): Promise<CounterRegisterResult<CounterRegisterSnapshot>> {
  const [stock, marks, queue] = await Promise.all([
    deps.client.readStockSnapshot(deps.merchantId),
    deps.client.readSoldOutMarks(deps.merchantId),
    deps.client.readPickupQueue(deps.merchantId),
  ]);
  if (!stock.ok) return commerceFail(stock.error);
  if (!marks.ok) return commerceFail(marks.error);
  if (!queue.ok) return commerceFail(queue.error);

  const locationId = resolveRegisterLocationId(stock.value, requestedLocationId);
  const posConfig =
    locationId.length > 0
      ? await deps.client.readPointOfSaleConfiguration(deps.merchantId, locationId)
      : null;

  let policy: CounterRegisterPolicy | null = null;
  if (posConfig !== null) {
    if (posConfig.ok) {
      const cfg = posConfig.value;
      policy = {
        revision: cfg.revision,
        currency: cfg.currency,
        cashEnabled: cfg.cashEnabled ?? false,
        catalogScope: cfg.catalogScope ?? { kind: "supported_items" },
        tax:
          cfg.tax.kind === "percentage"
            ? {
                kind: "percentage",
                basisPoints: cfg.tax.basisPoints,
                inclusion: cfg.tax.inclusion ?? "added",
              }
            : { kind: "none", basisPoints: 0, inclusion: "included" },
      };
    } else if (!(posConfig.error.kind === "http" && posConfig.error.status === 404)) {
      return commerceFail(posConfig.error);
    }
  }

  const targetMenuId =
    policy?.catalogScope.kind === "published_menu"
      ? policy.catalogScope.menuId
      : DEFAULT_CAFE_MENU_ID;
  const menu = buildRegisterMenu(
    stock.value,
    marks.value,
    locationId,
    targetMenuId,
  );

  const terminal = await readRegisterTerminal(deps, locationId);
  const currency =
    policy?.currency ??
    menu?.sections[0]?.entries[0]?.unitPrice.currency ??
    "JPY";
  const openOrders = queue.value.entries.map(presentOrderQueueEntry);

  return ok({
    schemaVersion: "pantry.counter-register.v1",
    merchantId: deps.merchantId,
    pantryLocationId: locationId,
    currency,
    policy,
    menu,
    terminal,
    openQueueCount: openOrders.length,
    openOrders,
  });
}

export async function readCounterSaleView(
  deps: CounterRegisterDeps,
  checkoutId: string,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const sale = await deps.client.readCounterSale(deps.merchantId, checkoutId);
  if (!sale.ok) {
    return sale.error.kind === "http" && sale.error.status === 404
      ? fail("counter_sale_not_found", 404)
      : commerceFail(sale.error);
  }
  return buildCounterSaleView(deps, sale.value);
}

export async function openCounterSale(
  deps: CounterRegisterDeps,
  input: Readonly<{
    pantryLocationId: string;
    checkoutId: string;
    lines: readonly CommercePickupCheckoutLineV1[];
    operatorIdentity: string;
    idempotencyKey: string;
    tenderMode?: "terminal" | "cash";
  }>,
): Promise<CounterRegisterResult<unknown>> {
  const configuration = await deps.client.readPointOfSaleConfiguration(
    deps.merchantId,
    input.pantryLocationId,
  );
  if (!configuration.ok) {
    return configuration.error.kind === "http" &&
      configuration.error.status === 404
      ? fail("counter_policy_not_found", 409)
      : commerceFail(configuration.error);
  }
  const assignment = await readActiveTerminalAssignment(
    deps.scope.database,
    deps.organisationId,
    input.pantryLocationId,
  );
  const cashEnabled = configuration.value.cashEnabled === true;
  let terminalAssignmentRevision: number | null;
  if (input.tenderMode === "cash") {
    if (!cashEnabled) {
      return fail("counter_cash_disabled", 409);
    }
    terminalAssignmentRevision = null;
  } else if (assignment.ok) {
    terminalAssignmentRevision = assignment.value.revision;
  } else if (cashEnabled) {
    terminalAssignmentRevision = null;
  } else {
    return fail("terminal_assignment_not_found", 409);
  }

  const snapshot = await deps.client.readSnapshot(deps.merchantId);
  if (!snapshot.ok) return commerceFail(snapshot.error);

  const created = await deps.client.createInPersonCheckout({
    merchantId: deps.merchantId,
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: input.idempotencyKey,
    pantryLocationId: input.pantryLocationId,
    posConfigurationRevision: configuration.value.revision,
    operatorIdentity: input.operatorIdentity,
    terminalAssignmentRevision,
    buyer: { kind: "anonymous" },
    checkoutId: input.checkoutId,
    lines: input.lines,
  });
  if (!created.ok) return commerceFail(created.error);
  if (created.value.outcome === "rejected") {
    return fail("counter_sale_rejected", 409, { detail: created.value });
  }
  return ok(created.value);
}

export async function recordCounterSaleCash(
  deps: CounterRegisterDeps,
  input: Readonly<{
    checkoutId: string;
    checkoutRevision: number;
    quoteDigest: string;
    cashReceived: Readonly<{ amountMinor: number; currency: string }>;
    idempotencyKey: string;
  }>,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const snapshot = await deps.client.readSnapshot(deps.merchantId);
  if (!snapshot.ok) return commerceFail(snapshot.error);
  const settled = await deps.client.recordCounterCashPayment({
    merchantId: deps.merchantId,
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: input.idempotencyKey,
    checkoutId: input.checkoutId,
    checkoutRevision: input.checkoutRevision,
    quoteDigest: input.quoteDigest,
    orderId: `order_${input.idempotencyKey}`,
    paymentId: `payment_${input.idempotencyKey}`,
    fulfillmentId: `fulfillment_${input.idempotencyKey}`,
    cashReceived: input.cashReceived,
  });
  if (!settled.ok) return commerceFail(settled.error);
  if (settled.value.outcome === "rejected") {
    return fail("counter_sale_rejected", 409, { detail: settled.value });
  }
  return readCounterSaleView(deps, input.checkoutId);
}

export async function collectCounterSalePayment(
  deps: CounterRegisterDeps,
  input: Readonly<{
    checkoutId: string;
    pantryLocationId: string;
    checkoutRevision: number;
    quoteDigest: string;
    amount: Readonly<{ amountMinor: number; currency: string }>;
    paymentMethod?: CounterRegisterPaymentMethod;
    idempotencyKey: string;
  }>,
): Promise<CounterRegisterResult<unknown>> {
  const assignment = await readActiveTerminalAssignment(
    deps.scope.database,
    deps.organisationId,
    input.pantryLocationId,
  );
  if (!assignment.ok) return fail("terminal_assignment_not_found", 409);
  const binding = terminalAssignmentPaymentBinding(assignment.value);
  if (!binding.ok) return fail("terminal_assignment_retired", 409);
  if (binding.value.account.currency !== input.amount.currency.toUpperCase()) {
    return fail("counter_sale_currency_mismatch", 409);
  }

  const existing = await deps.client.readCounterSale(
    deps.merchantId,
    input.checkoutId,
  );
  if (!existing.ok) {
    return existing.error.kind === "http" && existing.error.status === 404
      ? fail("counter_sale_not_found", 404)
      : commerceFail(existing.error);
  }
  const state = readCounterSaleState(existing.value);
  if (!state.collectable) {
    return fail("counter_sale_not_collectable", 409, { counterSale: state });
  }

  const snapshot = await deps.client.readSnapshot(deps.merchantId);
  if (!snapshot.ok) return commerceFail(snapshot.error);
  const paymentAttemptId = `payment_attempt_${input.idempotencyKey}`;
  const providerRequestId = `provider_request_${input.idempotencyKey}`;
  const collected = await deps.client.collectInPersonCheckoutPayment({
    merchantId: deps.merchantId,
    expectedMerchantRevision: snapshot.value.merchantRevision,
    idempotencyKey: input.idempotencyKey,
    checkoutId: input.checkoutId,
    checkoutRevision: input.checkoutRevision,
    quoteDigest: input.quoteDigest,
    paymentAttemptId,
    providerRequestId,
    amount: input.amount,
    paymentBinding: binding.value,
    ...(input.paymentMethod === undefined
      ? {}
      : { paymentMethod: input.paymentMethod }),
  });
  if (!collected.ok) return commerceFail(collected.error);
  if (collected.value.outcome === "rejected") {
    return fail("counter_sale_rejected", 409, { detail: collected.value });
  }
  if (collected.value.outcome === "unavailable") {
    return fail("counter_sale_collection_unavailable", 503, {
      retryAfter: collected.value.retryAfter,
    });
  }

  // For GMO stera LAN gateway terminals, dispatch the payment request through
  // the location's DeviceFleetActor (which enforces single-terminal exclusivity).
  if (
    collected.value.session.kind === "gateway_terminal_checkout" &&
    binding.value.provider === "gmo_stera"
  ) {
    const stub = deviceFleetStub(deps.env, deps.scope, input.pantryLocationId);
    if (stub === null) {
      return fail("gateway_fleet_unavailable", 503);
    }
    const dispatched = await stub.startTerminalCollection({
      gatewayId: binding.value.gatewayId,
      sourceKey: binding.value.deviceSourceKey,
      requestId: providerRequestId,
      paymentAttemptId,
      checkoutId: input.checkoutId,
      amountMinor: input.amount.amountMinor,
      currency: input.amount.currency.toUpperCase(),
      paymentMethod: input.paymentMethod ?? "card",
      expiresAt: collected.value.session.expiresAt,
    });
    if (!dispatched.ok) {
      const status =
        dispatched.reason === "gateway_offline" ? 503 : 409;
      return fail(dispatched.reason, status, {
        activeAttemptId: dispatched.active?.paymentAttemptId ?? null,
      });
    }
  }

  return ok(collected.value);
}

export async function reconcileCounterSale(
  deps: CounterRegisterDeps,
  input: Readonly<{ checkoutId: string; idempotencyKey: string }>,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const current = await deps.client.readCounterSale(
    deps.merchantId,
    input.checkoutId,
  );
  if (!current.ok) {
    return current.error.kind === "http" && current.error.status === 404
      ? fail("counter_sale_not_found", 404)
      : commerceFail(current.error);
  }
  if (current.value.paymentAttempt?.binding.paymentBinding.provider === "gmo_stera") {
    return reconcileGatewayTerminalSale(deps, current.value, input.idempotencyKey);
  }
  const reconciled = await deps.client.reconcileCounterSalePayment(
    deps.merchantId,
    input.checkoutId,
  );
  if (!reconciled.ok) return commerceFail(reconciled.error);
  return buildCounterSaleView(deps, reconciled.value);
}

/** The Square Point of Sale app's answer, as the Register's callback page read it. */
export type CounterSaleHandoffResult = Readonly<{
  paymentAttemptId: string;
  handoffReference: string;
  status: "ok" | "error";
  transactionId: string | null;
  clientTransactionId: string | null;
  errorCode: string | null;
}>;

/**
 * Hands the Square Point of Sale app's answer to Commerce, which reads the
 * order and the payment from Square before it places the order (Plan 90
 * Phase 3B). A refused answer changes nothing.
 */
export async function recordCounterSaleHandoffResult(
  deps: CounterRegisterDeps,
  input: Readonly<{ checkoutId: string; result: CounterSaleHandoffResult }>,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const recorded = await deps.client.recordCounterSaleHandoffResult(
    deps.merchantId,
    input.checkoutId,
    { schemaVersion: "commerce.counter-sale-handoff-result.v1", ...input.result },
  );
  if (!recorded.ok) {
    if (recorded.error.kind === "http" && recorded.error.status === 404)
      return fail("counter_sale_not_found", 404);
    if (recorded.error.kind === "http" && recorded.error.status === 409)
      return fail("counter_sale_handoff_refused", 409);
    return commerceFail(recorded.error);
  }
  return buildCounterSaleView(deps, recorded.value);
}

export async function cancelCounterSaleCollection(
  deps: CounterRegisterDeps,
  input: Readonly<{ checkoutId: string; idempotencyKey: string }>,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const current = await deps.client.readCounterSale(
    deps.merchantId,
    input.checkoutId,
  );
  if (!current.ok) {
    return current.error.kind === "http" && current.error.status === 404
      ? fail("counter_sale_not_found", 404)
      : commerceFail(current.error);
  }
  const attempt = current.value.paymentAttempt;
  if (
    attempt?.binding.paymentBinding.provider === "gmo_stera" &&
    current.value.checkout.source.kind === "point_of_sale"
  ) {
    const locationId = current.value.checkout.source.pantryLocationId;
    const assignment = await readActiveTerminalAssignment(
      deps.scope.database,
      deps.organisationId,
      locationId,
    );
    const stub = deviceFleetStub(deps.env, deps.scope, locationId);
    if (
      stub !== null &&
      assignment.ok &&
      assignment.value.target.kind === "lan_gateway_device"
    ) {
      const existingRecord = await stub.readTerminalCollection(
        assignment.value.target.gatewayId,
        assignment.value.target.deviceSourceKey,
      );
      await stub.cancelTerminalCollection({
        gatewayId: assignment.value.target.gatewayId,
        sourceKey: assignment.value.target.deviceSourceKey,
        requestId: existingRecord?.requestId ?? `cancel_${input.idempotencyKey}`,
        paymentAttemptId: attempt.paymentAttemptId,
      });
    }
    return reconcileGatewayTerminalSale(deps, current.value, input.idempotencyKey);
  }
  return reconcileCounterSale(deps, input);
}

export type CounterSaleAfterSaleAction =
  | "ready"
  | "handover"
  | "refund"
  | "manual_cash_refund";

export async function executeCounterSaleAfterSale(
  deps: CounterRegisterDeps,
  input: Readonly<{
    checkoutId: string;
    action: CounterSaleAfterSaleAction;
    idempotencyKey: string;
    reason?: string;
  }>,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const placed = await resolvePlacedCounterSale(deps, input.checkoutId);
  if (!placed.ok) return placed;
  if (
    input.action === "refund" &&
    refundStateOf(placed.value.order) === "pending"
  ) {
    return reconcileCounterSaleRefundView(deps, input.checkoutId);
  }
  const commandBase = {
    merchantId: deps.merchantId,
    expectedMerchantRevision: placed.value.snapshot.merchantRevision,
    idempotencyKey: input.idempotencyKey,
  };
  let mutated;
  switch (input.action) {
    case "ready":
      mutated = await deps.client.markPickupReady({
        ...commandBase,
        orderId: placed.value.order.id,
        orderRevision: placed.value.order.revision,
        fulfillmentId: placed.value.fulfillment.id,
        fulfillmentRevision: placed.value.fulfillment.revision,
      });
      break;
    case "handover":
      mutated = await deps.client.completePickup({
        ...commandBase,
        orderId: placed.value.order.id,
        orderRevision: placed.value.order.revision,
        paymentId: placed.value.payment.id,
        paymentRevision: placed.value.payment.revision,
        fulfillmentId: placed.value.fulfillment.id,
        fulfillmentRevision: placed.value.fulfillment.revision,
      });
      break;
    case "refund":
      mutated = await refundCounterSale(deps, placed.value, input.idempotencyKey, false, input.reason);
      break;
    case "manual_cash_refund":
      mutated = await refundCounterSale(deps, placed.value, input.idempotencyKey, true, input.reason);
      break;
    default:
      return assertNever(input.action);
  }
  if (!mutated.ok) return commerceFail(mutated.error);
  if (mutated.value.outcome === "rejected") {
    return fail("counter_sale_after_sale_rejected", 409, {
      detail: mutated.value.error,
    });
  }
  const view = await readCounterSaleView(deps, input.checkoutId);
  if (!view.ok) return view;
  if (
    input.action === "refund" &&
    view.value.afterSale?.refundState === "pending"
  ) {
    return fail("counter_sale_refund_processing", 503, {
      counterSale: view.value,
    });
  }
  return view;
}

async function reconcileGatewayTerminalSale(
  deps: CounterRegisterDeps,
  sale: CommerceCounterSaleV1,
  idempotencyKey: string,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const attempt = sale.paymentAttempt;
  if (
    attempt === null ||
    sale.checkout.source.kind !== "point_of_sale" ||
    sale.checkout.lifecycle.state === "accepted"
  ) {
    return buildCounterSaleView(deps, sale);
  }
  const locationId = sale.checkout.source.pantryLocationId;
  const assignment = await readActiveTerminalAssignment(
    deps.scope.database,
    deps.organisationId,
    locationId,
  );
  const stub = deviceFleetStub(deps.env, deps.scope, locationId);
  if (
    stub === null ||
    !assignment.ok ||
    assignment.value.target.kind !== "lan_gateway_device"
  ) {
    return buildCounterSaleView(deps, sale);
  }
  const { gatewayId, deviceSourceKey } = assignment.value.target;
  let record = await stub.readTerminalCollection(gatewayId, deviceSourceKey);
  if (
    record !== null &&
    record.paymentAttemptId === attempt.paymentAttemptId &&
    (record.state === "collecting" || record.state === "result_unknown")
  ) {
    await stub.inquireTerminalCollection({
      gatewayId,
      sourceKey: deviceSourceKey,
      requestId: record.requestId,
      paymentAttemptId: record.paymentAttemptId,
    });
    record = await stub.readTerminalCollection(gatewayId, deviceSourceKey);
  }
  if (record === null || record.paymentAttemptId !== attempt.paymentAttemptId) {
    return buildCounterSaleView(deps, sale);
  }

  const quote = sale.checkout.lifecycle.quote;
  if (quote === undefined) return buildCounterSaleView(deps, sale);

  if (record.state === "captured") {
    if (attempt.lifecycle.state !== "captured") {
      const snap = await deps.client.readSnapshot(deps.merchantId);
      if (!snap.ok) return commerceFail(snap.error);
      const captured = await deps.client.recordCheckoutPaymentCapture({
        merchantId: deps.merchantId,
        expectedMerchantRevision: snap.value.merchantRevision,
        idempotencyKey: `${idempotencyKey}_capture`,
        checkoutId: sale.checkout.checkoutId,
        checkoutRevision: sale.checkout.revision,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: attempt.paymentAttemptId,
        paymentAttemptRevision: attempt.revision,
        providerPaymentReference:
          record.providerPaymentReference ?? `stera_${attempt.paymentAttemptId}`,
        capturedAt: new Date(record.updatedAt).toISOString(),
        paymentMethod: record.paymentMethod,
        ...(record.tenderBrand === null
          ? {}
          : { tenderBrand: record.tenderBrand }),
        providerRefundable: record.providerRefundable ?? record.paymentMethod !== "felica",
      });
      if (!captured.ok) return commerceFail(captured.error);
    }
    const afterCapture = await deps.client.readCounterSale(
      deps.merchantId,
      sale.checkout.checkoutId,
    );
    if (!afterCapture.ok) return commerceFail(afterCapture.error);
    if (
      afterCapture.value.checkout.lifecycle.state !== "accepted" &&
      afterCapture.value.paymentAttempt !== null
    ) {
      const snap = await deps.client.readSnapshot(deps.merchantId);
      if (!snap.ok) return commerceFail(snap.error);
      const placed = await deps.client.placePaidCheckout({
        merchantId: deps.merchantId,
        expectedMerchantRevision: snap.value.merchantRevision,
        idempotencyKey: `${idempotencyKey}_place`,
        checkoutId: sale.checkout.checkoutId,
        checkoutRevision: afterCapture.value.checkout.revision,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: attempt.paymentAttemptId,
        paymentAttemptRevision: afterCapture.value.paymentAttempt.revision,
        orderId: `order_${attempt.paymentAttemptId}`,
        paymentId: `payment_${attempt.paymentAttemptId}`,
        fulfillmentId: `fulfillment_${attempt.paymentAttemptId}`,
        buyer: { kind: "guest" },
        placement: { kind: "pickup" },
      });
      if (!placed.ok) return commerceFail(placed.error);
    }
  } else if (
    (record.state === "declined" || record.state === "cancelled") &&
    attempt.lifecycle.state !== "declined"
  ) {
    const snap = await deps.client.readSnapshot(deps.merchantId);
    if (!snap.ok) return commerceFail(snap.error);
    await deps.client.resolveCheckoutPayment({
      merchantId: deps.merchantId,
      expectedMerchantRevision: snap.value.merchantRevision,
      idempotencyKey: `${idempotencyKey}_decline`,
      checkoutId: sale.checkout.checkoutId,
      checkoutRevision: sale.checkout.revision,
      quoteDigest: quote.quoteDigest,
      paymentAttemptId: attempt.paymentAttemptId,
      paymentAttemptRevision: attempt.revision,
      outcome: {
        kind: "declined",
        reasonCode: record.reasonCode ?? record.state,
      },
    });
  } else if (
    record.state === "result_unknown" &&
    attempt.lifecycle.state !== "indeterminate"
  ) {
    const snap = await deps.client.readSnapshot(deps.merchantId);
    if (!snap.ok) return commerceFail(snap.error);
    await deps.client.resolveCheckoutPayment({
      merchantId: deps.merchantId,
      expectedMerchantRevision: snap.value.merchantRevision,
      idempotencyKey: `${idempotencyKey}_unknown`,
      checkoutId: sale.checkout.checkoutId,
      checkoutRevision: sale.checkout.revision,
      quoteDigest: quote.quoteDigest,
      paymentAttemptId: attempt.paymentAttemptId,
      paymentAttemptRevision: attempt.revision,
      outcome: {
        kind: "indeterminate",
        reasonCode: record.reasonCode ?? "gateway_result_unknown",
        reconcileAfter: new Date(Date.now() + 15_000).toISOString(),
      },
    });
  }
  return readCounterSaleView(deps, sale.checkout.checkoutId);
}

async function reconcileCounterSaleRefundView(
  deps: CounterRegisterDeps,
  checkoutId: string,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const reconciled = await deps.client.reconcileCounterSaleRefund(
    deps.merchantId,
    checkoutId,
  );
  if (!reconciled.ok) return commerceFail(reconciled.error);
  const view = await buildCounterSaleView(deps, reconciled.value);
  if (!view.ok) return view;
  if (view.value.afterSale?.refundState === "pending") {
    return fail("counter_sale_refund_processing", 503, {
      counterSale: view.value,
    });
  }
  return view;
}

type PlacedCounterSale = Readonly<{
  sale: CommerceCounterSaleV1;
  snapshot: CommerceMerchantSnapshotV1;
  order: CommerceOrderV1;
  payment: CommercePaymentV1;
  fulfillment: CommercePickupFulfillmentV1;
}>;

async function resolvePlacedCounterSale(
  deps: CounterRegisterDeps,
  checkoutId: string,
): Promise<CounterRegisterResult<PlacedCounterSale>> {
  const sale = await deps.client.readCounterSale(deps.merchantId, checkoutId);
  if (!sale.ok) return commerceFail(sale.error);
  const state = readCounterSaleState(sale.value);
  if (state.orderId === null) {
    return fail("counter_sale_order_not_found", 409);
  }
  const snapshot = await deps.client.readSnapshot(deps.merchantId);
  if (!snapshot.ok) return commerceFail(snapshot.error);
  const order = snapshot.value.resources.orders.find(
    (o) => o.id === state.orderId,
  );
  const payment = snapshot.value.resources.payments.find(
    (p) => p.orderId === state.orderId,
  );
  const fulfillment = snapshot.value.resources.fulfillments.find(
    (f): f is CommercePickupFulfillmentV1 =>
      f.orderId === state.orderId && f.kind === "pickup",
  );
  if (
    order === undefined ||
    payment === undefined ||
    fulfillment === undefined
  ) {
    return fail("counter_sale_after_sale_not_found", 409);
  }
  return ok({ sale: sale.value, snapshot: snapshot.value, order, payment, fulfillment });
}

async function refundCounterSale(
  deps: CounterRegisterDeps,
  placed: PlacedCounterSale,
  idempotencyKey: string,
  manualCash: boolean,
  reason?: string,
) {
  const locationId =
    placed.sale.checkout.source.kind === "point_of_sale"
      ? placed.sale.checkout.source.pantryLocationId
      : "";
  const configuration = await deps.client.readPointOfSaleConfiguration(
    deps.merchantId,
    locationId,
  );
  if (!configuration.ok) return configuration;
  const payload = {
    merchantId: deps.merchantId,
    expectedMerchantRevision: placed.snapshot.merchantRevision,
    idempotencyKey,
    orderId: placed.order.id,
    orderRevision: placed.order.revision,
    paymentId: placed.payment.id,
    paymentRevision: placed.payment.revision,
    refundAttemptId: `refund_${idempotencyKey}`,
    refundPolicyId: configuration.value.afterSalePolicy.refundPolicyId,
    amount: placed.payment.amount,
    allocation: fullRefundAllocation(placed.order),
    reason:
      reason ??
      (manualCash
        ? "Counter sale refunded in cash from register drawer"
        : "Counter sale returned in full"),
  };
  return manualCash
    ? deps.client.recordCounterManualCashRefund(payload)
    : deps.client.refundOrder(payload);
}

function fullRefundAllocation(order: CommerceOrderV1) {
  const lineAllocations = [];
  const taxAllocations = [];
  const taxIncluded = order.totals.taxIncluded === true;
  for (const line of order.lineItems) {
    lineAllocations.push({ orderLineId: line.id, amount: line.lineTotal });
    if (!taxIncluded && line.tax.amountMinor > 0) {
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

async function buildCounterSaleView(
  deps: CounterRegisterDeps,
  sale: CommerceCounterSaleV1,
): Promise<CounterRegisterResult<CounterSaleView>> {
  const state = readCounterSaleState(sale);
  if (state.orderId === null) {
    return ok({ ...state, afterSale: null });
  }
  const snapshot = await deps.client.readSnapshot(deps.merchantId);
  if (!snapshot.ok) return commerceFail(snapshot.error);
  const order = snapshot.value.resources.orders.find(
    (o) => o.id === state.orderId,
  );
  const payment = snapshot.value.resources.payments.find(
    (p) => p.orderId === state.orderId,
  );
  const fulfillment = snapshot.value.resources.fulfillments.find(
    (f): f is CommercePickupFulfillmentV1 =>
      f.orderId === state.orderId && f.kind === "pickup",
  );
  if (
    order === undefined ||
    payment === undefined ||
    fulfillment === undefined
  ) {
    return fail("counter_sale_after_sale_not_found", 409);
  }
  return ok({
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
  });
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

function resolveRegisterLocationId(
  stock: CommerceStockSnapshot,
  requestedLocationId?: string | null,
): string {
  if (requestedLocationId && requestedLocationId.length > 0) {
    return requestedLocationId;
  }
  const cafeMenu = stock.foodService.resources.menus.find(
    (m) => m.menuId === DEFAULT_CAFE_MENU_ID,
  );
  if (cafeMenu?.scope.kind === "location") {
    return cafeMenu.scope.locationId;
  }
  const anyLocationMenu = stock.foodService.resources.menus.find(
    (m) => m.scope.kind === "location",
  );
  if (anyLocationMenu?.scope.kind === "location") {
    return anyLocationMenu.scope.locationId;
  }
  return stock.commerce.resources.locations[0]?.id ?? "";
}

function buildRegisterMenu(
  stock: CommerceStockSnapshot,
  marks: CommerceSoldOutMarksV1,
  locationId: string,
  menuId: string,
): CounterRegisterMenu | null {
  const menu =
    stock.foodService.resources.menus.find(
      (candidate) =>
        candidate.menuId === menuId && candidate.lifecycle.state === "published",
    ) ??
    stock.foodService.resources.menus.find(
      (candidate) => candidate.lifecycle.state === "published",
    );
  if (menu === undefined) return null;

  const { offers, variants, products } = stock.commerce.resources;
  const groups = stock.foodService.resources.modifierGroupRevisions;
  const entriesBySection = new Map<string, CounterRegisterMenuEntry[]>();

  for (const entry of menu.entries) {
    if (entry.lifecycle !== "active") continue;
    const offer = offers.find((o) => o.id === entry.offerId);
    const variant = variants.find((v) => v.id === offer?.variantId);
    const product = products.find((p) => p.id === variant?.productId);
    if (offer === undefined || variant === undefined || product === undefined) {
      continue;
    }
    const soldOutUntil =
      marks.marks.find(
        (m) => m.locationId === locationId && m.variantId === variant.id,
      )?.until ?? null;

    const modifierGroups: CounterRegisterModifierGroup[] = [];
    for (const ref of entry.modifierGroupRevisions) {
      const group = groups.find(
        (g) =>
          g.modifierGroupId === ref.modifierGroupId &&
          g.revision === ref.revision,
      );
      if (group === undefined) continue;
      modifierGroups.push({
        modifierGroupId: group.modifierGroupId,
        revision: group.revision,
        name: group.name,
        minimumSelections: group.minimumSelections,
        maximumSelections: group.maximumSelections,
        options: group.options.map((opt) => ({
          modifierOptionId: opt.modifierOptionId,
          name: opt.name,
          priceDeltaMinor: opt.priceDelta.amountMinor,
          currency: opt.priceDelta.currency,
        })),
      });
    }

    const mapped: CounterRegisterMenuEntry = {
      menuEntryId: entry.menuEntryId,
      sectionId: entry.sectionId,
      offerId: offer.id,
      variantId: variant.id,
      title: product.title,
      description: product.description ?? null,
      unitPrice: {
        amountMinor: offer.price.amountMinor,
        currency: offer.price.currency,
      },
      soldOutUntil,
      available:
        soldOutUntil === null && offer.lifecycle.state === "listed",
      modifierGroups,
    };
    const bucket = entriesBySection.get(entry.sectionId) ?? [];
    bucket.push(mapped);
    entriesBySection.set(entry.sectionId, bucket);
  }

  const sections: CounterRegisterMenuSection[] = [...menu.sections]
    .sort((a, b) => a.position - b.position)
    .map((section) => ({
      sectionId: section.sectionId,
      name: section.name,
      position: section.position,
      entries: entriesBySection.get(section.sectionId) ?? [],
    }))
    .filter((section) => section.entries.length > 0);

  return { menuId: menu.menuId, name: menu.name, sections };
}

async function readRegisterTerminal(
  deps: CounterRegisterDeps,
  locationId: string,
): Promise<CounterRegisterTerminal> {
  if (locationId.length === 0) {
    return emptyTerminal("no_location");
  }
  const assignment = await readActiveTerminalAssignment(
    deps.scope.database,
    deps.organisationId,
    locationId,
  );
  if (!assignment.ok) {
    return emptyTerminal("terminal_not_assigned");
  }
  return describeAssignedTerminal(assignment.value);
}

function describeAssignedTerminal(
  assignment: TerminalAssignment,
): CounterRegisterTerminal {
  const binding = terminalAssignmentPaymentBinding(assignment);
  if (!binding.ok) {
    return emptyTerminal("assignment_retired");
  }
  const target = assignment.target;
  return {
    assigned: true,
    provider: binding.value.provider,
    assignmentRevision: assignment.revision,
    targetKind: target.kind,
    deviceId: terminalTargetDeviceId(target),
    gatewayId: target.kind === "lan_gateway_device" ? target.gatewayId : null,
    deviceSourceKey:
      target.kind === "lan_gateway_device" ? target.deviceSourceKey : null,
    ready: true,
    blockedReason: null,
    supportedMethods: ALL_JAPAN_METHODS,
  };
}

function emptyTerminal(blockedReason: string): CounterRegisterTerminal {
  return {
    assigned: false,
    provider: null,
    assignmentRevision: null,
    targetKind: null,
    deviceId: null,
    gatewayId: null,
    deviceSourceKey: null,
    ready: false,
    blockedReason,
    supportedMethods: [],
  };
}
