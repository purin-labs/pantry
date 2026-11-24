import React from "react";
import type { CaseTimelineCase, ScheduleRunsDay } from "@purin-labs/control-api";

import {
  parseAgentOperationsResponse,
  type AgentOperationsSnapshot,
  type AgentOperationsTransport,
  type ScheduleBinding,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import { scheduleTriggerLabel } from "../../pages/agent-console";
import {
  nowIn,
  periodWords,
  TimeLanesNote,
  usePeriod,
  usePeriodRead,
  useWiderWhenEmpty,
  type TimePeriod,
} from "@purin-labs/ui/index";
import {
  executionErrorMessage,
  readScheduleRuns,
  type BrainTransport,
} from "@purin-labs/area-brain/ui/features/brain/api";
import {
  ScheduleLanes,
  type ScheduledAgent,
  type ScheduleRun,
} from "./schedule-lanes";
import { scheduleWindows } from "./windows";

/**
 * The Schedules tab of the Agents page: one lane for each agent with a
 * schedule, with the day's runs and the windows still to come today. Each
 * run shows its Case as the reader may see it on the Activity timeline.
 */
export function AgentSchedulesPanel(props: {
  readonly organisationId: string;
  readonly operations: AgentOperationsTransport;
  readonly transport: BrainTransport;
  readonly onOpenCase: (caseId: string) => void;
}): React.ReactNode {
  const { organisationId, operations, transport } = props;
  const control = usePeriod();
  const reader = React.useCallback(
    async (window: Readonly<{ from: number; to: number }>) => {
      const [snapshot, runs] = await Promise.all([
        operations.read(organisationId).then(parseAgentOperationsResponse),
        readScheduleRuns(transport, organisationId, window),
      ]);
      return { snapshot, runs };
    },
    [organisationId, operations, transport],
  );
  const read = usePeriodRead(control.period, reader, {
    loading: "Loading the scheduled runs",
    failed: executionErrorMessage,
  });
  const now = nowIn(control.period, Date.now());
  const lanes =
    read.value === null
      ? { agents: [], runs: [] }
      : scheduleLanes(
          read.value.snapshot,
          read.value.runs,
          control.period,
          now,
        );
  useWiderWhenEmpty(
    control,
    read.window,
    read.value !== null && lanes.runs.length === 0,
  );
  const withheld = read.value?.runs.withheld ?? 0;
  return (
    <section className="agent-schedules" aria-labelledby="agent-schedules">
      {/* The tab names the view, so the heading is for a screen reader. */}
      <h2 className="visually-hidden" id="agent-schedules" tabIndex={-1}>
        Schedules
      </h2>
      <ScheduleLanes
        control={control}
        now={now}
        agents={lanes.agents}
        runs={lanes.runs}
        onOpenCase={props.onOpenCase}
        status={read.status}
        notes={
          <>
            {withheld > 0 ? (
              <TimeLanesNote>
                {withheld === 1
                  ? `1 run ${periodWords(control.period)} opened a Case that you cannot read.`
                  : `${String(withheld)} runs ${periodWords(control.period)} opened Cases that you cannot read.`}
              </TimeLanesNote>
            ) : null}
            {read.value?.runs.truncated === true ? (
              <TimeLanesNote>
                The view shows the most recent runs{" "}
                {periodWords(control.period)}. There are more.
              </TimeLanesNote>
            ) : null}
          </>
        }
      />
    </section>
  );
}

/** The agents with a schedule, and their runs and planned windows. */
function scheduleLanes(
  snapshot: AgentOperationsSnapshot,
  day: ScheduleRunsDay,
  period: TimePeriod,
  now: number | null,
): Readonly<{ agents: ScheduledAgent[]; runs: ScheduleRun[] }> {
  const definitions = new Map(
    snapshot.definitions.map((definition) => [
      definition.agentDefinitionId,
      definition,
    ]),
  );
  const bindings = new Map(
    snapshot.scheduleBindings.map((binding) => [binding.bindingId, binding]),
  );
  const agents = new Map<string, ScheduledAgent>();
  const agentOf = (installationId: string): ScheduledAgent => {
    const known = agents.get(installationId);
    if (known !== undefined) return known;
    const installation = snapshot.installations.find(
      (item) => item.installationId === installationId,
    );
    const definition =
      installation === undefined
        ? undefined
        : definitions.get(installation.agentDefinitionId);
    const role = definition?.role;
    const agent: ScheduledAgent = {
      agentId: installationId,
      name: definition?.displayName ?? "Agent",
      role: role === "research" || role === "specialist" ? role : "coordinator",
    };
    agents.set(installationId, agent);
    return agent;
  };
  const runs: ScheduleRun[] = day.runs.map((run) => {
    const binding = bindings.get(run.bindingId);
    agentOf(run.installationId);
    return {
      runId: `${run.bindingId}:${run.windowKey}`,
      agentId: run.installationId,
      schedule:
        binding === undefined ? "Schedule" : scheduleTriggerLabel(binding),
      title: binding === undefined ? "Scheduled run" : runTitle(binding),
      at: run.dispatchedAt,
      ...runState(run.case),
      startedBy: null,
      caseId: run.case.caseId,
    };
  });
  // The windows still to come in the period, for each enabled schedule.
  if (now !== null)
    for (const binding of snapshot.scheduleBindings) {
      if (!binding.enabled) continue;
      const agent = agentOf(binding.installationId);
      for (const at of scheduleWindows(binding.spec, now, period.to))
        runs.push({
          runId: `${binding.bindingId}:planned:${String(at)}`,
          agentId: agent.agentId,
          schedule: scheduleTriggerLabel(binding),
          title: runTitle(binding),
          at,
          endedAt: null,
          state: "planned",
          waitsSince: null,
          startedBy: null,
          caseId: null,
        });
    }
  return { agents: [...agents.values()], runs };
}

/** A schedule's name: the first line of its instruction, kept short. */
function runTitle(binding: ScheduleBinding): string {
  const line = binding.instructionBody?.split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return "Scheduled run";
  return line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line;
}

/**
 * What the run's Case shows this reader. A Case whose records the reader may
 * not read shows only that it ran.
 */
function runState(
  event: CaseTimelineCase,
): Pick<ScheduleRun, "state" | "endedAt" | "waitsSince"> {
  const ended = Math.max(
    event.startedAt,
    event.outcome?.at ?? event.startedAt,
    ...event.spans.map((span) => span.to ?? span.from),
  );
  switch (event.outcome?.kind) {
    case undefined:
      return { state: "ran", endedAt: null, waitsSince: null };
    case "waiting": {
      const open = event.spans.filter(
        (span) => span.holder === "person" && span.to === null,
      );
      return {
        state: "waiting",
        endedAt: null,
        waitsSince: open.at(-1)?.from ?? event.outcome.at,
      };
    }
    case "running":
      return { state: "running", endedAt: null, waitsSince: null };
    case "failed":
    case "rejected":
      return { state: "failed", endedAt: ended, waitsSince: null };
    default:
      return { state: "done", endedAt: ended, waitsSince: null };
  }
}
