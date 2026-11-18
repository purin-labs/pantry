// The staff and buyer helpers that the state machine conformance journeys
// share (Plan 77 step 1): orders placed at the storefront, and the staff
// commands that move them and draft orders.
import type {
  CommerceAdminClient,
  CommerceDraftOrderLineV1,
  CommerceManualTenderV1,
  CommerceMutationResultV1,
  CommerceStorefrontClient,
} from "@seams/commerce-client";

import {
  Buyer,
  StaffDesk,
  catalogLine,
  jpy,
  merchantId,
  required,
} from "./journey-support.ts";

export const SMALL_SENCHA = "variant_tea_small_sencha";
export const LARGE_SENCHA = "variant_tea_large_sencha";
export const WEEK_LATER = "2026-08-21T10:00:00.000Z";

export type PlacedOrder = Readonly<{
  orderId: string;
  checkoutId: string;
  recoveryToken: string;
}>;

/** A buyer pays at the storefront and keeps the order link. */
export async function placeAtStorefront(
  client: CommerceStorefrontClient,
  name: string,
): Promise<PlacedOrder> {
  const buyer = await Buyer.start(client, name);
  const orderId = await buyer.buyLines([catalogLine(SMALL_SENCHA)]);
  const placement = buyer.lastPlacement;
  if (placement === undefined) throw new Error(`${name} has no order link`);
  return { ...placement, orderId };
}

