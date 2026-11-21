import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  CommerceAdminClient,
  parseProductSalesReport,
  parseOrder,
  type CommerceOrderLineItemV1,
  type CommerceOrderV1,
} from "@purin-labs/commerce-client";
import { BuyerSessionAuthority } from "../src/buyer-session.ts";
import { CommerceAuthority } from "../src/commerce-authority.ts";
import {
  writeOrder,
  writeProduct,
  writeVariant,
} from "../src/commerce-persistence.ts";
import { CommerceHttpApi } from "../src/http.ts";
import { createJapanShippingGateway } from "../src/plugins/japan-export/index.ts";
import { NodeCommerceDatabase } from "../src/node-database.ts";
import { initializeCommerceSchema } from "../src/schema.ts";

const START = "2026-09-01T00:00:00.000Z";
const END = "2026-09-08T00:00:00.000Z";
const UPDATED = "2026-09-10T00:00:00.000Z";
const TOKEN = "product-sales-test-service-token";
const URL = `https://commerce.test/v1/admin/merchants/merchant_sales/reports/product-sales?start=${START}&end=${END}`;

it(
  "reports actual line attribution through authenticated HTTP at one snapshot",
  reportThroughHttp,
);
it(
  "refuses missing acceptance evidence and unreconciled discounts without reporting partial totals",
  refuseIncompleteEvidence,
);
it(
  "rejects a successful HTTP response for another merchant",
  rejectOtherMerchantResponse,
);

async function rejectOtherMerchantResponse(): Promise<void> {
  const client = new CommerceAdminClient({
    baseUrl: "https://commerce.test",
    serviceToken: TOKEN,
    fetch: async () =>
      Response.json({
        organisationId: "organisation_sales",
        merchantId: "merchant_other",
        merchantRevision: 1,
        window: { start: START, end: END },
        kind: "unavailable",
        reason: "population_limit",
      }),
  });
  expect(
    await client.readProductSales("merchant_sales", { start: START, end: END }),
  ).toMatchObject({
    ok: false,
    error: { kind: "invalid_response" },
  });
}

