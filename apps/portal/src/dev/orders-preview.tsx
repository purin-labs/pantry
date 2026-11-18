import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import "../styles.css";
import { OrderList, type ListedOrder } from "../features/orders/order-list";
import { PortalFrame } from "../shell";

// The orders page with the sample café's Thursday orders. `?theme=dark`
// shows the dark theme, `?order=<id>` opens that order's drawer and `?frame`
// shows the page in the Portal's own frame, as for site screenshots. The
// orders, the checks and the drafted emails are sample data; no JEV run made
// them. Approve only marks the email approved on this page.
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Orders preview is development-only.");
const search = new URL(window.location.href).searchParams;
if (search.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";

const ORDERS: readonly ListedOrder[] = [
  {
    id: "order_2207",
    number: "#2207",
    customer: "Aiko",
    items: "24 financiers",
    stage: "ready",
    due: "Today 17:00",
    place: "Yamato",
    total: "¥9,120",
    hold: {
      problem: "The gift note is 212 characters. The limit is 120.",
      tone: "danger",
      rule: "Gift notes · Packaging policy",
      action: "Review email",
      update: {
        at: "14:00",
        draft:
          "Hi Aiko, your gift note is longer than our cards allow. Can you send a version of 120 characters or less? Your box still leaves today.",
        state: "waits_for_you",
      },
    },
    checks: [
      { label: "Paid", state: "passed" },
      { label: "Stock reserved", state: "passed" },
      { label: "Bake slot · Thursday batch A", state: "passed" },
      { label: "Gift note length", state: "failed" },
    ],
  },
  {
    id: "order_2211",
    number: "#2211",
    customer: "Kenji",
    items: "box of 12",
    stage: "checking",
    due: "Sat",
    place: null,
    total: "¥4,320",
    hold: {
      problem: "The payment failed. A retry runs at 15:00.",
      tone: "warning",
      rule: null,
      action: "Open order",
      update: {
        at: "15:05",
        draft:
          "Hi Kenji, we could not take the payment for your box of 12. You can pay with this link, and we keep your box for you until Saturday.",
        state: "draft",
      },
    },
    checks: [
      { label: "Payment failed once", state: "warning" },
      { label: "Retry at 15:00", state: "waiting" },
      { label: "Stock reserved", state: "passed" },
    ],
  },
  {
    id: "order_2214",
    number: "#2214",
    customer: "Mei",
    items: "60 ginger financiers",
    stage: "checking",
    due: "Fri",
    place: null,
    total: "¥22,800",
    hold: null,
    checks: [
      { label: "Paid", state: "passed" },
      { label: "Bake slot · Friday batch B", state: "running" },
      { label: "Shipping cut-off", state: "pending" },
    ],
  },
  {
    id: "order_2203",
    number: "#2203",
    customer: "Hana",
    items: "tart for 6",
    stage: "ready",
    due: "16:30",
    place: "shelf B2",
    total: "¥4,860",
    hold: null,
    checks: [
      { label: "Paid", state: "passed" },
      { label: "Stock reserved", state: "passed" },
      { label: "Bake slot · Thursday batch A", state: "passed" },
      { label: "Pickup window", state: "passed" },
    ],
  },
  {
    id: "order_2198",
    number: "#2198",
    customer: "Taro",
    items: "12 madeleines",
    stage: "in_kitchen",
    due: "13:40",
    place: "batch A",
    total: "¥3,240",
    hold: null,
    checks: [
      { label: "Paid", state: "passed" },
      { label: "Bake slot · Thursday batch A", state: "passed" },
    ],
  },
  {
    id: "order_2190",
    number: "#2190",
    customer: "Sora",
    items: "gift box of 6",
    stage: "out",
    due: "Fri AM",
    place: "Yamato",
    total: "¥2,160",
    hold: null,
    checks: [
      { label: "Paid", state: "passed" },
      { label: "Shipped with tracking", state: "passed" },
    ],
  },
];

function OrdersPreview(): React.ReactNode {
  const [orders, setOrders] = React.useState(ORDERS);
  const approve = React.useCallback((orderId: string) => {
    setOrders((current) =>
      current.map((order) =>
        order.id === orderId && order.hold?.update != null
          ? {
              ...order,
              hold: {
                ...order.hold,
                update: { ...order.hold.update, state: "approved" },
              },
            }
          : order,
      ),
    );
  }, []);
  const page = (
    <>
      <header className="portal-heading">
        <h1>Orders</h1>
        <p>Agents check each order against your rules.</p>
      </header>
      <OrderList
        day="Thursday"
        orders={orders}
        counts={{ checking: 1, ready: 9, in_kitchen: 2, out: 5 }}
        checkedAt="2 min ago"
        ruleCount={6}
        approve={approve}
        initialOpenId={search.get("order")}
      />
    </>
  );
  if (search.has("frame"))
    return (
      <MemoryRouter initialEntries={["/portal/nuki/cafe/orders"]}>
        <PortalFrame
          identity={{
            kind: "ready",
            displayName: "Pta",
            logout: previewLogout,
          }}
          organisation={{
            organisationHandle: "nuki",
            name: "Nuki Inc.",
            choices: [],
          }}
          workspace={{
            organisationHandle: "nuki",
            workspaceHandle: "cafe",
            name: "Cafe operations",
            choices: [],
          }}
          sidebar={{ activePage: "orders", chatOpen: false, footer: null }}
        >
          {page}
        </PortalFrame>
      </MemoryRouter>
    );
  return (
    <main className="portal-main" style={{ padding: "28px" }}>
      <div className="portal-main-inner">{page}</div>
    </main>
  );
}

function previewLogout(): Promise<void> {
  return Promise.resolve();
}

createRoot(root).render(
  <React.StrictMode>
    <OrdersPreview />
  </React.StrictMode>,
);
