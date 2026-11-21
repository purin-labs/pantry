import { describe, expect, it } from "vitest";

import { parseHomeResponse } from "@purin-labs/control-api/portal/home";

const OBSERVED_AT = "2026-07-26T00:00:00.000Z";

describe("Café Home boundary parser", () => {
  it("accepts the versioned merchant-safe view and closed destinations", () => {
    const parsed = parseHomeResponse({
      ok: true,
      schemaVersion: "pantry.cafeos.home.v1",
      generatedAt: Date.parse(OBSERVED_AT),
      home: {
        workspace: {
          organisationId: "organisation_home_parser",
          name: "Parser workspace",
          lifecycle: "active",
          environment: "development",
        },
        attention: [
          {
            kind: "governed_action",
            urgency: "high",
            status: "awaiting_review",
            title: "Adjust inventory",
            reason: "A governed change is waiting for review.",
            resource: { kind: "inventory", label: "Inventory" },
            observedAt: OBSERVED_AT,
            assignee: { kind: "unassigned" },
            nextAction: {
              kind: "review_operations",
              label: "Review change",
              destination: { kind: "operations" },
            },
          },
        ],
        today: [
          {
            kind: "open_customer_orders",
            label: "Open customer orders",
            value: 2,
            observedAt: OBSERVED_AT,
            destination: { kind: "orders" },
          },
        ],
        blockers: [],
        permissions: {
          role: "operator",
          canApproveCommerceActions: false,
          canConfigureIntegrations: false,
          canManageWorkspace: false,
        },
        availableActions: [
          {
            kind: "open_commerce",
            label: "Open customer order",
            destination: {
              kind: "customer_order",
              resourceId: "order_home_parser",
            },
          },
        ],
        sourceObservations: [
          {
            kind: "commerce",
            status: "current",
            observedAt: OBSERVED_AT,
          },
        ],
      },
    });

    expect(parsed.workspace.name).toBe("Parser workspace");
    expect(parsed.attention[0]?.nextAction.destination).toEqual({
      kind: "operations",
    });
    expect(parsed.today[0]?.destination).toEqual({ kind: "orders" });
    expect(parsed.availableActions[0]?.destination).toEqual({
      kind: "customer_order",
      resourceId: "order_home_parser",
    });
  });

  it("rejects unknown destinations and stale schema versions at the boundary", () => {
    const response = {
      ok: true,
      schemaVersion: "pantry.cafeos.home.v1",
      generatedAt: Date.parse(OBSERVED_AT),
      home: {
        workspace: {
          organisationId: "organisation_home_parser",
          name: "Parser workspace",
          lifecycle: "active",
          environment: "development",
        },
        attention: [],
        today: [],
        blockers: [],
        permissions: {
          role: "viewer",
          canApproveCommerceActions: false,
          canConfigureIntegrations: false,
          canManageWorkspace: false,
        },
        availableActions: [],
        sourceObservations: [],
      },
    };

    expect(() =>
      parseHomeResponse({ ...response, schemaVersion: "pantry.cafeos.home.v0" }),
    ).toThrow("Home response is invalid.");
    expect(() =>
      parseHomeResponse({
        ...response,
        home: {
          ...response.home,
          availableActions: [
            {
              kind: "open_commerce",
              label: "Open commerce",
              destination: { kind: "arbitrary_url" },
            },
          ],
        },
      }),
    ).toThrow("Home destination is invalid.");
    expect(() =>
      parseHomeResponse({
        ...response,
        home: {
          ...response.home,
          availableActions: [
            {
              kind: "open_commerce",
              label: "Open customer order",
              destination: { kind: "customer_order" },
            },
          ],
        },
      }),
    ).toThrow("Home resource destination is invalid.");
  });

  it("does not expose raw server error codes as merchant copy", () => {
    expect(() =>
      parseHomeResponse({ ok: false, error: "home_internal_database_code" }),
    ).toThrow("Home is unavailable.");
  });

  it("rejects an unbounded attention queue", () => {
    const attention = Array.from({ length: 6 }, () => ({
      kind: "governed_action",
      urgency: "high",
      status: "awaiting_review",
      title: "Review change",
      reason: "A governed change is waiting for review.",
      resource: { kind: "inventory", label: "Inventory" },
      observedAt: OBSERVED_AT,
      assignee: { kind: "unassigned" },
      nextAction: {
        kind: "review_operations",
        label: "Review change",
        destination: { kind: "operations" },
      },
    }));
    expect(() =>
      parseHomeResponse({
        ok: true,
        schemaVersion: "pantry.cafeos.home.v1",
        generatedAt: Date.parse(OBSERVED_AT),
        home: {
          workspace: {
            organisationId: "organisation_home_parser",
            name: "Parser workspace",
            lifecycle: "active",
            environment: "development",
          },
          attention,
          today: [],
          blockers: [],
          permissions: {
            role: "viewer",
            canApproveCommerceActions: false,
            canConfigureIntegrations: false,
            canManageWorkspace: false,
          },
          availableActions: [],
          sourceObservations: [],
        },
      }),
    ).toThrow("Home response exceeds its bounded view limits.");
  });
});
