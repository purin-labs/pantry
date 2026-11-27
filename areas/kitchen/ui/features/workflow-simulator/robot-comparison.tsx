import { Select } from "@purin-labs/ui/select";
import {
  parseIngredientLoad,
  sameIngredientLoad,
  type IngredientLoad,
} from "@purin-labs/bakery-model/bakery-physics";
import React from "react";
import { assertNever } from "@purin-labs/std";
import {
  assessRobotLoad,
  robotLoadLabel,
  UR5E_PAYLOAD_SOURCE,
  type RobotLoadAssessment,
} from "@purin-labs/bakery-model/bakery-load-assessment";
import {
  ROBOT_IDS,
  ROBOTS,
  parseRobotModel,
  type RobotModel,
} from "@purin-labs/bakery-model/bakery-robots";
import type {
  PhysicsRecording,
  PhysicsRequest,
} from "@purin-labs/bakery-model/bakery-physics";
import { EngineJobs } from "../production-run/engine-jobs";
import { jobStepLabel, type JobProgress } from "../production-run/job-progress";
import { downloadBakeryFile } from "./file-download";
import { RobotLimits } from "./robot-limits";
import { summarizeMargins } from "@purin-labs/bakery-model/bakery-margins";

type Task = "table-to-rack" | "table-to-oven";
type Workcell = "separate" | "spanner-oven";
type Scenario = "nominal" | "blocked" | "unreachable" | "closed-door" | "slip";
const ROBOT_ITEMS = ROBOT_IDS.map((robot) => ({
  value: robot,
  label: ROBOTS[robot].label,
}));
const SPANNER_ROBOT_IDS: readonly RobotModel[] = [
  "fairino-fr10",
  "universal-robots-ur5e",
  "fanuc-crx10ial",
];
const SPANNER_ROBOT_ITEMS = SPANNER_ROBOT_IDS.map((robot) => ({
  value: robot,
  label: ROBOTS[robot].label,
}));
const WORKCELL_ITEMS = [
  { value: "separate", label: "Standard fork clamp" },
  { value: "spanner-oven", label: "Spanner oven (MBCO-4ME)" },
];
const TASK_ITEMS = [
  { value: "table-to-rack", label: "Table to rack" },
  { value: "table-to-oven", label: "Table to oven" },
];
const SCENARIO_ITEMS = [
  { value: "nominal", label: "Nominal" },
  { value: "blocked", label: "Blocked destination" },
  { value: "unreachable", label: "Unreachable destination" },
];
const SPANNER_SCENARIO_ITEMS = [
  { value: "nominal", label: "Nominal" },
  { value: "blocked", label: "Blocked destination" },
  { value: "closed-door", label: "Closed door" },
  { value: "slip", label: "Slip (lost grasp)" },
];
type Entry = Readonly<{
  robot: RobotModel;
  repetition: number;
  recording: PhysicsRecording;
  loadAssessment: RobotLoadAssessment;
}>;
type Progress =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "running";
      robot: RobotModel;
      completed: number;
      total: number;
      steps?: Readonly<{ step: number; planned: number }>;
    }>
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "failed"; message: string }>;
type State = Readonly<{
  massKg: string;
  forwardMm: string;
  lateralMm: string;
  robot: RobotModel;
  cell: Workcell;
  task: Task;
  scenario: Scenario;
  progress: Progress;
  entries: readonly Entry[];
}>;
type Props = Readonly<{
  runner: EngineJobs;
  open(recording: PhysicsRecording): void;
  disabled: boolean;
  active: boolean;
}>;

/**
 * Each transfer runs on a new persistent cell, as the first transfer of a
 * production run does (Refactor 16, step 5), in the page's engine worker.
 */
export class RobotComparison extends React.Component<Props, State> {
  state: State = {
    massKg: "1",
    forwardMm: "0",
    lateralMm: "0",
    robot: "fanuc-crx10ial",
    cell: "separate",
    task: "table-to-rack",
    scenario: "nominal",
    progress: { kind: "idle" },
    entries: [],
  };
  private generation = 0;

  componentDidUpdate(previous: Props): void {
    if (
      previous.active &&
      !this.props.active &&
      this.state.progress.kind === "running"
    ) {
      this.stop();
    }
  }

