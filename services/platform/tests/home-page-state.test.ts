// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { StaticRouter } from "../../../apps/portal/node_modules/react-router";
import { describe, expect, it } from "vitest";

import type { HomeSnapshot } from "@seams/control-api/portal/home";
import {
  HomePageView,
  type HomePageContent,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/pages/home";

const ORGANISATION_ID = "organisation_cafe_central";
const ORGANISATION_HANDLE = "cafe";
const WORKSPACE_HANDLE = "cafe-central";

describe("CafeOS Home page state", () => {
  it("does not invent a destination when an empty action has no server destination", () => {
    const markup = renderHome({
      kind: "empty",
      reason: "Connect a commerce system to populate this brief.",
      nextAction: { label: "Open integrations" },
    });

    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("/integrations");
  });

  it("keeps operational bands quiet while the workspace is still being set up", () => {
    const snapshot: HomeSnapshot = {
      ...emptyHomeSnapshot(),
      workspace: {
        organisationId: ORGANISATION_ID,
        name: "Cafe Central",
        lifecycle: "configuring",
        environment: "development",
      },
      blockers: [
        {
          kind: "workspace",
          title: "Finish setting up this workspace",
          reason: "Complete setup before using daily operations.",
          consequence: "Actions that require approval are unavailable.",
          observedAt: "2026-08-10T00:00:00.000Z",
          nextAction: {
            kind: "manage_workspace",
            label: "Open integrations",
            destination: { kind: "integrations" },
          },
        },
      ],
    };
    const markup = renderHome({
      kind: "ready",
      data: snapshot,
      freshness: {
        kind: "delayed",
        observedAt: "2026-08-10T00:00:00.000Z",
        explanation: "Some connected data is delayed.",
      },
      updating: false,
    });

    // The setup checklist above the brief owns this state entirely; an empty
    // attention band, duplicate setup cards, a staleness warning, or a
    // freshness footer would all contradict it, so the brief renders nothing.
    expect(markup).toBe("");
  });

  it("announces the quiet state and freshness without the retired commerce blocker", () => {
    const snapshot: HomeSnapshot = {
      ...emptyHomeSnapshot(),
      sourceObservations: [
        {
          kind: "commerce",
          status: "delayed",
          observedAt: "2026-08-10T00:00:00.000Z",
        },
        { kind: "governed_work", status: "current", observedAt: null },
      ],
      blockers: [
        {
          kind: "synchronization",
          title: "Commerce data is unavailable",
          reason: "Satyr cannot read the selected commerce system right now.",
          consequence:
            "Products, stock, orders, and actions may be incomplete.",
          observedAt: null,
          nextAction: {
            kind: "open_commerce",
            label: "Open commerce",
            destination: { kind: "commerce" },
          },
        },
      ],
    };
    const markup = renderHome({
      kind: "ready",
      data: snapshot,
      freshness: {
        kind: "delayed",
        observedAt: "2026-08-10T00:00:00.000Z",
        explanation: "Some connected data is delayed.",
      },
      updating: false,
    });

    expect(markup).toContain("Nothing needs your attention");
    expect(markup).not.toContain("Workspace status");
    expect(markup).not.toContain("Commerce data is unavailable");
    expect(markup).toContain("Some connected data is delayed.");
    // Source freshness is a footer line now, not a disclosure card.
    expect(markup).toContain("Commerce · Delayed");
    expect(markup).toContain("Approval workflow · Current");
    expect(markup).not.toContain("Data update details");
  });
});

function renderHome(content: HomePageContent): string {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/portal/cafe/cafe-central" },
      React.createElement(HomePageView, {
        organisationHandle: ORGANISATION_HANDLE,
        workspaceHandle: WORKSPACE_HANDLE,
        content,
        retry: ignoreRetry,
      }),
    ),
  );
}

function ignoreRetry(): void {}

function emptyHomeSnapshot(): HomeSnapshot {
  return {
    schemaVersion: "satyr.cafeos.home.v1",
    generatedAt: Date.parse("2026-08-10T00:00:00.000Z"),
    workspace: {
      organisationId: ORGANISATION_ID,
      name: "Cafe Central",
      lifecycle: "active",
      environment: "development",
    },
    attention: [],
    today: [],
    blockers: [],
    permissions: {
      role: "operator",
      canApproveCommerceActions: false,
      canConfigureIntegrations: false,
      canManageWorkspace: false,
    },
    availableActions: [],
    sourceObservations: [],
  };
}
