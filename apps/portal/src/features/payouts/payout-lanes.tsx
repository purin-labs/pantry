import React from "react";

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
  type PeriodControl,
  type TimeLanesItem,
  type TimeLanesSection,
  type TimeLanesStatus,
  type TimeLanesStep,
  type TimeLanesTone,
} from "../../ui";
import {
  needsOperator,
  payoutGuidance,
  readPayoutsInWindow,
  supplierPayoutAuditPath,
} from "./api";
import type { DatedSupplierPayout } from "@seams/control-api/portal/payouts";

// Money paid to suppliers over time: a bar from when each payout was proposed to
// its last change, or to now while its outcome is still open. Payouts are few,
// so the timeline opens on the month.

const SECTIONS: readonly TimeLanesSection[] = [
  { key: "person", name: "Needs a person", emphasis: true },
  { key: "problem", name: "Not paid", emphasis: true },
  { key: "moving", name: "On its way", emphasis: false },
  { key: "sent", name: "Sent", emphasis: false },
];

type Section = "person" | "problem" | "moving" | "sent";

function sectionOf(payout: DatedSupplierPayout): Section {
  if (needsOperator(payout)) return "person";
  switch (payout.state) {
    case "settled":
      return "sent";
    case "failed":
    case "returned":
    case "reversed":
    case "cancelled":
      return "problem";
    default:
      return "moving";
  }
}

const SECTION_TONE: Record<Section, TimeLanesTone> = {
  person: "coral",
  problem: "red",
  moving: "blue",
  sent: "green",
};

function payoutItem(
  payout: DatedSupplierPayout,
  now: number | null,
  organisationId: string,
): TimeLanesItem {
  const section = sectionOf(payout);
  const tone = SECTION_TONE[section];
  const open = section === "person" || section === "moving";
  const end = open
    ? Math.max(now ?? payout.updatedAt, payout.updatedAt)
    : payout.updatedAt;
  const steps: TimeLanesStep[] = [
    { at: payout.createdAt, text: "Proposed", tone: "info" },
    open
      ? { at: null, text: "Outcome not known yet", tone: "wait" }
      : {
          at: payout.updatedAt,
          text: section === "sent" ? "Sent and confirmed" : "Ended unpaid",
          tone: section === "sent" ? "done" : "failed",
        },
  ];
  return {
    id: payout.payoutId,
    section,
    start: payout.createdAt,
    end,
    title: `${payout.supplierId} · ${formatMoneyMinor(payout.recipientAmountMinor, payout.currency)}`,
    untitled: false,
    suffix: section === "sent" ? duration(end - payout.createdAt) : null,
    suffixTone: "grey",
    tone,
    avatar: {
      tone,
      letter: payout.rail === "gmo_aozora_private" ? "G" : "W",
    },
    waits: section === "person" ? [{ from: payout.updatedAt, to: null }] : [],
    parent: null,
    muted: section === "sent",
    card: {
      meta: `${payout.rail === "gmo_aozora_private" ? "GMO Aozora" : "Wise"} · payable ${payout.payableId}`,
      steps,
      note: payoutGuidance(payout),
      action: {
        label: "Download audit",
        run: () =>
          window.location.assign(
            supplierPayoutAuditPath(organisationId, payout.payoutId),
          ),
      },
    },
  };
}

function PayoutLanes(props: {
  readonly control: PeriodControl;
  readonly clock: number;
  readonly organisationId: string;
  readonly payouts: readonly DatedSupplierPayout[];
  readonly truncated: boolean;
  readonly status?: TimeLanesStatus;
}): React.ReactNode {
  const { control, payouts } = props;
  const { period } = control;
  const [range, setRange] = usePeriodRange(period);
  const now = nowIn(period, props.clock);
  const items = payouts.map((payout) =>
    payoutItem(payout, now ?? props.clock, props.organisationId),
  );
  const sent = payouts.filter((payout) => sectionOf(payout) === "sent");
  const currencies = new Set(sent.map((payout) => payout.currency));
  const onlyCurrency = currencies.size === 1 ? [...currencies][0] : undefined;
  const waiting = items.filter((item) => item.section === "person").length;
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
            <b>{sent.length}</b> sent
          </span>
          {onlyCurrency === undefined ? null : (
            <span>
              <b>
                {formatMoneyMinor(
                  sent.reduce(
                    (sum, payout) => sum + payout.recipientAmountMinor,
                    0,
                  ),
                  onlyCurrency,
                )}
              </b>{" "}
              paid
            </span>
          )}
          {waiting > 0 ? (
            <span className="time-lanes-summary-wait">
              <b>{waiting}</b> {waiting === 1 ? "waits" : "wait"} for a person
            </span>
          ) : null}
        </>
      }
      notes={
        props.truncated ? (
          <TimeLanesNote>
            The view shows the most recent payouts {periodWords(period)}. There
            are more.
          </TimeLanesNote>
        ) : null
      }
      empty={
        items.length === 0
          ? {
              title: `No supplier payouts ${periodWords(period)}`,
              detail: "A payout shows here from the time that it is proposed.",
            }
          : null
      }
    >
      <TimeLanes
        label="Supplier payouts from proposal to their last change"
        sections={SECTIONS}
        items={items}
        bounds={[period.from, period.to]}
        now={now}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[
              { tone: "green", letter: "W", name: "Wise" },
              { tone: "green", letter: "G", name: "GMO Aozora" },
              { tone: "coral", letter: "!", name: "A person acts" },
            ]}
            link={null}
          />
        }
      />
    </TimeLanesFrame>
  );
}

/** The payouts of a period. It reads when it opens and on each change. */
export function PayoutTimeline(props: {
  readonly organisationId: string;
}): React.ReactNode {
  const { organisationId } = props;
  const control = usePeriod(Date.now(), "month");
  const reader = React.useCallback(
    (window: Readonly<{ from: number; to: number }>) =>
      readPayoutsInWindow(organisationId, window),
    [organisationId],
  );
  const read = usePeriodRead(control.period, reader, {
    loading: "Loading the payouts",
    failed: "The payout timeline could not be read.",
  });
  useWiderWhenEmpty(
    control,
    read.window,
    read.value !== null && read.value.payouts.length === 0,
  );
  return (
    <PayoutLanes
      control={control}
      clock={Date.now()}
      organisationId={organisationId}
      payouts={read.value?.payouts ?? []}
      truncated={read.value?.truncated ?? false}
      status={read.status}
    />
  );
}