  componentWillUnmount(): void {
    this.cancel();
  }

  private cancel(): void {
    this.generation++;
    if (this.state.progress.kind === "running") this.props.runner.stop();
  }

  private stop(): void {
    this.cancel();
    this.setState({
      progress: {
        kind: "failed",
        message: "Comparison stopped. Completed recordings remain available.",
      },
    });
  }

  private chooseRobot(value: string | null): void {
    if (value !== null) this.setState({ robot: parseRobotModel(value) });
  }

  private chooseWorkcell(value: string | null): void {
    if (value === "spanner-oven") {
      this.setState((state) => ({
        cell: "spanner-oven",
        robot: SPANNER_ROBOT_IDS.includes(state.robot)
          ? state.robot
          : "fairino-fr10",
        task: "table-to-oven",
        scenario: state.scenario === "unreachable" ? "nominal" : state.scenario,
      }));
    } else if (value === "separate") {
      this.setState((state) => ({
        cell: "separate",
        scenario:
          state.scenario === "closed-door" || state.scenario === "slip"
            ? "nominal"
            : state.scenario,
      }));
    }
  }

  private chooseTask(value: string | null): void {
    const task = value;
    if (task === "table-to-rack" || task === "table-to-oven")
      this.setState({ task });
  }

  private chooseScenario(value: string | null): void {
    const scenario = value;
    if (
      scenario === "nominal" ||
      scenario === "blocked" ||
      scenario === "unreachable" ||
      scenario === "closed-door" ||
      scenario === "slip"
    )
      this.setState({ scenario });
  }

  private loadField(
    field: "massKg" | "forwardMm" | "lateralMm",
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const value = event.currentTarget.value;
    switch (field) {
      case "massKg":
        this.setState({ massKg: value });
        break;
      case "forwardMm":
        this.setState({ forwardMm: value });
        break;
      case "lateralMm":
        this.setState({ lateralMm: value });
        break;
      default:
        assertNever(field);
    }
  }
  private runSelected(): void {
    void this.run([this.state.robot], 1);
  }
  private compare(): void {
    void this.run(
      this.state.cell === "spanner-oven" ? SPANNER_ROBOT_IDS : ROBOT_IDS,
      2,
    );
  }

  private prepared(
    robot: RobotModel,
    task: Task,
    scenario: Scenario,
    ingredients: IngredientLoad,
    request: PhysicsRequest,
  ): Promise<boolean> {
    return Promise.resolve(
      sameIngredientLoad(request.ingredients, ingredients) &&
        request.robot === robot &&
        request.bakeryTaskId === task &&
        request.case === scenario &&
        request.layout.kind === "fixed" &&
        request.timestep === 0.002,
    );
  }

  private progress(progress: JobProgress): void {
    if (progress.stage !== "running") return;
    const steps = { step: progress.step, planned: progress.planned };
    this.setState((state) =>
      state.progress.kind === "running"
        ? { progress: { ...state.progress, steps } }
        : null,
    );
  }

