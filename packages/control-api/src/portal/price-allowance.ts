import { isNonEmptyString, isPositiveInteger, isRecord } from "@purin-labs/std";

/**
 * One listed Offer, as the priced-offers route reports it.
 *
 * The Portal cannot reach an Offer through the commerce graph — there is no
 * product-to-offer relationship and an Offer entity carries no price — so the
 * allowance surface names Offers from this list rather than by traversal.
 */
export type PricedOffer = Readonly<{
  offerId: string;
  variantId: string;
  salesChannelId: string;
  revision: number;
  priceMinor: number;
  currency: string;
}>;

type OfferPriceAllowance =
  | Readonly<{ kind: "disabled"; revision: number }>
  | Readonly<{
      kind: "enabled";
      revision: number;
      referenceOfferRevision: number;
      referencePriceMinor: number;
      currency: string;
      maxMovementBps: number;
    }>;

export type OfferPriceAllowanceView = Readonly<{
  policy: OfferPriceAllowance;
  allowedRange: Readonly<{ minimumMinor: number; maximumMinor: number }> | null;
  currentPriceMinor: number;
  currentOfferRevision: number;
  currency: string;
}>;

export function parsePricedOffers(value: unknown): readonly PricedOffer[] {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.offers)) {
    throw new Error("Priced offers response is invalid.");
  }
  return value.offers.map((entry): PricedOffer => {
    if (
      !isRecord(entry) ||
      !isNonEmptyString(entry.offerId) ||
      !isNonEmptyString(entry.variantId) ||
      !isNonEmptyString(entry.salesChannelId) ||
      !isPositiveInteger(entry.revision) ||
      !isPositiveInteger(entry.priceMinor) ||
      typeof entry.currency !== "string" ||
      !/^[A-Z]{3}$/u.test(entry.currency)
    ) {
      throw new Error("Priced offers response is invalid.");
    }
    return {
      offerId: entry.offerId,
      variantId: entry.variantId,
      salesChannelId: entry.salesChannelId,
      revision: entry.revision,
      priceMinor: entry.priceMinor,
      currency: entry.currency,
    };
  });
}

export function parseOfferPriceAllowanceView(
  value: unknown,
): OfferPriceAllowanceView {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.pricePolicy)) {
    throw new Error("Offer price allowance response is invalid.");
  }
  const view = value.pricePolicy;
  if (
    !isRecord(view.policy) ||
    !isPositiveInteger(view.currentPriceMinor) ||
    !isPositiveInteger(view.currentOfferRevision) ||
    typeof view.currency !== "string"
  ) {
    throw new Error("Offer price allowance response is invalid.");
  }
  return {
    policy: parseAllowance(view.policy),
    allowedRange: parseAllowedRange(view.allowedRange),
    currentPriceMinor: view.currentPriceMinor,
    currentOfferRevision: view.currentOfferRevision,
    currency: view.currency,
  };
}

function parseAllowance(
  value: Readonly<Record<string, unknown>>,
): OfferPriceAllowance {
  if (value.kind === "disabled" && typeof value.revision === "number") {
    return { kind: "disabled", revision: value.revision };
  }
  if (
    value.kind === "enabled" &&
    isPositiveInteger(value.revision) &&
    isPositiveInteger(value.referenceOfferRevision) &&
    isPositiveInteger(value.referencePriceMinor) &&
    typeof value.currency === "string" &&
    isPositiveInteger(value.maxMovementBps)
  ) {
    return {
      kind: "enabled",
      revision: value.revision,
      referenceOfferRevision: value.referenceOfferRevision,
      referencePriceMinor: value.referencePriceMinor,
      currency: value.currency,
      maxMovementBps: value.maxMovementBps,
    };
  }
  throw new Error("Offer price allowance is invalid.");
}

function parseAllowedRange(
  value: unknown,
): Readonly<{ minimumMinor: number; maximumMinor: number }> | null {
  if (value === null || value === undefined) return null;
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.minimumMinor) ||
    !isPositiveInteger(value.maximumMinor)
  ) {
    throw new Error("Offer price allowance range is invalid.");
  }
  return { minimumMinor: value.minimumMinor, maximumMinor: value.maximumMinor };
}
