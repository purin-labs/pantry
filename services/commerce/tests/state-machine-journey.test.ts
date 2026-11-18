// Plan 77 step 1: every lifecycle move goes through its state machine. This
// journey drives the checkout, payment attempt, payment, payment dispute,
// order, pickup fulfillment and refund attempt machines over HTTP. In each state that it reaches, it asks for the
// moves that a buyer or staff can ask for. A move that the machine allows
// applies, or a guard of the move refuses it with its own error. A move that
// the machine forbids answers `invalid_transition` with the machine, the state
// and the event, and changes nothing. The evidence is the transition matrix.
// A cell that this journey does not reach names its reason, or the journey
// that drives it. Set STATE_MACHINE_ARTIFACT_DIR to keep the matrix; the file
// repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceMutationResultV1,
  CommerceStorefrontClient,
} from "@seams/commerce-client";
import type { CommerceMachineName } from "@seams/commerce-contracts";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  catalogLine,
  jpy,
  merchantId,
  organisationId,
  rejectionOf,
  startBackend,
  writeEvidence,
  type Quoted,
} from "./journey-support.ts";
import {
  LARGE_SENCHA,
  OrderDesk,
  SMALL_SENCHA,
  placeAtStorefront,
  type PlacedOrder,
} from "./order-desk.ts";
import { TransitionMatrix } from "./transition-matrix.ts";

/** The account of the journey backend's deterministic payment gateway. */
const PAYMENT_BINDING = {
  provider: "stripe_online",
  account: {
    integrationAccountId: "integration_stripe_deterministic",
    providerAccountId: "acct_deterministic",
    environment: "development",
    capabilityRevision: 1,
    country: "JP",
    currency: "JPY",
  },
  collection: "embedded_tokenization",
} as const;

/**
 * The cells that this journey does not reach, as `machine state event`
 * patterns (`*` matches any state or event), with the reason. Every cell
 * that the journey does not probe must match one pattern, and every pattern
 * must match a cell that the journey does not probe.
 */
const MACHINES: readonly CommerceMachineName[] = [
  "checkout",
  "payment_attempt",
  "payment",
  "payment_dispute",
  "order",
  "pickup_fulfillment",
  "refund_attempt",
];

const NOT_REACHED: Readonly<Record<string, string>> = {
  "pickup_fulfillment * prepare":
    "checkout-persistence.test.ts prepares food-service tickets for a pickup",
  "checkout * place_with_stored_value":
    "The route takes only a checkout that gift cards pay; gift-card-journey.test.ts drives it",
  "checkout * place_manually":
    "Only a draft's own checkout takes a manual payment; manual-tender-journey.test.ts drives it",
  "payment_attempt declined *":
    "A decline expires the checkout, so the checkout machine answers first",
  "order partially_fulfilled *":
    "No pickup order holds two open fulfillments, so a completion always fulfils the whole order",
  "order * complete_pickup_part":
    "One completion command asks for complete_pickup; the order's lines decide the part move after the state check",
  "order * deliver":
    "plan33-core-acceptance.test.ts delivers a shipping order through carrier tracking",
  "order * deliver_part": "A shipping order has one shipment",
  "order * prepare":
    "checkout-persistence.test.ts prepares food-service tickets for a pickup order",
  "order * resolve_cancellation":
    "Underclerk resolves a cancellation's refund itself, inside cancel_order",
  "order fulfilled exchange":
    "exchange-journey.test.ts exchanges received units of a fulfilled order",
  "order fulfilled pay_balance":
    "A balance checkout opens only while the order waits for fulfilment",
  "order cancelled pay_balance":
    "A balance checkout opens only while the order waits for fulfilment",
  "payment partially_refunded record_dispute":
    "stripe-after-sale-journey.test.ts records a dispute of a refunded card payment",
  "payment refunded record_dispute":
    "stripe-after-sale-journey.test.ts records a dispute of a refunded card payment",
  "payment captured refund_part":
    "Underclerk moves the payment when the provider answers a refund; this journey refunds through request_refund",
  "payment captured refund_rest":
    "Underclerk moves the payment when the provider answers a refund; this journey refunds through request_refund",
  "payment partially_refunded refund_part":
    "Underclerk moves the payment when the provider answers a refund; this journey refunds through request_refund",
  "payment partially_refunded refund_rest":
    "Underclerk moves the payment when the provider answers a refund; this journey refunds through request_refund",
  "payment refunded refund_part":
    "Underclerk moves the payment only inside a refund, which request_refund already refuses",
  "payment refunded refund_rest":
    "Underclerk moves the payment only inside a refund, which request_refund already refuses",
  "refund_attempt requested *":
    "The deterministic gateway answers a refund inside the request; stripe-after-sale-journey.test.ts holds a refund open",
  "refund_attempt processing *":
    "stripe-after-sale-journey.test.ts drives a slow refund answer",
  "refund_attempt indeterminate *":
    "stripe-after-sale-journey.test.ts drives a lost refund answer",
  "refund_attempt failed *":
    "stripe-after-sale-journey.test.ts drives a refused refund",
  "refund_attempt succeeded *":
    "The merchant's alarm reads only open refunds, and a repeated refund command replays its receipt",
};

