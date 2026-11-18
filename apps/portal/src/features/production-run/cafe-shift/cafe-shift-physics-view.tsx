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
import {
  ORIGINAL_ANIMATION,
  modelTime,
  runEnd,
  steppedRun,
  warpedStages,
  type AnimationPlan,
  type AnimationPlanBuilder,
} from "../recipe-clock";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import {
  CafeShiftSimulationEngine,
  cafeShiftGrinderLabel,
  cafeShiftTimelineStages,
  type CafeShiftAppliance,
  type CafeShiftCheck,
  type CafeShiftGrinder,
  type CafeShiftOutcome,
  type CafeShiftPhase,
  type CafeShiftRecipeConfig,
  type CafeShiftSample,
  type CafeShiftStaffing,
} from "@seams/production-simulation/recipes/cafe-shift/model";
import { CafeShiftScene, type CafeShiftCameraPreset } from "./cafe-shift-scene";
import type { RecipeFrames } from "../shared/playback-controller";
import { Live, LiveText } from "../shared/live";
import { deriveLive, LiveValue, type LiveSource } from "../shared/live-value";
import { RecipeRunFooter } from "../recipe-run-footer";
import "../oven-workspace.css";
// The station readout uses the pour-over styles, so this view loads them itself.
import "../pour-over/pour-over.css";

type ViewProps = Readonly<{
  frames: LiveSource<RecipeFrames<CafeShiftSample>>;
}>;

type ViewState = Readonly<{
  error: string | null;
  camera: CafeShiftCameraPreset;
}>;

const SHIFT_STEPS = [
  {
    id: "batter-and-order-1",
    label: "1 · Batter",
    detail: "Mix & Shot 1",
  },
  {
    id: "deposit-and-order-2",
    label: "2 · 8P Dose",
    detail: "Mould & Shot 2",
  },
  {
    id: "bake-and-bar-service",
    label: "3 · 170 °C Bake",
    detail: "Oven & Bar",
  },
  {
    id: "crumb-check-and-pack",
    label: "4 · Demould & Pack",
    detail: "Sample & Seal",
  },
] as const;

const PHASE_INDEX: Readonly<Record<CafeShiftPhase, number>> = {
  "batter-and-order-1": 0,
  "deposit-and-order-2": 1,
  "bake-and-bar-service": 2,
  "bake-review-and-demould": 3,
  "crumb-check-and-pack": 3,
  completed: 4,
  failed: -1,
};

