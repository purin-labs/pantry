// Plan 76 phase 8 slice 2: B2B companies. Staff make "Shibuya Office Gifts"
// with Ana as its buyer and ¥900 for the small sencha (¥1,200 in the shop).
// Signed in, Ana pays ¥900 for it, and a 10% code comes off the company
// price; the large sencha keeps the shop price. Cookies shipped to Singapore
// get the company price too. Bo, a guest and Ana's guest
// visit pay the shop price. A customer in two companies, an unknown customer
// or variant, a zero price and a stale revision are refused. An inactive
// company, a member who leaves and a paused plugin bring the shop price
// back; Bo joins and gets the company price. Set COMPANY_PRICE_ARTIFACT_DIR
// to keep the run's evidence; the file repeats byte for byte for the same
// commit.
import type {
  CreateCommerceCompanyV1,
  CommerceAdminClient,
  CommerceStorefrontClient,
  UpdateCommerceCompanyV1,
} from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  Buyer,
  NOW,
  STOREFRONT,
  catalogLine,
  jpy,
  merchantId,
  rejectedWith,
  required,
  startBackend,
  writeEvidence,
  type EmailOutbox,
  type Evidence,
} from "./journey-support.ts";
import { LARGE_SENCHA, OrderDesk, SMALL_SENCHA } from "./order-desk.ts";

const PRICES: CreateCommerceCompanyV1["prices"] = {
  currency: "JPY",
  items: [{ variantId: SMALL_SENCHA, amountMinor: 900 }],
};

it(
  "gives a company's buyers its prices at checkout",
  { timeout: 120_000 },
  companyPrices,
);

