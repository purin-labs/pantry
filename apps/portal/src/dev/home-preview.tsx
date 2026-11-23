import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import "@purin-labs/surface-portal/ui/styles.css";
import { PageHeader } from "@purin-labs/ui/page-components";
import { HomePage } from "@purin-labs/surface-portal/ui/pages/home";

/*
 * Home with example data. Scenarios:
 *   ?scenario=quiet    nothing waits, every source is current (the default)
 *   ?scenario=late     one item waits, and the commerce source is late
 */
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Home preview is development-only.");

const scenario =
  new URLSearchParams(window.location.search).get("scenario") === "late"
    ? "late"
    : "quiet";
const OBSERVED_AT = "2026-11-23T03:00:00.000Z";

function homeResponse(): unknown {
  return {
    ok: true,
    schemaVersion: "pantry.cafeos.home.v1",
    generatedAt: Date.parse(OBSERVED_AT),
    home: {
      workspace: {
        organisationId: "organisation_preview",
        name: "Cafe operations",
        lifecycle: "active",
        environment: "development",
      },
      attention:
        scenario === "late"
          ? [
              {
                kind: "governed_action",
                urgency: "high",
                status: "awaiting_review",
                title: "Refund for order #1042",
                reason: "The refund is above the automatic limit.",
                resource: { kind: "customer_order", label: "Order #1042" },
                observedAt: OBSERVED_AT,
                assignee: { kind: "unassigned" },
                nextAction: {
                  kind: "review_operations",
                  label: "Review",
                  destination: { kind: "orders" },
                },
              },
            ]
          : [],
      today: [],
      blockers: [],
      permissions: {
        role: "owner",
        canApproveCommerceActions: true,
        canConfigureIntegrations: true,
        canManageWorkspace: true,
      },
      availableActions: [],
      sourceObservations: [
        {
          kind: "commerce",
          status: scenario === "late" ? "delayed" : "current",
          observedAt: OBSERVED_AT,
        },
        { kind: "governed_work", status: "current", observedAt: null },
        {
          kind: "workspace_readiness",
          status: "current",
          observedAt: OBSERVED_AT,
        },
      ],
    },
  };
}

function count(value: string): unknown {
  return {
    ok: true,
    result: {
      merchantRevision: 174,
      entities: [],
      relationships: [],
      listEntries: [],
      aggregations: [{ kind: "count", value }],
      nextCursor: null,
      provenance: [],
      freshness: [],
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// The preview answers the reads of Home. The stock read has no answer here,
// so its two counts show as unavailable, as they do when that read fails.
window.fetch = function previewFetch(input: RequestInfo | URL) {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/home")) return Promise.resolve(json(homeResponse()));
  if (url.includes("/commerce/graph"))
    return Promise.resolve(
      json({ results: [count("0"), count("2"), count("0")] }),
    );
  return Promise.resolve(json({ ok: false, error: "not_in_preview" }, 404));
};

createRoot(root).render(
  <MemoryRouter>
    <div className="portal-shell portal-shell-workspace">
      <main className="portal-main">
        <div className="portal-main-inner">
          <PageHeader title="Home" description={null} />
          <HomePage
            organisationId="organisation_preview"
            organisationHandle="preview"
            workspaceHandle="cafe"
          />
        </div>
      </main>
    </div>
  </MemoryRouter>,
);
