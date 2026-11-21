// Plan 77 step 4: one merchant plugin uses the four checkout hooks other than
// validate. Two or more boxes cost 10% less (lines), ¥500 comes off an order
// of ¥5,000 or more (discount), gift cards do not pay for whole cakes
// (tenders), and a whole cake is ready no earlier than 48 hours after the
// order (delivery). The core applies each output: the paid order keeps the
// plugin's prices and discount, a whole cake moves to its notice time and
// keeps it through a refresh, a buyer's earlier pickup time and a gift card
// for a cake are refused with the plugin's words, and a shipping checkout
// gets the same line prices. A second plugin that raises a price is skipped
// and reported as a failure. Set CHECKOUT_HOOKS_ARTIFACT_DIR to keep the
// run's evidence; the file repeats byte for byte for the same commit.
import type {
  CommerceAdminClient,
  CommerceBuyerQuotedShippingCheckoutV1,
  CommercePluginSettingsV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";
import type { PluginDefinition } from "@purin-labs/commerce-contracts";
import { expect, it } from "vitest";

import { readCheckout } from "../src/checkout-persistence.ts";
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
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const SHIPPING_SHOP = "storefront_cookie_store_sg";
const GIFT_CODE = "HANA-2345-6789-ABCD";
const HOUR = 3_600_000;

const SOURCES = {
  bulk_prices: `
function run(input) {
  const settings = input.settings;
  return { prices: input.checkout.lines
    .filter((line) => line.quantity >= settings.bulkQuantity)
    .map((line) => ({
      checkoutLineId: line.checkoutLineId,
      unitPriceMinor: Math.floor(
        line.unitPriceMinor * (100 - settings.bulkPercentOff) / 100),
    })) };
}`,
  order_discount: `
function run(input) {
  const settings = input.settings;
  return { discounts:
    input.checkout.subtotalMinor >= settings.orderDiscountThreshold
      ? [{ amountMinor: settings.orderDiscountMinor }]
      : [] };
}`,
  cake_tenders: `
function run(input) {
  const cake = input.checkout.lines.some((line) =>
    input.settings.wholeCakeVariantIds.includes(line.variantId));
  return { refusals: cake
    ? [{ tender: "gift_card", message: "Gift cards do not pay for whole cakes." }]
    : [] };
}`,
  cake_notice: `
function run(input) {
  const settings = input.settings;
  const cake = input.checkout.lines.some((line) =>
    settings.wholeCakeVariantIds.includes(line.variantId));
  if (input.fulfillment.kind !== "pickup" || !cake) return {};
  return {
    earliestReadyAt: new Date(Date.parse(input.checkout.quotedAt) +
      settings.noticeHours * 3600000).toISOString(),
    message: "Whole cakes need " + settings.noticeHours + " hours' notice.",
  };
}`,
};

const HOOKS = {
  bulk_prices: "checkout.lines",
  order_discount: "checkout.discount",
  cake_tenders: "checkout.tenders",
  cake_notice: "checkout.delivery",
} as const;

const SETTINGS: CommercePluginSettingsV1 = {
  bulkQuantity: 2,
  bulkPercentOff: 10,
  orderDiscountThreshold: 5_000,
  orderDiscountMinor: 500,
  wholeCakeVariantIds: [LARGE_SENCHA],
  noticeHours: 48,
};

function cafeRules(): PluginDefinition {
  return {
    pluginId: "cafe_rules",
    version: 1,
    kind: "merchant",
    title: "Café rules",
    purpose:
      "Boxes cost less in twos, big orders get ¥500 off, and whole cakes need notice and no gift cards.",
    requirements: {
      hookPoints: [...new Set(Object.values(HOOKS))],
      reads: [],
      commands: [],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: Object.entries(SETTINGS).map(([key, value]) => ({
        key,
        valueKind: Array.isArray(value) ? "text_list" : "integer",
        description: key,
      })),
      functions: Object.entries(SOURCES).map(([functionId, source]) => ({
        functionId,
        hookPoint: HOOKS[functionId as keyof typeof HOOKS],
        required: false,
        source,
      })),
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}

/** A plugin whose price is above the catalog's, so the core skips it. */
function brokenPrices(): PluginDefinition {
  const base = cafeRules();
  return {
    ...base,
    pluginId: "broken_prices",
    title: "Broken prices",
    purpose: "Raises every price by ¥100, which the lines hook does not allow.",
    requirements: { ...base.requirements, hookPoints: ["checkout.lines"] },
    contributions: {
      ...base.contributions,
      settings: [],
      functions: [
        {
          functionId: "raise",
          hookPoint: "checkout.lines",
          required: false,
          source: `function run(input) { return { prices: input.checkout.lines.map((line) => ({ checkoutLineId: line.checkoutLineId, unitPriceMinor: line.unitPriceMinor + 100 })) }; }`,
        },
      ],
    },
  };
}

it(
  "applies a plugin's line prices, discount, tender and delivery rules at checkout",
  { timeout: 90_000 },
  checkoutHooks,
);

async function checkoutHooks(): Promise<void> {
  let clock = Date.parse(NOW);
  const backend = await startBackend({
    now: () => new Date(clock).toISOString(),
  });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, database } = backend;
    const staff = new HookDesk(admin);
    await staff.createTea();
    await staff.issueGiftCard("gift_hana", GIFT_CODE, 5_000);
    expect(await staff.install(cafeRules(), SETTINGS)).toMatchObject({
      outcome: "applied",
    });
    const runsOf = (checkoutId: string) =>
      (
        readCheckout(database, merchantId, checkoutId)?.lifecycle.quote
          .pluginRuns ?? []
      ).map((run) => `${run.functionId}:${run.outcome}`);
    const quote = async (
      name: string,
      lines: Parameters<Buyer["quote"]>[0],
      choose: Partial<Pick<Buyer, "pickupAt" | "giftCardCodes">> = {},
    ) => {
      const shopper = await Buyer.start(buyer, `hooks_${name}`);
      Object.assign(shopper, choose);
      return { shopper, result: await shopper.tryQuote(lines) };
    };
    const quoted = (result: Awaited<ReturnType<Buyer["tryQuote"]>>) => {
      if (result.kind !== "quoted")
        throw new Error(`Refused: ${JSON.stringify(result.error)}`);
      return result.checkout;
    };
    const lead = (
      await quote("one", [catalogLine(SMALL_SENCHA)]).then(({ result }) =>
        quoted(result),
      )
    ).quote;

    // One box: the catalog price, ready after the shop's lead time.
    expect(lead.lines[0]).toMatchObject({
      unitPrice: jpy(1_200),
      lineTotal: jpy(1_200),
    });
    expect(lead.totals.discount).toBeUndefined();

    // Two boxes cost 10% less each; ¥2,160 gets no order discount.
    const two = quoted(
      (await quote("two", [{ ...catalogLine(SMALL_SENCHA), quantity: 2 }]))
        .result,
    );
    expect(two.quote.lines[0]).toMatchObject({
      unitPrice: jpy(1_080),
      lineTotal: jpy(2_160),
    });
    expect(two.quote.totals.discount).toBeUndefined();

    // Five boxes: ¥5,400 at the lower price, then ¥500 off the order before
    // tax. The paid order charges what the quote said.
    const five = await quote("five", [
      { ...catalogLine(SMALL_SENCHA), quantity: 5 },
    ]);
    const fiveQuote = quoted(five.result);
    expect(fiveQuote.quote.lines[0]).toMatchObject({
      unitPrice: jpy(1_080),
      lineTotal: jpy(4_900),
      discount: jpy(500),
    });
    expect(fiveQuote.quote.totals).toMatchObject({
      subtotal: jpy(4_900),
      discount: jpy(500),
    });
    const fiveOrder = await five.shopper.pay(fiveQuote);
    const charged = await staff.paymentOf(fiveOrder);
    expect(charged?.amount).toEqual(fiveQuote.quote.totals.total);
    expect(runsOf(fiveQuote.checkoutId)).toEqual([
      "bulk_prices:passed",
      "order_discount:passed",
      "cake_tenders:passed",
      "cake_notice:passed",
    ]);

    // A whole cake is ready 48 hours after the order. A refresh five minutes
    // later moves it to 48 hours after the refresh: the plugin set the time,
    // the buyer did not choose it.
    const cake = await quote("cake", [catalogLine(LARGE_SENCHA)]);
    const cakeQuote = quoted(cake.result);
    const atNotice = new Date(Date.parse(NOW) + 48 * HOUR).toISOString();
    expect(cakeQuote.quote.pickup.readyAt).toBe(atNotice);
    expect(lead.pickup.readyAt < atNotice).toBe(true);
    clock += 5 * 60_000;
    const refreshed = await cake.shopper.refresh(cakeQuote, [
      catalogLine(LARGE_SENCHA),
    ]);
    expect(refreshed.quote.pickup.readyAt).toBe(
      new Date(clock + 48 * HOUR).toISOString(),
    );
    clock = Date.parse(NOW);

    // A buyer's own pickup time before the notice is refused with the
    // plugin's words; a later one stands.
    const early = await quote("cake_early", [catalogLine(LARGE_SENCHA)], {
      pickupAt: new Date(Date.parse(NOW) + 24 * HOUR).toISOString(),
    });
    expect(early.result).toMatchObject({
      kind: "refused",
      error: {
        code: "checkout_refused",
        pluginId: "cafe_rules",
        message: "Whole cakes need 48 hours' notice.",
      },
    });
    const later = new Date(Date.parse(NOW) + 72 * HOUR).toISOString();
    const late = await quote("cake_late", [catalogLine(LARGE_SENCHA)], {
      pickupAt: later,
    });
    expect(quoted(late.result).quote.pickup.readyAt).toBe(later);

    // Gift cards pay for tea, not for a whole cake.
    const cakeGift = await quote("cake_gift", [catalogLine(LARGE_SENCHA)], {
      giftCardCodes: [GIFT_CODE],
    });
    expect(cakeGift.result).toMatchObject({
      kind: "refused",
      error: {
        code: "checkout_refused",
        message: "Gift cards do not pay for whole cakes.",
      },
    });
    const teaGift = quoted(
      (
        await quote("tea_gift", [catalogLine(SMALL_SENCHA)], {
          giftCardCodes: [GIFT_CODE],
        })
      ).result,
    );
    expect(teaGift.quote.storedValue?.amount).toEqual(
      teaGift.quote.totals.total,
    );

    // A shipping checkout gets the same rules: two boxes of cookies to
    // Singapore cost 10% less each, and the order of more than ¥5,000 gets
    // ¥500 off before the carrier rate, tax and duty.
    const shipped = await shipTwoBoxes(buyer, "hooks_ship");
    const shippedLine = shipped.quote.lines[0];
    if (shippedLine === undefined) throw new Error("No shipped line");
    expect(shippedLine).toMatchObject({
      unitPrice: jpy(3_240),
      lineTotal: jpy(5_980),
      discount: jpy(500),
    });
    expect(runsOf(shipped.checkoutId)).toEqual([
      "bulk_prices:passed",
      "order_discount:passed",
      "cake_notice:passed",
      "cake_tenders:passed",
    ]);

    // A plugin that raises a price is skipped: the café's lower price
    // stands, and the failure is an event with its reason.
    expect(await staff.install(brokenPrices(), {})).toMatchObject({
      outcome: "applied",
    });
    const mixed = quoted(
      (await quote("mixed", [{ ...catalogLine(SMALL_SENCHA), quantity: 2 }]))
        .result,
    );
    expect(mixed.quote.lines[0]).toMatchObject({ unitPrice: jpy(1_080) });
    expect(runsOf(mixed.checkoutId)).toContain("raise:skipped");
    const broken = (await required(admin.listPlugins(merchantId))).plugins.find(
      (plugin) => plugin.pluginId === "broken_prices",
    );
    expect(broken?.lastFailure).toMatchObject({
      functionId: "raise",
      reason: "invalid_output",
      failuresInARow: 1,
    });
    const pluginEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("plugin."));
    expect(pluginEvents).toEqual([
      "plugin.installed",
      "plugin.installed",
      "plugin.function_failed",
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      quotes: {
        one: lead.lines,
        two: two.quote.lines,
        five: { lines: fiveQuote.quote.lines, totals: fiveQuote.quote.totals },
        cake: cakeQuote.quote.pickup,
        cakeRefreshed: refreshed.quote.pickup,
        cakeLate: later,
        shipped: shipped.quote.lines,
        mixed: mixed.quote.lines,
      },
      refusals: { early: early.result, cakeGift: cakeGift.result },
      runs: {
        five: runsOf(fiveQuote.checkoutId),
        shipped: runsOf(shipped.checkoutId),
        mixed: runsOf(mixed.checkoutId),
      },
      lastFailure: broken?.lastFailure,
      pluginEvents,
    });
  } finally {
    writeEvidence("CHECKOUT_HOOKS_ARTIFACT_DIR", "checkout-hooks", evidence);
    backend.close();
  }
}

