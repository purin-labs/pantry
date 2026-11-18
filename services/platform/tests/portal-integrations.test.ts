import { describe, expect, it } from "vitest";

import {
  readPortalRoute,
  workspaceResourcePath,
} from "../../../apps/portal/src/route";

describe("portal integrations route", () => {
  it("selects workspace operations pages without changing the organisation identity", () => {
    expect(readPortalRoute("/portal")).toEqual({ kind: "organisation_list" });
    expect(readPortalRoute("/portal/cafe-central")).toEqual({
      kind: "organisation",
      organisationHandle: "cafe-central",
    });
    expect(
      readPortalRoute("/portal/cafe-central/main/suppliers/packaging_supply"),
    ).toEqual({
      kind: "workspace",
      organisationHandle: "cafe-central",
      workspaceHandle: "main",
      destination: {
        kind: "resource",
        page: "suppliers",
        resourceId: "packaging_supply",
      },
    });
    expect(
      readPortalRoute("/portal/cafe-central/main/products/product_1"),
    ).toEqual({
      kind: "workspace",
      organisationHandle: "cafe-central",
      workspaceHandle: "main",
      destination: {
        kind: "resource",
        page: "products",
        resourceId: "product_1",
      },
    });
    expect(
      readPortalRoute(
        "/portal/cafe-central/main/products/gid%253A%252F%252Fshopify%252FProduct%252F42",
      ),
    ).toEqual({
      kind: "workspace",
      organisationHandle: "cafe-central",
      workspaceHandle: "main",
      destination: {
        kind: "resource",
        page: "products",
        resourceId: "gid://shopify/Product/42",
      },
    });
    expect(
      readPortalRoute(
        "/portal/cafe-central/main/orders/gid%253A%252F%252Fshopify%252FOrder%252F43",
      ),
    ).toEqual({
      kind: "workspace",
      organisationHandle: "cafe-central",
      workspaceHandle: "main",
      destination: {
        kind: "resource",
        page: "orders",
        resourceId: "gid://shopify/Order/43",
      },
    });
    expect(readPortalRoute("/portal/cafe-central/main/products/%")).toEqual({
      kind: "not_found",
      organisationHandle: "cafe-central",
      workspaceHandle: "main",
    });
    expect(readPortalRoute("/portal/%/orders")).toEqual({
      kind: "not_found",
      organisationHandle: null,
      workspaceHandle: null,
    });
    expect(readPortalRoute("/portal/cafe-central/main/unknown")).toEqual({
      kind: "not_found",
      organisationHandle: "cafe-central",
      workspaceHandle: "main",
    });
    expect(
      workspaceResourcePath(
        "cafe-central",
        "main",
        "customer_order",
        "gid://shopify/Order/43",
      ),
    ).toBe(
      "/portal/cafe-central/main/orders/gid%253A%252F%252Fshopify%252FOrder%252F43",
    );
  });
});