  private async run(
    robots: readonly RobotModel[],
    repetitions: number,
  ): Promise<void> {
    if (
      this.props.disabled ||
      this.props.runner.running ||
      this.state.progress.kind === "running"
    )
      return;
    const generation = ++this.generation;
    const { cell, task, scenario } = this.state;
    const entries: Entry[] = [];
    this.setState({ entries: [] });
    try {
      const ingredients = parseIngredientLoad({
        massKg:
          this.state.massKg.trim() === "" ? null : Number(this.state.massKg),
        forwardMm:
          this.state.forwardMm.trim() === ""
            ? null
            : Number(this.state.forwardMm),
        lateralMm:
          this.state.lateralMm.trim() === ""
            ? null
            : Number(this.state.lateralMm),
      });
      for (const robot of robots) {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
          if (generation !== this.generation) return;
          this.setState({
            progress: {
              kind: "running",
              robot,
              completed: entries.length,
              total: robots.length * repetitions,
            },
          });
          const result = await this.props.runner.execute(
            { kind: "selection", robot, cell, task, scenario, ingredients },
            this.prepared.bind(this, robot, task, scenario, ingredients),
            this.progress.bind(this),
          );
          if (generation !== this.generation) return;
          if (result.recording.kind !== "bakery-physics-recording")
            throw new Error(
              "Arm comparison requires an individual transfer recording.",
            );
          const loadAssessment = await assessRobotLoad(
            result.recording.request,
          );
          if (generation !== this.generation) return;
          entries.push({
            robot,
            repetition,
            recording: result.recording,
            loadAssessment,
          });
          this.setState({ entries: entries.slice() });
        }
      }
      this.setState({ progress: { kind: "complete" } });
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({
        progress: {
          kind: "failed",
          message:
            error instanceof Error ? error.message : "Robot execution failed.",
        },
      });
    }
  }

  private export(): void {
    downloadBakeryFile(
      "robot-comparison.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "bakery-arm-comparison",
          conditions:
            "Same fixed pedestal, tray, clamp and destination. Model-specific nominal flange adapters and initial poses are assumptions.",
          loadAssessmentSource: UR5E_PAYLOAD_SOURCE,
          entries: this.state.entries,
        },
        null,
        2,
      ),
    );
  }

  private openRecording(recording: PhysicsRecording): void {
    this.props.open(recording);
  }

  private renderEntry(entry: Entry): React.ReactNode {
    const recording = entry.recording;
    const outcome = recording.outcome;
    const status = outcome.kind === "failed" ? outcome.reason : outcome.kind;
    const previous = this.state.entries.find(
      firstRepetition.bind(null, entry.robot),
    );
    const repeat = repeatLabel(entry, previous);
    return (
      <tr key={`${entry.robot}-${entry.repetition}`}>
        <td>{ROBOTS[entry.robot].label}</td>
        <td>{entry.repetition}</td>
        <td>{status}</td>
        <td>
          {recording.request.ingredients.massKg} kg;{" "}
          {recording.request.ingredients.forwardMm} /{" "}
          {recording.request.ingredients.lateralMm} mm
        </td>
        <td>{renderLoadAssessment(entry.loadAssessment)}</td>
        <td>{(outcome.step * recording.request.timestep).toFixed(2)} s</td>
        <td>
          <RobotLimits margins={summarizeMargins(outcome.margins)} />
        </td>
        <td>{repeat}</td>
        <td>
          <button
            type="button"
            onClick={this.openRecording.bind(this, recording)}
          >
            View recording
          </button>
        </td>
      </tr>
    );
  }

  render(): React.ReactNode {
    const progress = this.state.progress;
    const busy = progress.kind === "running";
    const disabled = busy || this.props.disabled;
    const isSpanner = this.state.cell === "spanner-oven";
    const robots = isSpanner ? SPANNER_ROBOT_ITEMS : ROBOT_ITEMS;
    const scenarios = isSpanner ? SPANNER_SCENARIO_ITEMS : SCENARIO_ITEMS;
    return (
      <section
        className="robot-comparison"
        aria-label="Robot selection and comparison"
      >
        <h3>Choose a robot</h3>
        <p>
          Run the same cold-tray task with a selected arm. Compare existing arms
          runs each arm twice. An unreachable result means the planner found no
          continuous path.
        </p>
        <div className="robot-comparison-controls">
          <label>
            Workcell
            <Select.Root
              items={WORKCELL_ITEMS}
              value={this.state.cell}
              onValueChange={this.chooseWorkcell.bind(this)}
              disabled={disabled}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{WORKCELL_ITEMS.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Robot
            <Select.Root
              items={robots}
              value={this.state.robot}
              onValueChange={this.chooseRobot.bind(this)}
              disabled={disabled}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{robots.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Task
            <Select.Root
              items={TASK_ITEMS}
              value={this.state.task}
              onValueChange={this.chooseTask.bind(this)}
              disabled={disabled || isSpanner}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{TASK_ITEMS.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Case
            <Select.Root
              items={scenarios}
              value={this.state.scenario}
              onValueChange={this.chooseScenario.bind(this)}
              disabled={disabled}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{scenarios.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
        </div>
        <fieldset className="robot-comparison-controls" disabled={disabled}>
          <legend>Comparison ingredient load</legend>
          <label>
            Ingredient mass (kg)
            <input
              type="number"
              min="0"
              max="4"
              step="any"
              value={this.state.massKg}
              onChange={this.loadField.bind(this, "massKg")}
            />
          </label>
          <label>
            Forward offset (mm)
            <input
              type="number"
              min="-100"
              max="100"
              step="1"
              value={this.state.forwardMm}
              onChange={this.loadField.bind(this, "forwardMm")}
            />
          </label>
          <label>
            Lateral offset (mm)
            <input
              type="number"
              min="-60"
              max="60"
              step="1"
              value={this.state.lateralMm}
              onChange={this.loadField.bind(this, "lateralMm")}
            />
          </label>
          <p>
            Every selected arm receives this load. UR5e results include a chart
            estimate for the combined tool, tray and ingredients. Prototype
            masses are unmeasured. Motion completion does not establish hardware
            suitability.
          </p>
        </fieldset>
        <div className="robot-comparison-actions">
          <button
            type="button"
            disabled={disabled}
            onClick={this.runSelected.bind(this)}
          >
            Run selected robot
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={this.compare.bind(this)}
          >
            Compare existing arms
          </button>
          {busy && (
            <button type="button" onClick={this.stop.bind(this)}>
              Stop comparison
            </button>
          )}
          <button
            type="button"
            disabled={this.state.entries.length === 0 || busy}
            onClick={this.export.bind(this)}
          >
            Export comparison
          </button>
        </div>
        <p role="status">{progressLabel(progress)}</p>
        {this.state.entries.length > 0 && (
          <div className="robot-comparison-results">
            <table>
              <thead>
                <tr>
                  <th>Robot</th>
                  <th>Run</th>
                  <th>Motion outcome</th>
                  <th>Ingredients: mass; forward / lateral</th>
                  <th>Load-chart estimate</th>
                  <th>Simulated time</th>
                  <th>Robot limits</th>
                  <th>Repeat check</th>
                  <th>Playback</th>
                </tr>
              </thead>
              <tbody>
                {this.state.entries.map(this.renderEntry.bind(this))}
              </tbody>
            </table>
          </div>
        )}
        <p>
          Source inertias, flange adapters, friction and motor settings remain
          uncalibrated. Failed runs are diagnostics, not speed scores. Robot
          limits compare each move with the rated joint speeds and torques in
          the robot's description file. A move over a rated speed fails; a long
          time at a torque limit, a deep contact or a large grip slip gives a
          warning.
        </p>
      </section>
    );
  }
}

function renderItem(
  item: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function renderLoadAssessment(
  assessment: RobotLoadAssessment,
): React.ReactNode {
  if (assessment.kind === "unassessed")
    return (
      <span>
        {robotLoadLabel(assessment)} ·{" "}
        {assessment.reason === "unsupported-robot"
          ? "No chart assessment for this arm"
          : "Model requires a new assessment"}
      </span>
    );
  return (
    <span>
      {robotLoadLabel(assessment)} · margin{" "}
      {assessment.chartMarginKg.toFixed(2)} kg
    </span>
  );
}
function firstRepetition(robot: RobotModel, entry: Entry): boolean {
  return entry.robot === robot && entry.repetition === 1;
}
function sameMotion(
  first: PhysicsRecording,
  second: PhysicsRecording,
): boolean {
  return (
    JSON.stringify([first.samples, first.events, first.outcome]) ===
    JSON.stringify([second.samples, second.events, second.outcome])
  );
}

function repeatLabel(entry: Entry, previous: Entry | undefined): string {
  if (entry.repetition === 1) return "Baseline";
  if (previous && sameMotion(previous.recording, entry.recording))
    return "Matches baseline";
  return "Different motion";
}

function progressLabel(progress: Progress): string {
  switch (progress.kind) {
    case "idle":
      return "Shared Rust + MuJoCo engine · 2 ms timestep · Simulation only";
    case "running":
      return `${progress.completed}/${progress.total} complete · ${ROBOTS[progress.robot].label}${jobStepLabel(progress.steps)}`;
    case "complete":
      return "Run complete. Inspect failures and assumptions before comparing results.";
    case "failed":
      return progress.message;
    default:
      return assertNever(progress);
  }
}
