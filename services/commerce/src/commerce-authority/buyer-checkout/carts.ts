import type {
  CreateCommerceBuyerCartV1,
  ReplaceCommerceBuyerCartV1,
  CommerceBuyerCatalogV1,
  CommerceBuyerCartLineV1,
  CommerceBuyerCartV1,
} from "@purin-labs/commerce-client";
import type { Cart, Storefront } from "@purin-labs/commerce-contracts";
import type { CommerceDatabase } from "../../database.ts";
import { buyerSessionDigest } from "../../buyer-session.ts";
import {
  writeBuyerCartCommandReceipt,
  writeCart,
} from "../../checkout-persistence.ts";
import type {
  CheckoutProviderCapabilityHealthProvider,
  RegionalShipping,
} from "../../regional-shipping.ts";
import { readShippingProfile as readCatalogShippingProfile } from "../catalog.ts";
import { sha256 } from "../checkout-shared.ts";
import { assertNever } from "@purin-labs/std";
import { buyerShippingTaxHealthBinding } from "./quotes.ts";
import type { BuyerCartMutation, BuyerCheckoutProfileClaims } from "./types.ts";

export function buyerCartRequestDigest(
  operationKind: "create" | "replace",
  claims: BuyerCheckoutProfileClaims,
  command:
    | CreateCommerceBuyerCartV1
    | (ReplaceCommerceBuyerCartV1 & Readonly<{ cartId: string }>),
): string {
  return sha256(
    JSON.stringify({
      operationKind,
      merchantId: claims.merchantId,
      storefrontId: claims.storefrontId,
      buyerSessionDigest: buyerSessionDigest(claims.sessionId),
      checkoutProfile: claims.checkoutProfile,
      command,
    }),
  );
}

export function buyerCartIdempotencyRejected(
  idempotencyKey: string,
): BuyerCartMutation {
  return {
    kind: "rejected",
    error: { code: "idempotency_conflict", idempotencyKey },
  };
}

export function buyerCartMatchesClaims(
  cart: Cart,
  claims: BuyerCheckoutProfileClaims,
): boolean {
  return (
    cart.storefrontId === claims.storefrontId &&
    cart.buyerSessionDigest === buyerSessionDigest(claims.sessionId) &&
    cart.checkoutProfile.checkoutProfileId ===
      claims.checkoutProfile.checkoutProfileId &&
    cart.checkoutProfile.revision === claims.checkoutProfile.revision
  );
}

export function cartLineQuantity(line: CommerceBuyerCartLineV1): number {
  return line.quantity;
}

export function toCartLines(
  lines: readonly CommerceBuyerCartLineV1[],
  identity: string,
  catalog: CommerceBuyerCatalogV1,
): readonly Cart["lines"][number][] {
  const cartLines: Cart["lines"][number][] = [];
  for (const [index, line] of lines.entries()) {
    cartLines.push({
      cartLineId: `cart_line_${identity}_${String(index + 1).padStart(4, "0")}`,
      source: buyerCartLineSource(line, catalog),
      quantity: { amount: line.quantity, scale: 0, unit: "each" },
    });
  }
  return cartLines;
}

function buyerCartLineSource(
  line: CommerceBuyerCartLineV1,
  catalog: CommerceBuyerCatalogV1,
): Cart["lines"][number]["source"] {
  switch (line.kind) {
    case "catalog":
      return { kind: "catalog", variantId: line.variantId };
    case "menu": {
      const menu = catalog.menus.find(
        buyerMenuMatches.bind(undefined, line.menuId),
      );
      const entry = menu?.entries.find(
        buyerMenuEntryMatches.bind(undefined, line.menuEntryId),
      );
      if (entry === undefined)
        throw new Error("Validated buyer Cart menu entry disappeared");
      return {
        kind: "food_service",
        variantId: entry.variantId,
        menuId: line.menuId,
        menuEntryId: line.menuEntryId,
        modifierOptionIds: [...line.modifierOptionIds],
      };
    }
    default:
      return assertNever(line, "Unsupported buyer checkout state");
  }
}

