import React from "react";

import {
  periodWords,
  TimeLanes,
  TimeLanesFrame,
  TimeLanesKey,
  usePeriodRange,
  type PeriodControl,
  type TimeLanesItem,
  type TimeLanesSection,
  type TimeLanesStatus,
  type TimeLanesStep,
} from "../../ui";

// A period of payments: each card payment that the provider answered, paid or
// declined. A declined payment shows each later try by the same buyer, and a
// line joins each retry to the payment it follows. The view only shows what the
// caller gives it; it reads nothing.

export type PaymentStep = Readonly<{
  stepId: string;
  /** What the buyer tried to buy: "Sencha tin × 2". */
  bought: string;
  channel: "online" | "counter";
  amount: string;
  at: number;
  state: "declined" | "paid";
  /** Why the card provider declined, in words. */
  reason: string | null;
  /** The pickup code of the order that a paid step placed. */
  orderCode: string | null;
  /** The step this one follows. */
  follows: string | null;
}>;

export type PaymentLanesProps = Readonly<{
  control: PeriodControl;
  now: number | null;
  steps: readonly PaymentStep[];
  /** The money that the paid steps took, in words: "¥12,400". */
  taken?: string;
  status?: TimeLanesStatus;
  notes?: React.ReactNode;
}>;

// A run that no later try paid is "open"; one that a later try paid is
// "recovered"; a payment with no decline before it is "paid".
type Outcome = "open" | "recovered" | "paid";

const SECTIONS: readonly TimeLanesSection[] = [
  { key: "open", name: "Not recovered", emphasis: true },
  { key: "recovered", name: "Recovered", emphasis: false },
  { key: "paid", name: "Paid", emphasis: false },
];

export function PaymentLanes(props: PaymentLanesProps): React.ReactNode {
  const { period } = props.control;
  const [range, setRange] = usePeriodRange(period);
  const now = props.now;
  // A retry shares a section with the payment it follows: paid or not.
  const follows = new Map(
    props.steps.map((step) => [step.stepId, step.follows]),
  );
  const rootOf = (stepId: string): string => {
    const parent = follows.get(stepId) ?? null;
    return parent === null ? stepId : rootOf(parent);
  };
  const outcome = new Map<string, Outcome>();
  for (const step of props.steps) {
    const root = rootOf(step.stepId);
    if (step.state === "paid")
      outcome.set(root, step.follows === null ? "paid" : "recovered");
    else if (!outcome.has(root)) outcome.set(root, "open");
  }
  const orders = [...outcome.values()];
  const count = (state: Outcome): number =>
    orders.filter((value) => value === state).length;
  return (
    <TimeLanesFrame
      control={props.control}
      now={now}
      {...(props.status === undefined ? {} : { status: props.status })}
      range={range}
      onFit={() => setRange(null)}
      summary={
        <>
          <span>
            <b>{orders.length}</b>{" "}
            {orders.length === 1 ? "payment" : "payments"}
          </span>
          {props.taken === undefined ? null : (
            <span>
              <b>{props.taken}</b> paid
            </span>
          )}
          <span>
            <b>{count("open")}</b> not recovered
          </span>
        </>
      }
      notes={props.notes}
      empty={
        props.steps.length === 0
          ? {
              title: `No payments ${periodWords(period)}`,
              detail:
                "A card payment shows here when the provider answers it, with each later try by the same buyer.",
            }
          : null
      }
    >
      <TimeLanes
        label="Payments and how declined ones recover"
        sections={SECTIONS}
        items={props.steps.map((step) =>
          stepItem(step, outcome.get(rootOf(step.stepId)) ?? "open"),
        )}
        bounds={[period.from, period.to]}
        now={now}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[
              { tone: "red", letter: "¥", name: "Card declined" },
              { tone: "green", letter: "¥", name: "Card paid" },
            ]}
            link="Follows"
          />
        }
        linkWords={{ parent: "Follows", child: "Then" }}
      />
    </TimeLanesFrame>
  );
}

function stepItem(step: PaymentStep, section: Outcome): TimeLanesItem {
  const paid = step.state === "paid";
  const tone = paid ? "green" : "red";
  const steps: TimeLanesStep[] = [
    paid
      ? {
          at: step.at,
          text:
            step.orderCode === null
              ? `Paid ${step.amount}`
              : `Paid ${step.amount} · order ${step.orderCode}`,
          tone: "done",
        }
      : {
          at: step.at,
          text: `Declined ${step.amount}${step.reason === null ? "" : `: ${step.reason}`}`,
          tone: "failed",
        },
  ];
  return {
    id: step.stepId,
    section,
    start: step.at,
    end: step.at,
    title:
      step.follows === null
        ? `${step.bought} · ${step.amount}`
        : `${step.bought} · retry`,
    untitled: false,
    suffix: paid ? "Paid" : "Declined",
    suffixTone: tone,
    tone,
    avatar: { tone, letter: "¥" },
    waits: [],
    parent: step.follows,
    muted: section !== "open",
    card: {
      meta: `${step.bought} · ${step.channel === "online" ? "Online" : "At the counter"}`,
      steps,
      note: null,
      action: null,
    },
  };
}
