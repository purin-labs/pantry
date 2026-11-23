/**
 * Sample answers for the commerce preview's reads of the Products list, the
 * Payments and Payouts pages and the Orders timeline. The times follow the
 * clock of the browser, so each page opens on data of its first period.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

const photos = { revision: 0, items: [] };

function productLink(
  productId: string,
  title: string,
  amountMinor: number,
  description: string,
) {
  return {
    productId,
    productTitle: title,
    productRevision: 3,
    deleteBlock: null,
    variantId: `${productId}_variant`,
    variantTitle: "Default",
    variantRevision: 2,
    offerId: `${productId}_offer`,
    offerRevision: 4,
    price: { amountMinor, currency: "JPY" },
    description,
    image: null,
    photos,
  };
}

function productRow(
  id: string,
  link: ReturnType<typeof productLink>,
  stock: Readonly<{
    onHand: string | null;
    allocated: string | null;
    available: string | null;
    status: "uncounted" | "out" | "low" | "healthy";
  }>,
) {
  return {
    id,
    inventoryItemId: `item_${id}`,
    positionId: `position_${id}`,
    recipeCount: 1,
    locationId: "location_boutique",
    name: link.productTitle,
    location: "Tokyo boutique",
    ...stock,
    reorderPoint: "12",
    target: "40",
    kind: "product",
    category: "finished_good",
    product: link,
    lots: [],
    movements: [],
    reservations: [],
  };
}

/** The `/commerce/inventory` answer: the products of a pâtisserie. */
export function previewInventory(scenario: string): unknown {
  if (scenario === "empty")
    return { ok: true, rows: [], untrackedProducts: [], archivedProducts: [] };
  return {
    ok: true,
    rows: [
      productRow(
        "financier",
        productLink(
          "product_financier",
          "Brown butter financier",
          420,
          "A small almond cake with browned butter and a crisp golden edge.",
        ),
        { onHand: "24", allocated: "4", available: "20", status: "healthy" },
      ),
      productRow(
        "eclair",
        productLink("product_eclair", "Pistachio éclair", 680, ""),
        { onHand: "6", allocated: "2", available: "4", status: "low" },
      ),
      productRow("canele", productLink("product_canele", "Canelé", 380, ""), {
        onHand: "0",
        allocated: "0",
        available: "0",
        status: "out",
      }),
      productRow(
        "sable_box",
        productLink("product_sable_box", "Sablé gift box", 2400, ""),
        { onHand: null, allocated: null, available: null, status: "uncounted" },
      ),
    ],
    untrackedProducts: [
      {
        ...productLink("product_fruit_tart", "Seasonal fruit tart", 3200, ""),
        name: "Seasonal fruit tart",
        madeToOrder: true,
      },
      {
        ...productLink("product_roll_cake", "Matcha roll cake", 1800, ""),
        name: "Matcha roll cake",
        madeToOrder: false,
      },
    ],
    archivedProducts: [
      {
        productId: "product_mont_blanc",
        title: "Chestnut Mont Blanc",
        revision: 5,
        deleteBlock: "sold",
        image: null,
        photos,
      },
    ],
  };
}

function windowOf(url: string): Readonly<{ from: number; to: number }> {
  const query = new URL(url, window.location.origin).searchParams;
  return { from: Number(query.get("from")), to: Number(query.get("to")) };
}

/** A time a few minutes before now, kept inside the window that was read. */
function recent(
  window: Readonly<{ from: number; to: number }>,
  minutesAgo: number,
): number | null {
  const at = Math.min(Date.now(), window.to) - minutesAgo * MINUTE;
  return at >= window.from ? at : null;
}

