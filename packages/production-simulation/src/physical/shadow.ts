import type { BakePlan, PlannedStep } from "./compile.ts";
import {
  sameTask,
  type CarrierAt,
  type ClockOrigin,
  type CobotObserved,
  type CobotTask,
} from "./protocol.ts";

/**
 * Shadow mode (S5): the controller runs a bake from its own script, as a
 * person at the teach pendant would, and the run only watches. Each
 * observed move is matched to the planned task with the same move. This
 * reads values and returns values: it sends nothing and changes no run.
 */

export type ShadowObservation = Readonly<{
  /** Each device clock reading at the plan's logical zero. */
  origin: ClockOrigin;
  messages: readonly CobotObserved[];
}>;

export type ShadowMatch = Readonly<{
  observationId: string;
  sourceKey: string;
  task: CobotTask;
  state: CobotObserved["state"] | null;
  carrierAt: CarrierAt | null;
  reason: string | null;
  observed: Readonly<{
    startSeconds: number | null;
    endSeconds: number | null;
  }>;
  /** The planned task with the same move, or null when the plan has none. */
  planned: Readonly<{
    key: string;
    sourceKey: string;
    startSeconds: number;
    endSeconds: number;
  }> | null;
  /** Whether the plan assigned the move to the cobot that made it. */
  sameCobot: boolean | null;
  /** Observed minus planned, in seconds. */
  difference: Readonly<{
    startSeconds: number | null;
    endSeconds: number | null;
  }>;
}>;

export type ShadowCorrelation = Readonly<{
  matches: readonly ShadowMatch[];
  /** Planned tasks that no observation made. */
  unobserved: readonly string[];
}>;

type Observation = {
  observationId: string;
  sourceKey: string;
  task: CobotTask;
  start: number | null;
  end: number | null;
  last: CobotObserved | null;
};

function minus(left: number | null, right: number): number | null {
  return left === null ? null : Math.round((left - right) * 1_000) / 1_000;
}

export function correlateShadowMoves(
  plan: BakePlan,
  observed: ShadowObservation,
): ShadowCorrelation {
  const observations = new Map<string, Observation>();
  const ordered = [...observed.messages].sort(
    (left, right) =>
      left.deviceClockMs - right.deviceClockMs ||
      left.sequence - right.sequence,
  );
  for (const message of ordered) {
    const name = `${message.sourceKey}/${message.observationId}`;
    const entry = observations.get(name) ?? {
      observationId: message.observationId,
      sourceKey: message.sourceKey,
      task: message.task,
      start: null,
      end: null,
      last: null,
    };
    const seconds =
      (message.deviceClockMs - (observed.origin[message.sourceKey] ?? 0)) /
      1_000;
    if (message.state === "started") entry.start ??= seconds;
    else entry.end = seconds;
    entry.last = message;
    observations.set(name, entry);
  }
  const used = new Set<string>();
  const matches: ShadowMatch[] = [];
  for (const entry of observations.values()) {
    let planned: PlannedStep | null = null;
    for (const step of plan.steps)
      if (!used.has(step.key) && sameTask(step.task, entry.task)) {
        planned = step;
        break;
      }
    if (planned !== null) used.add(planned.key);
    const start = planned === null ? 0 : planned.start / 1_000_000;
    const end = planned === null ? 0 : planned.end / 1_000_000;
    matches.push({
      observationId: entry.observationId,
      sourceKey: entry.sourceKey,
      task: entry.task,
      state: entry.last?.state ?? null,
      carrierAt: entry.last?.carrierAt ?? null,
      reason: entry.last?.reason ?? null,
      observed: { startSeconds: entry.start, endSeconds: entry.end },
      planned:
        planned === null
          ? null
          : {
              key: planned.key,
              sourceKey: planned.sourceKey,
              startSeconds: start,
              endSeconds: end,
            },
      sameCobot:
        planned === null ? null : planned.sourceKey === entry.sourceKey,
      difference:
        planned === null
          ? { startSeconds: null, endSeconds: null }
          : {
              startSeconds: minus(entry.start, start),
              endSeconds: minus(entry.end, end),
            },
    });
  }
  const unobserved: string[] = [];
  for (const step of plan.steps)
    if (!used.has(step.key)) unobserved.push(step.key);
  return { matches, unobserved };
}
