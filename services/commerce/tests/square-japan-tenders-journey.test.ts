// Plan 90 Phase 3A: Square Terminal Japan multi-tender (CARD_PRESENT,
// FELICA_ALL, QR_CODE), payment readback verification, FeliCa manual cash
// refund accounting without calling Square Refunds API, and switching a
// cancelled terminal prompt to cash. Phase 3B: the same tenders through the
// Square Point of Sale app on the Register's iPad, where the app's answer is
// only a hint until Commerce reads the order and the payment from Square.
// The fake answers with Square's documented Payment shapes: e-money is a
// CARD payment with card brand FELICA and electronic_money_details.
// Set SQUARE_JAPAN_TENDERS_ARTIFACT_DIR to keep repeatable evidence.
import type {
  CommerceAdminClient,
  CommerceCounterSaleV1,
  CommerceOrderV1,
  CommercePaymentV1,
} from "@purin-labs/commerce-client";
import type {
  InPersonPaymentBinding,
  InPersonPaymentMethod,
} from "@purin-labs/commerce-contracts";
import type { CommerceCounterSaleHandoffResultV1 } from "@purin-labs/commerce-contracts/records/api-admin";
import { isRecord } from "@purin-labs/std";
import { expect, it } from "vitest";

import {
  CHANNEL,
  LOCATION,
  NOW,
  StaffDesk,
  jpy,
  merchantId,
  organisationId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SELLER = "SQUARE_SELLER_JP";
const SQUARE_LOCATION = "SQUARE_LOC_TOKYO";
const DEVICE = "DEVICE_JP_TERM_1";
const BINDING_ID = "binding_square_jp_terminal";
const OAUTH = {
  environment: "development" as const,
  clientId: "sandbox-sq0idb-jp",
  clientSecret: "sandbox-secret-jp",
};
const ACCOUNT: InPersonPaymentBinding["account"] = {
  integrationAccountId: `commerce_square_${SELLER}`,
  providerAccountId: SELLER,
  environment: "development",
  capabilityRevision: 1,
  country: "JP",
  currency: "JPY",
};

it(
  "verifies Square Japan Card, FeliCa, and QR tenders, refunds FeliCa in cash without calling Square Refunds API, and allows switching cancelled terminal prompts to cash",
  { timeout: 60_000 },
  squareJapanTendersJourney,
);

it(
  "settles Square Point of Sale app handoffs only after reading the order and payment from Square, and refuses forged, replayed and mismatched answers",
  { timeout: 60_000 },
  squarePosAppHandoffJourney,
);

/** Connects the Square Japan account, links the Tokyo location and opens the counter. */
async function openJapanCounter(square: FakeJapanSquare) {
  const backend = await startBackend({
    square: { fetch: square.fetch, oauth: OAUTH },
  });
  const { admin } = backend;
  const desk = new JapanTerminalDesk(admin);
  await required(
    admin.connectSquare(merchantId, {
      environment: "development",
      grant: { kind: "authorization_code", code: "jp-cafe-code" },
    }),
  );
  await required(
    admin.linkSquareAccount(merchantId, {
      paymentProviderBindingId: BINDING_ID,
      locationId: SQUARE_LOCATION,
    }),
  );
  await desk.publishCashAndTerminalPolicy();
  return { backend, admin, desk };
}

async function squareJapanTendersJourney(): Promise<void> {
  const square = new FakeJapanSquare();
  const { backend, admin, desk } = await openJapanCounter(square);
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const binding: InPersonPaymentBinding = {
      provider: "square_terminal",
      account: ACCOUNT,
      locationId: SQUARE_LOCATION,
      deviceId: DEVICE,
      transport: "server_terminal",
    };

    // 1. Card sale (CARD_PRESENT -> CARD / VISA, providerRefundable: true -> Square refund works).
    const cardSale = await desk.sellOnTerminal("card_1", "card", binding);
    expect(square.createdPaymentTypes).toEqual(["CARD_PRESENT"]);
    expect(cardSale.sale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "card",
      tenderBrand: "VISA",
      providerRefundable: true,
    });
    const cardRefund = await desk.providerRefund(
      cardSale.order,
      cardSale.payment,
      "refund_card_1",
    );
    expect(cardRefund).toMatchObject({ outcome: "applied" });
    expect(square.refundRequests).toHaveLength(1);

    // 2. FeliCa sale (FELICA_ALL -> FELICA / FELICA_TRANSPORTATION, providerRefundable: false).
    const felicaSale = await desk.sellOnTerminal("felica_1", "felica", binding);
    expect(square.createdPaymentTypes).toEqual(["CARD_PRESENT", "FELICA_ALL"]);
    expect(felicaSale.sale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "felica",
      tenderBrand: "FELICA_TRANSPORTATION",
      providerRefundable: false,
    });

    // Normal provider refund refuses FeliCa and makes zero calls to Square /v2/refunds.
    const refusedProviderRefund = await desk.providerRefund(
      felicaSale.order,
      felicaSale.payment,
      "refund_felica_provider",
    );
    expect(refusedProviderRefund).toMatchObject(
      rejectedWith({ field: "payment.providerRefundable" }),
    );
    expect(square.refundRequests).toHaveLength(1);

    // Manual cash refund succeeds without calling Square, and replay returns the same receipt.
    const felicaCashRefund = await desk.manualCashRefund(
      felicaSale.order,
      felicaSale.payment,
      "refund_felica_cash_1",
    );
    expect(felicaCashRefund).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "record_counter_manual_cash_refund",
        resource: { kind: "refund_attempt", id: "refund_felica_cash_1" },
      },
    });
    expect(square.refundRequests).toHaveLength(1);
    const felicaRecord = await required(
      admin.readOrderRecord(merchantId, felicaSale.order.id),
    );
    expect(felicaRecord.refundAttempts).toEqual([
      expect.objectContaining({
        refundAttemptId: "refund_felica_cash_1",
        lifecycle: expect.objectContaining({
          state: "succeeded",
          providerRefundReference: "manual_cash_refund_felica_cash_1",
        }),
      }),
    ]);

    // 3. QR code sale (QR_CODE -> WALLET / PAYPAY, providerRefundable: true -> Square refund works).
    const qrSale = await desk.sellOnTerminal("qr_1", "qr_code", binding);
    expect(square.createdPaymentTypes).toEqual([
      "CARD_PRESENT",
      "FELICA_ALL",
      "QR_CODE",
    ]);
    expect(qrSale.sale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "qr_code",
      tenderBrand: "PAYPAY",
      providerRefundable: true,
    });
    const qrRefund = await desk.providerRefund(
      qrSale.order,
      qrSale.payment,
      "refund_qr_1",
    );
    expect(qrRefund).toMatchObject({ outcome: "applied" });
    expect(square.refundRequests).toHaveLength(2);

    // 4. Cancelled terminal prompt allows switching the same basket to cash.
    square.nextCheckoutStatus = "CANCELED";
    const cancelledId = "checkout_cancelled_term";
    await desk.openMenuCheckout(cancelledId, 1);
    await desk.collectOnTerminal(cancelledId, "card", binding);
    const reconciledCancelled = await required(
      admin.reconcileCounterSalePayment(merchantId, cancelledId),
    );
    expect(reconciledCancelled.checkout.lifecycle.state).toBe("expired");
    expect(reconciledCancelled.paymentAttempt?.lifecycle.state).toBe(
      "declined",
    );

    // Re-open the same basket with no terminal and settle in cash.
    const cashFallbackId = "checkout_cash_fallback";
    await desk.openMenuCheckout(cashFallbackId, null);
    const fallbackSale = await required(
      admin.readCounterSale(merchantId, cashFallbackId),
    );
    const fallbackQuote = fallbackSale.checkout.lifecycle.quote;
    const cashPaid = await desk.settleCash(
      cashFallbackId,
      fallbackSale.checkout.revision,
      fallbackQuote.quoteDigest,
      fallbackQuote.totals.total.amountMinor,
    );
    expect(cashPaid).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "record_counter_cash_payment" },
    });

    Object.assign(evidence, {
      createdPaymentTypes: square.createdPaymentTypes,
      refundRequests: square.refundRequests,
      cardAttempt: cardSale.sale.paymentAttempt?.lifecycle,
      felicaAttempt: felicaSale.sale.paymentAttempt?.lifecycle,
      refusedProviderRefund,
      felicaCashRefund,
      qrAttempt: qrSale.sale.paymentAttempt?.lifecycle,
      cancelledLifecycle: reconciledCancelled.checkout.lifecycle.state,
      cashPaid,
    });
  } finally {
    writeEvidence(
      "SQUARE_JAPAN_TENDERS_ARTIFACT_DIR",
      "square-japan-tenders",
      evidence,
    );
    backend.close();
  }
}

