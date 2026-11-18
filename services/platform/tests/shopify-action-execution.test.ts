/// <reference types="@cloudflare/workers-types" />

import type { CanonicalAction } from "@seams/contracts";
import { describe, expect, it } from "vitest";

import {
  buildGeneratedActionDraft,
  buildGeneratedShopifyRequest,
  matchGeneratedActionRoute,
  parseGeneratedActionCall,
  type GeneratedShopifyActionCall,
} from "../src/generated/action-registry";
import { parseSessionId, parseOrganisationId } from "../src/ids";
import {
  executeShopifyAction,
  materializeShopifyWriteCredential,
  reconcileShopifyOrderCancellation,
  type ShopifyWriteCredential,
} from "../src/shopify/action-execution";

describe("Shopify typed action execution", function shopifyExecutionSuite() {
  it("accepts only the generated order-cancel argument shape", function parsesTypedCall() {
    const route = matchGeneratedActionRoute(
      "POST",
      "/v1/actions/shopify/order.cancel",
    );

    expect(route).toEqual({
      kind: "shopify_order_cancel",
      tool: "satyr-shopify-order-cancel",
    });

    if (route === null) {
      throw new Error("missing Shopify route");
    }

    expect(
      parseGeneratedActionCall(route, {
        ...shopifyCall().args,
        query: "mutation { productDelete(input: {}) { deletedProductId } }",
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_action_args", field: "input" },
    });
  });

  it("builds a fixed GraphQL document and strict approved variables", function buildsTrustedRequest() {
    const request = buildGeneratedShopifyRequest(shopifyCall());

    expect(request.host).toBe("fixture.myshopify.com");
    expect(request.path).toBe("/admin/api/2026-07/graphql.json");
    expect(request.body.query).toContain("mutation SatyrOrderCancel");
    expect(request.body.query).toContain("orderCancel(");
    expect(request.body.query).not.toContain("productDelete");
    expect(request.body.variables).toEqual({
      orderId: "gid://shopify/Order/42",
      reason: "CUSTOMER",
      refundMethod: { originalPaymentMethodsRefund: true },
      restock: true,
      notifyCustomer: true,
      staffNote: "Customer requested cancellation.",
    });
  });

  it("sends the fixed mutation with only the Shopify access-token header", async function executesCancellation() {
    const call = shopifyCall();
    const result = await executeShopifyAction({
      action: await canonicalAction(call),
      call,
      credential: shopifyCredential(),
      fetcher: confirmedShopifyFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "confirmed",
        actionKind: "shopify_order_cancel",
        provider: "shopify",
        statusCode: 200,
        orderId: "gid://shopify/Order/42",
        jobId: "gid://shopify/Job/job-42",
        jobDone: false,
      },
    });
  });

  it("models Shopify user errors as a failed provider receipt", async function readsUserErrors() {
    const call = shopifyCall();
    const result = await executeShopifyAction({
      action: await canonicalAction(call),
      call,
      credential: shopifyCredential(),
      fetcher: failedShopifyFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "failed",
        provider: "shopify",
        statusCode: 200,
        errors: [
          {
            field: "orderId",
            code: "INVALID",
            message: "Order cannot be canceled.",
          },
        ],
      },
    });
  });

  it("holds transport ambiguity without manufacturing a safe retry", async function holdsAmbiguity() {
    const call = shopifyCall();
    const result = await executeShopifyAction({
      action: await canonicalAction(call),
      call,
      credential: shopifyCredential(),
      fetcher: unavailableShopifyFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "indeterminate",
        provider: "shopify",
        reason: "transport_failure",
      },
    });
  });

  it("holds an invalid post-dispatch response for reconciliation", async function holdsInvalidResponse() {
    const call = shopifyCall();
    const result = await executeShopifyAction({
      action: await canonicalAction(call),
      call,
      credential: shopifyCredential(),
      fetcher: malformedShopifyMutationFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "indeterminate",
        provider: "shopify",
        reason: "response_invalid",
      },
    });
  });

  it("confirms cancellation from a read-only order lookup", async function reconcilesCancelledOrder() {
    const result = await reconcileShopifyOrderCancellation({
      credential: shopifyCredential(),
      orderId: "gid://shopify/Order/42",
      fetcher: cancelledOrderLookupFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "cancelled",
        provider: "shopify",
        orderId: "gid://shopify/Order/42",
        cancelledAt: "2026-08-23T04:05:06Z",
        cancelReason: "CUSTOMER",
      },
    });
  });

  it("verifies an order remains uncancelled from a read-only lookup", async function reconcilesActiveOrder() {
    const result = await reconcileShopifyOrderCancellation({
      credential: shopifyCredential(),
      orderId: "gid://shopify/Order/42",
      fetcher: activeOrderLookupFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "not_cancelled",
        provider: "shopify",
        orderId: "gid://shopify/Order/42",
      },
    });
  });

  it("keeps an unavailable order lookup indeterminate", async function reconcilesUnavailableOrder() {
    const result = await reconcileShopifyOrderCancellation({
      credential: shopifyCredential(),
      orderId: "gid://shopify/Order/42",
      fetcher: unavailableShopifyFetch,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        kind: "indeterminate",
        provider: "shopify",
        reason: "transport_failure",
      },
    });
  });

  it("rejects a malformed cancellation lookup response", async function rejectsMalformedLookup() {
    const result = await reconcileShopifyOrderCancellation({
      credential: shopifyCredential(),
      orderId: "gid://shopify/Order/42",
      fetcher: malformedOrderLookupFetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "shopify_reconciliation_response_invalid" },
    });
  });

  it("uses the OAuth bearer stored during Shopify onboarding", async function usesStoredBearer() {
    const credential = await materializeShopifyWriteCredential({
      secret: { kind: "bearer", value: "shopify-oauth-access-token" },
      shopDomain: "fixture.myshopify.com",
      fetcher: unexpectedShopifyFetch,
      now: 1_000,
    });

    expect(credential).toEqual({
      ok: true,
      value: {
        accessToken: "shopify-oauth-access-token",
        shopDomain: "fixture.myshopify.com",
      },
    });
  });

  it("rejects malformed credentials before provider I/O", async function rejectsCredential() {
    const call = shopifyCall();
    const result = await executeShopifyAction({
      action: await canonicalAction(call),
      call,
      credential: {
        shopDomain: "fixture.myshopify.com",
        accessToken: "short",
      },
      fetcher: unexpectedShopifyFetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "shopify_write_credential_invalid" },
    });
  });

  it("rejects a connector credential bound to another shop", async function rejectsShopMismatch() {
    const call = shopifyCall();
    const result = await executeShopifyAction({
      action: await canonicalAction(call),
      call,
      credential: shopifyCredentialForDomain("other-shop.myshopify.com"),
      fetcher: unexpectedShopifyFetch,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "shopify_shop_mismatch" },
    });
  });
});

