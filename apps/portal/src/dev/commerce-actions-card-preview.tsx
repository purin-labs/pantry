import React from "react";
import { createRoot } from "react-dom/client";
import "@purin-labs/surface-portal/ui/styles.css";
import { configurationDraftInserts } from "@purin-labs/surface-portal/ui/features/chat/configuration-draft-cards";
import type { ConfigurationDraftView } from "@purin-labs/control-api/portal/configuration-drafts";
import { commerceActionTitle } from "@purin-labs/area-commerce-contract/ui/features/governed-actions/commerce";
import { OrderRefundDetails } from "@purin-labs/area-commerce/ui/features/governed-actions/order-refund-details";
import { StockOperationCard } from "@purin-labs/area-commerce/ui/features/governed-actions/stock-operation-details";
import type { StockOperationView } from "@purin-labs/control-api/portal/stock-operation";

// The refund and stock approval cards and the chat's setup card, with sample
// facts. The server's records run in tests/e2e/pi-commerce-actions.test.ts and
// tests/e2e/pi-stock-actions.test.ts.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Commerce action card preview is development-only.");

const pending: ConfigurationDraftView = {
  draftId: "draft_preview",
  summary:
    "Allow the price of Taro cookie to move up to 5.00% from ¥450 (the price when you were shown this).",
  actionLabel: "Save price allowance",
  consequence:
    "The band is measured from that price. If the price changes before you confirm, this is refused rather than measured from a price you did not see.",
  state: "pending",
  receiptCode: null,
  requestedByViewer: true,
  createdAt: 1,
};

const stockCards: readonly (readonly [string, string, StockOperationView])[] = [
  [
    "commerce.stock.receive",
    "The flour delivery arrived.",
    {
      kind: "receive_stock",
      itemName: "Bread flour",
      locationName: "Omotesando kitchen",
      quantity: { amount: 5, scale: 0, unit: "kg" },
      lot: {
        kind: "tracked",
        lotCode: "MILL-1",
        expiresAt: "2026-12-01T00:00:00.000Z",
      },
      purchaseRequestEntryId: null,
      receivedAt: null,
    },
  ],
];

function answer(
  draft: ConfigurationDraftView,
  state: ConfigurationDraftView["state"],
): Promise<ConfigurationDraftView> {
  return Promise.resolve({
    ...draft,
    state,
    receiptCode: state === "settled" ? "accepted" : null,
  });
}

function SetupCards(): React.ReactNode {
  return configurationDraftInserts(
    [pending, { ...pending, draftId: "draft_other", requestedByViewer: false }],
    {
      actions: {
        confirm: (draft) => answer(draft, "settled"),
        cancel: (draft) => answer(draft, "cancelled"),
      },
      canManage: true,
      onChanged: () => Promise.resolve(),
    },
  ).map((insert) => insert.node);
}

createRoot(root).render(
  <main style={{ maxWidth: 640, margin: "32px auto", padding: "0 16px" }}>
    <section className="portal-band commerce-action-status">
      <div className="action-status-heading">
        <div>
          <h2>{commerceActionTitle("commerce.order.refund")}</h2>
        </div>
        <span className="action-state action-state-proposed">
          Waiting for approval
        </span>
      </div>
      <p className="action-summary">
        Return this money to the customer's payment.
      </p>
      <OrderRefundDetails
        details={{
          kind: "refund_order",
          orderId: "order_preview",
          reason: "The sesame cookie was burnt.",
          amountMinor: 450,
          currency: "JPY",
          wholeOrder: false,
          lines: [
            { orderLineId: "line_1", title: "Taro cookie", amountMinor: 450 },
          ],
          taxes: [],
          shippingMinor: 0,
        }}
      />
    </section>
    {stockCards.map(([verb, reason, operation]) => (
      <section
        className="portal-band commerce-action-status"
        key={verb}
        style={{ marginTop: 24 }}
      >
        <div className="action-status-heading">
          <div>
            <h2>{commerceActionTitle(verb)}</h2>
          </div>
          <span className="action-state action-state-proposed">
            Waiting for approval
          </span>
        </div>
        <StockOperationCard
          details={{ kind: "stock_operation", reason, operation }}
        />
      </section>
    ))}
    <div style={{ marginTop: 24 }}>
      <SetupCards />
    </div>
  </main>,
);
