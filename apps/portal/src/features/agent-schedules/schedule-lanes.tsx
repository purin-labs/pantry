import React from "react";

import {
  duration,
  periodWords,
  startOfDay,
  timeIn,
  TimeLanes,
  TimeLanesFrame,
  TimeLanesKey,
  usePeriodRange,
  type PeriodControl,
  type TimeLanesItem,
  type TimeLanesStatus,
  type TimeLanesStep,
  type TimeLanesTone,
} from "@purin-labs/ui/index";

// The day of each agent's scheduled runs: the runs that already went, the
// one that runs now, and the ones still planned for the day. A run that
// waits for a person is hatched, and a side Case that a run started joins
// it with a line. The view only shows what the caller gives it; it reads
// nothing.

export type ScheduledAgent = Readonly<{
  agentId: string;
  name: string;
  role: "coordinator" | "research" | "specialist";
}>;

export type ScheduleRun = Readonly<{
  runId: string;
  agentId: string;
  /** "Daily at 07:00", or "Side Case" for work that a run started. */
  schedule: string;
  title: string;
  /** When the window opened, or when a planned run will start. */
  at: number;
  /** When the run ended; null while it runs, waits or is planned. */
  endedAt: number | null;
  /** "ran" when the run's Case records are not shown to this reader. */
  state: "planned" | "running" | "waiting" | "done" | "failed" | "ran";
  /** Since when a waiting run waits for a person. */
  waitsSince: number | null;
  /** The run that started this one, for a side Case. */
  startedBy: string | null;
  caseId: string | null;
}>;

type ScheduleLanesProps = Readonly<{
  control: PeriodControl;
  now: number | null;
  agents: readonly ScheduledAgent[];
  runs: readonly ScheduleRun[];
  onOpenCase: (caseId: string) => void;
  status?: TimeLanesStatus;
  notes?: React.ReactNode;
}>;

const ROLE_TONE: Record<ScheduledAgent["role"], TimeLanesTone> = {
  coordinator: "violet",
  research: "blue",
  specialist: "green",
};

const ROLE_LETTER: Record<ScheduledAgent["role"], string> = {
  coordinator: "A",
  research: "R",
  specialist: "S",
};

export function ScheduleLanes(props: ScheduleLanesProps): React.ReactNode {
  const { period } = props.control;
  const [range, setRange] = usePeriodRange(period);
  const bounds = [period.from, period.to] as const;
  const now = props.now;
  const byAgent = new Map(props.agents.map((agent) => [agent.agentId, agent]));
  // The first run of a series carries its title; the repeats show only
  // their suffix, so an hourly schedule fits one lane.
  const seen = new Set<string>();
  const sorted = [...props.runs].sort((left, right) => left.at - right.at);
  const items = (
    period.span === "day" ? sorted.map((run) => [run]) : runsByDay(sorted)
  ).flatMap((runs) => {
    const run = runs.reduce((shown, other) =>
      STATE_WEIGHT[other.state] > STATE_WEIGHT[shown.state] ? other : shown,
    );
    const agent = byAgent.get(run.agentId);
    if (agent === undefined) return [];
    const series = `${run.agentId}:${run.schedule}:${run.title}`;
    const repeat = seen.has(series);
    seen.add(series);
    const item = runItem(run, agent, now, props.onOpenCase);
    const joined = runs.length > 1;
    // A planned repeat is a mark alone: the key says what grey means.
    return [
      {
        ...item,
        start: runs[0]?.at ?? run.at,
        end: Math.max(
          ...runs.map(
            (other) => runItem(other, agent, now, props.onOpenCase).end,
          ),
        ),
        quiet: repeat,
        suffix:
          joined && !repeat
            ? `${String(runs.length)} runs`
            : (repeat && period.span !== "day" && run.state !== "failed") ||
                (repeat && run.state === "planned")
              ? null
              : item.suffix,
        card: joined
          ? {
              ...item.card,
              note: `One of ${String(runs.length)} runs on this day. ${item.card.note ?? ""}`.trim(),
            }
          : item.card,
      },
    ];
  });
  const failed = props.runs.filter((run) => run.state === "failed").length;
  const waiting = props.runs.filter((run) => run.state === "waiting").length;
  const next = props.runs
    .filter((run) => run.state === "planned")
    .sort((left, right) => left.at - right.at)[0];
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
            <b>{props.runs.filter((run) => run.state !== "planned").length}</b>{" "}
            runs
          </span>
          {waiting > 0 ? (
            <span className="time-lanes-summary-wait">
              <b>{waiting}</b> {waiting === 1 ? "waits" : "wait"} for a person
            </span>
          ) : null}
          {failed > 0 ? (
            <span className="time-lanes-summary-failed">
              <b>{failed}</b> failed
            </span>
          ) : null}
          {next === undefined ? null : (
            <span>
              Next at <b>{timeIn(bounds, next.at)}</b>
            </span>
          )}
        </>
      }
      notes={props.notes}
      empty={
        props.runs.length === 0
          ? {
              title: `No scheduled runs ${periodWords(period)}`,
              detail: "A run shows here when its schedule starts it.",
            }
          : null
      }
    >
      <TimeLanes
        label="Scheduled runs on a timeline"
        sections={props.agents.map((agent) => ({
          key: agent.agentId,
          name: agent.name,
          emphasis: false,
        }))}
        items={items}
        bounds={bounds}
        now={now}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[
              ...props.agents.map((agent) => ({
                tone: ROLE_TONE[agent.role],
                letter: ROLE_LETTER[agent.role],
                name: agent.name,
              })),
              { tone: "coral", letter: null, name: "A person" },
              { tone: "grey", letter: "·", name: "Planned" },
            ]}
            link="Side Case of"
          />
        }
        linkWords={{ parent: "Side Case of", child: "Started" }}
      />
    </TimeLanesFrame>
  );
}