async function reportThroughHttp(): Promise<void> {
  const fixture = setup();
  try {
    seedOrder(fixture.db, "order_a", "JPY", START);
    seedOrder(fixture.db, "order_b", "USD", START);
    seedOrder(fixture.db, "order_at_end", "JPY", END);
    seedOrder(fixture.db, "order_cancelled", "JPY", START, true);
    expect((await fixture.api.fetch(URL)).status).toBe(401);
    const invalid = await fixture.api.fetch(
      URL.replace(`end=${END}`, `end=${START}`),
      headers(),
    );
    expect(invalid.status).toBe(422);
    const response = await fixture.api.fetch(URL, headers());
    expect(response.status).toBe(200);
    const report = await response.json();
    const client = new CommerceAdminClient({
      baseUrl: "https://commerce.test",
      serviceToken: TOKEN,
      fetch: fixture.api.fetch,
    });
    expect(
      await client.readProductSales("merchant_sales", {
        start: START,
        end: END,
      }),
    ).toEqual({ ok: true, value: report });
    const typed = parseProductSalesReport(report);
    if (typed.kind !== "reported") throw new Error("expected report");
    expect(() =>
      parseProductSalesReport({ ...typed, orderCount: 99 }),
    ).toThrow();
    expect(() =>
      parseProductSalesReport({
        ...typed,
        groups: [...typed.groups, ...typed.groups],
      }),
    ).toThrow();
    expect(report).toMatchObject({
      kind: "reported",
      organisationId: "organisation_sales",
      merchantId: "merchant_sales",
      merchantRevision: 1,
      metric: "booked_merchandise_before_refunds",
      population: "accepted_non_cancelled_orders",
      orderCount: 2,
      window: { start: START, end: END },
      ordersWithAdjustments: ["order_a", "order_b"],
      groups: [
        { productId: "product_a", currency: "JPY", merchandiseMinor: 1500 },
        { productId: "product_b", currency: "JPY", merchandiseMinor: 2000 },
        { productId: "product_a", currency: "USD", merchandiseMinor: 1500 },
        { productId: "product_b", currency: "USD", merchandiseMinor: 2000 },
      ],
      unmatchedLines: [
        {
          orderId: "order_a",
          lineId: "unknown",
          currency: "JPY",
          merchandiseMinor: 500,
          reason: "source_only",
        },
        {
          orderId: "order_b",
          lineId: "unknown",
          currency: "USD",
          merchandiseMinor: 500,
          reason: "source_only",
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain("private-buyer");
    expect(await (await fixture.api.fetch(URL, headers())).json()).toEqual(
      report,
    );
    const missing = await fixture.api.fetch(
      URL.replace("merchant_sales", "merchant_other"),
      headers(),
    );
    expect(missing.status).toBe(404);
  } finally {
    fixture.authority.close();
  }
}

async function refuseIncompleteEvidence(): Promise<void> {
  const fixture = setup();
  try {
    seedOrder(fixture.db, "order_a", "JPY", START);
    fixture.db
      .prepare("UPDATE buyer_checkout SET lifecycle_state = 'payment_pending'")
      .run();
    expect(
      await (await fixture.api.fetch(URL, headers())).json(),
    ).toMatchObject({ kind: "unavailable", reason: "acceptance_time_missing" });
    fixture.db
      .prepare("UPDATE buyer_checkout SET lifecycle_state = 'accepted'")
      .run();
    const order = orderFixture("order_a", "JPY", false);
    writeOrder(fixture.db, "merchant_sales", {
      ...order,
      totals: {
        ...order.totals,
        discount: { amountMinor: 200, currency: "JPY" },
      },
    });
    expect(
      await (await fixture.api.fetch(URL, headers())).json(),
    ).toMatchObject({
      kind: "unavailable",
      reason: "money_basis_unreconciled",
    });
  } finally {
    fixture.authority.close();
  }
}

function headers(): RequestInit {
  return { headers: { authorization: `Bearer ${TOKEN}` } };
}

function setup() {
  const db = new NodeCommerceDatabase(":memory:");
  initializeCommerceSchema(db, START);
  db.prepare(
    "INSERT INTO merchant (merchant_id, external_reference, revision, created_at, updated_at) VALUES ('merchant_sales', 'organisation_sales', 1, ?, ?)",
  ).run(START, START);
  db.prepare(
    "INSERT INTO sales_channel (merchant_id, resource_id, revision, name, kind, lifecycle_state, lifecycle_json, occurred_at) VALUES ('merchant_sales', 'channel', 1, 'Online', 'online', 'active', ?, ?)",
  ).run(JSON.stringify({ state: "active", activeAt: START }), START);
  db.prepare(
    `INSERT INTO storefront (merchant_id, storefront_id, revision, name, sales_channel_id,
    fulfillment_kind, fulfillment_json, checkout_json, lifecycle_state, lifecycle_json)
    VALUES ('merchant_sales', 'storefront', 1, 'Store', 'channel', 'pickup', ?, ?, 'active', ?)`,
  ).run(
    JSON.stringify({
      kind: "pickup",
      locationId: "location",
      readyLeadTimeSeconds: 900,
    }),
    JSON.stringify({
      quoteTtlSeconds: 900,
      tax: { kind: "percentage", basisPoints: 1000 },
    }),
    JSON.stringify({ state: "active", activeAt: START }),
  );
  db.prepare(
    `INSERT INTO checkout_profile_revision (merchant_id, checkout_profile_id, revision, name,
    configuration_json, lifecycle_state, lifecycle_json, recorded_at)
    VALUES ('merchant_sales', 'profile', 1, 'Profile', '{}', 'published', ?, ?)`,
  ).run(
    JSON.stringify({
      state: "published",
      publishedAt: START,
      publishedBy: "owner",
    }),
    START,
  );
  for (const id of ["a", "b"]) {
    writeProduct(db, "merchant_sales", {
      id: `product_${id}`,
      revision: 1,
      title: id,
      description: "Product",
      handle: null,
      productType: "",
      vendor: "",
      tags: [],
      status: "active",
      occurredAt: START,
    });
    writeVariant(db, "merchant_sales", {
      id: `variant_${id}`,
      revision: 1,
      productId: `product_${id}`,
      sku: id,
      title: id,
      options: [],
      media: [],
      barcode: null,
      status: "active",
      occurredAt: START,
    });
  }
  const authority = new CommerceAuthority({
    database: db,
    signer: new TestSigner(),
    paymentGateway: new UnusedGateway(),
    now: now,
    shippingGateway: createJapanShippingGateway("sales-test-carrier"),
  });
  const api = new CommerceHttpApi({
    authority,
    serviceToken: TOKEN,
    buyerSessions: new BuyerSessionAuthority({
      secret: "sales-test-buyer-session-secret-at-least-32",
      now,
    }),
  });
  return { db, authority, api };
}

function seedOrder(
  db: NodeCommerceDatabase,
  id: string,
  currency: string,
  acceptedAt: string,
  cancelled = false,
): void {
  writeOrder(db, "merchant_sales", orderFixture(id, currency, cancelled));
  db.prepare(
    `INSERT INTO buyer_cart (merchant_id, cart_id, storefront_id, checkout_profile_id,
    checkout_profile_revision, buyer_session_digest, revision, lifecycle_state, lifecycle_json)
    VALUES ('merchant_sales', ?, 'storefront', 'profile', 1, ?, 1, 'submitted', ?)`,
  ).run(
    `cart_${id}`,
    "0".repeat(64),
    JSON.stringify({ state: "submitted", submittedAt: acceptedAt }),
  );
  // Seed the persisted acceptance projection; the report reads no cart or payment fields.
  db.prepare(
    `INSERT INTO buyer_checkout (merchant_id, checkout_id, source_kind, storefront_id, cart_id,
    buyer_session_digest, checkout_profile_id, checkout_profile_revision, revision, lifecycle_state, quote_digest, checkout_json)
    VALUES ('merchant_sales', ?, 'online', 'storefront', ?, ?, 'profile', 1, 1, 'accepted', 'quote', ?)`,
  ).run(
    `checkout_${id}`,
    `cart_${id}`,
    "0".repeat(64),
    JSON.stringify({
      lifecycle: { state: "accepted", orderId: id, acceptedAt },
    }),
  );
}

function orderFixture(
  id: string,
  currency: string,
  cancelled: boolean,
): CommerceOrderV1 {
  return parseOrder({
    id,
    revision: 2,
    occurredAt: UPDATED,
    origin: {
      kind: "online",
      salesChannelId: "channel",
      storefrontId: "storefront",
      checkoutId: `checkout_${id}`,
      configuration: { kind: "external_authority" },
    },
    buyer: { kind: "identified", customerReference: "private-buyer" },
    lineItems: [
      line("a", "variant_a", 1000, 100, currency),
      line("b", "variant_b", 2000, 0, currency),
      line("a_again", "variant_a", 600, 0, currency),
      line("unknown", null, 500, 0, currency),
    ],
    totals: {
      subtotal: money(4100, currency),
      discount: money(100, currency),
      tax: money(400, currency),
      duty: money(0, currency),
      shipping: money(300, currency),
      serviceFee: money(0, currency),
      tip: money(0, currency),
      rounding: money(0, currency),
      total: money(4700, currency),
    },
    adjustments: [
      {
        id: "refund",
        kind: "refund",
        status: "completed",
        occurredAt: UPDATED,
        amount: money(200, currency),
        reason: "Partial refund",
      },
    ],
    lifecycle: cancelled
      ? { state: "cancelled", cancelledAt: UPDATED, reason: "Cancelled" }
      : { state: "fulfilled", fulfilledAt: UPDATED },
  });
}

function line(
  id: string,
  variantId: string | null,
  gross: number,
  discount: number,
  currency: string,
): CommerceOrderLineItemV1 {
  return {
    id,
    sku: id,
    title: id,
    quantity: { amount: 1, scale: 0, unit: "each" },
    fulfilledQuantity: { amount: 1, scale: 0, unit: "each" },
    source:
      variantId === null
        ? { kind: "source_only", sourceItemReference: id }
        : {
            kind: "catalog",
            variantId,
            variantRevision: 1,
            merchantCode: id,
            optionValues: [],
            offerId: `offer_${id}`,
            offerRevision: 1,
            consumptionPlanId: "plan",
            consumptionPlanRevision: 1,
            inventory: { kind: "untracked" },
          },
    unitPrice: money(gross, currency),
    discount: money(discount, currency),
    tax: money(0, currency),
    lineTotal: money(gross - discount, currency),
  };
}

function money(amountMinor: number, currency: string) {
  return { amountMinor, currency };
}
function now(): string {
  return UPDATED;
}
class TestSigner {
  readonly keyId = "sales-test-signer";
  readonly publicKeyB64 = Buffer.alloc(32, 9).toString("base64url");
  sign(payload: Uint8Array): string {
    return createHash("sha256").update(payload).digest("hex");
  }
}
class UnusedGateway {
  async binding(): Promise<never> {
    throw new Error("Payment gateway unused");
  }
  async createSession(): Promise<never> {
    throw new Error("Payment gateway unused");
  }
  async reconcile(): Promise<never> {
    throw new Error("Payment gateway unused");
  }
  async refund(): Promise<never> {
    throw new Error("Payment gateway unused");
  }
}
