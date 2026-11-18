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
  FinancierBatterSimulationEngine,
  financierBatterTimelineStages,
  type FinancierBatterCheck,
  type FinancierBatterOutcome,
  type FinancierBatterPhase,
  type FinancierBatterRecipeConfig,
  type FinancierBatterSample,
  type FinancierHobModel,
  type FinancierMixerTool,
} from "@seams/production-simulation/recipes/financier-batter/model";
import {
  FinancierBatterScene,
  type FinancierBatterCameraPreset,
} from "./financier-batter-scene";
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
  hob: FinancierHobModel;
  tool: FinancierMixerTool;
  frames: LiveSource<RecipeFrames<FinancierBatterSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: FinancierBatterCameraPreset;
}>;

const BATTER_STEPS = [
  {
    id: "noisette",
    label: "1 · Noisette",
    detail: "152 °C · 158 g",
  },
  {
    id: "charge",
    label: "2 · Charge",
    detail: "395 g + 181 g",
  },
  {
    id: "paste",
    label: "3 · Paste Mix",
    detail: "Speed 2 · 107 RPM",
  },
  {
    id: "emulsify",
    label: "4 · Emulsify",
    detail: "Speed 1 · 726 g",
  },
] as const;

const PHASE_INDEX: Readonly<Record<FinancierBatterPhase, number>> = {
  "brown-butter": 0,
  "charge-dry-whites": 1,
  "mix-paste": 2,
  "temper-butter": 3,
  homogenize: 3,
  completed: 4,
  failed: -1,
};

class FinancierBatterPhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: FinancierBatterScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new FinancierBatterScene(
      element,
      this.props.hob,
      this.props.tool,
    );
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: FinancierBatterScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The Financier batter workcell visual is unavailable.",
        });
    }
  }

  componentDidUpdate(prevProps: ViewProps): void {
    if (
      prevProps.hob !== this.props.hob ||
      prevProps.tool !== this.props.tool
    ) {
      this.visual?.dispose();
      const element = this.element.current;
      if (element !== null) {
        this.visual = new FinancierBatterScene(
          element,
          this.props.hob,
          this.props.tool,
        );
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

  private showFrames(frames: RecipeFrames<FinancierBatterSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-financier-batter-phase", frames.sample.phase);
      station.setAttribute(
        "data-financier-batter-step",
        String(frames.sample.step),
      );
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private selectCamera(camera: FinancierBatterCameraPreset): void {
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
    const toolTitle =
      this.props.tool === "beater"
        ? "Hobart BBEATER-HL20 Flat Beater"
        : "Hobart DWHIP-HL20 Wire Whip";

    return (
      <section
        ref={this.station}
        aria-label="Accepted financier batter station state"
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label="3D Financier batter workcell with FAIRINO FR10 Cobot, Ohaus Ranger 3000 scale, Maruzen MIH-02C induction hob, and Hobart HL200 20 qt planetary mixer"
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
            aria-pressed={this.state.camera === "hob"}
            onClick={this.selectCamera.bind(this, "hob")}
          >
            Beurre noisette hob
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "mixer"}
            onClick={this.selectCamera.bind(this, "mixer")}
          >
            Hobart HL200 bowl
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "overhead"}
            onClick={this.selectCamera.bind(this, "overhead")}
          >
            Overhead workcell
          </button>
        </div>
        <div className="pour-over-status">
          <Live source={frames} select={(f) => f.sample.phase}>
            {(phase) => (
              <div
                className="pour-over-steps"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
                aria-label="Financier batter cycle progress"
              >
                {BATTER_STEPS.map((item, idx) => {
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
                  data-financier-batter-stage={phase}
                  source={frames}
                  text={({ sample }) => `${sample.stage}`}
                />
              )}
            </Live>
            <dt>Beurre noisette</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.induction.butterMassG.toFixed(1)} g at ${sample.induction.butterTempC.toFixed(1)} °C (${sample.induction.evaporatedG.toFixed(1)} g steam loss)`
              }
            />
            <dt>20 qt mixer bowl</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.mixer.bowlMassG.toFixed(1)} g at ${sample.mixer.batterTempC.toFixed(1)} °C · ${Math.round(sample.mixer.emulsification * 100)}% homogenized`
              }
            />
            <dt>Ohaus scale</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.scale.displayedG.toFixed(1)} g ${sample.scale.tared ? "(tared)" : "(verifying)"}`
              }
            />
          </dl>
          {physicsEvidenceVisible() && (
            <details>
              <summary>Equipment &amp; thermal details</summary>
              <dl>
                <dt>Induction hob</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${hobTitle} · ${sample.induction.powerKw.toFixed(1)} kW`
                  }
                />
                <dt>Hobart HL200</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${
                      sample.mixer.speedSetting === 0
                        ? "Stopped"
                        : `Speed ${sample.mixer.speedSetting} (${sample.mixer.rpm} RPM)`
                    } · ${toolTitle}`
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
  recipe: FinancierBatterRecipeConfig;
  close(): void;
  applyToSchedule?: (
    outcome: Extract<FinancierBatterOutcome, { kind: "completed" }>,
  ) => void;
}>;

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  recipe: FinancierBatterRecipeConfig;
  panel: "scenario" | "results" | null;
  timeline: boolean;
}> &
  RecipeRunState;

export class FinancierBatterWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private readonly playback: RecipePlayback<
    ReturnType<FinancierBatterSimulationEngine["initialSample"]>,
    ConstructorParameters<typeof FinancierBatterSimulationEngine>[0]
  >;

  constructor(props: WorkspaceProps) {
    super(props);
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.state.recipe,
        model: (recipe) => new FinancierBatterSimulationEngine(recipe),
        stages: () => financierBatterTimelineStages(),
        outcomeNotice: (outcome) =>
          outcome.kind === "failed"
            ? outcome.reason
            : "Financier batter homogenized and ready for mould depositing.",
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
      notice: "Workcell prepared at t = 0.00 s. Press Start production to run.",
    };
  }

  componentWillUnmount(): void {
    this.playback.stop();
  }

  private applyScenario(next: FinancierBatterRecipeConfig): void {
    this.playback.applyScenario(next);
    this.setState({
      recipe: next,
      status: "review",
      panel: null,
      notice: "Updated Financier batter scenario applied.",
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
      financierBatterTimelineStages(),
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
          <FinancierBatterPhysicsView
            hob={recipe.hob}
            tool={recipe.tool}
            frames={frames}
          />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>Financier Batter · Beurre Noisette &amp; Hobart HL200</h2>
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
            <strong>{outcome.totalBatterG.toFixed(1)} g</strong> Financier
            batter · {outcome.mouldCavitiesYield} cavities @ 25 g
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
            <FinancierBatterScenarioForm
              recipe={recipe}
              notice={notice}
              apply={this.applyScenario.bind(this)}
            />
          </div>
          <div hidden={panel !== "results"}>
            <h4>Measured Financier batter mass &amp; thermal balance</h4>
            <dl>
              <dt>Tant-pour-tant dry blend</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mixer.dryChargedG.toFixed(1)} g`
                }
              />
              <dt>Tempered egg whites &amp; vanilla</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mixer.whitesChargedG.toFixed(1)} g`
                }
              />
              <dt>Browned butter (beurre noisette)</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mixer.butterChargedG.toFixed(1)} g (${sample.induction.evaporatedG.toFixed(1)} g steam loss + 8.0 g pan residue)`
                }
              />
              <dt>Total Hobart HL200 20 qt yield</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mixer.bowlMassG.toFixed(1)} g at ${sample.mixer.batterTempC.toFixed(1)} °C (${Math.round(sample.mixer.emulsification * 100)}% homogenized)`
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
            graph={{ kind: "financier", part: "batter" }}
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
          actions={
            <>
              {outcome?.kind === "completed" &&
                this.props.applyToSchedule !== undefined && (
                  <button
                    type="button"
                    className="factory-primary"
                    onClick={() => this.props.applyToSchedule?.(outcome)}
                  >
                    Apply to Tier 3 schedule
                  </button>
                )}
            </>
          }
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

const TOOL_ITEMS = [
  { value: "beater", label: "BBEATER-HL20 Flat Beater" },
  { value: "whip", label: "DWHIP-HL20 Wire Whip" },
];

const CHECK_ITEMS = [
  { value: "none", label: "Normal run (726 g batter)" },
  { value: "burnt-butter", label: "Burnt butter (> 170 °C)" },
  { value: "guard-interlock", label: "Guard interlock trip" },
];

function FinancierBatterScenarioForm(props: {
  readonly recipe: FinancierBatterRecipeConfig;
  readonly notice: string;
  readonly apply: (next: FinancierBatterRecipeConfig) => void;
}): React.ReactNode {
  const [hob, setHob] = React.useState<FinancierHobModel>(props.recipe.hob);
  const [tool, setTool] = React.useState<FinancierMixerTool>(props.recipe.tool);
  const [check, setCheck] = React.useState<FinancierBatterCheck>(
    props.recipe.check,
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({ ...props.recipe, hob, tool, check });
      }}
    >
      <p>
        FAIRINO FR10 Cobot operating the patisserie prep bench: Ohaus Ranger
        3000 weighing pan, 152 °C induction beurre noisette pan, and Hobart
        HL200 20 qt planetary mixer.
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
        Hobart HL200 agitator
        <Select.Root
          items={TOOL_ITEMS}
          value={tool}
          onValueChange={(value) => {
            if (value === null) return;
            setTool(value === "whip" ? "whip" : "beater");
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{TOOL_ITEMS.map(renderItem)}</Select.Popup>
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
              v === "burnt-butter" || v === "guard-interlock" ? v : "none",
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
