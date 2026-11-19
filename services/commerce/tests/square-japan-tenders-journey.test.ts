// Plan 90 Phase 3A: Square Terminal Japan multi-tender (CARD_PRESENT,
// FELICA_ALL, QR_CODE), payment readback verification, FeliCa manual cash
// refund accounting without calling Square Refunds API, and switching a
// cancelled terminal prompt to cash. Set SQUARE_JAPAN_TENDERS_ARTIFACT_DIR
// to keep repeatable evidence.
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

it(
  "verifies Square Japan Card, FeliCa, and QR tenders, refunds FeliCa in cash without calling Square Refunds API, and allows switching cancelled terminal prompts to cash",
  { timeout: 60_000 },
  squareJapanTendersJourney,
);

async function squareJapanTendersJourney(): Promise<void> {
  const square = new FakeJapanSquare();
  const backend = await startBackend({
    square: { fetch: square.fetch, oauth: OAUTH },
  });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const desk = new JapanTerminalDesk(admin);

    // Connect Square Japan account & link Tokyo JPY location.
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

    const binding: InPersonPaymentBinding = {
      provider: "square_terminal",
      account: {
        integrationAccountId: `underclerk_square_${SELLER}`,
        providerAccountId: SELLER,
        environment: "development",
        capabilityRevision: 1,
        country: "JP",
        currency: "JPY",
      },
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

class JapanTerminalDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "jp_term");
  }

  publishCashAndTerminalPolicy() {
    return required(
      this.admin.publishPointOfSaleConfiguration({
        schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
        merchantId,
        expectedRevision: null,
        publishedAt: NOW,
        publishedBy: "operator_manager",
        configuration: {
          configurationId: "pos_configuration_jp",
          organisationId,
          satyrLocationId: LOCATION,
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
            merchantDisplayName: "Seams Patisserie",
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
        satyrLocationId: LOCATION,
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
    const orderId =
      sale.checkout.lifecycle.state === "accepted"
        ? sale.checkout.lifecycle.orderId
        : "";
    const snap = await required(this.admin.readSnapshot(merchantId));
    const order = snap.resources.orders.find((o) => o.id === orderId)!;
    const payment = snap.resources.payments.find((p) => p.orderId === orderId)!;
    return { sale, order, payment };
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
  nextCheckoutStatus: "COMPLETED" | "CANCELED" = "COMPLETED";
  #seq = 0;
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
          business_name: "Seams Patisserie Tokyo",
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
    if (path.startsWith("/v2/payments/")) {
      const paymentId = path.slice("/v2/payments/".length);
      const record = [...this.#checkouts.values()].find(
        (c) => c.paymentId === paymentId,
      );
      if (record === undefined) return json({ errors: [] }, 404);
      const tender =
        record.payment_type === "FELICA_ALL"
          ? {
              source_type: "FELICA",
              felica_details: { brand: "FELICA_TRANSPORTATION" },
            }
          : record.payment_type === "QR_CODE"
            ? {
                source_type: "WALLET",
                wallet_details: { brand: "PAYPAY" },
              }
            : {
                source_type: "CARD",
                card_details: { card: { card_brand: "VISA" } },
              };
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
