import React from "react";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import { assertNever } from "@seams/std";
import type { PourOverDeviation, PourOverSample } from "@seams/production-simulation/recipes/pour-over/sample";
import {
  PourOverScene,
  type PourOverCameraPreset,
  type PourOverSetup,
} from "./pour-over-scene";
import { physicsEvidenceVisible } from "@seams/production-simulation/runs/physics-evidence";
import "./pour-over.css";

type Props = Readonly<{
  setup: PourOverSetup;
  sample: PourOverSample | null;
  samples?: readonly PourOverSample[];
}>;
type State = Readonly<{
  error: string | null;
  camera: PourOverCameraPreset;
}>;

const POUR_STEPS = [
  { pour: 1, label: "Bloom", targetG: 50 },
  { pour: 2, label: "Pour 2", targetG: 150 },
  { pour: 3, label: "Pour 3", targetG: 250 },
  { pour: 4, label: "Pour 4", targetG: 350 },
] as const;

/** Accepted station samples only: it has no reference to the execution worker. */
export class PourOverPhysicsView extends React.Component<Props, State> {
  state: State = { error: null, camera: "bench" };
  private readonly element = React.createRef<HTMLDivElement>();
  private visual: PourOverScene | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new PourOverScene(element, this.props.setup);
    this.syncVisual();
    void this.load(this.visual);
  }
  private async load(visual: PourOverScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The robot visual is unavailable.",
        });
    }
  }
  componentDidUpdate(): void {
    this.syncVisual();
  }
  private syncVisual(): void {
    if (this.visual === null) return;
    if (this.props.samples !== undefined && this.props.samples.length > 0) {
      this.visual.setSamples(this.props.samples);
      return;
    }
    if (this.props.sample !== null) this.visual.setFrame(this.props.sample);
  }
  private selectCamera(camera: PourOverCameraPreset): void {
    this.setState({ camera });
    this.visual?.setCameraPreset(camera);
  }
  componentWillUnmount(): void {
    this.visual?.dispose();
    this.visual = null;
  }
  render(): React.ReactNode {
    const sample = this.props.sample;
    return (
      <section
        aria-label="Accepted pour-over station state"
        className="pour-over-station"
        data-pour-over-phase={sample?.control.phase}
        data-pour-over-step={sample?.step}
      >
        <div className="pour-over-canvas" ref={this.element} />
        <div
          className="pour-over-camera-bar"
          role="group"
          aria-label="Camera view"
        >
          <BakeryAppearanceControl />
          {(
            [
              ["bench", "Bench view"],
              ["closeup", "Dripper close-up"],
              ["overhead", "Overhead spiral"],
            ] as const
          ).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              aria-pressed={this.state.camera === preset}
              onClick={this.selectCamera.bind(this, preset)}
            >
              {label}
            </button>
          ))}
        </div>
        {this.state.error !== null && <p role="status">{this.state.error}</p>}
        {sample === null ? (
          <p>Waiting for an accepted station sample.</p>
        ) : (
          <PourOverStatus sample={sample} />
        )}
        <p className="pour-over-note">
          Accepted Rust/MuJoCo state with the declared water model. The display
          draws recorded samples; it does not infer water transfer.
        </p>
      </section>
    );
  }
}

