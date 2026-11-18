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
  FinancierPackSimulationEngine,
  financierPackTimelineStages,
  type FinancierBoxStyle,
  type FinancierPackCheck,
  type FinancierPackLoadPreset,
  type FinancierPackOutcome,
  type FinancierPackPhase,
  type FinancierPackRecipeConfig,
  type FinancierPackSample,
} from "@seams/production-simulation/recipes/financier-pack/model";
import {
  FinancierPackScene,
  type FinancierPackCameraPreset,
} from "./financier-pack-scene";
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
  frames: LiveSource<RecipeFrames<FinancierPackSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: FinancierPackCameraPreset;
}>;

const PACK_STEPS = [
  {
    id: "demould",
    label: "1 · 8P Demould",
    detail: "Invert & Wash",
  },
  {
    id: "crumb",
    label: "2 · Crumb Check",
    detail: "23.5 g Sample",
  },
  {
    id: "pack",
    label: "3 · Gift Box",
    detail: "Ohaus Net Weigh",
  },
  {
    id: "seal",
    label: "4 · Gold Ribbon",
    detail: "Seal & Release",
  },
] as const;

const PHASE_INDEX: Readonly<Record<FinancierPackPhase, number>> = {
  "cool-demould": 0,
  "crumb-check": 1,
  "pack-giftbox": 2,
  "seal-release": 3,
  completed: 4,
  failed: -1,
};

class FinancierPackPhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "station" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: FinancierPackScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new FinancierPackScene(element);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: FinancierPackScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The Financier pack workcell visual is unavailable.",
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

  private showFrames(frames: RecipeFrames<FinancierPackSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-financier-pack-phase", frames.sample.phase);
      station.setAttribute(
        "data-financier-pack-step",
        String(frames.sample.step),
      );
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private selectCamera(camera: FinancierPackCameraPreset): void {
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
        aria-label="Accepted financier pack station state"
        className="pour-over-station"
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label="3D Financier cooling, demoulding and gift-box packing workcell with FAIRINO FR10 Cobot, 16-level cooling rack, wire cooling grid, Matsunaga 8P mould, porcelain crumb-check plate, and Ohaus Ranger 3000 scale"
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
            aria-pressed={this.state.camera === "demould"}
            onClick={this.selectCamera.bind(this, "demould")}
          >
            Wire grid &amp; 8P demould
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "crumb"}
            onClick={this.selectCamera.bind(this, "crumb")}
          >
            Ohaus &amp; 23.5 g crumb check
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "giftbox"}
            onClick={this.selectCamera.bind(this, "giftbox")}
          >
            Patisserie gift box &amp; ribbon
          </button>
        </div>
        <div className="pour-over-status">
          <Live source={frames} select={(f) => f.sample.phase}>
            {(phase) => (
              <div
                className="pour-over-steps"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
                aria-label="Financier pack cycle progress"
              >
                {PACK_STEPS.map((item, idx) => {
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
                  data-financier-pack-stage={phase}
                  source={frames}
                  text={({ sample }) => `${sample.stage}`}
                />
              )}
            </Live>
            <dt>10-min crumb check</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${
                  sample.crumbCheck.sampleCutOpen
                    ? `${sample.crumbCheck.sampleMassG.toFixed(1)} g halved — honeycombed beurre noisette crumb verified`
                    : sample.crumbCheck.sampled
                      ? `${sample.crumbCheck.sampleMassG.toFixed(1)} g weighed on Ohaus`
                      : "Pending 23.5 g sample"
                }`
              }
            />
            <dt>Patisserie gift box</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.giftBox.packedCount} / ${sample.giftBox.targetCapacity} financiers (${sample.giftBox.packedNetG.toFixed(1)} g net) · ${
                  sample.giftBox.released
                    ? "Gold ribbon sealed & released"
                    : sample.giftBox.lidClosedProgress > 0
                      ? "Seating lid & ribbon"
                      : "Open fluted ballotin"
                }`
              }
            />
            <dt>Ohaus scale</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.scale.displayedG.toFixed(1)} g (${
                  sample.scale.itemOnScale === "gift-box"
                    ? "tared gift box net"
                    : sample.scale.itemOnScale === "crumb-sample"
                      ? "piece check"
                      : "tared · 0.0 g"
                })`
              }
            />
            <dt>Matsunaga 8P mould</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${
                  sample.coolingGrid.mouldInWashTray
                    ? "Released in manual-care wash basin"
                    : sample.coolingGrid.mouldDemoulded
                      ? "Inverted (financiers demoulded)"
                      : "In-mould cooling on wire grid"
                } · core ${sample.coolingGrid.coreTempC.toFixed(1)} °C`
              }
            />
          </dl>
        </div>
        {this.state.error !== null && <p role="alert">{this.state.error}</p>}
      </section>
    );
  }
}

type WorkspaceProps = Readonly<{
  recipe: FinancierPackRecipeConfig;
  close(): void;
  applyToSchedule?: (
    outcome: Extract<FinancierPackOutcome, { kind: "completed" }>,
  ) => void;
}>;

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  recipe: FinancierPackRecipeConfig;
  panel: "scenario" | "results" | null;
  timeline: boolean;
}> &
  RecipeRunState;

