// Plan 90 Phase 4A: GMO stera LAN gateway binding (gmo_stera / lan_gateway),
// gateway_terminal_checkout collection session, settlement into Commerce via
// record_checkout_payment_capture + place_paid_checkout, FeliCa manual cash
// refund, and decline / indeterminate recovery boundaries.
// Set GMO_STERA_LAN_ARTIFACT_DIR to keep repeatable evidence.
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

const GATEWAY_ID = "gw_tokyo_counter_1";
const DEVICE_SOURCE_KEY = "stera_lan_1";
const EXPECTED_TERMINAL_ID = `${GATEWAY_ID}:${DEVICE_SOURCE_KEY}`;
const PROVIDER_LOCATION = "GMO_STERA_LOC_TOKYO";

const STERA_BINDING: InPersonPaymentBinding = {
  provider: "gmo_stera",
  account: {
    integrationAccountId: "gmo_stera_account_tokyo",
    providerAccountId: "gmo_merchant_tokyo",
    environment: "development",
    capabilityRevision: 1,
    country: "JP",
    currency: "JPY",
  },
  locationId: PROVIDER_LOCATION,
  gatewayId: GATEWAY_ID,
  deviceSourceKey: DEVICE_SOURCE_KEY,
  transport: "lan_gateway",
};

it(
  "collects Card, FeliCa, and QR via gmo_stera lan_gateway session, enforces FeliCa manual cash refunds, and guards decline vs indeterminate recovery",
  { timeout: 60_000 },
  gmoSteraLanGatewayJourney,
);

