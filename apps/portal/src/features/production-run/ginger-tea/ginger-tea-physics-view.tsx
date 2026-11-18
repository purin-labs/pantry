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
  GingerTeaSimulationEngine,
  gingerTeaTimelineStages,
  type GingerTeaCheck,
  type GingerTeaCobotPhase,
  type GingerTeaCobotRecipeConfig,
  type GingerTeaCobotSample,
  type GingerTeaHobModel,
  type GingerTeaLeaf,
  type GingerTeaWorkflowMode,
} from "@seams/production-simulation/recipes/ginger-tea/model";
import { GingerTeaScene, type GingerTeaCameraPreset } from "./ginger-tea-scene";
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
  hob: GingerTeaHobModel;
  frames: LiveSource<RecipeFrames<GingerTeaCobotSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: GingerTeaCameraPreset;
}>;

const PHASE_INDEX: Readonly<Record<GingerTeaCobotPhase, number>> = {
  "stage-clean-pans": 0,
  "weigh-and-simmer-ginger": 1,
  "extract-tea": 2,
  "strain-and-inspect": 3,
  "finish-and-serve": 4,
  completed: 5,
  failed: -1,
};

function stepPills(mode: GingerTeaWorkflowMode) {
  if (mode === "black-tea") {
    return [
      { id: "stage", label: "1 · FR10 Pan Stage", detail: "Clean pan & pot" },
      { id: "simmer", label: "2 · Ginger Simmer", detail: "450 g + 15 g" },
      { id: "steep", label: "3 · Heat-Off Steep", detail: "8 g off-hob rest" },
      { id: "strain", label: "4 · Strain & Review", detail: "415 g extract" },
      { id: "serve", label: "5 · Sugar & Serve", detail: "435 g · 2 cups" },
    ] as const;
  }
  return [
    { id: "stage", label: "1 · Wash & FR10 Stage", detail: "Pan-b in insert" },
    { id: "simmer", label: "2 · Ginger Simmer", detail: "400 g + 15 g" },
    { id: "extract", label: "3 · Assam Simmer", detail: "9 g · 3 min" },
    { id: "strain", label: "4 · Strain to Pan-B", detail: "365 g extract" },
    { id: "finish", label: "5 · Milk 78 °C & Serve", detail: "570 g · 2 cups" },
  ] as const;
}

class GingerTeaPhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: GingerTeaScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new GingerTeaScene(element, this.props.hob);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: GingerTeaScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The Ginger Tea workcell visual is unavailable.",
        });
    }
  }

  componentDidUpdate(prevProps: ViewProps): void {
    if (prevProps.hob !== this.props.hob) {
      this.visual?.dispose();
      const element = this.element.current;
      if (element !== null) {
        this.visual = new GingerTeaScene(element, this.props.hob);
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

  private showFrames(frames: RecipeFrames<GingerTeaCobotSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-ginger-tea-phase", frames.sample.phase);
      station.setAttribute("data-ginger-tea-step", String(frames.sample.step));
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private selectCamera(camera: GingerTeaCameraPreset): void {
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
        aria-label="Accepted ginger tea station state"
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label="3D Ginger Tea and Two-Pan Ginger Milk Tea workcell with FAIRINO FR10 Cobot, rigid pan-staging insert, wash sink, Ohaus Ranger 3000 scale, Maruzen MIH-02C induction hob, heatproof rest, and fine mesh strainer"
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
            aria-pressed={this.state.camera === "pan-staging"}
            onClick={this.selectCamera.bind(this, "pan-staging")}
          >
            FR10 pan-staging insert
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "hob-straining"}
            onClick={this.selectCamera.bind(this, "hob-straining")}
          >
            Hob &amp; strainer
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "sink-service"}
            onClick={this.selectCamera.bind(this, "sink-service")}
          >
            Wash sink &amp; service
          </button>
        </div>
        <div className="pour-over-status">
          <Live
            source={frames}
            select={(f) => `${f.sample.mode}:${f.sample.phase}`}
          >
            {(key) => {
              const [mode, phase] = key.split(":") as [
                GingerTeaWorkflowMode,
                GingerTeaCobotPhase,
              ];
              return (
                <div
                  className="pour-over-steps"
                  style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}
                  aria-label="Ginger tea cycle progress"
                >
                  {stepPills(mode).map((item, idx) => {
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
              );
            }}
          </Live>
          <dl className="pour-over-kpi-strip">
            <dt>Stage</dt>
            <Live source={frames} select={(f) => f.sample.phase}>
              {(phase) => (
                <LiveText
                  as="dd"
                  data-ginger-tea-stage={phase}
                  source={frames}
                  text={({ sample }) => `${sample.stage}`}
                />
              )}
            </Live>
            <dt>FR10 Pan Staging</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${
                  sample.panStaging.stagedAtReceiver
                    ? "Staged at receiving station"
                    : sample.panStaging.insertSeated
                      ? "In-flight in rigid tray insert"
                      : "Insert displaced (recovery active)"
                }${
                  sample.panStaging.recoveryAttempt > 0
                    ? ` · recovery #${sample.panStaging.recoveryAttempt}`
                    : ""
                }`
              }
            />
            <dt>Hob &amp; Pan-A</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${hobTitle} · ${sample.hobStation.panAMassG.toFixed(0)} g at ${sample.hobStation.panATempC.toFixed(1)} °C (${sample.hobStation.evaporatedG.toFixed(1)} g steam loss)`
              }
            />
            <dt>Straining &amp; Service</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.straining.strainedMassG.toFixed(0)} g strained (${sample.straining.disposition}) · ${sample.finishing.servedMassG.toFixed(0)} g served (${sample.finishing.servings} cups at ${sample.finishing.panBTempC.toFixed(1)} °C)`
              }
            />
          </dl>
          {physicsEvidenceVisible() && (
            <details>
              <summary>Equipment, wash &amp; mass-balance details</summary>
              <dl>
                <dt>Ohaus Ranger 3000</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${sample.scale.displayedG.toFixed(1)} g displayed · ${sample.scale.gingerG.toFixed(1)} g ginger · ${sample.scale.teaG.toFixed(1)} g tea · ${sample.scale.sugarG.toFixed(1)} g sugar`
                  }
                />
                <dt>Wash sink &amp; cup preheat</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${sample.sink.panCleaned ? "Pans clean" : "Washing dirty pan"} · ${sample.sink.cupPreheatWaterG} g cup-preheat water`
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
  recipe: GingerTeaCobotRecipeConfig;
  close(): void;
}>;

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  recipe: GingerTeaCobotRecipeConfig;
  panel: "scenario" | "results" | null;
  timeline: boolean;
}> &
  RecipeRunState;

export class GingerTeaWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private readonly playback: RecipePlayback<
    ReturnType<GingerTeaSimulationEngine["initialSample"]>,
    ConstructorParameters<typeof GingerTeaSimulationEngine>[0]
  >;

  constructor(props: WorkspaceProps) {
    super(props);
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.state.recipe,
        model: (recipe) => new GingerTeaSimulationEngine(recipe),
        stages: (recipe) => gingerTeaTimelineStages(recipe.mode),
        outcomeNotice: (outcome) =>
          outcome.kind === "failed"
            ? outcome.reason
            : `Served ${outcome.servings} cups (${outcome.servedMassG} g at ${outcome.finalTempC.toFixed(1)} °C).`,
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
        "Ginger Tea MuJoCo pan-staging workcell prepared at t = 0.00 s. Press Start production to run.",
    };
  }

  componentWillUnmount(): void {
    this.playback.stop();
  }

  private applyScenario(next: GingerTeaCobotRecipeConfig): void {
    this.playback.applyScenario(next);
    this.setState({
      recipe: next,
      status: "review",
      panel: null,
      notice: "Updated Ginger Tea scenario applied.",
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
      gingerTeaTimelineStages(recipe.mode),
      this.playback.animation,
    );
    const title =
      recipe.mode === "two-pan-milk-tea"
        ? "Plan 61D Two-Pan Ginger Milk Tea · FR10 Pan-B Staging & 78 °C Milk Finishing"
        : "Plan 61C Ginger Black Tea · FR10 Clean-Pan Staging & Heat-Off Extraction";

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
          <GingerTeaPhysicsView hob={recipe.hob} frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>{title}</h2>
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
            <strong>{outcome.servings} cups</strong> (
            <strong>{outcome.servedMassG.toFixed(0)} g</strong>) served at{" "}
            {outcome.finalTempC.toFixed(0)} °C
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
            <GingerTeaScenarioForm
              recipe={recipe}
              notice={notice}
              apply={this.applyScenario.bind(this)}
            />
          </div>
          <div hidden={panel !== "results"}>
            <h4>Measured Ginger Tea mass, pan custody &amp; thermal balance</h4>
            <dl>
              <dt>Workflow procedure</dt>
              <dd>
                {recipe.mode === "two-pan-milk-tea"
                  ? "Plan 61D Two-Pan Ginger Milk Tea (pan-a simmer → pan-b strain & 75–80 °C milk finish)"
                  : "Plan 61C Ginger Black Tea (heat-off steeping on heatproof rest)"}
              </dd>
              <dt>FR10 MuJoCo pan staging (`persistent-pan-staging/1`)</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    sample.panStaging.stagedAtReceiver
                      ? "200 mm clean pan staged in rigid 600 × 400 mm tray insert"
                      : "In-flight staging"
                  }${
                    sample.panStaging.recoveryAttempt > 0
                      ? ` (recovered after displaced-pan fault)`
                      : ""
                  }`
                }
              />
              <dt>Extraction &amp; fine-mesh straining</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.straining.strainedMassG.toFixed(1)} g strained · ${sample.straining.retainedSolidsG.toFixed(1)} g wet solids · ${sample.straining.spillG.toFixed(1)} g spill`
                }
              />
              <dt>Finishing &amp; service</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.finishing.servedMassG.toFixed(1)} g (${sample.finishing.servings} cups) at ${sample.finishing.panBTempC.toFixed(1)} °C · ${sample.sink.cupPreheatWaterG} g cup preheat water`
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
            graph={{ kind: "ginger-tea", mode: recipe.mode }}
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

