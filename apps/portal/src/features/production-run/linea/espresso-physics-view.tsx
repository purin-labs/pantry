import React from "react";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import { isRecord, parseJsonOrNull, sha256Hex } from "@seams/std";
import {
  readCellRecordingDocument,
  type PhysicsView,
} from "@seams/production-simulation";
import {
  parseApplianceSample,
  type ApplianceSample,
} from "@seams/bakery-model/bakery-appliance-protocol";
import {
  espressoVisualHash,
  type EspressoMachine,
  type PersistentEspressoCell,
} from "@seams/bakery-model/bakery-physics";
import {
  EspressoScene,
  parseEspressoLiveTelemetry,
  type EspressoCameraPreset,
} from "./espresso-scene";
import { physicsEvidenceVisible } from "@seams/production-simulation/runs/physics-evidence";
import "../pour-over/pour-over.css";

type Props = Readonly<{
  sample: ApplianceSample | null;
  samples?: readonly ApplianceSample[];
  appliance: EspressoMachine;
}>;
type State = Readonly<{
  error: string | null;
  camera: EspressoCameraPreset;
}>;

const ESPRESSO_STEPS = [
  { id: "place", label: "Place cup", detail: "Drip grate" },
  { id: "brew", label: "Extract", detail: "18 s · 36 g" },
  { id: "serve", label: "Serve cup", detail: "Service mat" },
] as const;

export class EspressoPhysicsView extends React.Component<Props, State> {
  state: State = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private visual: EspressoScene | null = null;
  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new EspressoScene(element, this.props.appliance);
    this.syncVisual();
    void this.load(this.visual);
  }
  private async load(visual: EspressoScene): Promise<void> {
    try {
      await visual.load();
      if (this.visual === visual) this.syncVisual();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The appliance visual is unavailable.",
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
  private selectCamera(camera: EspressoCameraPreset): void {
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
        aria-label="Accepted espresso machine state"
        className="pour-over-station"
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
              ["station", "Station view"],
              ["group", "Group head close-up"],
              ["overhead", "Overhead bar"],
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
        {sample !== null && (
          <EspressoStatus sample={sample} appliance={this.props.appliance} />
        )}
        <p className="pour-over-note">
          Accepted Rust/MuJoCo state. Guided cup movement and beverage yield
          remain uncalibrated.
        </p>
      </section>
    );
  }
}

function EspressoStatus(
  props: Readonly<{ sample: ApplianceSample; appliance: EspressoMachine }>,
) {
  const telemetry = parseEspressoLiveTelemetry(props.sample);
  const { leftCup, leftShot } = telemetry;
  const placing =
    leftCup.position === "placed" &&
    leftShot.kind === "idle" &&
    leftCup.massG < 0.5;
  const brewing = leftShot.kind === "dispensing";
  const removing =
    (leftCup.position === "removed" && leftCup.travelM < 0.178) ||
    (leftCup.position === "placed" && leftShot.kind === "complete");
  const completedOrder =
    leftCup.position === "removed" &&
    leftCup.travelM >= 0.178 &&
    (telemetry.servedG > 0 || leftCup.massG >= 35);

  const stepState = (id: "place" | "brew" | "serve") => {
    if (id === "place") {
      if (placing) return "active";
      if (brewing || removing || completedOrder || leftCup.travelM < 0.01)
        return "done";
      return "pending";
    }
    if (id === "brew") {
      if (brewing) return "active";
      if (removing || completedOrder || leftShot.kind === "complete")
        return "done";
      return "pending";
    }
    if (removing) return "active";
    if (completedOrder) return "done";
    return "pending";
  };

  const servedOrders = Math.min(4, Math.floor((telemetry.servedG + 0.5) / 36));
  const stageDescription = placing
    ? servedOrders > 0 && leftCup.travelM > 0.145
      ? "Knocking spent puck & dosing 18 g portafilter"
      : leftCup.travelM > 0.004
        ? "FR10 placing demitasse cup on drip grate"
        : "Cup seated · pressing group brew button"
    : brewing
      ? `9-bar dual-spout extraction (${leftShot.elapsedS.toFixed(1)} s / ${leftShot.durationS.toFixed(0)} s)`
      : removing
        ? "FR10 transferring espresso cup to service mat"
        : completedOrder
          ? "Order served · station ready"
          : "Preheated station · ready for order";

  return (
    <div className="pour-over-status">
      <div
        className="pour-over-steps"
        style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        aria-label="Espresso cycle progress"
      >
        {ESPRESSO_STEPS.map((item) => (
          <div
            key={item.id}
            className="pour-over-step-pill"
            data-step-state={stepState(item.id)}
          >
            <span>{item.label}</span>
            <strong>{item.detail}</strong>
          </div>
        ))}
      </div>
      <dl className="pour-over-kpi-strip">
        <dt>Stage</dt>
        <dd>{stageDescription}</dd>
        <dt>Group pressure</dt>
        <dd>{telemetry.brewPressureBar.toFixed(1)} bar</dd>
        <dt>Shot timer</dt>
        <dd>
          {leftShot.kind === "idle"
            ? "0.0 s · idle"
            : `${leftShot.elapsedS.toFixed(1)} s / ${leftShot.durationS.toFixed(0)} s`}
        </dd>
        <dt>Cup yield</dt>
        <dd>
          {(leftCup.massG > 0.1
            ? leftCup.massG
            : completedOrder
              ? Math.min(36, telemetry.servedG)
              : 0
          ).toFixed(1)}{" "}
          g at {leftCup.temperatureC.toFixed(1)} °C
        </dd>
        <dt>Total served</dt>
        <dd>
          {servedOrders} {servedOrders === 1 ? "cup" : "cups"} ·{" "}
          {telemetry.servedG.toFixed(1)} g
        </dd>
      </dl>
      {physicsEvidenceVisible() && (
        <details>
          <summary>Equipment &amp; thermal details</summary>
          <dl>
            <dt>Machine</dt>
            <dd>
              {props.appliance === "linea"
                ? "La Marzocco Linea Classic S"
                : "Victoria Arduino Eagle One"}
            </dd>
            <dt>Boilers</dt>
            <dd>
              {telemetry.coffeeC.toFixed(1)} °C coffee ·{" "}
              {telemetry.steamC.toFixed(1)} °C steam
            </dd>
            <dt>Knock-box</dt>
            <dd>
              {servedOrders} {servedOrders === 1 ? "spent puck" : "spent pucks"}
            </dd>
          </dl>
        </details>
      )}
    </div>
  );
}

