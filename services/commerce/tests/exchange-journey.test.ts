// Plan 76A step 2C, exchanges: Ana collects two small sencha tins and a
// hojicha tin, returns one small tin and exchanges it for a large one. The
// order gets a second pickup fulfillment for the large tin, waits for the
// 660 yen difference, which Ana pays with her order link, and is fulfilled
// when she collects it. Bo exchanges a large tin for a cheaper hojicha tin;
// staff refund the 660 yen difference against the line that left the order.
// An exchange needs a received return, closes it, and cannot run twice.
// Set EXCHANGE_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  LOCATION,
  NOW,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SMALL_SENCHA = "variant_tea_small_sencha";
const SMALL_HOJICHA = "variant_tea_small_hojicha";
const LARGE_SENCHA = "variant_tea_large_sencha";
const TEA_POSITION = "position_tea_tin_cafe";

it(
  "exchanges returned units for new lines in a second fulfillment, settling the difference",
  { timeout: 60_000 },
  exchangeReturnedUnits,
);

async function exchangeReturnedUnits(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new ExchangeStaff(admin);
    await staff.createTea();

    // Ana collects two small sencha tins and a hojicha tin: 3,960 yen.
    const ana = await Buyer.start(buyer, "ana");
    const anaOrder = await ana.buyLines([
      { ...catalogLine(SMALL_SENCHA), quantity: 2 },
      catalogLine(SMALL_HOJICHA),
    ]);
    const anaLink = ana.lastPlacement;
    if (anaLink === undefined) throw new Error("Ana's order has no link");
    await staff.collect(anaOrder);
    expect(await staff.stock()).toEqual({ onHand: 37, available: 37 });

    // She returns one small tin. Until it is received, no exchange.
    const small = await staff.lineId(anaOrder, "TEA-S-SENCHA");
    await staff.returnUnits("return_ana", anaOrder, small, 1);
    expect(await staff.exchange("ana_early", anaOrder, "return_ana", LARGE_SENCHA)).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "return",
        state: "authorized",
        event: "exchange",
      }),
    );
    await staff.receive("return_ana");
    expect(await staff.stock()).toEqual({ onHand: 38, available: 38 });

    // The exchange: one small tin out, one large tin in. 4,620 yen now.
    expect(await staff.exchange("ana_large", anaOrder, "return_ana", LARGE_SENCHA)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "exchange_order_lines", resource: { kind: "commerce_order" } },
    });
    expect(await staff.lines(anaOrder)).toEqual([
      ["TEA-S-SENCHA", 1, 1, 1_200],
      ["TEA-S-HOJICHA", 1, 1, 1_200],
      ["TEA-L-SENCHA", 1, 0, 1_800],
    ]);
    expect(await staff.fulfillments(anaOrder)).toEqual([
      ["completed", ["TEA-S-SENCHA", "TEA-S-HOJICHA"]],
      ["requested", ["TEA-L-SENCHA"]],
    ]);
    expect(await staff.returnState("return_ana")).toMatchObject({
      state: "closed",
      exchangeId: "ana_large",
      refundAttemptId: null,
    });
    expect((await staff.changes(anaOrder)).balance).toMatchObject({
      total: jpy(4_620),
      outstanding: jpy(660),
    });
    // The large tin is held for Ana.
    expect(await staff.stock()).toEqual({ onHand: 38, available: 37 });
    // Nothing more changes until the large tin is handed over: no second
    // exchange and no edit.
    expect(await staff.exchange("ana_again", anaOrder, "return_ana", SMALL_HOJICHA)).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "order",
        state: "fulfillment_pending",
        event: "exchange",
      }),
    );
    expect(await staff.editOrder(anaOrder)).toMatchObject(
      rejectedWith({ field: "orderEdit.fulfillment" }),
    );
    // No handover while she owes 660 yen; she pays it with her order link.
    expect(await staff.markReady(anaOrder)).toMatchObject(
      rejectedWith({ field: "pickupFulfillment.balance" }),
    );
    const balance = await required(
      buyer.openOrderBalance(merchantId, STOREFRONT, anaLink.checkoutId, anaLink.recoveryToken),
    );
    expect(balance.checkout.quote.totals.total).toEqual(jpy(660));
    await new Buyer(buyer, "ana_balance", balance.session.token).pay(balance.checkout);
    await staff.collect(anaOrder);
    const anaDone = await staff.order(anaOrder);
    expect(anaDone.lifecycle.state).toBe("fulfilled");
    expect(await staff.lines(anaOrder)).toEqual([
      ["TEA-S-SENCHA", 1, 1, 1_200],
      ["TEA-S-HOJICHA", 1, 1, 1_200],
      ["TEA-L-SENCHA", 1, 1, 1_800],
    ]);
    expect(await staff.stock()).toEqual({ onHand: 37, available: 37 });
    const anaChanges = await staff.changes(anaOrder);
    expect(anaChanges.changes.map((change) => change.kind)).toEqual(["exchange", "payment"]);
    // The closed return cannot settle a second exchange.
    expect(await staff.exchange("ana_again", anaOrder, "return_ana", SMALL_HOJICHA)).toMatchObject(
      rejectedWith({
        code: "invalid_transition",
        machine: "return",
        state: "closed",
        event: "exchange",
      }),
    );

    // Bo exchanges a large tin for a hojicha tin; staff refund the 660 yen.
    const bo = await Buyer.start(buyer, "bo");
    const boOrder = await bo.buyLines([catalogLine(LARGE_SENCHA)]);
    await staff.collect(boOrder);
    const large = await staff.lineId(boOrder, "TEA-L-SENCHA");
    await staff.returnUnits("return_bo", boOrder, large, 1);
    await staff.receive("return_bo");
    expect(
      await staff.exchange("bo_hojicha", boOrder, "return_bo", SMALL_HOJICHA),
    ).toMatchObject({ outcome: "applied" });
    expect((await staff.changes(boOrder)).balance).toMatchObject({
      total: jpy(1_320),
      refundDue: jpy(660),
    });
    expect(await staff.refund(boOrder, large, 600, 60)).toMatchObject({ outcome: "applied" });
    expect((await staff.changes(boOrder)).balance).toMatchObject({
      refunded: jpy(660),
      outstanding: jpy(0),
      refundDue: jpy(0),
    });
    await staff.collect(boOrder);
    expect((await staff.order(boOrder)).lifecycle.state).toBe("fulfilled");
    // Bo took a large tin, gave it back and took a hojicha tin: one tin less.
    expect(await staff.stock()).toEqual({ onHand: 36, available: 36 });

    Object.assign(evidence, {
      receipts: staff.receipts,
      ana: {
        lines: await staff.lines(anaOrder),
        fulfillments: await staff.fulfillments(anaOrder),
        changes: anaChanges,
      },
      bo: { changes: await staff.changes(boOrder), fulfillments: await staff.fulfillments(boOrder) },
      stock: await staff.stock(),
    });
  } finally {
    writeEvidence("EXCHANGE_ARTIFACT_DIR", "exchanges", evidence);
    backend.close();
  }
}

