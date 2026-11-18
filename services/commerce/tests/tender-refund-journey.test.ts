// Plan 77 step 2: one refund split over the payments of an order that a gift
// card and a card paid together. With no tenders named, the card money goes
// back first and the gift card takes the rest; staff can also name the
// tenders and their amounts. The same request again changes nothing, and a
// refund larger than the payments can return is refused before any part
// runs. Set TENDER_REFUND_ARTIFACT_DIR to keep the run's evidence; the file
// repeats byte for byte for the same commit.
import {
  generateGiftCardCode,
  type RefundCommerceOrderTendersV1,
  type CommerceAdminClient,
  type CommerceTenderRefundV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  catalogLine,
  jpy,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk } from "./order-desk.ts";

it(
  "splits one refund over a card and a gift card, card first unless staff name the tenders",
  { timeout: 60_000 },
  splitRefunds,
);

async function splitRefunds(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer } = backend;
    const staff = new TenderDesk(admin);
    await staff.createTea();

    // Mio pays for two large tins with a ¥2,000 gift card and her card.
    const mioCode = generateGiftCardCode();
    await staff.issueGiftCard("gift_mio", mioCode, 2_000);
    const mio = await Buyer.start(buyer, "split_mio");
    mio.giftCardCodes = [mioCode];
    const mioOrder = await mio.buyLines([
      { ...catalogLine(LARGE_SENCHA), quantity: 2 },
    ]);
    const mioTenders = await staff.tenders(mioOrder);
    const mioCard = mioTenders.card;
    expect(mioTenders.storedValue.amount).toEqual(jpy(2_000));

    // A refund of the card payment and ¥500 more: the card money goes back
    // first and the gift card takes the rest.
    const mioRefund = mioCard.amount.amountMinor + 500;
    const split = await staff.splitRefund(mioOrder, "refund_mio", mioRefund);
    expect(partsOf(split)).toEqual([
      {
        paymentId: mioCard.id,
        amount: mioCard.amount,
        outcome: "applied",
      },
      {
        paymentId: mioTenders.storedValue.id,
        amount: jpy(500),
        outcome: "applied",
      },
    ]);
    expect(await staff.paymentStates(mioOrder)).toEqual({
      [mioCard.id]: { state: "refunded", refunded: mioCard.amount },
      [mioTenders.storedValue.id]: {
        state: "partially_refunded",
        refunded: jpy(500),
      },
    });
    expect(await staff.giftCardBalance("gift_mio")).toEqual(jpy(500));
    // The same request again replays each part and refunds nothing more.
    const again = await staff.splitRefund(mioOrder, "refund_mio", mioRefund);
    expect(partsOf(again).map((part) => part.outcome)).toEqual([
      "replayed",
      "replayed",
    ]);
    expect(await staff.giftCardBalance("gift_mio")).toEqual(jpy(500));
    // Only ¥1,500 of the gift card is left to refund; ¥1,600 is refused
    // before any part runs.
    expect(await staff.splitRefund(mioOrder, "refund_mio_more", 1_600)).toEqual(
      {
        schemaVersion: "underclerk.tender-refund.v1",
        outcome: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "refund.amount",
        },
      },
    );
    expect(await staff.giftCardBalance("gift_mio")).toEqual(jpy(500));

    // Noe pays for one large tin with a ¥1,000 gift card and her card. Staff
    // give ¥600 back to the gift card first and ¥300 to the card.
    const noeCode = generateGiftCardCode();
    await staff.issueGiftCard("gift_noe", noeCode, 1_000);
    const noe = await Buyer.start(buyer, "split_noe");
    noe.giftCardCodes = [noeCode];
    const noeOrder = await noe.buyLines([catalogLine(LARGE_SENCHA)]);
    const noeTenders = await staff.tenders(noeOrder);
    // A named tender cannot take more than it can return.
    expect(
      await staff.splitRefund(noeOrder, "refund_noe_over", 1_100, [
        { paymentId: noeTenders.storedValue.id, amount: jpy(1_100) },
      ]),
    ).toMatchObject({
      outcome: "rejected",
      error: { field: "refund.tenders" },
    });
    const named = await staff.splitRefund(noeOrder, "refund_noe", 900, [
      { paymentId: noeTenders.storedValue.id, amount: jpy(600) },
      { paymentId: noeTenders.card.id, amount: jpy(300) },
    ]);
    expect(partsOf(named)).toEqual([
      {
        paymentId: noeTenders.storedValue.id,
        amount: jpy(600),
        outcome: "applied",
      },
      { paymentId: noeTenders.card.id, amount: jpy(300), outcome: "applied" },
    ]);
    expect(await staff.paymentStates(noeOrder)).toEqual({
      [noeTenders.card.id]: { state: "partially_refunded", refunded: jpy(300) },
      [noeTenders.storedValue.id]: {
        state: "partially_refunded",
        refunded: jpy(600),
      },
    });
    expect(await staff.giftCardBalance("gift_noe")).toEqual(jpy(600));

    Object.assign(evidence, {
      receipts: staff.receipts,
      mio: {
        tenders: mioTenders,
        split: partsOf(split),
        again: partsOf(again),
        payments: await staff.paymentStates(mioOrder),
        giftCard: await staff.giftCardBalance("gift_mio"),
      },
      noe: {
        tenders: noeTenders,
        split: partsOf(named),
        payments: await staff.paymentStates(noeOrder),
        giftCard: await staff.giftCardBalance("gift_noe"),
      },
    });
  } finally {
    writeEvidence("TENDER_REFUND_ARTIFACT_DIR", "tender-refund", evidence);
    backend.close();
  }
}

