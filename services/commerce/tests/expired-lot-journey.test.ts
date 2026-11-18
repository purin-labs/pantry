// Plan 40B phase 3 and Refactor 15 refactor 7: the menu and checkout promise
// only what staff can make, and an expired lot leaves the shelf count.
//
// 1. The café's opening lots pass their date. The latte shows as sold out and
//    a buyer is refused, with no republish. A dated delivery for one latte
//    brings it back: a buyer who wants two is refused, a buyer who wants one
//    pays, and staff take that order to ready and hand it over. A delivery
//    that passes its date after a buyer paid holds the paid order until fresh
//    stock arrives, and then it completes.
// 2. The merchant's alarm writes each lapsed lot off as waste: the lot is
//    expired, on hand drops by what was left in it, and the stock ledger has
//    one waste movement for it, which the Costs page counts as a loss.
// 3. A paid made-to-order latte whose lot lapsed before staff made it can be
//    cancelled and refunded: its ticket is cancelled, its stock comes back,
//    and the alarm then writes the lapsed lot off.
//
// Set EXPIRED_LOT_ARTIFACT_DIR to keep each run's evidence; each file repeats
// byte for byte for the same commit.
import type {
  CommerceInventoryPositionV1,
  CommercePickupQueueEntryV1,
  CommerceStockSnapshot,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  catalogFor,
  latteEntry,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const LATTE = {
  kind: "menu" as const,
  menuId: "menu_cafe_main",
  menuEntryId: "menu_entry_sesame_latte",
  modifierOptionIds: [],
  quantity: 1,
};
// The scenario's opening lots expire at the start of this day.
const OPENING_LOTS_PAST = Date.parse("2036-08-21T01:00:00.000Z");
const DAY = 86_400_000;
const CAFE = "location_cafe";

it(
  "sells only stock that staff can make, and recovers a paid order when a lot lapses",
  { timeout: 60_000 },
  expiredLotJourney,
);

it(
  "writes a lapsed lot off as waste, so on hand drops by what was left in it",
  { timeout: 60_000 },
  lotWriteOffJourney,
);

it(
  "cancels and refunds a paid made-to-order latte whose lot lapsed before staff made it",
  { timeout: 60_000 },
  madeToOrderCancellationJourney,
);

type Backend = Awaited<ReturnType<typeof startBackend>>;

/** Staff at the café counter and in its kitchen, on a clock they can move. */
class Kitchen {
  readonly #backend: Backend;
  readonly #clock: () => number;

  constructor(backend: Backend, clock: () => number) {
    this.#backend = backend;
    this.#clock = clock;
  }

  async stock(): Promise<CommerceStockSnapshot> {
    return required(this.#backend.admin.readStockSnapshot(merchantId));
  }

  async latteAvailability() {
    return latteEntry(await catalogFor(this.#backend.buyer))?.availability;
  }

  async latteInputs() {
    const stock = await this.stock();
    const recipe = stock.foodService.resources.recipeRevisions.find(
      (candidate) => candidate.recipeId === "recipe_sesame_latte",
    );
    if (recipe === undefined) throw new Error("Latte recipe missing");
    return recipe.inputs;
  }

  /** The café's position of one inventory item. */
  async position(inventoryItemId: string) {
    const position = (
      await this.stock()
    ).commerce.resources.inventoryPositions.find(
      (candidate) =>
        candidate.inventoryItemId === inventoryItemId &&
        candidate.locationId === CAFE,
    );
    if (position?.balance.kind !== "accounted")
      throw new Error(`No accounted position for ${inventoryItemId}`);
    return position as CommerceInventoryPositionV1 & {
      balance: Extract<
        CommerceInventoryPositionV1["balance"],
        { kind: "accounted" }
      >;
    };
  }

  /** A dated delivery of exactly what `lattes` lattes need. */
  async receiveForLattes(name: string, lattes: number, expiresAt: number) {
    const { admin } = this.#backend;
    for (const input of await this.latteInputs()) {
      const stock = await this.stock();
      const item = stock.commerce.resources.inventoryItems.find(
        (candidate) => candidate.id === input.inventoryItemId,
      );
      const position = stock.commerce.resources.inventoryPositions.find(
        (candidate) =>
          candidate.inventoryItemId === input.inventoryItemId &&
          candidate.locationId === CAFE,
      );
      if (item === undefined || position === undefined)
        throw new Error(`No stock for ${input.inventoryItemId}`);
      const code = `${name}-${input.inventoryItemId}`;
      expect(
        await required(
          admin.receiveInventory({
            merchantId,
            expectedMerchantRevision: stock.commerce.merchantRevision,
            idempotencyKey: `receive_${code}`,
            purchase: { kind: "unlinked" },
            receiptId: `receipt_${name}`,
            receiptLineId: code,
            inventoryItemId: item.id,
            inventoryItemRevision: item.revision,
            inventoryPositionId: position.id,
            inventoryPositionRevision: position.revision,
            locationId: position.locationId,
            receivedQuantity: {
              amount: input.quantity.amount * lattes,
              scale: input.quantity.scale,
              unit: input.quantity.unit,
            },
            lot:
              item.tracking.kind === "aggregate"
                ? { kind: "not_tracked" }
                : {
                    kind: "tracked",
                    lotId: `lot_${code}`,
                    lotCode: code,
                    expiry: {
                      kind: "expires",
                      expiresAt: new Date(expiresAt).toISOString(),
                    },
                  },
            receivedAt: new Date(this.#clock()).toISOString(),
          }),
        ),
      ).toMatchObject({ outcome: "applied" });
    }
  }

  async queueEntry(orderId: string) {
    const queue = await required(
      this.#backend.admin.readPickupQueue(merchantId),
    );
    const entry = queue.entries.find((item) => item.orderId === orderId);
    if (entry === undefined) throw new Error(`${orderId} is not in the queue`);
    return { entry, revision: queue.merchantRevision };
  }

  async inQueue(orderId: string): Promise<boolean> {
    const queue = await required(
      this.#backend.admin.readPickupQueue(merchantId),
    );
    return queue.entries.some((item) => item.orderId === orderId);
  }

  /** One staff step at a time: what the order queue route does. */
  async stepToReady(
    orderId: string,
    name: string,
  ): Promise<CommercePickupQueueEntryV1["stage"] | string> {
    const { admin } = this.#backend;
    for (let step = 0; step < 6; step += 1) {
      const { entry, revision } = await this.queueEntry(orderId);
      if (entry.stage === "ready") return "ready";
      const base = {
        merchantId,
        expectedMerchantRevision: revision,
        idempotencyKey: `${name}_${step}`,
      };
      const preparation = entry.preparation;
      if (preparation.state === "not_started") {
        if (preparation.stationId === null)
          throw new Error("The demo café has a preparation station");
      }
      const result = await required(
        preparation.state === "not_started"
          ? admin.managePreparationTicket({
              ...base,
              operation: {
                kind: "create",
                ticketId: preparation.ticketId,
                orderId: entry.orderId,
                fulfillmentId: entry.fulfillmentId,
                stationId: preparation.stationId ?? "",
              },
            })
          : preparation.state === "queued"
            ? admin.managePreparationTicket({
                ...base,
                operation: {
                  kind: "start",
                  ticketId: preparation.ticketId,
                  expectedTicketRevision: preparation.ticketRevision,
                },
              })
            : preparation.state === "preparing"
              ? admin.managePreparationTicket({
                  ...base,
                  operation: {
                    kind: "complete",
                    ticketId: preparation.ticketId,
                    expectedTicketRevision: preparation.ticketRevision,
                  },
                })
              : admin.markPickupReady({
                  ...base,
                  orderId: entry.orderId,
                  orderRevision: entry.orderRevision,
                  fulfillmentId: entry.fulfillmentId,
                  fulfillmentRevision: entry.fulfillmentRevision,
                }),
      );
      if (result.outcome === "rejected") {
        const error = result.error;
        return "field" in error ? String(error.field) : error.code;
      }
    }
    throw new Error("The order did not reach ready");
  }
}

async function expiredLotJourney(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
  });
  const { admin, buyer } = backend;
  const kitchen = new Kitchen(backend, () => clock);
  const evidence: Evidence = { merchantId };

  try {
    await catalogFor(buyer);
    expect(await kitchen.latteAvailability()).toBe("available");
    const [firstInput] = await kitchen.latteInputs();
    if (firstInput === undefined) throw new Error("Latte has no inputs");

    // The opening lots pass their date. The shelf count still shows them
    // until the alarm writes them off.
    clock = OPENING_LOTS_PAST;
    const position = await kitchen.position(firstInput.inventoryItemId);
    expect(position.balance.available.amount).toBeGreaterThan(0);
    expect(await kitchen.latteAvailability()).toBe("unavailable");
    const refusedOnLapse = await (
      await Buyer.start(buyer, "lapse_ana")
    ).tryQuote([LATTE]);
    expect(refusedOnLapse.kind).toBe("refused");

    // Staff receive a delivery for one latte, and the menu follows.
    await kitchen.receiveForLattes("first", 1, clock + DAY);
    expect(await kitchen.latteAvailability()).toBe("available");
    const refusedForTwo = await (
      await Buyer.start(buyer, "two_ben")
    ).tryQuote([{ ...LATTE, quantity: 2 }]);
    expect(refusedForTwo).toMatchObject({
      kind: "refused",
      error: {
        code: "insufficient_inventory",
        requestedAmount: firstInput.quantity.amount * 2,
        availableAmount: firstInput.quantity.amount,
      },
    });

    // Cai pays for the one latte, so the next buyer sees it as sold out.
    const paid = await (await Buyer.start(buyer, "one_cai")).buyLines([LATTE]);
    expect(await kitchen.latteAvailability()).toBe("unavailable");

    // Staff make it from the fresh lots and hand it over.
    expect(await kitchen.stepToReady(paid, "cai_ready")).toBe("ready");
    const { entry, revision } = await kitchen.queueEntry(paid);
    if (entry.payment === null) throw new Error("Cai's order has no payment");
    expect(
      await required(
        admin.completePickup({
          merchantId,
          expectedMerchantRevision: revision,
          idempotencyKey: "cai_hand_over",
          orderId: entry.orderId,
          orderRevision: entry.orderRevision,
          fulfillmentId: entry.fulfillmentId,
          fulfillmentRevision: entry.fulfillmentRevision,
          paymentId: entry.payment.paymentId,
          paymentRevision: entry.payment.paymentRevision,
        }),
      ),
    ).toMatchObject({ outcome: "applied" });

    // Dee pays before the next delivery lapses; staff reach it too late.
    await kitchen.receiveForLattes("second", 1, clock + DAY);
    const heldOrder = await (
      await Buyer.start(buyer, "held_dee")
    ).buyLines([LATTE]);
    clock += 2 * DAY;
    const heldOutcome = await kitchen.stepToReady(heldOrder, "dee_held");
    expect(heldOutcome).toBe("preparationTicket.lotAvailability");
    expect(await kitchen.latteAvailability()).toBe("unavailable");

    // Fresh stock frees the paid order, and it takes nothing from a new buyer.
    await kitchen.receiveForLattes("third", 1, clock + DAY);
    expect(await kitchen.latteAvailability()).toBe("unavailable");
    expect(await kitchen.stepToReady(heldOrder, "dee_fresh")).toBe("ready");

    Object.assign(evidence, {
      refusedOnLapse,
      refusedForTwo,
      heldOutcome,
    });
  } finally {
    writeEvidence("EXPIRED_LOT_ARTIFACT_DIR", "expired-lot", evidence);
    backend.close();
  }
}

async function lotWriteOffJourney(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
  });
  const kitchen = new Kitchen(backend, () => clock);
  const evidence: Evidence = { merchantId };
  try {
    const [firstInput] = await kitchen.latteInputs();
    if (firstInput === undefined) throw new Error("Latte has no inputs");

    // The opening lots pass their date while they still count on hand.
    clock = OPENING_LOTS_PAST;
    const before = await kitchen.stock();
    const now = new Date(clock).toISOString();
    const lapsed = before.lots.filter(
      (lot) =>
        lot.lifecycle.state === "available" &&
        lot.remainingQuantity.amount > 0 &&
        lot.expiry.kind === "expires" &&
        lot.expiry.expiresAt <= now,
    );
    expect(lapsed.map((lot) => lot.inventoryItemId)).toContain(
      firstInput.inventoryItemId,
    );
    const onHandBefore = (await kitchen.position(firstInput.inventoryItemId))
      .balance.onHand.amount;

    // The merchant's alarm runs its due work.
    await backend.runDueWork();
    const after = await kitchen.stock();
    const waste = after.movements.filter(
      (movement) =>
        movement.change.kind === "decrease" &&
        movement.change.reason.kind === "waste",
    );
    for (const lot of lapsed) {
      const written = after.lots.find((candidate) => candidate.id === lot.id);
      expect(written?.lifecycle.state).toBe("expired");
      expect(written?.remainingQuantity.amount).toBe(0);
      const movements = waste.filter(
        (movement) =>
          movement.change.kind === "decrease" &&
          movement.change.lotAllocation.kind === "allocated" &&
          movement.change.lotAllocation.lots.some(
            (part) => part.lotId === lot.id,
          ),
      );
      expect(movements).toHaveLength(1);
      expect(movements[0]?.change.quantity.amount).toBe(
        lot.remainingQuantity.amount,
      );
    }
    const position = await kitchen.position(firstInput.inventoryItemId);
    const firstLapsed = lapsed
      .filter((lot) => lot.inventoryItemId === firstInput.inventoryItemId)
      .reduce((total, lot) => total + lot.remainingQuantity.amount, 0);
    expect(position.balance.onHand.amount).toBe(onHandBefore - firstLapsed);
    expect(position.balance.onHand.amount).toBe(
      position.balance.allocated.amount,
    );

    // The next run finds nothing more to write off.
    await backend.runDueWork();
    expect((await kitchen.stock()).movements).toHaveLength(
      after.movements.length,
    );

    Object.assign(evidence, {
      lapsedLots: lapsed.map((lot) => ({
        lotId: lot.id,
        remaining: lot.remainingQuantity,
      })),
      wasteMovements: waste.map((movement) => ({
        inventoryItemId: movement.inventoryItemId,
        change: movement.change,
      })),
      onHand: { before: onHandBefore, after: position.balance.onHand.amount },
    });
  } finally {
    writeEvidence("EXPIRED_LOT_ARTIFACT_DIR", "lot-write-off", evidence);
    backend.close();
  }
}

async function madeToOrderCancellationJourney(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
  });
  const { admin, buyer } = backend;
  const kitchen = new Kitchen(backend, () => clock);
  const evidence: Evidence = { merchantId };
  try {
    const [firstInput] = await kitchen.latteInputs();
    if (firstInput === undefined) throw new Error("Latte has no inputs");

    // Eli pays for a latte from a delivery that lapses the next day.
    clock = OPENING_LOTS_PAST;
    await kitchen.receiveForLattes("eli", 1, clock + DAY);
    const order = await (
      await Buyer.start(buyer, "late_eli")
    ).buyLines([LATTE]);
    const held = await kitchen.position(firstInput.inventoryItemId);
    expect(held.balance.allocated.amount).toBe(firstInput.quantity.amount);

    // Staff start it two days later, and cannot finish it from lapsed lots.
    clock += 2 * DAY;
    const blocked = await kitchen.stepToReady(order, "eli_late");
    expect(blocked).toBe("preparationTicket.lotAvailability");

    // The alarm writes off the lapsed stock that no order holds; Eli's
    // latte still holds its share.
    await backend.runDueWork();
    const beforeCancel = await kitchen.position(firstInput.inventoryItemId);
    expect(beforeCancel.balance.onHand.amount).toBe(firstInput.quantity.amount);
    expect(beforeCancel.balance.allocated.amount).toBe(
      firstInput.quantity.amount,
    );
    const { entry, revision } = await kitchen.queueEntry(order);
    if (entry.payment === null) throw new Error("Eli's order has no payment");
    if (entry.preparation.state !== "preparing")
      throw new Error("Eli's ticket is not in preparation");
    const ticketId = entry.preparation.ticketId;

    // Staff cancel the order and refund Eli.
    const cancelled = await required(
      admin.cancelOrder({
        merchantId,
        expectedMerchantRevision: revision,
        idempotencyKey: "eli_cancel",
        orderId: entry.orderId,
        orderRevision: entry.orderRevision,
        fulfillmentId: entry.fulfillmentId,
        fulfillmentRevision: entry.fulfillmentRevision,
        paymentId: entry.payment.paymentId,
        paymentRevision: entry.payment.paymentRevision,
        refundAttemptId: "refund_cancel_eli",
        reason: "The latte could not be made before its milk lapsed",
      }),
    );
    expect(cancelled).toMatchObject({
      outcome: "applied",
      receipt: { commandKind: "cancel_order" },
    });
    const snapshot = await required(admin.readSnapshot(merchantId));
    const payment = snapshot.resources.payments.find(
      (candidate) => candidate.id === entry.payment?.paymentId,
    );
    expect(payment?.lifecycle.state).toBe("refunded");
    const ticket = await required(
      admin.readPreparationTicket(merchantId, ticketId),
    );
    expect(ticket.lifecycle.state).toBe("cancelled");
    expect(await kitchen.inQueue(order)).toBe(false);

    // Its stock comes back, and the alarm writes the lapsed lot off.
    const released = await kitchen.position(firstInput.inventoryItemId);
    expect(released.balance.allocated.amount).toBe(0);
    await backend.runDueWork();
    const written = await kitchen.position(firstInput.inventoryItemId);
    expect(written.balance.onHand.amount).toBe(0);
    const eliLot = (await kitchen.stock()).lots.find(
      (lot) => lot.id === `lot_eli-${firstInput.inventoryItemId}`,
    );
    expect(eliLot?.lifecycle.state).toBe("expired");

    Object.assign(evidence, {
      blocked,
      cancelled: { outcome: cancelled.outcome },
      payment: payment?.lifecycle.state,
      ticket: ticket.lifecycle,
      stock: {
        beforeCancel: beforeCancel.balance,
        afterCancel: released.balance,
        afterWriteOff: written.balance,
      },
    });
  } finally {
    writeEvidence(
      "EXPIRED_LOT_ARTIFACT_DIR",
      "made-to-order-cancellation",
      evidence,
    );
    backend.close();
  }
}
