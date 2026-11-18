import { isRecord } from "@seams/std";

/** The price of a menu item on one side of a change, as the boards show it. */
export type MenuPriceSideDetails = Readonly<{
  price: Readonly<{ amountMinor: number; currency: string }>;
  compareAtPrice: Readonly<{ amountMinor: number; currency: string }> | null;
}>;

/** A price or deal change of one café menu item (Plan 40B phase 4). */
export type MenuPriceDetails = Readonly<{
  kind: "change_menu_price";
  offerId: string;
  expectedOfferRevision: number;
  menuEntryId: string;
  itemName: string;
  before: MenuPriceSideDetails;
  after: MenuPriceSideDetails;
}>;

function parseMoney(
  value: unknown,
): Readonly<{ amountMinor: number; currency: string }> | null {
  if (
    !isRecord(value) ||
    typeof value.amountMinor !== "number" ||
    !Number.isSafeInteger(value.amountMinor) ||
    value.amountMinor < 1 ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/u.test(value.currency)
  )
    return null;
  return { amountMinor: value.amountMinor, currency: value.currency };
}

function parseSide(value: unknown): MenuPriceSideDetails {
  if (!isRecord(value)) throw new Error("Menu price details are invalid.");
  const price = parseMoney(value.price);
  const compareAtPrice =
    value.compareAtPrice === null ? null : parseMoney(value.compareAtPrice);
  if (
    price === null ||
    (value.compareAtPrice !== null && compareAtPrice === null)
  )
    throw new Error("Menu price details are invalid.");
  return { price, compareAtPrice };
}

export function parseMenuPriceDetails(
  raw: Record<string, unknown>,
): MenuPriceDetails {
  if (
    typeof raw.offerId !== "string" ||
    raw.offerId.length === 0 ||
    typeof raw.expectedOfferRevision !== "number" ||
    !Number.isSafeInteger(raw.expectedOfferRevision) ||
    raw.expectedOfferRevision < 1 ||
    typeof raw.menuEntryId !== "string" ||
    typeof raw.itemName !== "string" ||
    raw.itemName.length === 0
  )
    throw new Error("Menu price details are invalid.");
  return {
    kind: "change_menu_price",
    offerId: raw.offerId,
    expectedOfferRevision: raw.expectedOfferRevision,
    menuEntryId: raw.menuEntryId,
    itemName: raw.itemName,
    before: parseSide(raw.before),
    after: parseSide(raw.after),
  };
}
