import React from "react";
import {
  RecipeAnimationNotice,
  RecipeBackButton,
  RecipeSplitDivider,
  RunIcon,
  type RecipeSurface,
  RecipeSurfaceSwitch,
  RecipeWorkflow,
} from "../recipe-workflow";
import { runEnd, warpedStages } from "../recipe-clock";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import {
  LatteSimulationEngine,
  latteTimelineStages,
  type LattePhase,
  type LatteRecipeConfig,
  type LatteSample,
} from "@seams/production-simulation/recipes/latte/model";
import { LatteScene, type LatteCameraPreset } from "./latte-scene";
import { physicsEvidenceVisible } from "@seams/production-simulation/runs/physics-evidence";
import "../oven-workspace.css";
// The station readout uses the pour-over styles, so this view loads them itself.
import "../pour-over/pour-over.css";
import {
  RecipePlayback,
  type RecipeFrames,
  type RecipeRunState,
} from "../shared/playback-controller";
import { Live, LiveText } from "../shared/live";
import type { LiveSource } from "../shared/live-value";
import { RecipeRunFooter } from "../recipe-run-footer";

type ViewProps = Readonly<{
  appliance: "linea" | "eagle-one";
  frames: LiveSource<RecipeFrames<LatteSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: LatteCameraPreset;
}>;

const LATTE_STEPS = [
  {
    id: "espresso",
    label: "1 · Espresso",
    detail: "9 bar · 36 g",
    phases: [
      "place-cup",
      "espresso-shot",
      "transfer-cup",
    ] as readonly LattePhase[],
  },
  {
    id: "stretch",
    label: "2 · Stretch",
    detail: "1.4 bar · 37 °C",
    phases: ["grasp-pitcher", "steam-stretch"] as readonly LattePhase[],
  },
  {
    id: "whirlpool",
    label: "3 · Whirlpool",
    detail: "Roll · 63 °C",
    phases: ["steam-whirlpool"] as readonly LattePhase[],
  },
  {
    id: "pour",
    label: "4 · Rosetta",
    detail: "Free-pour art",
    phases: ["pour-latte", "return-pitcher"] as readonly LattePhase[],
  },
] as const;

const PHASE_INDEX: Readonly<Record<LattePhase, number>> = {
  "place-cup": 0,
  "espresso-shot": 0,
  "transfer-cup": 0,
  "grasp-pitcher": 1,
  "steam-stretch": 1,
  "steam-whirlpool": 2,
  "pour-latte": 3,
  "return-pitcher": 3,
  completed: 4,
  failed: -1,
};

class LattePhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: LatteScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new LatteScene(element, this.props.appliance);
    this.subscribe();
    void this.load(this.visual);
  }

  /** The scene and the station attributes follow each frame outside React. */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.props.frames.subscribe(this.showFrames.bind(this));
    this.showFrames(this.props.frames.get());
  }

  private showFrames(frames: RecipeFrames<LatteSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.dataset.lattePhase = frames.sample.phase;
      station.dataset.latteStep = String(frames.sample.step);
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private async load(visual: LatteScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The latte station visual is unavailable.",
        });
    }
  }

  componentDidUpdate(prevProps: ViewProps): void {
    if (prevProps.appliance !== this.props.appliance) {
      this.visual?.dispose();
      const element = this.element.current;
      if (element !== null) {
        this.visual = new LatteScene(element, this.props.appliance);
        void this.load(this.visual);
      }
    }
    if (
      prevProps.appliance !== this.props.appliance ||
      prevProps.frames !== this.props.frames
    )
      this.subscribe();
  }

  private selectCamera(camera: LatteCameraPreset): void {
    this.setState({ camera });
    this.visual?.setCameraPreset(camera);
  }

  componentWillUnmount(): void {
    this.unsubscribe?.();
    this.visual?.dispose();
    this.visual = null;
  }

  render(): React.ReactNode {
    const { frames } = this.props;
    return (
      <section
        ref={this.station}
        aria-label="Accepted caffe latte station state"
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label="3D FAIRINO FR10 Cobot and La Marzocco Linea Classic S milk steaming and Rosetta latte art station"
        />
        <div className="pour-over-camera-bar" role="group" aria-label="Camera">
          <BakeryAppearanceControl />
          <button
            type="button"
            aria-pressed={this.state.camera === "station"}
            onClick={this.selectCamera.bind(this, "station")}
          >
            Station view
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "steam"}
            onClick={this.selectCamera.bind(this, "steam")}
          >
            Steam wand close-up
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "pour"}
            onClick={this.selectCamera.bind(this, "pour")}
          >
            Latte pour close-up
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "overhead"}
            onClick={this.selectCamera.bind(this, "overhead")}
          >
            Overhead latte art
          </button>
        </div>
        <div className="pour-over-status">
          <Live source={frames} select={framePhase}>
            {(phase) => (
              <div
                className="pour-over-steps"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
                aria-label="Latte cycle progress"
              >
                {LATTE_STEPS.map((item, idx) => {
                  const currentIdx = PHASE_INDEX[phase];
                  const state =
                    phase === "completed" || currentIdx > idx
                      ? "done"
                      : currentIdx === idx
                        ? "active"
                        : "pending";
                  return (
                    <div
                      key={item.id}
                      className="pour-over-step-pill"
                      data-step-state={state}
                    >
                      <span>{item.label}</span>
                      <strong>{item.detail}</strong>
                    </div>
                  );
                })}
              </div>
            )}
          </Live>
          <dl className="pour-over-kpi-strip">
            <dt>Stage</dt>
            <Live source={frames} select={framePhase}>
              {(phase) => (
                <LiveText
                  as="dd"
                  data-latte-stage={phase}
                  source={frames}
                  text={stageText}
                />
              )}
            </Live>
            <dt>Pitcher milk</dt>
            <LiveText as="dd" source={frames} text={pitcherText} />
            <dt>Latte bowl</dt>
            <LiveText as="dd" source={frames} text={bowlText} />
            <dt>Rosetta art</dt>
            <LiveText as="dd" source={frames} text={artText} />
          </dl>
          {physicsEvidenceVisible() && (
            <details>
              <summary>Equipment &amp; thermal details</summary>
              <dl>
                <dt>Machine</dt>
                <dd>
                  {this.props.appliance === "linea"
                    ? "La Marzocco Linea Classic S"
                    : "Victoria Arduino Eagle One"}
                </dd>
                <dt>Steam boiler</dt>
                <LiveText as="dd" source={frames} text={boilerText} />
              </dl>
            </details>
          )}
        </div>
        {this.state.error !== null && <p role="alert">{this.state.error}</p>}
      </section>
    );
  }
}

