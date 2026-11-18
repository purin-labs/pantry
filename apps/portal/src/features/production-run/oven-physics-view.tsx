import { Select } from "../../ui/select";
import {
  contactsAtStep,
  type ContactPair,
  type ContactObservation,
} from "@seams/production-simulation";
import React from "react";
import { PhysicsSceneHost } from "../workflow-simulator/spatial/physics-scene-host";
import { seconds } from "./oven-logistics";
import { physicsEvidenceVisible } from "@seams/production-simulation/runs/physics-evidence";
import {
  ovenFrameLabel,
  ovenFrameMotion,
  ovenSampleTime,
  type OvenLiveFrame,
} from "@seams/production-simulation/runs/oven-live-physics";

type Props = Readonly<{
  kind: "inspection" | "live" | "observation";
  playback: OvenLiveFrame;
  select(task: string): void;
}>;
type State = Readonly<{
  sample: number;
  showContacts: boolean;
  endpoint: "before" | "after";
  scene: "empty" | "loading" | "ready" | "unavailable";
}>;
const ENDPOINTS = [
  { value: "before", label: "Before handoff" },
  { value: "after", label: "After handoff" },
];

/** Seeks stored samples only. It has no reference to the execution worker. */
export class OvenPhysicsView extends React.Component<Props, State> {
  state: State = {
    sample: 0,
    showContacts: false,
    endpoint: "after",
    scene: "empty",
  };
  private readonly element = React.createRef<HTMLDivElement>();
  private mounted = false;
  private readonly host = new PhysicsSceneHost({
    fallback: "floor-plan",
    camera: "cell",
    select: this.select.bind(this),
    changed: this.sceneChanged.bind(this),
    inspectEvent: null,
    pause: null,
  });