function partsOf(refund: CommerceTenderRefundV1) {
  if (refund.outcome !== "split")
    throw new Error(`The refund was refused: ${JSON.stringify(refund)}`);
  return refund.parts.map((part) => ({
    paymentId: part.paymentId,
    amount: part.amount,
    outcome: part.result.outcome,
  }));
}

class TenderDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "tender");
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

  /** The order's card payment and its gift card payment. */
  async tenders(orderId: string) {
    const payments = (await this.snapshot()).payments.filter(
      (payment) => payment.orderId === orderId,
    );
    const storedValue = payments.find((payment) =>
      payment.id.startsWith("payment_stored_value_"),
    );
    const card = payments.find((payment) => payment !== storedValue);
    if (
      payments.length !== 2 ||
      card === undefined ||
      storedValue === undefined
    )
      throw new Error(`${orderId} is not paid by a card and a gift card`);
    return {
      card: { id: card.id, amount: card.amount },
      storedValue: { id: storedValue.id, amount: storedValue.amount },
    };
  }

  async paymentStates(orderId: string) {
    return Object.fromEntries(
      (await this.snapshot()).payments
        .filter((payment) => payment.orderId === orderId)
        .map((payment) => [
          payment.id,
          {
            state: payment.lifecycle.state,
            ...(payment.lifecycle.state === "partially_refunded" ||
            payment.lifecycle.state === "refunded"
              ? { refunded: payment.lifecycle.refundedAmount }
              : {}),
          },
        ]),
    );
  }

  async giftCardBalance(accountId: string) {
    const account = (
      await required(this.admin.listStoredValueAccounts(merchantId))
    ).find((item) => item.id === accountId);
    if (account === undefined) throw new Error(`${accountId} is missing`);
    return account.balance;
  }

  /** Refunds part of the order's first line, split over its tenders. */
  async splitRefund(
    orderId: string,
    refundId: string,
    amountMinor: number,
    tenders?: RefundCommerceOrderTendersV1["tenders"],
  ): Promise<CommerceTenderRefundV1> {
    const lineId = await this.lineId(orderId);
    return required(
      this.admin.refundOrderTenders({
        merchantId,
        idempotencyKey: refundId,
        orderId,
        refundId,
        refundPolicyId: "refund_policy_standard",
        amount: jpy(amountMinor),
        allocation: {
          lineAllocations: [{ orderLineId: lineId, amount: jpy(amountMinor) }],
          taxAllocations: [],
          dutyAllocations: [],
          shippingAllocation: jpy(0),
        },
        reason: "Dented tin",
        ...(tenders === undefined ? {} : { tenders }),
      }),
    );
  }
}
