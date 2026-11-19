import React from "react";
import type { StockRow } from "@purin-labs/contracts";
import {
  parseInventoryDeliveries,
  type InventoryDeliveries,
  type InventoryDelivery,
} from "@purin-labs/control-api";

import { controlRead } from "../../control-client";
import { PageSkeleton, RecoverableError } from "../../page-components";
import {
  nowIn,
  periodWords,
  TimeLanes,
  TimeLanesFrame,
  TimeLanesKey,
  TimeLanesNote,
  usePeriod,
  usePeriodRange,
  useWiderWhenEmpty,
  type PeriodControl,
  type TimeLanesItem,
  type TimeLanesSection,
} from "../../ui";
import type { Variant } from "@purin-labs/type-utils";

// What expires and what arrives: each lot on its expiry date and each open
// purchase on its delivery date. The rows are the ones the page's search,
// location and category keep, so the timeline and the list show the same stock.

const SECTIONS: readonly TimeLanesSection[] = [
  { key: "expired", name: "Expired", emphasis: true },
  { key: "late", name: "Late deliveries", emphasis: true },
  { key: "expires", name: "Expires", emphasis: false },
  { key: "arrives", name: "Arrives", emphasis: false },
];

type Dated = Readonly<{ item: TimeLanesItem; at: number; overdue: boolean }>;

/** Lots that still hold stock, on the day that they expire. */
function lotEvents(
  rows: readonly StockRow[],
  now: number,
  onOpen: (rowId: string) => void,
): readonly Dated[] {
  return rows.flatMap((row) =>
    row.lots.flatMap((lot) => {
      const at =
        lot.expiresAt === null ? Number.NaN : Date.parse(lot.expiresAt);
      if (
        !Number.isFinite(at) ||
        lot.status !== "available" ||
        parseFloat(lot.remaining) === 0
      )
        return [];
      const overdue = at < now;
      const tone = overdue ? ("red" as const) : ("coral" as const);
      return [
        {
          at,
          overdue,
          item: {
            id: `lot-${lot.id}`,
            section: overdue ? "expired" : "expires",
            start: at,
            end: at,
            title: `${row.name} · ${lot.code}`,
            untitled: false,
            suffix: lot.remaining,
            suffixTone: overdue ? ("red" as const) : ("grey" as const),
            tone,
            avatar: { tone, letter: overdue ? "!" : "E" },
            waits: [],
            parent: null,
            muted: false,
            card: {
              meta: row.location,
              steps: [
                {
                  at,
                  text: `${overdue ? "Expired" : "Expires"} · ${lot.remaining} left`,
                  tone: overdue ? ("failed" as const) : ("wait" as const),
                },
              ],
              note: null,
              action: { label: "Open item", run: () => onOpen(row.id) },
            },
          },
        },
      ];
    }),
  );
}

/** Open purchases that have a delivery date, on that date. */
function deliveryEvents(
  rows: readonly StockRow[],
  deliveries: readonly InventoryDelivery[],
  now: number,
  onOpen: (rowId: string) => void,
): readonly Dated[] {
  return deliveries.flatMap((delivery) => {
    const row = rows.find(
      (candidate) =>
        candidate.inventoryItemId === delivery.inventoryItemId &&
        candidate.locationId === delivery.locationId,
    );
    const at =
      delivery.expectedAt === null
        ? Number.NaN
        : Date.parse(delivery.expectedAt);
    if (row === undefined || !Number.isFinite(at)) return [];
    const overdue = at < now || delivery.status === "late";
    const tone = overdue ? ("red" as const) : ("blue" as const);
    return [
      {
        at,
        overdue,
        item: {
          id: `delivery-${delivery.id}`,
          section: overdue ? "late" : "arrives",
          start: at,
          end: at,
          title: row.name,
          untitled: false,
          suffix: delivery.required,
          suffixTone: overdue ? ("red" as const) : ("grey" as const),
          tone,
          avatar: { tone, letter: overdue ? "!" : "A" },
          waits: [],
          parent: null,
          muted: false,
          card: {
            meta: `${delivery.supplier} · ${row.location}`,
            steps: [
              {
                at,
                text: overdue ? "Was due" : "Due to arrive",
                tone: overdue ? ("failed" as const) : ("info" as const),
              },
            ],
            note: `${delivery.received} received of ${delivery.required} requested.`,
            action: { label: "Open item", run: () => onOpen(row.id) },
          },
        },
      },
    ];
  });
}

