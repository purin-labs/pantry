// Plan 40B phase 3: staff control what a shop sells today and when a menu
// serves. A latte that staff mark as sold out leaves sale while its stock count
// stays the same, a cart that already holds it is refused, and it returns by
// itself at the shop's midnight, or sooner when staff clear the mark. A menu
// with repeating time slots serves only in them on the shop's clock, and a
// buyer who waits until the slot ends is refused. Set
// SOLD_OUT_SLOTS_ARTIFACT_DIR to keep the run's evidence; the file repeats byte
// for byte for the same commit.
import type { CommerceAdminClient } from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  LOCATION,
  NOW,
  catalogFor,
  latteEntry,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const LATTE_VARIANT = "variant_sesame_latte";
const MENU = "menu_cafe_main";
const LATTE = {
  kind: "menu" as const,
  menuId: MENU,
  menuEntryId: "menu_entry_sesame_latte",
  modifierOptionIds: [],
  quantity: 1,
};
// Friday 14 August 2026, 19:00 in Tokyo. The next midnight there is at 15:00Z.
const TOKYO_MIDNIGHT = Date.parse("2026-08-14T15:00:00.000Z");
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;

it(
  "ends a sold-out mark at the shop's midnight and serves a menu only in its slots",
  { timeout: 60_000 },
  soldOutAndSlotsJourney,
);

