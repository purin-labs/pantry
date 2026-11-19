// Plan 77 step 1: the draft order, return, customer, discount and stored
// value account machines, driven over HTTP as the first conformance journey
// (state-machine-journey.test.ts) drives checkouts and orders. In each state
// that it reaches, it asks for the moves that staff or a buyer can ask for.
// An allowed move applies; a forbidden move answers `invalid_transition`, or,
// on a buyer route, a refusal that does not show the state. The machines of
// checkout profiles, shipments, shipping fulfillments and webhook
// subscriptions are driven by the journeys that NOT_REACHED names. Set
// LIFECYCLE_MACHINE_ARTIFACT_DIR to keep the matrix; the file repeats byte for
// byte for the same commit.
import {
  generateGiftCardCode,
  type CommerceAdminClient,
  type CommerceDraftOrderLineV1,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import type { CommerceMachineName } from "@purin-labs/commerce-contracts";
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
} from "./journey-support.ts";
import { OrderDesk, SMALL_SENCHA, placeAtStorefront } from "./order-desk.ts";
import { TransitionMatrix } from "./transition-matrix.ts";

const MACHINES: readonly CommerceMachineName[] = [
  "checkout_profile",
  "discount",
  "draft_order",
  "shipping_fulfillment",
  "shipment",
  "return",
  "customer",
  "stored_value_account",
  "webhook_subscription",
];

const NOT_REACHED: Readonly<Record<string, string>> = {
  "checkout_profile * *":
    "checkout-profile-service.test.ts and checkout-profile-http.test.ts drive drafts, publishing, retirement and activation; the profile routes answer invalid_lifecycle with the state that the event needs",
  "shipping_fulfillment * *":
    "plan33-core-acceptance.test.ts and saved-address-journey.test.ts hand shipping orders to the carrier",
  "shipment * *":
    "plan33-core-acceptance.test.ts buys labels and records carrier scans",
  "webhook_subscription * *":
    "webhook-lifecycle-journey.test.ts fails, restarts and rotates subscriptions and probes a restart of an active one",
  "return received exchange":
    "exchange-journey.test.ts exchanges the received units of a return",
};

it(
  "moves drafts, returns, customers, discounts and gift cards only as their machines allow",
  { timeout: 90_000 },
  driveLifecycleMachines,
);