/** The `/commerce/payments` answer: paid, declined and recovered payments. */
export function previewPayments(url: string): unknown {
  const window = windowOf(url);
  const step = (
    paymentAttemptId: string,
    minutesAgo: number,
    rest: Readonly<{
      follows?: string;
      channel?: "online" | "counter";
      amountMinor: number;
      state: "declined" | "paid";
      reasonCode?: string;
      orderCode?: string;
      lines: readonly Readonly<{ title: string; quantity: number }>[];
    }>,
  ) => {
    const at = recent(window, minutesAgo);
    return at === null
      ? []
      : [
          {
            paymentAttemptId,
            follows: rest.follows ?? null,
            channel: rest.channel ?? "online",
            amount: { amountMinor: rest.amountMinor, currency: "JPY" },
            at: new Date(at).toISOString(),
            state: rest.state,
            reasonCode: rest.reasonCode ?? null,
            orderCode: rest.orderCode ?? null,
            lines: rest.lines,
          },
        ];
  };
  return {
    truncated: false,
    steps: [
      ...step("pay_1", 140, {
        amountMinor: 840,
        state: "paid",
        orderCode: "A12",
        lines: [{ title: "Brown butter financier", quantity: 2 }],
      }),
      ...step("pay_2", 110, {
        amountMinor: 2400,
        state: "declined",
        reasonCode: "card_declined",
        lines: [{ title: "Sablé gift box", quantity: 1 }],
      }),
      ...step("pay_3", 104, {
        follows: "pay_2",
        amountMinor: 2400,
        state: "paid",
        orderCode: "A13",
        lines: [{ title: "Sablé gift box", quantity: 1 }],
      }),
      ...step("pay_4", 70, {
        amountMinor: 1360,
        state: "declined",
        reasonCode: "payment_method_required",
        lines: [
          { title: "Pistachio éclair", quantity: 1 },
          { title: "Canelé", quantity: 2 },
        ],
      }),
      ...step("pay_5", 30, {
        channel: "counter",
        amountMinor: 760,
        state: "paid",
        orderCode: "C04",
        lines: [{ title: "Canelé", quantity: 2 }],
      }),
    ],
  };
}

function localDay(at: number): string {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The `/commerce/bank-payouts` answer for a month of local days. */
export function previewBankPayouts(url: string, scenario: string): unknown {
  const query = new URL(url, window.location.origin).searchParams;
  const [year = 2026, month = 1, day = 1] = (query.get("from") ?? "")
    .split("-")
    .map(Number);
  const first = new Date(year, month - 1, day, 12).getTime();
  const payout = (
    payoutId: string,
    dayOfMonth: number,
    amountMinor: number,
    status: "on_its_way" | "arrived" | "failed" | "cancelled",
    provider: "stripe" | "square" = "stripe",
  ) => {
    const arrival = first + (dayOfMonth - 1) * DAY;
    return {
      provider,
      payoutId,
      amount: { amountMinor, currency: "JPY" },
      status,
      arrivalDate: localDay(arrival),
      sentAt: new Date(arrival - 2 * DAY).toISOString(),
      sales: {
        from: new Date(arrival - 9 * DAY).toISOString(),
        to: new Date(arrival - 3 * DAY).toISOString(),
      },
    };
  };
  if (scenario === "empty")
    return { sources: [], truncated: false, payouts: [] };
  return {
    sources: [
      { provider: "stripe", state: "read" },
      { provider: "square", state: "needs_permission" },
    ],
    truncated: false,
    payouts: [
      payout("po_stripe_1", 4, 48200, "arrived"),
      payout("po_stripe_2", 11, 31500, "arrived"),
      payout("po_stripe_3", 18, 52650, "arrived"),
      payout("po_stripe_4", 21, 12800, "failed"),
      payout("po_stripe_5", 27, 40300, "on_its_way"),
    ],
  };
}

/** The `/commerce/order-times` answer: today's orders, one of them late. */
export function previewOrderTimes(url: string): unknown {
  const window = windowOf(url);
  const order = (
    orderId: string,
    code: string,
    placedAgo: number,
    stage: "preparing" | "ready" | "finished" | "cancelled",
    stageAgo: number | null,
    promisedAgo: number | null,
    amountMinor: number,
    title: string,
  ) => {
    const placed = recent(window, placedAgo);
    if (placed === null) return [];
    return [
      {
        orderId,
        code,
        channel: code.startsWith("C") ? "counter" : "online",
        amount: { amountMinor, currency: "JPY" },
        placedAt: new Date(placed).toISOString(),
        expectedBy:
          promisedAgo === null
            ? null
            : new Date(Date.now() - promisedAgo * MINUTE).toISOString(),
        stage,
        stageAt:
          stageAgo === null
            ? null
            : new Date(Date.now() - stageAgo * MINUTE).toISOString(),
        lines: [{ title, quantity: 1 }],
      },
    ];
  };
  return {
    truncated: false,
    orders: [
      ...order(
        "ord_1036",
        "A10",
        150,
        "cancelled",
        140,
        null,
        3200,
        "Seasonal fruit tart",
      ),
      ...order(
        "ord_1037",
        "A11",
        130,
        "finished",
        100,
        110,
        840,
        "Brown butter financier",
      ),
      ...order(
        "ord_1038",
        "A12",
        90,
        "finished",
        72,
        70,
        2400,
        "Sablé gift box",
      ),
      ...order("ord_1039", "C04", 45, "ready", 35, 30, 760, "Canelé"),
      ...order(
        "ord_1040",
        "A13",
        25,
        "preparing",
        null,
        5,
        1360,
        "Pistachio éclair",
      ),
    ],
  };
}