it(
  "moves checkouts, payments, orders and refunds only as their machines allow",
  { timeout: 90_000 },
  driveStateMachines,
);

async function driveStateMachines(): Promise<void> {
  const clock = { now: NOW };
  const backend = await startBackend({ now: () => clock.now });
  const matrix = new TransitionMatrix(MACHINES, NOT_REACHED);
  try {
    const { admin, buyer } = backend;
    const staff = new MachineDesk(admin);
    await staff.createTea();

    // A spare attempt lets the journey ask for a capture, a progress report,
    // a placement or a decline of a checkout that has no attempt of its own:
    // the machine answers before the attempt's checkout is compared.
    const spare = await staff.paymentPending(
      await quote(buyer, "spare"),
      "attempt_spare",
    );

    // Quoted: only a payment start, a refresh or an expiry may follow.
    const aki = await quote(buyer, "aki");
    await probeCheckout(staff, buyer, matrix, aki, "quoted", spare);
    matrix.check("checkout", "quoted", "refresh", await refresh(buyer, aki));
    aki.revision += 1;
    aki.quoteDigest = aki.refreshed?.quoteDigest ?? aki.quoteDigest;
    const expiring = await quote(buyer, "ema");
    clock.now = expiring.expiresAt;
    matrix.check("checkout", "quoted", "expire", await staff.expire(expiring));
    clock.now = NOW;

    // Payment pending, with an attempt in each open state.
    await staff.begin(aki, "attempt_aki");
    matrix.observed("checkout", "quoted", "begin_payment", "applied");
    await probeCheckout(staff, buyer, matrix, aki, "payment_pending", spare);
    for (const from of ["pending", "processing", "indeterminate"] as const) {
      for (const event of [
        "capture",
        "report_processing",
        "report_indeterminate",
        "decline",
      ] as const) {
        const name = `${from.slice(0, 4)}_${event}`;
        const record = await staff.paymentPending(
          await quote(buyer, name),
          `attempt_${name}`,
        );
        if (from !== "pending") await staff.report(record, from);
        const result = await staff.answer(record, event);
        matrix.check("payment_attempt", from, event, result);
        if (event === "decline" && result.outcome === "applied")
          matrix.observed("checkout", "payment_pending", "decline", "applied");
        if (event !== "decline" && event !== "capture")
          matrix.observed(
            "checkout",
            "payment_pending",
            "record_progress",
            "applied",
          );
        if (event === "capture")
          matrix.observed(
            "checkout",
            "payment_pending",
            "record_capture",
            "applied",
          );
      }
    }

    // A captured attempt takes no other answer, and the paid checkout
    // takes nothing more.
    const cam = await staff.paymentPending(
      await quote(buyer, "cam"),
      "attempt_cam",
    );
    await staff.answer(cam, "capture");
    for (const event of [
      "capture",
      "report_processing",
      "report_indeterminate",
      "decline",
    ] as const)
      matrix.check(
        "payment_attempt",
        "captured",
        event,
        await staff.answer(cam, event),
      );
    await staff.place(cam);
    matrix.observed("checkout", "payment_pending", "place", "applied");
    await probeCheckout(staff, buyer, matrix, cam, "accepted", spare);

    // The bank disputes Cam's payment four times. Each dispute moves while
    // it is open and ends once; a finished dispute takes no other answer.
    clock.now = minutesAfter(30);
    const dispute = (reference: string, at: number, lifecycle: DisputeState) =>
      staff.observeDispute(cam, reference, at, lifecycle);
    const opened = (at: number) => ({
      state: "action_required" as const,
      observedAt: minutesAfter(at),
      responseDueAt: minutesAfter(60 * 24 * 7),
    });
    const reviewed = (at: number) => ({
      state: "under_review" as const,
      observedAt: minutesAfter(at),
    });
    const ended = (state: "won" | "lost", at: number) => ({
      state,
      resolvedAt: minutesAfter(at),
    });
    for (const reference of ["dp_one", "dp_two", "dp_three", "dp_four"])
      expect(await dispute(reference, 1, opened(1))).toMatchObject({
        outcome: "applied",
      });
    matrix.observed("payment", "captured", "record_dispute", "applied");
    const steps: readonly (readonly [
      string,
      DisputeEvent,
      string,
      number,
      DisputeState,
    ])[] = [
      ["dp_one", "report_action_required", "action_required", 2, opened(2)],
      ["dp_one", "report_under_review", "action_required", 3, reviewed(3)],
      ["dp_one", "report_under_review", "under_review", 4, reviewed(4)],
      ["dp_one", "report_action_required", "under_review", 5, opened(5)],
      ["dp_one", "win", "action_required", 6, ended("won", 6)],
      ["dp_two", "lose", "action_required", 2, ended("lost", 2)],
      ["dp_three", "report_under_review", "action_required", 2, reviewed(2)],
      ["dp_three", "lose", "under_review", 3, ended("lost", 3)],
      ["dp_four", "report_under_review", "action_required", 2, reviewed(2)],
      ["dp_four", "win", "under_review", 3, ended("won", 3)],
    ];
    for (const [reference, event, state, at, lifecycle] of steps)
      matrix.check(
        "payment_dispute",
        state,
        event,
        await dispute(reference, at, lifecycle),
      );
    for (const [reference, state] of [
      ["dp_one", "won"],
      ["dp_two", "lost"],
    ] as const) {
      const probes: readonly (readonly [DisputeEvent, DisputeState])[] = [
        ["report_action_required", opened(10)],
        ["report_under_review", reviewed(10)],
        ["win", ended("won", 10)],
        ["lose", ended("lost", 10)],
      ];
      for (const [event, lifecycle] of probes)
        matrix.check(
          "payment_dispute",
          state,
          event,
          await dispute(reference, 10, lifecycle),
        );
    }
    clock.now = NOW;

    // Expired: a declined checkout and a lapsed one take nothing more.
    const cai = await staff.paymentPending(
      await quote(buyer, "cai"),
      "attempt_cai",
    );
    await staff.answer(cai, "decline");
    await probeCheckout(staff, buyer, matrix, cai, "expired", spare);
    await probeCheckout(staff, buyer, matrix, expiring, "expired", spare);

    // Ben pays at the storefront and keeps the order link. While the order
    // waits for pickup, a return or an exchange waits for the handover.
    const ben = await placeAtStorefront(buyer, "ben");
    await probeOrder(staff, buyer, matrix, ben, "fulfillment_pending");
    const benLine = await staff.lineId(ben.orderId);
    // Staff add a large tin, so the order owes 1,980 yen; Ben opens the
    // balance from the order link and pays it.
    matrix.check(
      "order",
      "fulfillment_pending",
      "edit",
      await staff.editOrder(ben.orderId, LARGE_SENCHA),
    );
    matrix.observed("pickup_fulfillment", "requested", "edit", "applied");
    const balance = await openBalance(buyer, ben);
    matrix.check(
      "order",
      "fulfillment_pending",
      "open_balance",
      balance.result,
    );
    if (balance.pay === undefined)
      throw new Error("Ben's balance did not open");
    expect(await balance.pay()).toBe(ben.orderId);
    matrix.observed("order", "fulfillment_pending", "pay_balance", "applied");
    expect((await staff.changes(ben.orderId)).balance.outstanding).toEqual(
      jpy(0),
    );
    // Staff refund 100 yen of the first payment.
    matrix.check(
      "order",
      "fulfillment_pending",
      "refund",
      await staff.refund(ben.orderId, benLine, "refund_ben_part", 100),
    );
    matrix.observed("payment", "captured", "request_refund", "applied");
    matrix.observed("refund_attempt", "requested", "succeed", "applied");
    // The pickup is not ready, so it cannot be handed over yet.
    matrix.check(
      "pickup_fulfillment",
      "requested",
      "complete",
      await staff.completePickup(ben.orderId),
    );
    matrix.check(
      "order",
      "fulfillment_pending",
      "ready_pickup",
      await staff.markReady(ben.orderId),
    );
    matrix.observed("pickup_fulfillment", "requested", "ready", "applied");
    // A ready pickup takes no edit and no cancellation, and is ready once.
    matrix.check(
      "pickup_fulfillment",
      "ready_for_pickup",
      "edit",
      await staff.editOrder(ben.orderId, SMALL_SENCHA),
    );
    matrix.check(
      "pickup_fulfillment",
      "ready_for_pickup",
      "ready",
      await staff.markReady(ben.orderId),
    );
    matrix.check(
      "pickup_fulfillment",
      "ready_for_pickup",
      "cancel",
      await staff.cancel(ben.orderId),
    );
    matrix.check(
      "order",
      "fulfillment_pending",
      "complete_pickup",
      await staff.completePickup(ben.orderId),
    );
    matrix.observed(
      "pickup_fulfillment",
      "ready_for_pickup",
      "complete",
      "applied",
    );
    // A completed pickup belongs to a fulfilled order, which answers first.
    await probePickup(staff, matrix, ben.orderId, "completed", "fulfilled");

    // Fulfilled: the order takes a return and refunds, nothing that edits it
    // or hands it over again.
    await probeOrder(staff, buyer, matrix, ben, "fulfilled");
    matrix.check(
      "order",
      "fulfilled",
      "request_return",
      await staff.requestReturn(ben.orderId, benLine),
    );
    matrix.check(
      "order",
      "fulfilled",
      "refund",
      await staff.refund(ben.orderId, benLine, "refund_ben_more", 100),
    );
    matrix.observed(
      "payment",
      "partially_refunded",
      "request_refund",
      "applied",
    );

    // Dan's order is cancelled before pickup. The cancellation refunds the
    // whole payment, so a later refund of it is refused by the payment.
    const dan = await placeAtStorefront(buyer, "dan");
    matrix.check(
      "order",
      "fulfillment_pending",
      "cancel",
      await staff.cancel(dan.orderId),
    );
    matrix.observed("pickup_fulfillment", "requested", "cancel", "applied");
    await probeOrder(staff, buyer, matrix, dan, "cancelled");
    await probePickup(staff, matrix, dan.orderId, "cancelled", "cancelled");
    matrix.observed(
      "order",
      "cancelled",
      "refund",
      "allowed; the refunded payment refuses it",
    );
    matrix.check(
      "payment",
      "refunded",
      "request_refund",
      await staff.refund(
        dan.orderId,
        await staff.lineId(dan.orderId),
        "refund_dan_again",
        100,
      ),
    );

    const report = matrix.report();
    expect(report.unexplained).toEqual([]);
    expect(report.stalePatterns).toEqual([]);
    writeEvidence("STATE_MACHINE_ARTIFACT_DIR", "state-machines", {
      clock: NOW,
      merchantId,
      cells: report.cells,
      notReached: report.notReached,
    });
  } finally {
    backend.close();
  }
}