/** The run that speaks for its day: a fault before work in progress or done. */
const STATE_WEIGHT: Record<ScheduleRun["state"], number> = {
  planned: 0,
  ran: 1,
  done: 1,
  running: 2,
  waiting: 3,
  failed: 4,
};

/**
 * In a week or a month an hourly schedule's marks would touch, so each series
 * joins into one bar for each day. Runs that have happened and planned runs
 * stay apart, because grey says that a run has not happened.
 */
function runsByDay(runs: readonly ScheduleRun[]): readonly ScheduleRun[][] {
  const days = new Map<string, ScheduleRun[]>();
  for (const run of runs) {
    const key = [
      run.agentId,
      run.schedule,
      run.title,
      startOfDay(run.at),
      run.state === "planned",
    ].join(":");
    const day = days.get(key);
    if (day === undefined) days.set(key, [run]);
    else day.push(run);
  }
  return [...days.values()];
}

function runItem(
  run: ScheduleRun,
  agent: ScheduledAgent,
  now: number | null,
  open: (caseId: string) => void,
): TimeLanesItem {
  const caseId = run.caseId;
  const end =
    run.endedAt ??
    (run.state === "planned" || run.state === "ran"
      ? run.at
      : Math.max(now ?? run.at, run.at));
  const tone = run.state === "planned" ? "grey" : ROLE_TONE[agent.role];
  const steps: TimeLanesStep[] =
    run.state === "planned"
      ? [{ at: run.at, text: "Planned to start", tone: "info" }]
      : [
          {
            at: run.at,
            text:
              run.startedBy === null
                ? "Started on its schedule"
                : "Started by a run",
            tone: "info",
          },
          ...(run.waitsSince === null
            ? []
            : [
                {
                  at: null,
                  text:
                    now === null
                      ? "Waits for a person"
                      : `Waits for a person · ${duration(now - run.waitsSince)}`,
                  tone: "wait" as const,
                },
              ]),
          ...(run.state === "done" && run.endedAt !== null
            ? [{ at: run.endedAt, text: "Done", tone: "done" as const }]
            : run.state === "failed" && run.endedAt !== null
              ? [{ at: run.endedAt, text: "Failed", tone: "failed" as const }]
              : run.state === "running"
                ? [{ at: null, text: "Running", tone: "info" as const }]
                : []),
        ];
  return {
    id: run.runId,
    section: agent.agentId,
    start: run.at,
    end,
    title: run.title,
    untitled: false,
    suffix:
      run.state === "planned"
        ? "Planned"
        : run.state === "ran"
          ? "Ran"
          : run.state === "failed"
            ? "Failed"
            : run.state === "waiting"
              ? now === null || run.waitsSince === null
                ? "Waits"
                : duration(now - run.waitsSince)
              : run.state === "running"
                ? now === null
                  ? "Running"
                  : duration(now - run.at)
                : run.endedAt === null
                  ? null
                  : duration(run.endedAt - run.at),
    suffixTone:
      run.state === "failed"
        ? "red"
        : run.state === "waiting"
          ? "coral"
          : run.state === "running"
            ? ROLE_TONE[agent.role]
            : "grey",
    tone,
    avatar:
      run.state === "waiting"
        ? { tone: "coral", letter: null }
        : run.state === "planned"
          ? { tone: "grey", letter: "·" }
          : {
              tone: run.state === "failed" ? "red" : tone,
              letter: ROLE_LETTER[agent.role],
            },
    waits: run.waitsSince === null ? [] : [{ from: run.waitsSince, to: null }],
    parent: run.startedBy,
    muted:
      run.state === "done" || run.state === "planned" || run.state === "ran",
    card: {
      meta: `${run.schedule} · ${agent.name}`,
      steps,
      note:
        run.state === "ran"
          ? "What the agent did in this run is not shown to you."
          : null,
      action:
        caseId === null
          ? null
          : { label: "Open Case trace", run: () => open(caseId) },
    },
  };
}