async function driveLifecycleMachines(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const matrix = new TransitionMatrix(MACHINES, NOT_REACHED);
  try {
    const { admin, buyer } = backend;
    const staff = new LifecycleDesk(admin);
    await staff.createTea();

    // Draft orders: an open or invoiced draft takes a change, an invoice, a
    // cancellation or a manual payment; a cancelled draft takes nothing.
    const lines: readonly CommerceDraftOrderLineV1[] = [
      {
        lineId: "line_tea",
        variantId: SMALL_SENCHA,
        quantity: 1,
        priceOverride: null,
      },
    ];
    expect(await staff.createDraft("draft_kai", lines)).toMatchObject({
      outcome: "applied",
    });
    const draftSteps = [
      ["open", "update", () => staff.updateDraft("draft_kai", 1, lines)],
      ["open", "send_invoice", () => staff.sendDraftInvoice("draft_kai", 2)],
      [
        "invoiced",
        "send_invoice",
        () => staff.sendDraftInvoice("draft_kai", 3),
      ],
      ["invoiced", "update", () => staff.updateDraft("draft_kai", 4, lines)],
    ] as const;
    for (const [state, event, ask] of draftSteps)
      matrix.check("draft_order", state, event, await ask());
    await staff.sendDraftInvoice("draft_kai", 5);
    matrix.check(
      "draft_order",
      "invoiced",
      "cancel",
      await staff.cancelDraft("draft_kai", 6),
    );
    const cancelledAsks = [
      ["update", () => staff.updateDraft("draft_kai", 7, lines)],
      ["send_invoice", () => staff.sendDraftInvoice("draft_kai", 7)],
      ["cancel", () => staff.cancelDraft("draft_kai", 7)],
      [
        "mark_paid",
        () => staff.markDraftPaid("draft_kai", 7, { method: "cash" }),
      ],
    ] as const;
    for (const [event, ask] of cancelledAsks)
      matrix.check("draft_order", "cancelled", event, await ask());
    await staff.createDraft("draft_lea", lines);
    matrix.check(
      "draft_order",
      "open",
      "cancel",
      await staff.cancelDraft("draft_lea", 1),
    );
    await staff.createDraft("draft_uma", lines);
    matrix.check(
      "draft_order",
      "open",
      "mark_paid",
      await staff.markDraftPaid("draft_uma", 1, { method: "cash" }),
    );
    await staff.createDraft("draft_yui", lines);
    await staff.sendDraftInvoice("draft_yui", 1);
    matrix.check(
      "draft_order",
      "invoiced",
      "mark_paid",
      await staff.markDraftPaid("draft_yui", 2, {
        method: "bank_transfer",
        reference: "YUI 0814",
      }),
    );

    // Customers: an active customer takes a change and an erasure; an
    // erased customer takes nothing.
    await staff.createCustomer("customer_mia", "mia@example.test");
    matrix.check(
      "customer",
      "active",
      "update",
      await staff.updateCustomer("customer_mia", 1),
    );
    matrix.check(
      "customer",
      "active",
      "erase",
      await staff.eraseCustomer("customer_mia", 2),
    );
    matrix.check(
      "customer",
      "erased",
      "update",
      await staff.updateCustomer("customer_mia", 3),
    );
    matrix.check(
      "customer",
      "erased",
      "erase",
      await staff.eraseCustomer("customer_mia", 3),
    );

    // Discounts: an active code applies at checkout and can be turned off
    // once; a buyer who enters an inactive code learns only that it does
    // not apply.
    await staff.createDiscount("discount_probe", "PROBE10");
    const withCode = await Buyer.start(buyer, "pia");
    withCode.discountCodes = ["PROBE10"];
    const discounted = await withCode.tryQuote([catalogLine(SMALL_SENCHA)]);
    expect(discounted.kind).toBe("quoted");
    matrix.observed("discount", "active", "apply", "applied");
    matrix.check(
      "discount",
      "active",
      "deactivate",
      await staff.deactivateDiscount("discount_probe", 1),
    );
    matrix.check(
      "discount",
      "inactive",
      "deactivate",
      await staff.deactivateDiscount("discount_probe", 2),
    );
    const late = await Buyer.start(buyer, "quin");
    late.discountCodes = ["PROBE10"];
    matrix.hidden(
      "discount",
      "inactive",
      "apply",
      quoteRefusal(await late.tryQuote([catalogLine(SMALL_SENCHA)])),
      "discount.code.unavailable",
    );

    // Gift cards: an active card pays at checkout and can be turned off
    // once; a turned-off card does not pay. Store credit takes credit while
    // it is active and after it is turned off, for refunds.
    const giftCode = generateGiftCardCode();
    await staff.issueGiftCard("gift_probe", giftCode);
    const withCard = await Buyer.start(buyer, "rio");
    withCard.giftCardCodes = [giftCode];
    const paidByCard = await withCard.tryQuote([catalogLine(SMALL_SENCHA)]);
    expect(paidByCard).toMatchObject({
      kind: "quoted",
      checkout: { quote: { storedValue: { amount: jpy(500) } } },
    });
    matrix.observed("stored_value_account", "active", "apply", "applied");
    matrix.check(
      "stored_value_account",
      "active",
      "disable",
      await staff.disableAccount("gift_probe"),
    );
    matrix.check(
      "stored_value_account",
      "disabled",
      "disable",
      await staff.disableAccount("gift_probe"),
    );
    const withOffCard = await Buyer.start(buyer, "sol");
    withOffCard.giftCardCodes = [giftCode];
    matrix.hidden(
      "stored_value_account",
      "disabled",
      "apply",
      quoteRefusal(await withOffCard.tryQuote([catalogLine(SMALL_SENCHA)])),
      "checkout.storedValue.giftCard",
    );
    await staff.createCustomer("customer_noa", "noa@example.test");
    await staff.creditStoreCredit("customer_noa", "credit_first");
    matrix.check(
      "stored_value_account",
      "active",
      "credit",
      await staff.creditStoreCredit("customer_noa", "credit_second"),
    );
    const credit = await staff.storeCreditAccount("customer_noa");
    await staff.disableAccount(credit.id);
    matrix.check(
      "stored_value_account",
      "disabled",
      "credit",
      await staff.creditStoreCredit("customer_noa", "credit_refund"),
    );

    // Returns: Ivy's collected order. A request waits for a decision, an
    // authorized return for the units, and received units for a refund; a
    // closed return takes nothing.
    const ivy = await placeAtStorefront(buyer, "ivy");
    await staff.collect(ivy.orderId);
    const ivyLine = await staff.lineId(ivy.orderId);
    await staff.requestReturn(ivy.orderId, ivyLine, "return_ivy");
    await probeReturn(staff, matrix, ivy.orderId, "return_ivy", "requested", [
      "receive",
      "close",
      "exchange",
    ]);
    matrix.check(
      "return",
      "requested",
      "authorize",
      await staff.decide("return_ivy", ivyLine, "authorized"),
    );
    await probeReturn(staff, matrix, ivy.orderId, "return_ivy", "authorized", [
      "authorize",
      "reject",
      "close",
      "exchange",
    ]);
    matrix.check(
      "return",
      "authorized",
      "receive",
      await staff.receive("return_ivy"),
    );
    await probeReturn(staff, matrix, ivy.orderId, "return_ivy", "received", [
      "authorize",
      "reject",
      "receive",
    ]);
    expect(
      await staff.refund(ivy.orderId, ivyLine, "refund_ivy_return", 1_200),
    ).toMatchObject({ outcome: "applied" });
    matrix.check(
      "return",
      "received",
      "close",
      await staff.close("return_ivy", "refund_ivy_return"),
    );
    await probeReturn(staff, matrix, ivy.orderId, "return_ivy", "closed", [
      "authorize",
      "reject",
      "receive",
      "close",
      "exchange",
    ]);
    // Jo's return is refused, and then takes nothing.
    const jo = await placeAtStorefront(buyer, "jo");
    await staff.collect(jo.orderId);
    const joLine = await staff.lineId(jo.orderId);
    await staff.requestReturn(jo.orderId, joLine, "return_jo");
    matrix.check(
      "return",
      "requested",
      "reject",
      await staff.decide("return_jo", joLine, "rejected"),
    );
    await probeReturn(staff, matrix, jo.orderId, "return_jo", "rejected", [
      "authorize",
      "reject",
      "receive",
      "close",
      "exchange",
    ]);

    const report = matrix.report();
    expect(report.unexplained).toEqual([]);
    expect(report.stalePatterns).toEqual([]);
    writeEvidence("LIFECYCLE_MACHINE_ARTIFACT_DIR", "lifecycle-machines", {
      clock: NOW,
      merchantId,
      cells: report.cells,
      notReached: report.notReached,
    });
  } finally {
    backend.close();
  }
}

