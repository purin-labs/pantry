import React from "react";
import {
  ORIGINAL_ANIMATION,
  modelTime,
  runEnd,
  steppedRun,
  warpedStages,
  type AnimationPlan,
  type AnimationPlanBuilder,
} from "../recipe-clock";
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
import { recipeFrames, type RecipeFrames } from "../shared/playback-controller";
import { Live, LiveText } from "../shared/live";
import { deriveLive, LiveValue, type LiveSource } from "../shared/live-value";
import { RecipeChoice, RecipeScenarioForm } from "../shared/recipe-form";
import {
  RecipeStation,
  RecipeStepPills,
  type RecipeStep,
} from "../shared/recipe-station";
import {
  RECIPE_WORKSPACE_VIEW,
  RecipeRunControl,
  RecipeWorkspaceLayout,
  type RecipeWorkspaceView,
} from "../shared/recipe-workspace";
import "../oven-workspace.css";
// The station readout uses the pour-over styles, so this view loads them itself.
import "../pour-over/pour-over.css";

type ViewProps = Readonly<{
  frames: LiveSource<RecipeFrames<CafeShiftSample>>;
}>;

const SHIFT_STEPS: readonly RecipeStep[] = [
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
];

const PHASE_INDEX: Readonly<Record<CafeShiftPhase, number>> = {
  "batter-and-order-1": 0,
  "deposit-and-order-2": 1,
  "bake-and-bar-service": 2,
  "bake-review-and-demould": 3,
  "crumb-check-and-pack": 3,
  completed: 4,
  failed: -1,
};

function CafeShiftPhysicsView(props: ViewProps): React.ReactNode {
  const { frames } = props;
  // The appliance belongs to the scenario: it changes with a new run.
  const sample = frames.get().sample;
  const machineLabel =
    sample.appliance === "linea"
      ? "La Marzocco Linea Classic S"
      : "Victoria Arduino Eagle One";
  const cameras: readonly (readonly [
    CafeShiftCameraPreset,
    React.ReactNode,
  ])[] = [
    ["overview", "Café shift overview"],
    ["bakery", "Financier patisserie line"],
    [
      "espresso-bar",
      <>
        Espresso bar ({sample.appliance === "linea" ? "Linea" : "Eagle One"})
      </>,
    ],
    ["packing", "Cooling rack & gift box"],
  ];
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new CafeShiftScene(element)}
      unavailable="The combined café shift workcell visual is unavailable."
      attributes={(next) => ({
        "data-cafe-shift-phase": next.phase,
        "data-cafe-shift-step": String(next.step),
        "data-cafe-shift-grinder": next.grinder,
      })}
      label="Accepted combined café shift state"
      canvasLabel={`3D combined café shift workspace with Head Baker #1, Hobart HL200 mixer, Maruzen MIH-02C hob, Maruzen MBCO-5E oven, 16-level cooling rack, Ohaus Ranger 3000 scale, gold-ribbon gift box, Lead Barista #2, Hoshizaki IM-35P undercounter ice maker, and ${machineLabel}`}
      camera="overview"
      cameras={cameras}
    >
      <RecipeStepPills
        frames={frames}
        label="Café shift stages"
        steps={() => SHIFT_STEPS}
        index={(next) => PHASE_INDEX[next.phase]}
      />
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
    </RecipeStation>
  );
}

type WorkspaceProps = Readonly<{
  recipe: CafeShiftRecipeConfig;
  close(): void;
  applyToSchedule?(
    outcome: Extract<CafeShiftOutcome, { kind: "completed" }>,
  ): void;
}>;

type CompletedShift = Extract<CafeShiftOutcome, { kind: "completed" }>;

/** The completed runs with this outcome, once for each scenario. */
function withCompletedRun(
  runs: readonly CompletedShift[],
  outcome: CafeShiftOutcome | null,
): readonly CompletedShift[] {
  return outcome !== null &&
    outcome.kind === "completed" &&
    !runs.some(
      (r) =>
        r.appliance === outcome.appliance &&
        r.grinder === outcome.grinder &&
        r.staffing === outcome.staffing &&
        r.financierLoads === outcome.financierLoads &&
        r.espressoOrders === outcome.espressoOrders &&
        r.check === outcome.check,
    )
    ? [...runs, outcome]
    : runs;
}

