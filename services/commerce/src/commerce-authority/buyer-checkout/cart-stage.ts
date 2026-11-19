import {
  type CreateCommerceBuyerCartV1,
  type ReplaceCommerceBuyerCartV1,
  type CommerceBuyerCatalogV1,
  type CommerceBuyerCartLineV1,
  type CommerceBuyerCartV1,
  type CommerceMutationErrorV1,
  parseCart,
} from "@purin-labs/commerce-client";
import { type Cart } from "@purin-labs/commerce-contracts";
import { buyerSessionDigest } from "../../buyer-session.ts";
import {
  readBuyerCartCommandReceipt,
  readCart,
} from "../../checkout-persistence.ts";
import { resolveCheckoutProfileForCart } from "../../checkout-profile-resolution.ts";
import { sha256 } from "../checkout-shared.ts";
import {
  buyerCartIdempotencyRejected,
  buyerCartMatchesClaims,
  buyerCartRequestDigest,
  cartLineQuantity,
  commitBuyerCartMutation,
  invalidBuyerCartField,
  toBuyerCart,
  toCartLines,
} from "./carts.ts";
import { requireIdentity } from "../command-guards.ts";
import type { BuyerCartMutation, BuyerCheckoutProfileClaims } from "./types.ts";
import { BuyerStorefrontStage } from "./storefront-stage.ts";

/**
 * Stage 2 of a buyer checkout: the cart.
 */