function framePhase(frames: RecipeFrames<LatteSample>): LattePhase {
  return frames.sample.phase;
}

function stageText({ sample }: RecipeFrames<LatteSample>): string {
  return sample.stage;
}

function pitcherText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.pitcher.milkMassG.toFixed(1)} g at ${sample.pitcher.temperatureC.toFixed(1)} °C · ${Math.round((sample.pitcher.foamExpansion - 1) * 100)}% microfoam`;
}

function bowlText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.totalMassG.toFixed(1)} g (${sample.cup.espressoMassG.toFixed(0)} g espresso + ${sample.cup.milkMassG.toFixed(0)} g milk) at ${sample.cup.temperatureC.toFixed(1)} °C`;
}

function artText({ sample }: RecipeFrames<LatteSample>): string {
  return `${Math.round(sample.cup.latteArtProgress * 100)}% pattern`;
}

function boilerText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.espresso.steamPressureBar.toFixed(2)} bar · ${sample.espresso.steamBoilerC.toFixed(1)} °C ${sample.espresso.steamValveOpen ? "(open)" : "(closed)"}`;
}

function espressoText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.espressoMassG.toFixed(1)} g`;
}

function milkText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.milkMassG.toFixed(1)} g`;
}

function yieldText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.totalMassG.toFixed(1)} g at ${sample.cup.temperatureC.toFixed(1)} °C`;
}

function foamText({ sample }: RecipeFrames<LatteSample>): string {
  return `${Math.round((sample.pitcher.foamExpansion - 1) * 100)}% volume expansion`;
}

type WorkspaceProps = Readonly<{
  recipe: LatteRecipeConfig;
  close(): void;
}>;

type WorkspaceState = RecipeRunState &
  Readonly<{
    surface: RecipeSurface;
    panel: "scenario" | "results" | null;
    timeline: boolean;
  }>;

