import type {
  OrderQueueAction,
  OrderQueueEntry,
  SoldOutItem,
} from "@purin-labs/control-api";
import type {
  CommerceAdminClient,
  CommerceClientResult,
  CommerceMutationResultV1,
  CommercePickupQueueEntryV1,
  CommerceSoldOutMarksV1,
} from "@purin-labs/commerce-client";

/**
 * The commands of the staff order queue and "sold out today" (Plan 40B phase
 * 3). A person's page and the Portal chat agent (Plan 81) run these, so the two
 * cannot differ.
 *
 * Staff see the shop's open pickups, and each one moves with one action: start
 * it, mark it ready, or hand it over. Commerce's rules stay as they are: a
 * made-to-order line needs a completed preparation ticket before ready, so
 * "ready" walks the ticket through what is left. Each step reads the queue
 * again, so that a sale that moved the merchant's revision costs a repeat and
 * not a refusal.
 */
export type OrderQueueContext = Readonly<{
  client: CommerceAdminClient;
  merchantId: string;
}>;

export type OrderQueueAdvanceResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "commerce_unavailable"
        | "order_queue_changed"
        | "order_queue_payment_missing"
        | "order_queue_busy";
    }>
  | Readonly<{
      ok: false;
      code: "order_queue_refused";
      step: string;
      detail: string;
      field: string | null;
    }>;

export type SoldOutMark =
  Readonly<{ kind: "today"; timeZone: string }> | Readonly<{ kind: "cleared" }>;

export type SoldOutMarkResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "commerce_unavailable"
        | "sold_out_item_not_on_menu"
        | "sold_out_refused"
        | "sold_out_busy";
    }>;

/** The items of the café's published menu, with their marks at its location. */
type CafeSoldOutMenu = Readonly<{
  locationId: string;
  merchantRevision: number;
  items: readonly SoldOutItem[];
}>;

/** The first station of a shop that had none, for made-to-order lines. */
const DEFAULT_STATION_ID = "station_counter";
/** Create, start, complete, ready, and a repeat for each sale that interrupts. */
const STEP_LIMIT = 10;
const CAFE_MENU_ID = "menu_cafe_main";
/** One try, and a repeat for each sale that moves the merchant's revision. */
const MARK_ATTEMPT_LIMIT = 4;

export function presentOrderQueueEntry(
  entry: CommercePickupQueueEntryV1,
): OrderQueueEntry {
  return {
    fulfillmentId: entry.fulfillmentId,
    orderId: entry.orderId,
    code: entry.code,
    channel: entry.channel,
    stage: entry.stage,
    since: entry.since,
    preparation: entry.preparation.state,
    lines: entry.lines,
  };
}

type Step = Readonly<{
  name: string;
  run: (
    base: Readonly<{
      merchantId: string;
      expectedMerchantRevision: number;
      idempotencyKey: string;
    }>,
  ) => Promise<CommerceClientResult<CommerceMutationResultV1>>;
}>;

export async function advanceOrderQueueEntry(
  context: OrderQueueContext,
  fulfillmentId: string,
  action: OrderQueueAction,
  idempotencyKey: string,
): Promise<OrderQueueAdvanceResult> {
  let moved = false;
  for (let attempt = 0; attempt < STEP_LIMIT; attempt += 1) {
    const queue = await context.client.readPickupQueue(context.merchantId);
    if (!queue.ok) return { ok: false, code: "commerce_unavailable" };
    const entry = queue.value.entries.find(
      (candidate) => candidate.fulfillmentId === fulfillmentId,
    );
    // A handed-over pickup leaves the queue. Another tablet may have done it.
    if (entry === undefined)
      return moved ? { ok: true } : { ok: false, code: "order_queue_changed" };
    const step = nextStep(context.client, entry, action);
    if (step === "done") return { ok: true };
    if (step === "changed") return { ok: false, code: "order_queue_changed" };
    if (step === "no_payment")
      return { ok: false, code: "order_queue_payment_missing" };
    const result = await step.run({
      merchantId: context.merchantId,
      expectedMerchantRevision: queue.value.merchantRevision,
      idempotencyKey: `${idempotencyKey}_${attempt}_${step.name}`,
    });
    if (!result.ok) return { ok: false, code: "commerce_unavailable" };
    if (result.value.outcome === "rejected") {
      const code = result.value.error.code;
      // Another sale moved a revision between the read and the command.
      if (
        code === "stale_merchant_revision" ||
        code === "stale_resource_revision"
      )
        continue;
      return {
        ok: false,
        code: "order_queue_refused",
        step: step.name,
        detail: code,
        field: "field" in result.value.error ? result.value.error.field : null,
      };
    }
    moved = true;
  }
  return { ok: false, code: "order_queue_busy" };
}

