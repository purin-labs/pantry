import type {
  CommerceBuyerCatalogV1,
  CommerceBuyerCheckoutIdentityV1,
  CommerceCheckoutBuyerAuthorityV1,
  CommerceMutationErrorV1,
} from "@seams/commerce-client";
import type {
  Cart,
  Checkout,
  CheckoutFulfillmentQuoteSnapshot,
  Storefront,
} from "@seams/commerce-contracts";
import { protectBuyerContact } from "../../buyer-contact.ts";
import type { CheckoutTaxHealthBinding } from "../../regional-shipping.ts";
import type {
  BuyerPickupCheckoutCommand,
  BuyerShippingCheckoutCommand,
} from "../checkout-planning.ts";
import { sha256 } from "../checkout-shared.ts";
import { assertNever } from "@seams/std";
import { buyerCartMatchesClaims } from "./carts.ts";
import { retainedBuyerContactAuthority } from "./placements.ts";
import type {
  BuyerCheckoutProfileClaims,
  BuyerShippingCheckoutCreation,
  ResolvedRefreshBuyerPickupCheckoutV1,
  ResolvedRefreshBuyerShippingCheckoutV1,
} from "./types.ts";

export function buyerCheckoutCartReferenceError(
  cart: Cart | undefined,
  claims: BuyerCheckoutProfileClaims,
  cartId: string,
  cartRevision: number,
  checkoutId: string,
): CommerceMutationErrorV1 | undefined {
  if (cart === undefined || !buyerCartMatchesClaims(cart, claims)) {
    return buyerCheckoutCartMissing(cartId);
  }
  if (
    cart.revision === cartRevision ||
    (cart.revision === cartRevision + 1 &&
      cart.lifecycle.state === "submitted" &&
      cart.lifecycle.checkoutId === checkoutId)
  ) {
    return undefined;
  }
  return {
    code: "stale_resource_revision",
    kind: "cart",
    id: cart.cartId,
    expected: cartRevision,
    actual: cart.revision,
  };
}

export function buyerShippingTaxHealthBinding(
  storefront: Storefront,
): CheckoutTaxHealthBinding {
  switch (storefront.checkout.tax.kind) {
    case "percentage":
      return { kind: "merchant_percentage" };
    case "provider_quoted":
      return {
        kind: "provider_quoted",
        capabilityReference: storefront.checkout.tax.providerAccountReference,
      };
    default:
      return assertNever(
        storefront.checkout.tax,
        "Unsupported buyer checkout state",
      );
  }
}

export function buyerShippingServiceIsAvailable(
  catalog: CommerceBuyerCatalogV1 | undefined,
  destinationCountry: string,
  serviceCode: string,
): boolean {
  if (catalog?.storefront.fulfillment !== "shipping") return false;
  const matches = catalog.storefront.shippingServices.filter(
    (service) =>
      service.destinationCountry === destinationCountry &&
      service.service.code === serviceCode &&
      service.availability.state === "available",
  );
  return matches.length === 1;
}

export function buyerShippingCapabilityUnavailable(): BuyerShippingCheckoutCreation {
  return {
    kind: "rejected",
    error: {
      code: "resource_relationship_invalid",
      field: "buyerCheckout.shippingServiceAvailability",
    },
  };
}

export function buyerCheckoutIdentityDigest(
  claims: BuyerCheckoutProfileClaims,
  idempotencyKey: string,
): string {
  return sha256(
    JSON.stringify([
      claims.merchantId,
      claims.storefrontId,
      claims.sessionId,
      idempotencyKey,
    ]),
  );
}

export function buyerCheckoutRefreshIdentityDigest(
  checkoutId: string,
  sessionId: string,
  idempotencyKey: string,
): string {
  return sha256(JSON.stringify([checkoutId, sessionId, idempotencyKey]));
}

export function buyerPickupCheckoutRefreshRequestDigest(
  command: ResolvedRefreshBuyerPickupCheckoutV1,
): string {
  return sha256(
    JSON.stringify([
      command.schemaVersion,
      command.checkoutRevision,
      command.quoteDigest,
      command.lines,
    ]),
  );
}

export function buyerShippingCheckoutRefreshRequestDigest(
  command: ResolvedRefreshBuyerShippingCheckoutV1,
): string {
  return sha256(
    JSON.stringify([
      command.schemaVersion,
      command.checkoutRevision,
      command.quoteDigest,
      command.lines,
      command.shippingServiceCode,
      command.shippingDestination,
    ]),
  );
}

export function refreshCheckoutLineId(
  operationDigest: string,
  requestDigest: string,
  index: number,
): string {
  return `checkout_line_${operationDigest}_${requestDigest}_${index + 1}`;
}

export function buyerCheckoutRefreshIdempotencyConflict(
  idempotencyKey: string,
): Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
  return {
    kind: "rejected",
    error: { code: "idempotency_conflict", idempotencyKey },
  };
}

