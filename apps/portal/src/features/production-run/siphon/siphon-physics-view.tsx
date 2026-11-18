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
import {
  ORIGINAL_ANIMATION,
  warpedEngine,
  warpedStages,
  type AnimationPlan,
  type AnimationPlanBuilder,
  type RecipeEngine,
} from "../recipe-clock";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import {
  SIPHON_STATION_SETUP,
  SiphonSimulationEngine,
  type SiphonPhase,
  type SiphonRecipeConfig,
  type SiphonSample,
  type SiphonSetup,
} from "@seams/production-simulation/recipes/siphon/model";
import { SiphonScene, type SiphonCameraPreset } from "./siphon-scene";
import { physicsEvidenceVisible } from "@seams/production-simulation/runs/physics-evidence";
import "../oven-workspace.css";
import "./siphon.css";
import {
  recipeClock,
  recipeFrames,
  type RecipeFrames,
} from "../shared/playback-controller";
import { Live, LiveText, useLive } from "../shared/live";
import { LiveValue, type LiveSource } from "../shared/live-value";
import { RecipeRunFooter, RecipeScrubber } from "../recipe-run-footer";

type ViewProps = Readonly<{
  setup: SiphonSetup;
  frames: LiveSource<RecipeFrames<SiphonSample>>;
}>;
type ViewState = Readonly<{
  error: string | null;
  camera: SiphonCameraPreset;
}>;

const SIPHON_STAGES = [
  {
    id: "upflow",
    label: "Upflow",
    target: "350 W",
    phases: ["preheat-seal", "upflow"] as readonly SiphonPhase[],
  },
  {
    id: "fold-in",
    label: "Fold-in",
    target: "3 stirs",
    phases: ["fold-in"] as readonly SiphonPhase[],
  },
  {
    id: "steep",
    label: "Steep",
    target: "110 W",
    phases: ["steep"] as readonly SiphonPhase[],
  },
  {
    id: "whirlpool",
    label: "Whirlpool",
    target: "3 stirs",
    phases: ["whirlpool"] as readonly SiphonPhase[],
  },
  {
    id: "drawdown",
    label: "Vacuum",
    target: "0 W",
    phases: ["drawdown"] as readonly SiphonPhase[],
  },
] as const;

const PHASE_ORDER: Readonly<Record<SiphonPhase, number>> = {
  "preheat-seal": 0,
  upflow: 0,
  "fold-in": 1,
  steep: 2,
  whirlpool: 3,
  drawdown: 4,
  completed: 5,
  failed: -1,
};

