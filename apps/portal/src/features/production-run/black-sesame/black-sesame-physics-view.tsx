import { Select } from "../../../ui/select";
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
  BlackSesameCobotSimulationEngine,
  blackSesameTimelineStages,
  type BlackSesameCheck,
  type BlackSesameCobotPhase,
  type BlackSesameCobotRecipeConfig,
  type BlackSesameCobotSample,
  type BlackSesameHobModel,
  type BlackSesameRoastMode,
} from "@seams/production-simulation/recipes/black-sesame/model";
import {
  BlackSesameScene,
  type BlackSesameCameraPreset,
} from "./black-sesame-scene";
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
  hob: BlackSesameHobModel;
  frames: LiveSource<RecipeFrames<BlackSesameCobotSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: BlackSesameCameraPreset;
}>;

const SESAME_STEPS = [
  {
    id: "grind",
    label: "1 · WSG60 Grind",
    detail: "4 × 55 g · 220 g",
  },
  {
    id: "slurry",
    label: "2 · Sweet Slurry",
    detail: "542 g · 96 °C",
  },
  {
    id: "blend",
    label: "3 · Quiet One Blend",
    detail: "760 g Ohaus tare",
  },
  {
    id: "cold-carrier",
    label: "4 · Cold Carrier",
    detail: "2 × 380 g · 3.0 °C",
  },
  {
    id: "severin",
    label: "5 · Severin Service",
    detail: "76 g + 210 g · 65 °C",
  },
] as const;

const PHASE_INDEX: Readonly<Record<BlackSesameCobotPhase, number>> = {
  "grind-sesame": 0,
  "cook-slurry": 1,
  "blend-standardize": 2,
  "cold-carrier-transfer": 3,
  "heated-mixer-service": 4,
  completed: 5,
  failed: -1,
};

class BlackSesamePhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: BlackSesameScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new BlackSesameScene(element, this.props.hob);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: BlackSesameScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The Black Sesame Milk workcell visual is unavailable.",
        });
    }
  }

  componentDidUpdate(prevProps: ViewProps): void {
    if (prevProps.hob !== this.props.hob) {
      this.visual?.dispose();
      const element = this.element.current;
      if (element !== null) {
        this.visual = new BlackSesameScene(element, this.props.hob);
        void this.load(this.visual);
      }
    }
    this.subscribe();
  }

  /** The scene and the station attributes follow each frame outside React. */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.props.frames.subscribe(this.showFrames.bind(this));
    this.showFrames(this.props.frames.get());
  }

  private showFrames(frames: RecipeFrames<BlackSesameCobotSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-black-sesame-phase", frames.sample.phase);
      station.setAttribute(
        "data-black-sesame-step",
        String(frames.sample.step),
      );
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private selectCamera(camera: BlackSesameCameraPreset): void {
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
    const hobTitle =
      this.props.hob === "maruzen"
        ? "Maruzen MIH-02C (2.0 kW)"
        : this.props.hob === "vollrath"
          ? "Vollrath Mirage Pro 59500P"
          : this.props.hob === "rinnai-rsb-150pj"
            ? "Rinnai RSB-150PJ (5.23 kW gas)"
            : "Panasonic KZ-CK1402 (1.4 kW)";

    return (
      <section
        ref={this.station}
        aria-label="Accepted black sesame milk station state"
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label="3D Black Sesame Milk workcell with FAIRINO FR10 Cobot, Waring WSG60 spice grinder, Maruzen MIH-02C induction hob, Vitamix The Quiet One blender, Ohaus Ranger 3000 scale, Hoshizaki RT-120SNJ refrigerator, and Severin SM 3587 milk mixer"
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
            aria-pressed={this.state.camera === "grinder-blender"}
            onClick={this.selectCamera.bind(this, "grinder-blender")}
          >
            WSG60 &amp; Vitamix
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "refrigerator"}
            onClick={this.selectCamera.bind(this, "refrigerator")}
          >
            Hoshizaki cold carrier
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "service"}
            onClick={this.selectCamera.bind(this, "service")}
          >
            Severin SM 3587 service
          </button>
        </div>
        <div className="pour-over-status">
          <Live source={frames} select={(f) => f.sample.phase}>
            {(phase) => (
              <div
                className="pour-over-steps"
                style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}
                aria-label="Black sesame milk cycle progress"
              >
                {SESAME_STEPS.map((item, idx) => {
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
            <Live source={frames} select={(f) => f.sample.phase}>
              {(phase) => (
                <LiveText
                  as="dd"
                  data-black-sesame-stage={phase}
                  source={frames}
                  text={({ sample }) => `${sample.stage}`}
                />
              )}
            </Live>
            <dt>WSG60 &amp; Vitamix</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.grinder.sesameGroundG.toFixed(0)} g milled (load ${sample.grinder.loadIndex}/4) · ${sample.blender.containerMassG.toFixed(1)} g in Advance container (${Math.round(sample.blender.homogenization * 100)}% homogenized)`
              }
            />
            <dt>Cold carrier &amp; Hoshizaki</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `bottle-a ${sample.coldCarrier.bottleAMassG.toFixed(0)} g · bottle-b ${sample.coldCarrier.bottleBMassG.toFixed(0)} g at ${sample.coldCarrier.cabinetTempC.toFixed(1)} °C ${
                  sample.coldCarrier.storedInRefrigerator
                    ? "(refrigerated)"
                    : "(staging)"
                }`
              }
            />
            <dt>Severin SM 3587</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.milkMixer.concentrateDosedG.toFixed(0)} g concentrate + ${sample.milkMixer.milkDosedG.toFixed(0)} g milk · ${sample.milkMixer.servedCupG.toFixed(0)} g served at ${sample.milkMixer.drinkTempC.toFixed(1)} °C`
              }
            />
          </dl>
          {physicsEvidenceVisible() && (
            <details>
              <summary>Equipment &amp; mass-balance details</summary>
              <dl>
                <dt>Induction slurry hob</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${hobTitle} · ${sample.induction.slurryMassG.toFixed(1)} g at ${sample.induction.slurryTempC.toFixed(1)} °C (${sample.induction.evaporatedG.toFixed(1)} g steam loss)`
                  }
                />
                <dt>Ohaus Ranger 3000</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${sample.scale.displayedG.toFixed(1)} g displayed (+${sample.scale.waterTopUpG.toFixed(1)} g water top-up)`
                  }
                />
              </dl>
            </details>
          )}
        </div>
        {this.state.error !== null && <p role="alert">{this.state.error}</p>}
      </section>
    );
  }
}