class CafeShiftPhysicsView extends React.Component<ViewProps, ViewState> {
  state: ViewState = { error: null, camera: "overview" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: CafeShiftScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new CafeShiftScene(element);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: CafeShiftScene): Promise<void> {
    try {
      await visual.load();
    } catch (error) {
      if (this.visual === visual)
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The combined café shift workcell visual is unavailable.",
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

  private showFrames(frames: RecipeFrames<CafeShiftSample>): void {
    const station = this.station.current;
    if (station !== null) {
      station.setAttribute("data-cafe-shift-phase", frames.sample.phase);
      station.setAttribute("data-cafe-shift-step", String(frames.sample.step));
      station.setAttribute("data-cafe-shift-grinder", frames.sample.grinder);
    }
    if (frames.samples.length > 1) this.visual?.setSamples(frames.samples);
    else this.visual?.setFrame(frames.sample);
  }

  private selectCamera(camera: CafeShiftCameraPreset): void {
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
    // The appliance belongs to the scenario: it changes with a new run.
    const sample = frames.get().sample;
    const machineLabel =
      sample.appliance === "linea"
        ? "La Marzocco Linea Classic S"
        : "Victoria Arduino Eagle One";

    return (
      <section
        aria-label="Accepted combined café shift state"
        className="pour-over-station"
        ref={this.station}
      >
        <div
          ref={this.element}
          className="pour-over-canvas"
          role="img"
          aria-label={`3D combined café shift workspace with Head Baker #1, Hobart HL200 mixer, Maruzen MIH-02C hob, Maruzen MBCO-5E oven, 16-level cooling rack, Ohaus Ranger 3000 scale, gold-ribbon gift box, Lead Barista #2, Hoshizaki IM-35P undercounter ice maker, and ${machineLabel}`}
        />
        <div className="pour-over-camera-bar" role="group" aria-label="Camera">
          <BakeryAppearanceControl />
          <button
            type="button"
            aria-pressed={this.state.camera === "overview"}
            onClick={this.selectCamera.bind(this, "overview")}
          >
            Café shift overview
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "bakery"}
            onClick={this.selectCamera.bind(this, "bakery")}
          >
            Financier patisserie line
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "espresso-bar"}
            onClick={this.selectCamera.bind(this, "espresso-bar")}
          >
            Espresso bar ({sample.appliance === "linea" ? "Linea" : "Eagle One"}
            )
          </button>
          <button
            type="button"
            aria-pressed={this.state.camera === "packing"}
            onClick={this.selectCamera.bind(this, "packing")}
          >
            Cooling rack &amp; gift box
          </button>
        </div>
        <div className="pour-over-status">
          <Live source={frames} select={(f) => f.sample.phase}>
            {(phase) => (
              <div
                className="pour-over-steps"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
                aria-label="Café shift stages"
              >
                {SHIFT_STEPS.map((st, idx) => {
                  const currentIdx = PHASE_INDEX[phase];
                  const state =
                    phase === "completed" || currentIdx > idx
                      ? "done"
                      : currentIdx === idx
                        ? "active"
                        : "pending";
                  return (
                    <div
                      key={st.id}
                      className="pour-over-step-pill"
                      data-step-state={state}
                    >
                      <span>{st.label}</span>
                      <strong>{st.detail}</strong>
                    </div>
                  );
                })}
              </div>
            )}
          </Live>
          <dl>
            <dt>Patisserie baker</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) => `${sample.bakerStatus}`}
            />
            <dt>Espresso barista</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) => `${sample.baristaStatus}`}
            />
            <dt>Espresso bar</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.servedEspressoG.toFixed(1)} g (${sample.servedOrders}/${sample.espressoOrders} cups) · ${sample.coffeeBoilerC.toFixed(0)} °C · ${sample.brewPressureBar.toFixed(1)} bar · ${cafeShiftGrinderLabel(sample.grinder)} (${sample.grinderRpm} RPM) · IM-35P ${sample.iceBinStockKg.toFixed(2)} kg ice (${sample.iceMakerPowerW} W)`
              }
            />
            <dt>Financiers</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.packedFinanciers} packed (${sample.packedNetMassG.toFixed(1)} g) · ${sample.crumbSamplePieces} sample${
                  sample.rejectedFinanciers > 0
                    ? ` · ${sample.rejectedFinanciers} rejected`
                    : ""
                } · ${sample.retainedBatterG.toFixed(0)} g batter`
              }
            />
            <dt>Shift clock</dt>
            <LiveText
              as="dd"
              source={frames}
              text={({ sample }) =>
                `${sample.logicalClockS} s · ${
                  sample.staffing === "two-workers"
                    ? "2 Workers (0 s wait)"
                    : `1 worker (${sample.workerContentionWaitS} s wait)`
                }`
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
  recipe: CafeShiftRecipeConfig;
  close(): void;
  applyToSchedule?(
    outcome: Extract<CafeShiftOutcome, { kind: "completed" }>,
  ): void;
}>;

type WorkspaceState = Readonly<{
  surface: RecipeSurface;
  config: CafeShiftRecipeConfig;
  status: "ready" | "running" | "paused" | "completed" | "blocked";
  panel: "scenario" | "results" | null;
  timeline: boolean;
  outcome: CafeShiftOutcome | null;
  completedRuns: readonly Extract<CafeShiftOutcome, { kind: "completed" }>[];
  notice: string;
}>;

