import React from "react";
import { errorMessage } from "@seams/std";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import type { RecipeFrames } from "./playback-controller";
import { Live, LiveText, useLive } from "./live";
import type { LiveSource } from "./live-value";

/** The Three.js scene of a recipe station. */
type RecipeScene<Sample, Preset> = Readonly<{
  load(): Promise<void>;
  setFrame(sample: Sample): void;
  setSamples(samples: readonly Sample[]): void;
  setCameraPreset(preset: Preset): void;
  dispose(): void;
}>;

type Cameras<Preset extends string> = readonly (readonly [
  Preset,
  React.ReactNode,
])[];

/** The camera presets of a station, after the appearance control. */
export function RecipeCameraBar<Preset extends string>(
  props: Readonly<{
    className?: string;
    label: string;
    camera: Preset;
    cameras: Cameras<Preset>;
    select(camera: Preset): void;
    /** The agent's name for a preset button (`data-surface-target`). */
    target?(camera: Preset): string;
    /** More buttons after the presets. */
    children?: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <div
      className={props.className ?? "pour-over-camera-bar"}
      role="group"
      aria-label={props.label}
    >
      <BakeryAppearanceControl />
      {props.cameras.map(([preset, label]) => (
        <button
          key={preset}
          type="button"
          data-surface-target={props.target?.(preset)}
          aria-pressed={props.camera === preset}
          onClick={() => props.select(preset)}
        >
          {label}
        </button>
      ))}
      {props.children}
    </div>
  );
}

type StationProps<Sample, Preset extends string> = Readonly<{
  frames: LiveSource<RecipeFrames<Sample>>;
  /** Builds the scene on its element. A new `sceneKey` builds it again. */
  scene(element: HTMLDivElement): RecipeScene<Sample, Preset>;
  sceneKey?: string;
  /** The error when the scene does not load and gives no reason. */
  unavailable: string;
  /** The station's data attributes, written on each frame. */
  attributes(sample: Sample): Readonly<Record<string, string>>;
  /**
   * Shows the current frames again on each render of the workspace, not only
   * when the frames or the scene change.
   */
  showOnEachUpdate?: boolean;
  label: string;
  canvasLabel: string;
  camera: Preset;
  cameras: Cameras<Preset>;
  /** The readouts under the camera bar. */
  children: React.ReactNode;
}>;

type StationState<Preset> = Readonly<{
  error: string | null;
  camera: Preset;
}>;

/**
 * The 3D station of a recipe workspace: its scene, camera bar and readouts.
 * The scene and the station attributes follow each frame outside React.
 */
export class RecipeStation<
  Sample,
  Preset extends string,
> extends React.Component<StationProps<Sample, Preset>, StationState<Preset>> {
  state: StationState<Preset> = { error: null, camera: this.props.camera };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: RecipeScene<Sample, Preset> | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) {
      return;
    }
    this.visual = this.props.scene(element);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: RecipeScene<Sample, Preset>): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual) {
        this.setState({ error: errorMessage(error, this.props.unavailable) });
      }
    }
  }

  componentDidUpdate(prevProps: StationProps<Sample, Preset>): void {
    const rebuilt = prevProps.sceneKey !== this.props.sceneKey;
    if (rebuilt) {
      this.visual?.dispose();
      const element = this.element.current;
      if (element !== null) {
        this.visual = this.props.scene(element);
        void this.load(this.visual);
      }
    }
    if (
      this.props.showOnEachUpdate === true ||
      rebuilt ||
      prevProps.frames !== this.props.frames
    ) {
      this.subscribe();
    }
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.props.frames.subscribe(this.showFrames.bind(this));
    this.showFrames(this.props.frames.get());
  }

  private showFrames(frames: RecipeFrames<Sample>): void {
    const station = this.station.current;
    if (station !== null) {
      for (const [name, value] of Object.entries(
        this.props.attributes(frames.sample),
      )) {
        station.setAttribute(name, value);
      }
    }
    if (frames.samples.length > 1) {
      this.visual?.setSamples(frames.samples);
    } else {
      this.visual?.setFrame(frames.sample);
    }
  }

  private selectCamera(camera: Preset): void {
    this.setState({ camera });
    this.visual?.setCameraPreset(camera);
  }

  componentWillUnmount(): void {
    this.unsubscribe?.();
    this.visual?.dispose();
    this.visual = null;
  }

  render(): React.ReactNode {
    return (
      <section
        ref={this.station}
        aria-label={this.props.label}
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label={this.props.canvasLabel}
        />
        <RecipeCameraBar
          label="Camera"
          camera={this.state.camera}
          cameras={this.props.cameras}
          select={this.selectCamera.bind(this)}
        />
        <div className="pour-over-status">{this.props.children}</div>
        {this.state.error !== null && <p role="alert">{this.state.error}</p>}
      </section>
    );
  }
}