async function squarePosAppHandoffJourney(): Promise<void> {
  const square = new FakeJapanSquare();
  const { backend, admin, desk } = await openJapanCounter(square);
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const ipad: InPersonPaymentBinding = {
      provider: "square_terminal",
      account: ACCOUNT,
      locationId: SQUARE_LOCATION,
      transport: "client_app_handoff",
    };

    // 1. A card sale. The Register receives what it needs to open the app;
    // Commerce has not touched Square yet.
    await desk.openMenuCheckout("checkout_ipad_card", 1);
    const cardHandoff = await desk.handOffToPosApp("checkout_ipad_card", "card", ipad);
    expect(cardHandoff).toMatchObject({
      kind: "client_app_handoff",
      app: "square_point_of_sale",
      clientId: OAUTH.clientId,
      locationId: SQUARE_LOCATION,
      currency: "JPY",
      tenderTypes: ["CREDIT_CARD"],
    });
    expect(cardHandoff.handoffReference).toMatch(/^[0-9a-f]{40}$/u);
    expect(square.createdPaymentTypes).toEqual([]);
    const waiting = await required(
      admin.reconcileCounterSalePayment(merchantId, "checkout_ipad_card"),
    );
    expect(waiting.checkout.lifecycle.state).toBe("payment_pending");

    // The buyer pays on the Reader, and the app returns to the Register.
    const cardPaid = square.takePosPayment(cardHandoff.amountMinor, "card");
    // An answer with another reference is refused and changes nothing.
    const forged = await admin.recordCounterSaleHandoffResult(
      merchantId,
      "checkout_ipad_card",
      desk.answer("checkout_ipad_card", "0".repeat(40), cardPaid),
    );
    expect(httpStatus(forged)).toBe(409);
    expect(square.orderReads).toEqual([]);
    const cardSale = await required(
      admin.recordCounterSaleHandoffResult(
        merchantId,
        "checkout_ipad_card",
        desk.answer("checkout_ipad_card", cardHandoff.handoffReference, cardPaid),
      ),
    );
    expect(cardSale.checkout.lifecycle.state).toBe("accepted");
    expect(cardSale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      providerPaymentReference: "POS_PAY_1",
      paymentMethod: "card",
      tenderBrand: "VISA",
      providerRefundable: true,
    });
    expect(square.orderReads).toEqual([cardPaid.transactionId]);
    // The same answer again is a retry; another answer is refused.
    const retried = await required(
      admin.recordCounterSaleHandoffResult(
        merchantId,
        "checkout_ipad_card",
        desk.answer("checkout_ipad_card", cardHandoff.handoffReference, cardPaid),
      ),
    );
    expect(retried.checkout.lifecycle.state).toBe("accepted");
    const conflicting = await admin.recordCounterSaleHandoffResult(
      merchantId,
      "checkout_ipad_card",
      desk.answer("checkout_ipad_card", cardHandoff.handoffReference, null),
    );
    expect(httpStatus(conflicting)).toBe(409);

    // 2. The barista asked for a card payment and the buyer tapped Suica:
    // the app offers e-money as a card tender, and the readback records it
    // as FeliCa that is refunded in cash.
    await desk.openMenuCheckout("checkout_ipad_suica", 1);
    const suicaHandoff = await desk.handOffToPosApp("checkout_ipad_suica", "card", ipad);
    const suicaSale = await required(
      admin.recordCounterSaleHandoffResult(
        merchantId,
        "checkout_ipad_suica",
        desk.answer(
          "checkout_ipad_suica",
          suicaHandoff.handoffReference,
          square.takePosPayment(suicaHandoff.amountMinor, "felica"),
        ),
      ),
    );
    expect(suicaSale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "felica",
      tenderBrand: "FELICA_TRANSPORTATION",
      providerRefundable: false,
    });
    const suica = await desk.placedSale(suicaSale);
    expect(
      await desk.providerRefund(suica.order, suica.payment, "refund_ipad_suica_provider"),
    ).toMatchObject(rejectedWith({ field: "payment.providerRefundable" }));
    expect(
      await desk.manualCashRefund(suica.order, suica.payment, "refund_ipad_suica_cash"),
    ).toMatchObject({ outcome: "applied" });
    expect(square.refundRequests).toEqual([]);

    // 3. PayPay: the QR choice offers only the PayPay tender.
    await desk.openMenuCheckout("checkout_ipad_paypay", 1);
    const paypayHandoff = await desk.handOffToPosApp("checkout_ipad_paypay", "qr_code", ipad);
    expect(paypayHandoff.tenderTypes).toEqual(["PAYPAY"]);
    const paypaySale = await required(
      admin.recordCounterSaleHandoffResult(
        merchantId,
        "checkout_ipad_paypay",
        desk.answer(
          "checkout_ipad_paypay",
          paypayHandoff.handoffReference,
          square.takePosPayment(paypayHandoff.amountMinor, "qr_code"),
        ),
      ),
    );
    expect(paypaySale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "qr_code",
      tenderBrand: "PAYPAY",
    });

    // 4. A replayed transaction cannot pay a second sale.
    await desk.openMenuCheckout("checkout_ipad_replay", 1);
    const replayHandoff = await desk.handOffToPosApp("checkout_ipad_replay", "card", ipad);
    const replayed = await admin.recordCounterSaleHandoffResult(
      merchantId,
      "checkout_ipad_replay",
      desk.answer("checkout_ipad_replay", replayHandoff.handoffReference, cardPaid),
    );
    expect(httpStatus(replayed)).toBe(409);

    // 5. A payment that Square holds for another amount places no order.
    const short = await required(
      admin.recordCounterSaleHandoffResult(
        merchantId,
        "checkout_ipad_replay",
        desk.answer(
          "checkout_ipad_replay",
          replayHandoff.handoffReference,
          square.takePosPayment(replayHandoff.amountMinor - 100, "card"),
        ),
      ),
    );
    expect(short.checkout.lifecycle.state).toBe("payment_pending");
    expect(short.paymentAttempt?.lifecycle.state).toBe("indeterminate");

    // 6. The barista cancels in the app: the attempt is declined and the
    // basket can go to cash.
    await desk.openMenuCheckout("checkout_ipad_cancel", 1);
    const cancelHandoff = await desk.handOffToPosApp("checkout_ipad_cancel", "card", ipad);
    const cancelled = await required(
      admin.recordCounterSaleHandoffResult(merchantId, "checkout_ipad_cancel", {
        ...desk.answer("checkout_ipad_cancel", cancelHandoff.handoffReference, null),
        status: "error",
        errorCode: "payment_canceled",
      }),
    );
    expect(cancelled.checkout.lifecycle.state).toBe("expired");
    expect(cancelled.paymentAttempt?.lifecycle.state).toBe("declined");

    // 7. Offline Mode: the app says ok without a transaction id, so the sale
    // waits for staff to check the Square Dashboard.
    await desk.openMenuCheckout("checkout_ipad_offline", 1);
    const offlineHandoff = await desk.handOffToPosApp("checkout_ipad_offline", "card", ipad);
    const offline = await required(
      admin.recordCounterSaleHandoffResult(
        merchantId,
        "checkout_ipad_offline",
        desk.answer("checkout_ipad_offline", offlineHandoff.handoffReference, {
          transactionId: null,
          clientTransactionId: "CLIENT_OFFLINE_1",
        }),
      ),
    );
    expect(offline.checkout.lifecycle.state).toBe("payment_pending");
    expect(offline.paymentAttempt?.lifecycle.state).toBe("indeterminate");
    expect(square.createdPaymentTypes).toEqual([]);

    Object.assign(evidence, {
      handoff: { ...cardHandoff, handoffReference: "<40 hex>" },
      forgedStatus: httpStatus(forged),
      cardAttempt: cardSale.paymentAttempt?.lifecycle,
      conflictingStatus: httpStatus(conflicting),
      suicaAttempt: suicaSale.paymentAttempt?.lifecycle,
      paypayAttempt: paypaySale.paymentAttempt?.lifecycle,
      replayedStatus: httpStatus(replayed),
      shortAttempt: short.paymentAttempt?.lifecycle.state,
      cancelled: cancelled.paymentAttempt?.lifecycle.state,
      offline: offline.paymentAttempt?.lifecycle.state,
      squareOrderReads: square.orderReads,
    });
  } finally {
    writeEvidence(
      "SQUARE_JAPAN_TENDERS_ARTIFACT_DIR",
      "square-pos-app-handoff",
      evidence,
    );
    backend.close();
  }
}