/** Asks for every checkout move, and checks that nothing changed. */
async function probeCheckout(
  staff: MachineDesk,
  buyer: CommerceStorefrontClient,
  matrix: TransitionMatrix,
  record: CheckoutRecord,
  state: "quoted" | "payment_pending" | "accepted" | "expired",
  spare: CheckoutRecord,
): Promise<void> {
  const before = await staff.merchantRevision();
  const attempt = record.attempt ?? spare.attempt;
  const target = { ...record, attempt };
  const asks: readonly (readonly [
    string,
    () => Promise<CommerceMutationResultV1>,
  ])[] = [
    [
      "begin_payment",
      () => staff.beginRaw(record, `attempt_${record.name}_again`),
    ],
    ["record_capture", () => staff.answer(target, "capture", false)],
    ["record_progress", () => staff.answer(target, "report_processing", false)],
    ["decline", () => staff.answer(target, "decline", false)],
    ["place", () => staff.placeRaw(target, `${record.name}_probe`)],
    ["expire", () => staff.expire(record)],
    ["refresh", () => refresh(buyer, record)],
  ];
  for (const [event, ask] of asks) {
    if (matrix.allowed("checkout", state, event)) continue;
    matrix.check("checkout", state, event, await ask());
  }
  expect(await staff.merchantRevision()).toBe(before);
}