  componentDidMount(): void {
    this.mounted = true;
    if (this.element.current !== null)
      void this.host.load(this.element.current, this.motion());
  }
  componentDidUpdate(): void {
    this.scheduleScene();
  }
  componentWillUnmount(): void {
    this.mounted = false;
    if (this.updateTimer !== null) clearTimeout(this.updateTimer);
    this.host.dispose();
  }
  // Each live observation would move the cell model, the floor plan and the
  // contact outlines. That work can block the page and the run behind it, so
  // updates coalesce, and the next waits at least as long as the last took.
  // The scene host spaces the frames themselves by the same rule.
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateEnd = 0;
  private lastUpdateCost = 0;
  private scheduleScene(): void {
    if (this.updateTimer !== null) return;
    const wait = Math.max(
      0,
      this.lastUpdateEnd + this.lastUpdateCost - performance.now(),
    );
    this.updateTimer = setTimeout(this.timedUpdate.bind(this), wait);
  }
  private timedUpdate(): void {
    this.updateTimer = null;
    if (!this.mounted) return;
    const started = performance.now();
    this.updateScene();
    this.lastUpdateEnd = performance.now();
    this.lastUpdateCost = this.lastUpdateEnd - started;
  }
  private motion() {
    return ovenFrameMotion(this.props.playback, this.state.endpoint);
  }
  private select(): void {
    const playback = this.props.playback;
    if (playback.purpose === "operation" || playback.purpose === "recovery")
      this.props.select(playback.task);
  }
  private sceneChanged(scene: State["scene"]): void {
    if (!this.mounted) return;
    this.setState({ scene });
    this.updateScene();
  }
  private updateScene(): void {
    const motion = this.motion();
    const sample = motion.samples[this.sampleIndex()];
    if (sample === undefined) return;
    const frame = {
      seconds: sample.step * motion.request.timestep,
      workcell: { kind: "empty" as const },
      layout: null,
      trays: null,
      motion,
    };
    this.host.webgl?.update(frame);
    this.host.fallback?.update(frame);
    const names = new Set<string>();
    const contacts = this.contacts(sample.step);
    if (this.state.showContacts && contacts !== null)
      for (const pair of contacts.pairs) {
        names.add(pair.first.geometry);
        names.add(pair.second.geometry);
      }
    const mapped = this.host.webgl?.showContactShapes(names) ?? 0;
    if (this.element.current !== null)
      this.element.current.dataset.contactShapes = String(mapped);
  }
  private contacts(step: number): ContactObservation | null {
    const frame = this.props.playback;
    return frame.purpose === "operation" ||
      frame.purpose === "recovery" ||
      frame.purpose === "idle"
      ? contactsAtStep(frame.contacts, step)
      : null;
  }
  private toggleContacts(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ showContacts: event.currentTarget.checked });
  }
  private seek(event: React.ChangeEvent<HTMLInputElement>): void {
    const sample = event.currentTarget.valueAsNumber;
    if (
      Number.isInteger(sample) &&
      sample >= 0 &&
      sample < this.motion().samples.length
    )
      this.setState({ sample });
  }
  private chooseEndpoint(endpoint: string | null): void {
    if (endpoint === "before" || endpoint === "after")
      this.setState({ endpoint, sample: 0 });
  }
  private sampleIndex(): number {
    return this.props.kind === "inspection"
      ? this.state.sample
      : this.motion().samples.length - 1;
  }
  render(): React.ReactNode {
    const playback = this.props.playback;
    const motion = this.motion();
    const sample = motion.samples[this.sampleIndex()] ?? motion.samples[0];
    const time = ovenSampleTime(playback, sample);
    const contacts = this.contacts(sample.step);
    const handoff =
      playback.purpose === "admission" || playback.purpose === "removal";
    const slot = handoff ? playback[this.state.endpoint].slot : null;
    return (
      <section
        aria-label={physicsLabel(this.props.kind)}
        data-physics-task={playback.task}
        data-boundary={playback.boundary}
        data-endpoint={handoff ? this.state.endpoint : undefined}
        data-slot={slot?.kind}
        data-scene={this.state.scene}
        data-step={sample.step}
        data-time={time}
        data-observation={time === playback.committedAt ? "current" : "gap"}
        data-purpose={playback.purpose}
      >
        <h3>
          {this.props.kind === "live"
            ? "Live recorded physics"
            : "Recorded physics"}{" "}
          · {ovenFrameLabel(playback)}
        </h3>
        <p>
          {playback.cell} · exact accepted sample at {seconds(time)} s.
          {this.props.kind === "observation"
            ? "Factory observation time"
            : "Committed simulation time"}
          : {seconds(playback.committedAt)} s.
          {this.props.kind !== "inspection" &&
            time < playback.committedAt &&
            " This view holds the last accepted sample."}
          {playback.purpose === "recovery" && " Recovery motion."}
        </p>
        {handoff && (
          <>
            <p>
              {playback.boundary} · both endpoints occur at{" "}
              {seconds(playback.at)} s. No transfer motion is recorded between
              them.
            </p>
            <p>
              Slot: {slot?.kind}
              {slot?.kind === "active" && ` · ${slot.carrier}`} · generation{" "}
              {slot?.generation}.
            </p>
            {this.props.kind === "inspection" && (
              <label>
                Handoff endpoint
                <Select.Root
                  items={ENDPOINTS}
                  value={this.state.endpoint}
                  onValueChange={this.chooseEndpoint.bind(this)}
                >
                  <Select.Trigger aria-label="Handoff endpoint">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {ENDPOINTS.map((item) => (
                      <Select.Item key={item.value} value={item.value}>
                        {item.label}
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Root>
              </label>
            )}
          </>
        )}
        {this.props.kind === "inspection" && (
          <>
            <p>
              Inspection time:{" "}
              <output aria-label="Physics inspection seconds">
                {seconds(time)}
              </output>{" "}
              s. The logistics views remain at {seconds(playback.committedAt)}{" "}
              s. Positions between these recorded samples are not shown.
            </p>
            {!handoff && (
              <label>
                Recorded sample
                <input
                  aria-label="Recorded physics sample"
                  type="range"
                  min={0}
                  max={motion.samples.length - 1}
                  step={1}
                  value={this.state.sample}
                  onChange={this.seek.bind(this)}
                />
              </label>
            )}
            <p>
              Sample {this.sampleIndex() + 1} of {motion.samples.length} ·
              solver step {sample.step}
            </p>
          </>
        )}
        <div className="oven-physics-scene" ref={this.element} />
        {this.state.scene === "unavailable" && (
          <p role="status">
            {physicsEvidenceVisible()
              ? "3D is unavailable. Exact sample values remain available below."
              : "3D is unavailable."}
          </p>
        )}
        {physicsEvidenceVisible() && (
          <>
            <details>
              <summary>Recorded contacts</summary>
              <section
                aria-label="Exact contact evidence"
                data-step={sample.step}
                data-coverage={contacts === null ? "unavailable" : "recorded"}
                data-pairs={contacts?.pairs.length}
              >
                {contacts === null ? (
                  <p>No contact observation is recorded for this exact step.</p>
                ) : (
                  <>
                    <p>
                      Forces were recomputed at the recorded pose. Each row
                      aggregates penetrating points between two shapes.
                    </p>
                    <label className="checkbox-label production-contact-toggle">
                      <input
                        type="checkbox"
                        checked={this.state.showContacts}
                        onChange={this.toggleContacts.bind(this)}
                      />
                      Outline recorded contact shapes
                    </label>
                    <p>
                      Outlines mark available scene geometry. The recording does
                      not contain contact point locations or force directions.
                      Unmapped shapes remain listed below.
                    </p>
                    {contacts.pairs.length === 0 ? (
                      <p>No penetrating shape pairs at this step.</p>
                    ) : (
                      <table>
                        <thead>
                          <tr>
                            <th>First shape</th>
                            <th>Second shape</th>
                            <th>Normal force (N)</th>
                            <th>Penetration (m)</th>
                          </tr>
                        </thead>
                        <tbody>{contacts.pairs.map(contactRow)}</tbody>
                      </table>
                    )}
                  </>
                )}
              </section>
            </details>
            <details>
              <summary>Exact solver values</summary>
              <pre aria-label="Exact physics sample">
                {JSON.stringify(sample, null, 2)}
              </pre>
            </details>
          </>
        )}
      </section>
    );
  }
}

function physicsLabel(kind: Props["kind"]): string {
  switch (kind) {
    case "live":
      return "Live accepted physics";
    case "observation":
      return "Historical accepted physics";
    case "inspection":
      return "Accepted physics inspection";
  }
}

function contactRow(pair: ContactPair): React.ReactNode {
  return (
    <tr
      key={`${pair.first.geometry}/${pair.first.body}/${pair.second.geometry}/${pair.second.body}`}
      data-contact-first={pair.first.geometry}
      data-contact-second={pair.second.geometry}
    >
      <td>
        {pair.first.geometry} ({pair.first.body})
      </td>
      <td>
        {pair.second.geometry} ({pair.second.body})
      </td>
      <td data-force-n={pair.normalForceN}>{pair.normalForceN}</td>
      <td data-penetration-m={pair.penetrationM}>{pair.penetrationM}</td>
    </tr>
  );
}