type WorkspaceProps = Readonly<{
  recipe: BlackSesameCobotRecipeConfig;
  close(): void;
}>;

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  recipe: BlackSesameCobotRecipeConfig;
  panel: "scenario" | "results" | null;
  timeline: boolean;
}> &
  RecipeRunState;

export class BlackSesameWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private readonly playback: RecipePlayback<
    ReturnType<BlackSesameCobotSimulationEngine["initialSample"]>,
    ConstructorParameters<typeof BlackSesameCobotSimulationEngine>[0]
  >;

  constructor(props: WorkspaceProps) {
    super(props);
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.state.recipe,
        model: (recipe) => new BlackSesameCobotSimulationEngine(recipe),
        stages: () => blackSesameTimelineStages(),
        outcomeNotice: (outcome) =>
          outcome.kind === "failed"
            ? outcome.reason
            : "Black Sesame Milk concentrate refrigerated in Hoshizaki RT-120SNJ and 286 g heated drink served.",
        resetNotice: "Workcell reset to t = 0.00 s.",
      },
      props.recipe,
    );
    this.state = {
      recipe: props.recipe,
      status: "review",
      surface: "factory",
      panel: null,
      timeline: false,
      notice:
        "Black Sesame Milk workcell prepared at t = 0.00 s. Press Start production to run.",
    };
  }

  componentWillUnmount(): void {
    this.playback.stop();
  }

  private applyScenario(next: BlackSesameCobotRecipeConfig): void {
    this.playback.applyScenario(next);
    this.setState({
      recipe: next,
      status: "review",
      panel: null,
      notice: "Updated Black Sesame Milk scenario applied.",
    });
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
    const { recipe, status, panel, timeline, notice } = this.state;
    const { frames, clock } = this.playback;
    // The outcome arrives with a status change, so this render reads it.
    const outcome = frames.get().sample.outcome;
    const stages = warpedStages(
      blackSesameTimelineStages(),
      this.playback.animation,
    );

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
          <BlackSesamePhysicsView hob={recipe.hob} frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>
                Black Sesame Milk · WSG60, Vitamix Quiet One &amp; Severin SM
                3587
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
            <strong>{outcome.standardizedConcentrateG.toFixed(0)} g</strong>{" "}
            concentrate · <strong>{outcome.servedDrinkG.toFixed(0)} g</strong>{" "}
            served at {outcome.servedDrinkTempC.toFixed(0)} °C
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
            <BlackSesameScenarioForm
              recipe={recipe}
              notice={notice}
              apply={this.applyScenario.bind(this)}
            />
          </div>
          <div hidden={panel !== "results"}>
            <h4>Measured Black Sesame Milk mass &amp; cold-storage balance</h4>
            <dl>
              <dt>Waring WSG60 milled black sesame</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.grinder.sesameGroundG.toFixed(1)} g (4 × 55 g)`
                }
              />
              <dt>Cooked sweet rice-flour slurry</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `530.0 g (${sample.induction.evaporatedG.toFixed(1)} g steam loss + 10.0 g residue/spill)`
                }
              />
              <dt>Ohaus Ranger 3000 standardized concentrate</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.scale.standardizedMassG.toFixed(1)} g (+${sample.scale.waterTopUpG.toFixed(1)} g water top-up)`
                }
              />
              <dt>Hoshizaki RT-120SNJ cold-container carrier</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `bottle-a ${sample.coldCarrier.bottleAMassG.toFixed(1)} g · bottle-b ${sample.coldCarrier.bottleBMassG.toFixed(1)} g at ${sample.coldCarrier.cabinetTempC.toFixed(1)} °C`
                }
              />
              <dt>Severin SM 3587 heated drink</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.milkMixer.servedCupG.toFixed(1)} g served at ${sample.milkMixer.drinkTempC.toFixed(1)} °C (76 g concentrate + 210 g milk)`
                }
              />
            </dl>
          </div>
        </aside>
        <div
          className="factory-workflow-canvas"
          hidden={this.state.surface === "factory"}
        >
          <RecipeWorkflow
            planned={this.playback.planned.bind(this.playback)}
            graph={{ kind: "black-sesame" }}
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
          horizonS={runEnd(this.playback.animation, 60)}
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

const HOB_ITEMS = [
  { value: "maruzen", label: "Maruzen MIH-02C (2.0 kW)" },
  { value: "vollrath", label: "Vollrath Mirage Pro 59500P" },
  {
    value: "panasonic-kz-ck1402",
    label: "Panasonic KZ-CK1402 (1.4 kW / 100 V)",
  },
  { value: "rinnai-rsb-150pj", label: "Rinnai RSB-150PJ (5.23 kW gas)" },
];

const ROAST_ITEMS = [
  { value: "skip", label: "Pre-roasted seeds (skip oven refresh)" },
  {
    value: "refresh",
    label: "160 °C Maruzen oven aroma refresh before grinding",
  },
];

const CHECK_ITEMS = [
  {
    value: "none",
    label: "Normal run (760 g concentrate + 286 g served drink)",
  },
  {
    value: "overweight-unreconciled",
    label: "Unreconciled overweight concentrate (762 g > 760 g)",
  },
  {
    value: "enclosure-interlock",
    label: "Vitamix Quiet One acoustic enclosure door interlock trip",
  },
];

function BlackSesameScenarioForm(props: {
  readonly recipe: BlackSesameCobotRecipeConfig;
  readonly notice: string;
  readonly apply: (next: BlackSesameCobotRecipeConfig) => void;
}): React.ReactNode {
  const [hob, setHob] = React.useState<BlackSesameHobModel>(props.recipe.hob);
  const [roast, setRoast] = React.useState<BlackSesameRoastMode>(
    props.recipe.roast,
  );
  const [check, setCheck] = React.useState<BlackSesameCheck>(
    props.recipe.check,
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({ ...props.recipe, hob, roast, check });
      }}
    >
      <p>
        FAIRINO FR10 Cobot operating the Black Sesame Milk bench: Waring WSG60
        spice grinder, induction slurry cooker, Vitamix The Quiet One blender,
        Ohaus Ranger 3000 scale, Hoshizaki RT-120SNJ cold-carrier transfer, and
        Severin SM 3587 heated drink service.
      </p>
      <label>
        Induction hob
        <Select.Root
          items={HOB_ITEMS}
          value={hob}
          onValueChange={(v) => {
            if (v === null) return;
            setHob(
              v === "vollrath" ||
                v === "panasonic-kz-ck1402" ||
                v === "rinnai-rsb-150pj"
                ? v
                : "maruzen",
            );
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{HOB_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Sesame roast mode
        <Select.Root
          items={ROAST_ITEMS}
          value={roast}
          onValueChange={(value) => {
            if (value === null) return;
            setRoast(value === "refresh" ? "refresh" : "skip");
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{ROAST_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Process check
        <Select.Root
          items={CHECK_ITEMS}
          value={check}
          onValueChange={(v) => {
            if (v === null) return;
            setCheck(
              v === "overweight-unreconciled" || v === "enclosure-interlock"
                ? v
                : "none",
            );
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{CHECK_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <button type="submit">Apply scenario</button>
      <p role="status">{props.notice}</p>
    </form>
  );
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