/** Interactive 3D Hario ECA-3-B Electric Coffee Syphon + FAIRINO FR10 view. */
class SiphonPhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "bench" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: SiphonScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new SiphonScene(element, this.props.setup);
    this.subscribe();
    void this.load(this.visual);
  }
  private async load(visual: SiphonScene): Promise<void> {
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
  componentDidUpdate(prevProps: ViewProps): void {
    if (prevProps.frames !== this.props.frames) this.subscribe();
  }
  /** The scene and the station attributes follow each frame outside React. */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.props.frames.subscribe(this.showFrames.bind(this));
    this.showFrames(this.props.frames.get());
  }
  private showFrames(frames: RecipeFrames<SiphonSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-siphon-phase", frames.sample.control.phase);
      station.setAttribute("data-siphon-step", String(frames.sample.step));
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }
  private selectCamera(camera: SiphonCameraPreset): void {
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
        aria-label="Accepted siphon coffee station state"
        className="siphon-station"
      >
        <div className="siphon-canvas" ref={this.element} />
        <div
          className="siphon-camera-bar"
          role="group"
          aria-label="Camera view"
        >
          <BakeryAppearanceControl />
          {(
            [
              ["bench", "Bench view"],
              ["chambers", "Chambers close-up"],
              ["overhead", "Overhead stir"],
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
        <SiphonStatus frames={this.props.frames} />
        <p className="siphon-note">
          Hario ECA-3-B Electric Coffee Syphon (360 mL), F-103S cloth filter and
          BA-15 bamboo paddle on the MuJoCo FR10 cell.
        </p>
      </section>
    );
  }
}

function SiphonStatus(
  props: Readonly<{ frames: LiveSource<RecipeFrames<SiphonSample>> }>,
) {
  const { frames } = props;
  // Coarse values: they change at a phase, an outcome or a new deviation.
  const outcome = useLive(frames, (f) => f.sample.outcome);
  const phase = useLive(frames, (f) => f.sample.control.phase);
  const deviations = useLive(
    frames,
    (f) => f.sample.control.deviations,
    sameDeviations,
  );
  const currentIdx = PHASE_ORDER[phase];
  return (
    <div className="siphon-status">
      {outcome?.kind === "failed" && (
        <p role="alert" data-siphon-failure={outcome.reason}>
          The brew failed:{" "}
          {outcome.reason === "unsealed-gasket-leak"
            ? "the upper bowl silicone gasket did not seal, so steam escaped"
            : "the gripper lost the BA-15 bamboo paddle collar"}
          . The station holds its material where it is.
        </p>
      )}
      <div className="siphon-steps" aria-label="Five-stage siphon progress">
        {SIPHON_STAGES.map((stage, index) => {
          const active = stage.phases.includes(phase);
          const done = outcome?.kind === "completed" || currentIdx > index;
          const state = active ? "active" : done ? "done" : "pending";
          return (
            <div
              key={stage.id}
              className="siphon-step-pill"
              data-step-state={state}
            >
              <span>{stage.label}</span>
              <strong>{stage.target}</strong>
            </div>
          );
        })}
      </div>
      <dl className="siphon-kpi-strip">
        <dt>Stage</dt>
        <LiveText
          as="dd"
          data-siphon-stage
          source={frames}
          text={({ sample: { control, outcome } }) =>
            `${
              outcome?.kind === "completed"
                ? "Brew complete · vacuum drawdown finished"
                : outcome?.kind === "failed"
                  ? "Stopped after a failure"
                  : control.stage
            }`
          }
        />
        <dt>Brew time</dt>
        <LiveText
          as="dd"
          source={frames}
          text={({ sample: { control } }) =>
            `${clock(control.brewS)}${
              (control.steepRemainingS !== null &&
                ` · ${control.steepRemainingS} s steep remaining`) ||
              ""
            }`
          }
          attributes={({ sample: { control } }) => ({
            "data-siphon-brew-seconds": String(Math.floor(control.brewS)),
          })}
        />
        <dt>Bulb pressure</dt>
        <LiveText
          as="dd"
          source={frames}
          text={({ sample: { thermo } }) =>
            `${thermo.pressureKPa.toFixed(1)} kPa${
              thermo.vacuumKPa > 0.2
                ? ` · -${thermo.vacuumKPa.toFixed(1)} kPa vacuum`
                : thermo.pressureKPa > 101.6
                  ? ` · +${(thermo.pressureKPa - 101.325).toFixed(1)} kPa steam`
                  : " · atmospheric"
            }`
          }
          attributes={({ sample: { thermo } }) => ({
            "data-siphon-pressure": String(thermo.pressureKPa.toFixed(1)),
          })}
        />
        <dt>Extraction</dt>
        <LiveText
          as="dd"
          source={frames}
          text={({ sample: { extraction } }) =>
            `${extraction.tdsPct.toFixed(2)}% TDS · ${extraction.extractionYieldPct.toFixed(1)}% yield`
          }
          attributes={({ sample: { extraction } }) => ({
            "data-siphon-tds": String(extraction.tdsPct.toFixed(2)),
          })}
        />
        <dt>Beverage in bulb</dt>
        <LiveText
          as="dd"
          source={frames}
          text={({ sample: { water, outcome } }) =>
            `${water.beverageG.toFixed(1)} g${
              (outcome?.kind === "completed" &&
                ` · ${(outcome.beverageMg / 1000).toFixed(1)} g clarified coffee`) ||
              ""
            }`
          }
          attributes={({ sample: { water, outcome } }) => ({
            "data-siphon-beverage": String(water.beverageG.toFixed(1)),
          })}
        />
      </dl>
      {deviations.length > 0 && (
        <section aria-label="Brew deviations">
          <h4>Deviations</h4>
          <ul>
            {deviations.map((deviation, index) => (
              <li key={index} data-siphon-deviation={deviation.kind}>
                {deviation.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      {physicsEvidenceVisible() && (
        <details>
          <summary>Water, vapor &amp; extraction physics</summary>
          <dl>
            <dt>Electric heater</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { heater } }) =>
                `${heater.powerW} W (${heater.radiativeW.toFixed(0)} W thermal · ${
                  heater.mode === "high-350w"
                    ? "max heat-up"
                    : heater.mode === "hold-110w"
                      ? "mid steep hold"
                      : "off · cooling"
                })`
              }
            />
            <dt>Stem flow</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) =>
                `${
                  Math.abs(water.flowGS) > 0.08
                    ? `${Math.abs(water.flowGS).toFixed(1)} g/s ${water.flowGS > 0 ? "upflow" : "Darcy drawdown"}`
                    : "0.0 g/s · hydrostatic balance"
                }`
              }
            />
            <dt>Lower bulb</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { thermo, water } }) =>
                `${water.lowerG.toFixed(1)} g at ${thermo.lowerC.toFixed(1)} °C`
              }
            />
            <dt>Upper funnel</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { thermo, water } }) =>
                `${(water.upperFreeG + water.absorbedG).toFixed(1)} g slurry at ${thermo.upperC.toFixed(1)} °C`
              }
            />
            <dt>Bamboo stirs</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { control } }) =>
                `${control.stirCount} / 6 revolutions (BA-15)`
              }
            />
            <dt>Initial lower water</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) => `${water.initialG.toFixed(1)} g`}
            />
            <dt>In lower bulb</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) => `${water.lowerG.toFixed(2)} g`}
            />
            <dt>In 140 mm glass stem</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) => `${water.stemG.toFixed(2)} g`}
            />
            <dt>Free in upper funnel</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) =>
                `${water.upperFreeG.toFixed(2)} g`
              }
            />
            <dt>Retained in coffee dome</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) =>
                `${water.absorbedG.toFixed(2)} g (${(water.domeHeightM * 1000).toFixed(1)} mm dome)`
              }
            />
            <dt>Evaporated</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { water } }) =>
                `${water.evaporatedG.toFixed(2)} g`
              }
            />
            <dt>Antoine P_sat(T_bulb)</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { thermo } }) =>
                `${thermo.vaporPressureKPa.toFixed(1)} kPa`
              }
            />
            <dt>Grounds wetting &amp; CO₂ foam</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { extraction } }) =>
                `${(extraction.wettingFraction * 100).toFixed(0)}% wet · ${extraction.co2FoamMm.toFixed(1)} mm crema`
              }
            />
            <dt>3-layer crust buoyancy</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { extraction } }) =>
                `${(extraction.crustBuoyancy * 100).toFixed(0)}% suspended`
              }
            />
            <dt>Neck gasket</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample: { control } }) =>
                `${control.sealed ? "Seated and sealed" : "Unsealed"}`
              }
            />
          </dl>
        </details>
      )}
    </div>
  );
}