export class FinancierPackWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private readonly playback: RecipePlayback<
    ReturnType<FinancierPackSimulationEngine["initialSample"]>,
    ConstructorParameters<typeof FinancierPackSimulationEngine>[0]
  >;

  constructor(props: WorkspaceProps) {
    super(props);
    this.playback = new RecipePlayback(
      this,
      {
        recipe: () => this.state.recipe,
        model: (recipe) => new FinancierPackSimulationEngine(recipe),
        stages: () => financierPackTimelineStages(),
        outcomeNotice: (outcome) =>
          outcome.kind === "failed"
            ? outcome.reason
            : "Financiers demoulded, crumb-checked, and sealed in gold-ribbon patisserie gift box.",
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

  private applyScenario(next: FinancierPackRecipeConfig): void {
    this.playback.applyScenario(next);
    this.setState({
      recipe: next,
      status: "review",
      panel: null,
      notice: "Updated Financier pack scenario applied.",
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
      financierPackTimelineStages(),
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
          <FinancierPackPhysicsView frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Factory simulation</span>
              <h2>Financier Pack · Wire-Grid Demoulding &amp; Gift Box</h2>
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
            <strong>{outcome.packedNetMassG.toFixed(1)} g</strong> (
            {outcome.packedPieces} packed @ {outcome.pieceMassG.toFixed(1)} g ·{" "}
            {outcome.crumbSampleG.toFixed(1)} g crumb sample)
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
            <FinancierPackScenarioForm
              recipe={recipe}
              notice={notice}
              apply={this.applyScenario.bind(this)}
            />
          </div>
          <div hidden={panel !== "results"}>
            <h4>
              Plan 61A Financier Demoulding, Crumb Check &amp; Pack Ledger
            </h4>
            <dl>
              <dt>Demoulded onto wire grid</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    sample.giftBox.targetCapacity +
                    (sample.crumbCheck.sampled ? 1 : 0)
                  } financiers @ 23.5 g`
                }
              />
              <dt>10-minute crumb check sample</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.crumbCheck.sampleMassG.toFixed(1)} g (1 piece)`
                }
              />
              <dt>Packed patisserie gift box</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.giftBox.packedCount} pieces (${sample.giftBox.packedNetG.toFixed(1)} g net)`
                }
              />
              <dt>Matsunaga 8P mould disposition</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${
                    sample.coolingGrid.mouldInWashTray
                      ? "Staged in manual-care wash basin"
                      : "In active use"
                  }`
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
            graph={{ kind: "financier", part: "pack" }}
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

const LOAD_PRESET_ITEMS = [
  {
    value: "two-accepted-16",
    label: "Plan 61A campaign (16 accepted · 376.0 g → 15 packed · 352.5 g)",
  },
  {
    value: "single-load-8",
    label:
      "Single Matsunaga 8P load (8 accepted · 188.0 g → 7 packed · 164.5 g)",
  },
];

const CRUMB_SAMPLE_PIECES_ITEMS = [
  { value: "1", label: "1 × 23.5 g honeycombed crumb sample" },
  { value: "0", label: "0 samples (pack all accepted pieces)" },
];

const CHECK_ITEMS = [
  { value: "none", label: "Normal demould & gift-box release" },
  {
    value: "warm-demould",
    label: "Warm demoulding (> 55 °C tears bosse crown)",
  },
  {
    value: "underweight-box",
    label: "Ohaus net check-weight shortfall (−23.5 g)",
  },
];

function FinancierPackScenarioForm(props: {
  readonly recipe: FinancierPackRecipeConfig;
  readonly notice: string;
  readonly apply: (next: FinancierPackRecipeConfig) => void;
}): React.ReactNode {
  const [loadPreset, setLoadPreset] = React.useState<FinancierPackLoadPreset>(
    props.recipe.loadPreset,
  );
  const [boxStyle, setBoxStyle] = React.useState<FinancierBoxStyle>(
    props.recipe.boxStyle,
  );
  const [crumbSamplePieces, setCrumbSamplePieces] = React.useState<0 | 1>(
    props.recipe.crumbSamplePieces,
  );
  const [check, setCheck] = React.useState<FinancierPackCheck>(
    props.recipe.check,
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({
          ...props.recipe,
          loadPreset,
          boxStyle,
          crumbSamplePieces,
          check,
        });
      }}
    >
      <p>
        FAIRINO FR10 Cobot inverting the Matsunaga 8P silicone-coated mould onto
        the wire cooling grid, sampling 1 × 23.5 g piece for the 10-minute crumb
        check, and packing the accepted golden financiers into a gold-ribbon
        patisserie gift box on the Ohaus Ranger 3000 scale.
      </p>
      <label>
        Accepted baked load
        <Select.Root
          items={LOAD_PRESET_ITEMS}
          value={loadPreset}
          onValueChange={(value) => {
            if (value === null) return;
            const next =
              value === "single-load-8" ? "single-load-8" : "two-accepted-16";
            setLoadPreset(next);
            setBoxStyle(
              next === "two-accepted-16" ? "atelier-15" : "patisserie-8",
            );
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{LOAD_PRESET_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Crumb check sample
        <Select.Root
          items={CRUMB_SAMPLE_PIECES_ITEMS}
          value={String(crumbSamplePieces)}
          onValueChange={(value) => {
            if (value === null) return;
            setCrumbSamplePieces(value === "0" ? 0 : 1);
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {CRUMB_SAMPLE_PIECES_ITEMS.map(renderItem)}
          </Select.Popup>
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
              v === "warm-demould" || v === "underweight-box" ? v : "none",
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