export class CafeShiftWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  private engine: CafeShiftSimulationEngine;
  private animation: AnimationPlan = ORIGINAL_ANIMATION;
  /** The run's clock while the animation follows a draft. */
  private runS = 0;
  private timer: number | null = null;
  /** The frames of the run. They live outside React state. */
  private readonly frames: LiveValue<RecipeFrames<CafeShiftSample>>;

  constructor(props: WorkspaceProps) {
    super(props);
    this.engine = new CafeShiftSimulationEngine(props.recipe);
    this.frames = new LiveValue(cafeFrames(this.resetRun()));
    this.state = {
      config: this.engine.config,
      status: "ready",
      surface: "factory",
      panel: null,
      timeline: false,
      outcome: null,
      completedRuns: [],
      notice: "",
    };
  }

  componentWillUnmount(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private togglePanel(target: "scenario" | "results"): void {
    this.setState((s) => ({
      panel: s.panel === target ? null : target,
    }));
  }

  private toggleTimeline(): void {
    this.setState((s) => ({ timeline: !s.timeline }));
  }

  private startOrResume(): void {
    if (this.state.status === "running") return;
    this.setState({ status: "running", notice: "" });
    this.timer = window.setInterval(() => {
      this.advance(4);
    }, 50);
  }

  private pause(): void {
    this.stopTimer();
    this.setState({ status: "paused" });
  }

  private restart(): void {
    this.stopTimer();
    this.frames.set(cafeFrames(this.resetRun()));
    this.setState({
      status: "running",
      outcome: null,
      notice: "",
    });
    this.timer = window.setInterval(() => {
      this.advance(4);
    }, 50);
  }

  private advance(steps: number): void {
    const batch: CafeShiftSample[] = [];
    let latest = this.frames.get().sample;
    for (let i = 0; i < steps; i++) {
      latest = this.stepRun();
      batch.push(latest);
      if (this.engine.outcome !== null) break;
    }
    this.frames.set({ sample: latest, samples: batch, history: [latest] });
    const outcome = this.engine.outcome;
    if (outcome !== null) {
      this.stopTimer();
      this.setState((prev) => ({
        status: outcome.kind === "completed" ? "completed" : "blocked",
        outcome,
        completedRuns:
          outcome.kind === "completed" &&
          !prev.completedRuns.some(
            (r) =>
              r.appliance === outcome.appliance &&
              r.grinder === outcome.grinder &&
              r.staffing === outcome.staffing &&
              r.financierLoads === outcome.financierLoads &&
              r.espressoOrders === outcome.espressoOrders &&
              r.check === outcome.check,
          )
            ? [...prev.completedRuns, outcome]
            : prev.completedRuns,
      }));
    }
  }

  private completeImmediately(): void {
    this.stopTimer();
    let latest = this.frames.get().sample;
    if (this.engine.outcome !== null) {
      latest = this.resetRun();
    }
    let guard = 0;
    while (this.engine.outcome === null && guard < 3000) {
      latest = this.stepRun();
      guard += 1;
    }
    const outcome = this.engine.outcome;
    this.frames.set(cafeFrames(latest));
    this.setState((prev) => ({
      status: outcome?.kind === "completed" ? "completed" : "blocked",
      outcome,
      completedRuns:
        outcome !== null &&
        outcome.kind === "completed" &&
        !prev.completedRuns.some(
          (r) =>
            r.appliance === outcome.appliance &&
            r.grinder === outcome.grinder &&
            r.staffing === outcome.staffing &&
            r.financierLoads === outcome.financierLoads &&
            r.espressoOrders === outcome.espressoOrders &&
            r.check === outcome.check,
        )
          ? [...prev.completedRuns, outcome]
          : prev.completedRuns,
    }));
  }

  private resetRun(): CafeShiftSample {
    this.runS = 0;
    return this.engine.reset();
  }

  private stepRun(): CafeShiftSample {
    if (this.animation.kind !== "warped") return this.engine.step(0.05);
    return this.seekRun(
      steppedRun(
        this.runS,
        0.05,
        runEnd(this.animation, this.engine.totalDurationS),
      ),
    );
  }

  private seekRun(targetS: number): CafeShiftSample {
    if (this.animation.kind !== "warped") return this.engine.seek(targetS);
    this.runS = targetS;
    return {
      ...this.engine.seek(modelTime(this.animation, targetS)),
      timeSeconds: targetS,
    };
  }

  /** A draft ran: the next start plays it, as far as this animation can. */
  private planned(build: AnimationPlanBuilder): void {
    this.stopTimer();
    this.animation = build(cafeShiftTimelineStages(this.engine.config));
    this.frames.set(cafeFrames(this.resetRun()));
    this.setState({
      status: "ready",
      outcome: null,
    });
  }

  private scrubToTime(targetS: number): void {
    this.stopTimer();
    const sample = this.seekRun(targetS);
    this.frames.set(cafeFrames(sample));
    const outcome = this.engine.outcome;
    this.setState({
      status:
        outcome !== null
          ? outcome.kind === "completed"
            ? "completed"
            : "blocked"
          : targetS > 0
            ? "paused"
            : "ready",
      outcome,
    });
  }

  private applyScenario(next: CafeShiftRecipeConfig): void {
    this.stopTimer();
    this.animation = ORIGINAL_ANIMATION;
    this.engine = new CafeShiftSimulationEngine(next);
    this.frames.set(cafeFrames(this.resetRun()));
    this.setState({
      config: this.engine.config,
      status: "ready",
      outcome: null,
      notice: `Prepared ${this.engine.config.appliance === "linea" ? "Linea Classic S" : "Eagle One"} · ${this.engine.config.financierLoads} load(s) · ${this.engine.config.espressoOrders} espresso orders (${this.engine.config.staffing}).`,
    });
  }

  private primaryControl(): React.ReactNode {
    const { status } = this.state;
    if (status === "running") {
      return (
        <button className="factory-primary" onClick={this.pause.bind(this)}>
          <RunIcon action="pause" />
          Pause production
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
    const { config, status, panel, timeline, outcome, completedRuns, notice } =
      this.state;
    const { frames } = this;
    const stages = warpedStages(
      cafeShiftTimelineStages(config),
      this.animation,
    );
    const maxRecordedS = runEnd(this.animation, this.engine.totalDurationS);
    const clock = deriveLive(frames, (f) => ({
      timeS: f.sample.timeSeconds,
      reachedS: maxRecordedS,
    }));
    const machineTitle =
      config.appliance === "linea"
        ? "Linea Classic S"
        : "Victoria Arduino Eagle One";

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
          <CafeShiftPhysicsView frames={frames} />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>Tier 3 · Plan 61E Combined Café Shift</span>
              <h2>
                Financiers ({config.financierLoads} load
                {config.financierLoads > 1 ? "s" : ""}) &amp; Espresso (
                {config.espressoOrders} orders · {machineTitle})
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
              <button
                type="button"
                onClick={this.completeImmediately.bind(this)}
              >
                Complete shift
              </button>
            </div>
          </nav>
        </header>

        {outcome?.kind === "completed" && (
          <button
            className="factory-summary"
            onClick={this.togglePanel.bind(this, "results")}
          >
            <strong>{outcome.servedEspressoG.toFixed(1)} g espresso</strong> ·{" "}
            <strong>{outcome.packedFinanciers} packed financiers</strong> (
            {outcome.packedNetMassG.toFixed(1)} g net ·{" "}
            {outcome.crumbSampleMassG.toFixed(1)} g sample
            {outcome.rejectedFinanciers > 0
              ? ` · ${outcome.rejectedFinanciers} rejected`
              : ""}{" "}
            · {outcome.logicalClockS} s clock)
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
                ? "Plan 61E café shift results"
                : "Scenario and staffing controls"}
            </h3>
            <button
              type="button"
              onClick={() => this.setState({ panel: null })}
            >
              Close details
            </button>
          </div>
          <div hidden={panel !== "scenario"}>
            <CafeShiftScenarioForm
              recipe={config}
              notice={notice}
              apply={this.applyScenario.bind(this)}
            />
          </div>
          <div hidden={panel !== "results"}>
            <h4>Plan 61E Combined Café Shift Ledger</h4>
            <dl>
              <dt>Served espresso</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.servedEspressoG.toFixed(1)} g (${sample.servedOrders}/${sample.espressoOrders} orders on ${machineTitle})`
                }
              />
              <dt>Single-dose grinder</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${cafeShiftGrinderLabel(sample.grinder)} (${sample.groundDoseG.toFixed(1)} g ground)`
                }
              />
              <dt>Undercounter ice maker</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `Hoshizaki IM-35P (${sample.iceBinStockKg.toFixed(2)} kg stock · ${sample.iceMakerMode} · ${sample.iceMakerPowerW} W)`
                }
              />
              <Live
                source={frames}
                select={(f) => f.sample.discardedEspressoG > 0}
              >
                {(discarded) =>
                  discarded && (
                    <>
                      <dt>Interrupted extraction waste</dt>
                      <LiveText
                        as="dd"
                        source={frames}
                        text={({ sample }) =>
                          `${sample.discardedEspressoG.toFixed(1)} g discarded`
                        }
                      />
                    </>
                  )
                }
              </Live>
              <dt>Packed financiers</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.packedFinanciers} pieces (${sample.packedNetMassG.toFixed(1)} g net in gold-ribbon ballotin)`
                }
              />
              <dt>Crumb check sample</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.crumbSamplePieces} piece (${sample.crumbSampleMassG.toFixed(1)} g on Ohaus Ranger 3000)`
                }
              />
              <dt>Rejected financiers</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.rejectedFinanciers} pieces (${sample.rejectedMassG.toFixed(1)} g disposed)`
                }
              />
              <dt>Retained batter inventory</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.retainedBatterG.toFixed(1)} g of 726.0 g batch`
                }
              />
              <dt>Logical shift clock &amp; contention</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ sample }) =>
                  `${sample.logicalClockS} s (${sample.workerContentionWaitS} s worker contention wait)`
                }
              />
            </dl>
            {completedRuns.length > 0 && (
              <section aria-label="Completed shift comparison">
                <h4>Completed shift runs ({completedRuns.length})</h4>
                <ul>
                  {completedRuns.map((r, i) => (
                    <li key={i}>
                      {r.appliance === "linea" ? "Linea" : "Eagle One"} ·{" "}
                      {cafeShiftGrinderLabel(r.grinder)} · {r.financierLoads}L/
                      {r.espressoOrders}E ·{" "}
                      {r.staffing === "two-workers" ? "2 Workers" : "1 Worker"}:{" "}
                      {r.servedEspressoG.toFixed(1)} g espresso,{" "}
                      {r.packedFinanciers} packed, {r.rejectedFinanciers}{" "}
                      rejected ({r.logicalClockS} s)
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </aside>

        <div
          className="factory-workflow-canvas"
          hidden={this.state.surface === "factory"}
        >
          <RecipeWorkflow
            planned={this.planned.bind(this)}
            graph={{
              kind: "cafe-shift",
              appliance: config.appliance,
              financierLoads: config.financierLoads,
              espressoOrders: config.espressoOrders,
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
          horizonS={maxRecordedS}
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
          labels={{
            title: "Café shift timeline",
            scaleDigits: 1,
            header: (
              <>
                Logical clock: <LiveText source={frames} text={logicalClock} />{" "}
                s
              </>
            ),
            clockNote: (
              <>
                {" "}
                (<LiveText source={frames} text={logicalClock} /> s shift clock)
              </>
            ),
            span: (stage) =>
              `${stage.startS.toFixed(0)}–${stage.endS.toFixed(0)} s`,
            minSpanPct: 1.5,
          }}
          timeline={timeline}
          toggleTimeline={this.toggleTimeline.bind(this)}
          seek={this.scrubToTime.bind(this)}
        />
      </section>
    );
  }
}

const APPLIANCE_ITEMS = [
  { value: "linea", label: "La Marzocco Linea Classic S" },
  { value: "eagle-one", label: "Victoria Arduino Eagle One" },
];

const GRINDER_ITEMS = [
  {
    value: "miicoffee-df64-gen2",
    label: "MiiCoffee DF64 II (Gen 2 · 64 mm flat)",
  },
  { value: "option-o-lagom-casa", label: "Option-O Lagom Casa" },
  { value: "timemore-bricks-01s", label: "Timemore Bricks 01S" },
  { value: "fellow-opus-2", label: "Fellow Opus 2" },
];

const FINANCIER_LOAD_ITEMS = [
  { value: "1", label: "1 load · 8 cavities (7 packed + 1 sample)" },
  { value: "2", label: "2 loads · 16 cavities (15 packed + 1 sample)" },
  { value: "3", label: "3 loads · 24 cavities (23 packed + 1 sample)" },
];

const ESPRESSO_ORDERS_ITEMS = [
  { value: "2", label: "2 orders (72.0 g served espresso)" },
  { value: "4", label: "4 orders (144.0 g served espresso)" },
];

const STAFFING_ITEMS = [
  { value: "two-workers", label: "Two workers · Baker #1 + Barista #2" },
  { value: "single-worker", label: "Single shared worker (contention wait)" },
];

const CHECK_ITEMS = [
  { value: "none", label: "Uninterrupted shift · accept all loads" },
  {
    value: "reject-second-load",
    label: "Reject second load (7 packed · 8 rejected · 72.0 g espresso)",
  },
  {
    value: "interrupted-extraction",
    label: "Interrupted extraction on Order 2 (18.0 g discarded & recovered)",
  },
];

function CafeShiftScenarioForm(props: {
  readonly recipe: CafeShiftRecipeConfig;
  readonly notice: string;
  readonly apply: (next: CafeShiftRecipeConfig) => void;
}): React.ReactNode {
  const [appliance, setAppliance] = React.useState<CafeShiftAppliance>(
    props.recipe.appliance,
  );
  const [grinder, setGrinder] = React.useState<CafeShiftGrinder>(
    props.recipe.grinder ?? "miicoffee-df64-gen2",
  );
  const [financierLoads, setFinancierLoads] = React.useState<1 | 2 | 3>(
    props.recipe.financierLoads,
  );
  const [espressoOrders, setEspressoOrders] = React.useState<2 | 4>(
    props.recipe.espressoOrders,
  );
  const [staffing, setStaffing] = React.useState<CafeShiftStaffing>(
    props.recipe.staffing,
  );
  const [check, setCheck] = React.useState<CafeShiftCheck>(props.recipe.check);

  React.useEffect(() => {
    setAppliance(props.recipe.appliance);
    setGrinder(props.recipe.grinder ?? "miicoffee-df64-gen2");
    setFinancierLoads(props.recipe.financierLoads);
    setEspressoOrders(props.recipe.espressoOrders);
    setStaffing(props.recipe.staffing);
    setCheck(props.recipe.check);
  }, [props.recipe]);

  return (
    <form
      aria-label="Cafe shift scenario controls"
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({
          appliance,
          grinder,
          financierLoads:
            check === "reject-second-load" && financierLoads < 2
              ? 2
              : financierLoads,
          espressoOrders,
          staffing,
          check,
        });
      }}
    >
      <p>
        Head Baker #1 operates the Financier patisserie line while Lead Barista
        #2 operates the preheated espresso bar under one shared logical clock.
      </p>
      <label>
        Espresso machine
        <Select.Root
          items={APPLIANCE_ITEMS}
          value={appliance}
          onValueChange={(value) => {
            if (value === null) return;
            setAppliance(value === "eagle-one" ? "eagle-one" : "linea");
          }}
        >
          <Select.Trigger aria-label="Espresso machine">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{APPLIANCE_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Single-dose grinder
        <Select.Root
          items={GRINDER_ITEMS}
          value={grinder}
          onValueChange={(v) => {
            if (v === null) return;
            setGrinder(
              v === "option-o-lagom-casa" ||
                v === "timemore-bricks-01s" ||
                v === "fellow-opus-2"
                ? v
                : "miicoffee-df64-gen2",
            );
          }}
        >
          <Select.Trigger aria-label="Single-dose grinder">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{GRINDER_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Financier loads
        <Select.Root
          items={FINANCIER_LOAD_ITEMS}
          value={String(financierLoads)}
          onValueChange={(value) => {
            if (value === null) return;
            const v = Number(value);
            setFinancierLoads(v === 3 ? 3 : v === 2 ? 2 : 1);
          }}
        >
          <Select.Trigger aria-label="Financier loads">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{FINANCIER_LOAD_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Espresso orders
        <Select.Root
          items={ESPRESSO_ORDERS_ITEMS}
          value={String(espressoOrders)}
          onValueChange={(value) => {
            if (value === null) return;
            setEspressoOrders(value === "4" ? 4 : 2);
          }}
        >
          <Select.Trigger aria-label="Espresso orders">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{ESPRESSO_ORDERS_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Shift staffing
        <Select.Root
          items={STAFFING_ITEMS}
          value={staffing}
          onValueChange={(value) => {
            if (value === null) return;
            setStaffing(
              value === "single-worker" ? "single-worker" : "two-workers",
            );
          }}
        >
          <Select.Trigger aria-label="Shift staffing">
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{STAFFING_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Quality &amp; fault journey
        <Select.Root
          items={CHECK_ITEMS}
          value={check}
          onValueChange={(v) => {
            if (v === null) return;
            const nextCheck: CafeShiftCheck =
              v === "reject-second-load" || v === "interrupted-extraction"
                ? v
                : "none";
            setCheck(nextCheck);
            if (nextCheck === "reject-second-load" && financierLoads < 2) {
              setFinancierLoads(2);
            }
          }}
        >
          <Select.Trigger aria-label="Quality and fault journey">
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

function cafeFrames(sample: CafeShiftSample): RecipeFrames<CafeShiftSample> {
  return { sample, samples: [sample], history: [sample] };
}

function logicalClock({ sample }: RecipeFrames<CafeShiftSample>): string {
  return String(sample.logicalClockS);
}
