import React from "react";
import type {
  BankPayout,
  BankPayoutSource,
  BankPayoutsWindow,
} from "@purin-labs/control-api";

import { formatMoneyMinor } from "@purin-labs/ui/formatting";
import {
  nowIn,
  periodWords,
  TimeLanes,
  TimeLanesFrame,
  TimeLanesKey,
  TimeLanesNote,
  usePeriod,
  usePeriodRange,
  usePeriodRead,
  type PeriodControl,
  type PeriodWindow,
  type TimeLanesItem,
  type TimeLanesSection,
  type TimeLanesStatus,
  type TimeLanesStep,
  type TimeLanesTone,
} from "@purin-labs/ui/index";
import { readBankPayouts } from "./requests";

// The money from card sales that reaches the shop's bank: a bar from the first
// sale that a payout pays out to the day that it arrives. Payouts are few, so
// the page opens on the month.

const SECTIONS: readonly TimeLanesSection[] = [
  { key: "problem", name: "Not paid", emphasis: true },
  { key: "moving", name: "On its way", emphasis: false },
  { key: "arrived", name: "In the bank", emphasis: false },
];

type Section = "problem" | "moving" | "arrived";

function sectionOf(payout: BankPayout): Section {
  switch (payout.status) {
    case "arrived":
      return "arrived";
    case "on_its_way":
      return "moving";
    case "failed":
    case "cancelled":
      return "problem";
  }
}

const SECTION_TONE: Record<Section, TimeLanesTone> = {
  problem: "red",
  moving: "blue",
  arrived: "green",
};

const PROVIDER: Record<
  BankPayout["provider"],
  Readonly<{ name: string; letter: string }>
> = {
  stripe: { name: "Stripe", letter: "St" },
  square: { name: "Square", letter: "Sq" },
};

/** A local calendar day: the provider gives the day at the bank, not a time. */
function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function arrivalTime(arrivalDate: string): number {
  const [year = 0, month = 1, day = 1] = arrivalDate.split("-").map(Number);
  return new Date(year, month - 1, day, 12).getTime();
}

