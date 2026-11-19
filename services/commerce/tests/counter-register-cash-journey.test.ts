// Plan 90 Phase 1: a café counter sells from its published menu with drink
// modifiers, included consumption tax, sold-out enforcement, cash tender with
// exact change, recipe/pastry stock consumption on handover, and idempotent
// cash refunds without a card terminal. Set COUNTER_REGISTER_CASH_ARTIFACT_DIR
// to keep the run's evidence; the file repeats byte for byte for one commit.
import {
  commercePickupCode,
  type CommerceAdminClient,
} from "@seams/commerce-client";
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

const MENU = "menu_cafe_main";
const COOKIE_VARIANT = "variant_sesame_cookie";
const PASTRY_ITEM = "inventory_matcha_cookie";
const OAT_MILK_ITEM = "inventory_oat_milk";
const WHOLE_MILK_ITEM = "inventory_whole_milk";

it(
  "rings up published menu lines with modifiers, settles cash with change, consumes stock, and refunds cash idempotently",
  { timeout: 60_000 },
  counterRegisterCashJourney,
);

async function counterRegisterCashJourney(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const desk = new RegisterCashDesk(admin);

    // 1. A non-cash counter policy refuses cashless-terminal-less checkout.
    const cardOnlyPolicy = await desk.publishPolicy({
      expectedRevision: null,
      cashEnabled: false,
    });
    expect(cardOnlyPolicy.revision).toBe(1);
    const refusedNoCash = await desk.ringMenuCheckout({
      checkoutId: "checkout_no_cash",
      posConfigurationRevision: 1,
      terminalAssignmentRevision: null,
      lines: [
        {
          cartLineId: "cl_fin",
          checkoutLineId: "line_fin",
          source: {
            kind: "menu",
            menuId: MENU,
            menuEntryId: "menu_entry_sesame_financier",
            modifierOptionIds: [],
          },
          quantity: { amount: 1, scale: 0, unit: "each" },
        },
      ],
    });
    expect(refusedNoCash).toMatchObject(
      rejectedWith({ field: "pointOfSaleConfiguration.cashEnabled" }),
    );

    // 2. Publish cash-enabled counter policy scoped to menu_cafe_main with
    //    10% included consumption tax.
    const cashPolicy = await desk.publishPolicy({
      expectedRevision: 1,
      cashEnabled: true,
    });
    expect(cashPolicy.revision).toBe(2);
    expect(cashPolicy.cashEnabled).toBe(true);
    expect(cashPolicy.catalogScope).toEqual({
      kind: "published_menu",
      menuId: MENU,
      maxQuantityPerLine: 20,
    });

    // 3. Mark sesame cookie sold_out_today; counter checkout refuses it.
    await desk.markSoldOutToday(COOKIE_VARIANT);
    const refusedSoldOut = await desk.ringMenuCheckout({
      checkoutId: "checkout_sold_out",
      posConfigurationRevision: 2,
      terminalAssignmentRevision: null,
      lines: [
        {
          cartLineId: "cl_cookie",
          checkoutLineId: "line_cookie",
          source: {
            kind: "menu",
            menuId: MENU,
            menuEntryId: "menu_entry_sesame_cookie",
            modifierOptionIds: [],
          },
          quantity: { amount: 1, scale: 0, unit: "each" },
        },
      ],
    });
    expect(refusedSoldOut).toMatchObject(
      rejectedWith({ field: "checkout.soldOut" }),
    );

    // 4. Record opening stock for stocked pastry, oat milk, and whole milk.
    const stockBefore = await desk.readOnHand([
      PASTRY_ITEM,
      OAT_MILK_ITEM,
      WHOLE_MILK_ITEM,
    ]);

    // 5. Ring up 2 matcha cookies + 1 ginger milk tea with oat milk (+¥100)
    //    with no terminal assignment (terminalAssignmentRevision: null).
    const opened = await desk.ringMenuCheckout({
      checkoutId: "checkout_cash_sale_1",
      posConfigurationRevision: 2,
      terminalAssignmentRevision: null,
      lines: [
        {
          cartLineId: "cl_pastry",
          checkoutLineId: "line_pastry",
          source: {
            kind: "menu",
            menuId: MENU,
            menuEntryId: "menu_entry_matcha_cookie",
            modifierOptionIds: [],
          },
          quantity: { amount: 2, scale: 0, unit: "each" },
        },
        {
          cartLineId: "cl_tea",
          checkoutLineId: "line_tea",
          source: {
            kind: "menu",
            menuId: MENU,
            menuEntryId: "menu_entry_ginger_milk_tea",
            modifierOptionIds: ["modifier_option_oat_milk"],
          },
          quantity: { amount: 1, scale: 0, unit: "each" },
        },
      ],
    });
    expect(opened).toMatchObject({ outcome: "applied" });

    const quotedSale = await required(
      admin.readCounterSale(merchantId, "checkout_cash_sale_1"),
    );
    expect(quotedSale.checkout.source).toMatchObject({
      kind: "point_of_sale",
      terminalAssignmentRevision: null,
    });
    const quote = quotedSale.checkout.lifecycle.quote;
    expect(quote.totals.taxIncluded).toBe(true);
    expect(quote.totals.total).toEqual(quote.totals.subtotal);
    const totalMinor = quote.totals.total.amountMinor;
    expect(totalMinor).toBeGreaterThan(0);
    expect(totalMinor).toBeLessThan(2_000);
    // Verify modifier was applied on the drink line.
    const drinkLine = quote.lines.find(
      (line) => line.checkoutLineId === "line_tea",
    );
    expect(drinkLine?.source.kind).toBe("food_service");
    if (drinkLine?.source.kind === "food_service") {
      expect(drinkLine.source.modifiers).toEqual([
        expect.objectContaining({
          modifierOptionId: "modifier_option_oat_milk",
          name: "Oat milk",
        }),
      ]);
    }

    // 6. Under-tendered cash is refused.
    const shortCash = await desk.payCash({
      checkoutId: "checkout_cash_sale_1",
      checkoutRevision: quotedSale.checkout.revision,
      quoteDigest: quote.quoteDigest,
      orderId: "order_cash_short",
      paymentId: "payment_cash_short",
      fulfillmentId: "fulfillment_cash_short",
      cashReceivedMinor: totalMinor - 1,
      idempotencyKey: "cash_short",
    });
    expect(shortCash).toMatchObject(rejectedWith({ field: "cashReceived" }));

    // 7. Tender ¥2,000 cash -> settles order with terminalId: null and exact change.
    const revisionBeforeCash = (
      await required(admin.readSnapshot(merchantId))
    ).merchantRevision;
    const cashSettled = await desk.payCash({
      checkoutId: "checkout_cash_sale_1",
      checkoutRevision: quotedSale.checkout.revision,
      quoteDigest: quote.quoteDigest,
      orderId: "order_cash_sale_1",
      paymentId: "payment_cash_sale_1",
      fulfillmentId: "fulfillment_cash_sale_1",
      cashReceivedMinor: 2_000,
      idempotencyKey: "cash_pay_1",
      expectedMerchantRevision: revisionBeforeCash,
    });
    expect(cashSettled).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "record_counter_cash_payment",
        resource: {
          kind: "commerce_order",
          id: "order_cash_sale_1",
          revision: 1,
        },
      },
    });
    // Replay with the same request returns the identical receipt.
    const cashReplayed = await desk.payCash({
      checkoutId: "checkout_cash_sale_1",
      checkoutRevision: quotedSale.checkout.revision,
      quoteDigest: quote.quoteDigest,
      orderId: "order_cash_sale_1",
      paymentId: "payment_cash_sale_1",
      fulfillmentId: "fulfillment_cash_sale_1",
      cashReceivedMinor: 2_000,
      idempotencyKey: "cash_pay_1",
      expectedMerchantRevision: revisionBeforeCash,
    });
    expect(cashReplayed).toEqual({ ...cashSettled, outcome: "replayed" });

    // Read back the counter sale and order.
    const acceptedSale = await required(
      admin.readCounterSale(merchantId, "checkout_cash_sale_1"),
    );
    expect(acceptedSale.checkout.lifecycle.state).toBe("accepted");
    expect(acceptedSale.paymentAttempt).toBeNull();
    expect(acceptedSale.manualTender).toEqual({
      method: "cash",
      cashReceivedMinor: 2_000,
      changeDueMinor: 2_000 - totalMinor,
      recordedAt: NOW,
    });

    const snapshot = await required(admin.readSnapshot(merchantId));
    const order = snapshot.resources.orders.find(
      (candidate) => candidate.id === "order_cash_sale_1",
    );
    expect(order?.origin).toEqual({
      kind: "point_of_sale",
      salesChannelId: CHANNEL,
      locationId: LOCATION,
      checkoutId: "checkout_cash_sale_1",
      terminalId: null,
      receiptNumber: "order_cash_sale_1",
    });

    // Verify pickup queue entry has F-xxx pickup code, counter channel, and modifier.
    const queue = await required(admin.readPickupQueue(merchantId));
    const entry = queue.entries.find(
      (candidate) => candidate.orderId === "order_cash_sale_1",
    );
    expect(entry).toMatchObject({
      orderId: "order_cash_sale_1",
      fulfillmentId: "fulfillment_cash_sale_1",
      code: commercePickupCode("order_cash_sale_1"),
      channel: "counter",
      stage: "preparing",
    });
    expect(entry?.code).toMatch(/^[A-Z]-\d{3}$/u);
    expect(entry?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quantity: 1, modifiers: ["Oat milk"] }),
      ]),
    );

    // 8. Complete drink preparation ticket, mark ready, and hand over pickup.
    expect(entry?.preparation.state).toBe("not_started");
    if (
      entry?.preparation.state === "not_started" &&
      entry.preparation.stationId !== null
    ) {
      await desk.completeDrinkTicket(
        entry.preparation.ticketId,
        entry.preparation.stationId,
        "order_cash_sale_1",
        "fulfillment_cash_sale_1",
      );
    }
    await desk.handOverPickup(
      "order_cash_sale_1",
      "payment_cash_sale_1",
      "fulfillment_cash_sale_1",
    );

    // Stock consumed: 2 stocked pastries and 210 ml oat milk (not whole milk!).
    const stockAfter = await desk.readOnHand([
      PASTRY_ITEM,
      OAT_MILK_ITEM,
      WHOLE_MILK_ITEM,
    ]);
    expect(stockBefore[PASTRY_ITEM]! - stockAfter[PASTRY_ITEM]!).toBe(2);
    expect(stockBefore[OAT_MILK_ITEM]! - stockAfter[OAT_MILK_ITEM]!).toBe(210);
    expect(stockAfter[WHOLE_MILK_ITEM]).toBe(stockBefore[WHOLE_MILK_ITEM]);

    // 9. Cash refund succeeds with no provider call, and replay returns the
    //    exact same receipt.
    const afterHandover = await required(admin.readSnapshot(merchantId));
    const finalOrder = afterHandover.resources.orders.find(
      (candidate) => candidate.id === "order_cash_sale_1",
    )!;
    const finalPayment = afterHandover.resources.payments.find(
      (candidate) => candidate.id === "payment_cash_sale_1",
    )!;
    const financierLine = finalOrder.lineItems.find(
      (line) => line.source.kind === "food_service" && line.quantity.amount === 2,
    )!;
    const refundPayload = await desk.buildRefundCommand(
      finalOrder,
      finalPayment,
      financierLine,
    );
    const refunded = await required(admin.refundOrder(refundPayload));
    expect(refunded).toMatchObject({ outcome: "applied" });
    const refundedReplay = await required(admin.refundOrder(refundPayload));
    expect(refundedReplay).toEqual({ ...refunded, outcome: "replayed" });

    const orderRecord = await required(
      admin.readOrderRecord(merchantId, "order_cash_sale_1"),
    );
    expect(orderRecord.refundAttempts).toEqual([
      expect.objectContaining({
        lifecycle: expect.objectContaining({
          state: "succeeded",
          providerRefundReference: "manual_refund_cash_1",
        }),
      }),
    ]);

    Object.assign(evidence, {
      cashPolicy,
      refusedNoCash,
      refusedSoldOut,
      quote,
      acceptedSale,
      pickupCode: entry?.code,
      stockBefore,
      stockAfter,
      refunded,
    });
  } finally {
    writeEvidence(
      "COUNTER_REGISTER_CASH_ARTIFACT_DIR",
      "counter-register-cash",
      evidence,
    );
    backend.close();
  }
}

class RegisterCashDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "register_cash");
  }

  publishPolicy(
    input: Readonly<{ expectedRevision: number | null; cashEnabled: boolean }>,
  ) {
    return required(
      this.admin.publishPointOfSaleConfiguration({
        schemaVersion: "underclerk.publish-point-of-sale-configuration.v1",
        merchantId,
        expectedRevision: input.expectedRevision,
        publishedAt: NOW,
        publishedBy: "operator_manager",
        configuration: {
          configurationId: "pos_configuration_register",
          organisationId,
          satyrLocationId: LOCATION,
          salesChannelId: CHANNEL,
          currency: "JPY",
          supportedItems: [],
          catalogScope: {
            kind: "published_menu",
            menuId: MENU,
            maxQuantityPerLine: 20,
          },
          cashEnabled: input.cashEnabled,
          quoteTtlSeconds: 900,
          tax: {
            kind: "percentage",
            basisPoints: 1_000,
            inclusion: "included",
          },
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

  async markSoldOutToday(variantId: string) {
    return this.apply(
      this.admin.markSoldOut({
        ...(await this.base(`sold_out_${variantId}`)),
        locationId: LOCATION,
        variantId,
        mark: { kind: "today", timeZone: "Asia/Tokyo" },
      }),
    );
  }

  async ringMenuCheckout(input: Readonly<{
    checkoutId: string;
    posConfigurationRevision: number;
    terminalAssignmentRevision: number | null;
    lines: Parameters<
      CommerceAdminClient["createInPersonCheckout"]
    >[0]["lines"];
  }>) {
    return this.edit(
      this.admin.createInPersonCheckout({
        ...(await this.base(`ring_${input.checkoutId}`)),
        satyrLocationId: LOCATION,
        posConfigurationRevision: input.posConfigurationRevision,
        operatorIdentity: "operator_barista",
        terminalAssignmentRevision: input.terminalAssignmentRevision,
        buyer: { kind: "anonymous" },
        checkoutId: input.checkoutId,
        lines: input.lines,
      }),
    );
  }

  async payCash(input: Readonly<{
    checkoutId: string;
    checkoutRevision: number;
    quoteDigest: string;
    orderId: string;
    paymentId: string;
    fulfillmentId: string;
    cashReceivedMinor: number;
    idempotencyKey: string;
    expectedMerchantRevision?: number;
  }>) {
    const expectedMerchantRevision =
      input.expectedMerchantRevision ??
      (await required(this.admin.readSnapshot(merchantId))).merchantRevision;
    return this.edit(
      this.admin.recordCounterCashPayment({
        merchantId,
        expectedMerchantRevision,
        idempotencyKey: input.idempotencyKey,
        checkoutId: input.checkoutId,
        checkoutRevision: input.checkoutRevision,
        quoteDigest: input.quoteDigest,
        orderId: input.orderId,
        paymentId: input.paymentId,
        fulfillmentId: input.fulfillmentId,
        cashReceived: jpy(input.cashReceivedMinor),
      }),
    );
  }

  async completeDrinkTicket(
    ticketId: string,
    stationId: string,
    orderId: string,
    fulfillmentId: string,
  ) {
    await this.apply(
      this.admin.managePreparationTicket({
        ...(await this.base(`ticket_create_${ticketId}`)),
        operation: {
          kind: "create",
          ticketId,
          orderId,
          fulfillmentId,
          stationId,
        },
      }),
    );
    await this.apply(
      this.admin.managePreparationTicket({
        ...(await this.base(`ticket_start_${ticketId}`)),
        operation: {
          kind: "start",
          ticketId,
          expectedTicketRevision: 1,
        },
      }),
    );
    await this.apply(
      this.admin.managePreparationTicket({
        ...(await this.base(`ticket_complete_${ticketId}`)),
        operation: {
          kind: "complete",
          ticketId,
          expectedTicketRevision: 2,
        },
      }),
    );
  }

  async handOverPickup(
    orderId: string,
    paymentId: string,
    fulfillmentId: string,
  ) {
    const snap1 = await required(this.admin.readSnapshot(merchantId));
    const order1 = snap1.resources.orders.find((o) => o.id === orderId)!;
    const f1 = snap1.resources.fulfillments.find((f) => f.id === fulfillmentId)!;
    await this.apply(
      this.admin.markPickupReady({
        ...(await this.base(`ready_${orderId}`)),
        orderId,
        orderRevision: order1.revision,
        fulfillmentId,
        fulfillmentRevision: f1.revision,
      }),
    );
    const snap2 = await required(this.admin.readSnapshot(merchantId));
    const order2 = snap2.resources.orders.find((o) => o.id === orderId)!;
    const p2 = snap2.resources.payments.find((p) => p.id === paymentId)!;
    const f2 = snap2.resources.fulfillments.find((f) => f.id === fulfillmentId)!;
    await this.apply(
      this.admin.completePickup({
        ...(await this.base(`complete_${orderId}`)),
        orderId,
        orderRevision: order2.revision,
        paymentId,
        paymentRevision: p2.revision,
        fulfillmentId,
        fulfillmentRevision: f2.revision,
      }),
    );
  }

  async buildRefundCommand(
    order: Readonly<{ id: string; revision: number }>,
    payment: Readonly<{ id: string; revision: number }>,
    line: Readonly<{
      id: string;
      lineTotal: Readonly<{ amountMinor: number; currency: string }>;
    }>,
  ) {
    return {
      ...(await this.base("cash_refund_1")),
      orderId: order.id,
      orderRevision: order.revision,
      paymentId: payment.id,
      paymentRevision: payment.revision,
      refundAttemptId: "refund_cash_1",
      refundPolicyId: "refund_counter",
      amount: line.lineTotal,
      allocation: {
        lineAllocations: [{ orderLineId: line.id, amount: line.lineTotal }],
        taxAllocations: [],
        dutyAllocations: [],
        shippingAllocation: jpy(0),
      },
      reason: "Customer changed mind at counter",
    };
  }

  async readOnHand(
    itemIds: readonly string[],
  ): Promise<Record<string, number>> {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    const totals: Record<string, number> = {};
    for (const itemId of itemIds) {
      const position = snapshot.resources.inventoryPositions.find(
        (p) => p.inventoryItemId === itemId && p.locationId === LOCATION,
      );
      if (position === undefined || position.balance.kind !== "accounted") {
        throw new Error(`Missing accounted position for ${itemId}`);
      }
      totals[itemId] = position.balance.onHand.amount;
    }
    return totals;
  }
}