async function confirmedShopifyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  expect(String(input)).toBe(
    "https://fixture.myshopify.com/admin/api/2026-07/graphql.json",
  );
  const headers = new Headers(init?.headers);
  expect(headers.get("x-shopify-access-token")).toBe("shopify-test-token-42");
  expect(headers.get("authorization")).toBeNull();
  const body: unknown = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    query: expect.stringContaining("mutation SatyrOrderCancel"),
    variables: { orderId: "gid://shopify/Order/42" },
  });
  return Response.json({
    data: {
      orderCancel: {
        job: { id: "gid://shopify/Job/job-42", done: false },
        orderCancelUserErrors: [],
      },
    },
  });
}

async function cancelledOrderLookupFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  expect(String(input)).toBe(
    "https://fixture.myshopify.com/admin/api/2026-07/graphql.json",
  );
  const body: unknown = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    query: expect.stringContaining(
      "query SatyrOrderCancellationReconciliation",
    ),
    variables: { orderId: "gid://shopify/Order/42" },
  });
  expect(body).toMatchObject({
    query: expect.not.stringContaining("mutation"),
  });
  return Response.json({
    data: {
      order: {
        id: "gid://shopify/Order/42",
        cancelledAt: "2026-08-23T04:05:06Z",
        cancelReason: "CUSTOMER",
      },
    },
  });
}

async function activeOrderLookupFetch(): Promise<Response> {
  return Response.json({
    data: {
      order: {
        id: "gid://shopify/Order/42",
        cancelledAt: null,
        cancelReason: null,
      },
    },
  });
}

async function malformedOrderLookupFetch(): Promise<Response> {
  return Response.json({
    data: {
      order: {
        id: "gid://shopify/Order/42",
        cancelledAt: "2026-08-23T04:05:06Z",
        cancelReason: null,
      },
    },
  });
}

async function failedShopifyFetch(): Promise<Response> {
  return Response.json({
    data: {
      orderCancel: {
        job: null,
        orderCancelUserErrors: [
          {
            field: ["orderId"],
            code: "INVALID",
            message: "Order cannot be canceled.",
          },
        ],
      },
    },
  });
}

async function malformedShopifyMutationFetch(): Promise<Response> {
  return Response.json({ data: { orderCancel: { job: null } } });
}

async function unavailableShopifyFetch(): Promise<Response> {
  throw new Error("provider unavailable after request dispatch");
}

async function unexpectedShopifyFetch(): Promise<Response> {
  throw new Error("invalid credential reached provider fetch");
}

function shopifyCall(): GeneratedShopifyActionCall {
  return {
    kind: "shopify_order_cancel",
    tool: "satyr-shopify-order-cancel",
    args: {
      shopDomain: "fixture.myshopify.com",
      orderId: "gid://shopify/Order/42",
      cancelReason: "CUSTOMER",
      refundOriginal: true,
      restock: true,
      notifyCustomer: true,
      staffNote: "Customer requested cancellation.",
    },
  };
}

async function canonicalAction(
  call: GeneratedShopifyActionCall,
): Promise<CanonicalAction> {
  const organisationId = parseOrganisationId("organisation_shopify_action");
  const sessionId = parseSessionId("session_shopify_action");
  const draft = await buildGeneratedActionDraft(call);

  if (!organisationId.ok || !sessionId.ok) {
    throw new Error("invalid Shopify action fixture");
  }

  return {
    organisationId: organisationId.value,
    integrationAccountId: "integration_shopify_action",
    threadId: "slack:T:C:2.0",
    sessionId: sessionId.value,
    host: draft.host,
    verb: draft.verb,
    path: draft.path,
    argsHash: draft.argsHash,
    amount: draft.amount,
    nonce: { value: "98ed03e0-f1bd-4f5e-9dd5-b7334332fbac" },
    exp: 10_000,
    resourceKey: draft.resourceKey,
  };
}

function shopifyCredential(): ShopifyWriteCredential {
  return shopifyCredentialForDomain("fixture.myshopify.com");
}

function shopifyCredentialForDomain(
  shopDomain: string,
): ShopifyWriteCredential {
  return {
    shopDomain,
    accessToken: "shopify-test-token-42",
  };
}