/** Asks for the pickup moves of an order that already answers first. */
async function probePickup(
  staff: MachineDesk,
  matrix: TransitionMatrix,
  orderId: string,
  state: "completed" | "cancelled",
  orderState: "fulfilled" | "cancelled",
): Promise<void> {
  const asks = [
    ["edit", "edit", () => staff.editOrder(orderId, SMALL_SENCHA)],
    ["ready", "ready_pickup", () => staff.markReady(orderId)],
    ["complete", "complete_pickup", () => staff.completePickup(orderId)],
    ["cancel", "cancel", () => staff.cancel(orderId)],
  ] as const;
  for (const [event, orderEvent, ask] of asks)
    matrix.check("pickup_fulfillment", state, event, await ask(), {
      machine: "order",
      state: orderState,
      event: orderEvent,
    });
}

/** Asks for every order move that the order's state forbids. */
async function probeOrder(
  staff: MachineDesk,
  buyer: CommerceStorefrontClient,
  matrix: TransitionMatrix,
  placed: PlacedOrder,
  state: "fulfillment_pending" | "fulfilled" | "cancelled",
): Promise<void> {
  const before = await staff.merchantRevision();
  const { orderId } = placed;
  const line = await staff.lineId(orderId);
  const asks: readonly (readonly [
    string,
    () => Promise<CommerceMutationResultV1>,
  ])[] = [
    ["edit", () => staff.editOrder(orderId, SMALL_SENCHA)],
    ["open_balance", async () => (await openBalance(buyer, placed)).result],
    ["ready_pickup", () => staff.markReady(orderId)],
    ["complete_pickup", () => staff.completePickup(orderId)],
    ["cancel", () => staff.cancel(orderId)],
    ["exchange", () => staff.exchange(orderId)],
    ["request_return", () => staff.requestReturn(orderId, line)],
    ["refund", () => staff.refund(orderId, line, `refund_probe_${state}`, 100)],
  ];
  for (const [event, ask] of asks) {
    if (matrix.allowed("order", state, event)) continue;
    matrix.check("order", state, event, await ask());
  }
  expect(await staff.merchantRevision()).toBe(before);
}