async function companyPrices(): Promise<void> {
  const backend = await startBackend({ customers: true });
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin, buyer, emails } = backend;
    const staff = new CompanyDesk(admin);
    await staff.createTea();
    let visits = 0;
    const visit = (access: string) =>
      Buyer.signedIn(buyer, `company_${(visits += 1)}`, access);
    const ana = await signIn(buyer, emails, "ana@example.test");
    const bo = await signIn(buyer, emails, "bo@example.test");
    const tea = [catalogLine(SMALL_SENCHA), catalogLine(LARGE_SENCHA)];
    // Each line's unit price, small sencha first.
    const prices = async (shopper: Buyer) =>
      (await shopper.quote(tea)).quote.lines.map((line) =>
        line.kind === "order_balance" ? null : line.unitPrice.amountMinor,
      );

    // Staff find Ana and Bo by their first orders.
    const anaId = await staff.customerOf(
      await (await visit(ana)).buyLines([catalogLine(SMALL_SENCHA)]),
    );
    const boId = await staff.customerOf(
      await (await visit(bo)).buyLines([catalogLine(SMALL_SENCHA)]),
    );
    const shop = await prices(await visit(bo));
    expect(shop[0]).toBe(1_200);
    // The same buyers sign in at the shipping storefront.
    const anaShip = await signIn(
      buyer,
      emails,
      "ana@example.test",
      SHIPPING_SHOP,
    );
    const boShip = await signIn(
      buyer,
      emails,
      "bo@example.test",
      SHIPPING_SHOP,
    );
    const cookies = await shippedCookies(buyer, anaShip, "ship_before");

    expect(
      await staff.create("company_shibuya", "Shibuya Office Gifts", [anaId], {
        currency: "JPY",
        items: [
          ...PRICES.items,
          { variantId: cookies.variantId, amountMinor: 300 },
        ],
      }),
    ).toMatchObject({
      outcome: "applied",
      receipt: {
        commandKind: "create_company",
        resource: { kind: "company", id: "company_shibuya", revision: 1 },
      },
    });

    // Ana pays the company price of the small sencha, and a 10% code comes
    // off it; the large sencha keeps the shop price.
    expect(await prices(await visit(ana))).toEqual([900, shop[1]]);
    expect(await prices(await visit(bo))).toEqual(shop);
    expect(await prices(await Buyer.start(buyer, "company_guest"))).toEqual(
      shop,
    );
    await staff.createCode();
    const withCode = await visit(ana);
    withCode.discountCodes = ["OFFICE10"];
    const quoted = await withCode.quote([catalogLine(SMALL_SENCHA)]);
    expect(quoted.quote.totals).toMatchObject({
      subtotal: jpy(810),
      discount: jpy(90),
    });
    const order = await staff.order(await withCode.pay(quoted));
    expect(
      order.lineItems.map((line) => [
        line.unitPrice.amountMinor,
        line.lineTotal.amountMinor,
      ]),
    ).toEqual([[900, 810]]);

    // What staff cannot save.
    const refusals = {
      secondCompany: await staff.create("company_other", "Other", [anaId]),
      unknownCustomer: await staff.create("company_ghost", "Ghost", [
        "customer_missing",
      ]),
      unknownVariant: await staff.create("company_tins", "Tins", [], {
        currency: "JPY",
        items: [{ variantId: "variant_missing", amountMinor: 500 }],
      }),
      zeroPrice: await staff.create("company_free", "Free", [], {
        currency: "JPY",
        items: [{ variantId: SMALL_SENCHA, amountMinor: 0 }],
      }),
      again: await staff.create("company_shibuya", "Again", []),
      stale: await staff.update("company_shibuya", 3, { name: "Late" }),
    };
    expect(refusals).toMatchObject({
      secondCompany: rejectedWith({ field: "company.customerIds" }),
      unknownCustomer: rejectedWith({
        code: "resource_not_found",
        kind: "customer",
      }),
      unknownVariant: rejectedWith({
        code: "resource_not_found",
        kind: "sellable_variant",
      }),
      zeroPrice: rejectedWith({ code: "invalid_command" }),
      again: rejectedWith({ code: "resource_already_exists" }),
      stale: rejectedWith({ code: "stale_resource_revision" }),
    });

    // An inactive company gives no price; Ana leaves and Bo joins.
    await staff.update("company_shibuya", 1, { status: "inactive" });
    expect(await prices(await visit(ana))).toEqual(shop);
    await staff.update("company_shibuya", 2, {
      status: "active",
      customerIds: [boId],
    });
    expect(await prices(await visit(ana))).toEqual(shop);
    expect(await prices(await visit(bo))).toEqual([900, shop[1]]);

    // At a shipping checkout, too, Bo pays the company price and Ana the
    // shop price.
    const shipped = {
      bo: await shippedCookies(buyer, boShip, "ship_bo"),
      ana: await shippedCookies(buyer, anaShip, "ship_ana"),
    };
    expect(shipped).toEqual({
      bo: { variantId: cookies.variantId, unitPriceMinor: 300 },
      ana: cookies,
    });
    expect(cookies.unitPriceMinor).toBeGreaterThan(300);

    // A paused plugin closes its routes and gives the shop price.
    await staff.pause();
    expect((await admin.listCompanies(merchantId)).ok).toBe(false);
    expect(await prices(await visit(bo))).toEqual(shop);
    await staff.resume();
    expect(await prices(await visit(bo))).toEqual([900, shop[1]]);

    const companies = await required(admin.listCompanies(merchantId));
    expect(
      companies.map((company) => [
        company.id,
        company.revision,
        company.customerIds,
      ]),
    ).toEqual([["company_shibuya", 3, [boId]]]);
    const companyEvents = (
      await required(admin.readEvents(merchantId, { limit: 300 }))
    ).events
      .map((event) => event.kind)
      .filter((kind) => kind.startsWith("company."));
    expect(companyEvents).toEqual([
      "company.created",
      "company.updated",
      "company.updated",
    ]);

    Object.assign(evidence, {
      receipts: staff.receipts,
      shop,
      totals: quoted.quote.totals,
      cookies,
      shipped,
      refusals,
      companies,
      companyEvents,
    });
  } finally {
    writeEvidence("COMPANY_PRICE_ARTIFACT_DIR", "company-prices", evidence);
    backend.close();
  }
}

const SHIPPING_SHOP = "storefront_cookie_store_sg";