async function gmoSteraLanGatewayJourney(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const desk = new SteraGatewayDesk(admin);
    await desk.publishPosPolicy();

    // 1. Card sale via gateway_terminal_checkout.
    const cardSale = await desk.sellViaGateway("stera_card_1", "card", {
      providerPaymentReference: "stera_pay_card_1",
      tenderBrand: "VISA",
      providerRefundable: true,
    });
    expect(cardSale.order.origin).toMatchObject({
      kind: "point_of_sale",
      locationId: LOCATION,
      terminalId: EXPECTED_TERMINAL_ID,
    });
    expect(cardSale.sale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "card",
      tenderBrand: "VISA",
      providerRefundable: true,
    });

    // 2. FeliCa sale via gateway_terminal_checkout -> providerRefundable: false.
    const felicaSale = await desk.sellViaGateway("stera_felica_1", "felica", {
      providerPaymentReference: "stera_pay_felica_1",
      tenderBrand: "SUICA",
      providerRefundable: false,
    });
    expect(felicaSale.sale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "felica",
      tenderBrand: "SUICA",
      providerRefundable: false,
    });

    const refusedProviderRefund = await desk.providerRefund(
      felicaSale.order,
      felicaSale.payment,
      "refund_stera_felica_provider_blocked",
    );
    expect(refusedProviderRefund).toMatchObject(
      rejectedWith({ field: "payment.providerRefundable" }),
    );

    const manualCashRefund = await desk.manualCashRefund(
      felicaSale.order,
      felicaSale.payment,
      "refund_stera_felica_cash_1",
    );
    expect(manualCashRefund).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "record_counter_manual_cash_refund",
        resource: { kind: "refund_attempt", id: "refund_stera_felica_cash_1" },
      },
    });
    const felicaRecord = await required(
      admin.readOrderRecord(merchantId, felicaSale.order.id),
    );
    expect(felicaRecord.refundAttempts).toEqual([
      expect.objectContaining({
        refundAttemptId: "refund_stera_felica_cash_1",
        lifecycle: expect.objectContaining({
          state: "succeeded",
          providerRefundReference: "manual_cash_refund_stera_felica_cash_1",
        }),
      }),
    ]);

    // 3. QR sale via gateway_terminal_checkout.
    const qrSale = await desk.sellViaGateway("stera_qr_1", "qr_code", {
      providerPaymentReference: "stera_pay_qr_1",
      tenderBrand: "PAYPAY",
      providerRefundable: true,
    });
    expect(qrSale.sale.paymentAttempt?.lifecycle).toMatchObject({
      state: "captured",
      paymentMethod: "qr_code",
      tenderBrand: "PAYPAY",
      providerRefundable: true,
    });

    // 4. Declined gateway attempt -> checkout can be replaced by a cash checkout.
    const declinedOpen = await desk.openAndStartCollection(
      "stera_declined_1",
      "card",
    );
    const resolvedDeclined = await desk.resolveAttempt(declinedOpen, {
      kind: "declined",
      reasonCode: "card_declined",
    });
    expect(resolvedDeclined).toMatchObject({ outcome: "applied" });
    const declinedSale = await required(
      admin.readCounterSale(merchantId, declinedOpen.checkoutId),
    );
    expect(declinedSale.paymentAttempt?.lifecycle.state).toBe("declined");

    const cashFallbackId = "checkout_stera_cash_fallback";
    await desk.openMenuCheckout(cashFallbackId, null);
    const fallbackSale = await required(
      admin.readCounterSale(merchantId, cashFallbackId),
    );
    const fallbackQuote = fallbackSale.checkout.lifecycle.quote;
    const cashPaid = await desk.settleCash(
      cashFallbackId,
      fallbackSale.checkout.revision,
      fallbackQuote.quoteDigest,
      1000,
    );
    expect(cashPaid).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "record_counter_cash_payment" },
    });
    const paidFallback = await required(
      admin.readCounterSale(merchantId, cashFallbackId),
    );
    expect(paidFallback.manualTender?.changeDueMinor).toBe(
      1000 - fallbackQuote.totals.total.amountMinor,
    );

    // 5. Indeterminate gateway attempt (network drop) -> cannot settle checkout in cash.
    const unknownOpen = await desk.openAndStartCollection(
      "stera_unknown_1",
      "card",
    );
    const resolvedUnknown = await desk.resolveAttempt(unknownOpen, {
      kind: "indeterminate",
      reasonCode: "gateway_disconnected",
      reconcileAfter: new Date(Date.parse(NOW) + 15_000).toISOString(),
    });
    expect(resolvedUnknown).toMatchObject({ outcome: "applied" });
    const unknownSale = await required(
      admin.readCounterSale(merchantId, unknownOpen.checkoutId),
    );
    expect(unknownSale.paymentAttempt?.lifecycle.state).toBe("indeterminate");
    const blockedCash = await desk.settleCash(
      unknownOpen.checkoutId,
      unknownSale.checkout.revision,
      unknownSale.checkout.lifecycle.quote.quoteDigest,
      1000,
    );
    expect(blockedCash).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "checkout",
        state: "payment_pending",
        event: "place_manually",
      }),
    );

    Object.assign(evidence, {
      cardOrderId: cardSale.order.id,
      felicaOrderId: felicaSale.order.id,
      qrOrderId: qrSale.order.id,
      cashFallbackId,
      indeterminateOutcome: unknownSale.paymentAttempt?.lifecycle.state,
      blockedCash,
    });
  } finally {
    writeEvidence(
      "GMO_STERA_LAN_ARTIFACT_DIR",
      "gmo-stera-lan-gateway",
      evidence,
    );
    backend.close();
  }
}

type StartedCollection = Readonly<{
  checkoutId: string;
  checkoutRevision: number;
  quoteDigest: string;
  paymentAttemptId: string;
  paymentAttemptRevision: number;
}>;

class SteraGatewayDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "stera_lan");
  }

  publishPosPolicy() {
    return required(
      this.admin.publishPointOfSaleConfiguration({
        schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
        merchantId,
        expectedRevision: null,
        publishedAt: NOW,
        publishedBy: "operator_manager",
        configuration: {
          configurationId: "pos_configuration_stera",
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

  async openAndStartCollection(
    tag: string,
    paymentMethod: InPersonPaymentMethod,
  ): Promise<StartedCollection> {
    const checkoutId = `checkout_${tag}`;
    await this.openMenuCheckout(checkoutId, 1);
    const sale = await required(
      this.admin.readCounterSale(merchantId, checkoutId),
    );
    const quote = sale.checkout.lifecycle.quote;
    const paymentAttemptId = `attempt_${tag}`;
    const collected = await required(
      this.admin.collectInPersonCheckoutPayment({
        ...(await this.base(`collect_${tag}`)),
        checkoutId,
        checkoutRevision: sale.checkout.revision,
        quoteDigest: quote.quoteDigest,
        paymentAttemptId,
        providerRequestId: `req_${tag}`,
        amount: quote.totals.total,
        paymentBinding: STERA_BINDING,
        paymentMethod,
      }),
    );
    expect(collected.outcome).toBe("ready");
    if (collected.outcome !== "ready") {
      throw new Error("Expected ready collection session");
    }
    expect(collected.paymentAttemptId).toBe(paymentAttemptId);
    expect(collected.session).toMatchObject({
      kind: "gateway_terminal_checkout",
      gatewayId: GATEWAY_ID,
      deviceSourceKey: DEVICE_SOURCE_KEY,
    });
    const afterCollect = await required(
      this.admin.readCounterSale(merchantId, checkoutId),
    );
    return {
      checkoutId,
      checkoutRevision: afterCollect.checkout.revision,
      quoteDigest: quote.quoteDigest,
      paymentAttemptId,
      paymentAttemptRevision: afterCollect.paymentAttempt?.revision ?? 1,
    };
  }

  async sellViaGateway(
    tag: string,
    paymentMethod: InPersonPaymentMethod,
    capture: {
      providerPaymentReference: string;
      tenderBrand: string;
      providerRefundable: boolean;
    },
  ): Promise<{
    sale: CommerceCounterSaleV1;
    order: CommerceOrderV1;
    payment: CommercePaymentV1;
  }> {
    const started = await this.openAndStartCollection(tag, paymentMethod);
    await this.apply(
      this.admin.recordCheckoutPaymentCapture({
        ...(await this.base(`capture_${tag}`)),
        checkoutId: started.checkoutId,
        checkoutRevision: started.checkoutRevision,
        quoteDigest: started.quoteDigest,
        paymentAttemptId: started.paymentAttemptId,
        paymentAttemptRevision: started.paymentAttemptRevision,
        providerPaymentReference: capture.providerPaymentReference,
        capturedAt: new Date(Date.parse(NOW) + 1_000).toISOString(),
        paymentMethod,
        tenderBrand: capture.tenderBrand,
        providerRefundable: capture.providerRefundable,
      }),
    );
    const afterCapture = await required(
      this.admin.readCounterSale(merchantId, started.checkoutId),
    );
    await this.apply(
      this.admin.placePaidCheckout({
        ...(await this.base(`place_${tag}`)),
        checkoutId: started.checkoutId,
        checkoutRevision: afterCapture.checkout.revision,
        quoteDigest: started.quoteDigest,
        paymentAttemptId: started.paymentAttemptId,
        paymentAttemptRevision: afterCapture.paymentAttempt?.revision ?? 2,
        orderId: `order_${tag}`,
        paymentId: `payment_${tag}`,
        fulfillmentId: `fulfillment_${tag}`,
        buyer: { kind: "guest" },
        placement: { kind: "pickup" },
      }),
    );
    const sale = await required(
      this.admin.readCounterSale(merchantId, started.checkoutId),
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

  async resolveAttempt(
    started: StartedCollection,
    outcome:
      | { kind: "declined"; reasonCode: string }
      | { kind: "indeterminate"; reasonCode: string; reconcileAfter: string },
  ) {
    return this.edit(
      this.admin.resolveCheckoutPayment({
        ...(await this.base(`resolve_${started.paymentAttemptId}`)),
        checkoutId: started.checkoutId,
        checkoutRevision: started.checkoutRevision,
        quoteDigest: started.quoteDigest,
        paymentAttemptId: started.paymentAttemptId,
        paymentAttemptRevision: started.paymentAttemptRevision,
        outcome,
      }),
    );
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
        reason: "FeliCa stera charge refunded in cash at counter",
      }),
    );
  }

  async settleCash(
    checkoutId: string,
    checkoutRevision: number,
    quoteDigest: string,
    cashReceivedMinor: number,
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
        cashReceived: jpy(cashReceivedMinor),
      }),
    );
  }
}
