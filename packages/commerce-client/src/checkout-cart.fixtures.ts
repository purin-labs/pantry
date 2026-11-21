import type {
  CreateCommerceBuyerPickupCheckoutV1,
  CommerceBuyerCartLineV1,
  CommerceBuyerCartV1,
} from "./index.ts";

const profile = {
  checkoutProfileId: "checkout_profile_fixture",
  revision: 1,
} as const;

const activeCart: CommerceBuyerCartV1 = {
  schemaVersion: "commerce.buyer-cart.v1",
  cartId: "cart_fixture",
  revision: 1,
  checkoutProfile: profile,
  fulfillment: "pickup",
  lines: [{ kind: "catalog", variantId: "variant_fixture", quantity: 1 }],
  state: "active",
};

// @ts-expect-error Submitted Carts require the Checkout they created.
const incompleteSubmittedCart: CommerceBuyerCartV1 = {
  schemaVersion: "commerce.buyer-cart.v1",
  cartId: "cart_fixture",
  revision: 2,
  checkoutProfile: profile,
  fulfillment: "pickup",
  lines: [{ kind: "catalog", variantId: "variant_fixture", quantity: 1 }],
  state: "submitted",
};

// @ts-expect-error Active Carts cannot point at a Checkout.
const invalidActiveCart: CommerceBuyerCartV1 = {
  schemaVersion: "commerce.buyer-cart.v1",
  cartId: "cart_fixture",
  revision: 1,
  checkoutProfile: profile,
  fulfillment: "pickup",
  lines: [{ kind: "catalog", variantId: "variant_fixture", quantity: 1 }],
  state: "active",
  checkoutId: "checkout_fixture",
};

// @ts-expect-error Catalog lines cannot carry menu identity.
const invalidMixedLine: CommerceBuyerCartLineV1 = {
  kind: "catalog",
  variantId: "variant_fixture",
  quantity: 1,
  menuId: "menu_fixture",
};

const lineBearingCheckout: CreateCommerceBuyerPickupCheckoutV1 = {
  schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
  idempotencyKey: "checkout_fixture",
  cartId: "cart_fixture",
  cartRevision: 1,
  buyer: { kind: "identified_customer" },
  // @ts-expect-error Checkout creation consumes a persisted Cart revision.
  lines: [{ kind: "catalog", variantId: "variant_fixture", quantity: 1 }],
};

void activeCart;
void incompleteSubmittedCart;
void invalidActiveCart;
void invalidMixedLine;
void lineBearingCheckout;
