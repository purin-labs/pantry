import { createHash } from "node:crypto";

import {
  orderOriginCheckoutId,
  type CommerceProductV1,
  type CommerceVariantV1,
} from "@purin-labs/commerce-client";
import type {
  CommerceMutationErrorV1,
  CommerceOrderOriginV1,
} from "@purin-labs/commerce-client";
import type {
  CheckoutQuoteSnapshot,
  CheckoutProfileReference,
} from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";

export function checkCheckoutRevision(
  kind: string,
  id: string,
  expected: number,
  actual: number | undefined,
): CommerceMutationErrorV1 | undefined {
  if (actual === undefined) return { code: "resource_not_found", kind, id };
  return actual === expected
    ? undefined
    : { code: "stale_resource_revision", kind, id, expected, actual };
}

export function definedMutationError(
  value: CommerceMutationErrorV1 | undefined,
): value is CommerceMutationErrorV1 {
  return value !== undefined;
}

export function findResource<T extends Readonly<{ id: string }>>(
  resources: readonly T[],
  id: string,
): T | undefined {
  for (const resource of resources) {
    if (resource.id === id) return resource;
  }
  return undefined;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function checkoutQuoteDigest(
  input: Omit<CheckoutQuoteSnapshot, "quoteDigest">,
): string {
  return `quote_${sha256(
    JSON.stringify({
      checkoutRevision: input.checkoutRevision,
      lines: input.lines,
      totals: input.totals,
      fulfillment: input.fulfillment,
      quotedAt: input.quotedAt,
      expiresAt: input.expiresAt,
      // Older quotes have no market, so their digests do not change.
      ...(input.market === undefined ? {} : { market: input.market }),
      ...(input.storedValue === undefined
        ? {}
        : { storedValue: input.storedValue }),
      ...(input.pluginRuns === undefined
        ? {}
        : { pluginRuns: input.pluginRuns }),
    }),
  )}`;
}

/** What a payment provider must collect: the total less stored value. */
export function amountDue(
  quote: CheckoutQuoteSnapshot,
): Readonly<{ amountMinor: number; currency: string }> {
  return quote.storedValue?.due ?? quote.totals.total;
}

export function sameMoney(
  left: Readonly<{ amountMinor: number; currency: string }>,
  right: Readonly<{ amountMinor: number; currency: string }>,
): boolean {
  return (
    left.amountMinor === right.amountMinor && left.currency === right.currency
  );
}

export function checkoutOrderProfileMatches(
  origin: CommerceOrderOriginV1,
  /** Absent for a counter sale, which matches no online origin. */
  checkoutProfile: CheckoutProfileReference | undefined,
): origin is Variant<CommerceOrderOriginV1, "online"> &
  Readonly<{
    configuration: Readonly<{
      kind: "checkout_profile";
      checkoutProfile: CheckoutProfileReference;
    }>;
  }> {
  return (
    checkoutProfile !== undefined &&
    origin.kind === "online" &&
    origin.configuration.kind === "checkout_profile" &&
    origin.configuration.checkoutProfile.checkoutProfileId ===
      checkoutProfile.checkoutProfileId &&
    origin.configuration.checkoutProfile.revision === checkoutProfile.revision
  );
}

/**
 * Whether an Order's origin agrees with the Checkout it was placed from.
 *
 * An online Order pins its published checkout profile in the origin, so that is
 * what is compared. A counter Order has no storefront profile to pin — its
 * policy is the POS configuration revision the Checkout recorded — so the
 * binding that matters is the Checkout identity itself, which both branches
 * carry.
 */
export function checkoutOrderMatchesCheckout(
  origin: CommerceOrderOriginV1,
  checkoutId: string,
  /** Absent for a counter sale, which is priced by its own configuration. */
  checkoutProfile: CheckoutProfileReference | undefined,
): boolean {
  if (orderOriginCheckoutId(origin) !== checkoutId) return false;
  if (origin.kind === "point_of_sale") return true;
  // An online Order whose Checkout pins no profile is not a match: the two
  // describe different sales.
  return (
    checkoutProfile !== undefined &&
    checkoutOrderProfileMatches(origin, checkoutProfile)
  );
}

export function timestampAtOrBefore(left: string, right: string): boolean {
  return Date.parse(left) <= Date.parse(right);
}

export function timestampBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

export function timestampAfter(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

export function orderLineIdFor(
  orderId: string,
  checkoutLineId: string,
): string {
  return `order_line_${sha256(`${orderId}:${checkoutLineId}`)}`;
}

/** A storefront sells a variant only while it and its product are active. */
export function variantIsSellable(
  products: readonly CommerceProductV1[],
  variant: CommerceVariantV1,
): boolean {
  if (variant.status !== "active") return false;
  return (
    products.find((product) => product.id === variant.productId)?.status ===
    "active"
  );
}
