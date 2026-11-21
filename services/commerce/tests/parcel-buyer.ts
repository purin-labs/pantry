// A guest buyer of the Japan cookie shop who ships two boxes to Singapore,
// for the shipping journeys of Plan 77.
import type {
  CommerceBuyerQuotedShippingCheckoutV1,
  CommerceStorefrontClient,
} from "@purin-labs/commerce-client";

import { merchantId, required } from "./journey-support.ts";

export const PARCEL_SHOP = "storefront_cookie_store_sg";

export type ParcelQuote =
  | Readonly<{
      outcome: "quoted";
      checkout: CommerceBuyerQuotedShippingCheckoutV1;
    }>
  | Readonly<{ outcome: "rejected"; error: unknown }>;

type ParcelCart = Readonly<{
  cart: Readonly<{ cartId: string; revision: number }>;
  validation: Extract<
    Awaited<ReturnType<CommerceStorefrontClient["validateShippingAddress"]>>,
    { ok: true }
  >["value"] & { state: "accepted" };
  serviceCode: string;
}>;

/** A guest buyer who ships two boxes of cookies to Singapore. */
export class ParcelBuyer {
  readonly #client: CommerceStorefrontClient;
  readonly #name: string;
  readonly #token: string;

  private constructor(
    client: CommerceStorefrontClient,
    name: string,
    token: string,
  ) {
    this.#client = client;
    this.#name = name;
    this.#token = token;
  }

  static async start(
    client: CommerceStorefrontClient,
    name: string,
  ): Promise<ParcelBuyer> {
    const session = await required(
      client.createSession(merchantId, PARCEL_SHOP, {
        schemaVersion: "commerce.create-buyer-session.v1",
        buyer: { kind: "guest" },
      }),
    );
    return new ParcelBuyer(client, name, session.token);
  }

  /** "open", or the kind of the catalog read's failure. */
  async catalogStatus(): Promise<string> {
    const result = await this.#client.readCatalog(
      merchantId,
      PARCEL_SHOP,
      this.#token,
    );
    return result.ok ? "open" : result.error.kind;
  }

  /** The quote, or the refusal of a market. */
  async quote(marketId?: string): Promise<ParcelQuote> {
    return this.checkout(await this.prepare(), marketId);
  }

  /** Reads the catalog, fills the cart and has the address accepted. */
  async prepare(): Promise<ParcelCart> {
    const catalog = await required(
      this.#client.readCatalog(merchantId, PARCEL_SHOP, this.#token),
    );
    const listing = catalog.listings.find(
      (item) => item.availability === "available",
    );
    const service =
      catalog.storefront.fulfillment === "shipping"
        ? catalog.storefront.shippingServices.find(
            (item) =>
              item.destinationCountry === "SG" &&
              item.availability.state === "available",
          )
        : undefined;
    if (listing === undefined || service === undefined)
      throw new Error("The shipping storefront sells nothing to Singapore");
    const cart = await required(
      this.#client.createCart(merchantId, PARCEL_SHOP, this.#token, {
        schemaVersion: "commerce.create-buyer-cart.v1",
        idempotencyKey: `${this.#name}_cart`,
        lines: [{ kind: "catalog", variantId: listing.variantId, quantity: 2 }],
      }),
    );
    const validation = await required(
      this.#client.validateShippingAddress(
        merchantId,
        PARCEL_SHOP,
        this.#token,
        {
          schemaVersion: "commerce.validate-buyer-shipping-address.v1",
          idempotencyKey: `${this.#name}_address`,
          address: {
            countryCode: "SG",
            recipientName: "Mei Lim",
            addressLine1: "1 Raffles Quay",
            locality: "Singapore",
            postalCode: "018956",
          },
        },
      ),
    );
    if (validation.state !== "accepted")
      throw new Error("The Singapore address was not accepted");
    return { cart, validation, serviceCode: service.service.code };
  }

  /** The checkout of a prepared cart, or its refusal. */
  async checkout(
    { cart, validation, serviceCode }: ParcelCart,
    marketId?: string,
  ): Promise<ParcelQuote> {
    const result = await this.#client.createShippingCheckout(
      merchantId,
      PARCEL_SHOP,
      this.#token,
      {
        schemaVersion: "commerce.create-buyer-shipping-checkout.v1",
        idempotencyKey: `${this.#name}_checkout`,
        cartId: cart.cartId,
        cartRevision: cart.revision,
        buyer: {
          kind: "guest",
          contact: { kind: "email", email: `${this.#name}@example.test` },
        },
        shippingServiceCode: serviceCode,
        shippingDestination: {
          kind: "provided_address",
          address: validation.address,
          acceptance: {
            kind: "accepted_as_entered",
            addressValidationReference: validation.validationReference,
          },
        },
        ...(marketId === undefined ? {} : { marketId }),
      },
    );
    if (result.ok) return { outcome: "quoted", checkout: result.value };
    if (result.error.kind === "rejected")
      return { outcome: "rejected", error: result.error.error };
    throw new Error(JSON.stringify(result.error));
  }

  async pay(checkout: CommerceBuyerQuotedShippingCheckoutV1) {
    const key = `${this.#name}_payment`;
    const session = await required(
      this.#client.createPaymentSession(
        merchantId,
        PARCEL_SHOP,
        checkout.checkoutId,
        this.#token,
        {
          schemaVersion: "commerce.create-buyer-payment-session.v1",
          idempotencyKey: key,
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          returnUrl: "https://commerce.test/store/cookies",
        },
      ),
    );
    if (session.state !== "ready")
      throw new Error(`${this.#name} payment is not ready`);
    return required(
      this.#client.reconcilePayment(
        merchantId,
        PARCEL_SHOP,
        checkout.checkoutId,
        this.#token,
        {
          schemaVersion: "commerce.reconcile-buyer-payment.v1",
          idempotencyKey: key,
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          confirmation: { kind: "provider_ui_completed" },
        },
      ),
    );
  }
}
