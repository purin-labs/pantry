import React from "react";
import type {
  BakeRunActionInput,
  BakeRunRecord,
  BakeRunSeen,
  BakeRunTaskView,
  BakeRunView,
  BakeShadowMatch,
} from "@purin-labs/kitchen-control-api";

import {
  Button,
  TimeLanes,
  TimeLanesKey,
  useLatestRead,
  useMutation,
  type TimeLanesItem,
  type TimeLanesSection,
  type TimeLanesTone,
  type TimeRange,
} from "../../ui";
import { Select } from "../../ui/select";
import { actOnBakeRun, readBakeRun, refusalText } from "./requests";
import "./run-panel.css";

/**
 * The bake run of an approved proposal (Plan 24 S4), inside its drawer. The
 * task graph, the timeline and the positions of the mould groups all show
 * one read of the run, so they agree on each task. A position that no
 * receipt proves shows as unknown. An operator or a higher role pauses,
 * resumes, settles, stops and checks the run here.
 *
 * A hold (S6) is the one disposition of an uncertain outcome. A person
 * settles it with what they saw; a failed task asks where the mould group is,
 * and the run then stops. Settling never sends a move again.
 *
 * A shadow run (S5) sends nothing: the drawer shows each move that the
 * controller made, the planned task that it matches and the difference of
 * the times. A person only stops watching it.
 */

const REFRESH_MS = 3_000;

const RUN_STATE: Readonly<Record<BakeRunRecord["state"], string>> = {
  not_started: "Not started",
  running: "Running",
  paused: "Paused",
  held: "Held for a person",
  completed: "Baked, waits for the check",
  stopped: "Stopped",
  checked: "Checked",
};

const TASK_STATE: Readonly<Record<BakeRunTaskView["state"], string>> = {
  planned: "Planned",
  ready: "Next",
  dispatched: "Sent",
  accepted: "Accepted",
  running: "Running",
  completed: "Done",
  rejected: "Refused",
  failed: "Failed",
};

const SEEN: readonly Readonly<{ value: BakeRunSeen; label: string }>[] = [
  { value: "source", label: "On its source shelf" },
  { value: "tool", label: "On the cobot's tool" },
  { value: "destination", label: "On its destination shelf" },
  { value: "lost", label: "Lost" },
];

const STATION: Readonly<Record<string, string>> = {
  cold_rack: "Cold rack",
  oven: "Oven",
  cooling_rack: "Cooling rack",
};