export function readEspressoObservation(
  raw: unknown,
  cell: PersistentEspressoCell,
): ApplianceSample {
  if (cell.visualHash !== espressoVisualHash(cell.appliance))
    throw new Error("This Portal cannot display the saved espresso visual.");
  if (
    !isRecord(raw) ||
    raw.kind !== "observed" ||
    raw.modelHash !== cell.modelHash
  )
    throw new Error("The espresso observation differs from its model.");
  return parseApplianceSample(raw.sample);
}

export async function readEspressoSamples(
  view: Exclude<PhysicsView, { kind: "unavailable" }>,
  cell: PersistentEspressoCell,
): Promise<readonly ApplianceSample[]> {
  if (
    view.cell !== cell.cellId ||
    (await sha256Hex(view.content)) !== view.digest
  )
    throw new Error("The espresso recording differs from its accepted digest.");
  let raw: unknown = parseJsonOrNull(view.content);
  if (view.kind === "cell-recorded")
    raw = parseJsonOrNull(readCellRecordingDocument(raw).native);
  if (
    !isRecord(raw) ||
    raw.kind !== "espresso-physics-recording" ||
    raw.modelHash !== cell.modelHash ||
    raw.runId !== cell.runId ||
    raw.runnerSha256 !== cell.execution.controllerHash ||
    raw.runtimeSha256 !== cell.execution.runtimeHash ||
    !Array.isArray(raw.samples) ||
    raw.samples.length === 0
  )
    throw new Error("Invalid espresso recording.");
  const samples = raw.samples;
  const stride = Math.max(1, Math.floor(samples.length / 8));
  const result: ApplianceSample[] = [];
  for (let index = 0; index < samples.length; index += stride) {
    const item: unknown = samples[index];
    if (!isRecord(item)) throw new Error("Missing espresso sample.");
    result.push(parseApplianceSample(item.appliance));
  }
  const last: unknown = samples.at(-1);
  if (!isRecord(last)) throw new Error("Missing espresso sample.");
  const finalSample = parseApplianceSample(last.appliance);
  if (result.at(-1)?.timeSeconds !== finalSample.timeSeconds) {
    result.push(finalSample);
  }
  return result;
}

export async function readEspressoFrame(
  view: Exclude<PhysicsView, { kind: "unavailable" }>,
  cell: PersistentEspressoCell,
): Promise<ApplianceSample> {
  const samples = await readEspressoSamples(view, cell);
  const last = samples.at(-1);
  if (last === undefined) throw new Error("Missing espresso sample.");
  return last;
}