type SampleStationProps<Sample, Preset extends string> = Readonly<{
  sample: Sample | null;
  samples?: readonly Sample[] | undefined;
  /** Builds the scene on its element. */
  scene(element: HTMLDivElement): RecipeScene<Sample, Preset>;
  /** The error when the scene does not load and gives no reason. */
  unavailable: string;
  /** Shows the samples again once the scene has loaded. */
  showAfterLoad?: boolean;
  label: string;
  /** The station's data attributes; an undefined value writes none. */
  attributes?: Readonly<Record<`data-${string}`, string | number | undefined>>;
  camera: Preset;
  cameras: Cameras<Preset>;
  /** The readouts under the camera bar. */
  children: React.ReactNode;
}>;

/**
 * The 3D station of an appliance cell that shows the accepted samples its
 * parent passes, with no playback of its own.
 */
export class RecipeSampleStation<
  Sample,
  Preset extends string,
> extends React.Component<
  SampleStationProps<Sample, Preset>,
  StationState<Preset>
> {
  state: StationState<Preset> = { error: null, camera: this.props.camera };
  private readonly element = React.createRef<HTMLDivElement>();
  private visual: RecipeScene<Sample, Preset> | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) {
      return;
    }
    this.visual = this.props.scene(element);
    this.show();
    void this.load(this.visual);
  }

  private async load(visual: RecipeScene<Sample, Preset>): Promise<void> {
    try {
      await visual.load();
      if (this.props.showAfterLoad === true && this.visual === visual) {
        this.show();
      }
    } catch (error) {
      if (this.visual === visual) {
        this.setState({ error: errorMessage(error, this.props.unavailable) });
      }
    }
  }

  componentDidUpdate(): void {
    this.show();
  }

  private show(): void {
    if (this.visual === null) {
      return;
    }
    const { sample, samples } = this.props;
    if (samples !== undefined && samples.length > 0) {
      this.visual.setSamples(samples);
      return;
    }
    if (sample !== null) {
      this.visual.setFrame(sample);
    }
  }

  private selectCamera(camera: Preset): void {
    this.setState({ camera });
    this.visual?.setCameraPreset(camera);
  }

  componentWillUnmount(): void {
    this.visual?.dispose();
    this.visual = null;
  }

  render(): React.ReactNode {
    return (
      <section
        aria-label={this.props.label}
        className="pour-over-station"
        {...this.props.attributes}
      >
        <div className="pour-over-canvas" ref={this.element} />
        <RecipeCameraBar
          label="Camera view"
          camera={this.state.camera}
          cameras={this.props.cameras}
          select={this.selectCamera.bind(this)}
        />
        {this.state.error !== null && <p role="status">{this.state.error}</p>}
        {this.props.children}
      </section>
    );
  }
}

export type RecipeStep = Readonly<{
  id: string;
  label: string;
  detail: string;
}>;

/** The step pills of a station: done, active or pending at the frame's phase. */
export function RecipeStepPills<Sample>(
  props: Readonly<{
    frames: LiveSource<RecipeFrames<Sample>>;
    label: string;
    steps(sample: Sample): readonly RecipeStep[];
    /** The active step: the step count once the run completes, -1 when it fails. */
    index(sample: Sample): number;
  }>,
): React.ReactNode {
  const steps = useLive(props.frames, (frames) => props.steps(frames.sample));
  const index = useLive(props.frames, (frames) => props.index(frames.sample));
  return (
    <div
      className="pour-over-steps"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
      aria-label={props.label}
    >
      {steps.map((step, position) => (
        <div
          key={step.id}
          className="pour-over-step-pill"
          data-step-state={
            index > position
              ? "done"
              : index === position
                ? "active"
                : "pending"
          }
        >
          <span>{step.label}</span>
          <strong>{step.detail}</strong>
        </div>
      ))}
    </div>
  );
}

/** The Stage readout: the stage text, and the phase in a data attribute. */
export function RecipeStageReadout<
  Sample extends Readonly<{ phase: string; stage: string }>,
>(
  props: Readonly<{
    frames: LiveSource<RecipeFrames<Sample>>;
    attribute: `data-${string}`;
  }>,
): React.ReactNode {
  const { frames } = props;
  return (
    <>
      <dt>Stage</dt>
      <Live source={frames} select={(f) => f.sample.phase}>
        {(phase) => (
          <LiveText
            as="dd"
            {...{ [props.attribute]: phase }}
            source={frames}
            text={stageText}
          />
        )}
      </Live>
    </>
  );
}

function stageText({
  sample,
}: RecipeFrames<Readonly<{ stage: string }>>): string {
  return sample.stage;
}
