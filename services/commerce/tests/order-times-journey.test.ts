// How long a shop's orders took, as staff read them. The orders, their promised
// times and the staff's steps are the product's. Set ORDER_TIMES_ARTIFACT_DIR to
// keep the evidence.
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  startBackend,
  writeEvidence,
} from "./journey-support.ts";

const SENCHA = "variant_tea_small_sencha";
const START = Date.parse(NOW);

class PickupDesk extends StaffDesk {
  /** Staff move one paid pickup: ready, or ready and then collected. */
  async advance(orderId: string, step: "ready" | "complete"): Promise<void> {
    const resources = await this.snapshot();
    const order = resources.orders.find((item) => item.id === orderId);
    const fulfillment = resources.fulfillments.find(
      (item) => item.orderId === orderId,
    );
    const payment = resources.payments.find((item) => item.orderId === orderId);
    if (
      order === undefined ||
      fulfillment === undefined ||
      payment === undefined
    )
      throw new Error(`${orderId} is incomplete`);
    const target = {
      ...(await this.base(`pickup_${step}_${orderId}`)),
      orderId,
      orderRevision: order.revision,
      fulfillmentId: fulfillment.id,
      fulfillmentRevision: fulfillment.revision,
    };
    await this.apply(
      step === "ready"
        ? this.admin.markPickupReady(target)
        : this.admin.completePickup({
            ...target,
            paymentId: payment.id,
            paymentRevision: payment.revision,
          }),
    );
  }
}

it(
  "shows when each order was placed, what the shop promised, and how far it has come",
  { timeout: 120_000 },
  async () => {
    let clock = START;
    const at = (minutes: number): string =>
      new Date(START + minutes * 60_000).toISOString();
    const backend = await startBackend({
      now: () => new Date(clock).toISOString(),
    });
    try {
      const desk = new PickupDesk(backend.admin, "times");
      await desk.createTea();
      const place = async (name: string, minutes: number): Promise<string> => {
        clock = START + minutes * 60_000;
        const buyer = await Buyer.start(backend.buyer, name);
        const quote = await buyer.tryQuote([catalogLine(SENCHA)]);
        if (quote.kind !== "quoted") throw new Error("No quote");
        return buyer.pay(quote.checkout);
      };
      const read = async (from: number, to: number) =>
        required(
          backend.admin.readOrderTimes(merchantId, {
            start: at(from),
            end: at(to),
          }),
        );

      // Aki is collected. Ben is ready and waits. Cho is still preparing.
      const aki = await place("times_aki", 0);
      const ben = await place("times_ben", 5);
      const cho = await place("times_cho", 10);
      clock = START + 20 * 60_000;
      await desk.advance(aki, "ready");
      clock = START + 30 * 60_000;
      await desk.advance(aki, "complete");
      clock = START + 35 * 60_000;
      await desk.advance(ben, "ready");

      const hour = await read(0, 60);
      expect(hour.truncated).toBe(false);
      // The most recent order comes first. An order's own later change does
      // not move the time that it was placed.
      expect(
        hour.orders.map((order) => ({
          id: order.orderId,
          placedAt: order.placedAt,
          stage: order.stage,
          stageAt: order.stageAt,
        })),
      ).toEqual([
        { id: cho, placedAt: at(10), stage: "preparing", stageAt: null },
        { id: ben, placedAt: at(5), stage: "ready", stageAt: at(35) },
        { id: aki, placedAt: at(0), stage: "finished", stageAt: at(30) },
      ]);
      for (const order of hour.orders) {
        expect(order.expectedBy).not.toBeNull();
        expect(order.lines.length).toBeGreaterThan(0);
        expect(order.amount.amountMinor).toBeGreaterThan(0);
      }

      // The window decides by when the order was placed.
      const middle = await read(5, 10);
      expect(middle.orders.map((order) => order.orderId)).toEqual([ben]);
      const later = await read(40, 60);
      expect(later.orders).toEqual([]);
      // A window with its end first is refused.
      const refused = await backend.admin.readOrderTimes(merchantId, {
        start: at(60),
        end: at(0),
      });
      expect(refused.ok).toBe(false);

      writeEvidence("ORDER_TIMES_ARTIFACT_DIR", "order-times", {
        window: [at(0), at(60)],
        orders: hour.orders.length,
        stages: hour.orders.map((order) => order.stage),
      });
    } finally {
      backend.close();
    }
  },
);