type DisputeEvent =
  "report_action_required" | "report_under_review" | "win" | "lose";

type DisputeState =
  | Readonly<{
      state: "action_required";
      observedAt: string;
      responseDueAt: string;
    }>
  | Readonly<{ state: "under_review"; observedAt: string }>
  | Readonly<{ state: "won" | "lost"; resolvedAt: string }>;

/** A time `minutes` after the journey's clock starts. */
function minutesAfter(minutes: number): string {
  return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

type CheckoutRecord = {
  name: string;
  token: string;
  checkoutId: string;
  revision: number;
  quoteDigest: string;
  expiresAt: string;
  amount: Readonly<{ amountMinor: number; currency: string }>;
  lines: readonly ReturnType<typeof catalogLine>[];
  attempt?: { id: string; revision: number };
  refreshed?: Readonly<{ quoteDigest: string }>;
};

async function quote(
  client: CommerceStorefrontClient,
  name: string,
): Promise<CheckoutRecord> {
  const buyer = await Buyer.start(client, name);
  const lines = [catalogLine(SMALL_SENCHA)];
  const checkout: Quoted = await buyer.quote(lines);
  return {
    name,
    token: buyer.token,
    checkoutId: checkout.checkoutId,
    revision: checkout.revision,
    quoteDigest: checkout.quote.quoteDigest,
    expiresAt: checkout.quote.expiresAt,
    amount: checkout.quote.totals.total,
    lines,
  };
}

async function refresh(
  client: CommerceStorefrontClient,
  record: CheckoutRecord,
): Promise<CommerceMutationResultV1> {
  const result = await client.refreshPickupCheckout(
    merchantId,
    STOREFRONT,
    record.checkoutId,
    record.token,
    {
      schemaVersion: "underclerk.refresh-buyer-pickup-checkout.v1",
      idempotencyKey: `${record.name}_refresh_${record.revision}`,
      checkoutRevision: record.revision,
      quoteDigest: record.quoteDigest,
      lines: record.lines,
    },
  );
  if (!result.ok) return refusal(result);
  record.refreshed = { quoteDigest: result.value.quote.quoteDigest };
  return appliedByBuyer("refresh");
}

/** Opens the order's balance from the order link. */
async function openBalance(
  client: CommerceStorefrontClient,
  placed: PlacedOrder,
): Promise<
  Readonly<{ result: CommerceMutationResultV1; pay?: () => Promise<string> }>
> {
  const opened = await client.openOrderBalance(
    merchantId,
    STOREFRONT,
    placed.checkoutId,
    placed.recoveryToken,
  );
  if (!opened.ok) return { result: refusal(opened) };
  const payer = new Buyer(
    client,
    `${placed.orderId}_balance`,
    opened.value.session.token,
  );
  return {
    result: appliedByBuyer("open_order_balance"),
    pay: () => payer.pay(opened.value.checkout),
  };
}

/** The rejection of a buyer route, as a mutation result. */
function refusal(
  result: Parameters<typeof rejectionOf>[0],
): CommerceMutationResultV1 {
  const error = rejectionOf(result);
  if (error === undefined) throw new Error("The buyer route did not refuse");
  return { outcome: "rejected", error };
}

/** A buyer route answers with its own shape; the matrix needs only success. */
function appliedByBuyer(name: string): CommerceMutationResultV1 {
  return {
    outcome: "applied",
    receipt: { commandKind: name },
  } as unknown as CommerceMutationResultV1;
}

class MachineDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "machines");
  }

  /** The bank's report of a dispute on the record's card payment. */
  async observeDispute(
    record: CheckoutRecord,
    reference: string,
    at: number,
    lifecycle: DisputeState,
  ) {
    const attempt = record.attempt;
    if (attempt === undefined) throw new Error(`${record.name} has no attempt`);
    return this.edit(
      this.admin.observePaymentDispute({
        schemaVersion: "underclerk.observe-payment-dispute.v1",
        organisationId,
        merchantId,
        providerDeliveryId: `${reference}_${at}_${lifecycle.state}`,
        receivedAt: minutesAfter(at),
        checkoutId: record.checkoutId,
        paymentAttemptId: attempt.id,
        providerPaymentReference: `pi_${attempt.id}`,
        providerDisputeReference: reference,
        amount: record.amount,
        reason: "cardholder_claim",
        evidenceReferences: [],
        lifecycle,
      }),
    );
  }

  async paymentPending(record: CheckoutRecord, attemptId: string) {
    await this.begin(record, attemptId);
    return record;
  }

  async begin(record: CheckoutRecord, attemptId: string): Promise<void> {
    const result = await this.beginRaw(record, attemptId);
    if (result.outcome !== "applied")
      throw new Error(
        `${record.name} payment did not start: ${JSON.stringify(result)}`,
      );
    record.revision += 1;
    record.attempt = { id: attemptId, revision: 1 };
  }

  async beginRaw(record: CheckoutRecord, attemptId: string) {
    return this.edit(
      this.admin.beginCheckoutPayment({
        ...(await this.base(`begin_${attemptId}`)),
        checkoutId: record.checkoutId,
        checkoutRevision: record.revision,
        quoteDigest: record.quoteDigest,
        paymentAttemptId: attemptId,
        providerRequestId: `provider_${attemptId}`,
        amount: record.amount,
        paymentBinding: PAYMENT_BINDING,
      }),
    );
  }

  /** Moves an open attempt to processing or indeterminate. */
  async report(record: CheckoutRecord, to: "processing" | "indeterminate") {
    const result = await this.answer(
      record,
      to === "processing" ? "report_processing" : "report_indeterminate",
    );
    if (result.outcome !== "applied")
      throw new Error(`${record.name} did not report ${to}`);
  }

  /** Sends a provider's answer for the record's attempt. */
  async answer(
    record: CheckoutRecord,
    event: "capture" | "report_processing" | "report_indeterminate" | "decline",
    track = true,
  ): Promise<CommerceMutationResultV1> {
    const attempt = record.attempt;
    if (attempt === undefined) throw new Error(`${record.name} has no attempt`);
    const common = {
      checkoutId: record.checkoutId,
      checkoutRevision: record.revision,
      quoteDigest: record.quoteDigest,
      paymentAttemptId: attempt.id,
      paymentAttemptRevision: attempt.revision,
    };
    const result =
      event === "capture"
        ? await this.edit(
            this.admin.recordCheckoutPaymentCapture({
              ...(await this.base(`capture_${attempt.id}`)),
              ...common,
              providerPaymentReference: `pi_${attempt.id}`,
              capturedAt: NOW,
            }),
          )
        : await this.edit(
            this.admin.resolveCheckoutPayment({
              ...(await this.base(`resolve_${attempt.id}`)),
              ...common,
              outcome:
                event === "decline"
                  ? { kind: "declined", reasonCode: "card_declined" }
                  : {
                      kind:
                        event === "report_processing"
                          ? "processing"
                          : "indeterminate",
                      reasonCode: "provider_slow",
                      reconcileAfter: NOW,
                    },
            }),
          );
    if (track && result.outcome === "applied") {
      attempt.revision += 1;
      if (event === "decline") record.revision += 1;
    }
    return result;
  }

  async place(record: CheckoutRecord): Promise<string> {
    const result = await this.placeRaw(record);
    if (result.outcome !== "applied")
      throw new Error(
        `${record.name} was not placed: ${JSON.stringify(result)}`,
      );
    record.revision += 1;
    return `order_${record.name}`;
  }

  /** Places the record; `name` keeps a probe's order apart from the real one. */
  async placeRaw(record: CheckoutRecord, name = record.name) {
    const attempt = record.attempt;
    if (attempt === undefined) throw new Error(`${record.name} has no attempt`);
    return this.edit(
      this.admin.placePaidCheckout({
        ...(await this.base(`place_${record.name}`)),
        checkoutId: record.checkoutId,
        checkoutRevision: record.revision,
        quoteDigest: record.quoteDigest,
        paymentAttemptId: attempt.id,
        paymentAttemptRevision: attempt.revision,
        orderId: `order_${name}`,
        paymentId: `payment_${name}`,
        fulfillmentId: `fulfillment_${name}`,
        buyer: { kind: "guest" },
        placement: { kind: "pickup" },
      }),
    );
  }

  async expire(record: CheckoutRecord) {
    const result = await this.edit(
      this.admin.expireCheckout({
        ...(await this.base(`expire_${record.name}`)),
        checkoutId: record.checkoutId,
        checkoutRevision: record.revision,
        quoteDigest: record.quoteDigest,
      }),
    );
    if (result.outcome === "applied") record.revision += 1;
    return result;
  }
}
