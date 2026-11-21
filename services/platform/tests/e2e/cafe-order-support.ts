import { env } from "cloudflare:workers";
import { CommerceStorefrontClient } from "@purin-labs/commerce-client";

import {
  CAFE_STOREFRONT_ID,
  planCafeMenu,
} from "../../src/cafe/contract/menu-publication";
import { providerClient } from "./pi-sdk-effect-support";

/** The café menu of a demo shop, published so that a buyer can order from it. */
export async function publishCafeMenu(merchantId: string): Promise<void> {
  const client = providerClient();
  const storefront = await client.readStorefront(
    merchantId,
    CAFE_STOREFRONT_ID,
  );
  const stock = await client.readStockSnapshot(merchantId);
  if (
    !storefront.ok ||
    storefront.value.fulfillment.kind !== "pickup" ||
    !stock.ok
  )
    throw new Error("No café storefront");
  const productId = (title: string): string => {
    const product = stock.value.commerce.resources.products.find(
      (candidate) => candidate.title === title,
    );
    if (product === undefined) throw new Error(`No product ${title}`);
    return product.id;
  };
  const item = (id: string, title: string, order: number) => ({
    id,
    productId: productId(title),
    displayName: title,
    description: "",
    placement: { sectionId: "section_main", order },
  });
  const plan = planCafeMenu(
    {
      title: "Café menu",
      sections: [{ id: "section_main", title: "Main", order: 0 }],
      items: [
        item("item_taro", "Taro Milk Tea", 0),
        item("item_cookie", "Taro Cookie", 1),
      ],
    } as Parameters<typeof planCafeMenu>[0],
    stock.value,
    {
      salesChannelId: storefront.value.salesChannelId,
      locationId: storefront.value.fulfillment.locationId,
    },
  );
  if (plan.kind !== "ready") throw new Error(`Menu is ${plan.kind}`);
  const published = await client.publishMenu({
    merchantId: merchantId,
    expectedMerchantRevision: stock.value.commerce.merchantRevision,
    idempotencyKey: `journey_menu_${crypto.randomUUID()}`,
    menu: plan.menu,
  });
  if (!published.ok || published.value.outcome === "rejected")
    throw new Error(`Menu refused: ${JSON.stringify(published)}`);
}

/** One paid pickup order of a guest buyer, as the QR order page places it. */
export async function placeCafeOrder(
  merchantId: string,
  menuEntryIds: readonly string[] = ["item_taro", "item_cookie"],
): Promise<string> {
  const placed = await placePickupOrder(
    merchantId,
    CAFE_STOREFRONT_ID,
    menuEntryIds.map((menuEntryId) => ({
      kind: "menu" as const,
      menuId: "menu_cafe_main",
      menuEntryId,
      modifierOptionIds: [],
      quantity: 1,
    })),
    { key: "refund", email: "buyer-private@example.test" },
  );
  return placed.orderId;
}

type PickupOrderLine =
  | Readonly<{
      kind: "menu";
      menuId: string;
      menuEntryId: string;
      modifierOptionIds: readonly string[];
      quantity: number;
    }>
  | Readonly<{ kind: "catalog"; variantId: string; quantity: number }>;

/**
 * One paid pickup order of a guest buyer through a storefront's buyer API,
 * from the cart to the reconciled payment. Its checkout holds the stock.
 * `key` names the order's idempotency keys.
 */
export async function placePickupOrder(
  merchantId: string,
  storefrontId: string,
  lines: readonly PickupOrderLine[],
  order: Readonly<{ key: string; email: string }>,
) {
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://underclerk.test",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const session = await required(
    buyer.createSession(merchantId, storefrontId, {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const cart = await required(
    buyer.createCart(merchantId, storefrontId, session.token, {
      schemaVersion: "underclerk.create-buyer-cart.v1",
      idempotencyKey: `cart-${order.key}`,
      lines: lines.map((line) =>
        line.kind === "menu"
          ? { ...line, modifierOptionIds: [...line.modifierOptionIds] }
          : line,
      ),
    }),
  );
  const checkout = await required(
    buyer.createPickupCheckout(merchantId, storefrontId, session.token, {
      schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
      idempotencyKey: `checkout-${order.key}`,
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: order.email },
      },
    }),
  );
  const payment = await required(
    buyer.createPaymentSession(
      merchantId,
      storefrontId,
      checkout.checkoutId,
      session.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: `payment-${order.key}`,
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: "https://underclerk.test/return",
      },
    ),
  );
  if (payment.state !== "ready") throw new Error("No payment session");
  const placed = await required(
    buyer.reconcilePayment(
      merchantId,
      storefrontId,
      checkout.checkoutId,
      session.token,
      {
        schemaVersion: "underclerk.reconcile-buyer-payment.v1",
        idempotencyKey: `payment-${order.key}`,
        checkoutRevision: payment.checkoutRevision,
        quoteDigest: checkout.quote.quoteDigest,
        confirmation: { kind: "provider_ui_completed" },
      },
    ),
  );
  if (placed.state !== "placed") throw new Error(`Payment ${placed.state}`);
  return placed;
}

/** A guest buyer's card payment that the provider declines: no order is placed. */
export async function declineCafeOrder(merchantId: string): Promise<string> {
  const buyer = new CommerceStorefrontClient({
    baseUrl: "http://underclerk.test",
    fetch: env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
  });
  const session = await required(
    buyer.createSession(merchantId, CAFE_STOREFRONT_ID, {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  const cart = await required(
    buyer.createCart(merchantId, CAFE_STOREFRONT_ID, session.token, {
      schemaVersion: "underclerk.create-buyer-cart.v1",
      idempotencyKey: "cart-declined",
      lines: [
        {
          kind: "menu" as const,
          menuId: "menu_cafe_main",
          menuEntryId: "item_taro",
          modifierOptionIds: [],
          quantity: 1,
        },
      ],
    }),
  );
  const checkout = await required(
    buyer.createPickupCheckout(merchantId, CAFE_STOREFRONT_ID, session.token, {
      schemaVersion: "underclerk.create-buyer-pickup-checkout.v1",
      idempotencyKey: "checkout-declined",
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: {
        kind: "guest",
        contact: { kind: "email", email: "buyer-private@example.test" },
      },
    }),
  );
  const payment = await required(
    buyer.createPaymentSession(
      merchantId,
      CAFE_STOREFRONT_ID,
      checkout.checkoutId,
      session.token,
      {
        schemaVersion: "underclerk.create-buyer-payment-session.v1",
        idempotencyKey: "payment-declined",
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: "https://underclerk.test/return",
      },
    ),
  );
  if (payment.state !== "ready") throw new Error("No payment session");
  const admin = providerClient();
  const snapshot = await required(admin.readSnapshot(merchantId));
  const declined = await required(
    admin.resolveCheckoutPayment({
      merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: "decline-declined",
      checkoutId: checkout.checkoutId,
      checkoutRevision: payment.checkoutRevision + 1,
      quoteDigest: checkout.quote.quoteDigest,
      paymentAttemptId: payment.paymentAttemptId,
      paymentAttemptRevision: 1,
      outcome: { kind: "declined", reasonCode: "card_declined" },
    }),
  );
  if (declined.outcome !== "applied")
    throw new Error(`Decline ${declined.outcome}`);
  return payment.paymentAttemptId;
}

export async function required<T>(
  result: Promise<
    Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>
  >,
): Promise<T> {
  const answered = await result;
  if (!answered.ok) throw new Error(JSON.stringify(answered.error));
  return answered.value;
}