function httpStatus(result: Awaited<ReturnType<CommerceAdminClient["readCounterSale"]>>): number {
  if (result.ok) return 200;
  return result.error.kind === "http" ? result.error.status : 0;
}

class JapanTerminalDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "jp_term");
  }

  publishCashAndTerminalPolicy() {
    return required(
      this.admin.publishPointOfSaleConfiguration({
        schemaVersion: "commerce.publish-point-of-sale-configuration.v1",
        merchantId,
        expectedRevision: null,
        publishedAt: NOW,
        publishedBy: "operator_manager",
        configuration: {
          configurationId: "pos_configuration_jp",
          organisationId,
          pantryLocationId: LOCATION,
          salesChannelId: CHANNEL,
          currency: "JPY",
          supportedItems: [],
          catalogScope: {
            kind: "published_menu",
            menuId: "menu_cafe_main",
            maxQuantityPerLine: 20,
          },
          cashEnabled: true,
          quoteTtlSeconds: 900,
          tax: { kind: "percentage", basisPoints: 1_000, inclusion: "included" },
          pickupReadyLeadTimeSeconds: 0,
          afterSalePolicy: {
            cancellationPolicyId: "cancellation_counter",
            refundPolicyId: "refund_counter",
            refundGovernance: { kind: "approval_required" },
          },
          presentationPolicy: {
            locale: "ja-JP",
            merchantDisplayName: "Purin Patisserie",
            termsPolicyId: "terms_counter",
            privacyPolicyId: "privacy_counter",
            supportContact: "support@example.test",
          },
        },
      }),
    );
  }

  async openMenuCheckout(
    checkoutId: string,
    terminalAssignmentRevision: number | null,
  ) {
    return this.apply(
      this.admin.createInPersonCheckout({
        ...(await this.base(`open_${checkoutId}`)),
        pantryLocationId: LOCATION,
        posConfigurationRevision: 1,
        operatorIdentity: "operator_barista",
        terminalAssignmentRevision,
        buyer: { kind: "anonymous" },
        checkoutId,
        lines: [
          {
            cartLineId: `cl_${checkoutId}`,
            checkoutLineId: `line_${checkoutId}`,
            source: {
              kind: "menu",
              menuId: "menu_cafe_main",
              menuEntryId: "menu_entry_matcha_cookie",
              modifierOptionIds: [],
            },
            quantity: { amount: 1, scale: 0, unit: "each" },
          },
        ],
      }),
    );
  }

  async collectOnTerminal(
    checkoutId: string,
    paymentMethod: InPersonPaymentMethod,
    paymentBinding: InPersonPaymentBinding,
  ) {
    const sale = await required(
      this.admin.readCounterSale(merchantId, checkoutId),
    );
    const quote = sale.checkout.lifecycle.quote;
    return required(
      this.admin.collectInPersonCheckoutPayment({
        ...(await this.base(`collect_${checkoutId}`)),
        checkoutId,
        checkoutRevision: sale.checkout.revision,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId: `attempt_${checkoutId}`,
        providerRequestId: `req_${checkoutId}`,
        amount: quote.totals.total,
        paymentBinding,
        paymentMethod,
      }),
    );
  }

  /** Starts the handoff and returns what the Register opens the app with. */
  async handOffToPosApp(
    checkoutId: string,
    paymentMethod: InPersonPaymentMethod,
    paymentBinding: InPersonPaymentBinding,
  ) {
    const collected = await this.collectOnTerminal(
      checkoutId,
      paymentMethod,
      paymentBinding,
    );
    if (
      collected.outcome !== "ready" ||
      collected.session.kind !== "client_app_handoff"
    )
      throw new Error(`No POS app handoff: ${JSON.stringify(collected)}`);
    return collected.session;
  }

  /** What the Register's callback page sends after the app returns. */
  answer(
    checkoutId: string,
    handoffReference: string,
    paid: Readonly<{
      transactionId: string | null;
      clientTransactionId: string;
    }> | null,
  ): CommerceCounterSaleHandoffResultV1 {
    return {
      schemaVersion: "commerce.counter-sale-handoff-result.v1",
      paymentAttemptId: `attempt_${checkoutId}`,
      handoffReference,
      status: "ok",
      transactionId: paid?.transactionId ?? null,
      clientTransactionId: paid?.clientTransactionId ?? null,
      errorCode: null,
    };
  }

  async placedSale(sale: CommerceCounterSaleV1) {
    const orderId =
      sale.checkout.lifecycle.state === "accepted"
        ? sale.checkout.lifecycle.orderId
        : "";
    const snap = await required(this.admin.readSnapshot(merchantId));
    const order = snap.resources.orders.find((o) => o.id === orderId)!;
    const payment = snap.resources.payments.find((p) => p.orderId === orderId)!;
    return { order, payment };
  }

  async sellOnTerminal(
    key: string,
    paymentMethod: InPersonPaymentMethod,
    paymentBinding: InPersonPaymentBinding,
  ): Promise<
    Readonly<{
      sale: CommerceCounterSaleV1;
      order: CommerceOrderV1;
      payment: CommercePaymentV1;
    }>
  > {
    const checkoutId = `checkout_${key}`;
    await this.openMenuCheckout(checkoutId, 1);
    const collected = await this.collectOnTerminal(
      checkoutId,
      paymentMethod,
      paymentBinding,
    );
    expect(collected.outcome).toBe("ready");
    const sale = await required(
      this.admin.reconcileCounterSalePayment(merchantId, checkoutId),
    );
    expect(sale.checkout.lifecycle.state).toBe("accepted");
    return { sale, ...(await this.placedSale(sale)) };
  }

  async providerRefund(
    order: CommerceOrderV1,
    payment: CommercePaymentV1,
    refundAttemptId: string,
  ) {
    const line = order.lineItems[0]!;
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(refundAttemptId)),
        orderId: order.id,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId,
        refundPolicyId: "refund_counter",
        amount: line.lineTotal,
        allocation: {
          lineAllocations: [{ orderLineId: line.id, amount: line.lineTotal }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Customer refund",
      }),
    );
  }

  async manualCashRefund(
    order: CommerceOrderV1,
    payment: CommercePaymentV1,
    refundAttemptId: string,
  ) {
    const line = order.lineItems[0]!;
    return this.edit(
      this.admin.recordCounterManualCashRefund({
        ...(await this.base(refundAttemptId)),
        orderId: order.id,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId,
        refundPolicyId: "refund_counter",
        amount: line.lineTotal,
        allocation: {
          lineAllocations: [{ orderLineId: line.id, amount: line.lineTotal }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "FeliCa refunded in cash at counter",
      }),
    );
  }

  async settleCash(
    checkoutId: string,
    checkoutRevision: number,
    quoteDigest: string,
    totalMinor: number,
  ) {
    return this.edit(
      this.admin.recordCounterCashPayment({
        ...(await this.base(`cash_${checkoutId}`)),
        checkoutId,
        checkoutRevision,
        quoteDigest,
        orderId: `order_${checkoutId}`,
        paymentId: `payment_${checkoutId}`,
        fulfillmentId: `fulfillment_${checkoutId}`,
        cashReceived: jpy(totalMinor),
      }),
    );
  }
}

class FakeJapanSquare {
  readonly createdPaymentTypes: string[] = [];
  readonly refundRequests: Record<string, unknown>[] = [];
  readonly orderReads: string[] = [];
  nextCheckoutStatus: "COMPLETED" | "CANCELED" = "COMPLETED";
  #seq = 0;
  #posSeq = 0;
  readonly #posPayments = new Map<
    string,
    Readonly<{ payment: Readonly<Record<string, unknown>> }>
  >();

  /**
   * What the Square Point of Sale app does when the buyer pays on the
   * Reader: Square keeps an order with one tender and its payment. Returns
   * the ids that the app hands back to the Register.
   */
  takePosPayment(
    amountMinor: number,
    tender: InPersonPaymentMethod,
    createdAt = NOW,
  ): Readonly<{ transactionId: string; clientTransactionId: string }> {
    this.#posSeq += 1;
    const transactionId = `POS_ORDER_${this.#posSeq}`;
    const paymentId = `POS_PAY_${this.#posSeq}`;
    this.#posPayments.set(paymentId, {
      payment: {
        id: paymentId,
        status: "COMPLETED",
        location_id: SQUARE_LOCATION,
        order_id: transactionId,
        created_at: createdAt,
        amount_money: { amount: amountMinor, currency: "JPY" },
        application_details: { square_product: "SQUARE_POS" },
        ...squareTender(tender),
      },
    });
    return { transactionId, clientTransactionId: `CLIENT_${this.#posSeq}` };
  }
  readonly #checkouts = new Map<
    string,
    {
      id: string;
      reference_id: unknown;
      amount_money: unknown;
      device_options: unknown;
      payment_type: string;
      paymentId: string;
      status: "COMPLETED" | "CANCELED";
    }
  >();

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    if (path === "/oauth2/token") {
      return json({
        access_token: "token_jp_1",
        refresh_token: "refresh_jp_1",
        expires_at: "2026-09-14T10:00:00.000Z",
        merchant_id: SELLER,
      });
    }
    if (path === "/v2/merchants/me") {
      return json({
        merchant: {
          id: SELLER,
          business_name: "Purin Patisserie Tokyo",
          country: "JP",
          currency: "JPY",
        },
      });
    }
    if (path === `/v2/locations/${SQUARE_LOCATION}`) {
      return json({
        location: {
          id: SQUARE_LOCATION,
          name: "Tokyo Flagship",
          status: "ACTIVE",
          country: "JP",
          currency: "JPY",
          capabilities: ["CREDIT_CARD_PROCESSING"],
        },
      });
    }
    if (
      path === "/v2/terminals/checkouts" &&
      method === "POST" &&
      isRecord(body) &&
      isRecord(body.checkout)
    ) {
      this.#seq += 1;
      const id = `TERM_JP_${this.#seq}`;
      const paymentId = `PAY_JP_${this.#seq}`;
      const paymentType =
        typeof body.checkout.payment_type === "string"
          ? body.checkout.payment_type
          : "CARD_PRESENT";
      this.createdPaymentTypes.push(paymentType);
      const record = {
        id,
        reference_id: body.checkout.reference_id,
        amount_money: body.checkout.amount_money,
        device_options: body.checkout.device_options,
        payment_type: paymentType,
        paymentId,
        status: this.nextCheckoutStatus,
      };
      this.nextCheckoutStatus = "COMPLETED";
      this.#checkouts.set(id, record);
      return json({
        checkout: {
          id: record.id,
          reference_id: record.reference_id,
          amount_money: record.amount_money,
          device_options: record.device_options,
          status: "PENDING",
        },
      });
    }
    if (path.startsWith("/v2/terminals/checkouts/")) {
      const id = path.slice("/v2/terminals/checkouts/".length);
      const record = this.#checkouts.get(id);
      if (record === undefined) return json({ errors: [] }, 404);
      return json({
        checkout: {
          id: record.id,
          reference_id: record.reference_id,
          amount_money: record.amount_money,
          device_options: record.device_options,
          status: record.status,
          ...(record.status === "COMPLETED"
            ? { payment_ids: [record.paymentId] }
            : {}),
        },
      });
    }
    if (path.startsWith("/v2/orders/")) {
      const orderId = path.slice("/v2/orders/".length);
      const pos = [...this.#posPayments.values()].find(
        (p) => p.payment.order_id === orderId,
      );
      if (pos === undefined) return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
      this.orderReads.push(orderId);
      return json({
        order: {
          id: orderId,
          location_id: SQUARE_LOCATION,
          state: "COMPLETED",
          tenders: [{ id: pos.payment.id, payment_id: pos.payment.id }],
        },
      });
    }
    if (path.startsWith("/v2/payments/")) {
      const paymentId = path.slice("/v2/payments/".length);
      const pos = this.#posPayments.get(paymentId);
      if (pos !== undefined) return json({ payment: pos.payment });
      const record = [...this.#checkouts.values()].find(
        (c) => c.paymentId === paymentId,
      );
      if (record === undefined) return json({ errors: [] }, 404);
      const tender = squareTender(
        record.payment_type === "FELICA_ALL"
          ? "felica"
          : record.payment_type === "QR_CODE"
            ? "qr_code"
            : "card",
      );
      return json({
        payment: {
          id: record.paymentId,
          status: "COMPLETED",
          location_id: SQUARE_LOCATION,
          amount_money: record.amount_money,
          reference_id: record.reference_id,
          ...tender,
        },
      });
    }
    if (path === "/v2/refunds" && method === "POST" && isRecord(body)) {
      this.refundRequests.push(body);
      return json({
        refund: {
          id: `SQ_REFUND_${this.refundRequests.length}`,
          status: "COMPLETED",
          amount_money: body.amount_money,
          payment_id: body.payment_id,
          reason: body.reason,
        },
      });
    }
    return json({ errors: [{ code: "NOT_FOUND" }] }, 404);
  };
}

/** The tender fields of a Square Payment, as Square documents them for Japan. */
function squareTender(method: InPersonPaymentMethod): Record<string, unknown> {
  switch (method) {
    case "felica":
      return {
        source_type: "CARD",
        card_details: {
          card: { card_brand: "FELICA" },
          entry_method: "CONTACTLESS",
        },
        electronic_money_details: {
          felica_details: { felica_brand: "FELICA_TRANSPORTATION" },
        },
      };
    case "qr_code":
      return { source_type: "WALLET", wallet_details: { brand: "PAYPAY" } };
    case "card":
      return {
        source_type: "CARD",
        card_details: { card: { card_brand: "VISA" }, entry_method: "EMV" },
      };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
