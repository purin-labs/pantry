import {
  Check,
  CircleDashed,
  Clock,
  LoaderCircle,
  Mail,
  TriangleAlert,
  X,
} from "lucide-react";
import React from "react";
import { SideDrawer } from "../../ui";
import "./order-list.css";

// The orders page: JEV checks each open order against the shop's published
// rules. The page leads with the orders that a rule holds, each with one
// sentence and one action. The rest are quiet rows, filtered by stage. An
// order opens in a side drawer with its problem, its drafted customer update
// and every check. The page only shows what the caller gives it; it reads
// nothing.

export type OrderStage = "checking" | "ready" | "in_kitchen" | "out";

export type OrderCheck = {
  label: string;
  // "running" is the check that JEV holds now; "pending" waits behind it.
  state: "passed" | "failed" | "warning" | "waiting" | "running" | "pending";
};

export type CustomerUpdate = {
  at: string;
  // The message the agent drafted, in full, for the drawer.
  draft: string;
  state: "waits_for_you" | "approved" | "draft";
};

export type OrderHold = {
  // One sentence that says what is wrong.
  problem: string;
  tone: "danger" | "warning";
  rule: string | null;
  // The label of the one action on the row; it opens the drawer.
  action: string;
  update: CustomerUpdate | null;
};

export type ListedOrder = {
  id: string;
  number: string;
  customer: string;
  items: string;
  stage: OrderStage;
  // When the order is due: a pickup time, a bake day, a delivery.
  due: string;
  // Where the order is: a shelf, a carrier. Null when it has no place yet.
  place: string | null;
  total: string;
  hold: OrderHold | null;
  checks: readonly OrderCheck[];
};

export type OrderListProps = {
  day: string;
  orders: readonly ListedOrder[];
  // Orders in each stage that are on track, with the ones the page does not
  // list.
  counts: Readonly<Record<OrderStage, number>>;
  checkedAt: string;
  ruleCount: number;
  approve: (orderId: string) => void;
  // The order whose drawer is open when the page first shows.
  initialOpenId?: string | null;
};

const STAGE_LABEL: Record<OrderStage, string> = {
  checking: "Checking",
  ready: "Ready",
  in_kitchen: "In kitchen",
  out: "Out",
};

const STAGES: readonly OrderStage[] = [
  "checking",
  "ready",
  "in_kitchen",
  "out",
];