function StockLanes(props: {
  readonly control: PeriodControl;
  readonly clock: number;
  readonly rows: readonly StockRow[];
  readonly deliveries: Variant<InventoryDeliveries, "ready">;
  readonly onOpen: (rowId: string) => void;
  readonly notice?: React.ReactNode;
}): React.ReactNode {
  const { control, clock, rows, deliveries, onOpen } = props;
  const { period } = control;
  const [range, setRange] = usePeriodRange(period);
  const now = nowIn(period, clock);
  const events = [
    ...lotEvents(rows, clock, onOpen),
    ...deliveryEvents(rows, deliveries.entries, clock, onOpen),
  ];
  const shown = events.filter(
    (event) => event.at >= period.from && event.at < period.to,
  );
  const items = shown.map((event) => event.item);
  // A lot that expired before this period, or a delivery that it missed, still
  // needs a person. The arrows reach it; this count says that it is there.
  const earlier = events.filter(
    (event) => event.overdue && event.at < period.from,
  ).length;
  const undated = deliveries.entries.filter(
    (delivery) =>
      delivery.expectedAt === null &&
      rows.some(
        (row) =>
          row.inventoryItemId === delivery.inventoryItemId &&
          row.locationId === delivery.locationId,
      ),
  ).length;
  const count = (section: string): number =>
    items.filter((item) => item.section === section).length;
  const expiring = count("expires") + count("expired");
  useWiderWhenEmpty(control, period, items.length === 0);
  return (
    <TimeLanesFrame
      className="stock-lanes"
      control={control}
      now={now}
      future
      range={range}
      onFit={() => setRange(null)}
      summary={
        <>
          <span>
            <b>{expiring}</b> {expiring === 1 ? "expires" : "expire"}
          </span>
          <span>
            <b>{count("arrives")}</b>{" "}
            {count("arrives") === 1 ? "arrives" : "arrive"}
          </span>
          {count("late") > 0 ? (
            <span className="time-lanes-summary-failed">
              <b>{count("late")}</b> late
            </span>
          ) : null}
          {earlier > 0 ? (
            <span className="time-lanes-summary-failed">
              <b>{earlier}</b> overdue from earlier
            </span>
          ) : null}
          {undated > 0 ? (
            <span>
              <b>{undated}</b> with no delivery date
            </span>
          ) : null}
        </>
      }
      notices={props.notice}
      notes={
        deliveries.truncated ? (
          <TimeLanesNote>
            There are more open purchases than one view shows, so some
            deliveries are not on this timeline.
          </TimeLanesNote>
        ) : null
      }
      empty={
        items.length === 0
          ? {
              title: `Nothing expires or arrives ${periodWords(period)}`,
              detail:
                "A lot with an expiry date and a purchase with a delivery date show here.",
            }
          : null
      }
    >
      <TimeLanes
        label="Lots that expire and purchases that arrive"
        sections={SECTIONS}
        items={items}
        bounds={[period.from, period.to]}
        now={now}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[
              { tone: "coral", letter: "E", name: "Expires" },
              { tone: "blue", letter: "A", name: "Arrives" },
              { tone: "red", letter: "!", name: "Needs a person" },
            ]}
            link={null}
          />
        }
      />
    </TimeLanesFrame>
  );
}

type Loaded =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "ready"; deliveries: InventoryDeliveries }>;

/** Reads the open purchases when it opens. The page holds the lots. */
export function StockTimeline(props: {
  readonly organisationId: string;
  readonly rows: readonly StockRow[];
  readonly onOpen: (rowId: string) => void;
}): React.ReactNode {
  const { organisationId } = props;
  const control = usePeriod(Date.now(), "week");
  const [loaded, setLoaded] = React.useState<Loaded>({ kind: "loading" });
  const request = React.useRef(0);
  const load = React.useCallback(async (): Promise<void> => {
    const current = ++request.current;
    setLoaded({ kind: "loading" });
    try {
      const raw = await controlRead(
        `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory/deliveries`,
      );
      const deliveries = parseInventoryDeliveries(
        (raw as { deliveries?: unknown }).deliveries,
      );
      if (current === request.current) setLoaded({ kind: "ready", deliveries });
    } catch {
      if (current === request.current) setLoaded({ kind: "failed" });
    }
  }, [organisationId]);
  React.useEffect(() => {
    void load();
  }, [load]);
  if (loaded.kind === "loading")
    return <PageSkeleton label="Loading the deliveries" />;
  if (loaded.kind === "failed")
    return (
      <RecoverableError
        message="The deliveries could not be read."
        action={
          <button
            className="secondary"
            type="button"
            onClick={() => void load()}
          >
            Try again
          </button>
        }
      />
    );
  // Lots still show when purchasing is not set up.
  const deliveries =
    loaded.deliveries.kind === "ready"
      ? loaded.deliveries
      : ({ kind: "ready", entries: [], truncated: false } as const);
  return (
    <StockLanes
      control={control}
      clock={Date.now()}
      rows={props.rows}
      deliveries={deliveries}
      onOpen={props.onOpen}
      notice={
        loaded.deliveries.kind === "unavailable" ? (
          <TimeLanesNote>
            Purchasing data is unavailable, so this timeline shows only lots.
          </TimeLanesNote>
        ) : null
      }
    />
  );
}
