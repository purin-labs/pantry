import { hasExactKeys, isNonNegativeInteger, isRecord } from "@purin-labs/std";

/**
 * The shop's open pickups (Plan 40B phase 3). Staff work through them in the
 * Portal, and a pickup board shows their codes. Neither names a buyer.
 */

/** How long one order took. It names no buyer. */
export type OrderTime = Readonly<{
  orderId: string;
  code: string;
  channel: "online" | "counter";
  amount: Readonly<{ amountMinor: number; currency: string }>;
  placedAt: string;
  /** What the shop promised; null for an order with no fulfillment. */
  expectedBy: string | null;
  stage: "preparing" | "ready" | "finished" | "cancelled";
  stageAt: string | null;
  lines: readonly Readonly<{ title: string | null; quantity: number }>[];
}>;

export type OrderTimesWindow = Readonly<{
  /** True when the window held more orders than this read returns. */
  truncated: boolean;
  orders: readonly OrderTime[];
}>;

function isOrderTime(value: unknown): value is OrderTime {
  return (
    isRecord(value) &&
    typeof value.orderId === "string" &&
    typeof value.code === "string" &&
    (value.channel === "online" || value.channel === "counter") &&
    isRecord(value.amount) &&
    isNonNegativeInteger(value.amount.amountMinor) &&
    typeof value.amount.currency === "string" &&
    typeof value.placedAt === "string" &&
    (value.expectedBy === null || typeof value.expectedBy === "string") &&
    (value.stage === "preparing" ||
      value.stage === "ready" ||
      value.stage === "finished" ||
      value.stage === "cancelled") &&
    (value.stageAt === null || typeof value.stageAt === "string") &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        (line.title === null || typeof line.title === "string") &&
        isNonNegativeInteger(line.quantity),
    )
  );
}

export function parseOrderTimes(value: unknown): OrderTimesWindow {
  if (
    !isRecord(value) ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.orders) ||
    !value.orders.every(isOrderTime)
  )
    throw new Error("The order times response is not valid.");
  return { truncated: value.truncated, orders: value.orders };
}

type OrderQueuePreparation =
  "not_needed" | "not_started" | "queued" | "preparing" | "completed";

export type OrderQueueEntry = Readonly<{
  fulfillmentId: string;
  orderId: string;
  code: string;
  channel: "online" | "counter";
  stage: "preparing" | "ready";
  /** When the pickup entered its stage. */
  since: string;
  preparation: OrderQueuePreparation;
  lines: readonly Readonly<{
    title: string;
    quantity: number;
    modifiers: readonly string[];
  }>[];
}>;

export type OrderQueueAction = "start" | "ready" | "hand_over";

/** One item of the café's menu, for "Sold out today". */
export type SoldOutItem = Readonly<{
  variantId: string;
  title: string;
  /** When the mark ends; null when the item is on sale. */
  soldOutUntil: string | null;
}>;

export function parseSoldOutItems(
  value: unknown,
): readonly SoldOutItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: SoldOutItem[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, ["variantId", "title", "soldOutUntil"]) ||
      typeof raw.variantId !== "string" ||
      typeof raw.title !== "string" ||
      (raw.soldOutUntil !== null && typeof raw.soldOutUntil !== "string")
    )
      return null;
    items.push({
      variantId: raw.variantId,
      title: raw.title,
      soldOutUntil: raw.soldOutUntil,
    });
  }
  return items;
}

export const MENU_HOUR_DAYS = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
] as const;
export type MenuHourDay = (typeof MENU_HOUR_DAYS)[number];

/** The repeating hours of a menu on the shop's clock; null means all day. */
export type MenuHours = Readonly<{
  timeZone: string;
  slots: readonly Readonly<{
    days: readonly MenuHourDay[];
    startsAt: string;
    endsAt: string;
  }>[];
}>;

function isMenuHourDay(value: unknown): value is MenuHourDay {
  return MENU_HOUR_DAYS.some((day) => day === value);
}

/** The shape only: Commerce refuses hours that make no sense. */
export function parseMenuHours(value: unknown): MenuHours | null {
  if (
    !isRecord(value) ||
    typeof value.timeZone !== "string" ||
    !Array.isArray(value.slots)
  )
    return null;
  const slots: MenuHours["slots"][number][] = [];
  for (const raw of value.slots) {
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.days) ||
      !raw.days.every(isMenuHourDay) ||
      typeof raw.startsAt !== "string" ||
      typeof raw.endsAt !== "string"
    )
      return null;
    slots.push({
      days: raw.days.filter(isMenuHourDay),
      startsAt: raw.startsAt,
      endsAt: raw.endsAt,
    });
  }
  return { timeZone: value.timeZone, slots };
}

export function isOrderQueueAction(value: unknown): value is OrderQueueAction {
  return value === "start" || value === "ready" || value === "hand_over";
}

/** A pickup board's codes, from `GET /v1/screens/pickup`. */
export type MenuScreenPickup = Readonly<{
  observedAt: number;
  preparing: readonly string[];
  ready: readonly string[];
}>;

const PREPARATION_STATES: readonly unknown[] = [
  "not_needed",
  "not_started",
  "queued",
  "preparing",
  "completed",
];

export function parseOrderQueueEntries(
  value: unknown,
): readonly OrderQueueEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: OrderQueueEntry[] = [];
  for (const raw of value) {
    const entry = parseEntry(raw);
    if (entry === null) return null;
    entries.push(entry);
  }
  return entries;
}

function parseEntry(raw: unknown): OrderQueueEntry | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "fulfillmentId",
      "orderId",
      "code",
      "channel",
      "stage",
      "since",
      "preparation",
      "lines",
    ]) ||
    typeof raw.fulfillmentId !== "string" ||
    typeof raw.orderId !== "string" ||
    typeof raw.code !== "string" ||
    (raw.channel !== "online" && raw.channel !== "counter") ||
    (raw.stage !== "preparing" && raw.stage !== "ready") ||
    typeof raw.since !== "string" ||
    !PREPARATION_STATES.includes(raw.preparation) ||
    !Array.isArray(raw.lines)
  )
    return null;
  const lines: OrderQueueEntry["lines"][number][] = [];
  for (const line of raw.lines) {
    if (
      !isRecord(line) ||
      !hasExactKeys(line, ["title", "quantity", "modifiers"]) ||
      typeof line.title !== "string" ||
      !isNonNegativeInteger(line.quantity) ||
      !Array.isArray(line.modifiers) ||
      !line.modifiers.every((modifier) => typeof modifier === "string")
    )
      return null;
    lines.push({
      title: line.title,
      quantity: line.quantity,
      modifiers: line.modifiers as string[],
    });
  }
  return {
    fulfillmentId: raw.fulfillmentId,
    orderId: raw.orderId,
    code: raw.code,
    channel: raw.channel,
    stage: raw.stage,
    since: raw.since,
    preparation: raw.preparation as OrderQueuePreparation,
    lines,
  };
}

export function parseMenuScreenPickup(value: unknown): MenuScreenPickup | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["observedAt", "preparing", "ready"]) ||
    !isNonNegativeInteger(value.observedAt) ||
    !isTextList(value.preparing) ||
    !isTextList(value.ready)
  )
    return null;
  return {
    observedAt: value.observedAt,
    preparing: value.preparing,
    ready: value.ready,
  };
}

function isTextList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