type WorkspaceState = RecipeWorkspaceView &
  Readonly<{
    config: CafeShiftRecipeConfig;
    status: "ready" | "running" | "paused" | "completed" | "blocked";
    outcome: CafeShiftOutcome | null;
    completedRuns: readonly CompletedShift[];
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
    this.frames = new LiveValue(recipeFrames(this.resetRun()));
    this.state = {
      ...RECIPE_WORKSPACE_VIEW,
      config: this.engine.config,
      status: "ready",
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
    this.frames.set(recipeFrames(this.resetRun()));
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
        completedRuns: withCompletedRun(prev.completedRuns, outcome),
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
    this.frames.set(recipeFrames(latest));
    this.setState((prev) => ({
      status: outcome?.kind === "completed" ? "completed" : "blocked",
      outcome,
      completedRuns: withCompletedRun(prev.completedRuns, outcome),
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
    this.frames.set(recipeFrames(this.resetRun()));
    this.setState({
      status: "ready",
      outcome: null,
    });
  }

  private scrubToTime(targetS: number): void {
    this.stopTimer();
    const sample = this.seekRun(targetS);
    this.frames.set(recipeFrames(sample));
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
    this.frames.set(recipeFrames(this.resetRun()));
    this.setState({
      config: this.engine.config,
      status: "ready",
      outcome: null,
      notice: `Prepared ${this.engine.config.appliance === "linea" ? "Linea Classic S" : "Eagle One"} · ${this.engine.config.financierLoads} load(s) · ${this.engine.config.espressoOrders} espresso orders (${this.engine.config.staffing}).`,
    });
  }

  render(): React.ReactNode {
    const { config, status, outcome, completedRuns, notice } = this.state;
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
      <RecipeWorkspaceLayout
        view={this.state}
        change={(view) => this.setState(view)}
        close={this.props.close}
        status={status}
        clock={clock}
        stages={stages}
        seek={this.scrubToTime.bind(this)}
        animation={this.animation}
        scene={<CafeShiftPhysicsView frames={frames} />}
        kicker="Tier 3 · Plan 61E Combined Café Shift"
        title={
          <>
            Financiers ({config.financierLoads} load
            {config.financierLoads > 1 ? "s" : ""}) &amp; Espresso (
            {config.espressoOrders} orders · {machineTitle})
          </>
        }
        pills={
          <button type="button" onClick={this.completeImmediately.bind(this)}>
            Complete shift
          </button>
        }
        summary={
          outcome?.kind === "completed" ? (
            <>
              <strong>{outcome.servedEspressoG.toFixed(1)} g espresso</strong> ·{" "}
              <strong>{outcome.packedFinanciers} packed financiers</strong> (
              {outcome.packedNetMassG.toFixed(1)} g net ·{" "}
              {outcome.crumbSampleMassG.toFixed(1)} g sample
              {outcome.rejectedFinanciers > 0
                ? ` · ${outcome.rejectedFinanciers} rejected`
                : ""}{" "}
              · {outcome.logicalClockS} s clock)
            </>
          ) : null
        }
        headings={{
          scenario: "Scenario and staffing controls",
          results: "Plan 61E café shift results",
        }}
        scenario={
          <CafeShiftScenarioForm
            recipe={config}
            notice={notice}
            apply={this.applyScenario.bind(this)}
          />
        }
        results={
          <>
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
          </>
        }
        graph={{
          kind: "cafe-shift",
          appliance: config.appliance,
          financierLoads: config.financierLoads,
          espressoOrders: config.espressoOrders,
        }}
        planned={this.planned.bind(this)}
        prepared={status === "ready"}
        outcome={outcome?.kind ?? null}
        footer={{
          horizonS: maxRecordedS,
          control: (
            <RecipeRunControl
              status={status}
              start={this.startOrResume.bind(this)}
              pause={this.pause.bind(this)}
              restart={this.restart.bind(this)}
              pauseLabel="Pause production"
            />
          ),
          actions: outcome?.kind === "completed" &&
            this.props.applyToSchedule !== undefined && (
              <button
                type="button"
                className="factory-primary"
                onClick={() => this.props.applyToSchedule?.(outcome)}
              >
                Apply to Tier 3 schedule
              </button>
            ),
          labels: {
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
          },
        }}
      />
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
    <RecipeScenarioForm
      label="Cafe shift scenario controls"
      notice={props.notice}
      apply={() =>
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
        })
      }
    >
      <p>
        Head Baker #1 operates the Financier patisserie line while Lead Barista
        #2 operates the preheated espresso bar under one shared logical clock.
      </p>
      <RecipeChoice
        label="Espresso machine"
        triggerLabel="Espresso machine"
        items={APPLIANCE_ITEMS}
        value={appliance}
        choose={(value) =>
          setAppliance(value === "eagle-one" ? "eagle-one" : "linea")
        }
      />
      <RecipeChoice
        label="Single-dose grinder"
        triggerLabel="Single-dose grinder"
        items={GRINDER_ITEMS}
        value={grinder}
        choose={(value) =>
          setGrinder(
            value === "option-o-lagom-casa" ||
              value === "timemore-bricks-01s" ||
              value === "fellow-opus-2"
              ? value
              : "miicoffee-df64-gen2",
          )
        }
      />
      <RecipeChoice
        label="Financier loads"
        triggerLabel="Financier loads"
        items={FINANCIER_LOAD_ITEMS}
        value={String(financierLoads)}
        choose={(value) => {
          const v = Number(value);
          setFinancierLoads(v === 3 ? 3 : v === 2 ? 2 : 1);
        }}
      />
      <RecipeChoice
        label="Espresso orders"
        triggerLabel="Espresso orders"
        items={ESPRESSO_ORDERS_ITEMS}
        value={String(espressoOrders)}
        choose={(value) => setEspressoOrders(value === "4" ? 4 : 2)}
      />
      <RecipeChoice
        label="Shift staffing"
        triggerLabel="Shift staffing"
        items={STAFFING_ITEMS}
        value={staffing}
        choose={(value) =>
          setStaffing(
            value === "single-worker" ? "single-worker" : "two-workers",
          )
        }
      />
      <RecipeChoice
        label="Quality & fault journey"
        triggerLabel="Quality and fault journey"
        items={CHECK_ITEMS}
        value={check}
        choose={(value) => {
          const nextCheck: CafeShiftCheck =
            value === "reject-second-load" || value === "interrupted-extraction"
              ? value
              : "none";
          setCheck(nextCheck);
          if (nextCheck === "reject-second-load" && financierLoads < 2) {
            setFinancierLoads(2);
          }
        }}
      />
    </RecipeScenarioForm>
  );
}

function logicalClock({ sample }: RecipeFrames<CafeShiftSample>): string {
  return String(sample.logicalClockS);
}
