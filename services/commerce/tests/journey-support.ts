// Shared harness for Commerce journeys: the real HTTP API and SQLite store,
// seeded by seed-local-commerce.ts at a fixed clock, with the deterministic
// payment gateway as the only provider fake. Staff use the admin client and
// buyers the storefront client, both through the HTTP API.
import type { OnlinePaymentBinding } from "@purin-labs/commerce-contracts";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CommerceBuyerCartLineV1,
  type CommerceClientResult,
  type CommerceMutationErrorV1,
  type CommerceMutationResultV1,
  type CommerceVariantV1,
} from "@purin-labs/commerce-client";

import { ApiAccess } from "../src/api-access.ts";
import { handleMcpRequest, mcpMerchantId } from "../src/mcp-server.ts";
import { FeedConsumers } from "../src/feed-consumers.ts";
import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import type { CommerceSigner } from "../src/commerce-authority/contracts.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { EntityPlaneService } from "../src/entity-plane/service.ts";
import {
  createJapanExportShipping,
  createJapanShippingGateway,
} from "../src/plugins/japan-export/index.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import {
  DeterministicPaymentGateway,
  UnavailablePaymentGateway,
} from "../src/payments/provider.ts";
import {
  StripeApi,
  StripePaymentAccounts,
  StripePaymentGateway,
} from "../src/payments/stripe/stripe-payments.ts";
import { BankPayouts } from "../src/payments/bank-payouts.ts";
import {
  SquarePaymentAccounts,
  SquarePaymentGateway,
  SquareTerminalGateway,
} from "../src/payments/square/square-payments.ts";
import { SquareApi } from "../src/payments/square/square-api.ts";
import { SquareConnections } from "../src/payments/square/square-connection.ts";
import { CustomerVault } from "../src/plugins/customers/index.ts";
import type {
  NotificationGateway,
  NotificationMessage,
  NotificationSendResult,
} from "../src/notification-gateway.ts";
import type { WebhookSender } from "../src/webhooks.ts";
import type { ArchiveStore } from "../src/archive.ts";
import type { MediaStore } from "../src/plugins/media/index.ts";
import { initializeCommerceSchema } from "../src/schema.ts";
import { createLocalShippingAddressValidationService } from "../src/shipping-address-validation.ts";
import {
  LOCAL_COMMERCE_MERCHANT,
  seedLocalCommerce,
} from "../scripts/seed-local-commerce.ts";
import { QuickJsFunctionRuntime } from "../src/plugins/function-runtime.ts";
import quickjsWasm from "./quickjs-wasm-module.ts";
import { FIXTURE_NOW } from "../scripts/fixture-miniflare.ts";

export const NOW = FIXTURE_NOW;
export const SERVICE_TOKEN = "catalog_editing_service_token";
export const BASE_URL = "https://commerce.test";
export const STOREFRONT = "storefront_cafe";
export const CHANNEL = "sales_channel_cafe";
export const LOCATION = "location_cafe";
export const PRODUCT = "product_loose_leaf_tea";
/**
 * The seeded café's opening lots expire then, so the alarm's `lot_expiry`
 * pass is the last work that stays due.
 */
export const CAFE_LOTS_EXPIRE = "2036-08-21T00:00:00.000Z";
export const { organisationId, merchantId } = LOCAL_COMMERCE_MERCHANT;

export type Evidence = Record<string, unknown>;

/** Staff actions shared by journeys: unique keys, receipts, the tea setup. */
export class StaffDesk {
  readonly receipts: Evidence[] = [];
  protected readonly admin: CommerceAdminClient;
  protected step = 0;

  protected readonly prefix: string;

  constructor(admin: CommerceAdminClient, prefix: string) {
    this.admin = admin;
    this.prefix = prefix;
  }

