import { describe, expect, it } from "vitest";
import {
  CommerceAdminClient,
  type ProductSalesReport,
} from "@purin-labs/commerce-client";
import type { AccessGrant } from "../src/authorization/access-grants/types";
import { selectNamedCommerceQuerySourceGrant } from "../src/commerce/entity-plane/context-read";
import {
  PRODUCT_SALES_SOURCE_TYPES,
  productSalesGrantProbe,
  readBoundProductSales,
} from "../src/commerce/entity-plane/product-sales-report";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { fixtureRequestAuthority } from "./fixtures/plan25-turn";

const NOW = "2026-09-08T00:00:00.000Z";
const ORGANISATION = "organisation_sales";
const MERCHANT = "merchant_sales";

describe("merchant product sales", () => {
  it("rejects a response from another organisation", async () => {
    await expect(
      readBoundProductSales({
        client: client({ ...report(), organisationId: "organisation_other" }),
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
        now: NOW,
      }),
    ).rejects.toThrow("organisation binding mismatch");
  });

  it("requires restricted full-type read authority for each attribution source", () => {
    const parsed = parseOrganisationId(ORGANISATION);
    if (!parsed.ok) throw new Error("fixture organisation invalid");
    const authority = fixtureRequestAuthority(parsed.value, "connector_sales");
    for (const typeId of PRODUCT_SALES_SOURCE_TYPES) {
      const grant: AccessGrant = {
        grantId: `grant_sales_${typeId}`,
        organisationId: parsed.value,
        subject: { kind: "person", personId: authority.requesterPersonId },
        target: {
          kind: "commerce_read",
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
          scope: {
            kind: "entity_type",
            entityTypeId: { origin: "system", typeId },
          },
        },
        provenance: {
          kind: "integration_setup",
          integrationAccountId: "integration_sales",
          setupRevision: 1,
          materializationReceiptId: "receipt_sales",
        },
        lifecycle: { kind: "active", revision: 1, activatedAt: 1 },
      };
      const input = {
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
        grants: [grant],
        requestAuthority: authority,
        causationId: "turn_sales",
        query: productSalesGrantProbe(typeId),
        allowedSensitivity: "restricted" as const,
        now: NOW,
      };
      expect(selectNamedCommerceQuerySourceGrant(input).ok).toBe(true);
      expect(
        selectNamedCommerceQuerySourceGrant({ ...input, grants: [] }).ok,
      ).toBe(false);
      expect(
        selectNamedCommerceQuerySourceGrant({
          ...input,
          requestAuthority: { ...authority, role: "viewer" },
        }).ok,
      ).toBe(false);
    }
  });
});

function client(value: ProductSalesReport): CommerceAdminClient {
  return new CommerceAdminClient({
    baseUrl: "https://commerce.test",
    serviceToken: "test-token",
    fetch: respond.bind(null, value),
  });
}

async function respond(
  value: ProductSalesReport,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  expect(url.pathname).toBe(
    `/v1/admin/merchants/${MERCHANT}/reports/product-sales`,
  );
  expect(url.searchParams.get("start")).toBe("2026-09-01T00:00:00.000Z");
  expect(url.searchParams.get("end")).toBe(NOW);
  return Response.json(value);
}

function report(): ProductSalesReport {
  return {
    kind: "reported",
    organisationId: ORGANISATION,
    merchantId: MERCHANT,
    merchantRevision: 8,
    window: { start: "2026-09-01T00:00:00.000Z", end: NOW },
    metric: "booked_merchandise_before_refunds",
    population: "accepted_non_cancelled_orders",
    groups: [
      {
        productId: "product_bread",
        currency: "JPY",
        merchandiseMinor: 1800,
        lines: [
          {
            orderId: "order_bread",
            orderRevision: 2,
            lineId: "line_bread",
            acceptedAt: "2026-09-07T00:00:00.000Z",
          },
        ],
      },
    ],
    unmatchedLines: [],
    ordersWithAdjustments: ["order_bread"],
    orderCount: 1,
  };
}