class ExchangeStaff extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "exchange");
  }

  async order(orderId: string) {
    const order = (await this.snapshot()).orders.find((item) => item.id === orderId);
    if (order === undefined) throw new Error(`${orderId} is missing`);
    return order;
  }

  /** Each line: SKU, quantity, quantity handed over, line total. */
  async lines(orderId: string) {
    return (await this.order(orderId)).lineItems.map((line) => [
      line.sku,
      line.quantity.amount,
      line.fulfilledQuantity.amount,
      line.lineTotal.amountMinor,
    ]);
  }

  /**
   * Each fulfillment of the order with its state and SKUs, ordered by the
   * order's first line in it (the clock does not move in this journey).
   */
  async fulfillments(orderId: string) {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const position = (lineId: string | undefined) =>
      order?.lineItems.findIndex((line) => line.id === lineId) ?? -1;
    return resources.fulfillments
      .filter((item) => item.orderId === orderId)
      .sort(
        (left, right) =>
          position(left.lineItems[0]?.lineItemId) - position(right.lineItems[0]?.lineItemId),
      )
      .map((fulfillment) => [
        fulfillment.lifecycle.state,
        fulfillment.lineItems.map(
          (item) => order?.lineItems.find((line) => line.id === item.lineItemId)?.sku,
        ),
      ]);
  }

  async lineId(orderId: string, sku: string): Promise<string> {
    const line = (await this.order(orderId)).lineItems.find((item) => item.sku === sku);
    if (line === undefined) throw new Error(`${orderId} has no ${sku} line`);
    return line.id;
  }

  async stock() {
    const position = (await this.snapshot()).inventoryPositions.find(
      (item) => item.id === TEA_POSITION,
    );
    return position?.balance.kind === "accounted"
      ? { onHand: position.balance.onHand.amount, available: position.balance.available.amount }
      : undefined;
  }

  changes(orderId: string) {
    return required(this.admin.readOrderChanges(merchantId, orderId));
  }

  async returnState(returnId: string) {
    const orders = (await this.snapshot()).orders;
    for (const order of orders) {
      const returns = await required(this.admin.listOrderReturns(merchantId, order.id));
      const found = returns.find((item) => item.id === returnId);
      if (found !== undefined) return found.lifecycle;
    }
    throw new Error(`${returnId} is missing`);
  }

  async #return(returnId: string) {
    for (const order of (await this.snapshot()).orders) {
      const found = (await required(this.admin.listOrderReturns(merchantId, order.id))).find(
        (item) => item.id === returnId,
      );
      if (found !== undefined) return found;
    }
    throw new Error(`${returnId} is missing`);
  }

  /** A staff return of some units of one line, authorized at once. */
  async returnUnits(returnId: string, orderId: string, orderLineId: string, quantity: number) {
    await this.apply(
      this.admin.requestReturn({
        ...this.editBase(`request_${returnId}`),
        returnId,
        orderId,
        lines: [{ orderLineId, quantity, reason: "Wrong size" }],
      }),
    );
    await this.apply(
      this.admin.authorizeReturn({
        ...this.editBase(`authorize_${returnId}`),
        returnId,
        expectedReturnRevision: 1,
        decisions: [{ orderLineId, decision: "authorized" }],
      }),
    );
  }

  async receive(returnId: string): Promise<void> {
    const record = await this.#return(returnId);
    await this.apply(
      this.admin.receiveReturn({
        ...this.editBase(`receive_${returnId}`),
        returnId,
        expectedReturnRevision: record.revision,
        locationId: LOCATION,
        dispositions: record.lines.map((line) => ({
          orderLineId: line.orderLineId,
          disposition: "restock" as const,
        })),
      }),
    );
  }

  async exchange(
    exchangeId: string,
    orderId: string,
    returnId: string,
    variantId: string,
  ): Promise<CommerceMutationResultV1> {
    const order = await this.order(orderId);
    const record = await this.#return(returnId);
    return this.edit(
      this.admin.exchangeOrderLines({
        ...this.editBase(`exchange_${exchangeId}_${this.step}`),
        exchangeId,
        orderId,
        expectedOrderRevision: order.revision,
        returnId,
        expectedReturnRevision: record.revision,
        additions: [{ variantId, quantity: 1 }],
        reason: "Exchanged for another tin",
      }),
    );
  }

  async editOrder(orderId: string): Promise<CommerceMutationResultV1> {
    const order = await this.order(orderId);
    return this.edit(
      this.admin.editOrder({
        ...this.editBase(`edit_${orderId.slice(-6)}`),
        editId: `edit_${orderId.slice(-6)}`,
        orderId,
        expectedOrderRevision: order.revision,
        lineChanges: [],
        additions: [{ variantId: SMALL_HOJICHA, quantity: 1 }],
        reason: "One more tin",
      }),
    );
  }

  async #open(orderId: string, name: string) {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const fulfillment = resources.fulfillments.find(
      (item) => item.orderId === orderId && item.lifecycle.state !== "completed",
    );
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || fulfillment === undefined || payment === undefined)
      throw new Error(`${orderId} has nothing to hand over`);
    return {
      base: {
        ...(await this.base(name)),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
      },
      payment,
    };
  }

  async markReady(orderId: string): Promise<CommerceMutationResultV1> {
    const target = await this.#open(orderId, "ready");
    return this.edit(this.admin.markPickupReady(target.base));
  }

  /** Staff hand over the order's open pickup fulfillment: ready, then collected. */
  async collect(orderId: string): Promise<void> {
    const ready = await this.markReady(orderId);
    if (ready.outcome === "rejected") throw new Error(JSON.stringify(ready));
    const target = await this.#open(orderId, "complete");
    await this.apply(
      this.admin.completePickup({
        ...target.base,
        paymentId: target.payment.id,
        paymentRevision: target.payment.revision,
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    lineMinor: number,
    taxMinor: number,
  ): Promise<CommerceMutationResultV1> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (order === undefined || payment === undefined) throw new Error(`${orderId} is incomplete`);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base("refund")),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_exchange_${orderId.slice(-6)}`,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(lineMinor + taxMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(lineMinor) }],
          taxAllocations: [{ orderLineId, amount: jpy(taxMinor) }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Exchanged for a cheaper tin",
      }),
    );
  }
}