export function buyerShippingDestinationMatchesQuote(
  command: ResolvedRefreshBuyerShippingCheckoutV1,
  fulfillment: CheckoutFulfillmentQuoteSnapshot,
): boolean {
  if (fulfillment.kind !== "shipping") return false;
  const addressDigest = sha256(
    JSON.stringify(command.shippingDestination.address),
  );
  const protectedAddressReference =
    command.shippingDestination.kind === "saved_address"
      ? command.shippingDestination.savedAddressReference
      : `protected_address_${addressDigest}`;
  return (
    fulfillment.quote.carrierRate.service.code ===
      command.shippingServiceCode &&
    fulfillment.quote.address.destinationCountry ===
      command.shippingDestination.address.countryCode &&
    fulfillment.quote.address.addressValidationReference ===
      command.shippingDestination.addressValidationReference &&
    fulfillment.quote.address.protectedAddressReference ===
      protectedAddressReference &&
    fulfillment.quote.address.addressDigest === addressDigest
  );
}

export function buyerCheckoutCartMissing(
  cartId: string,
): CommerceMutationErrorV1 {
  return { code: "resource_not_found", kind: "cart", id: cartId };
}

export function pickupCheckoutLinesFromCart(
  cart: Cart,
  checkoutIdentity: string,
): BuyerPickupCheckoutCommand["lines"] {
  const lines: BuyerPickupCheckoutCommand["lines"][number][] = [];
  for (const [index, line] of cart.lines.entries()) {
    const checkoutLineId = buyerCheckoutLineId(checkoutIdentity, index);
    switch (line.source.kind) {
      case "catalog":
        lines.push({
          cartLineId: line.cartLineId,
          checkoutLineId,
          source: { kind: "catalog", variantId: line.source.variantId },
          quantity: line.quantity,
        });
        break;
      case "food_service":
        lines.push({
          cartLineId: line.cartLineId,
          checkoutLineId,
          source: {
            kind: "menu",
            menuId: line.source.menuId,
            menuEntryId: line.source.menuEntryId,
            modifierOptionIds: [...line.source.modifierOptionIds],
          },
          quantity: line.quantity,
        });
        break;
      default:
        return assertNever(line.source, "Unsupported buyer checkout state");
    }
  }
  return lines;
}

export function shippingCheckoutLinesFromCart(
  cart: Cart,
  checkoutIdentity: string,
): BuyerShippingCheckoutCommand["lines"] {
  const lines: BuyerShippingCheckoutCommand["lines"][number][] = [];
  for (const [index, line] of cart.lines.entries()) {
    if (
      line.source.kind !== "catalog" ||
      line.quantity.scale !== 0 ||
      line.quantity.unit !== "each"
    ) {
      throw new Error("Shipping Cart contains an unsupported line");
    }
    lines.push({
      cartLineId: line.cartLineId,
      checkoutLineId: buyerCheckoutLineId(checkoutIdentity, index),
      variantId: line.source.variantId,
      quantity: line.quantity.amount,
    });
  }
  return lines;
}

export function buyerCheckoutLineId(
  checkoutIdentity: string,
  index: number,
): string {
  return `checkout_line_${checkoutIdentity}_${String(index + 1).padStart(4, "0")}`;
}

export function createCheckoutBuyerAuthority(
  claims: BuyerCheckoutProfileClaims,
  buyer: CommerceBuyerCheckoutIdentityV1,
): CommerceCheckoutBuyerAuthorityV1 | undefined {
  switch (claims.buyer.kind) {
    case "guest":
      if (buyer.kind !== "guest") return undefined;
      return {
        kind: "guest",
        contactAuthority: {
          kind: "provided",
          contact: protectBuyerContact({
            merchantId: claims.merchantId,
            sessionId: claims.sessionId,
            contact: buyer.contact,
          }),
        },
      };
    case "identified_customer":
      if (buyer.kind !== "identified_customer") return undefined;
      return {
        kind: "identified_customer",
        customerReference: claims.buyer.protectedCustomerReference,
        contact: claims.buyer.contact,
      };
    default:
      return assertNever(claims.buyer, "Unsupported buyer checkout state");
  }
}

export function refreshCheckoutBuyerAuthority(
  claims: BuyerCheckoutProfileClaims,
  checkout: Checkout,
): CommerceCheckoutBuyerAuthorityV1 {
  switch (claims.buyer.kind) {
    case "guest":
      return {
        kind: "guest",
        contactAuthority: retainedBuyerContactAuthority(checkout),
      };
    case "identified_customer":
      return {
        kind: "identified_customer",
        customerReference: claims.buyer.protectedCustomerReference,
        contact: claims.buyer.contact,
      };
    default:
      return assertNever(claims.buyer, "Unsupported buyer checkout state");
  }
}