/** Asks for return moves that the return's state forbids. */
async function probeReturn(
  staff: LifecycleDesk,
  matrix: TransitionMatrix,
  orderId: string,
  returnId: string,
  state: "requested" | "authorized" | "received" | "closed" | "rejected",
  events: readonly (
    "authorize" | "reject" | "receive" | "close" | "exchange"
  )[],
): Promise<void> {
  const before = await staff.merchantRevision();
  const line = await staff.lineId(orderId);
  for (const event of events) {
    const record = await staff.returnRecord(orderId, returnId);
    const result =
      event === "authorize" || event === "reject"
        ? await staff.decide(
            returnId,
            line,
            event === "authorize" ? "authorized" : "rejected",
          )
        : event === "receive"
          ? await staff.receive(returnId)
          : event === "close"
            ? await staff.close(returnId, null)
            : await staff.exchange(orderId, returnId, record.revision);
    matrix.check("return", state, event, result);
  }
  expect(await staff.merchantRevision()).toBe(before);
}

/** A buyer quote's refusal, as a mutation result. */
function quoteRefusal(
  quote: Awaited<ReturnType<Buyer["tryQuote"]>>,
): CommerceMutationResultV1 {
  if (quote.kind !== "refused" || quote.error === undefined)
    throw new Error("The quote was not refused");
  return { outcome: "rejected", error: quote.error };
}

class LifecycleDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "lifecycles");
  }

  createCustomer(customerId: string, email: string) {
    return this.apply(
      this.admin.createCustomer({
        ...this.editBase(`create_${customerId}`),
        customerId,
        email,
        name: null,
        phone: null,
        note: null,
        tags: [],
      }),
    );
  }

  updateCustomer(customerId: string, expectedRevision: number) {
    return this.edit(
      this.admin.updateCustomer({
        ...this.editBase(`update_${customerId}_${this.step}`),
        customerId,
        expectedRevision,
        changes: { note: "Prefers the hojicha" },
      }),
    );
  }

  eraseCustomer(customerId: string, expectedRevision: number) {
    return this.edit(
      this.admin.eraseCustomer({
        ...this.editBase(`erase_${customerId}_${this.step}`),
        customerId,
        expectedRevision,
        reason: "Customer asked to be forgotten",
      }),
    );
  }

  createDiscount(discountId: string, code: string) {
    return this.apply(
      this.admin.createDiscount({
        ...this.editBase(`create_${discountId}`),
        discountId,
        title: "Ten percent off",
        method: { kind: "code", codes: [code] },
        rule: {
          kind: "amount_off_order",
          value: { kind: "percentage", basisPoints: 1_000 },
        },
        conditions: {
          minimumSubtotal: null,
          startsAt: NOW,
          endsAt: null,
          usageLimit: null,
          oncePerCustomer: false,
        },
      }),
    );
  }

  deactivateDiscount(discountId: string, expectedRevision: number) {
    return this.edit(
      this.admin.deactivateDiscount({
        ...this.editBase(`deactivate_${discountId}_${this.step}`),
        discountId,
        expectedRevision,
      }),
    );
  }

  issueGiftCard(accountId: string, code: string) {
    return this.apply(
      this.admin.issueGiftCard({
        ...this.editBase(`issue_${accountId}`),
        accountId,
        code,
        amount: jpy(500),
        expiresAt: null,
        note: null,
      }),
    );
  }

  creditStoreCredit(customerId: string, name: string) {
    return this.edit(
      this.admin.creditStoreCredit({
        ...this.editBase(name),
        customerId,
        amount: jpy(300),
        note: null,
      }),
    );
  }

  async storeCreditAccount(customerId: string) {
    const account = (
      await required(this.admin.listStoredValueAccounts(merchantId))
    ).find((item) => item.customerId === customerId);
    if (account === undefined) throw new Error(`${customerId} has no credit`);
    return account;
  }

  async disableAccount(accountId: string) {
    const account = (
      await required(this.admin.listStoredValueAccounts(merchantId))
    ).find((item) => item.id === accountId);
    if (account === undefined) throw new Error(`${accountId} is missing`);
    return this.edit(
      this.admin.disableStoredValueAccount({
        ...this.editBase(`disable_${accountId}_${this.step}`),
        accountId,
        expectedRevision: account.revision,
      }),
    );
  }

  /** Makes the order ready and hands it to the buyer. */
  async collect(orderId: string): Promise<void> {
    expect(await this.markReady(orderId)).toMatchObject({ outcome: "applied" });
    expect(await this.completePickup(orderId)).toMatchObject({
      outcome: "applied",
    });
  }

  async returnRecord(orderId: string, returnId: string) {
    const record = (
      await required(this.admin.listOrderReturns(merchantId, orderId))
    ).find((item) => item.id === returnId);
    if (record === undefined) throw new Error(`${returnId} is missing`);
    return record;
  }

  async decide(
    returnId: string,
    orderLineId: string,
    decision: "authorized" | "rejected",
  ) {
    const record = await this.#return(returnId);
    return this.edit(
      this.admin.authorizeReturn({
        ...this.editBase(`decide_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision: record.revision,
        decisions: [{ orderLineId, decision }],
      }),
    );
  }

  async receive(returnId: string) {
    const record = await this.#return(returnId);
    return this.edit(
      this.admin.receiveReturn({
        ...this.editBase(`receive_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision: record.revision,
        locationId: "location_cafe",
        dispositions: record.lines.map((line) => ({
          orderLineId: line.orderLineId,
          disposition: "restock" as const,
        })),
      }),
    );
  }

  async close(returnId: string, refundAttemptId: string | null) {
    const record = await this.#return(returnId);
    return this.edit(
      this.admin.closeReturn({
        ...this.editBase(`close_${returnId}_${this.step}`),
        returnId,
        expectedReturnRevision: record.revision,
        refundAttemptId,
      }),
    );
  }

  async #return(returnId: string) {
    for (const order of (await this.snapshot()).orders) {
      const found = (
        await required(this.admin.listOrderReturns(merchantId, order.id))
      ).find((item) => item.id === returnId);
      if (found !== undefined) return found;
    }
    throw new Error(`${returnId} is missing`);
  }
}
