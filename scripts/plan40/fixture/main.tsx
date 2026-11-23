import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, RouterProvider, useLocation } from "react-router";
import { validateCommerceEntityShape } from "@purin-labs/commerce-contracts/browser-validators";
import type { CommerceEntity } from "@purin-labs/commerce-contracts";
import { ProductDescriptionDraftControl } from "../../../areas/commerce/ui/features/commerce/description-draft/control";
import DescriptionEditor from "../../../areas/commerce/ui/features/commerce/description-draft/editor";
import "../../../surfaces/portal/ui/styles.css";

const root = document.getElementById("root");

if (root === null) throw new Error("fixture root missing");

const router = createBrowserRouter([
  { path: "/editor", element: <EditorRoute /> },
  { path: "/control", element: <ControlRoute /> },
  { path: "/away", element: <AwayRoute /> },
]);

createRoot(root).render(<RouterProvider router={router} />);

function EditorRoute(): React.ReactNode {
  const room = new URLSearchParams(useLocation().search).get("room") ?? "browser-verification";
  return <>
    <h1>Plan 40 description editor</h1>
    <p data-room={room}>Controlled protocol peer room: {room}</p>
    <p><Link to={`/away?room=${encodeURIComponent(room)}`}>Leave product</Link></p>
    <div className="description-draft-workspace">
      <DescriptionEditor
        organisationId="organisation-browser"
        productId={room}
        currentProductRevision={5}
        currentProduct={null}
        canPropose={false}
        actionBusy={false}
        actionTransport={undefined}
        onActionProposed={undefined}
        onReviewRefresh={noReviewRefresh}
      />
    </div>
  </>;
}

function noReviewRefresh(): void {}

function AwayRoute(): React.ReactNode {
  const room = new URLSearchParams(useLocation().search).get("room") ?? "browser-verification";
  return <>
    <h1>Away from the product</h1>
    <p>This route represents another Portal destination.</p>
    <Link to={`/editor?room=${encodeURIComponent(room)}`}>Return to editor</Link>
  </>;
}

function ControlRoute(): React.ReactNode {
  const room = new URLSearchParams(useLocation().search).get("room") ?? "control-verification";
  const [sourceAvailable, setSourceAvailable] = React.useState(true);
  const entity = sourceAvailable ? productEntity(room) : unavailableProductEntity(room);
  return <>
    <h1>Plan 40 description control fixture</h1>
    <p data-room={room}>Actual ProductDescriptionDraftControl room: {room}</p>
    <button type="button" onClick={setSourceAvailable.bind(null, false)}>Remove product source</button>
    <ProductDescriptionDraftControl organisationId="organisation-browser" entity={entity} />
  </>;
}

function productEntity(productId: string): CommerceEntity {
  return buildProductEntity(productId, "commerce");
}

function unavailableProductEntity(productId: string): CommerceEntity {
  return buildProductEntity(productId, "shopify");
}

function buildProductEntity(productId: string, source: "shopify" | "commerce"): CommerceEntity {
  return validateCommerceEntityShape({
    reference: { origin: "system", typeId: "product", entityId: productId },
    revision: 7,
    displayName: "Fixture product",
    attributes: [],
    provenance: {
      organisationId: "organisation-browser",
      integrationAccountId: "intacc-browser",
      source,
      resourceType: "product",
      resourceId: productId,
      revision: 7,
      occurredAt: "2026-09-08T00:00:00.000Z",
      observedAt: "2026-09-08T00:00:00.000Z",
    },
    freshness: { state: "current", observedAt: "2026-09-08T00:00:00.000Z" },
  });
}
