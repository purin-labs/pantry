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
  FinancierBakeSimulationEngine,
  financierBakeTimelineStages,
  type FinancierBakeCheck,
  type FinancierBakeMode,
  type FinancierBakeOutcome,
  type FinancierBakePhase,
  type FinancierBakeRecipeConfig,
  type FinancierBakeSample,
  type FinancierMouldCount,
  type FinancierRackSlot,
} from "@seams/production-simulation/recipes/financier-bake/model";
import {
  FinancierBakeScene,
  type FinancierBakeCameraPreset,
} from "./financier-bake-scene";
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
  frames: LiveSource<RecipeFrames<FinancierBakeSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: FinancierBakeCameraPreset;
}>;

const BAKE_STEPS = [
  {
    id: "deposit",
    label: "1 · Deposit 8P",
    detail: "25 g × 8 · 78%",
  },
  {
    id: "load",
    label: "2 · Rack Load",
    detail: "600 × 400 mm",
  },
  {
    id: "bake",
    label: "3 · MBCO-5E Bake",
    detail: "Bosse & Crust",
  },
  {
    id: "cool",
    label: "4 · Grid Cool",
    detail: "23.5 g / pc",
  },
] as const;

const PHASE_INDEX: Readonly<Record<FinancierBakePhase, number>> = {
  "deposit-moulds": 0,
  "load-oven": 1,
  "convection-bake": 2,
  "unload-cool": 3,
  completed: 4,
  failed: -1,
};

export class FinancierBakePhysicsView extends React.Component<
  ViewProps,
  ViewState
> {
  state: ViewState = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: FinancierBakeScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new FinancierBakeScene(element);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: FinancierBakeScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The Financier bake workcell visual is unavailable.",
        });
    }
  }

  componentDidUpdate(): void {
    this.subscribe();
  }

  /** The scene and the station attributes follow each frame outside React. */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.props.frames.subscribe(this.showFrames.bind(this));
    this.showFrames(this.props.frames.get());
  }

  private showFrames(frames: RecipeFrames<FinancierBakeSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-financier-bake-phase", frames.sample.phase);
      station.setAttribute(
        "data-financier-bake-step",
        String(frames.sample.step),
      );
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private selectCamera(camera: FinancierBakeCameraPreset): void {
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
        aria-label="Accepted financier bake station state"
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label="3D Financier bake workcell with FAIRINO FR10 Cobot, Ohaus Ranger 3000 scale, Matsunaga 8-cavity silicone-coated financier mould, 600 by 400 mm carrier tray, and Maruzen MBCO-5E 5-tray convection oven"
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
            aria-pressed={this.state.camera === "depositor"}
            onClick={this.selectCamera.bind(this, "depositor")}
          >
            Ohaus &amp; 8P mould dosing
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "oven"}
            onClick={this.selectCamera.bind(this, "oven")}
          >
            Maruzen MBCO-5E chamber
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "cooling"}
            onClick={this.selectCamera.bind(this, "cooling")}
          >
            In-mould wire grid
          </button>
        </div>
        <div className="pour-over-status">
          <Live source={frames} select={(f) => f.sample.phase}>
            {(phase) => (
              <div
                className="pour-over-steps"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
                aria-label="Financier bake cycle progress"
              >
                {BAKE_STEPS.map((item, idx) => {
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
                  data-financier-bake-stage={phase}
                  source={frames}
                  text={({ sample }) => `${sample.stage}`}
                />
              )}
            </Live>
            <dt>Matsunaga 8P mould</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.mouldTray.mouldCount} × 8P (${sample.mouldTray.cavitiesFilled} cavities) · ${sample.mouldTray.currentMassG.toFixed(1)} g (${sample.mouldTray.evaporatedG.toFixed(1)} g steam loss)`
              }
            />
            <dt>Bosse &amp; Maillard</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${Math.round(sample.mouldTray.bosseRise * 100)}% central bosse rise · ${Math.round(Math.min(1, sample.mouldTray.crustBrowning) * 100)}% golden crust · core ${sample.mouldTray.coreTempC.toFixed(1)} °C`
              }
            />
            <dt>Ohaus scale</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.scale.displayedG.toFixed(1)} g ${sample.scale.mouldOnScale ? "(dosing)" : "(tared · unloaded)"}`
              }
            />
            <dt>Maruzen MBCO-5E</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.oven.chamberTempC.toFixed(1)} °C · ${ovenModeLabel(sample)} · Slot ${sample.oven.rackSlot} (${(sample.oven.rackHeightM * 1000).toFixed(0)} mm)`
              }
            />
            {physicsEvidenceVisible() && (
              <>
                <dt>Piston funnel</dt>
                <LiveText
                  as="dd"
                  source={frames}
                  text={({ sample }) =>
                    `${sample.depositor.funnelBatterG.toFixed(1)} g retained batter (of 726.0 g batch)`
                  }
                />
              </>
            )}
          </dl>
        </div>
        {this.state.error !== null && <p role="alert">{this.state.error}</p>}
      </section>
    );
  }
}

