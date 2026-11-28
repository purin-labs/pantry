import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import type { BillingView } from "@purin-labs/control-api/portal/billing";
import type { JevFeaturesView } from "@purin-labs/control-api/portal/jev-features";
import "@purin-labs/surface-portal/ui/styles.css";
import { BillingRoute } from "@purin-labs/area-organisation/ui/features/billing/route";
import { JevFeaturesRoute } from "@purin-labs/area-integrations/ui/features/jev-features/route";

// Settings › Jev and Settings › Billing with a stand-in Platform.
// `?case=` picks the data:
// - `pantry` (the default): Pantry's key, the owner.
// - `own`: the Organisation's own key. `missing`: a missing key.
// - `viewer`: a member who is not an admin.
// - `near`: 85 % of the free use, paid use off, the owner.
// - `used`: the free use used, paid use off, the owner.
// - `used-viewer`: the free use used, paid use off, a viewer.
// - `paid`: paid use on, $1.20 of $5.00, the owner.
// - `unpriced`: paid use is not open yet (`priced: false`).
// - `past-due`: paid use on and a failed payment, the owner.
// - `admin`: an admin who is not the owner.
// `?page=billing` opens Settings › Billing; `?theme=dark` sets the dark
// appearance.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Jev preview is development-only.");
const params = new URL(window.location.href).searchParams;
if (params.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";
const previewCase = params.get("case") ?? "pantry";
const viewer = previewCase === "viewer" || previewCase === "used-viewer";
const admin = !viewer;
const owner = !viewer && previewCase !== "admin";
const used = previewCase === "used" || previewCase === "used-viewer";
// controlMutation reads the session's CSRF cookie before it sends.
document.cookie = "pantry_csrf=preview";

function usedMicrousd(): number {
  if (used) return 998_500;
  if (previewCase === "near" || previewCase === "unpriced") return 850_000;
  if (previewCase === "paid") return 1_000_000;
  return 142_000;
}

let view: JevFeaturesView = {
  funding: previewCase === "own" ? "organisation_byo" : "pantry_platform",
  keyAvailable: previewCase !== "missing",
  mailClassification: {
    enabled: previewCase !== "missing",
    mailboxes: [
      {
        integrationAccountId: "ia_orders",
        displayName: "orders@noisette.example",
        covered: true,
      },
      {
        integrationAccountId: "ia_hello",
        displayName: "hello@noisette.example",
        covered: false,
      },
    ],
  },
  relatedCases: {
    enabled: previewCase !== "own" && previewCase !== "missing",
    mode:
      previewCase !== "own" && previewCase !== "missing"
        ? "metadata_only"
        : null,
    sourceCount: 2,
  },
  screenRelevance: { enabled: false },
  allowance:
    previewCase === "own"
      ? null
      : {
          usedMicrousd: usedMicrousd(),
          limitMicrousd: 1_000_000,
          resetsAt: Date.UTC(2026, 11, 1),
          reached: used || previewCase === "paid",
        },
  paidUse: {
    enabled: previewCase === "paid" || previewCase === "past-due",
    spendingLimitMinor: 500,
    spentMinor: previewCase === "paid" ? 120 : 0,
    limitReached: false,
    highestSpendingLimitMinor: 1_000,
    priced: previewCase !== "unpriced" && previewCase !== "own",
  },
};

/** Settings › Billing reads its own view of the same numbers. */
function billingView(): BillingView {
  return {
    plan: {
      id: "beta",
      name: "Beta",
      freeJevUseMicrousd: 1_000_000,
      highestSpendingLimitMinor: 1_000,
    },
    open: view.paidUse.priced,
    paymentState:
      previewCase === "paid"
        ? "active"
        : previewCase === "past-due"
          ? "past_due"
          : "none",
    freeUse:
      view.allowance === null
        ? null
        : {
            usedMicrousd: view.allowance.usedMicrousd,
            limitMicrousd: view.allowance.limitMicrousd,
            resetsAt: view.allowance.resetsAt,
          },
    paidUse: {
      enabled: view.paidUse.enabled,
      spentMinor: view.paidUse.spentMinor,
      spendingLimitMinor: view.paidUse.spendingLimitMinor,
      limitReached: view.paidUse.limitReached,
    },
  };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = String(input);
  if (/\/billing(\/(checkout|portal))?$/u.test(path)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (init?.method !== "POST")
      return Response.json({ ok: true, value: billingView() });
    // The stand-in opens no Stripe page: it answers as a Stripe fault does.
    return Response.json(
      { ok: false, error: "billing_provider_unavailable" },
      { status: 503 },
    );
  }
  const paidUse = path.endsWith("/jev-features/paid-use");
  if (!paidUse && !path.endsWith("/jev-features"))
    return realFetch(input, init);
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (init?.method !== "POST") return Response.json({ ok: true, value: view });
  if (paidUse) {
    // The control role check hides the owner route from other members.
    if (!owner)
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    const body = JSON.parse(String(init.body)) as {
      enabled: boolean;
      spendingLimitMinor: number;
    };
    view = {
      ...view,
      paidUse: {
        ...view.paidUse,
        enabled: body.enabled,
        spendingLimitMinor: body.spendingLimitMinor,
      },
    };
    return Response.json({ ok: true, value: view });
  }
  if (!admin)
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  const body = JSON.parse(String(init.body)) as {
    feature: "mail_classification" | "related_cases" | "screen_relevance";
    enabled: boolean;
    mode?: "shadow" | "metadata_only";
  };
  if (body.enabled && !view.keyAvailable)
    return Response.json(
      { ok: false, error: "jev_key_unavailable" },
      { status: 409 },
    );
  if (body.feature === "mail_classification")
    view = {
      ...view,
      mailClassification: {
        enabled: body.enabled,
        // Turning the switch on covers every mailbox that is connected now.
        mailboxes: view.mailClassification.mailboxes.map((mailbox) => ({
          ...mailbox,
          covered: body.enabled ? true : mailbox.covered,
        })),
      },
    };
  if (body.feature === "related_cases")
    view = {
      ...view,
      relatedCases: {
        ...view.relatedCases,
        enabled: body.enabled,
        mode: body.enabled
          ? (body.mode ?? view.relatedCases.mode ?? "metadata_only")
          : view.relatedCases.mode,
      },
    };
  if (body.feature === "screen_relevance")
    view = { ...view, screenRelevance: { enabled: body.enabled } };
  return Response.json({ ok: true, value: view });
};

function Page(props: {
  readonly title: string;
  /** Billing shows its title alone, as in the Portal. */
  readonly description?: string;
  readonly children: React.ReactNode;
}): React.ReactNode {
  return (
    <main style={{ padding: 24 }}>
      <header style={{ marginBlockEnd: 16 }}>
        <h1 style={{ margin: 0 }}>{props.title}</h1>
        {props.description === undefined ? null : (
          <p style={{ margin: "4px 0 0" }}>{props.description}</p>
        )}
      </header>
      {props.children}
    </main>
  );
}

createRoot(root).render(
  <React.StrictMode>
    <MemoryRouter
      initialEntries={[params.get("page") === "billing" ? "/billing" : "/jev"]}
    >
      <Routes>
        <Route
          path="/jev"
          element={
            <Page
              title="Jev"
              description="Choose which Purin Pantry features may send data to TypeSafe Jev."
            >
              <JevFeaturesRoute
                organisationId="organisation_jev_preview"
                canManage={admin}
                isOwner={owner}
                integrationsHref="/integrations"
              />
            </Page>
          }
        />
        <Route
          path="/billing"
          element={
            <Page title="Billing">
              <BillingRoute
                organisationId="organisation_jev_preview"
                isOwner={owner}
                canRead={admin}
                jevHref="/jev"
              />
            </Page>
          }
        />
      </Routes>
    </MemoryRouter>
  </React.StrictMode>,
);