function nextStep(
  client: CommerceAdminClient,
  entry: CommercePickupQueueEntryV1,
  action: OrderQueueAction,
): Step | "done" | "changed" | "no_payment" {
  const target = {
    orderId: entry.orderId,
    orderRevision: entry.orderRevision,
    fulfillmentId: entry.fulfillmentId,
    fulfillmentRevision: entry.fulfillmentRevision,
  };
  if (action === "hand_over") {
    if (entry.stage !== "ready") return "changed";
    if (entry.payment === null) return "no_payment";
    const payment = entry.payment;
    return {
      name: "complete_pickup",
      run: (base) =>
        client.completePickup({
          ...base,
          ...target,
          paymentId: payment.paymentId,
          paymentRevision: payment.paymentRevision,
        }),
    };
  }
  if (entry.stage === "ready") return action === "ready" ? "done" : "changed";
  const preparation = entry.preparation;
  switch (preparation.state) {
    case "not_started": {
      if (preparation.stationId === null)
        return {
          name: "create_station",
          run: (base) =>
            client.createPreparationStation({
              ...base,
              station: {
                stationId: DEFAULT_STATION_ID,
                locationId: entry.locationId,
                name: "Counter",
              },
            }),
        };
      const stationId = preparation.stationId;
      return {
        name: "create_ticket",
        run: (base) =>
          client.managePreparationTicket({
            ...base,
            operation: {
              kind: "create",
              ticketId: preparation.ticketId,
              orderId: entry.orderId,
              fulfillmentId: entry.fulfillmentId,
              stationId,
            },
          }),
      };
    }
    case "queued":
      return {
        name: "start_ticket",
        run: (base) =>
          client.managePreparationTicket({
            ...base,
            operation: {
              kind: "start",
              ticketId: preparation.ticketId,
              expectedTicketRevision: preparation.ticketRevision,
            },
          }),
      };
    case "preparing":
      if (action === "start") return "done";
      return {
        name: "complete_ticket",
        run: (base) =>
          client.managePreparationTicket({
            ...base,
            operation: {
              kind: "complete",
              ticketId: preparation.ticketId,
              expectedTicketRevision: preparation.ticketRevision,
            },
          }),
      };
    case "not_needed":
    case "completed":
      if (action === "start") return "done";
      return {
        name: "mark_ready",
        run: (base) => client.markPickupReady({ ...base, ...target }),
      };
    default:
      return preparation satisfies never;
  }
}

/**
 * "Sold out today". Commerce ends the mark at the shop's next midnight and
 * refuses the item at checkout.
 */
export async function setSoldOutMark(
  context: OrderQueueContext,
  variantId: string,
  mark: SoldOutMark,
  idempotencyKey: string,
): Promise<SoldOutMarkResult> {
  const menu = await readCafeSoldOutMenu(context);
  if (menu === null) return { ok: false, code: "commerce_unavailable" };
  if (!menu.items.some((item) => item.variantId === variantId))
    return { ok: false, code: "sold_out_item_not_on_menu" };
  for (let attempt = 0; attempt < MARK_ATTEMPT_LIMIT; attempt += 1) {
    const marks = await context.client.readSoldOutMarks(context.merchantId);
    if (!marks.ok) return { ok: false, code: "commerce_unavailable" };
    const result = await context.client.markSoldOut({
      merchantId: context.merchantId,
      expectedMerchantRevision: marks.value.merchantRevision,
      idempotencyKey: `${idempotencyKey}_${attempt}`,
      locationId: menu.locationId,
      variantId,
      mark,
    });
    if (!result.ok) return { ok: false, code: "commerce_unavailable" };
    if (result.value.outcome !== "rejected") return { ok: true };
    if (result.value.error.code !== "stale_merchant_revision")
      return { ok: false, code: "sold_out_refused" };
  }
  return { ok: false, code: "sold_out_busy" };
}

export async function readCafeSoldOutMenu(
  context: OrderQueueContext,
): Promise<CafeSoldOutMenu | null> {
  const [stock, marks] = await Promise.all([
    context.client.readStockSnapshot(context.merchantId),
    context.client.readSoldOutMarks(context.merchantId),
  ]);
  if (!stock.ok || !marks.ok) return null;
  const merchantRevision = marks.value.merchantRevision;
  const menu = stock.value.foodService.resources.menus.find(
    (candidate) => candidate.menuId === CAFE_MENU_ID,
  );
  if (menu?.scope.kind !== "location")
    return { locationId: "", merchantRevision, items: [] };
  const { locationId } = menu.scope;
  const { offers, variants, products } = stock.value.commerce.resources;
  const items = new Map<string, SoldOutItem>();
  for (const entry of menu.entries) {
    const offer = offers.find((candidate) => candidate.id === entry.offerId);
    const variant = variants.find(
      (candidate) => candidate.id === offer?.variantId,
    );
    const product = products.find(
      (candidate) => candidate.id === variant?.productId,
    );
    if (variant === undefined || product === undefined) continue;
    items.set(variant.id, {
      variantId: variant.id,
      title: product.title,
      soldOutUntil: markUntil(marks.value, locationId, variant.id),
    });
  }
  return { locationId, merchantRevision, items: [...items.values()] };
}

function markUntil(
  marks: CommerceSoldOutMarksV1,
  locationId: string,
  variantId: string,
): string | null {
  return (
    marks.marks.find(
      (mark) => mark.locationId === locationId && mark.variantId === variantId,
    )?.until ?? null
  );
}

// The requests and the reads of the order queue tools of the Portal chat
// agent (Plan 81). The tool definitions and their handlers both read them.

export type CounterSaleReadRequest = Readonly<{ checkoutId: string }>;

export type CounterSaleToolRead = Readonly<{
  checkoutId: string;
  pantryLocationId: string;
  state: string;
  collectable: boolean;
  orderId: string | null;
  pickupCode: string | null;
  paymentMethod: string | null;
  tenderBrand: string | null;
  providerRefundable: boolean | null;
  amountMinor: number | null;
  currency: string | null;
  cashReceivedMinor: number | null;
  changeDueMinor: number | null;
  afterSale: Readonly<{
    orderState: string;
    paymentState: string;
    fulfillmentState: string;
    refundState: string;
  }> | null;
}>;

export type OrderQueueToolRead = Readonly<{
  entries: readonly OrderQueueEntry[];
}>;

export type OrderQueueAdvanceRequest = Readonly<{
  fulfillmentId: string;
  action: OrderQueueAction;
}>;

export type SoldOutToolRead = Readonly<{ items: readonly SoldOutItem[] }>;

export type SoldOutMarkRequest = Readonly<{
  variantId: string;
  mark: SoldOutMark;
}>;
