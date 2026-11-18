import { describe, expect, it, vi } from "vitest";

import worker from "../src/worker.ts";

const SERVICE_TOKEN = "underclerk_worker_route_service_token";
const BUYER_TOKEN = "buyer_session_token";
const MERCHANT_ID = "merchant_worker_route";
const FORWARD_URL =
  "https://underclerk.test/v1/public/merchants/merchant_worker_route/storefronts/storefront_cafe";

describe("Underclerk outer Worker route guard", () => {
  it("forwards buyer cart and address-validation routes with buyer auth", async () => {
    const fixture = routeFixture();

    const cart = await worker.fetch(
      new Request(`${FORWARD_URL}/carts`, {
        method: "POST",
        headers: { authorization: `Bearer ${BUYER_TOKEN}` },
      }),
      fixture.env,
    );
    const addressValidation = await worker.fetch(
      new Request(`${FORWARD_URL}/address-validations`, {
        method: "POST",
        headers: { authorization: `Bearer ${BUYER_TOKEN}` },
      }),
      fixture.env,
    );
    const cartItem = await worker.fetch(
      new Request(`${FORWARD_URL}/carts/cart_123`, {
        headers: { authorization: `Bearer ${BUYER_TOKEN}` },
      }),
      fixture.env,
    );

    expect(cart.status).toBe(204);
    expect(addressValidation.status).toBe(204);
    expect(cartItem.status).toBe(204);
    expect(fixture.forwarded).toHaveLength(3);
    expect(fixture.forwarded.map((request) => request.url)).toEqual([
      `${FORWARD_URL}/carts`,
      `${FORWARD_URL}/address-validations`,
      `${FORWARD_URL}/carts/cart_123`,
    ]);
    expect(
      fixture.forwarded.every(
        (request) =>
          request.headers.get("authorization") === `Bearer ${BUYER_TOKEN}`,
      ),
    ).toBe(true);
  });

  // The guard follows the route table: these public routes were refused
  // while the Worker kept its own list of buyer paths.
  it("forwards every buyer route of the route table", async () => {
    const fixture = routeFixture();
    const requests = [
      new Request(`${FORWARD_URL}/collections`),
      new Request(`${FORWARD_URL}/media/media_tea_tin`),
      new Request(`${FORWARD_URL}/customer-sign-ins`, { method: "POST" }),
      new Request(
        `${FORWARD_URL}/checkouts/checkout_1/order/balance-checkouts`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${BUYER_TOKEN}` },
        },
      ),
    ];
    const statuses = [];
    for (const request of requests)
      statuses.push((await worker.fetch(request, fixture.env)).status);

    expect(statuses).toEqual([204, 204, 204, 204]);
    expect(fixture.forwarded).toHaveLength(4);
  });

  // The merchant object decides each admin credential (Plan 76 phase 2);
  // the gateway refuses only what no credential could open.
  it("refuses arbitrary public paths and admin paths with no bearer token", async () => {
    const fixture = routeFixture();

    const arbitraryPublic = await worker.fetch(
      new Request(`${FORWARD_URL}/private`, {
        headers: { authorization: `Bearer ${BUYER_TOKEN}` },
      }),
      fixture.env,
    );
    const arbitraryAdmin = await worker.fetch(
      new Request(
        "https://underclerk.test/v1/admin/merchants/merchant_worker_route/snapshot",
        { headers: { authorization: `Basic ${BUYER_TOKEN}` } },
      ),
      fixture.env,
    );

    expect(arbitraryPublic.status).toBe(401);
    expect(arbitraryAdmin.status).toBe(401);
    expect(fixture.forwarded).toHaveLength(0);
  });
});

function routeFixture(): {
  readonly env: Parameters<typeof worker.fetch>[1];
  readonly forwarded: Request[];
} {
  const forwarded: Request[] = [];
  const stub = {
    get __DURABLE_OBJECT_BRAND(): never {
      throw new Error("Unexpected Durable Object RPC access");
    },
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      forwarded.push(request);
      return new Response(null, { status: 204 });
    },
    connect: () => {
      throw new Error("Unexpected Durable Object socket connection");
    },
    id: {
      toString: () => "underclerk_worker_route_id",
      equals: () => false,
    },
  };
  const namespace = {
    newUniqueId: () => stub.id,
    idFromName: () => stub.id,
    idFromString: () => stub.id,
    get: () => stub,
    getByName: vi.fn((name: string) => {
      expect(name).toBe(`${MERCHANT_ID}:g2`);
      return stub;
    }),
    jurisdiction: () => namespace,
  };
  const env = {
    UNDERCLERK_MERCHANT: namespace,
    UNDERCLERK_SERVICE_TOKEN: SERVICE_TOKEN,
    UNDERCLERK_BUYER_SESSION_SECRET: "underclerk_worker_route_buyer_secret",
    UNDERCLERK_SIGNING_KEY_ID: "underclerk_worker_route_signing_key",
    UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64:
      "underclerk_worker_route_private_key",
    JAPAN_CARRIER_SIGNING_KEY: "underclerk_worker_route_carrier_key",
  };
  return { env, forwarded };
}