/** Staff commands on orders, with the revisions read from the snapshot. */
export class OrderDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient, prefix: string) {
    super(admin, prefix);
  }

  async merchantRevision(): Promise<number> {
    return (await required(this.admin.readSnapshot(merchantId)))
      .merchantRevision;
  }

  async order(orderId: string) {
    const order = (await this.snapshot()).orders.find(
      (item) => item.id === orderId,
    );
    if (order === undefined) throw new Error(`${orderId} is missing`);
    return order;
  }

  async lineId(orderId: string): Promise<string> {
    const line = (await this.order(orderId)).lineItems[0];
    if (line === undefined) throw new Error(`${orderId} has no line`);
    return line.id;
  }

  async #pickup(orderId: string, step: string) {
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

  changes(orderId: string) {
    return required(this.admin.readOrderChanges(merchantId, orderId));
  }

  /** The order's first payment: the one its checkout took. */
  async #firstPayment(orderId: string) {
    const later = new Set(
      (await this.changes(orderId)).changes.flatMap((change) =>
        change.kind === "payment" ? [change.paymentId] : [],
      ),
    );
    const payment = (await this.snapshot()).payments.find(
      (item) => item.orderId === orderId && !later.has(item.id),
    );
    if (payment === undefined) throw new Error(`${orderId} has no payment`);
    return payment;
  }

  createDraft(
    draftOrderId: string,
    lines: readonly CommerceDraftOrderLineV1[],
  ) {
    return this.edit(
      this.admin.createDraftOrder({
        ...this.editBase(`create_${draftOrderId}`),
        draftOrderId,
        storefrontId: "storefront_cafe",
        ...draftContents(draftOrderId, lines),
      }),
    );
  }

  updateDraft(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
    lines: readonly CommerceDraftOrderLineV1[],
  ) {
    return this.edit(
      this.admin.updateDraftOrder({
        ...this.editBase(`update_${draftOrderId}_${this.step}`),
        draftOrderId,
        expectedDraftOrderRevision,
        ...draftContents(draftOrderId, lines),
      }),
    );
  }

  /** Sends the invoice and returns the mutation with the buyer's link. */
  async sendDraftInvoiceLink(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
  ) {
    const sent = await required(
      this.admin.sendDraftInvoice({
        ...this.editBase(`invoice_${draftOrderId}_${this.step}`),
        draftOrderId,
        expectedDraftOrderRevision,
        expiresAt: WEEK_LATER,
      }),
    );
    return {
      mutation: await this.edit(
        Promise.resolve({ ok: true, value: sent.mutation }),
      ),
      token: sent.invoice?.token,
    };
  }

  async sendDraftInvoice(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
  ): Promise<CommerceMutationResultV1> {
    return (
      await this.sendDraftInvoiceLink(draftOrderId, expectedDraftOrderRevision)
    ).mutation;
  }

  cancelDraft(draftOrderId: string, expectedDraftOrderRevision: number) {
    return this.edit(
      this.admin.cancelDraftOrder({
        ...this.editBase(`cancel_${draftOrderId}_${this.step}`),
        draftOrderId,
        expectedDraftOrderRevision,
      }),
    );
  }

  /** Staff record cash or a bank transfer; the draft becomes an order. */
  markDraftPaid(
    draftOrderId: string,
    expectedDraftOrderRevision: number,
    tender: CommerceManualTenderV1,
    key = `${draftOrderId}_${this.step + 1}`,
  ) {
    const name = draftOrderId.replace("draft_", "");
    return this.edit(
      this.admin.markDraftOrderPaid({
        ...this.editBase(`paid_${key}`),
        draftOrderId,
        expectedDraftOrderRevision,
        tender,
        orderId: `order_${name}`,
        paymentId: `payment_${name}`,
        fulfillmentId: `fulfillment_${name}`,
      }),
    );
  }

  async editOrder(orderId: string, variantId: string) {
    const order = await this.order(orderId);
    return this.edit(
      this.admin.editOrder({
        ...this.editBase(`edit_${orderId}_${this.step}`),
        editId: `edit_${orderId}_${this.step}`,
        orderId,
        expectedOrderRevision: order.revision,
        lineChanges: [],
        additions: [{ variantId, quantity: 1 }],
        reason: "Buyer asked by phone",
      }),
    );
  }

  async markReady(orderId: string) {
    return this.edit(
      this.admin.markPickupReady({
        ...(await this.#pickup(orderId, `ready_${orderId}`)),
      }),
    );
  }

  async completePickup(orderId: string) {
    const payment = await this.#firstPayment(orderId);
    return this.edit(
      this.admin.completePickup({
        ...(await this.#pickup(orderId, `complete_${orderId}`)),
        paymentId: payment.id,
        paymentRevision: payment.revision,
      }),
    );
  }

  async cancel(orderId: string) {
    const payment = await this.#firstPayment(orderId);
    return this.edit(
      this.admin.cancelOrder({
        ...(await this.#pickup(orderId, `cancel_${orderId}_${this.step}`)),
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: `refund_cancel_${orderId}_${this.step}`,
        reason: "Buyer cancelled",
      }),
    );
  }

  async exchange(
    orderId: string,
    returnId = `return_${orderId}`,
    expectedReturnRevision = 1,
  ) {
    const order = await this.order(orderId);
    return this.edit(
      this.admin.exchangeOrderLines({
        ...this.editBase(`exchange_${orderId}_${this.step}`),
        exchangeId: `exchange_${orderId}_${this.step}`,
        orderId,
        expectedOrderRevision: order.revision,
        returnId,
        expectedReturnRevision,
        additions: [{ variantId: LARGE_SENCHA, quantity: 1 }],
        reason: "Exchanged for another tin",
      }),
    );
  }

  async requestReturn(
    orderId: string,
    orderLineId: string,
    returnId = `return_${orderId}_${this.step}`,
  ) {
    return this.edit(
      this.admin.requestReturn({
        ...this.editBase(`return_${orderId}_${this.step}`),
        returnId,
        orderId,
        lines: [{ orderLineId, quantity: 1, reason: "Dented tin" }],
      }),
    );
  }

  /** A refund of the named line amounts, with no tax, duty or shipping. */
  async refundLines(
    orderId: string,
    refundAttemptId: string,
    lines: readonly Readonly<{ orderLineId: string; amountMinor: number }>[],
  ) {
    const order = await this.order(orderId);
    const payment = await this.#firstPayment(orderId);
    const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(`refund_${refundAttemptId}`)),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(total),
        allocation: {
          lineAllocations: lines.map((line) => ({
            orderLineId: line.orderLineId,
            amount: jpy(line.amountMinor),
          })),
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Dented tin",
      }),
    );
  }

  /** A refund of one line amount and its tax named separately. */
  async refundWithTax(
    orderId: string,
    orderLineId: string,
    refundAttemptId: string,
    amounts: Readonly<{ line: number; tax: number }>,
  ) {
    const order = await this.order(orderId);
    const payment = await this.#firstPayment(orderId);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(`refund_${refundAttemptId}`)),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(amounts.line + amounts.tax),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(amounts.line) }],
          taxAllocations: [{ orderLineId, amount: jpy(amounts.tax) }],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Dented tin",
      }),
    );
  }

  async refund(
    orderId: string,
    orderLineId: string,
    refundAttemptId: string,
    lineMinor: number,
  ) {
    const order = await this.order(orderId);
    const payment = await this.#firstPayment(orderId);
    return this.edit(
      this.admin.refundOrder({
        ...(await this.base(`refund_${refundAttemptId}`)),
        orderId,
        orderRevision: order.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(lineMinor),
        allocation: {
          lineAllocations: [{ orderLineId, amount: jpy(lineMinor) }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Dented tin",
      }),
    );
  }
}

function draftContents(
  draftOrderId: string,
  lines: readonly CommerceDraftOrderLineV1[],
) {
  return {
    lines,
    buyer: { email: `${draftOrderId.replace("draft_", "")}@example.test` },
    note: "Collect at the counter.",
    tags: [],
  };
}
