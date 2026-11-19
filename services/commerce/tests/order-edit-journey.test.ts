// Plan 76A steps 2.0 and 2B: staff edit pickup orders before they are ready.
// A higher total opens a balance checkout that the buyer pays from the order
// link; a lower total is refunded; a cancelled edited order refunds both
// payments. Set ORDER_EDIT_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import type {
  EditCommerceOrderV1,
  CommerceAdminClient,
  CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
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

const TEA_POSITION = "position_tea_tin_cafe";
const SMALL_SENCHA = "variant_tea_small_sencha";
const SMALL_HOJICHA = "variant_tea_small_hojicha";
const LARGE_SENCHA = "variant_tea_large_sencha";

it(
  "edits pickup orders, collects the balance, refunds the difference and cancels",
  { timeout: 60_000 },
  editPickupOrders,
);

async function editPickupOrders(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new EditStaff(admin);
    await staff.createTea();

    // Mio orders two small sencha tins and one small hojicha tin: 3,960 yen
    // with 10% tax.
    const mio = await Buyer.start(buyer, "mio");
    const mioOrder = await mio.buyLines([
      { ...catalogLine(SMALL_SENCHA), quantity: 2 },
      catalogLine(SMALL_HOJICHA),
    ]);
    const mioPlacement = mio.lastPlacement;
    if (mioPlacement === undefined) throw new Error("Mio's order has no link");
    expect(await staff.total(mioOrder)).toEqual(jpy(3_960));
    expect(await staff.stock()).toEqual({ onHand: 40, available: 37 });
    // The buyer owes nothing yet, so there is no balance to pay.
    expect(
      rejectionOf(
        await buyer.openOrderBalance(
          merchantId,
          STOREFRONT,
          mioPlacement.checkoutId,
          mioPlacement.recoveryToken,
        ),
      ),
    ).toMatchObject({ field: "orderBalance.none" });

    // Staff swap the hojicha tin for a large sencha tin: 4,620 yen.
    const hojicha = await staff.lineId(mioOrder, "TEA-S-HOJICHA");
    const swap = {
      lineChanges: [{ orderLineId: hojicha, quantity: 0 }],
      additions: [{ variantId: LARGE_SENCHA, quantity: 1 }],
    };
    expect(await staff.editOrder("mio_swap", mioOrder, 1, swap)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "edit_order", resource: { revision: 2 } },
    });
    // A second edit made from the same order revision is refused.
    expect(
      await staff.editOrder("mio_stale", mioOrder, 1, {
        lineChanges: [],
        additions: [{ variantId: SMALL_HOJICHA, quantity: 1 }],
      }),
    ).toMatchObject(
      rejectedWith({ code: "stale_resource_revision", expected: 1, actual: 2 }),
    );
    expect(await staff.lines(mioOrder)).toEqual([
      ["TEA-S-SENCHA", 2, 2_400, 240],
      ["TEA-L-SENCHA", 1, 1_800, 180],
    ]);
    expect(await staff.fulfillmentLines(mioOrder)).toEqual([2, 1]);
    expect(await staff.stock()).toEqual({ onHand: 40, available: 37 });
    expect((await staff.changes(mioOrder)).balance).toEqual({
      total: jpy(4_620),
      captured: jpy(3_960),
      refunded: jpy(0),
      outstanding: jpy(660),
      refundDue: jpy(0),
    });
    // The order cannot be made ready while it owes 660 yen.
    expect(await staff.markReady(mioOrder)).toMatchObject(
      rejectedWith({ field: "pickupFulfillment.balance" }),
    );

    // Mio opens the order link and pays the balance.
    const balance = await required(
      buyer.openOrderBalance(
        merchantId,
        STOREFRONT,
        mioPlacement.checkoutId,
        mioPlacement.recoveryToken,
      ),
    );
    expect(balance.checkout.quote.totals.total).toEqual(jpy(660));
    expect(balance.checkout.quote.lines).toEqual([
      expect.objectContaining({ kind: "order_balance", orderId: mioOrder }),
    ]);
    // Opening the link again reaches the same checkout.
    const reopened = await required(
      buyer.openOrderBalance(
        merchantId,
        STOREFRONT,
        mioPlacement.checkoutId,
        mioPlacement.recoveryToken,
      ),
    );
    expect(reopened.checkout.checkoutId).toBe(balance.checkout.checkoutId);
    const mioBalance = new Buyer(buyer, "mio_balance", balance.session.token);
    expect(await mioBalance.pay(balance.checkout)).toBe(mioOrder);
    const mioChanges = await staff.changes(mioOrder);
    expect(mioChanges.balance).toMatchObject({
      captured: jpy(4_620),
      outstanding: jpy(0),
    });
    expect(mioChanges.changes.map((change) => change.kind)).toEqual([
      "edit",
      "payment",
    ]);

    // Staff make the order ready; after that, an edit is refused.
    expect(await staff.markReady(mioOrder)).toMatchObject({
      outcome: "applied",
    });
    expect(
      await staff.editOrder("mio_late", mioOrder, 3, {
        lineChanges: [],
        additions: [{ variantId: SMALL_HOJICHA, quantity: 1 }],
      }),
    ).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "pickup_fulfillment",
        state: "ready_for_pickup",
        event: "edit",
      }),
    );
    // Collection commits the stock of the edited lines only: three tins.
    expect(await staff.completePickup(mioOrder)).toMatchObject({
      outcome: "applied",
    });
    expect(await staff.stock()).toEqual({ onHand: 37, available: 37 });

    // Kai orders three small sencha tins, then keeps only one: the edit
    // lowers the total by 2,640 yen, which staff refund to the card.
    const kai = await Buyer.start(buyer, "kai");
    const kaiOrder = await kai.buyLines([
      { ...catalogLine(SMALL_SENCHA), quantity: 3 },
    ]);
    const kaiSencha = await staff.lineId(kaiOrder, "TEA-S-SENCHA");
    expect(
      await staff.editOrder("kai_fewer", kaiOrder, 1, {
        lineChanges: [{ orderLineId: kaiSencha, quantity: 1 }],
        additions: [],
      }),
    ).toMatchObject({ outcome: "applied" });
    expect(await staff.stock()).toEqual({ onHand: 37, available: 36 });
    expect((await staff.changes(kaiOrder)).balance).toMatchObject({
      total: jpy(1_320),
      outstanding: jpy(0),
      refundDue: jpy(2_640),
    });
    // The refund names the units the edit took away.
    expect(
      await staff.refund(kaiOrder, kaiSencha, 2_400, 240, "Two tins removed"),
    ).toMatchObject({ outcome: "applied" });
    expect((await staff.changes(kaiOrder)).balance).toMatchObject({
      refunded: jpy(2_640),
      refundDue: jpy(0),
    });

    // Noa orders one tin and staff add a large tin; Noa pays the balance.
    const noa = await Buyer.start(buyer, "noa");
    const noaOrder = await noa.buyLines([catalogLine(SMALL_SENCHA)]);
    const noaPlacement = noa.lastPlacement;
    if (noaPlacement === undefined) throw new Error("Noa's order has no link");
    await staff.editOrder("noa_more", noaOrder, 1, {
      lineChanges: [],
      additions: [{ variantId: LARGE_SENCHA, quantity: 1 }],
    });
    const noaBalance = await required(
      buyer.openOrderBalance(
        merchantId,
        STOREFRONT,
        noaPlacement.checkoutId,
        noaPlacement.recoveryToken,
      ),
    );
    await new Buyer(buyer, "noa_balance", noaBalance.session.token).pay(
      noaBalance.checkout,
    );
    expect(await staff.stock()).toEqual({ onHand: 37, available: 34 });
    // Noa cancels: both payments are refunded and both tins go back.
    expect(await staff.cancel(noaOrder)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "cancel_order" },
    });
    const noaPayments = await staff.payments(noaOrder);
    expect(
      noaPayments.map((payment) => [
        payment.amount.amountMinor,
        payment.lifecycle.state,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [1_320, "refunded"],
        [1_980, "refunded"],
      ]),
    );
    expect(noaPayments).toHaveLength(2);
    expect((await staff.changes(noaOrder)).balance).toMatchObject({
      captured: jpy(3_300),
      refunded: jpy(3_300),
    });
    expect(await staff.stock()).toEqual({ onHand: 37, available: 36 });

    Object.assign(evidence, {
      receipts: staff.receipts,
      orders: {
        mio: await staff.changes(mioOrder),
        kai: await staff.changes(kaiOrder),
        noa: await staff.changes(noaOrder),
      },
      noaPayments: noaPayments.map((payment) => payment.lifecycle),
      stock: await staff.stock(),
    });
  } finally {
    writeEvidence("ORDER_EDIT_ARTIFACT_DIR", "order-edit", evidence);
    backend.close();
  }
}

class EditStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "edit");
  }

  editOrder(
    editId: string,
    orderId: string,
    expectedOrderRevision: number,
    change: Pick<EditCommerceOrderV1, "lineChanges" | "additions">,
  ): Promise<CommerceMutationResultV1> {
    return this.edit(
      this.admin.editOrder({
        ...this.editBase(`edit_${editId}`),
        editId,
        orderId,
        expectedOrderRevision,
        ...change,
        reason: "Buyer asked by phone",
      }),
    );
  }

  changes(orderId: string) {
    return required(this.admin.readOrderChanges(merchantId, orderId));
  }

  async order(orderId: string) {
    const order = (await this.snapshot()).orders.find(
      (item) => item.id === orderId,
    );
    if (order === undefined) throw new Error(`${orderId} is missing`);
    return order;
  }

  async total(orderId: string) {
    return (await this.order(orderId)).totals.total;
  }

  async lines(orderId: string) {
    return (await this.order(orderId)).lineItems.map((line) => [
      line.sku,
      line.quantity.amount,
      line.lineTotal.amountMinor,
      line.tax.amountMinor,
    ]);
  }

  async lineId(orderId: string, sku: string): Promise<string> {
    const line = (await this.order(orderId)).lineItems.find(
      (item) => item.sku === sku,
    );
    if (line === undefined) throw new Error(`${orderId} has no ${sku} line`);
    return line.id;
  }

  async fulfillmentLines(orderId: string) {
    const fulfillment = (await this.snapshot()).fulfillments.find(
      (item) => item.orderId === orderId,
    );
    return fulfillment?.lineItems.map((line) => line.quantity);
  }

  async payments(orderId: string) {
    return (await this.snapshot()).payments.filter(
      (item) => item.orderId === orderId,
    );
  }

  /** The order's first payment: the one its checkout took. */
  async firstPayment(orderId: string) {
    const later = new Set(
      (await this.changes(orderId)).changes.flatMap((change) =>
        change.kind === "payment" ? [change.paymentId] : [],
      ),
    );
    const payment = (await this.payments(orderId)).find(
      (item) => !later.has(item.id),
    );
    if (payment === undefined) throw new Error(`${orderId} has no payment`);
    return payment;
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

  async #target(orderId: string, step: string) {
    const order = await this.order(orderId);
    const fulfillment = (await this.snapshot()).fulfillments.find(
      (item) => item.orderId === orderId,
    );
    if (fulfillment === undefined) throw new Error(`${orderId} has no pickup`);
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
        ...(await this.#target(orderId, "pickup_ready")),
      }),
    );
  }

  async completePickup(orderId: string): Promise<CommerceMutationResultV1> {
    const payment = await this.firstPayment(orderId);
    return this.edit(
      this.admin.completePickup({
        ...(await this.#target(orderId, "pickup_complete")),
        paymentId: payment.id,
        paymentRevision: payment.revision,
      }),
    );
  }

  async cancel(orderId: string): Promise<CommerceMutationResultV1> {
    const payment = await this.firstPayment(orderId);
    return this.edit(
      this.admin.cancelOrder({
        ...(await this.#target(orderId, "cancel")),
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_cancel_${orderId.slice(-8)}`,
        reason: "Buyer cancelled",
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    lineMinor: number,
    taxMinor: number,
    reason: string,
  ): Promise<CommerceMutationResultV1> {
    const order = await this.order(orderId);
    const payment = await this.firstPayment(orderId);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base("refund")),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_edit_${orderId.slice(-8)}`,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(lineMinor + taxMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(lineMinor) }],
          taxAllocations: [{ orderLineId, amount: jpy(taxMinor) }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason,
      }),
    );
  }
}