  async createTea(): Promise<void> {
    await this.apply(
      this.admin.createInventoryItem({
        ...(await this.base("inventory_item")),
        inventoryItemId: "inventory_tea_tin",
        merchantCode: "TEA-TIN",
        name: "Tea tin",
        baseUnit: "each",
        category: "finished_good",
        tracking: { kind: "aggregate" },
      }),
    );
    const variants = [
      [
        "variant_tea_small_sencha",
        "Small sencha",
        "TEA-S-SENCHA",
        "Small",
        "Sencha",
        1_200,
      ],
      [
        "variant_tea_small_hojicha",
        "Small hojicha",
        "TEA-S-HOJICHA",
        "Small",
        "Hojicha",
        1_200,
      ],
      [
        "variant_tea_large_sencha",
        "Large sencha",
        "TEA-L-SENCHA",
        "Large",
        "Sencha",
        1_800,
      ],
      [
        "variant_tea_large_hojicha",
        "Large hojicha",
        "TEA-L-HOJICHA",
        "Large",
        "Hojicha",
        1_800,
      ],
    ] as const;
    for (const [
      index,
      [id, title, sku, size, leaf, price],
    ] of variants.entries()) {
      const variant = teaVariant(id, title, sku, [
        { name: "Size", value: size },
        { name: "Leaf", value: leaf },
      ]);
      await this.apply(
        this.admin.placeChannelListing({
          ...(await this.base("listing")),
          salesChannelId: CHANNEL,
          catalog:
            index === 0
              ? {
                  kind: "new_product",
                  product: {
                    id: PRODUCT,
                    revision: 1,
                    title: "Loose leaf tea",
                    description: "Leaf tea from Kyoto.",
                    handle: null,
                    productType: "",
                    vendor: "",
                    tags: [],
                    status: "active",
                    occurredAt: NOW,
                  },
                  variant,
                  consumptionPlan: teaPlan(id),
                }
              : {
                  kind: "new_variant",
                  productId: PRODUCT,
                  productRevision: 1,
                  variant,
                  consumptionPlan: teaPlan(id),
                },
          offer: teaOffer(id, price),
        }),
      );
    }
    await this.apply(
      this.admin.openInventoryPosition({
        ...(await this.base("position")),
        inventoryPositionId: "position_tea_tin_cafe",
        inventoryItemId: "inventory_tea_tin",
        inventoryItemRevision: 1,
        locationId: LOCATION,
        locationRevision: 1,
      }),
    );
    await this.apply(
      this.admin.receiveInventory({
        purchase: { kind: "unlinked" },
        ...(await this.base("receipt")),
        receiptId: "receipt_tea_opening_stock",
        receiptLineId: "receipt_line_tea_tins",
        inventoryItemId: "inventory_tea_tin",
        inventoryItemRevision: 1,
        inventoryPositionId: "position_tea_tin_cafe",
        inventoryPositionRevision: 1,
        locationId: LOCATION,
        receivedQuantity: { amount: 40, scale: 0, unit: "each" },
        lot: { kind: "not_tracked" },
        receivedAt: NOW,
      }),
    );
  }

  protected async snapshot() {
    return (await required(this.admin.readSnapshot(merchantId))).resources;
  }

  protected async base(name: string) {
    const snapshot = await required(this.admin.readSnapshot(merchantId));
    return {
      merchantId,
      expectedMerchantRevision: snapshot.merchantRevision,
      idempotencyKey: `${this.prefix}_${name}_${(this.step += 1)}`,
    };
  }

  protected editBase(key: string) {
    this.step += 1;
    return {
      merchantId,
      idempotencyKey: `${this.prefix}_${key}`,
    };
  }

  protected async apply(
    pending: Promise<CommerceClientResult<CommerceMutationResultV1>>,
  ): Promise<void> {
    const result = await this.edit(pending);
    if (result.outcome !== "applied")
      throw new Error(`Staff setup did not apply: ${JSON.stringify(result)}`);
  }

