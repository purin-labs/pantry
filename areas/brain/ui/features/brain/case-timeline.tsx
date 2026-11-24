import React from "react";

import type {
  CaseTimelineCase,
  CaseTimelineDay,
  CaseTimelineOutcomeKind,
} from "@purin-labs/control-api";

import { TimeLanesFrame, TimeLanesNote } from "@purin-labs/ui/time-lanes-frame";
import {
  duration,
  nowIn,
  periodWords,
  timeIn,
  TimeLanes,
  TimeLanesKey,
  usePeriodRange,
  type PeriodControl,
  type TimeLanesItem,
  type TimeLanesSection,
  type TimeLanesStep,
  type TimeLanesTone,
} from "@purin-labs/ui/time-lanes";
import { originLabel } from "./execution-model";

export type ActivityTimeline =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; timeline: CaseTimelineDay }>;

/**
 * A day, a week or a month of Cases on a timeline. Each Case is one event: a bar in the
 * colour of whoever held it, its owner and its title. Cases that wait for a
 * person come first. A line joins a side Case to the Case that proposed it.
 * The details of a Case show in a card on hover, focus or click.
 */
export function CaseTimeline(props: {
  readonly timeline: ActivityTimeline;
  readonly control: PeriodControl;
  readonly now: number;
  readonly onReload: () => void;
  readonly onOpenCase: (caseId: string) => void;
}): React.ReactNode {
  const { timeline, control } = props;
  const { period } = control;
  const now = nowIn(period, props.now);
  const bounds = [period.from, period.to] as const;
  const [range, setRange] = usePeriodRange(period);
  return (
    <TimeLanesFrame
      control={control}
      now={now}
      status={
        timeline.kind === "loading"
          ? { kind: "loading", label: "Loading the Cases" }
          : timeline.kind === "failed"
            ? {
                kind: "failed",
                message: timeline.message,
                retry: props.onReload,
              }
            : { kind: "ready" }
      }
      range={range}
      onFit={() => setRange(null)}
      summary={
        timeline.kind === "ready" ? (
          <TimelineSummary cases={timeline.timeline.cases} />
        ) : null
      }
      notes={
        timeline.kind === "ready" && timeline.timeline.truncated ? (
          <TimeLanesNote>
            There are more Cases {periodWords(period)} than one view shows. The
            newest are shown.
          </TimeLanesNote>
        ) : null
      }
      empty={
        timeline.kind === "ready" && timeline.timeline.cases.length === 0
          ? {
              title: `No Cases ${periodWords(period)}`,
              detail:
                "A Case appears here at the time it was filed, when you may read it.",
            }
          : null
      }
    >
      {timeline.kind === "ready" ? (
        <TimeLanes
          label="Cases on a timeline"
          sections={SECTIONS}
          items={timeline.timeline.cases.map((event) =>
            caseItem(event, now, bounds, () => props.onOpenCase(event.caseId)),
          )}
          bounds={bounds}
          now={now}
          range={range}
          onRange={setRange}
          legend={<OwnerKey />}
          linkWords={{ parent: "Side Case of", child: "Started" }}
        />
      ) : null}
    </TimeLanesFrame>
  );
}

/**
 * The number of Cases in the period. Each lane is a state and shows its own
 * count, so the summary does not repeat them.
 */
function TimelineSummary(props: {
  readonly cases: readonly CaseTimelineCase[];
}): React.ReactNode {
  return (
    <span>
      <b>{props.cases.length}</b> {props.cases.length === 1 ? "Case" : "Cases"}
    </span>
  );
}

/* ---------- Cases as timeline items ---------- */

type Section = "waiting" | "failed" | "running" | "settled";
const SECTIONS: readonly TimeLanesSection[] = [
  { key: "waiting", name: "Waits for a person", emphasis: true },
  { key: "failed", name: "Failed", emphasis: false },
  { key: "running", name: "Running", emphasis: false },
  { key: "settled", name: "Settled", emphasis: false },
];
type Holder = "coordinator" | "research" | "specialist" | "person";

const HOLDER_TONE: Record<Holder, TimeLanesTone> = {
  coordinator: "violet",
  research: "blue",
  specialist: "green",
  person: "coral",
};

function OwnerKey(): React.ReactNode {
  return (
    <TimeLanesKey
      owners={(
        ["coordinator", "research", "specialist", "person"] as const
      ).map((holder) => ({
        tone: HOLDER_TONE[holder],
        letter: holder === "person" ? null : holderInitial(holder),
        name: holderLabel(holder),
      }))}
      link="Side Case of"
    />
  );
}