function sameDeviations(
  a: SiphonSample["control"]["deviations"],
  b: SiphonSample["control"]["deviations"],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.detail === b[index]?.detail && item.kind === b[index]?.kind,
    )
  );
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

type WorkspaceProps = Readonly<{
  recipe: SiphonRecipeConfig;
  close(): void;
}>;

type WorkspacePanel = "scenario" | "results" | null;
type WorkspaceStatus = "ready" | "running" | "paused" | "completed" | "blocked";

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  status: WorkspaceStatus;
  panel: WorkspacePanel;
  timeline: boolean;
  notice: string;
}>;

type SiphonTimelineStage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

function siphonTimelineStages(
  recipe: SiphonRecipeConfig,
): readonly SiphonTimelineStage[] {
  const steepEndS = 48 + recipe.steepSeconds;
  const whirlpoolEndS = steepEndS + 16;
  const drawdownEndS = whirlpoolEndS + 51;
  return [
    { id: "preheat-seal", label: "Preheat & seat gasket", startS: 0, endS: 10 },
    { id: "upflow", label: "Vapor upflow", startS: 10, endS: 28 },
    { id: "fold-in", label: "Fold-in bamboo stir (3×)", startS: 28, endS: 48 },
    {
      id: "steep",
      label: `Immersion steep (${recipe.steepSeconds} s)`,
      startS: 48,
      endS: steepEndS,
    },
    {
      id: "whirlpool",
      label: "Whirlpool stir (3×)",
      startS: steepEndS,
      endS: whirlpoolEndS,
    },
    {
      id: "drawdown",
      label: "Darcy vacuum drawdown",
      startS: whirlpoolEndS,
      endS: drawdownEndS,
    },
  ];
}

/**
 * Full persistent-production workspace for the Hario Syphon Technica TCA-3
 * vacuum coffee simulation, matching the Pour-over and Espresso workspaces.
 */
