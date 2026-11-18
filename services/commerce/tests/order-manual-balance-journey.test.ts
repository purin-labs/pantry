// Plan 77 step 2: staff take an edited order's balance outside a payment
// provider. Rin's order grows by a large tin; Rin opens the balance link but
// pays by bank transfer instead, and staff record it. The order owes
// nothing, can be made ready, and Rin's open balance checkout can no longer
// take a card payment. While Sora is paying a balance by card, staff cannot
// record the same money. Tom pays his balance in cash and cancels: the card
// payment goes back through the provider and staff return the cash. Set
// ORDER_MANUAL_BALANCE_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type {
  RecordCommerceOrderManualPaymentV1,
  CommerceAdminClient,
  CommerceMutationResultV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  rejectionOf,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SMALL_SENCHA = "variant_tea_small_sencha";
const LARGE_SENCHA = "variant_tea_large_sencha";

it(
  "records an order balance paid in cash or by bank transfer",
  { timeout: 60_000 },
  manualBalances,
);

async function manualBalances(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new BalanceDesk(admin);
    await staff.createTea();

    // Rin orders a small tin (1,320 yen); staff add a large tin by phone.
    const rin = await Buyer.start(buyer, "rin");
    const rinOrder = await rin.buyLines([catalogLine(SMALL_SENCHA)]);
    const rinPlacement = rin.lastPlacement;
    if (rinPlacement === undefined) throw new Error("Rin's order has no link");
    await staff.addLargeTin("rin", rinOrder);
    expect((await staff.changes(rinOrder)).balance.outstanding).toEqual(
      jpy(1_980),
    );
    // Rin opens the balance link, then pays by bank transfer instead.
    const link = await required(
      buyer.openOrderBalance(
        merchantId,
        STOREFRONT,
        rinPlacement.checkoutId,
        rinPlacement.recoveryToken,
      ),
    );
    const transfer = {
      method: "bank_transfer",
      reference: "MIZUHO-0425",
    } as const;
    const refusals = {
      amount: await staff.record("rin_short", rinOrder, 2, 1_000, transfer),
      stale: await staff.record("rin_stale", rinOrder, 1, 1_980, transfer),
    };
    expect(refusals).toMatchObject({
      amount: rejectedWith({ field: "amount" }),
      stale: rejectedWith({ code: "stale_resource_revision", expected: 1 }),
    });
    const recorded = await staff.record(
      "rin_transfer",
      rinOrder,
      2,
      1_980,
      transfer,
    );
    expect(recorded).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "record_order_manual_payment",
        resource: { kind: "commerce_order", id: rinOrder, revision: 3 },
      },
    });
    // The same request again answers with the same receipt.
    expect(
      await staff.record("rin_transfer", rinOrder, 2, 1_980, transfer),
    ).toMatchObject({ outcome: "replayed" });
    const rinChanges = await staff.changes(rinOrder);
    expect(rinChanges.balance).toMatchObject({
      captured: jpy(3_300),
      outstanding: jpy(0),
    });
    const payment = rinChanges.changes.at(-1);
    expect(payment).toMatchObject({ kind: "payment", amount: jpy(1_980) });
    expect(payment).not.toHaveProperty("checkoutId");
    // Rin's open balance checkout can no longer take a card payment, and the
    // link has nothing left to pay.
    const linkPayment = await new Buyer(
      buyer,
      "rin_link",
      link.session.token,
    ).tryPay(link.checkout);
    expect(linkPayment).toMatchObject({ code: "checkout_refresh_required" });
    expect(
      rejectionOf(
        await buyer.openOrderBalance(
          merchantId,
          STOREFRONT,
          rinPlacement.checkoutId,
          rinPlacement.recoveryToken,
        ),
      ),
    ).toMatchObject({ field: "orderBalance.none" });
    expect(await staff.markReady(rinOrder)).toMatchObject({
      outcome: "applied",
    });

    // Sora is paying a balance by card; staff cannot record the same money.
    const sora = await Buyer.start(buyer, "sora");
    const soraOrder = await sora.buyLines([catalogLine(SMALL_SENCHA)]);
    const soraPlacement = sora.lastPlacement;
    if (soraPlacement === undefined)
      throw new Error("Sora's order has no link");
    await staff.addLargeTin("sora", soraOrder);
    const soraLink = await required(
      buyer.openOrderBalance(
        merchantId,
        STOREFRONT,
        soraPlacement.checkoutId,
        soraPlacement.recoveryToken,
      ),
    );
    await new Buyer(buyer, "sora_link", soraLink.session.token).startPayment(
      soraLink.checkout,
    );
    const whilePaying = await staff.record("sora_cash", soraOrder, 2, 1_980, {
      method: "cash",
    });
    expect(whilePaying).toMatchObject(
      rejectedWith({ field: "orderBalance.paymentPending" }),
    );

    // Tom pays his balance in cash, then cancels: both payments go back.
    const tom = await Buyer.start(buyer, "tom");
    const tomOrder = await tom.buyLines([catalogLine(SMALL_SENCHA)]);
    await staff.addLargeTin("tom", tomOrder);
    expect(
      await staff.record("tom_cash", tomOrder, 2, 1_980, { method: "cash" }),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.cancel(tomOrder)).toMatchObject({ outcome: "applied" });
    const tomPayments = (await staff.payments(tomOrder)).map((item) => [
      item.amount.amountMinor,
      item.lifecycle.state,
    ]);
    expect(tomPayments).toEqual(
      expect.arrayContaining([
        [1_320, "refunded"],
        [1_980, "refunded"],
      ]),
    );
    expect((await staff.changes(tomOrder)).balance).toMatchObject({
      captured: jpy(3_300),
      refunded: jpy(3_300),
    });

    const paidEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind === "order.paid");
    expect(paidEvents).toHaveLength(2);

    Object.assign(evidence, {
      receipts: staff.receipts,
      refusals,
      whilePaying,
      linkPayment,
      orders: {
        rin: rinChanges,
        tom: await staff.changes(tomOrder),
      },
      tomPayments,
      paidEvents,
    });
  } finally {
    writeEvidence(
      "ORDER_MANUAL_BALANCE_ARTIFACT_DIR",
      "order-manual-balance",
      evidence,
    );
    backend.close();
  }
}

class BalanceDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "manual_balance");
  }

  addLargeTin(name: string, orderId: string) {
    return this.edit(
      this.admin.editOrder({
        ...this.editBase(`edit_${name}`),
        editId: `edit_${name}`,
        orderId,
        expectedOrderRevision: 1,
        lineChanges: [],
        additions: [{ variantId: LARGE_SENCHA, quantity: 1 }],
        reason: "Buyer asked by phone",
      }),
    );
  }

  record(
    key: string,
    orderId: string,
    expectedOrderRevision: number,
    amountMinor: number,
    tender: RecordCommerceOrderManualPaymentV1["tender"],
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.recordOrderManualPayment({
        ...this.editBase(`record_${key}`),
        orderId,
        expectedOrderRevision,
        paymentId: `payment_${key}`,
        amount: jpy(amountMinor),
        tender,
      }),
    );
  }

  changes(orderId: string) {
    return required(this.admin.readOrderChanges(merchantId, orderId));
  }

  async payments(orderId: string) {
    return (await this.snapshot()).payments.filter(
      (item) => item.orderId === orderId,
    );
  }

  async #target(orderId: string, step: string) {
    const snapshot = await this.snapshot();
    const order = snapshot.orders.find((item) => item.id === orderId);
    const fulfillment = snapshot.fulfillments.find(
      (item) => item.orderId === orderId,
    );
    if (order === undefined || fulfillment === undefined)
      throw new Error(`${orderId} has no pickup`);
    return {
      ...(await this.base(step)),
      orderId,
      orderRevision: order.revision,
      fulfillmentId: fulfillment.id,
      fulfillmentRevision: fulfillment.revision,
    };
  }

  async markReady(orderId: string): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.markPickupReady({
        ...(await this.#target(orderId, `ready_${orderId.slice(-8)}`)),
      }),
    );
  }

  /** Cancels the order, naming the payment that its checkout took. */
  async cancel(orderId: string): Promise<CommerceMutationResultV1> {
    const changes = await this.changes(orderId);
    const later = new Set(
      changes.changes.flatMap((change) =>
        change.kind === "payment" ? [change.paymentId] : [],
      ),
    );
    const first = (await this.snapshot()).payments.find(
      (item) => item.orderId === orderId && !later.has(item.id),
    );
    if (first === undefined) throw new Error(`${orderId} has no payment`);
    return this.edit(
      this.admin.cancelOrder({
        ...(await this.#target(orderId, `cancel_${orderId.slice(-8)}`)),
        paymentId: first.id,
        paymentRevision: first.revision,
        refundAttemptId: `refund_cancel_${orderId.slice(-8)}`,
        reason: "Buyer cancelled",
      }),
    );
  }
}