/** A guest who ships two boxes of the first available listing to Singapore. */
async function shipTwoBoxes(
  client: CommerceStorefrontClient,
  name: string,
): Promise<CommerceBuyerQuotedShippingCheckoutV1> {
  const session = await required(
    client.createSession(merchantId, SHIPPING_SHOP, {
      schemaVersion: "commerce.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const catalog = await required(
    client.readCatalog(merchantId, SHIPPING_SHOP, session.token),
  );
  const listing = catalog.listings.find(
    (item) => item.availability === "available",
  );
  const service =
    catalog.storefront.fulfillment === "shipping"
      ? catalog.storefront.shippingServices.find(
          (item) =>
            item.destinationCountry === "SG" &&
            item.availability.state === "available",
        )
      : undefined;
  if (listing === undefined || service === undefined)
    throw new Error("The shipping storefront sells nothing to Singapore");
  const cart = await required(
    client.createCart(merchantId, SHIPPING_SHOP, session.token, {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: `${name}_cart`,
      lines: [{ kind: "catalog", variantId: listing.variantId, quantity: 2 }],
    }),
  );
  const validation = await required(
    client.validateShippingAddress(merchantId, SHIPPING_SHOP, session.token, {
      schemaVersion: "commerce.validate-buyer-shipping-address.v1",
      idempotencyKey: `${name}_address`,
      address: {
        countryCode: "SG",
        recipientName: "Hana Lim",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
    }),
  );
  if (validation.state !== "accepted")
    throw new Error("The Singapore address was not accepted");
  return required(
    client.createShippingCheckout(merchantId, SHIPPING_SHOP, session.token, {
      schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
      idempotencyKey: `${name}_checkout`,
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: `${name}@example.test` },
      },
      shippingServiceCode: service.service.code,
      shippingDestination: {
        kind: "provided_address",
        address: validation.address,
        acceptance: {
          kind: "accepted_as_entered",
          addressValidationReference: validation.validationReference,
        },
      },
    }),
  );
}

class HookDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "checkout_hooks");
  }

  install(definition: PluginDefinition, settings: CommercePluginSettingsV1) {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase(`install_${definition.pluginId}`),
        definition,
        settings,
        expectedRevision: null,
      }),
    );
  }

  async paymentOf(orderId: string) {
    return (await this.snapshot()).payments.find(
      (payment) => payment.orderId === orderId,
    );
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
}