export class SiphonWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private engine: RecipeEngine<
    ReturnType<SiphonSimulationEngine["currentSample"]>
  >;
  private animation: AnimationPlan = ORIGINAL_ANIMATION;
  private timer: number | null = null;
  private mounted = false;
  /** The frames of the run. They live outside React state. */
  private readonly frames: LiveValue<RecipeFrames<SiphonSample>>;
  private readonly clock;

  constructor(props: WorkspaceProps) {
    super(props);
    this.engine = this.animated(props.recipe);
    this.frames = new LiveValue(recipeFrames(this.engine.initialSample()));
    this.clock = recipeClock(this.frames);
    this.state = {
      status: "ready",
      surface: "factory",
      panel: null,
      timeline: false,
      notice: `Prepared Hario ECA-3-B electric siphon station with ${props.recipe.waterG} g hot water, ${props.recipe.coffeeG} g medium-fine coffee and a ${props.recipe.steepSeconds} s steep.`,
    };
  }

  componentDidMount(): void {
    this.mounted = true;
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startOrResume(): void {
    if (this.state.status === "running") return;
    this.setState({
      status: "running",
      notice: "Running Hario ECA-3-B thermo-siphon and FR10 kinematics…",
    });
    this.stopTimer();
    this.timer = window.setInterval(() => {
      if (!this.mounted) return;
      const batch = this.engine.stepBatch(18);
      const latest = batch.at(-1);
      if (latest === undefined) return;
      this.frames.set({
        sample: latest,
        samples: batch,
        history: [...this.frames.get().history, latest],
      });
      if (latest.outcome !== null) {
        this.stopTimer();
        const doneStatus: WorkspaceStatus =
          latest.outcome.kind === "completed" ? "completed" : "blocked";
        this.setState({
          status: doneStatus,
          notice:
            latest.outcome.kind === "completed"
              ? `Brew complete: ${(latest.outcome.beverageMg / 1000).toFixed(1)} g clarified siphon coffee in the lower bulb.`
              : `Brew stopped: ${latest.outcome.reason}.`,
        });
      }
    }, 55);
  }

  private pause(): void {
    this.stopTimer();
    if (this.state.status === "running") {
      this.setState({
        status: "paused",
        notice: `Paused at ${this.frames.get().sample.timeS.toFixed(2)} s.`,
      });
    }
  }

  private restart(): void {
    this.stopTimer();
    this.engine = this.animated(this.props.recipe);
    this.frames.set(recipeFrames(this.engine.initialSample()));
    this.setState({ status: "ready" }, () => {
      this.startOrResume();
    });
  }

  private togglePanel(panel: Exclude<WorkspacePanel, null>): void {
    this.setState((prev) => ({
      panel: prev.panel === panel ? null : panel,
    }));
  }

  private toggleTimeline(): void {
    this.setState((prev) => ({
      timeline: !prev.timeline,
    }));
  }

  private animated(
    recipe: ConstructorParameters<typeof SiphonSimulationEngine>[0],
  ) {
    const model = new SiphonSimulationEngine(recipe);
    return warpedEngine(
      {
        initialSample: model.currentSample.bind(model),
        stepBatch: model.stepBatch.bind(model),
      },
      this.animation,
      0.02,
    );
  }

  /** A draft ran: the next start plays it, as far as this animation can. */
  private planned(build: AnimationPlanBuilder): void {
    this.stopTimer();
    this.animation = build(siphonTimelineStages(this.props.recipe));
    this.engine = this.animated(this.props.recipe);
    this.frames.set(recipeFrames(this.engine.initialSample()));
    this.setState({ status: "ready" });
  }

  private scrubToTime(targetS: number): void {
    const { history } = this.frames.get();
    if (history.length === 0) return;
    let closest = history[0]!;
    let bestDiff = Math.abs(closest.timeS - targetS);
    for (const candidate of history) {
      const diff = Math.abs(candidate.timeS - targetS);
      if (diff < bestDiff) {
        closest = candidate;
        bestDiff = diff;
      }
    }
    this.pause();
    this.frames.set({ sample: closest, samples: [closest], history });
  }

  private primaryControl(): React.ReactNode {
    const { status } = this.state;
    if (status === "running") {
      return (
        <button className="factory-primary" onClick={this.pause.bind(this)}>
          <RunIcon action="pause" />
          Pause production run
        </button>
      );
    }
    if (status === "paused") {
      return (
        <button
          className="factory-primary"
          onClick={this.startOrResume.bind(this)}
        >
          <RunIcon action="start" />
          Resume production run
        </button>
      );
    }
    if (status === "completed" || status === "blocked") {
      return (
        <button className="factory-primary" onClick={this.restart.bind(this)}>
          <RunIcon action="again" />
          Run again
        </button>
      );
    }
    return (
      <button
        className="factory-primary"
        onClick={this.startOrResume.bind(this)}
      >
        <RunIcon action="start" />
        Start production
      </button>
    );
  }

  render(): React.ReactNode {
    const { status, panel, timeline, notice } = this.state;
    const { recipe } = this.props;
    const { frames, clock } = this;
    // The outcome arrives with a status change, so this render reads it.
    const outcome = frames.get().sample.outcome;
    const stages = warpedStages(siphonTimelineStages(recipe), this.animation);
    const horizon = stages.at(-1)?.endS ?? 170;
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
          <RecipeAnimationNotice plan={this.animation} clock={clock} />
          <SiphonPhysicsView setup={SIPHON_STATION_SETUP} frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>Hario ECA-3-B Electric Coffee Syphon · 3-cup vacuum brew</h2>
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
            <strong>1</strong> siphon brew completed ·{" "}
            {(outcome.beverageMg / 1000).toFixed(1)} g beverage yield
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
              Hario ECA-3-B Electric Coffee Syphon (360 mL) with its conical
              BL-ECA-3 lower server, cylindrical BU-ECA-3 upper bowl, F-103S
              flannel cloth filter and BA-15 bamboo stirring paddle. Configured
              with {recipe.waterG} g water, {recipe.coffeeG} g medium-fine
              coffee and {recipe.steepSeconds} s immersion steep.
            </p>
            <p role="status">{notice}</p>
          </div>
          <div hidden={panel !== "results"}>
            <h4>Measured siphon mass balance</h4>
            <dl>
              <dt>Clarified siphon beverage</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    outcome?.kind === "completed"
                      ? `${outcome.beverageMg.toLocaleString()} mg (${(outcome.beverageMg / 1000).toFixed(2)} g)`
                      : `${sample.water.beverageG.toFixed(1)} g (in progress)`
                  }`
                }
              />
              <dt>Spent coffee dome (grounds + absorbed water)</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    outcome?.kind === "completed"
                      ? `${outcome.spentBedMg.toLocaleString()} mg`
                      : `${(recipe.coffeeG + sample.water.absorbedG).toFixed(1)} g`
                  }`
                }
              />
              <dt>Evaporated steam</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    outcome?.kind === "completed"
                      ? `${outcome.evaporatedMg.toLocaleString()} mg`
                      : `${(sample.water.evaporatedG * 1000).toFixed(0)} mg`
                  }`
                }
              />
              <dt>Coffee extraction (TDS / EY)</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    outcome?.kind === "completed"
                      ? `${outcome.tdsPct.toFixed(2)}% TDS · ${outcome.extractionYieldPct.toFixed(1)}% extraction yield`
                      : `${sample.extraction.tdsPct.toFixed(2)}% TDS · ${sample.extraction.extractionYieldPct.toFixed(1)}% yield`
                  }`
                }
              />
              <dt>Peak bulb pressure / Darcy vacuum</dt>
              <dd>104.8 kPa upflow / 96.1 kPa drawdown (-5.2 kPa vacuum)</dd>
            </dl>
          </div>
        </aside>
        <div
          className="factory-workflow-canvas"
          hidden={this.state.surface === "factory"}
        >
          <RecipeWorkflow
            planned={this.planned.bind(this)}
            graph={{
              kind: "siphon",
              waterG: recipe.waterG,
              coffeeG: recipe.coffeeG,
              steepSeconds: recipe.steepSeconds,
            }}
            stages={stages}
            clock={clock}
            running={status === "running"}
            prepared={status === "ready"}
            outcome={outcome?.kind ?? null}
            seek={this.scrubToTime.bind(this)}
          />
        </div>
        <RecipeSplitDivider surface={this.state.surface} />
        <RecipeRunFooter
          clock={clock}
          stages={stages}
          horizonS={horizon}
          completed={outcome?.kind === "completed"}
          status={status}
          control={
            <>
              {this.primaryControl()}
              <Live source={frames} select={(f) => f.history.length > 1}>
                {(scrubbable) =>
                  scrubbable && (
                    <div className="production-scrubber">
                      <LiveText
                        as="strong"
                        source={frames}
                        text={({ sample, history }) =>
                          `${sample.timeS.toFixed(2)} / ${(history.at(-1)?.timeS ?? horizon).toFixed(2)} s · ${sample.control.stage}`
                        }
                      />
                      <label>
                        <span className="production-sr-only">
                          Simulation time
                        </span>
                        <RecipeScrubber
                          source={frames}
                          label="Simulation time"
                          step="0.1"
                          value={(f) => f.sample.timeS}
                          max={(f) => f.history.at(-1)?.timeS ?? horizon}
                          seek={this.scrubToTime.bind(this)}
                        />
                      </label>
                    </div>
                  )
                }
              </Live>
            </>
          }
          after={
            <span className="factory-save-status">
              Hario ECA-3-B · F-103S · FAIRINO FR10
            </span>
          }
          timeline={timeline}
          toggleTimeline={this.toggleTimeline.bind(this)}
          seek={this.scrubToTime.bind(this)}
        />
      </section>
    );
  }
}