export class LatteWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private readonly playback: RecipePlayback<
    ReturnType<LatteSimulationEngine["initialSample"]>,
    ConstructorParameters<typeof LatteSimulationEngine>[0]
  >;

  constructor(props: WorkspaceProps) {
    super(props);
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.props.recipe,
        model: (recipe) => new LatteSimulationEngine(recipe),
        stages: () => latteTimelineStages(),
        outcomeNotice: (outcome) =>
          outcome.kind === "failed"
            ? outcome.reason
            : "Caffe Latte completed with Rosetta microfoam art.",
        resetNotice: "Station reset to t = 0.00 s.",
      },
      props.recipe,
    );
    this.state = {
      status: "review",
      surface: "factory",
      panel: null,
      timeline: false,
      notice: "Station prepared at t = 0.00 s. Press Start production to run.",
    };
  }

  componentWillUnmount(): void {
    this.playback.stop();
  }

  private togglePanel(next: "scenario" | "results"): void {
    this.setState((prev) => ({
      panel: prev.panel === next ? null : next,
    }));
  }

  private toggleTimeline(): void {
    this.setState((prev) => ({ timeline: !prev.timeline }));
  }

  private primaryControl(): React.ReactNode {
    const { status } = this.state;
    if (status === "running") {
      return (
        <button
          className="factory-primary"
          onClick={this.playback.pause.bind(this.playback)}
        >
          <RunIcon action="pause" />
          Pause production run
        </button>
      );
    }
    if (status === "paused") {
      return (
        <button
          className="factory-primary"
          onClick={this.playback.start.bind(this.playback)}
        >
          <RunIcon action="start" />
          Resume production run
        </button>
      );
    }
    if (status === "completed" || status === "blocked") {
      return (
        <button
          className="factory-primary"
          onClick={this.playback.restart.bind(this.playback)}
        >
          <RunIcon action="again" />
          Run again
        </button>
      );
    }
    return (
      <button
        className="factory-primary"
        onClick={this.playback.start.bind(this.playback)}
      >
        <RunIcon action="start" />
        Start production
      </button>
    );
  }

  render(): React.ReactNode {
    const { status, panel, timeline, notice } = this.state;
    const { recipe } = this.props;
    const { frames, clock } = this.playback;
    // The outcome arrives with a status change, so this render reads it.
    const outcome = frames.get().sample.outcome;
    const stages = warpedStages(latteTimelineStages(), this.playback.animation);

    return (
      <section
        className="production-workspace persistent-production"
        data-surface={this.state.surface}
        aria-label="Persistent production"
        data-lifecycle={status === "running" ? "running" : "settled"}
      >
        <div
          className="factory-main-canvas"
          hidden={this.state.surface === "workflow"}
        >
          <RecipeAnimationNotice plan={this.playback.animation} clock={clock} />
          <LattePhysicsView appliance={recipe.appliance} frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>
                Caffe Latte ·{" "}
                {recipe.appliance === "linea" ? "Linea Classic S" : "Eagle One"}{" "}
                &amp; FAIRINO FR10
              </h2>
            </div>
          </div>
          <nav aria-label="Factory workspace">
            <RecipeSurfaceSwitch
              value={this.state.surface}
              select={(surface) => this.setState({ surface })}
            />
            <div
              className="factory-panel-pills"
              role="group"
              aria-label="Detail panels"
            >
              <button
                type="button"
                aria-expanded={panel === "scenario"}
                onClick={this.togglePanel.bind(this, "scenario")}
              >
                Scenario
              </button>
              <button
                type="button"
                aria-expanded={panel === "results"}
                onClick={this.togglePanel.bind(this, "results")}
              >
                Results
              </button>
            </div>
          </nav>
        </header>
        {outcome?.kind === "completed" && (
          <button
            className="factory-summary"
            onClick={this.togglePanel.bind(this, "results")}
          >
            <strong>1</strong> Caffe Latte served ·{" "}
            {outcome.totalBeverageG.toFixed(1)} g at{" "}
            {outcome.finalCupTempC.toFixed(1)} °C
          </button>
        )}
        <aside
          className="production-panel factory-drawer"
          aria-label="Factory details"
          hidden={panel === null}
        >
          <div className="factory-drawer-heading">
            <h3>
              {panel === "results"
                ? "Production results"
                : "Scenario and run controls"}
            </h3>
            <button
              type="button"
              onClick={() => this.setState({ panel: null })}
            >
              Close details
            </button>
          </div>
          <div hidden={panel !== "scenario"}>
            <p>
              FAIRINO FR10 Cobot operating the dual-boiler espresso and steam
              station: 36 g 9-bar double espresso base, {recipe.milkG} g chilled
              milk steamed to {recipe.targetMilkC} °C with whirlpool microfoam
              texturing, and a free-pour Rosetta latte art finish.
            </p>
            <p role="status">{notice}</p>
          </div>
          <div hidden={panel !== "results"}>
            <h4>Measured latte mass &amp; thermal balance</h4>
            <dl>
              <dt>Espresso base (9 bar)</dt>
              <LiveText as="dd" source={frames} text={espressoText} />
              <dt>Steamed microfoam milk</dt>
              <LiveText as="dd" source={frames} text={milkText} />
              <dt>Total Caffe Latte yield</dt>
              <LiveText as="dd" source={frames} text={yieldText} />
              <dt>Microfoam expansion</dt>
              <LiveText as="dd" source={frames} text={foamText} />
            </dl>
          </div>
        </aside>
        <div
          className="factory-workflow-canvas"
          hidden={this.state.surface === "factory"}
        >
          <RecipeWorkflow
            planned={this.playback.planned.bind(this.playback)}
            graph={{ kind: "latte", milkG: recipe.milkG }}
            stages={stages}
            clock={clock}
            running={status === "running"}
            prepared={status === "review"}
            outcome={outcome?.kind ?? null}
            seek={this.playback.scrubToTime.bind(this.playback)}
          />
        </div>
        <RecipeSplitDivider surface={this.state.surface} />
        <RecipeRunFooter
          clock={clock}
          stages={stages}
          horizonS={runEnd(this.playback.animation, 56)}
          completed={outcome?.kind === "completed"}
          status={status}
          control={this.primaryControl()}
          timeline={timeline}
          toggleTimeline={this.toggleTimeline.bind(this)}
          seek={this.playback.scrubToTime.bind(this.playback)}
        />
      </section>
    );
  }
}
