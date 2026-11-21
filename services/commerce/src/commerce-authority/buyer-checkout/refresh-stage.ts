import {
  parseInventoryAllocation,
  requireCheckoutProfile,
  type CreateCommercePickupCheckoutV1,
  type CommerceResourcesV1,
  type CommerceInventoryPositionV1,
  type CommerceMutationErrorV1,
  checkoutOnlineSource,
} from "@purin-labs/commerce-client";
import {
  commerceTransition,
  type Cart,
  type Checkout,
  type InventoryAllocation,
  type Storefront,
} from "@purin-labs/commerce-contracts";
import { buyerSessionDigest } from "../../buyer-session.ts";
import {
  readCart,
  readCheckout,
  readStorefront,
} from "../../checkout-persistence.ts";
import {
  planPickupCheckout,
  planShippingCheckout,
  refreshOperationLineIdMatches,
  refreshRequestLineIdMatches,
  sameBuyerCheckoutLines,
  sameBuyerShippingCheckoutLines,
  type BuyerPickupCheckoutCommand,
  type BuyerShippingCheckoutCommand,
  type CheckoutPlanContext,
  type PickupCheckoutPlan,
} from "../checkout-planning.ts";
import { planCheckoutAllocationRelease } from "../checkout-payment-planning.ts";
import { heldCodeDiscounts } from "../../plugins/discounts/index.ts";
import { heldStoredValueAccounts } from "../../plugins/stored-value/index.ts";
import {
  buyerCheckoutRefreshIdempotencyConflict,
  buyerCheckoutRefreshIdentityDigest,
  buyerPickupCheckoutRefreshRequestDigest,
  buyerShippingCapabilityUnavailable,
  buyerShippingCheckoutRefreshRequestDigest,
  buyerShippingDestinationMatchesQuote,
  buyerShippingServiceIsAvailable,
  refreshCheckoutBuyerAuthority,
  refreshCheckoutLineId,
} from "./quotes.ts";
import type {
  BuyerCheckoutCreation,
  BuyerCheckoutProfileClaims,
  BuyerMerchantRow,
  BuyerShippingCheckoutCreation,
  ResolvedRefreshBuyerPickupCheckoutV1,
  ResolvedRefreshBuyerShippingCheckoutV1,
} from "./types.ts";
import { BuyerCheckoutCreationStage } from "./checkout-stage.ts";

/**
 * Stage 5 of a buyer checkout: a refresh of a quote with new lines or a new destination.
 */
