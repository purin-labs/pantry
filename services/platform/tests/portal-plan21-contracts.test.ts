import { describe, expect, it } from "vitest";

import {
  readPortalRoute,
  WORKSPACE_NAVIGATION_GROUPS,
  workspacePagePath,
  workspaceResourcePath,
} from "../../../apps/portal/src/route";

const ORGANISATION_HANDLE = "pantry-cafes";
const WORKSPACE_HANDLE = "cafe-central";

describe("Café Plan 21 contracts", () => {
  it("round-trips every navigable page through one route descriptor", () => {
    expect(readPortalRoute("/portal")).toEqual({ kind: "organisation_list" });
    expect(readPortalRoute(`/portal/${ORGANISATION_HANDLE}`)).toEqual({
      kind: "organisation",
      organisationHandle: ORGANISATION_HANDLE,
    });
    for (const group of WORKSPACE_NAVIGATION_GROUPS) {
      for (const page of group.pages) {
        const route = readPortalRoute(
          workspacePagePath(ORGANISATION_HANDLE, WORKSPACE_HANDLE, page),
        );
        expect(route).toEqual({
          kind: "workspace",
          organisationHandle: ORGANISATION_HANDLE,
          workspaceHandle: WORKSPACE_HANDLE,
          destination:
            page === "access"
              ? { kind: "access_subview", page: "access", subview: "access" }
              : { kind: "page", page },
        });
      }
    }

    expect(
      readPortalRoute(
        workspacePagePath(ORGANISATION_HANDLE, WORKSPACE_HANDLE, "chat"),
      ),
    ).toEqual({
      kind: "workspace",
      organisationHandle: ORGANISATION_HANDLE,
      workspaceHandle: WORKSPACE_HANDLE,
      destination: { kind: "page", page: "chat" },
    });

    const productPath = workspaceResourcePath(
      ORGANISATION_HANDLE,
      WORKSPACE_HANDLE,
      "product",
      "gid://shopify/Product/42",
    );
    expect(productPath).toBe(
      "/portal/pantry-cafes/cafe-central/products/gid%253A%252F%252Fshopify%252FProduct%252F42",
    );
    expect(readPortalRoute(productPath)).toEqual({
      kind: "workspace",
      organisationHandle: ORGANISATION_HANDLE,
      workspaceHandle: WORKSPACE_HANDLE,
      destination: {
        kind: "resource",
        page: "products",
        resourceId: "gid://shopify/Product/42",
      },
    });
    expect(
      workspaceResourcePath(
        ORGANISATION_HANDLE,
        WORKSPACE_HANDLE,
        "customer_order",
        "order/42",
      ),
    ).toBe("/portal/pantry-cafes/cafe-central/orders/order%252F42");
    expect(
      workspaceResourcePath(
        ORGANISATION_HANDLE,
        WORKSPACE_HANDLE,
        "supplier",
        "packaging/supply",
      ),
    ).toBe("/portal/pantry-cafes/cafe-central/suppliers/packaging%252Fsupply");
  });

  it("keeps malformed and extra-segment paths inside the not-found state", () => {
    expect(readPortalRoute("/portal/cafe%ZZ")).toEqual({
      kind: "not_found",
      organisationHandle: null,
      workspaceHandle: null,
    });
    expect(
      readPortalRoute("/portal/pantry-cafes/cafe-central/products/%ZZ"),
    ).toEqual({
      kind: "not_found",
      organisationHandle: ORGANISATION_HANDLE,
      workspaceHandle: WORKSPACE_HANDLE,
    });
    expect(
      readPortalRoute("/portal/pantry-cafes/cafe-central/commerce/extra"),
    ).toEqual({
      kind: "not_found",
      organisationHandle: ORGANISATION_HANDLE,
      workspaceHandle: WORKSPACE_HANDLE,
    });
    expect(
      readPortalRoute("/portal/pantry-cafes/cafe-central/products/item/extra"),
    ).toEqual({
      kind: "not_found",
      organisationHandle: ORGANISATION_HANDLE,
      workspaceHandle: WORKSPACE_HANDLE,
    });
    expect(
      readPortalRoute("/portal/pantry-cafes/cafe-central/%E0%A4%A"),
    ).toEqual({
      kind: "not_found",
      organisationHandle: ORGANISATION_HANDLE,
      workspaceHandle: WORKSPACE_HANDLE,
    });
  });
});
