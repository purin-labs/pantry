import React from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import "@purin-labs/surface-portal/ui/styles.css";
import { PageHeader } from "@purin-labs/ui/page-components";
import {
  BakesRoute,
  CostsPage,
  InventoryPage,
  InventoryProductionRequestsPage,
  RecipesPage,
} from "@purin-labs/surface-portal/ui/page-code";
import {
  bakeBoard,
  costsOverview,
  inventory,
  productionDemand,
  recipeCollection,
} from "./kitchen-preview-data";

/*
 * The Kitchen pages with example data, inside the Portal frame:
 *   ?page=recipes | costs | inventory | production-requests | bakes
 * `?theme=dark` sets the dark appearance. The preview answers each read of
 * the page by patching `window.fetch`; a write answers "not in preview".
 */
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Kitchen preview is development-only.");
const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";
// Each page with the title that the Portal shows; the pages show no subtitle.
const TITLES = {
  recipes: "Recipes",
  costs: "Costs & margins",
  inventory: "Ingredients & supplies",
  "production-requests": "Production requests",
  bakes: "Bakes",
} as const;
type PreviewPage = keyof typeof TITLES;
const page: PreviewPage =
  (Object.keys(TITLES) as PreviewPage[]).find(
    (name) => name === params.get("page"),
  ) ?? "recipes";
const ORGANISATION = "organisation_preview";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const READS: readonly (readonly [RegExp, () => unknown])[] = [
  [/\/commerce\/recipes$/u, recipeCollection],
  [/\/commerce\/costs$/u, costsOverview],
  [/\/commerce\/inventory$/u, inventory],
  [/\/commerce\/inventory\/production-requests(\?.*)?$/u, productionDemand],
  [/\/bakes$/u, bakeBoard],
];

window.fetch = function previewFetch(input: RequestInfo | URL) {
  const url = new URL(
    String(input instanceof Request ? input.url : input),
    window.location.origin,
  );
  const path = `${url.pathname}${url.search}`;
  const read = READS.find(([pattern]) => pattern.test(path));
  return Promise.resolve(
    read === undefined
      ? json({ ok: false, error: "not_in_preview" }, 404)
      : json(read[1]()),
  );
};

function notInPreview(): Promise<unknown> {
  return Promise.reject(new Error("Changes are not saved in the preview."));
}

function pageContent(name: PreviewPage): React.ReactNode {
  switch (name) {
    case "recipes":
      return (
        <RecipesPage
          organisationId={ORGANISATION}
          canEdit
          mutate={notInPreview}
          costsHref="/costs"
        />
      );
    case "costs":
      return (
        <CostsPage
          organisationId={ORGANISATION}
          canEdit
          mutate={notInPreview}
          recipesHref="/recipes"
          productsHref="/products"
          suppliesHref="/inventory"
        />
      );
    case "inventory":
      return (
        <InventoryPage
          userId="user_preview"
          organisationId={ORGANISATION}
          canManage
          canReceive
          view="supplies"
          mutate={notInPreview}
          ordersHref="/orders"
          productionHref="/production-requests"
          productsHref="/products"
          costsHref="/costs"
          suppliersHref="/suppliers"
        />
      );
    case "production-requests":
      return (
        <InventoryProductionRequestsPage
          userId="user_preview"
          organisationId={ORGANISATION}
          canManage
          canOperate
          mutate={notInPreview}
          productsHref="/products"
        />
      );
    case "bakes":
      return <BakesRoute organisationId={ORGANISATION} />;
  }
}

function KitchenPreview(): React.ReactNode {
  return (
    <div className="portal-shell portal-shell-workspace">
      <main className="portal-main">
        <div className="portal-main-inner">
          <PageHeader title={TITLES[page]} description={null} />
          <React.Suspense fallback={null}>{pageContent(page)}</React.Suspense>
        </div>
      </main>
    </div>
  );
}

const router = createMemoryRouter([{ path: "*", element: <KitchenPreview /> }]);
createRoot(root).render(<RouterProvider router={router} />);