export function OrderList({
  day,
  orders,
  counts,
  checkedAt,
  ruleCount,
  approve,
  initialOpenId = null,
}: OrderListProps): React.ReactNode {
  const [stage, setStage] = React.useState<OrderStage | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(initialOpenId);
  const held = orders.filter((order) => order.hold !== null);
  const onTrack = orders.filter(
    (order) => order.hold === null && (stage === null || order.stage === stage),
  );
  const trackCount =
    stage === null
      ? STAGES.reduce((sum, entry) => sum + counts[entry], 0)
      : counts[stage];
  const open = orders.find((order) => order.id === openId) ?? null;
  return (
    <div className="order-list">
      <header className="order-list-head">
        <div>
          <h2>
            {held.length === 0
              ? "No order needs you"
              : held.length === 1
                ? "1 order needs you"
                : `${held.length} orders need you`}
          </h2>
          <p>
            {STAGES.reduce((sum, entry) => sum + counts[entry], 0)}
            {held.length === 0 ? "" : " more"} on track · checked against{" "}
            {ruleCount} rules, {checkedAt}
          </p>
        </div>
        <span className="order-list-day">{day}</span>
      </header>

      <div
        className="order-list-stages"
        role="group"
        aria-label="Filter by stage"
      >
        {STAGES.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={stage === entry}
            onClick={() => setStage(stage === entry ? null : entry)}
          >
            <strong>{counts[entry]}</strong>
            {STAGE_LABEL[entry]}
          </button>
        ))}
      </div>

      {held.length > 0 ? (
        <section aria-labelledby="order-list-held">
          <h3 id="order-list-held" className="order-list-section">
            Needs you
          </h3>
          <ul className="order-list-held">
            {held.map((order) => (
              <HeldRow
                key={order.id}
                order={order}
                open={() => setOpenId(order.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="order-list-track">
        <h3 id="order-list-track" className="order-list-section">
          {stage === null ? "On track" : STAGE_LABEL[stage]}
          <span>{trackCount}</span>
        </h3>
        <ul className="order-list-rows">
          {onTrack.map((order) => (
            <li key={order.id}>
              <button type="button" onClick={() => setOpenId(order.id)}>
                <strong>{order.number}</strong>
                <span className="order-list-who">
                  {order.customer} · {order.items}
                </span>
                <span className="order-list-stage">
                  {order.stage === "checking" ? (
                    <LoaderCircle aria-hidden="true" size={13} />
                  ) : null}
                  {STAGE_LABEL[order.stage]}
                  {order.place === null ? null : ` · ${order.place}`}
                </span>
                <span className="order-list-due">{order.due}</span>
              </button>
            </li>
          ))}
        </ul>
        {trackCount > onTrack.length ? (
          <p className="order-list-more">{trackCount - onTrack.length} more</p>
        ) : null}
      </section>

      <SideDrawer
        open={open !== null}
        title={open === null ? "" : `Order ${open.number}`}
        close={() => setOpenId(null)}
      >
        {open === null ? null : <OrderDetail order={open} approve={approve} />}
      </SideDrawer>
    </div>
  );
}

function HeldRow({
  order,
  open,
}: {
  order: ListedOrder;
  open: () => void;
}): React.ReactNode {
  const hold = order.hold;
  if (hold === null) return null;
  return (
    <li className="order-list-held-row" data-tone={hold.tone}>
      <p className="order-list-held-title">
        <strong>
          {order.number} · {order.customer}
        </strong>
        <span> · {order.items}</span>
      </p>
      <button type="button" className="secondary" onClick={open}>
        {hold.action}
      </button>
      <p className="order-list-problem">{hold.problem}</p>
      {hold.update === null ? null : (
        <p className="order-list-update">
          {hold.update.state === "waits_for_you"
            ? `Email waits · ${hold.update.at}`
            : hold.update.state === "approved"
              ? `Email approved · ${hold.update.at}`
              : "Email drafted"}
        </p>
      )}
    </li>
  );
}

function OrderDetail({
  order,
  approve,
}: {
  order: ListedOrder;
  approve: (orderId: string) => void;
}): React.ReactNode {
  const hold = order.hold;
  return (
    <div className="side-drawer-body order-list-detail">
      <div>
        <p className="order-list-detail-title">
          {order.customer} · {order.items}
        </p>
        <p className="order-list-detail-meta">
          {order.total} · {STAGE_LABEL[order.stage]} · due {order.due}
        </p>
      </div>
      {hold === null ? null : (
        <div className="order-list-detail-problem" data-tone={hold.tone}>
          <p>{hold.problem}</p>
          {hold.rule === null ? null : <p>Rule: {hold.rule}</p>}
        </div>
      )}
      {hold?.update == null ? null : (
        <div className="order-list-detail-update">
          <p className="order-list-detail-label">
            <Mail aria-hidden="true" size={14} />
            {hold.update.state === "waits_for_you"
              ? `The agent drafted an email. It sends at ${hold.update.at} after you approve it.`
              : hold.update.state === "approved"
                ? `Approved. The email sends at ${hold.update.at}.`
                : "The agent drafted an email. It sends only if it is still needed."}
          </p>
          <blockquote>{hold.update.draft}</blockquote>
          {hold.update.state === "waits_for_you" ? (
            <div>
              <button
                type="button"
                className="primary-button"
                onClick={() => approve(order.id)}
              >
                Approve
              </button>
            </div>
          ) : null}
        </div>
      )}
      <section aria-label="Checks">
        <p className="order-list-detail-label">Checks</p>
        <ul className="order-list-checks">
          {order.checks.map((check) => (
            <li key={check.label} data-state={check.state}>
              <CheckIcon state={check.state} />
              {check.label}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CheckIcon({ state }: { state: OrderCheck["state"] }): React.ReactNode {
  switch (state) {
    case "passed":
      return <Check aria-label="Passed" size={14} />;
    case "failed":
      return <X aria-label="Failed" size={14} />;
    case "warning":
      return <TriangleAlert aria-label="Warning" size={14} />;
    case "waiting":
      return <Clock aria-label="Scheduled" size={14} />;
    case "running":
      return <LoaderCircle aria-label="Checking now" size={14} />;
    case "pending":
      return <CircleDashed aria-label="Not checked yet" size={14} />;
  }
}