  protected async edit(
    pending: Promise<CommerceClientResult<CommerceMutationResultV1>>,
  ): Promise<CommerceMutationResultV1> {
    const result = await pending;
    const value = result.ok
      ? result.value
      : result.error.kind === "rejected"
        ? { outcome: "rejected" as const, error: result.error.error }
        : undefined;
    if (value === undefined)
      throw new Error(result.ok ? "" : result.error.message);
    this.receipts.push(
      value.outcome === "rejected"
        ? { outcome: "rejected", code: value.error.code }
        : {
            outcome: value.outcome,
            commandKind: value.receipt.commandKind,
            resource: value.receipt.resource,
            merchantRevision: value.receipt.merchantRevision,
          },
    );
    return value;
  }
}

export class Buyer {
  readonly #client: CommerceStorefrontClient;
  readonly #name: string;
  readonly #token: string;
  readonly #signedIn: boolean;
  #cart: Readonly<{ cartId: string; revision: number }> | undefined;
  /** Discount codes this buyer enters at checkout. */
  discountCodes: readonly string[] = [];
  /** The market this buyer shops in, if not the shop's own currency. */
  marketId: string | undefined;
  /** Gift card codes this buyer enters at checkout. */
  giftCardCodes: readonly string[] = [];
  /** Whether a signed-in buyer pays with store credit. */
  storeCredit = false;
  /** The pickup time this buyer chooses; the lead time applies without one. */
  pickupAt: string | undefined;
  /** The order this buyer placed last, with its recovery token. */
  lastPlacement:
    | Readonly<{ orderId: string; checkoutId: string; recoveryToken: string }>
    | undefined;
  #step = 0;

  constructor(
    client: CommerceStorefrontClient,
    name: string,
    token: string,
    signedIn = false,
  ) {
    this.#client = client;
    this.#name = name;
    this.#token = token;
    this.#signedIn = signedIn;
  }

  /** The buyer session's bearer token, for calls the helpers do not make. */
  get token(): string {
    return this.#token;
  }