export function BakeRunPanel(
  props: Readonly<{ organisationId: string; proposalId: string }>,
): React.ReactNode {
  const { organisationId, proposalId } = props;
  const read = React.useCallback(
    (signal: AbortSignal) => readBakeRun(organisationId, proposalId, signal),
    [organisationId, proposalId],
  );
  const { read: loaded, reload } = useLatestRead(read, {
    everyMs: REFRESH_MS,
    pauseWhenHidden: true,
  });
  const act = useMutation(
    (input: BakeRunActionInput, idempotencyKey: string) =>
      actOnBakeRun(organisationId, proposalId, input, idempotencyKey),
    () => void reload(),
  );
  const [pieces, setPieces] = React.useState("");
  const [seen, setSeen] = React.useState<BakeRunSeen | null>(null);
  if (loaded.kind === "loading")
    return <p className="bake-run-note">Reading the bake run.</p>;
  if (loaded.kind === "failed")
    return <p className="bake-run-note">The bake run could not be read.</p>;
  const { run, access } = loaded.value;
  const state = act.state("run");
  const busy = state.kind === "running";
  const send = (input: BakeRunActionInput) => void act.run("run", input);
  const shadow = run.mode === "shadow";
  // A failed task: the person says where the group is, and the run stops.
  const failed = run.view !== null && run.view.disposition !== null;
  return (
    <section className="bake-run" aria-label="Bake run">
      <div className="bake-run-head">
        <h3>{shadow ? "Shadow run" : "Bake run"}</h3>
        <span className={`bake-run-state bake-run-state-${run.state}`}>
          {shadow && run.state === "completed"
            ? "Watched to the end"
            : RUN_STATE[run.state]}
        </span>
      </div>
      {shadow ? (
        <p className="bake-run-note">
          Shadow mode: Purin Pantry sends nothing to the devices and changes no
          stock. It matches each move of the cobots to the plan.
        </p>
      ) : null}
      {run.problem === null ? null : (
        <p className="bake-run-alert" role="status">
          The run did not start: {run.problem.message}
        </p>
      )}
      {run.hold === null ? null : (
        <p className="bake-run-alert" role="status">
          {run.hold.message}
        </p>
      )}
      {run.unloadRisk === null ? null : (
        <p className="bake-run-alert" role="status">
          Over-bake risk: {run.unloadRisk.step} did not start within{" "}
          {run.unloadRisk.graceSeconds} s after the bake ended. It was{" "}
          {Math.round(run.unloadRisk.lateSeconds)} s late.
        </p>
      )}
      {run.settlements.length === 0 ? null : (
        <ul className="bake-run-groups" aria-label="Settled holds">
          {run.settlements.map((settled) => (
            <li key={settled.at}>
              <span>{settled.holdCode.replaceAll("_", " ")}</span>
              <span>
                {settled.decision === "stop" ? "Stopped" : "Continued"}
                {settled.seen === null
                  ? ""
                  : `; the mould group was ${SEEN.find((item) => item.value === settled.seen)?.label.toLowerCase() ?? settled.seen}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {access.mayOperate && shadow && run.state === "running" ? (
        <div className="bakes-actions">
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => send({ action: "stop" })}
          >
            Stop watching
          </Button>
        </div>
      ) : null}
      {access.mayOperate && !shadow ? (
        <div className="bakes-actions">
          {run.state === "not_started" ? (
            <Button disabled={busy} onClick={() => send({ action: "start" })}>
              Start the run
            </Button>
          ) : null}
          {run.state === "running" || run.state === "held" ? (
            <Button disabled={busy} onClick={() => send({ action: "pause" })}>
              Pause
            </Button>
          ) : null}
          {run.state === "paused" ? (
            <Button disabled={busy} onClick={() => send({ action: "resume" })}>
              Resume
            </Button>
          ) : null}
          {run.state === "held" && !failed ? (
            <Button
              disabled={busy}
              onClick={() => send({ action: "settle", decision: "continue" })}
            >
              Checked, continue
            </Button>
          ) : null}
          {run.state === "held" && failed ? (
            <>
              <Select.Root
                items={SEEN}
                value={seen}
                onValueChange={(value) => {
                  const item = SEEN.find((entry) => entry.value === value);
                  setSeen(item?.value ?? null);
                }}
              >
                <Select.Trigger
                  size="sm"
                  aria-label="Where is the mould group?"
                >
                  <Select.Value placeholder="Where is the mould group?" />
                </Select.Trigger>
                <Select.Popup>
                  {SEEN.map((item) => (
                    <Select.Item key={item.value} value={item.value}>
                      {item.label}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
              <Button
                variant="danger"
                disabled={busy || seen === null}
                onClick={() => {
                  if (seen !== null)
                    send({ action: "settle", decision: "stop", seen });
                }}
              >
                Record and stop the run
              </Button>
            </>
          ) : null}
          {run.state === "running" ||
          run.state === "paused" ||
          (run.state === "held" && !failed) ? (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => send({ action: "stop" })}
            >
              Stop the run
            </Button>
          ) : null}
        </div>
      ) : null}
      {run.state === "completed" && access.mayOperate && !shadow ? (
        <form
          className="bake-run-check"
          onSubmit={(event) => {
            event.preventDefault();
            send({ action: "check", goodPieces: Number(pieces) });
          }}
        >
          <label className="bakes-field">
            Good pieces after the release from the moulds
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              required
              value={pieces}
              onChange={(event) => setPieces(event.target.value)}
            />
          </label>
          <Button variant="primary" type="submit" disabled={busy}>
            Add to the counter stock
          </Button>
        </form>
      ) : null}
      {run.check === null ? null : (
        <p className="bake-run-note">
          {run.check.goodPieces} good pieces reached the counter stock (receipt{" "}
          {run.check.receiptId}).
        </p>
      )}
      {state.kind === "failed" ? (
        <p className="bakes-refusal" role="alert">
          {refusalText(state.error)}
        </p>
      ) : null}
      {run.view === null ? null : (
        <>
          <TaskGraph view={run.view} />
          <RunTimeline run={run} view={run.view} />
          <Positions view={run.view} />
        </>
      )}
      {run.shadow === null ? null : (
        <ObservedMoves
          matches={run.shadow.matches}
          unobserved={run.shadow.unobserved}
        />
      )}
    </section>
  );
}

/** The canvas: the run's tasks in their order, with each task's state. */
function TaskGraph(props: Readonly<{ view: BakeRunView }>): React.ReactNode {
  return (
    <div className="bake-run-block">
      <h4>Tasks</h4>
      <ol className="bake-run-graph" aria-label="Task graph">
        {props.view.tasks.map((task) => (
          <li
            key={task.key}
            className={`bake-run-node bake-run-node-${task.state}`}
          >
            <span className="bake-run-node-title">{task.key}</span>
            <span className="bake-run-node-meta">
              {task.sourceKey} · {TASK_STATE[task.state]}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const TONE: Readonly<Record<BakeRunTaskView["state"], TimeLanesTone>> = {
  planned: "grey",
  ready: "grey",
  dispatched: "blue",
  accepted: "blue",
  running: "violet",
  completed: "green",
  rejected: "red",
  failed: "red",
};

/** The timeline: each device's planned and observed spans, in run time. */
function RunTimeline(
  props: Readonly<{ run: BakeRunRecord; view: BakeRunView }>,
): React.ReactNode {
  const { run, view } = props;
  const origin = run.startedAt ?? 0;
  const at = (seconds: number) => origin + Math.round(seconds * 1_000);
  const [range, setRange] = React.useState<TimeRange | null>(null);
  const sections: TimeLanesSection[] = run.devices.map((device) => ({
    key: device.sourceKey,
    name: device.name,
    emphasis: run.hold?.sourceKey === device.sourceKey,
  }));
  const items: TimeLanesItem[] = view.tasks.flatMap((task) => {
    const planned: TimeLanesItem = {
      id: `${task.key}:planned`,
      section: task.sourceKey,
      start: at(task.planned.startSeconds),
      end: at(task.planned.endSeconds),
      title: `${task.key}, planned`,
      untitled: false,
      suffix: null,
      suffixTone: null,
      tone: "grey",
      avatar: { tone: "grey", letter: "P" },
      waits: [],
      parent: null,
      muted: true,
      card: {
        meta: `Planned ${task.planned.startSeconds.toFixed(1)} s to ${task.planned.endSeconds.toFixed(1)} s`,
        steps: [],
        note: null,
        action: null,
      },
    };
    const start = task.observed.startSeconds;
    if (start === null) return [planned];
    const end = task.observed.endSeconds ?? view.logicalSeconds;
    return [
      planned,
      {
        id: `${task.key}:observed`,
        section: task.sourceKey,
        start: at(start),
        end: at(Math.max(end, start)),
        title: task.key,
        untitled: false,
        suffix: TASK_STATE[task.state],
        suffixTone: TONE[task.state],
        tone: TONE[task.state],
        avatar: { tone: TONE[task.state], letter: "O" },
        waits: [],
        parent: null,
        muted: task.state === "completed",
        card: {
          meta: `Observed ${start.toFixed(1)} s to ${task.observed.endSeconds === null ? "now" : `${task.observed.endSeconds.toFixed(1)} s`}`,
          steps: [],
          note: task.reason,
          action: null,
        },
      },
    ];
  });
  const last = Math.max(
    view.logicalSeconds,
    ...view.tasks.map((task) => task.planned.endSeconds),
    ...view.tasks.map((task) => task.observed.endSeconds ?? 0),
  );
  return (
    <div className="bake-run-block">
      <h4>Timeline</h4>
      <TimeLanes
        label="Planned and observed tasks of each device"
        sections={sections}
        items={items}
        bounds={[origin, at(last + 60)]}
        now={null}
        range={range}
        onRange={setRange}
        legend={
          <TimeLanesKey
            owners={[
              { tone: "grey", letter: "P", name: "Planned" },
              { tone: "green", letter: "O", name: "Observed" },
            ]}
            link={null}
          />
        }
      />
    </div>
  );
}

function signed(value: number | null): string {
  if (value === null) return "no time yet";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)} s`;
}

/** A shadow run's moves: each one's planned task and its time difference. */
function ObservedMoves(
  props: Readonly<{
    matches: readonly BakeShadowMatch[];
    unobserved: readonly string[];
  }>,
): React.ReactNode {
  return (
    <div className="bake-run-block">
      <h4>Observed moves</h4>
      {props.matches.length === 0 ? (
        <p className="bake-run-note">No move of the cobots yet.</p>
      ) : (
        <ul className="bake-run-groups" aria-label="Observed moves">
          {props.matches.map((match) => (
            <li key={`${match.sourceKey}/${match.observationId}`}>
              <span>
                {match.observationId} on {match.sourceKey}
              </span>
              <span
                className={
                  match.planned === null ? "bake-run-unknown" : undefined
                }
              >
                {match.planned === null
                  ? "Not in the plan"
                  : `${match.planned.key}${match.sameCobot === false ? ` (planned for ${match.planned.sourceKey})` : ""}: start ${signed(match.difference.startSeconds)}, end ${signed(match.difference.endSeconds)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {props.unobserved.length === 0 ? null : (
        <p className="bake-run-note">
          Not seen yet: {props.unobserved.join(", ")}.
        </p>
      )}
    </div>
  );
}

/** Where each mould group is, from the receipts. */
function Positions(props: Readonly<{ view: BakeRunView }>): React.ReactNode {
  return (
    <div className="bake-run-block">
      <h4>Mould groups</h4>
      <ul className="bake-run-groups">
        {props.view.groups.map((group) => (
          <li key={group.mouldGroup}>
            <span>Group {group.mouldGroup}</span>
            <span
              className={
                group.position.kind === "unknown"
                  ? "bake-run-unknown"
                  : undefined
              }
            >
              {group.position.kind === "place"
                ? `${STATION[group.position.place.station] ?? group.position.place.station}, shelf ${group.position.place.shelf}`
                : group.position.kind === "tool"
                  ? `On the tool of ${group.position.sourceKey}`
                  : "Unknown: a person must look"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