const MODES = [
  {
    value: "two-pan-milk-tea",
    label:
      "Plan 61D Two-Pan Ginger Milk Tea (pan-a simmer → pan-b milk finish)",
  },
  {
    value: "black-tea",
    label: "Plan 61C Ginger Black Tea (heat-off steeping on heatproof rest)",
  },
];
const HOBS = [
  { value: "maruzen", label: "Maruzen MIH-02C (2.0 kW)" },
  { value: "vollrath", label: "Vollrath Mirage Pro 59500P" },
  {
    value: "panasonic-kz-ck1402",
    label: "Panasonic KZ-CK1402 (1.4 kW / 100 V)",
  },
  { value: "rinnai-rsb-150pj", label: "Rinnai RSB-150PJ (5.23 kW gas)" },
];
const TEAS = [
  { value: "assam", label: "Assam leaf" },
  { value: "ctc", label: "Fine CTC tea" },
];
const CHECKS = [
  {
    value: "none",
    label: "Normal run (FR10 pan-b staging + on-time straining + service)",
  },
  {
    value: "dropped-pan-recovery",
    label: "D5 Dropped/displaced pan recovery (wash & re-stage in insert)",
  },
  {
    value: "late-straining-hold",
    label: "90 s worker delay across extraction deadline (hold for review)",
  },
];

function GingerTeaScenarioForm(props: {
  readonly recipe: GingerTeaCobotRecipeConfig;
  readonly notice: string;
  readonly apply: (next: GingerTeaCobotRecipeConfig) => void;
}): React.ReactNode {
  const [mode, setMode] = React.useState<GingerTeaWorkflowMode>(
    props.recipe.mode,
  );
  const [hob, setHob] = React.useState<GingerTeaHobModel>(props.recipe.hob);
  const [tea, setTea] = React.useState<GingerTeaLeaf>(props.recipe.tea);
  const [check, setCheck] = React.useState<GingerTeaCheck>(props.recipe.check);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({ ...props.recipe, mode, hob, tea, check });
      }}
    >
      <p>
        FAIRINO FR10 Cobot operating the Plan 61C Ginger Black Tea and Plan 61D
        Two-Pan Ginger Milk Tea bench: wash sink, rigid pan-staging insert,
        Ohaus Ranger 3000 scale, Maruzen / Vollrath induction hob, heatproof
        rest, and fine mesh strainer.
      </p>
      <label>
        Tea workflow mode
        <Select.Root
          items={MODES}
          value={mode}
          onValueChange={(value) => {
            if (value !== null)
              setMode(value === "black-tea" ? "black-tea" : "two-pan-milk-tea");
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {MODES.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <label>
        Induction hob model
        <Select.Root
          items={HOBS}
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
          <Select.Popup>
            {HOBS.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <label>
        Tea leaf selection
        <Select.Root
          items={TEAS}
          value={tea}
          onValueChange={(value) => {
            if (value !== null) setTea(value === "ctc" ? "ctc" : "assam");
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {TEAS.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <label>
        Process &amp; pan-staging check
        <Select.Root
          items={CHECKS}
          value={check}
          onValueChange={(v) => {
            if (v === null) return;
            setCheck(
              v === "late-straining-hold" || v === "dropped-pan-recovery"
                ? v
                : "none",
            );
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {CHECKS.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <button type="submit">Apply scenario</button>
      <p role="status">{props.notice}</p>
    </form>
  );
}