  /** A buyer session made from a signed-in customer's access token. */
  static async signedIn(
    client: CommerceStorefrontClient,
    name: string,
    customerAccessToken: string,
  ): Promise<Buyer> {
    const session = await required(
      client.createSession(merchantId, STOREFRONT, {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "identified_customer", customerAccessToken },
      }),
    );
    return new Buyer(client, name, session.token, true);
  }

  static async start(
    client: CommerceStorefrontClient,
    name: string,
  ): Promise<Buyer> {
    const session = await required(
      client.createSession(merchantId, STOREFRONT, {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    return new Buyer(client, name, session.token);
  }

  async tryCart(
    lines: readonly CommerceBuyerCartLineV1[],
  ): Promise<CommerceMutationErrorV1 | undefined> {
    const result = await this.#client.createCart(
      merchantId,
      STOREFRONT,
      this.#token,
      {
        schemaVersion: "commerce.create-buyer-cart.v1",
        idempotencyKey: this.#key("cart"),
        lines,
      },
    );
    return result.ok ? undefined : rejectionOf(result);
  }

  async fillCart(lines: readonly CommerceBuyerCartLineV1[]): Promise<void> {
    const cart =
      this.#cart === undefined
        ? await required(
            this.#client.createCart(merchantId, STOREFRONT, this.#token, {
              schemaVersion: "commerce.create-buyer-cart.v1",
              idempotencyKey: this.#key("cart"),
              lines,
            }),
          )
        : await required(
            this.#client.replaceCart(
              merchantId,
              STOREFRONT,
              this.#cart.cartId,
              this.#token,
              {
                schemaVersion: "commerce.replace-buyer-cart.v1",
                idempotencyKey: this.#key("cart"),
                cartRevision: this.#cart.revision,
                lines,
              },
            ),
          );
    this.#cart = { cartId: cart.cartId, revision: cart.revision };
  }

  async tryCheckout(): Promise<CommerceMutationErrorV1 | undefined> {
    const result = await this.#checkout();
    return result.ok ? undefined : rejectionOf(result);
  }

  /** The quoted checkout, or the refusal of the cart or the checkout. */
  async tryQuote(lines: readonly CommerceBuyerCartLineV1[]) {
    const cart = await this.#client.createCart(
      merchantId,
      STOREFRONT,
      this.#token,
      {
        schemaVersion: "commerce.create-buyer-cart.v1",
        idempotencyKey: this.#key("cart"),
        lines,
      },
    );
    if (!cart.ok) return { kind: "refused", error: rejectionOf(cart) } as const;
    this.#cart = { cartId: cart.value.cartId, revision: cart.value.revision };
    const result = await this.#checkout();
    return result.ok
      ? ({ kind: "quoted", checkout: result.value } as const)
      : ({ kind: "refused", error: rejectionOf(result) } as const);
  }

  async quote(lines: readonly CommerceBuyerCartLineV1[]) {
    await this.fillCart(lines);
    return required(this.#checkout());
  }

  async buyCart(): Promise<string> {
    return this.pay(await required(this.#checkout()));
  }

  async buyLines(lines: readonly CommerceBuyerCartLineV1[]): Promise<string> {
    return this.pay(await this.quote(lines));
  }

  /** Starts the payment only, as a buyer who is still on the payment page. */
  async startPayment(checkout: Quoted): Promise<void> {
    const session = await required(this.#paymentSession(checkout));
    if (session.state !== "ready")
      throw new Error(`${this.#name} payment is not ready`);
  }

  async tryPay(
    checkout: Quoted,
  ): Promise<CommerceMutationErrorV1 | undefined> {
    const session = await this.#paymentSession(checkout);
    return session.ok ? undefined : rejectionOf(session);
  }

  async refreshAndPay(
    checkout: Quoted,
    lines: readonly CommerceBuyerCartLineV1[],
  ): Promise<string> {
    return this.pay(await this.refresh(checkout, lines));
  }

  async refresh(
    checkout: Quoted,
    lines: readonly CommerceBuyerCartLineV1[],
  ): Promise<Quoted> {
    return required(
      this.#client.refreshPickupCheckout(
        merchantId,
        STOREFRONT,
        checkout.checkoutId,
        this.#token,
        {
          schemaVersion: "commerce.refresh-buyer-pickup-checkout.v1",
          idempotencyKey: this.#key("refresh"),
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          lines,
        },
      ),
    );
  }

  async pay(checkout: Quoted): Promise<string> {
    const session = await required(this.#paymentSession(checkout));
    if (session.state !== "ready")
      throw new Error(`${this.#name} payment is not ready`);
    const placed = await required(
      this.#client.reconcilePayment(
        merchantId,
        STOREFRONT,
        checkout.checkoutId,
        this.#token,
        {
          schemaVersion: "commerce.reconcile-buyer-payment.v1",
          idempotencyKey: this.#paymentKey(checkout),
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          confirmation: { kind: "provider_ui_completed" },
        },
      ),
    );
    if (placed.state !== "placed")
      throw new Error(`${this.#name} payment ended ${placed.state}`);
    this.lastPlacement = {
      orderId: placed.orderId,
      checkoutId: placed.checkoutId,
      recoveryToken: placed.orderRecovery.token,
    };
    return placed.orderId;
  }

  #checkout() {
    if (this.#cart === undefined) throw new Error(`${this.#name} has no cart`);
    return this.#client.createPickupCheckout(
      merchantId,
      STOREFRONT,
      this.#token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: this.#key("checkout"),
        cartId: this.#cart.cartId,
        cartRevision: this.#cart.revision,
        buyer: this.#signedIn
          ? { kind: "identified_customer" }
          : {
              kind: "guest",
              contact: { kind: "email", email: `${this.#name}@example.test` },
            },
        ...(this.discountCodes.length === 0
          ? {}
          : { discountCodes: this.discountCodes }),
        ...(this.marketId === undefined ? {} : { marketId: this.marketId }),
        ...(this.giftCardCodes.length === 0
          ? {}
          : { giftCardCodes: this.giftCardCodes }),
        ...(this.storeCredit ? { storeCredit: true } : {}),
        ...(this.pickupAt === undefined ? {} : { pickupAt: this.pickupAt }),
      },
    );
  }

  /** Places a checkout that gift cards and store credit pay in full. */
  async placeStoredValue(checkout: Quoted) {
    return this.#client.placeStoredValueCheckout(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      this.#token,
      {
        schemaVersion: "commerce.place-buyer-stored-value-checkout.v1",
        idempotencyKey: this.#paymentKey(checkout),
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
      },
    );
  }

  #paymentSession(checkout: Quoted) {
    return this.#client.createPaymentSession(
      merchantId,
      STOREFRONT,
      checkout.checkoutId,
      this.#token,
      {
        schemaVersion: "commerce.create-buyer-payment-session.v1",
        idempotencyKey: this.#paymentKey(checkout),
        checkoutRevision: checkout.revision,
        quoteDigest: checkout.quote.quoteDigest,
        returnUrl: `${BASE_URL}/store/cafe`,
      },
    );
  }

  #paymentKey(checkout: Quoted): string {
    return `${this.#name}_payment_${checkout.revision}`;
  }

  #key(name: string): string {
    return `${this.#name}_${name}_${(this.#step += 1)}`;
  }
}

