// The governed action that changes the price of one café menu item, or sets
// or ends a deal on it (Plan 40B phase 4). A board never holds a price: the
// price lives on the Commerce offer, and every menu, board and the QR order
// page reads it live. The path carries the price before and after, so the
// card shows both and the approval signs exactly that change. A deal is the
// new price with the earlier price kept as the offer's compare-at price.
import { isRecord } from "@purin-labs/std";

import type { Result } from "../result";

export const MENU_PRICE_CHANGE_VERB = "commerce.menu.change_price";

type MenuPriceMoney = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type MenuPriceSide = Readonly<{
  price: MenuPriceMoney;
  /** The "was" price of a deal; null when the item has no deal. */
  compareAtPrice: MenuPriceMoney | null;
}>;

export type ChangeMenuPriceAction = Readonly<{
  kind: "change_menu_price";
  /** The plain Commerce offer ID of the menu item. */
  offerId: string;
  /** The offer revision that the proposal read; a later one is refused. */
  expectedOfferRevision: number;
  /** The menu item (Commerce menu entry) that the boards show. */
  menuEntryId: string;
  /** The item's name on the menu, for the card. */
  itemName: string;
  before: MenuPriceSide;
  after: MenuPriceSide;
}>;

type ParseError = Readonly<{ code: "commerce_action_invalid"; field: string }>;

function invalid(field: string): Result<never, ParseError> {
  return { ok: false, error: { code: "commerce_action_invalid", field } };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function shortId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:.-]{1,160}$/u.test(value);
}

function parseMoney(value: unknown): MenuPriceMoney | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    positiveInteger(value.amountMinor) === null ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(value.currency)
  )
    return null;
  return { amountMinor: value.amountMinor as number, currency: value.currency };
}

function parseSide(value: unknown): MenuPriceSide | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  const price = parseMoney(value.price);
  if (price === null) return null;
  if (value.compareAtPrice === null) return { price, compareAtPrice: null };
  const compareAtPrice = parseMoney(value.compareAtPrice);
  // A "was" price is in the same currency and above the price, or no deal.
  if (
    compareAtPrice === null ||
    compareAtPrice.currency !== price.currency ||
    compareAtPrice.amountMinor <= price.amountMinor
  )
    return null;
  return { price, compareAtPrice };
}

function sameSide(first: MenuPriceSide, second: MenuPriceSide): boolean {
  return (
    first.price.amountMinor === second.price.amountMinor &&
    first.price.currency === second.price.currency &&
    (first.compareAtPrice?.amountMinor ?? null) ===
      (second.compareAtPrice?.amountMinor ?? null)
  );
}

export function parseChangeMenuPriceRequest(
  raw: Record<string, unknown>,
): Result<ChangeMenuPriceAction, ParseError> {
  const keys = [
    "kind",
    "offerId",
    "expectedOfferRevision",
    "menuEntryId",
    "itemName",
    "before",
    "after",
  ];
  for (const key of Object.keys(raw))
    if (!keys.includes(key) && raw[key] !== null && raw[key] !== undefined)
      return invalid(key);
  if (!shortId(raw.offerId)) return invalid("offerId");
  const expectedOfferRevision = positiveInteger(raw.expectedOfferRevision);
  if (expectedOfferRevision === null) return invalid("expectedOfferRevision");
  if (!shortId(raw.menuEntryId)) return invalid("menuEntryId");
  if (
    typeof raw.itemName !== "string" ||
    raw.itemName.length === 0 ||
    raw.itemName.length > 280
  )
    return invalid("itemName");
  const before = parseSide(raw.before);
  if (before === null) return invalid("before");
  const after = parseSide(raw.after);
  if (after === null || after.price.currency !== before.price.currency)
    return invalid("after");
  if (sameSide(before, after)) return invalid("after");
  return {
    ok: true,
    value: {
      kind: "change_menu_price",
      offerId: raw.offerId,
      expectedOfferRevision,
      menuEntryId: raw.menuEntryId,
      itemName: raw.itemName,
      before,
      after,
    },
  };
}

export function menuPriceActionPath(action: ChangeMenuPriceAction): string {
  const params = new URLSearchParams({
    expected_offer_revision: String(action.expectedOfferRevision),
    definition: JSON.stringify({
      menuEntryId: action.menuEntryId,
      itemName: action.itemName,
      before: action.before,
      after: action.after,
    }),
  });
  return `/menu-prices/${encodeURIComponent(action.offerId)}?${params.toString()}`;
}

/** Null when the path names no menu price change. */
export function parseMenuPriceActionPath(
  verb: string,
  url: URL,
): Result<ChangeMenuPriceAction, ParseError> | null {
  const match = /^\/menu-prices\/([^/]+)$/u.exec(url.pathname);
  if (match === null) return null;
  if (verb !== MENU_PRICE_CHANGE_VERB) return invalid("path");
  let definition: unknown;
  try {
    definition = JSON.parse(url.searchParams.get("definition") ?? "");
  } catch {
    return invalid("path");
  }
  if (!isRecord(definition)) return invalid("path");
  let offerId: string;
  try {
    offerId = decodeURIComponent(match[1] ?? "");
  } catch {
    return invalid("path");
  }
  return parseChangeMenuPriceRequest({
    ...definition,
    kind: "change_menu_price",
    offerId,
    expectedOfferRevision: Number(
      url.searchParams.get("expected_offer_revision"),
    ),
  });
}

/** Whether the change sets a deal, ends one, or changes only the price. */
export function menuPriceChangeKind(
  action: Pick<ChangeMenuPriceAction, "before" | "after">,
): "deal" | "end_deal" | "price" {
  if (action.after.compareAtPrice !== null) return "deal";
  if (action.before.compareAtPrice !== null) return "end_deal";
  return "price";
}