async function soldOutAndSlotsJourney(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
  });
  const { admin, buyer } = backend;
  const evidence: Evidence = { merchantId };
  let step = 0;

  const latteAvailability = async () =>
    latteEntry(await catalogFor(buyer))?.availability;

  const mark = async (
    variantId: string,
    value:
      | Readonly<{ kind: "today"; timeZone: string }>
      | Readonly<{ kind: "cleared" }>,
  ) =>
    required(
      admin.markSoldOut({
        merchantId,
        expectedMerchantRevision: await merchantRevision(admin),
        idempotencyKey: `mark_${(step += 1)}`,
        locationId: LOCATION,
        variantId,
        mark: value,
      }),
    );

  const marks = async () =>
    (await required(admin.readSoldOutMarks(merchantId))).marks;

  const publishSlots = async (
    validity: Parameters<
      CommerceAdminClient["publishMenu"]
    >[0]["menu"]["validity"],
  ) => {
    const snapshot = await required(admin.readStockSnapshot(merchantId));
    const menu = snapshot.foodService.resources.menus
      .filter((candidate) => candidate.menuId === MENU)
      .sort((left, right) => right.revision - left.revision)[0];
    if (menu === undefined) throw new Error("The café has no menu");
    return required(
      admin.publishMenu({
        merchantId,
        expectedMerchantRevision: snapshot.commerce.merchantRevision,
        idempotencyKey: `publish_${(step += 1)}`,
        expectedMenuRevision: menu.revision,
        menu: {
          menuId: menu.menuId,
          name: menu.name,
          salesChannelId: menu.salesChannelId,
          scope: menu.scope,
          validity,
          sections: menu.sections.map((section) => ({
            sectionId: section.sectionId,
            name: section.name,
            position: section.position,
          })),
          entries: menu.entries.map((entry) => ({
            menuEntryId: entry.menuEntryId,
            sectionId: entry.sectionId,
            offerId: entry.offerId,
            offerRevision: entry.offerRevision,
            consumptionPlanId: entry.consumptionPlanId,
            consumptionPlanRevision: entry.consumptionPlanRevision,
            modifierGroupRevisions: [...entry.modifierGroupRevisions],
          })),
        },
      }),
    );
  };

  const serving = async () =>
    (await catalogFor(buyer)).menus.some((menu) => menu.menuId === MENU);

  try {
    expect(await latteAvailability()).toBe("available");
    const stockBefore = await latteStock(admin);

    // Ana filled her cart. Then the milk ran out, and staff mark the latte.
    const ana = await Buyer.start(buyer, "ana_waits");
    await ana.fillCart([LATTE]);
    const markCommand = {
      merchantId,
      expectedMerchantRevision: await merchantRevision(admin),
      idempotencyKey: "milk_ran_out",
      locationId: LOCATION,
      variantId: LATTE_VARIANT,
      mark: { kind: "today", timeZone: "Asia/Tokyo" },
    } as const;
    const marked = await required(admin.markSoldOut(markCommand));
    expect(marked).toMatchObject({ outcome: "applied" });
    expect(await latteAvailability()).toBe("unavailable");
    expect(await marks()).toEqual([
      {
        locationId: LOCATION,
        variantId: LATTE_VARIANT,
        revision: 1,
        until: new Date(TOKYO_MIDNIGHT).toISOString(),
      },
    ]);
    // The mark says nothing about the shelf.
    expect(await latteStock(admin)).toEqual(stockBefore);

    const refusedCart = await ana.buyCart().then(
      () => "paid",
      (error: unknown) => String(error),
    );
    expect(refusedCart).toContain("checkout.soldOut");
    const refusedNewBuyer = await (
      await Buyer.start(buyer, "ben_new")
    ).tryQuote([LATTE]);
    expect(refusedNewBuyer.kind).toBe("refused");

    // A lost acknowledgement sends the same command again. It applies once.
    const replayed = await required(admin.markSoldOut(markCommand));
    expect(replayed.outcome).toBe("replayed");
    expect((await marks())[0]?.revision).toBe(1);

    // Staff refuse what they cannot mean.
    const refusedZone = await mark(LATTE_VARIANT, {
      kind: "today",
      timeZone: "Mars/Olympus",
    });
    const refusedVariant = await mark("variant_nothing", {
      kind: "today",
      timeZone: "Asia/Tokyo",
    });
    expect(refusedZone).toMatchObject({
      outcome: "rejected",
      error: { field: "mark.timeZone" },
    });
    expect(refusedVariant).toMatchObject({
      outcome: "rejected",
      error: { code: "resource_not_found" },
    });

    // One minute before midnight it is still sold out; at midnight it returns.
    clock = TOKYO_MIDNIGHT - 60_000;
    expect(await latteAvailability()).toBe("unavailable");
    clock = TOKYO_MIDNIGHT;
    expect(await latteAvailability()).toBe("available");
    expect(await marks()).toEqual([]);
    const paidNextDay = await (
      await Buyer.start(buyer, "cai_next_day")
    ).buyLines([LATTE]);
    expect(paidNextDay.length).toBeGreaterThan(0);

    // A new delivery came early: staff clear the mark the same day.
    await mark(LATTE_VARIANT, { kind: "today", timeZone: "Asia/Tokyo" });
    expect(await latteAvailability()).toBe("unavailable");
    await mark(LATTE_VARIANT, { kind: "cleared" });
    expect(await latteAvailability()).toBe("available");

    // A day of 25 hours: New York's clock falls back on 1 November 2026.
    clock = Date.parse("2026-11-01T05:00:00.000Z");
    await mark(LATTE_VARIANT, { kind: "today", timeZone: "America/New_York" });
    const fallBackUntil = (await marks())[0]?.until;
    expect(fallBackUntil).toBe("2026-11-02T05:00:00.000Z");
    await mark(LATTE_VARIANT, { kind: "cleared" });

    // Slots that make no sense stay off the menu.
    const refusedOvernight = await publishSlots({
      kind: "schedule",
      timeZone: "Asia/Tokyo",
      slots: [{ days: ["fri"], startsAt: "22:00", endsAt: "02:00" }],
    });
    const refusedNoSlots = await publishSlots({
      kind: "schedule",
      timeZone: "Asia/Tokyo",
      slots: [],
    });
    expect(refusedOvernight).toMatchObject({
      outcome: "rejected",
      error: { field: "menu.validity" },
    });
    expect(refusedNoSlots).toMatchObject({
      outcome: "rejected",
      error: { field: "menu.validity" },
    });

    // A morning on weekdays, a shorter morning at the weekend, and the evening
    // on Fridays. Monday 2 November 2026 in Tokyo.
    clock = Date.parse("2026-11-02T00:00:00.000Z");
    expect(
      await publishSlots({
        kind: "schedule",
        timeZone: "Asia/Tokyo",
        slots: [
          { days: [...WEEKDAYS], startsAt: "07:00", endsAt: "11:00" },
          { days: ["sat", "sun"], startsAt: "08:00", endsAt: "10:00" },
          { days: ["fri"], startsAt: "17:00", endsAt: "24:00" },
        ],
      }),
    ).toMatchObject({ outcome: "applied" });

    const servingAt = async (instant: string) => {
      clock = Date.parse(instant);
      return serving();
    };
    const tokyoTimetable = {
      "Monday 06:59": await servingAt("2026-11-01T21:59:00.000Z"),
      "Monday 07:00": await servingAt("2026-11-01T22:00:00.000Z"),
      "Monday 10:59": await servingAt("2026-11-02T01:59:00.000Z"),
      "Monday 11:00": await servingAt("2026-11-02T02:00:00.000Z"),
      "Monday 17:00": await servingAt("2026-11-02T08:00:00.000Z"),
      "Friday 16:59": await servingAt("2026-11-06T07:59:00.000Z"),
      "Friday 17:00": await servingAt("2026-11-06T08:00:00.000Z"),
      "Friday 23:59": await servingAt("2026-11-06T14:59:00.000Z"),
      "Saturday 00:00": await servingAt("2026-11-06T15:00:00.000Z"),
      "Saturday 07:30": await servingAt("2026-11-06T22:30:00.000Z"),
      "Saturday 08:00": await servingAt("2026-11-06T23:00:00.000Z"),
      "Saturday 10:00": await servingAt("2026-11-07T01:00:00.000Z"),
    };
    expect(tokyoTimetable).toEqual({
      "Monday 06:59": false,
      "Monday 07:00": true,
      "Monday 10:59": true,
      "Monday 11:00": false,
      "Monday 17:00": false,
      "Friday 16:59": false,
      "Friday 17:00": true,
      "Friday 23:59": true,
      "Saturday 00:00": false,
      "Saturday 07:30": false,
      "Saturday 08:00": true,
      "Saturday 10:00": false,
    });

    // Dee buys in the morning slot. Eri fills her cart and waits too long.
    clock = Date.parse("2026-11-09T01:00:00.000Z");
    const paidInSlot = await (
      await Buyer.start(buyer, "dee_morning")
    ).buyLines([LATTE]);
    expect(paidInSlot.length).toBeGreaterThan(0);
    const eri = await Buyer.start(buyer, "eri_waits");
    await eri.fillCart([LATTE]);
    clock = Date.parse("2026-11-09T02:00:00.000Z");
    const refusedAfterSlot = await eri.buyCart().then(
      () => "paid",
      (error: unknown) => String(error),
    );
    expect(refusedAfterSlot).not.toBe("paid");
    const refusedOutOfSlot = await (
      await Buyer.start(buyer, "fay_late")
    ).tryQuote([LATTE]);
    expect(refusedOutOfSlot.kind).toBe("refused");

    // A sold-out mark and a slot work together: the slot opens without it.
    clock = Date.parse("2026-11-09T23:00:00.000Z");
    expect(await latteAvailability()).toBe("available");

    Object.assign(evidence, {
      markedUntil: new Date(TOKYO_MIDNIGHT).toISOString(),
      refusedCart,
      refusedNewBuyer,
      refusedZone: refusedZone.outcome,
      fallBackUntil,
      refusedOvernight: refusedOvernight.outcome,
      refusedNoSlots: refusedNoSlots.outcome,
      tokyoTimetable,
      refusedAfterSlot,
      refusedOutOfSlot,
    });
  } finally {
    writeEvidence(
      "SOLD_OUT_SLOTS_ARTIFACT_DIR",
      "sold-out-and-slots",
      evidence,
    );
    backend.close();
  }
}

async function merchantRevision(admin: CommerceAdminClient): Promise<number> {
  return (await required(admin.readStockSnapshot(merchantId))).commerce
    .merchantRevision;
}

async function latteStock(admin: CommerceAdminClient) {
  const stock = await required(admin.readStockSnapshot(merchantId));
  return stock.commerce.resources.inventoryPositions.map((position) => ({
    id: position.id,
    balance: position.balance,
  }));
}
