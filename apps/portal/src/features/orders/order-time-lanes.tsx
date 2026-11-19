import React from "react";
import { useNavigate } from "react-router";
import { parseOrderTimes, type OrderTime } from "@purin-labs/control-api";

import { controlRead } from "../../control-client";
import { formatMoneyMinor } from "../../formatting";
import {
  duration,
  nowIn,
  periodWords,
  TimeLanes,
  TimeLanesFrame,
  TimeLanesKey,
  TimeLanesNote,
  usePeriod,
  usePeriodRange,
  usePeriodRead,
  useWiderWhenEmpty,
  ViewSwitch,
  type PeriodControl,
  type TimeLanesItem,
  type TimeLanesSection,
  type TimeLanesStatus,
  type TimeLanesStep,
  type TimeLanesTone,
} from "../../ui";

// How long each order took: a bar from when it was placed to when its stage
// began, or to now for an order that is still preparing. An order is late only
// against the time the shop itself promised, so late orders come first and no
// target is made up here.

const SECTIONS: readonly TimeLanesSection[] = [
  { key: "late", name: "Late", emphasis: true },
  { key: "preparing", name: "Preparing", emphasis: false },
  { key: "ready", name: "Ready", emphasis: false },
  { key: "finished", name: "Finished", emphasis: false },
  { key: "cancelled", name: "Cancelled", emphasis: false },
];

/** When the order stopped being worked on; now for one still preparing. */
function endOf(order: OrderTime, clock: number): number {
  return order.stageAt === null ? clock : Date.parse(order.stageAt);
}

/** The time the order ran past its promise, or zero. */
function lateBy(order: OrderTime, clock: number): number {
  if (order.expectedBy === null || order.stage === "cancelled") return 0;
  return Math.max(endOf(order, clock) - Date.parse(order.expectedBy), 0);
}

function linesLabel(order: OrderTime): string {
  const first = order.lines[0];
  if (first === undefined) return "Order";
  const title = first.title ?? "Item";
  const more = order.lines.length - 1;
  return more === 0
    ? `${title} × ${String(first.quantity)}`
    : `${title} + ${String(more)} more`;
}

function orderItem(
  order: OrderTime,
  clock: number,
  onOpen: (orderId: string) => void,
): TimeLanesItem {
  const late = lateBy(order, clock);
  const start = Date.parse(order.placedAt);
  const end = Math.max(endOf(order, clock), start);
  const tone: TimeLanesTone =
    late > 0
      ? "red"
      : order.stage === "preparing"
        ? "violet"
        : order.stage === "ready"
          ? "blue"
          : order.stage === "finished"
            ? "green"
            : "grey";
  const steps: TimeLanesStep[] = [
    { at: start, text: "Placed", tone: "info" },
    ...(order.expectedBy === null
      ? []
      : [
          {
            at: Date.parse(order.expectedBy),
            text: "Promised by",
            tone: "wait" as const,
          },
        ]),
    order.stageAt === null
      ? { at: null, text: "Still preparing", tone: "info" as const }
      : {
          at: Date.parse(order.stageAt),
          text:
            order.stage === "ready"
              ? "Ready for the buyer"
              : order.stage === "finished"
                ? "Handed over"
                : "Cancelled",
          tone:
            order.stage === "cancelled"
              ? ("failed" as const)
              : ("done" as const),
        },
  ];
  return {
    id: order.orderId,
    section: late > 0 ? "late" : order.stage,
    start,
    end,
    title: `${order.code} · ${linesLabel(order)}`,
    untitled: false,
    suffix:
      late > 0
        ? `${duration(late)} late`
        : order.stage === "cancelled"
          ? "Cancelled"
          : duration(end - start),
    suffixTone: late > 0 ? "red" : "grey",
    tone,
    avatar: { tone, letter: order.channel === "online" ? "O" : "C" },
    waits: [],
    parent: null,
    muted: order.stage === "finished" && late === 0,
    card: {
      meta: `${order.channel === "online" ? "Online" : "At the counter"} · ${formatMoneyMinor(order.amount.amountMinor, order.amount.currency)}`,
      steps,
      note:
        late > 0 && order.stage === "finished"
          ? "A hand-over time can include the time that the buyer took to come."
          : null,
      action: { label: "Open order", run: () => onOpen(order.orderId) },
    },
  };
}

