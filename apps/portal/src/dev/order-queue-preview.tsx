import React from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { OrderQueueRoute } from "../features/order-queue/route";

// The order queue against a Worker's control routes, for the Plan 40B browser
// journey. `?organisation=<id>` picks the Organisation.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Order queue preview is development-only.");
const organisationId =
  new URL(window.location.href).searchParams.get("organisation") ??
  "organisation_order_queue_preview";
createRoot(root).render(
  <React.StrictMode>
    <main style={{ padding: 24 }}>
      <OrderQueueRoute organisationId={organisationId} />
    </main>
  </React.StrictMode>,
);