function dayWords(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function arrivalWords(payout: BankPayout, arrival: number): string {
  switch (payout.status) {
    case "arrived":
      return `arrived ${dayWords(arrival)}`;
    case "on_its_way":
      return `due ${dayWords(arrival)}`;
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function payoutNote(payout: BankPayout): string | null {
  if (payout.status === "failed") return "The bank did not accept this payout.";
  if (payout.status === "cancelled")
    return "This payout was cancelled before it left.";
  if (payout.amount.amountMinor < 0)
    return `${PROVIDER[payout.provider].name} took this money back from the bank account.`;
  return payout.sales === null
    ? `${PROVIDER[payout.provider].name} does not list the sales of this payout.`
    : null;
}

function payoutItem(payout: BankPayout): TimeLanesItem {
  const section = sectionOf(payout);
  const tone = SECTION_TONE[section];
  const provider = PROVIDER[payout.provider];
  const sentAt = Date.parse(payout.sentAt);
  const arrival = arrivalTime(payout.arrivalDate);
  const start = Math.min(
    payout.sales === null ? sentAt : Date.parse(payout.sales.from),
    arrival,
  );
  const steps: TimeLanesStep[] = [
    ...(payout.sales === null
      ? []
      : [
          {
            at: Date.parse(payout.sales.from),
            text: "First sale",
            tone: "info" as const,
          },
          {
            at: Date.parse(payout.sales.to),
            text: "Last sale",
            tone: "info" as const,
          },
        ]),
    { at: sentAt, text: `${provider.name} sent it`, tone: "info" },
    {
      at: arrival,
      label: dayWords(arrival),
      text:
        section === "arrived"
          ? "In the bank"
          : section === "moving"
            ? "Due at the bank"
            : "Not paid",
      tone:
        section === "arrived"
          ? "done"
          : section === "moving"
            ? "wait"
            : "failed",
    },
  ];
  return {
    id: `${payout.provider}:${payout.payoutId}`,
    section,
    start,
    end: arrival,
    title: formatMoneyMinor(payout.amount.amountMinor, payout.amount.currency),
    untitled: false,
    suffix: arrivalWords(payout, arrival),
    suffixTone: section === "problem" ? "red" : "grey",
    tone,
    avatar: { tone, letter: provider.letter },
    waits: [],
    parent: null,
    muted: section === "arrived",
    card: {
      meta: `${provider.name} payout · ${payout.payoutId}`,
      steps,
      note: payoutNote(payout),
      action: null,
    },
  };
}

function SourceNotice(props: {
  readonly source: BankPayoutSource;
  readonly integrationsPath: string;
}): React.ReactNode {
  const { name } = PROVIDER[props.source.provider];
  switch (props.source.state) {
    case "read":
      return null;
    case "unavailable":
      return (
        <TimeLanesNote>
          {name} did not answer. This view shows the payouts that Purin Pantry
          read last.
        </TimeLanesNote>
      );
    case "needs_permission":
    case "scope_missing":
      return (
        <TimeLanesNote>
          {name} does not let Purin Pantry read payouts yet.{" "}
          <a href={props.integrationsPath}>
            Connect {name} again in Integrations
          </a>{" "}
          and accept the new permission.
        </TimeLanesNote>
      );
    case "refresh_failed":
      return (
        <TimeLanesNote>
          {name} did not renew the Purin Pantry sign-in.{" "}
          <a href={props.integrationsPath}>
            Connect {name} again in Integrations
          </a>{" "}
          to read payouts.
        </TimeLanesNote>
      );
    case "revoked":
      return (
        <TimeLanesNote>
          Purin Pantry was removed from your {name} account.{" "}
          <a href={props.integrationsPath}>
            Connect {name} again in Integrations
          </a>{" "}
          to read payouts.
        </TimeLanesNote>
      );
  }
}

/** A sum for each state, when the payouts share one currency. */
function total(payouts: readonly BankPayout[]): string | null {
  const first = payouts[0];
  if (
    first === undefined ||
    payouts.some((payout) => payout.amount.currency !== first.amount.currency)
  )
    return null;
  return formatMoneyMinor(
    payouts.reduce((sum, payout) => sum + payout.amount.amountMinor, 0),
    first.amount.currency,
  );
}

function BankPayoutsLanes(props: {
  readonly control: PeriodControl;
  readonly clock: number;
  readonly integrationsPath: string;
  readonly read: BankPayoutsWindow;
  readonly status?: TimeLanesStatus;
}): React.ReactNode {
  const { control, read } = props;
  const { period } = control;
  const [range, setRange] = usePeriodRange(period);
  const now = nowIn(period, props.clock);
  const arrived = read.payouts.filter(
    (payout) => sectionOf(payout) === "arrived",
  );
  const moving = read.payouts.filter(
    (payout) => sectionOf(payout) === "moving",
  );
  const arrivedTotal = total(arrived);
  const movingTotal = total(moving);
  const providers = new Set(read.sources.map((source) => source.provider));
  return (
    <TimeLanesFrame
      control={control}
      now={now}
      future
      {...(props.status === undefined ? {} : { status: props.status })}
      range={range}
      onFit={() => setRange(null)}
      summary={
        <>
          {arrivedTotal === null ? null : (
            <span>
              <b>{arrivedTotal}</b> in the bank
            </span>
          )}
          {movingTotal === null ? null : (
            <span>
              <b>{movingTotal}</b> on its way
            </span>
          )}
          <span>
            <b>{read.payouts.length}</b>{" "}
            {read.payouts.length === 1 ? "payout" : "payouts"}
          </span>
        </>
      }
      notices={read.sources.map((source) => (
        <SourceNotice
          key={source.provider}
          source={source}
          integrationsPath={props.integrationsPath}
        />
      ))}
      notes={
        read.truncated ? (
          <TimeLanesNote>
            The view shows the most recent payouts {periodWords(period)}. There
            are more.
          </TimeLanesNote>
        ) : null
      }
      empty={
        read.sources.length === 0
          ? {
              title: "No card provider is connected",
              detail:
                "Connect Stripe or Square to see when your card sales reach the bank.",
              action: (
                <a className="secondary" href={props.integrationsPath}>
                  Open Integrations
                </a>
              ),
            }
          : read.payouts.length === 0
            ? {
                title: `No payouts ${periodWords(period)}`,
                detail:
                  "A payout shows here from the day that your provider sends it.",
              }
            : null
      }
    >
      <TimeLanes
        label="Bank payouts from their first sale to their day at the bank"
        sections={SECTIONS}
        items={read.payouts.map(payoutItem)}
        bounds={[period.from, period.to]}
        now={now}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[...providers].map((provider) => ({
              tone: "green" as const,
              letter: PROVIDER[provider].letter,
              name: PROVIDER[provider].name,
            }))}
            link={null}
          />
        }
      />
    </TimeLanesFrame>
  );
}

const NO_PAYOUTS: BankPayoutsWindow = {
  sources: [],
  truncated: false,
  payouts: [],
};

/** The Payouts page. It reads when it opens and when the period changes. */
export function BankPayoutsRoute(props: {
  readonly organisationId: string;
  readonly integrationsPath: string;
}): React.ReactNode {
  const { organisationId } = props;
  const control = usePeriod(Date.now(), "month");
  const reader = React.useCallback(
    (window: PeriodWindow, signal: AbortSignal) =>
      readBankPayouts(
        organisationId,
        { from: localDay(window.from), to: localDay(window.to) },
        signal,
      ),
    [organisationId],
  );
  const read = usePeriodRead(control.period, reader, {
    loading: "Loading the payouts",
    failed: "The payouts could not be read.",
  });
  return (
    <section aria-label="Payouts">
      <BankPayoutsLanes
        control={control}
        clock={Date.now()}
        integrationsPath={props.integrationsPath}
        read={read.value ?? NO_PAYOUTS}
        status={read.status}
      />
    </section>
  );
}