function OrderTimeLanes(props: {
  readonly control: PeriodControl;
  readonly clock: number;
  readonly orders: readonly OrderTime[];
  readonly truncated: boolean;
  readonly onOpen: (orderId: string) => void;
  readonly status?: TimeLanesStatus;
}): React.ReactNode {
  const { control, clock, orders, onOpen } = props;
  const { period } = control;
  const [range, setRange] = usePeriodRange(period);
  const now = nowIn(period, clock);
  const items = orders.map((order) => orderItem(order, clock, onOpen));
  const count = (section: string): number =>
    items.filter((item) => item.section === section).length;
  const placed = orders.filter((order) => order.stage !== "cancelled");
  const done = placed.filter((order) => order.stageAt !== null);
  const average =
    done.length === 0
      ? null
      : done.reduce(
          (sum, order) =>
            sum + (endOf(order, clock) - Date.parse(order.placedAt)),
          0,
        ) / done.length;
  return (
    <TimeLanesFrame
      control={control}
      now={now}
      {...(props.status === undefined ? {} : { status: props.status })}
      range={range}
      onFit={() => setRange(null)}
      summary={
        <>
          <span>
            <b>{placed.length}</b> {placed.length === 1 ? "order" : "orders"}
          </span>
          {count("late") > 0 ? (
            <span className="time-lanes-summary-failed">
              <b>{count("late")}</b> late
            </span>
          ) : null}
          {average === null ? null : (
            <span>
              <b>{duration(average)}</b> on average
            </span>
          )}
        </>
      }
      notes={
        props.truncated ? (
          <TimeLanesNote>
            The view shows the most recent orders {periodWords(period)}. There
            are more.
          </TimeLanesNote>
        ) : null
      }
      empty={
        items.length === 0
          ? {
              title: `No orders ${periodWords(period)}`,
              detail: "An order shows here from the time it is placed.",
            }
          : null
      }
    >
      <TimeLanes
        label="How long each order took, with late orders first"
        sections={SECTIONS}
        items={items}
        bounds={[period.from, period.to]}
        now={now}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[
              { tone: "red", letter: "!", name: "Late" },
              { tone: "violet", letter: "O", name: "Online" },
              { tone: "violet", letter: "C", name: "At the counter" },
            ]}
            link={null}
          />
        }
      />
    </TimeLanesFrame>
  );
}

/** The order times of a period. It reads when it opens and on each change. */
function OrderTimes(props: {
  readonly organisationId: string;
  readonly onOpen: (orderId: string) => void;
}): React.ReactNode {
  const { organisationId } = props;
  const control = usePeriod();
  const reader = React.useCallback(
    async (window: Readonly<{ from: number; to: number }>) => {
      const params = new URLSearchParams({
        from: String(window.from),
        to: String(window.to),
      });
      return parseOrderTimes(
        await controlRead(
          `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/order-times?${params.toString()}`,
        ),
      );
    },
    [organisationId],
  );
  const read = usePeriodRead(control.period, reader, {
    loading: "Loading the order times",
    failed: "The order times could not be read.",
  });
  useWiderWhenEmpty(
    control,
    read.window,
    read.value !== null && read.value.orders.length === 0,
  );
  return (
    <OrderTimeLanes
      control={control}
      clock={Date.now()}
      orders={read.value?.orders ?? []}
      truncated={read.value?.truncated ?? false}
      onOpen={props.onOpen}
      status={read.status}
    />
  );
}

const ORDER_VIEWS = [
  { view: "list", name: "List" },
  { view: "timeline", name: "Timeline" },
] as const;

/** The order list and its timeline, for staff who work the orders. */
export function OrdersDisplay(props: {
  readonly organisationId: string;
  readonly orderHref: (orderId: string) => string;
  readonly list: React.ReactNode;
}): React.ReactNode {
  const [view, setView] = React.useState<"list" | "timeline">("list");
  const navigate = useNavigate();
  const { orderHref } = props;
  const open = React.useCallback(
    (orderId: string) => void navigate(orderHref(orderId)),
    [navigate, orderHref],
  );
  return (
    <>
      <div className="orders-display">
        <ViewSwitch
          label="Show orders as"
          value={view}
          views={ORDER_VIEWS}
          onChange={setView}
        />
        {view === "timeline" ? (
          <OrderTimes organisationId={props.organisationId} onOpen={open} />
        ) : null}
      </div>
      {view === "list" ? props.list : null}
    </>
  );
}
