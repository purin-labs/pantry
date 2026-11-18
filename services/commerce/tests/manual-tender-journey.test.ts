// Plan 77 step 2: staff mark a draft order as paid by bank transfer or in
// cash. The draft becomes an order with one captured payment, a refund of
// that payment asks no provider, and a cancellation gives the stock back. A
// draft whose buyer is paying by card cannot be marked as paid, so no draft
// is paid twice. Set MANUAL_TENDER_ARTIFACT_DIR to keep the run's evidence;
// the file repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceDraftOrderLineV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const TEA_POSITION = "position_tea_tin_cafe";

it(
  "turns a draft that staff were paid for into an order, and refunds it without a provider",
  { timeout: 60_000 },
  markDraftsAsPaid,
);

async function markDraftsAsPaid(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ManualDesk(admin);
    await staff.createTea();

    // Aiko orders by phone: two small tins at a staff price and one large
    // tin at the catalog price. She pays by bank transfer.
    const aikoLines: readonly CommerceDraftOrderLineV1[] = [
      {
        lineId: "line_small",
        variantId: SMALL_SENCHA,
        quantity: 2,
        priceOverride: { unitPrice: jpy(1_000), reason: "Regular customer" },
      },
      {
        lineId: "line_large",
        variantId: LARGE_SENCHA,
        quantity: 1,
        priceOverride: null,
      },
    ];
    await staff.createDraft("draft_aiko", aikoLines);
    const transfer = {
      method: "bank_transfer",
      reference: "MIZUHO 0814 AIKO",
    } as const;
    const paid = await staff.markDraftPaid("draft_aiko", 1, transfer, "aiko");
    expect(paid).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "mark_draft_order_paid",
        resource: { kind: "commerce_order", id: "order_aiko", revision: 1 },
      },
    });
    // The same request again gets the same receipt; a second payment for
    // the draft is refused.
    expect(
      await staff.markDraftPaid("draft_aiko", 1, transfer, "aiko"),
    ).toEqual({ ...paid, outcome: "replayed" });
    expect(
      await staff.markDraftPaid("draft_aiko", 1, { method: "cash" }, "again"),
    ).toMatchObject(rejectedWith({ field: "draftOrder.completed" }));

    // The draft names its order and the transfer. The order keeps the staff
    // price, and its one payment covers the whole total.
    const aikoDraft = await required(
      admin.readDraftOrder(merchantId, "draft_aiko"),
    );
    expect(aikoDraft.completion).toEqual({
      checkoutId: aikoDraft.checkoutIds[0],
      orderId: "order_aiko",
      manualTender: { ...transfer, recordedAt: NOW },
    });
    const aiko = await staff.order("order_aiko");
    expect(
      aiko.lineItems.map((line) => ({
        sku: line.sku,
        quantity: line.quantity.amount,
        unitPrice: line.unitPrice,
      })),
    ).toEqual([
      { sku: "TEA-S-SENCHA", quantity: 2, unitPrice: jpy(1_000) },
      { sku: "TEA-L-SENCHA", quantity: 1, unitPrice: jpy(1_800) },
    ]);
    expect(await staff.payment("payment_aiko")).toMatchObject({
      orderId: "order_aiko",
      amount: aiko.totals.total,
      lifecycle: { state: "captured", capturedAt: NOW },
    });
    expect((await staff.changes("order_aiko")).balance).toMatchObject({
      captured: aiko.totals.total,
      outstanding: jpy(0),
    });
    expect(await staff.eventKinds("order_aiko")).toEqual(["order.created"]);

    // The large tin was dented. Staff refund it; no provider holds the
    // money, so the refund resolves at once and staff pay it back.
    const largeLine = aiko.lineItems[1]?.id;
    if (largeLine === undefined) throw new Error("Aiko's order has no line");
    expect(
      await staff.refund("order_aiko", largeLine, "refund_aiko_large", 1_800),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.payment("payment_aiko")).toMatchObject({
      lifecycle: { state: "partially_refunded", refundedAmount: jpy(1_800) },
    });
    const aikoRecord = await required(
      admin.readOrderRecord(merchantId, "order_aiko"),
    );
    expect(
      aikoRecord.refundAttempts.map((attempt) => attempt.lifecycle),
    ).toMatchObject([
      {
        state: "succeeded",
        providerRefundReference: "manual_refund_aiko_large",
      },
    ]);
    expect((await staff.changes("order_aiko")).balance).toMatchObject({
      refunded: jpy(1_800),
    });

    // Ben opens his invoice link and starts to pay by card. While his card
    // payment is open, staff cannot mark the draft as paid; once he has
    // paid, the draft is complete.
    await staff.createDraft("draft_ben", [
      {
        lineId: "line_small",
        variantId: SMALL_SENCHA,
        quantity: 1,
        priceOverride: null,
      },
    ]);
    const benLink = (await staff.sendDraftInvoiceLink("draft_ben", 1)).token;
    if (benLink === undefined) throw new Error("No invoice link was sent");
    const opened = await required(
      buyer.openDraftInvoice(merchantId, STOREFRONT, "draft_ben", benLink),
    );
    const ben = new Buyer(buyer, "ben", opened.session.token);
    await ben.startPayment(opened.checkout);
    const whilePaying = await staff.markDraftPaid("draft_ben", 2, {
      method: "cash",
    });
    expect(whilePaying).toEqual({
      outcome: "rejected",
      error: {
        code: "invalid_transition",
        machine: "checkout",
        state: "payment_pending",
        event: "place_manually",
      },
    });
    const benOrder = await ben.pay(opened.checkout);
    expect(
      await staff.markDraftPaid("draft_ben", 2, { method: "cash" }),
    ).toMatchObject(rejectedWith({ field: "draftOrder.completed" }));
    expect(
      (await required(admin.readDraftOrder(merchantId, "draft_ben")))
        .completion,
    ).toEqual({ checkoutId: opened.checkout.checkoutId, orderId: benOrder });

    // Chie pays cash for a small tin, then cancels. The cancellation refunds
    // the cash payment in full and gives the tin back to stock.
    await staff.createDraft("draft_chie", [
      {
        lineId: "line_small",
        variantId: SMALL_SENCHA,
        quantity: 1,
        priceOverride: null,
      },
    ]);
    const before = await staff.stock();
    expect(
      await staff.markDraftPaid("draft_chie", 1, { method: "cash" }),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.stock()).toEqual({
      onHand: before?.onHand,
      available: (before?.available ?? 0) - 1,
    });
    expect(await staff.cancel("order_chie")).toMatchObject({
      outcome: "applied",
    });
    const chie = await staff.order("order_chie");
    expect(chie.lifecycle.state).toBe("cancelled");
    expect(await staff.payment("payment_chie")).toMatchObject({
      lifecycle: { state: "refunded", refundedAmount: chie.totals.total },
    });
    expect(await staff.stock()).toEqual(before);

    Object.assign(evidence, {
      receipts: staff.receipts,
      aikoDraft,
      aikoTotals: aiko.totals,
      aikoRefunds: aikoRecord.refundAttempts.map((attempt) => ({
        refundAttemptId: attempt.refundAttemptId,
        lifecycle: attempt.lifecycle,
      })),
      aikoBalance: (await staff.changes("order_aiko")).balance,
      benWhilePaying: whilePaying,
      chie: { state: chie.lifecycle.state, total: chie.totals.total },
      chiePayment: await staff.payment("payment_chie"),
    });
  } finally {
    writeEvidence("MANUAL_TENDER_ARTIFACT_DIR", "manual-tender", evidence);
    backend.close();
  }
}

class ManualDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "manual");
  }

  async payment(paymentId: string) {
    const payment = (await this.snapshot()).payments.find(
      (item) => item.id === paymentId,
    );
    if (payment === undefined) throw new Error(`${paymentId} is missing`);
    return payment;
  }

  async eventKinds(orderId: string): Promise<readonly string[]> {
    const page = await required(
      this.admin.readEvents(merchantId, { limit: 200 }),
    );
    return page.events
      .filter((event) =>
        event.resources.some((resource) => resource.id === orderId),
      )
      .map((event) => event.kind);
  }

  async stock() {
    const position = (await this.snapshot()).inventoryPositions.find(
      (item) => item.id === TEA_POSITION,
    );
    return position?.balance.kind === "accounted"
      ? {
          onHand: position.balance.onHand.amount,
          available: position.balance.available.amount,
        }
      : undefined;
  }
}