export abstract class BuyerCheckoutRefreshStage extends BuyerCheckoutCreationStage {
  refreshBuyerPickupCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: ResolvedRefreshBuyerPickupCheckoutV1;
    }>,
  ): BuyerCheckoutCreation {
    const identityDigest = buyerCheckoutRefreshIdentityDigest(
      input.checkoutId,
      input.claims.sessionId,
      input.command.idempotencyKey,
    );
    const requestDigest = buyerPickupCheckoutRefreshRequestDigest(
      input.command,
    );
    const replay = this.readBuyerPickupRefreshReplay(
      input,
      identityDigest,
      requestDigest,
    );
    if (replay !== undefined) return replay;
    const prepared = this.prepareBuyerCheckoutRefresh(input, "pickup");
    if (prepared.kind === "rejected") return prepared;
    // A refresh prices lines from the catalog, which would drop staff prices.
    // The buyer opens the draft invoice again instead.
    if (
      prepared.checkout.lifecycle.state === "quoted" &&
      prepared.checkout.lifecycle.quote.lines.some(
        (line) => line.priceOverride !== undefined,
      )
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "checkout.draftOrder",
        },
      };
    }
    // The refreshed quote keeps the buyer's market and the codes it holds.
    const held = heldCodeDiscounts(
      this.options.database,
      input.claims.merchantId,
      prepared.checkout.checkoutId,
    );
    const marketId = prepared.checkout.lifecycle.quote.market?.marketId;
    const keptAccountIds = heldStoredValueAccounts(
      this.options.database,
      input.claims.merchantId,
      prepared.checkout.checkoutId,
    );
    // It keeps the pickup time that the buyer chose; the planner checks it
    // again.
    const pickupAt = this.options.database
      .prepare(
        `SELECT pickup_at AS pickupAt FROM checkout_pickup_choice
         WHERE merchant_id = ? AND checkout_id = ?`,
      )
      .get<Readonly<{ pickupAt: string }>>(
        input.claims.merchantId,
        prepared.checkout.checkoutId,
      )?.pickupAt;
    const command: CreateCommercePickupCheckoutV1 &
      Pick<
        BuyerPickupCheckoutCommand,
        "discount" | "marketId" | "storedValue" | "pickupAt"
      > = {
      schemaVersion: "commerce.create-pickup-checkout.v1",
      merchantId: input.claims.merchantId,
      expectedMerchantRevision: prepared.merchant.revision,
      discount: {
        codes: [],
        customerId:
          input.claims.buyer.kind === "identified_customer"
            ? input.claims.buyer.protectedCustomerReference
            : held.customerId,
        keptDiscountIds: held.discountIds,
      },
      ...(marketId === undefined ? {} : { marketId }),
      ...(keptAccountIds.length === 0
        ? {}
        : {
            storedValue: {
              giftCardCodes: [],
              customerId:
                input.claims.buyer.kind === "identified_customer"
                  ? input.claims.buyer.protectedCustomerReference
                  : held.customerId,
              storeCredit: false,
              keptAccountIds,
            },
          }),
      ...(pickupAt === undefined ? {} : { pickupAt }),
      idempotencyKey: `buyer_checkout_refresh_${identityDigest}`,
      requestedAt: this.options.now(),
      storefrontId: input.claims.storefrontId,
      storefrontRevision: input.claims.storefrontRevision,
      checkoutProfile: input.claims.checkoutProfile,
      buyerSessionDigest: buyerSessionDigest(input.claims.sessionId),
      buyerAuthority: refreshCheckoutBuyerAuthority(
        input.claims,
        prepared.checkout,
      ),
      cartId: prepared.cart.cartId,
      checkoutId: prepared.checkout.checkoutId,
      lines: input.command.lines.map((line, index) => ({
        cartLineId: `cart_line_${identityDigest}_${index + 1}`,
        checkoutLineId: refreshCheckoutLineId(
          identityDigest,
          requestDigest,
          index,
        ),
        source:
          line.kind === "catalog"
            ? { kind: "catalog" as const, variantId: line.variantId }
            : {
                kind: "menu" as const,
                menuId: line.menuId,
                menuEntryId: line.menuEntryId,
                modifierOptionIds: [...line.modifierOptionIds],
              },
        quantity: { amount: line.quantity, scale: 0, unit: "each" as const },
      })),
    };
    const plan = planPickupCheckout(
      this.options.database,
      command,
      prepared.storefront,
      prepared.resources,
      this.options.readFoodServiceResources(command.merchantId),
      this.options.foodService?.menus,
      prepared.context,
    );
    if (plan.kind === "rejected") return plan;
    const result = this.options.commitPickupCheckout(
      command,
      prepared.merchant,
      refreshedHolds(prepared.releasedAllocations, plan.value),
    );
    if (result.outcome === "rejected")
      return { kind: "rejected", error: result.error };
    const checkout = this.readBuyerQuotedCheckout(
      command.merchantId,
      command.checkoutId,
      input.claims.sessionId,
    );
    return checkout === undefined
      ? {
          kind: "rejected",
          error: {
            code: "resource_relationship_invalid",
            field: "buyerCheckout.refresh",
          },
        }
      : { kind: "created", checkout };
  }

  refreshBuyerShippingCheckout(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: ResolvedRefreshBuyerShippingCheckoutV1;
    }>,
  ): BuyerShippingCheckoutCreation {
    const identityDigest = buyerCheckoutRefreshIdentityDigest(
      input.checkoutId,
      input.claims.sessionId,
      input.command.idempotencyKey,
    );
    const requestDigest = buyerShippingCheckoutRefreshRequestDigest(
      input.command,
    );
    const replay = this.readBuyerShippingRefreshReplay(
      input,
      identityDigest,
      requestDigest,
    );
    if (replay !== undefined) return replay;
    const prepared = this.prepareBuyerCheckoutRefresh(input, "shipping");
    if (prepared.kind === "rejected") return prepared;
    if (
      !buyerShippingServiceIsAvailable(
        this.readBuyerCatalog(
          input.claims.merchantId,
          input.claims.storefrontId,
        ),
        input.command.shippingDestination.address.countryCode,
        input.command.shippingServiceCode,
      )
    ) {
      return buyerShippingCapabilityUnavailable();
    }
    // The refreshed quote keeps the buyer's market and the codes and
    // accounts that it holds.
    const marketId = prepared.checkout.lifecycle.quote.market?.marketId;
    const held = heldCodeDiscounts(
      this.options.database,
      input.claims.merchantId,
      prepared.checkout.checkoutId,
    );
    const keptAccountIds = heldStoredValueAccounts(
      this.options.database,
      input.claims.merchantId,
      prepared.checkout.checkoutId,
    );
    const customerId =
      input.claims.buyer.kind === "identified_customer"
        ? input.claims.buyer.protectedCustomerReference
        : held.customerId;
    const command: BuyerShippingCheckoutCommand = {
      schemaVersion: "commerce.create-buyer-shipping-checkout.internal.v1",
      merchantId: input.claims.merchantId,
      expectedMerchantRevision: prepared.merchant.revision,
      idempotencyKey: `buyer_shipping_checkout_refresh_${identityDigest}`,
      requestedAt: this.options.now(),
      storefrontId: input.claims.storefrontId,
      storefrontRevision: input.claims.storefrontRevision,
      checkoutProfile: input.claims.checkoutProfile,
      buyerSessionDigest: buyerSessionDigest(input.claims.sessionId),
      buyerAuthority: refreshCheckoutBuyerAuthority(
        input.claims,
        prepared.checkout,
      ),
      cartId: prepared.cart.cartId,
      cartRevision: prepared.cart.revision,
      checkoutId: prepared.checkout.checkoutId,
      lines: input.command.lines.map((line, index) => ({
        cartLineId: `cart_line_${identityDigest}_${index + 1}`,
        checkoutLineId: refreshCheckoutLineId(
          identityDigest,
          requestDigest,
          index,
        ),
        variantId: line.variantId,
        quantity: line.quantity,
      })),
      shippingServiceCode: input.command.shippingServiceCode,
      shippingDestination: input.command.shippingDestination,
      discount: { codes: [], customerId, keptDiscountIds: held.discountIds },
      ...(marketId === undefined ? {} : { marketId }),
      ...(keptAccountIds.length === 0
        ? {}
        : {
            storedValue: {
              giftCardCodes: [],
              customerId,
              storeCredit: false,
              keptAccountIds,
            },
          }),
    };
    const plan = planShippingCheckout(
      this.options.database,
      this.options.shipping(command.merchantId),
      command,
      prepared.storefront,
      prepared.resources,
      prepared.context,
    );
    if (plan.kind === "rejected") return plan;
    const result = this.options.commitShippingCheckout(
      command,
      prepared.merchant,
      refreshedHolds(prepared.releasedAllocations, plan.value),
    );
    if (result.outcome === "rejected")
      return { kind: "rejected", error: result.error };
    const checkout = this.readBuyerQuotedShippingCheckout(
      command.merchantId,
      command.checkoutId,
      input.claims.sessionId,
    );
    return checkout === undefined
      ? {
          kind: "rejected",
          error: {
            code: "resource_relationship_invalid",
            field: "buyerCheckout.refresh",
          },
        }
      : { kind: "created", checkout };
  }

  protected readBuyerPickupRefreshReplay(
    input: Readonly<{
      claims: Readonly<{ sessionId: string; merchantId: string }>;
      checkoutId: string;
      command: ResolvedRefreshBuyerPickupCheckoutV1;
    }>,
    operationDigest: string,
    requestDigest: string,
  ): BuyerCheckoutCreation | undefined {
    const stored = readCheckout(
      this.options.database,
      input.claims.merchantId,
      input.checkoutId,
    );
    if (
      stored?.lifecycle.state !== "quoted" ||
      !stored.lifecycle.quote.lines.every(
        refreshOperationLineIdMatches.bind(undefined, operationDigest),
      )
    ) {
      return undefined;
    }
    const checkout = this.readBuyerQuotedCheckout(
      input.claims.merchantId,
      input.checkoutId,
      input.claims.sessionId,
    );
    if (
      checkout === undefined ||
      stored.lifecycle.quote.lines.length !== input.command.lines.length ||
      !stored.lifecycle.quote.lines.every(
        refreshRequestLineIdMatches.bind(
          undefined,
          operationDigest,
          requestDigest,
        ),
      ) ||
      !sameBuyerCheckoutLines(checkout.quote.lines, input.command.lines)
    ) {
      return buyerCheckoutRefreshIdempotencyConflict(
        input.command.idempotencyKey,
      );
    }
    return { kind: "created", checkout };
  }

  protected readBuyerShippingRefreshReplay(
    input: Readonly<{
      claims: Readonly<{ sessionId: string; merchantId: string }>;
      checkoutId: string;
      command: ResolvedRefreshBuyerShippingCheckoutV1;
    }>,
    operationDigest: string,
    requestDigest: string,
  ): BuyerShippingCheckoutCreation | undefined {
    const stored = readCheckout(
      this.options.database,
      input.claims.merchantId,
      input.checkoutId,
    );
    if (
      stored?.lifecycle.state !== "quoted" ||
      !stored.lifecycle.quote.lines.every(
        refreshOperationLineIdMatches.bind(undefined, operationDigest),
      )
    ) {
      return undefined;
    }
    const checkout = this.readBuyerQuotedShippingCheckout(
      input.claims.merchantId,
      input.checkoutId,
      input.claims.sessionId,
    );
    if (
      checkout === undefined ||
      stored.lifecycle.quote.lines.length !== input.command.lines.length ||
      !stored.lifecycle.quote.lines.every(
        refreshRequestLineIdMatches.bind(
          undefined,
          operationDigest,
          requestDigest,
        ),
      ) ||
      !sameBuyerShippingCheckoutLines(
        checkout.quote.lines,
        input.command.lines,
      ) ||
      !buyerShippingDestinationMatchesQuote(
        input.command,
        stored.lifecycle.quote.fulfillment,
      )
    ) {
      return buyerCheckoutRefreshIdempotencyConflict(
        input.command.idempotencyKey,
      );
    }
    return { kind: "created", checkout };
  }

  protected prepareBuyerCheckoutRefresh(
    input: Readonly<{
      claims: BuyerCheckoutProfileClaims;
      checkoutId: string;
      command: Readonly<{
        checkoutRevision: number;
        quoteDigest: string;
        idempotencyKey: string;
      }>;
    }>,
    fulfillment: "pickup" | "shipping",
  ):
    | Readonly<{
        kind: "ready";
        merchant: BuyerMerchantRow;
        checkout: Checkout;
        cart: Cart;
        storefront: Storefront;
        resources: CommerceResourcesV1;
        releasedAllocations: readonly InventoryAllocation[];
        context: CheckoutPlanContext;
      }>
    | Readonly<{ kind: "rejected"; error: CommerceMutationErrorV1 }> {
    const merchant = this.options.readMerchant(input.claims.merchantId);
    const checkout = readCheckout(
      this.options.database,
      input.claims.merchantId,
      input.checkoutId,
    );
    // A buyer session only ever reaches an online checkout; a counter sale has
    // no cart and fails the guard below.
    const checkoutOnline =
      checkout === undefined ? undefined : checkoutOnlineSource(checkout);
    const cart =
      checkoutOnline === undefined
        ? undefined
        : readCart(
            this.options.database,
            input.claims.merchantId,
            checkoutOnline.cartId,
          );
    const storefront = readStorefront(
      this.options.database,
      input.claims.merchantId,
      input.claims.storefrontId,
    );
    const snapshot = this.options.readSnapshot(input.claims.merchantId);
    if (merchant === undefined) {
      return {
        kind: "rejected",
        error: {
          code: "merchant_not_found",
          merchantId: input.claims.merchantId,
        },
      };
    }
    if (
      storefront === undefined ||
      storefront.revision !== input.claims.storefrontRevision ||
      snapshot === undefined
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.storefrontRevision",
        },
      };
    }
    if (checkout !== undefined) {
      const refresh = commerceTransition(
        "checkout",
        checkout.lifecycle,
        "refresh",
      );
      if (!refresh.allowed) return { kind: "rejected", error: refresh.refusal };
    }
    if (
      checkout === undefined ||
      checkoutOnline === undefined ||
      cart === undefined ||
      checkoutOnline.buyerSessionDigest !==
        buyerSessionDigest(input.claims.sessionId) ||
      checkoutOnline.storefrontId !== input.claims.storefrontId ||
      requireCheckoutProfile(checkout).checkoutProfileId !==
        input.claims.checkoutProfile.checkoutProfileId ||
      requireCheckoutProfile(checkout).revision !==
        input.claims.checkoutProfile.revision ||
      checkout.revision !== input.command.checkoutRevision ||
      checkout.lifecycle.quote.checkoutRevision !==
        input.command.checkoutRevision ||
      checkout.lifecycle.quote.quoteDigest !== input.command.quoteDigest ||
      checkout.lifecycle.quote.fulfillment.kind !== fulfillment ||
      cart.buyerSessionDigest !== checkoutOnline.buyerSessionDigest ||
      cart.checkoutProfile.checkoutProfileId !==
        input.claims.checkoutProfile.checkoutProfileId ||
      cart.checkoutProfile.revision !== input.claims.checkoutProfile.revision ||
      cart.cartId !== checkoutOnline.cartId
    ) {
      return {
        kind: "rejected",
        error: {
          code: "resource_relationship_invalid",
          field: "buyerCheckout.refresh",
        },
      };
    }
    const release = planCheckoutAllocationRelease(
      this.options.database,
      input.claims.merchantId,
      checkout.checkoutId,
      checkout.lifecycle.quote,
      this.options.now(),
      "checkout_refreshed",
    );
    if (release.kind === "rejected") return release;
    const positions = new Map<string, CommerceInventoryPositionV1>();
    for (const position of release.positions)
      positions.set(position.inventoryItemId, position);
    return {
      kind: "ready",
      merchant,
      checkout,
      cart,
      storefront,
      resources: snapshot.resources,
      releasedAllocations: release.allocations,
      context: {
        checkoutRevision: checkout.revision + 1,
        cartRevision: cart.revision + 1,
        positions,
      },
    };
  }
}

/**
 * A refreshed quote keeps holding stock for the lines that it keeps: the
 * same hold moves to its next revision (the allocation machine's `refresh`).
 * The holds of the lines that it dropped are released.
 */
function refreshedHolds(
  released: readonly InventoryAllocation[],
  plan: PickupCheckoutPlan,
): PickupCheckoutPlan {
  const previous = new Map<string, InventoryAllocation>();
  for (const allocation of released)
    previous.set(allocation.allocationId, allocation);
  const allocations: InventoryAllocation[] = [];
  for (const allocation of plan.allocations) {
    const before = previous.get(allocation.allocationId);
    allocations.push(
      before === undefined
        ? allocation
        : parseInventoryAllocation({
            ...allocation,
            revision: before.revision,
          }),
    );
    previous.delete(allocation.allocationId);
  }
  return {
    ...plan,
    allocations,
    releasedAllocations: [...previous.values()],
  };
}
