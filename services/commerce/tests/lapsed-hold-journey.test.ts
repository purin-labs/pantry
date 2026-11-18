// Plan 76 phase 7: a quoted checkout holds stock until its quote lapses.
// Ana quotes most of the tea tins and leaves; Ben pays for one; Cai is
// refused for want of stock. Before Ana's quote lapses the alarm changes
// nothing. After it, the alarm expires Ana's checkout and her tins return:
// Cai buys, Ana's old checkout cannot be paid, and the event feed shows the
// expiry. A checkout whose payment is under way keeps its hold; once its
// quote lapses, the alarm reads the payment and places the paid order.
import { expect, it } from "vitest";

import {
  Buyer,
  CAFE_LOTS_EXPIRE,
  NOW,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  startBackend,
} from "./journey-support.ts";

const TIN = "position_tea_tin_cafe";

it("returns the stock of a lapsed checkout to buyers who wait for it", async () => {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
  });
  try {
    await new StaffDesk(backend.admin, "lapse").createTea();
    const sencha = catalogLine("variant_tea_small_sencha");
    const available = async () => {
      const snapshot = await required(backend.admin.readSnapshot(merchantId));
      const position = snapshot.resources.inventoryPositions.find(
        (item) => item.id === TIN,
      );
      if (position?.balance.kind !== "accounted") throw new Error("No tins");
      return position.balance.available.amount;
    };
    const stock = await available();

    const ana = await Buyer.start(backend.buyer, "lapse_ana");
    const anaCheckout = await ana.quote([{ ...sencha, quantity: stock - 2 }]);
    const dee = await Buyer.start(backend.buyer, "lapse_dee");
    const deeCheckout = await dee.quote([sencha]);
    await dee.startPayment(deeCheckout);
    const ben = await Buyer.start(backend.buyer, "lapse_ben");
    await ben.buyLines([sencha]);
    const cai = await Buyer.start(backend.buyer, "lapse_cai");
    // The tea shows as sold out, so Cai cannot even fill a cart.
    expect((await cai.tryQuote([sencha])).kind).toBe("refused");

    // Before Ana's quote lapses, the alarm only learns when to come back.
    const lapse = Date.parse(anaCheckout.quote.expiresAt);
    expect(await backend.runDueWork()).toBe(anaCheckout.quote.expiresAt);
    expect(await available()).toBe(0);

    clock = lapse + 1_000;
    await backend.runDueWork();
    expect(await available()).toBe(stock - 2);
    const caiCheckout = await cai.quote([sencha]);
    await cai.pay(caiCheckout);
    expect(await ana.tryPay(anaCheckout)).toBeDefined();
    // Dee's payment was under way: her tin stayed held for her, and after
    // her quote lapsed the alarm read the paid payment and placed her order.
    const snapshot = await required(backend.admin.readSnapshot(merchantId));
    expect(
      snapshot.resources.orders.filter(
        (order) =>
          order.origin.kind === "online" &&
          order.origin.checkoutId === deeCheckout.checkoutId,
      ),
    ).toHaveLength(1);

    const kinds: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await required(
        backend.admin.readEvents(merchantId, {
          ...(after === undefined ? {} : { after }),
          limit: 200,
        }),
      );
      kinds.push(...page.events.map((event) => event.kind));
      if (page.nextCursor === null || page.events.length < 200) break;
      after = page.nextCursor;
    }
    expect(kinds.filter((kind) => kind === "checkout.expired")).toHaveLength(1);
    expect(await backend.runDueWork()).toBe(CAFE_LOTS_EXPIRE);
  } finally {
    backend.close();
  }
});
