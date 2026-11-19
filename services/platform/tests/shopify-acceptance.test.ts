/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";

import { triggerShopifyDevelopmentOrder } from "../src/shopify/acceptance";
import { isRecord } from "@purin-labs/std";

type CapturedShopifyAcceptanceRequest = {
  body: Record<string, unknown>;
  url: string;
};

let capturedRequests: CapturedShopifyAcceptanceRequest[] = [];
let capturedFetcherReceiver: unknown = null;

describe("Shopify M8 acceptance trigger", function shopifyAcceptanceSuite() {
  it(
    "creates one fixed order after proving the shop is a development store",
    triggersOrder,
  );
  it(
    "rejects a production shop before the order mutation",
    rejectsProductionShop,
  );
});

async function triggersOrder(): Promise<void> {
  capturedRequests = [];
  capturedFetcherReceiver = null;
  const result = await triggerShopifyDevelopmentOrder({
    shopDomain: "fixture.myshopify.com",
    accessToken: "shopify-offline-token",
    sourceIdentifier: "satyr-m8-00000000-0000-4000-8000-000000000042",
    fetcher: developmentShopFetch,
  });

  expect(result).toEqual({
    ok: true,
    value: {
      kind: "development_order_submitted",
      provider: "shopify",
      shopDomain: "fixture.myshopify.com",
      sourceIdentifier: "satyr-m8-00000000-0000-4000-8000-000000000042",
    },
  });
  expect(capturedFetcherReceiver).toBeUndefined();
  expect(capturedRequests).toHaveLength(3);
  expect(capturedRequests[1]?.body).toMatchObject({
    variables: { query: "sku:SATYR-CK4-20260809" },
  });
  expect(capturedRequests[2]?.body).toMatchObject({
    variables: {
      order: {
        currency: "USD",
        financialStatus: "PENDING",
        lineItems: [
          {
            quantity: 1,
            variantId: "gid://shopify/ProductVariant/7002",
          },
        ],
        sourceIdentifier: "satyr-m8-00000000-0000-4000-8000-000000000042",
        tags: ["satyr-m8-acceptance"],
        test: true,
      },
    },
  });
  expect(String(capturedRequests[2]?.body.query)).not.toContain(
    "order { id name }",
  );
}

async function rejectsProductionShop(): Promise<void> {
  capturedRequests = [];
  const result = await triggerShopifyDevelopmentOrder({
    shopDomain: "fixture.myshopify.com",
    accessToken: "shopify-offline-token",
    sourceIdentifier: "satyr-m8-00000000-0000-4000-8000-000000000043",
    fetcher: productionShopFetch,
  });

  expect(result).toEqual({
    ok: false,
    error: { code: "shopify_acceptance_store_not_development" },
  });
  expect(capturedRequests).toHaveLength(1);
}

async function developmentShopFetch(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  capturedFetcherReceiver = this;
  const request = captureRequest(input, init);

  if (String(request.body.query).includes("SatyrAcceptanceShopPlan")) {
    return Response.json({
      data: { shop: { plan: { partnerDevelopment: true } } },
    });
  }

  if (String(request.body.query).includes("SatyrAcceptanceVariant")) {
    return Response.json({
      data: {
        productVariants: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/7002",
              sku: "SATYR-CK4-20260809",
            },
          ],
        },
      },
    });
  }

  return Response.json({
    data: {
      orderCreate: {
        userErrors: [],
      },
    },
  });
}

async function productionShopFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  captureRequest(input, init);
  return Response.json({
    data: { shop: { plan: { partnerDevelopment: false } } },
  });
}

function captureRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): CapturedShopifyAcceptanceRequest {
  const rawBody = typeof init?.body === "string" ? init.body : "";
  const parsed: unknown = JSON.parse(rawBody);

  if (!isRecord(parsed)) {
    throw new Error("invalid Shopify acceptance request fixture");
  }

  const request = { body: parsed, url: String(input) };
  capturedRequests.push(request);
  expect(request.url).toBe(
    "https://fixture.myshopify.com/admin/api/2026-07/graphql.json",
  );
  expect(new Headers(init?.headers).get("x-shopify-access-token")).toBe(
    "shopify-offline-token",
  );
  return request;
}