export function invalidBuyerCartField(
  catalog: CommerceBuyerCatalogV1,
  lines: readonly CommerceBuyerCartLineV1[],
): string | undefined {
  const selections = new Set<string>();
  for (const line of lines) {
    const selection = JSON.stringify(
      line.kind === "catalog"
        ? { kind: line.kind, variantId: line.variantId }
        : {
            kind: line.kind,
            menuId: line.menuId,
            menuEntryId: line.menuEntryId,
            modifierOptionIds: [...line.modifierOptionIds].sort(),
          },
    );
    if (selections.has(selection)) return "cart.lines.duplicate";
    selections.add(selection);
    switch (line.kind) {
      case "catalog": {
        const listing = catalog.listings.find(
          buyerListingMatches.bind(undefined, line.variantId),
        );
        if (listing?.availability !== "available") return "cart.lines.catalog";
        break;
      }
      case "menu": {
        if (catalog.storefront.fulfillment !== "pickup")
          return "cart.lines.fulfillment";
        const menu = catalog.menus.find(
          buyerMenuMatches.bind(undefined, line.menuId),
        );
        const entry = menu?.entries.find(
          buyerMenuEntryMatches.bind(undefined, line.menuEntryId),
        );
        if (entry?.availability !== "available") return "cart.lines.menu";
        const optionGroups = new Map<string, string>();
        for (const group of entry.modifierGroups) {
          for (const option of group.options) {
            if (optionGroups.has(option.modifierOptionId))
              return "cart.lines.modifiers";
            optionGroups.set(option.modifierOptionId, group.modifierGroupId);
          }
        }
        for (const optionId of line.modifierOptionIds) {
          if (!optionGroups.has(optionId)) return "cart.lines.modifiers";
        }
        for (const group of entry.modifierGroups) {
          const count = line.modifierOptionIds.filter(
            optionSelectedFromGroup.bind(
              undefined,
              optionGroups,
              group.modifierGroupId,
            ),
          ).length;
          if (
            count < group.minimumSelections ||
            count > group.maximumSelections
          ) {
            return "cart.lines.modifierCardinality";
          }
        }
        break;
      }
      default:
        return assertNever(line, "Unsupported buyer checkout state");
    }
  }
  return undefined;
}

function optionSelectedFromGroup(
  optionGroups: ReadonlyMap<string, string>,
  groupId: string,
  optionId: string,
): boolean {
  return optionGroups.get(optionId) === groupId;
}

function buyerListingMatches(
  variantId: string,
  listing: CommerceBuyerCatalogV1["listings"][number],
): boolean {
  return listing.variantId === variantId;
}

function buyerMenuMatches(
  menuId: string,
  menu: CommerceBuyerCatalogV1["menus"][number],
): boolean {
  return menu.menuId === menuId;
}

function buyerMenuEntryMatches(
  menuEntryId: string,
  entry: CommerceBuyerCatalogV1["menus"][number]["entries"][number],
): boolean {
  return entry.menuEntryId === menuEntryId;
}

export function toBuyerCart(
  cart: Cart,
  fulfillment: "pickup" | "shipping",
): CommerceBuyerCartV1 {
  const base = {
    schemaVersion: "underclerk.buyer-cart.v1" as const,
    cartId: cart.cartId,
    revision: cart.revision,
    checkoutProfile: cart.checkoutProfile,
    fulfillment,
    lines: cart.lines.map(toBuyerCartLine),
  };
  switch (cart.lifecycle.state) {
    case "active":
      return { ...base, state: "active" };
    case "submitted":
      return {
        ...base,
        state: "submitted",
        checkoutId: cart.lifecycle.checkoutId,
      };
    default:
      return assertNever(cart.lifecycle, "Unsupported buyer checkout state");
  }
}

function toBuyerCartLine(line: Cart["lines"][number]): CommerceBuyerCartLineV1 {
  if (line.quantity.scale !== 0 || line.quantity.unit !== "each") {
    throw new Error("Stored buyer Cart quantity is invalid");
  }
  switch (line.source.kind) {
    case "catalog":
      return {
        kind: "catalog",
        variantId: line.source.variantId,
        quantity: line.quantity.amount,
      };
    case "food_service":
      return {
        kind: "menu",
        menuId: line.source.menuId,
        menuEntryId: line.source.menuEntryId,
        modifierOptionIds: [...line.source.modifierOptionIds],
        quantity: line.quantity.amount,
      };
    default:
      return assertNever(line.source, "Unsupported buyer checkout state");
  }
}

export function buyerCatalogStorefront(
  database: CommerceDatabase,
  merchantId: string,
  storefront: Storefront,
  shipping: RegionalShipping | undefined,
  healthProvider: CheckoutProviderCapabilityHealthProvider,
): CommerceBuyerCatalogV1["storefront"] | undefined {
  const common = {
    storefrontId: storefront.storefrontId,
    revision: storefront.revision,
    name: storefront.name,
  };
  switch (storefront.fulfillment.kind) {
    case "pickup":
      return { ...common, fulfillment: "pickup" };
    case "shipping": {
      const profile = readCatalogShippingProfile(
        database,
        merchantId,
        storefront.fulfillment.shippingProfileId,
      );
      if (
        profile?.lifecycle.state !== "active" ||
        profile.originLocationId !== storefront.fulfillment.originLocationId
      ) {
        return undefined;
      }
      const shippingServices = shipping?.publishedServices(profile.routes, {
        merchantId,
        taxCapability: buyerShippingTaxHealthBinding(storefront),
        healthProvider,
      });
      return shippingServices === undefined || shippingServices.length === 0
        ? undefined
        : { ...common, fulfillment: "shipping", shippingServices };
    }
  }
}

export function commitBuyerCartMutation(
  database: CommerceDatabase,
  merchantId: string,
  sessionDigest: string,
  idempotencyKey: string,
  operationKind: "create" | "replace",
  requestDigest: string,
  cart: Cart,
  committedAt: string,
): void {
  writeCart(database, merchantId, cart);
  writeBuyerCartCommandReceipt(database, {
    merchantId,
    buyerSessionDigest: sessionDigest,
    idempotencyKey,
    operationKind,
    requestDigest,
    cart,
    createdAt: committedAt,
  });
}