function PourOverStatus(props: Readonly<{ sample: PourOverSample }>) {
  const { control, scale, water, outcome } = props.sample;
  const activePour = /^pour-(\d)$/u.exec(control.phase);
  const activePourIndex = activePour !== null ? Number(activePour[1]) : null;
  return (
    <div className="pour-over-status">
      {outcome?.kind === "failed" && (
        <p role="alert" data-pour-over-failure={outcome.reason}>
          The brew failed: {failureText(outcome.reason)}. The station holds its
          material where it is. No beverage is reported.
        </p>
      )}
      <div className="pour-over-steps" aria-label="Four-pour recipe progress">
        {POUR_STEPS.map((item) => {
          const done =
            outcome?.kind === "completed" ||
            (control.nextTargetG === null &&
              control.brewS !== null &&
              activePourIndex === null) ||
            (control.nextTargetG !== null && control.nextTargetG > item.targetG);
          const active = activePourIndex === item.pour;
          const state = active ? "active" : done ? "done" : "pending";
          return (
            <div
              key={item.pour}
              className="pour-over-step-pill"
              data-step-state={state}
            >
              <span>{item.label}</span>
              <strong>{item.targetG} g</strong>
            </div>
          );
        })}
      </div>
      <dl className="pour-over-kpi-strip">
        <dt>Stage</dt>
        <dd data-pour-over-stage>
          {outcome?.kind === "completed"
            ? "Brew complete · beverage in the server"
            : outcome?.kind === "failed"
              ? "Stopped after a failure"
              : stageText(control.phase, control.stage)}
        </dd>
        <dt>Brew time</dt>
        <dd data-pour-over-brew-seconds={control.brewS ?? undefined}>
          {control.brewS === null ? "Not started" : clock(control.brewS)}
        </dd>
        <dt>Scale</dt>
        <dd data-pour-over-scale={scale.readingG ?? undefined}>
          {scale.readingG === null || !scale.tared
            ? "Not tared"
            : `${scale.readingG.toFixed(1)} g${scale.stable ? "" : " · settling"}`}
        </dd>
        <dt>Kettle water</dt>
        <dd data-pour-over-kettle={water.kettleG.toFixed(1)}>
          {water.kettleG.toFixed(1)} g at {water.kettleC.toFixed(1)} °C
        </dd>
        <dt>Beverage in server</dt>
        <dd data-pour-over-beverage={water.serverG.toFixed(3)}>
          {water.serverG.toFixed(1)} g
          {outcome?.kind === "completed" &&
            ` · ${(outcome.beverageMg / 1000).toFixed(3)} g measured at completion`}
        </dd>
      </dl>
      {control.deviations.length > 0 && (
        <section aria-label="Brew deviations">
          <h4>Deviations</h4>
          <ul>
            {control.deviations.map((deviation, index) => (
              <li key={index} data-pour-over-deviation={deviation.kind}>
                {deviationText(deviation)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {physicsEvidenceVisible() && (
        <details>
          <summary>Water accounting</summary>
          <dl>
            <dt>Pour rate</dt>
            <dd>
              {water.flowGS > 0.05
                ? `${water.flowGS.toFixed(1)} g/s`
                : "0.0 g/s · idle"}
            </dd>
            <dt>Next target</dt>
            <dd>
              {control.nextTargetG === null
                ? "No pour remains"
                : `${control.nextTargetG} g cumulative`}
            </dd>
            <dt>Coffee bed</dt>
            <dd>
              {(water.absorbedG + water.freeG).toFixed(1)} g slurry at{" "}
              {water.bedC.toFixed(1)} °C
            </dd>
            <dt>Poured from the kettle</dt>
            <dd>{water.pouredG.toFixed(2)} g</dd>
            <dt>In the air</dt>
            <dd>{water.airborneG.toFixed(2)} g</dd>
            <dt>In the bed</dt>
            <dd>
              {(water.absorbedG + water.freeG).toFixed(2)} g (
              {water.freeG.toFixed(2)} g free)
            </dd>
            <dt>Off the bed area</dt>
            <dd>{water.offBedG.toFixed(2)} g</dd>
            <dt>Spilled</dt>
            <dd data-pour-over-spill={water.spillG.toFixed(3)}>
              {water.spillG.toFixed(2)} g
            </dd>
            <dt>Evaporated</dt>
            <dd>{water.evaporatedG.toFixed(2)} g</dd>
          </dl>
        </details>
      )}
    </div>
  );
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function stageText(phase: string, stage: string | null): string {
  const pour = /^pour-(\d)$/u.exec(phase);
  if (pour !== null) {
    const step =
      stage === "pretilt"
        ? "tilting to the start"
        : stage === "approach"
          ? "waiting for flow"
          : stage === "regulate"
            ? "spiral pour"
            : stage === "cut-off"
              ? "stopping the flow"
              : stage === "settle"
                ? "reading the scale"
                : stage === "top-up"
                  ? "small top-up pour"
                  : "returning upright";
    return `Pour ${pour[1]} of 4 · ${step}`;
  }
  const rest = /^rest-(\d)$/u.exec(phase);
  if (rest !== null)
    return rest[1] === "1" ? "Bloom rest" : `Rest before pour ${rest[1]}`;
  if (phase.startsWith("return-")) return "Returning the kettle to its stand";
  switch (phase) {
    case "prepared":
      return "Prepared station";
    case "approach":
    case "insert":
      return "Moving to the kettle handle";
    case "grasp":
      return "Closing the fingers on the handle";
    case "lift":
      return "Lifting the kettle";
    case "transfer":
      return "Carrying the kettle to the dripper";
    case "tare":
      return "Taring the scale";
    case "drainage":
      return "Drainage";
    case "brewed":
      return "Brew complete · beverage in the server";
    case "held":
      return "Held after a failure";
    default:
      return phase;
  }
}

function failureText(reason: string): string {
  switch (reason) {
    case "lost-grasp":
      return "the kettle left the grip";
    case "collision":
      return "an unexpected contact stopped the arm";
    case "unreachable":
      return "the arm could not reach a target";
    case "placement-failed":
      return "the kettle did not rest on its stand";
    case "drainage-timeout":
      return "drainage did not finish before the timeout";
    default:
      return reason;
  }
}

function deviationText(deviation: PourOverDeviation): string {
  switch (deviation.kind) {
    case "pour-start":
      return `Pour ${deviation.pour + 1} started ${deviation.offsetS.toFixed(1)} s from its scheduled time.`;
    case "pour-mass":
      return `Pour ${deviation.pour + 1} ended ${deviation.errorG.toFixed(1)} g from its cumulative target.`;
    case "pour-duration":
      return `Pour ${deviation.pour + 1} lasted ${deviation.seconds.toFixed(1)} s.`;
    case "brew-time":
      return `The brew took ${clock(deviation.seconds)}, outside the 2:30–3:30 window.`;
    case "kettle-exhausted":
      return `Pour ${deviation.pour + 1} could not reach its target with the kettle water.`;
    default:
      return assertNever(deviation);
  }
}