function ovenModeLabel(sample: FinancierBakeSample): string {
  return sample.oven.mode === "convection"
    ? `Convection (${sample.oven.fanRpm} RPM fan)`
    : "Conventional (0 RPM fan)";
}

type WorkspaceProps = Readonly<{
  recipe: FinancierBakeRecipeConfig;
  close(): void;
  applyToSchedule?: (
    outcome: Extract<FinancierBakeOutcome, { kind: "completed" }>,
  ) => void;
}>;

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  recipe: FinancierBakeRecipeConfig;
  panel: "scenario" | "results" | null;
  timeline: boolean;
}> &
  RecipeRunState;

export class FinancierBakeWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private readonly playback: RecipePlayback<
    ReturnType<FinancierBakeSimulationEngine["initialSample"]>,
    ConstructorParameters<typeof FinancierBakeSimulationEngine>[0]
  >;

  constructor(props: WorkspaceProps) {
    super(props);
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.state.recipe,
        model: (recipe) => new FinancierBakeSimulationEngine(recipe),
        stages: () => financierBakeTimelineStages(),
        outcomeNotice: (outcome) =>
          outcome.kind === "failed"
            ? outcome.reason
            : "Financiers baked, inspected, and staged on wire grid for 2–3 min in-mould cooling.",
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

  private applyScenario(next: FinancierBakeRecipeConfig): void {
    this.playback.applyScenario(next);
    this.setState({
      recipe: next,
      status: "review",
      panel: null,
      notice: "Updated Financier bake scenario applied.",
    });
  }

  private runFaultRecoveryCalibration(): void {
    const next: FinancierBakeRecipeConfig = {
      ...this.state.recipe,
      mode: "convection",
      targetOvenTempC: 170,
      check: "carrier-handoff-recovery",
    };
    this.playback.applyScenario(next);
    this.setState(
      {
        recipe: next,
        status: "review",
        panel: null,
        notice:
          "Fault-recovery calibration preset loaded (14 mm carrier slip + FR10 cell 1 re-seat). Running recovery cycle.",
      },
      () => this.playback.start(),
    );
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
      financierBakeTimelineStages(),
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
          <FinancierBakePhysicsView frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>Financier Bake · Mould Depositing &amp; Maruzen MBCO-5E</h2>
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
            <strong>{outcome.bakedFinanciersG.toFixed(1)} g</strong> (
            {outcome.acceptedPieces} financiers @{" "}
            {outcome.pieceMassG.toFixed(1)} g ·{" "}
            {outcome.evaporatedWaterG.toFixed(1)} g steam loss)
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
            <FinancierBakeScenarioForm
              recipe={recipe}
              notice={notice}
              apply={this.applyScenario.bind(this)}
            />
          </div>
          <div hidden={panel !== "results"}>
            <h4>Plan 61A Financier Dosing &amp; Maruzen MBCO-5E Bake Ledger</h4>
            <dl>
              <dt>Matsunaga 8P cavities filled</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mouldTray.cavitiesFilled} cavities (${sample.mouldTray.depositedG.toFixed(1)} g @ ${recipe.portionG.toFixed(0)} g)`
                }
              />
              <dt>Retained batter in funnel</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.depositor.funnelBatterG.toFixed(1)} g`
                }
              />
              <dt>Maruzen MBCO-5E evaporation</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mouldTray.evaporatedG.toFixed(1)} g (6.0% loss)`
                }
              />
              <dt>Accepted baked output</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.mouldTray.currentMassG.toFixed(1)} g at ${sample.mouldTray.coreTempC.toFixed(1)} °C core`
                }
              />
              {outcome?.kind === "completed" && (
                <>
                  <dt>Tier 2 → Tier 3 cell handoff calibration</dt>
                  <dd data-handoff-preset={outcome.handoffRecovery.preset}>
                    {outcome.handoffRecovery.summary}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </aside>
        <div
          className="factory-workflow-canvas"
          hidden={this.state.surface === "factory"}
        >
          <RecipeWorkflow
            planned={this.playback.planned.bind(this.playback)}
            graph={{ kind: "financier", part: "bake" }}
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
              {status === "blocked" && (
                <button
                  type="button"
                  className="factory-primary"
                  onClick={this.runFaultRecoveryCalibration.bind(this)}
                >
                  Calibrate fault-recovery handoff
                </button>
              )}
              {outcome?.kind === "completed" &&
                this.props.applyToSchedule !== undefined && (
                  <button
                    type="button"
                    className="factory-primary"
                    data-handoff-recovery-preset={
                      outcome.handoffRecovery.preset
                    }
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

const MODE_ITEMS = [
  { value: "convection", label: "170 °C Convection (1450 RPM fan)" },
  { value: "conventional", label: "180 °C Conventional" },
];

const MOULD_COUNT_ITEMS = [
  { value: "1", label: "1 × Matsunaga 8P (8 pcs · 200 g → 188 g)" },
  { value: "2", label: "2 × Matsunaga 8P (16 pcs · 400 g → 376 g)" },
  { value: "3", label: "3 × Matsunaga 8P (24 pcs · 600 g → 564 g)" },
];

const RACK_SLOT_ITEMS = [
  { value: "2", label: "Slot 2 (Z = 269 mm lower-mid rail)" },
  { value: "3", label: "Slot 3 (Z = 357 mm centre rail)" },
  { value: "4", label: "Slot 4 (Z = 445 mm upper-mid rail)" },
];

const CHECK_ITEMS = [
  { value: "none", label: "Normal bake & accepted inspection" },
  {
    value: "carrier-handoff-recovery",
    label:
      "Fault-recovery calibration · 14 mm carrier slip & FR10 cell 1 re-seat",
  },
  {
    value: "cell-2-restage-recovery",
    label:
      "Fault-recovery calibration · 18 mm clamp hold & Cell 1 → Cell 2 failover",
  },
  {
    value: "under-preheated",
    label: "Delayed oven preheat (< 155 °C admission block)",
  },
  {
    value: "over-baked",
    label: "Scorched crust inspection rejection (> 200 °C)",
  },
];

function FinancierBakeScenarioForm(props: {
  readonly recipe: FinancierBakeRecipeConfig;
  readonly notice: string;
  readonly apply: (next: FinancierBakeRecipeConfig) => void;
}): React.ReactNode {
  const [mode, setMode] = React.useState<FinancierBakeMode>(props.recipe.mode);
  const [mouldCount, setMouldCount] = React.useState<FinancierMouldCount>(
    props.recipe.mouldCount,
  );
  const [rackSlot, setRackSlot] = React.useState<FinancierRackSlot>(
    props.recipe.rackSlot,
  );
  const [check, setCheck] = React.useState<FinancierBakeCheck>(
    props.recipe.check,
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({
          ...props.recipe,
          mode,
          mouldCount,
          rackSlot,
          targetOvenTempC: mode === "convection" ? 170 : 180,
          check,
        });
      }}
    >
      <p>
        FAIRINO FR10 Cobot dosing 25 g financier batter portions into Matsunaga
        8P silicone-coated moulds on the Ohaus Ranger 3000 scale and baking on a
        600 × 400 mm carrier in the Maruzen MBCO-5E 5-tray oven.
      </p>
      <label>
        Maruzen MBCO-5E oven mode
        <Select.Root
          items={MODE_ITEMS}
          value={mode}
          onValueChange={(value) => {
            if (value === null) return;
            setMode(value === "conventional" ? "conventional" : "convection");
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{MODE_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Matsunaga 8P mould load
        <Select.Root
          items={MOULD_COUNT_ITEMS}
          value={String(mouldCount)}
          onValueChange={(value) => {
            if (value === null) return;
            const v = Number(value);
            setMouldCount(v === 2 ? 2 : v === 3 ? 3 : 1);
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{MOULD_COUNT_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Maruzen MBCO-5E rack rail slot
        <Select.Root
          items={RACK_SLOT_ITEMS}
          value={String(rackSlot)}
          onValueChange={(value) => {
            if (value === null) return;
            const v = Number(value);
            setRackSlot(v === 2 ? 2 : v === 4 ? 4 : 3);
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{RACK_SLOT_ITEMS.map(renderItem)}</Select.Popup>
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
              v === "carrier-handoff-recovery" ||
                v === "cell-2-restage-recovery" ||
                v === "under-preheated" ||
                v === "over-baked"
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