/** A signed-in buyer's unit price of two cookies shipped to Singapore. */
async function shippedCookies(
  client: CommerceStorefrontClient,
  access: string,
  name: string,
): Promise<Readonly<{ variantId: string; unitPriceMinor: number }>> {
  const session = await required(
    client.createSession(merchantId, SHIPPING_SHOP, {
      schemaVersion: "underclerk.create-buyer-session.v1",
      buyer: { kind: "identified_customer", customerAccessToken: access },
    }),
  );
  const catalog = await required(
    client.readCatalog(merchantId, SHIPPING_SHOP, session.token),
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
    client.createCart(merchantId, SHIPPING_SHOP, session.token, {
      schemaVersion: "underclerk.create-buyer-cart.v1",
      idempotencyKey: `${name}_cart`,
      lines: [{ kind: "catalog", variantId: listing.variantId, quantity: 2 }],
    }),
  );
  const validation = await required(
    client.validateShippingAddress(merchantId, SHIPPING_SHOP, session.token, {
      schemaVersion: "underclerk.validate-buyer-shipping-address.v1",
      idempotencyKey: `${name}_address`,
      address: {
        countryCode: "SG",
        recipientName: "Office Gifts",
        addressLine1: "1 Raffles Quay",
        locality: "Singapore",
        postalCode: "018956",
      },
    }),
  );
  if (validation.state !== "accepted")
    throw new Error("The Singapore address was not accepted");
  const checkout = await required(
    client.createShippingCheckout(merchantId, SHIPPING_SHOP, session.token, {
      schemaVersion: "underclerk.create-buyer-shipping-checkout.v1",
      idempotencyKey: `${name}_checkout`,
      cartId: cart.cartId,
      cartRevision: cart.revision,
      buyer: { kind: "identified_customer" },
      shippingServiceCode: service.service.code,
      shippingDestination: {
        kind: "provided_address",
        address: validation.address,
        acceptance: {
          kind: "accepted_as_entered",
          addressValidationReference: validation.validationReference,
        },
      },
    }),
  );
  const line = checkout.quote.lines[0];
  if (line === undefined)
    throw new Error("The shipping quote has no cookie line");
  return {
    variantId: listing.variantId,
    unitPriceMinor: line.unitPrice.amountMinor,
  };
}

async function signIn(
  buyer: CommerceStorefrontClient,
  emails: EmailOutbox,
  email: string,
  storefront = STOREFRONT,
): Promise<string> {
  const challenge = await required(
    buyer.requestCustomerSignIn(merchantId, storefront, {
      schemaVersion: "underclerk.request-customer-sign-in.v1",
      email,
    }),
  );
  const code = /\b(\d{6})\b/.exec(emails.sent.at(-1)?.text ?? "")?.[1];
  if (code === undefined) throw new Error("The sign-in email has no code");
  return (
    await required(
      buyer.verifyCustomerSignIn(
        merchantId,
        storefront,
        challenge.challengeId,
        {
          schemaVersion: "underclerk.verify-customer-sign-in.v1",
          code,
        },
      ),
    )
  ).customerAccessToken;
}

class CompanyDesk extends OrderDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "companies");
  }

  async customerOf(orderId: string): Promise<string> {
    const order = await this.order(orderId);
    if (order.buyer.kind !== "identified")
      throw new Error(`${orderId} has no customer`);
    return order.buyer.customerReference;
  }

  create(
    companyId: string,
    name: string,
    customerIds: readonly string[],
    prices: CreateCommerceCompanyV1["prices"] = PRICES,
  ) {
    return this.edit(
      this.admin.createCompany({
        ...this.editBase(`create_${companyId}_${this.step}`),
        companyId,
        name,
        customerIds,
        prices,
      }),
    );
  }

  update(
    companyId: string,
    expectedRevision: number,
    changes: UpdateCommerceCompanyV1["changes"],
  ) {
    return this.edit(
      this.admin.updateCompany({
        ...this.editBase(`update_${companyId}_${this.step}`),
        companyId,
        expectedRevision,
        changes,
      }),
    );
  }

  createCode() {
    return this.edit(
      this.admin.createDiscount({
        ...this.editBase("code_office"),
        discountId: "discount_office",
        title: "Office 10%",
        method: { kind: "code", codes: ["OFFICE10"] },
        rule: {
          kind: "amount_off_order",
          value: { kind: "percentage", basisPoints: 1_000 },
        },
        conditions: {
          minimumSubtotal: null,
          startsAt: NOW,
          endsAt: null,
          usageLimit: null,
          oncePerCustomer: false,
        },
      }),
    );
  }

  async #pluginRevision(): Promise<number> {
    const plugin = (
      await required(this.admin.listPlugins(merchantId))
    ).plugins.find((item) => item.pluginId === "companies");
    if (plugin === undefined) throw new Error("No companies plugin");
    return plugin.revision;
  }

  async pause() {
    return this.edit(
      this.admin.pausePlugin({
        ...this.editBase(`pause_${this.step}`),
        pluginId: "companies",
        expectedRevision: await this.#pluginRevision(),
      }),
    );
  }

  async resume() {
    return this.edit(
      this.admin.resumePlugin({
        ...this.editBase(`resume_${this.step}`),
        pluginId: "companies",
        expectedRevision: await this.#pluginRevision(),
      }),
    );
  }
}
