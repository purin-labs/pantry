// Plan 77 step 2 exit journey, on a pickup order (Commerce edits pickup
// orders only). Kai pays for a small tin with a ¥1,000 gift card and a card;
// staff add a large tin and Kai pays the ¥1,980 balance by bank transfer; a
// ¥600 refund goes to the card first and the transfer next; the bank
// disputes the card payment; staff cancel the order. At each point the
// order's balance equals the sum of its payments and their refunds. Set
// MIXED_TENDER_ARTIFACT_DIR to keep the run's evidence; the file repeats
// byte for byte for the same commit.
import {
  generateGiftCardCode,
  type CommerceAdminClient,
  type CommercePaymentV1,
  type CommerceTenderRefundV1,
} from "@purin-labs/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  catalogLine,
  jpy,
  merchantId,
  organisationId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

it(
  "keeps a mixed-tender order's position through an edit, a transfer, a split refund, a dispute and a cancellation",
  { timeout: 60_000 },
  mixedTenders,
);

async function mixedTenders(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new MixedDesk(admin);
    await staff.createTea();
    const positions: Record<string, unknown> = {};
    const checkpoint = async (name: string) => {
      const position = await staff.position(kaiOrder);
      positions[name] = position;
      return position;
    };

    // Kai pays for a small tin (¥1,320) with a ¥1,000 gift card and a card.
    const code = generateGiftCardCode();
    await staff.issueGiftCard("gift_kai", code, 1_000);
    const kai = await Buyer.start(buyer, "mixed_kai");
    kai.giftCardCodes = [code];
    const kaiOrder = await kai.buyLines([catalogLine(SMALL_SENCHA)]);
    expect(await checkpoint("paid")).toMatchObject({
      balance: { captured: jpy(1_320), outstanding: jpy(0) },
      payments: { card: [320, 0], stored_value: [1_000, 0] },
    });

    // Staff add a large tin; Kai pays the balance by bank transfer.
    expect(await staff.addLargeTin(kaiOrder)).toMatchObject({
      outcome: "applied",
    });
    expect((await checkpoint("edited")).balance).toMatchObject({
      total: jpy(3_300),
      outstanding: jpy(1_980),
    });
    expect(await staff.recordTransfer(kaiOrder)).toMatchObject({
      outcome: "applied",
    });
    expect(await checkpoint("transferred")).toMatchObject({
      balance: { captured: jpy(3_300), outstanding: jpy(0) },
      payments: {
        card: [320, 0],
        stored_value: [1_000, 0],
        manual: [1_980, 0],
      },
    });

    // A ¥600 refund: the card first, then the transfer; the gift card last.
    const split = await staff.splitRefund(kaiOrder, 600);
    expect(partsOf(split)).toEqual([
      { kind: "card", amount: 320 },
      { kind: "manual", amount: 280 },
    ]);
    expect(await checkpoint("refunded")).toMatchObject({
      balance: { refunded: jpy(600) },
      payments: {
        card: [320, 320],
        stored_value: [1_000, 0],
        manual: [1_980, 280],
      },
    });

    // The bank disputes the card payment: recorded, and nothing moves.
    const card = (await staff.payments(kaiOrder)).find(isCard);
    if (card === undefined) throw new Error("Kai has no card payment");
    expect(await staff.dispute(card)).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "observe_payment_dispute" },
    });
    expect((await checkpoint("disputed")).balance).toMatchObject({
      refunded: jpy(600),
    });

    // Staff cancel, naming the transfer (the card has nothing left): what is
    // left of the transfer and the gift card goes back.
    expect(
      await staff.cancelNaming(kaiOrder, "payment_transfer_kai"),
    ).toMatchObject({ outcome: "applied" });
    expect(await checkpoint("cancelled")).toMatchObject({
      balance: { captured: jpy(3_300), refunded: jpy(3_300) },
      payments: {
        card: [320, 320],
        stored_value: [1_000, 1_000],
        manual: [1_980, 1_980],
      },
    });
    expect(await staff.giftCardBalance("gift_kai")).toEqual(jpy(1_000));

    // At every point the balance is the sum of the payments.
    for (const position of Object.values(positions) as Position[]) {
      const sums = Object.values(position.payments).reduce(
        ([paid, back], [amount, refunded]) => [paid + amount, back + refunded],
        [0, 0],
      );
      expect([
        position.balance.captured.amountMinor,
        position.balance.refunded.amountMinor,
      ]).toEqual(sums);
    }

    Object.assign(evidence, {
      receipts: staff.receipts,
      split: partsOf(split),
      positions,
    });
  } finally {
    writeEvidence("MIXED_TENDER_ARTIFACT_DIR", "mixed-tender", evidence);
    backend.close();
  }
}

type Position = Readonly<{
  balance: Readonly<{
    captured: Readonly<{ amountMinor: number }>;
    refunded: Readonly<{ amountMinor: number }>;
  }>;
  payments: Readonly<Record<string, readonly [number, number]>>;
}>;

function isCard(payment: CommercePaymentV1): boolean {
  return (
    !payment.id.startsWith("payment_stored_value_") &&
    !payment.id.startsWith("payment_transfer_")
  );
}