export abstract class BuyerCartStage extends BuyerStorefrontStage {
  createBuyerCart(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      command: CreateCommerceBuyerCartV1;
    }>,
  ): BuyerCartMutation {
    const sessionDigest = buyerSessionDigest(input.claims.sessionId);
    const requestDigest = buyerCartRequestDigest(
      "create",
      input.claims,
      input.command,
    );
    const replay = readBuyerCartCommandReceipt(
      this.options.database,
      input.claims.merchantId,
      sessionDigest,
      input.command.idempotencyKey,
    );
    if (replay !== undefined) {
      const cart = this.toBuyerCartForClaims(replay.cart, input.claims);
      return replay.operationKind === "create" &&
        replay.requestDigest === requestDigest &&
        cart !== undefined
        ? { kind: "resolved", cart }
        : buyerCartIdempotencyRejected(input.command.idempotencyKey);
    }
    const prepared = this.prepareBuyerCart(input.claims, input.command.lines);
    if (prepared.kind === "rejected") return prepared;
    const cartIdentity = sha256(
      JSON.stringify([
        input.claims.merchantId,
        input.claims.storefrontId,
        input.claims.sessionId,
        input.command.idempotencyKey,
      ]),
    );
    const cartId = `cart_${cartIdentity}`;
    if (
      readCart(this.options.database, input.claims.merchantId, cartId) !==
      undefined
    ) {
      return buyerCartIdempotencyRejected(input.command.idempotencyKey);
    }
    const committedAt = this.options.now();
    const cart = parseCart({
      cartId,
      storefrontId: input.claims.storefrontId,
      checkoutProfile: input.claims.checkoutProfile,
      buyerSessionDigest: sessionDigest,
      revision: 1,
      lines: toCartLines(input.command.lines, cartIdentity, prepared.catalog),
      lifecycle: { state: "active", updatedAt: committedAt },
    });
    this.options.database.transaction(
      commitBuyerCartMutation.bind(
        undefined,
        this.options.database,
        input.claims.merchantId,
        sessionDigest,
        input.command.idempotencyKey,
        "create",
        requestDigest,
        cart,
        committedAt,
      ),
    );
    return { kind: "resolved", cart: toBuyerCart(cart, prepared.fulfillment) };
  }

  readBuyerCart(
    claims: BuyerCheckoutProfileClaims,
    cartId: string,
  ): CommerceBuyerCartV1 | undefined {
    const cart = readCart(
      this.options.database,
      claims.merchantId,
      requireIdentity(cartId, "cartId"),
    );
    return cart === undefined
      ? undefined
      : this.toBuyerCartForClaims(cart, claims);
  }

  replaceBuyerCart(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      cartId: string;
      command: ReplaceCommerceBuyerCartV1;
    }>,
  ): BuyerCartMutation {
    const sessionDigest = buyerSessionDigest(input.claims.sessionId);
    const requestDigest = buyerCartRequestDigest("replace", input.claims, {
      ...input.command,
      cartId: input.cartId,
    });
    const replay = readBuyerCartCommandReceipt(
      this.options.database,
      input.claims.merchantId,
      sessionDigest,
      input.command.idempotencyKey,
    );
    if (replay !== undefined) {
      const cart = this.toBuyerCartForClaims(replay.cart, input.claims);
      return replay.operationKind === "replace" &&
        replay.requestDigest === requestDigest &&
        cart !== undefined
        ? { kind: "resolved", cart }
        : buyerCartIdempotencyRejected(input.command.idempotencyKey);
    }
    const current = readCart(
      this.options.database,
      input.claims.merchantId,
      requireIdentity(input.cartId, "cartId"),
    );
    if (
      current === undefined ||
      !buyerCartMatchesClaims(current, input.claims)
    ) {
      return {
        kind: "rejected",
        error: { code: "resource_not_found", kind: "cart", id: input.cartId },
      };
    }
    if (current.lifecycle.state !== "active") {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "cart.lifecycle",
        },
      };
    }
    if (current.revision !== input.command.cartRevision) {
      return {
        kind: "rejected",
        error: {
          code: "stale_resource_revision",
          kind: "cart",
          id: current.cartId,
          expected: input.command.cartRevision,
          actual: current.revision,
        },
      };
    }
    const prepared = this.prepareBuyerCart(input.claims, input.command.lines);
    if (prepared.kind === "rejected") return prepared;
    const committedAt = this.options.now();
    const cart = parseCart({
      cartId: current.cartId,
      storefrontId: current.storefrontId,
      checkoutProfile: current.checkoutProfile,
      buyerSessionDigest: current.buyerSessionDigest,
      revision: current.revision + 1,
      lines: toCartLines(input.command.lines, requestDigest, prepared.catalog),
      lifecycle: { state: "active", updatedAt: committedAt },
    });
    this.options.database.transaction(
      commitBuyerCartMutation.bind(
        undefined,
        this.options.database,
        input.claims.merchantId,
        sessionDigest,
        input.command.idempotencyKey,
        "replace",
        requestDigest,
        cart,
        committedAt,
      ),
    );
    return { kind: "resolved", cart: toBuyerCart(cart, prepared.fulfillment) };
  }

  protected prepareBuyerCart(
    claims: BuyerCheckoutProfileClaims,
    lines: readonly CommerceBuyerCartLineV1[],
  ):
    | Readonly<{
        kind: "ready";
        fulfillment: "pickup" | "shipping";
        catalog: CommerceBuyerCatalogV1;
      }>
    | Readonly<{
        kind: "rejected";
        error: CommerceMutationErrorV1;
      }> {
    const context = this.readBuyerStorefrontContext(
      claims.merchantId,
      claims.storefrontId,
    );
    if (
      context === undefined ||
      context.storefront.revision !== claims.storefrontRevision
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "cart.storefront",
        },
      };
    }
    const profile = resolveCheckoutProfileForCart({
      database: this.options.database,
      merchantId: claims.merchantId,
      reference: claims.checkoutProfile,
      storefront: context.storefront,
      lineQuantities: lines.map(cartLineQuantity),
    });
    if (profile.kind === "rejected") return profile;
    const catalog = this.readBuyerCatalog(
      claims.merchantId,
      claims.storefrontId,
    );
    if (catalog === undefined) {
      return {
        kind: "rejected",
        error: { code: "resource_relationship_invalid", field: "cart.catalog" },
      };
    }
    const invalidField = invalidBuyerCartField(catalog, lines);
    return invalidField === undefined
      ? {
          kind: "ready",
          fulfillment: context.storefront.fulfillment.kind,
          catalog,
        }
      : {
          kind: "rejected",
          error: { code: "resource_relationship_invalid", field: invalidField },
        };
  }

  protected toBuyerCartForClaims(
    cart: Cart,
    claims: BuyerCheckoutProfileClaims,
  ): CommerceBuyerCartV1 | undefined {
    if (!buyerCartMatchesClaims(cart, claims)) return undefined;
    const context = this.readBuyerStorefrontContext(
      claims.merchantId,
      claims.storefrontId,
    );
    return context === undefined ||
      context.storefront.revision !== claims.storefrontRevision
      ? undefined
      : toBuyerCart(cart, context.storefront.fulfillment.kind);
  }
}