function caseItem(
  event: CaseTimelineCase,
  now: number | null,
  bounds: readonly [number, number],
  open: () => void,
): TimeLanesItem {
  const section = stateOf(event);
  const holder = holderOf(event);
  const role = event.agent?.role ?? "coordinator";
  const meta = [
    originLabel(event.origin),
    event.agent === null ? null : holderLabel(event.agent.role),
    `from ${timeIn(bounds, event.startedAt)}`,
  ].filter((part) => part !== null);
  return {
    id: event.caseId,
    section,
    start: event.startedAt,
    end: endOf(event, now),
    title: event.title ?? `${originLabel(event.origin)} Case`,
    untitled: event.title === null,
    suffix: suffixOf(event, now),
    suffixTone:
      section === "waiting"
        ? "coral"
        : section === "failed"
          ? "red"
          : section === "running"
            ? HOLDER_TONE[holder]
            : null,
    tone: HOLDER_TONE[role],
    avatar: {
      tone: HOLDER_TONE[holder],
      letter: holder === "person" ? null : holderInitial(holder),
    },
    waits: event.spans
      .filter((span) => span.holder === "person")
      .map((span) => ({ from: span.from, to: span.to })),
    parent: event.sideCaseOf,
    muted: section === "settled",
    card: {
      meta: meta.join(" · "),
      steps: stepsOf(event, now),
      note:
        event.withheld === 0
          ? null
          : event.withheld === 1
            ? "1 record of this Case is not shown to you."
            : `${String(event.withheld)} records of this Case are not shown to you.`,
      action: { label: "Open Case trace", run: open },
    },
  };
}

function stateOf(event: CaseTimelineCase): Section {
  switch (event.outcome?.kind) {
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    case "running":
      return "running";
    default:
      return "settled";
  }
}

/** When the event ends on the timeline: its last known time, or now. */
function endOf(event: CaseTimelineCase, now: number | null): number {
  let end = event.startedAt;
  for (const at of [event.source.at, event.agent?.at, event.context?.at])
    if (at !== undefined) end = Math.max(end, at);
  if (event.outcome !== null) end = Math.max(end, event.outcome.at);
  for (const span of event.spans)
    end = Math.max(end, span.to ?? now ?? span.from);
  const open = stateOf(event);
  if (now !== null && (open === "waiting" || open === "running"))
    end = Math.max(end, now);
  return end;
}

/** Who holds the Case now, or who held it last. */
function holderOf(event: CaseTimelineCase): Holder {
  if (stateOf(event) === "waiting") return "person";
  return event.agent?.role ?? "coordinator";
}

function suffixOf(event: CaseTimelineCase, now: number | null): string | null {
  switch (stateOf(event)) {
    case "waiting": {
      const open = event.spans.filter(
        (span) => span.holder === "person" && span.to === null,
      );
      const since = open.at(-1)?.from ?? event.outcome?.at ?? event.startedAt;
      return now === null ? "Waits" : duration(now - since);
    }
    case "running":
      return now === null
        ? "Running"
        : duration(now - (event.agent?.at ?? event.startedAt));
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

/** What the Case's records show, in time order. */
function stepsOf(event: CaseTimelineCase, now: number | null): TimeLanesStep[] {
  const steps: TimeLanesStep[] = [
    {
      at: event.source.at,
      text:
        event.source.trigger === "cue"
          ? "Started on a schedule"
          : event.source.trigger === "api"
            ? "Started through the API"
            : `Arrived from ${originLabel(event.origin)}`,
      tone: "info",
    },
  ];
  if (event.agent !== null)
    steps.push({
      at: event.agent.at,
      text: `${holderLabel(event.agent.role)} started`,
      tone: "info",
    });
  if (event.context !== null)
    steps.push({
      at: event.context.at,
      text: `Used ${contextLabel(event.context)}`,
      tone: "info",
    });
  for (const span of event.spans)
    if (span.holder === "person" && span.to !== null)
      steps.push({
        at: span.from,
        text: `Waited ${duration(span.to - span.from)} for a person`,
        tone: "wait",
      });
  if (event.outcome !== null) {
    const waiting = event.outcome.kind === "waiting";
    steps.push({
      at: waiting || event.outcome.kind === "running" ? null : event.outcome.at,
      text:
        waiting && now !== null
          ? `Waits for a person · ${duration(now - event.outcome.at)}`
          : outcomeLabel(event.outcome.kind),
      tone: waiting
        ? "wait"
        : event.outcome.kind === "failed" || event.outcome.kind === "rejected"
          ? "failed"
          : "done",
    });
  }
  return steps.sort(
    (left, right) =>
      (left.at ?? Number.MAX_SAFE_INTEGER) -
      (right.at ?? Number.MAX_SAFE_INTEGER),
  );
}

/* ---------- words ---------- */

function holderLabel(holder: Holder): string {
  switch (holder) {
    case "coordinator":
      return "Agent";
    case "research":
      return "Research agent";
    case "specialist":
      return "Specialist agent";
    case "person":
      return "A person";
    default:
      return "Agent";
  }
}

function holderInitial(holder: Holder): string {
  return holder === "research" ? "R" : holder === "specialist" ? "S" : "A";
}

function contextLabel(
  context: NonNullable<CaseTimelineCase["context"]>,
): string {
  const parts: string[] = [];
  if (context.memories > 0)
    parts.push(
      context.memories === 1
        ? "1 memory"
        : `${String(context.memories)} memories`,
    );
  if (context.reads > 0)
    parts.push(
      context.reads === 1 ? "1 read" : `${String(context.reads)} reads`,
    );
  return parts.join(" · ");
}

function outcomeLabel(kind: CaseTimelineOutcomeKind): string {
  switch (kind) {
    case "waiting":
      return "Waits for a person";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "receipt":
      return "Receipt recorded";
    case "delivered":
      return "Delivered";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    case "done":
      return "Done";
    default:
      return "";
  }
}