function kindOf(paymentId: string): "card" | "stored_value" | "manual" {
  return paymentId.startsWith("payment_stored_value_")
    ? "stored_value"
    : paymentId.startsWith("payment_transfer_")
      ? "manual"
      : "card";
}

function partsOf(refund: CommerceTenderRefundV1) {
  if (refund.outcome !== "split")
    throw new Error(`The refund was refused: ${JSON.stringify(refund)}`);
  return refund.parts.map((part) => ({
    kind: kindOf(part.paymentId),
    amount: part.amount.amountMinor,
  }));
}

class MixedDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "mixed");
  }

  async issueGiftCard(accountId: string, code: string, amountMinor: number) {
    await this.apply(
      this.admin.issueGiftCard({
        ...this.editBase(`issue_${accountId}`),
        accountId,
        code,
        amount: jpy(amountMinor),
        expiresAt: null,
        note: null,
      }),
    );
  }

  async payments(orderId: string) {
    return (await this.snapshot()).payments.filter(
      (payment) => payment.orderId === orderId,
    );
  }

  /** The order's balance and, for each tender kind, [paid, refunded]. */
  async position(orderId: string): Promise<Position> {
    const changes = await required(
      this.admin.readOrderChanges(merchantId, orderId),
    );
    const payments: Record<string, readonly [number, number]> = {};
    for (const payment of await this.payments(orderId))
      payments[kindOf(payment.id)] = [
        payment.amount.amountMinor,
        payment.lifecycle.state === "partially_refunded" ||
        payment.lifecycle.state === "refunded"
          ? payment.lifecycle.refundedAmount.amountMinor
          : 0,
      ];
    return { balance: changes.balance, payments };
  }

  addLargeTin(orderId: string) {
    return this.edit(
      this.admin.editOrder({
        ...this.editBase("edit_kai"),
        editId: "edit_kai",
        orderId,
        expectedOrderRevision: 1,
        lineChanges: [],
        additions: [{ variantId: LARGE_SENCHA, quantity: 1 }],
        reason: "Buyer asked by phone",
      }),
    );
  }

  recordTransfer(orderId: string) {
    return this.edit(
      this.admin.recordOrderManualPayment({
        ...this.editBase("transfer_kai"),
        orderId,
        expectedOrderRevision: 2,
        paymentId: "payment_transfer_kai",
        amount: jpy(1_980),
        tender: { method: "bank_transfer", reference: "SMBC-1107" },
      }),
    );
  }

  async splitRefund(orderId: string, amountMinor: number) {
    const lineId = await this.lineId(orderId);
    return required(
      this.admin.refundOrderTenders({
        merchantId,
        idempotencyKey: "refund_kai",
        orderId,
        refundId: "refund_kai",
        refundPolicyId: "refund_policy_standard",
        amount: jpy(amountMinor),
        allocation: {
          lineAllocations: [{ orderLineId: lineId, amount: jpy(amountMinor) }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Dented tin",
      }),
    );
  }

  /** The bank's dispute of the card payment, as the provider reports it. */
  async dispute(card: CommercePaymentV1) {
    const identity = card.id.slice("payment_".length);
    const order = (await this.snapshot()).orders.find(
      (item) => item.id === card.orderId,
    );
    if (order?.origin.kind !== "online")
      throw new Error("The card paid no online order");
    return this.edit(
      this.admin.observePaymentDispute({
        schemaVersion: "commerce.observe-payment-dispute.v1",
        organisationId,
        merchantId,
        providerDeliveryId: "dispute_delivery_kai",
        receivedAt: NOW,
        checkoutId: order.origin.checkoutId,
        paymentAttemptId: `payment_attempt_${identity}`,
        providerPaymentReference: `pi_test_payment_request_${identity}`,
        providerDisputeReference: "dispute_kai",
        amount: card.amount,
        reason: "cardholder_claim",
        evidenceReferences: [],
        lifecycle: {
          state: "action_required",
          observedAt: NOW,
          responseDueAt: "2026-08-21T10:00:00.000Z",
        },
      }),
    );
  }

  async cancelNaming(orderId: string, paymentId: string) {
    const snapshot = await this.snapshot();
    const order = snapshot.orders.find((item) => item.id === orderId);
    const fulfillment = snapshot.fulfillments.find(
      (item) => item.orderId === orderId,
    );
    const payment = snapshot.payments.find((item) => item.id === paymentId);
    if (
      order === undefined ||
      fulfillment === undefined ||
      payment === undefined
    )
      throw new Error(`${orderId} cannot be cancelled`);
    return this.edit(
      this.admin.cancelOrder({
        ...(await this.base("cancel_kai")),
        orderId,
        orderRevision: order.revision,
        fulfillmentId: fulfillment.id,
        fulfillmentRevision: fulfillment.revision,
        paymentId: payment.id,
        paymentRevision: payment.revision,
        refundAttemptId: "refund_cancel_kai",
        reason: "Buyer cancelled",
      }),
    );
  }

  async giftCardBalance(accountId: string) {
    const account = (
      await required(this.admin.listStoredValueAccounts(merchantId))
    ).find((item) => item.id === accountId);
    if (account === undefined) throw new Error(`${accountId} is missing`);
    return account.balance;
  }
}