export type Quoted = Awaited<ReturnType<Buyer["quote"]>>;

/** A fake email provider: it only records what Commerce sends. */
export class EmailOutbox implements NotificationGateway {
  readonly sent: NotificationMessage[] = [];

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    this.sent.push(message);
    return { kind: "sent", providerMessageId: `email_${this.sent.length}` };
  }
}

const CUSTOMER_DATA_ROOT = "journey_customer_data_root_secret_32b";

export async function startBackend(
  options: Readonly<{
    customers?: boolean;
    /** A clock the journey can move; the default stays at NOW. */
    now?: () => string;
    webhooks?: WebhookSender;
    archive?: ArchiveStore;
    /** The storefront's payment account; the default is Stripe in JPY. */
    paymentBinding?: OnlinePaymentBinding;
    /**
     * Stripe test-mode keys: Commerce runs the payments of connected
     * accounts itself, and any other payment fails, as with Platform stopped.
     * `fetch` stands in for api.stripe.com.
     */
    stripe?: Readonly<{
      secretKey: string;
      publishableKey: string;
      fetch?: typeof fetch;
    }>;
    /**
     * Square online inside Commerce: payments of a connected Square
     * location run here, and any other payment fails, as with Platform
     * stopped. `fetch` stands in for Square's API.
     */
    square?: Readonly<{
      fetch?: typeof fetch;
      oauth?: Readonly<{ clientId: string; clientSecret: string }>;
    }>;
    media?: MediaStore;
  }> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "commerce-catalog-editing-"));
  const database = new NodeCommerceDatabase(
    join(directory, "commerce.sqlite3"),
  );
  initializeCommerceSchema(database, NOW);
  const now = options.now ?? (() => NOW);
  const stripeAccounts =
    options.stripe === undefined
      ? undefined
      : new StripePaymentAccounts({
          database,
          api: new StripeApi({
            secretKey: options.stripe.secretKey,
            ...(options.stripe.fetch === undefined
              ? {}
              : { fetch: options.stripe.fetch }),
          }),
          now,
        });
  const squareAccounts =
    options.square === undefined
      ? undefined
      : new SquarePaymentAccounts({
          database,
          connections: new SquareConnections({
            database,
            vault: new CustomerVault(CUSTOMER_DATA_ROOT),
            api: new SquareApi(
              options.square.fetch === undefined
                ? {}
                : { fetch: options.square.fetch },
            ),
            ...(options.square.oauth === undefined
              ? {}
              : { oauth: options.square.oauth }),
            now,
          }),
          now,
        });
  const authority = new CommerceAuthority({
    database,
    signer: new JourneySigner(),
    paymentGateway:
      squareAccounts !== undefined
        ? new SquarePaymentGateway({
            accounts: squareAccounts,
            database,
            fallback: new UnavailablePaymentGateway(),
            now,
          })
        : options.stripe === undefined || stripeAccounts === undefined
          ? new DeterministicPaymentGateway(now, options.paymentBinding)
          : new StripePaymentGateway({
              accounts: stripeAccounts,
              database,
              publishableKey: options.stripe.publishableKey,
              fallback: new UnavailablePaymentGateway(),
              now,
            }),
    ...(squareAccounts === undefined
      ? {}
      : {
          inPersonCollectionGateway: new SquareTerminalGateway({
            accounts: squareAccounts,
            database,
            now,
          }),
        }),
    now,
    shippingGateway: createJapanShippingGateway("catalog-editing-carrier-key"),
    shipping: createJapanExportShipping("catalog-editing-carrier-key"),
    functionRuntime: new QuickJsFunctionRuntime(quickjsWasm),
    ...(options.customers === true
      ? { customerDataRoot: CUSTOMER_DATA_ROOT }
      : {}),
  });
  const emails = new EmailOutbox();
  let sessions = 0;
  const access = new ApiAccess({ database, operatorToken: SERVICE_TOKEN, now });
  const api = new CommerceHttpApi({
    authority,
    entityPlane: new EntityPlaneService({
      database,
      signer: new JourneySigner(),
      now,
    }),
    buyerSessions: new BuyerSessionAuthority({
      secret: "catalog_editing_buyer_session_secret",
      now,
      newSessionId: () => `session_catalog_editing_${(sessions += 1)}`,
    }),
    addressValidations: createLocalShippingAddressValidationService(
      database,
      now,
    ),
    serviceToken: SERVICE_TOKEN,
    access,
    feedConsumers: new FeedConsumers({ database, now }),
    ...(stripeAccounts === undefined
      ? {}
      : { paymentAccounts: stripeAccounts }),
    ...(squareAccounts === undefined ? {} : { squareAccounts }),
    bankPayouts: new BankPayouts({
      database,
      ...(stripeAccounts === undefined ? {} : { stripe: stripeAccounts }),
      ...(squareAccounts === undefined ? {} : { square: squareAccounts }),
      now,
    }),
    ...(options.customers === true ? { notifications: emails } : {}),
    ...(options.webhooks === undefined ? {} : { webhooks: options.webhooks }),
    ...(options.archive === undefined ? {} : { archive: options.archive }),
    ...(options.media === undefined ? {} : { media: options.media }),
  });
  // The Worker sends queued email after each response; so does this fetch.
  const databasePath = join(directory, "commerce.sqlite3");
  const fetch: typeof api.fetch = async (input, init) => {
    // As the merchant object: the MCP server's tools call the same API.
    const request = new Request(input, init);
    const mcpMerchant = mcpMerchantId(request);
    const response =
      mcpMerchant === undefined
        ? await api.handle(request)
        : await handleMcpRequest(request, mcpMerchant, {
            access,
            dispatch: (inner) => api.handle(inner),
          });
    await api.runPluginHandlers();
    api.reportPluginFailures();
    await api.deliverNotifications();
    await api.deliverWebhooks();
    return response;
  };
  const admin = new CommerceAdminClient({
    baseUrl: BASE_URL,
    serviceToken: SERVICE_TOKEN,
    fetch,
  });
  const buyer = new CommerceStorefrontClient({
    baseUrl: BASE_URL,
    fetch,
  });
  await seedLocalCommerce(admin, buyer);
  return {
    admin,
    buyer,
    /** Raw HTTP, for what a browser fetches without a client (images). */
    fetch,
    emails,
    database,
    databasePath,
    /** What the Worker's alarm does: post the webhooks that are due. */
    dispatchWebhooks: () => api.deliverWebhooks(),
    /** What the Worker's alarm does: read due pending refunds again. */
    reconcileRefunds: () => api.reconcileRefunds(),
    /** What the Worker's alarm does: refunds again, and lapsed holds. */
    runDueWork: () => api.runDueWork(),
    close: () => {
      authority.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function catalogFor(client: CommerceStorefrontClient) {
  const session = await required(
    client.createSession(merchantId, STOREFRONT, {
      schemaVersion: "commerce.create-buyer-session.v1",
      buyer: { kind: "guest" },
    }),
  );
  return required(client.readCatalog(merchantId, STOREFRONT, session.token));
}

export function teaListings(catalog: Awaited<ReturnType<typeof catalogFor>>) {
  return catalog.listings
    .filter((listing) => listing.productId === PRODUCT)
    .sort((left, right) => left.variantId.localeCompare(right.variantId));
}

export function latteEntry(catalog: Awaited<ReturnType<typeof catalogFor>>) {
  return catalog.menus
    .find((menu) => menu.menuId === "menu_cafe_main")
    ?.entries.find((entry) => entry.menuEntryId === "menu_entry_sesame_latte");
}

export function teaVariant(
  id: string,
  title: string,
  sku: string,
  options: CommerceVariantV1["options"],
): CommerceVariantV1 {
  return {
    id,
    revision: 1,
    productId: PRODUCT,
    sku,
    title,
    options,
    media: [],
    barcode: null,
    status: "active",
    occurredAt: NOW,
  };
}

export function teaPlan(variantId: string) {
  return {
    consumptionPlanId: `plan_${variantId}`,
    variantId,
    revision: 1,
    scope: { kind: "location" as const, locationId: LOCATION },
    mode: {
      kind: "direct" as const,
      components: [
        {
          inventoryItemId: "inventory_tea_tin",
          quantity: { amount: 1, scale: 0, unit: "each" as const },
        },
      ],
      commitOn: "fulfillment_completed" as const,
    },
    lifecycle: "active" as const,
  };
}

export function teaOffer(variantId: string, priceMinor: number) {
  return {
    id: variantId.replace("variant_", "offer_"),
    revision: 1,
    variantId,
    salesChannelId: CHANNEL,
    price: jpy(priceMinor),
    compareAtPrice: null,
    availability: { state: "available" as const },
    lifecycle: { state: "listed" as const, listedAt: NOW },
    occurredAt: NOW,
  };
}

export function catalogLine(variantId: string): CommerceBuyerCartLineV1 {
  return { kind: "catalog", variantId, quantity: 1 };
}

export function jpy(amountMinor: number) {
  return { amountMinor, currency: "JPY" };
}

export function usd(amountMinor: number) {
  return { amountMinor, currency: "USD" };
}

export function rejectedWith(error: Partial<CommerceMutationErrorV1>) {
  return { outcome: "rejected", error };
}

export function rejectionOf(
  result: CommerceClientResult<unknown>,
): CommerceMutationErrorV1 | undefined {
  if (result.ok) return undefined;
  if (result.error.kind === "rejected") return result.error.error;
  throw new Error(result.error.message);
}

export async function required<T>(
  pending: Promise<CommerceClientResult<T>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok)
    throw new Error(
      result.error.kind === "rejected"
        ? JSON.stringify(result.error.error)
        : result.error.message,
    );
  return result.value;
}

export function writeEvidence(
  variable: string,
  name: string,
  evidence: Evidence,
): void {
  const root = process.env[variable];
  if (root === undefined) return;
  mkdirSync(root, { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(root, `${name}.json`), body);
  writeFileSync(
    join(root, `${name}.sha256`),
    `${createHash("sha256").update(body).digest("hex")}\n`,
  );
}

/** A fixed Ed25519 key, so receipts and signatures repeat. */
export class JourneySigner implements CommerceSigner {
  readonly keyId = "key_catalog_editing";
  readonly publicKeyB64: string;
  readonly #privateKey: KeyObject;

  constructor() {
    const seed = createHash("sha256").update(this.keyId).digest();
    this.#privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        seed,
      ]),
      format: "der",
      type: "pkcs8",
    });
    this.publicKeyB64 = String(
      createPublicKey(this.#privateKey).export({ format: "jwk" }).x,
    );
  }

  sign(payload: Uint8Array): string {
    return sign(null, payload, this.#privateKey).toString("base64url");
  }
}
