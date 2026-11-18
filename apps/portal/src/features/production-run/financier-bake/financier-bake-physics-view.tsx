import React from "react";
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
import type { RecipeFrames } from "../shared/playback-controller";
import { LiveText } from "../shared/live";
import type { LiveSource } from "../shared/live-value";
import { RecipeChoice, RecipeScenarioForm } from "../shared/recipe-form";
import {
  RecipeStageReadout,
  RecipeStation,
  RecipeStepPills,
  type RecipeStep,
} from "../shared/recipe-station";
import {
  RecipePlaybackWorkspace,
  type RecipeContent,
  type RecipeRun,
  type RecipeRunView,
} from "../shared/recipe-workspace";

const BAKE_STEPS: readonly RecipeStep[] = [
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
];

const PHASE_INDEX: Readonly<Record<FinancierBakePhase, number>> = {
  "deposit-moulds": 0,
  "load-oven": 1,
  "convection-bake": 2,
  "unload-cool": 3,
  completed: 4,
  failed: -1,
};

const CAMERAS: readonly (readonly [FinancierBakeCameraPreset, string])[] = [
  ["station", "Station view"],
  ["depositor", "Ohaus & 8P mould dosing"],
  ["oven", "Maruzen MBCO-5E chamber"],
  ["cooling", "In-mould wire grid"],
];

function FinancierBakePhysicsView(
  props: Readonly<{ frames: LiveSource<RecipeFrames<FinancierBakeSample>> }>,
): React.ReactNode {
  const { frames } = props;
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new FinancierBakeScene(element)}
      unavailable="The Financier bake workcell visual is unavailable."
      attributes={(sample) => ({
        "data-financier-bake-phase": sample.phase,
        "data-financier-bake-step": String(sample.step),
      })}
      showOnEachUpdate
      label="Accepted financier bake station state"
      canvasLabel="3D Financier bake workcell with FAIRINO FR10 Cobot, Ohaus Ranger 3000 scale, Matsunaga 8-cavity silicone-coated financier mould, 600 by 400 mm carrier tray, and Maruzen MBCO-5E 5-tray convection oven"
      camera="station"
      cameras={CAMERAS}
    >
      <RecipeStepPills
        frames={frames}
        label="Financier bake cycle progress"
        steps={() => BAKE_STEPS}
        index={(sample) => PHASE_INDEX[sample.phase]}
      />
      <dl className="pour-over-kpi-strip">
        <RecipeStageReadout
          frames={frames}
          attribute="data-financier-bake-stage"
        />
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
    </RecipeStation>
  );
}

function ovenModeLabel(sample: FinancierBakeSample): string {
  return sample.oven.mode === "convection"
    ? `Convection (${sample.oven.fanRpm} RPM fan)`
    : "Conventional (0 RPM fan)";
}

const FINANCIER_BAKE_RUN: RecipeRun<
  FinancierBakeSample,
  FinancierBakeRecipeConfig
> = {
  model: (recipe) => new FinancierBakeSimulationEngine(recipe),
  stages: () => financierBakeTimelineStages(),
  outcomeNotice: (outcome) =>
    outcome.kind === "failed"
      ? outcome.reason
      : "Financiers baked, inspected, and staged on wire grid for 2–3 min in-mould cooling.",
  resetNotice: "Workcell reset to t = 0.00 s.",
  notice: "Workcell prepared at t = 0.00 s. Press Start production to run.",
  endS: 60,
};

type CompletedBake = Extract<FinancierBakeOutcome, { kind: "completed" }>;

export function FinancierBakeWorkspace(
  props: Readonly<{
    recipe: FinancierBakeRecipeConfig;
    close(): void;
    applyToSchedule?: (outcome: CompletedBake) => void;
  }>,
): React.ReactNode {
  return (
    <RecipePlaybackWorkspace
      recipe={props.recipe}
      close={props.close}
      run={FINANCIER_BAKE_RUN}
      content={(run) => financierBakeContent(run, props.applyToSchedule)}
    />
  );
}

function financierBakeContent(
  run: RecipeRunView<FinancierBakeSample, FinancierBakeRecipeConfig>,
  applyToSchedule: ((outcome: CompletedBake) => void) | undefined,
): RecipeContent {
  const { recipe, frames, outcome } = run;
  function runFaultRecoveryCalibration(): void {
    run.apply(
      {
        ...recipe,
        mode: "convection",
        targetOvenTempC: 170,
        check: "carrier-handoff-recovery",
      },
      "Fault-recovery calibration preset loaded (14 mm carrier slip + FR10 cell 1 re-seat). Running recovery cycle.",
      true,
    );
  }
  return {
    title: "Financier Bake · Mould Depositing & Maruzen MBCO-5E",
    scene: <FinancierBakePhysicsView frames={frames} />,
    summary:
      outcome?.kind === "completed" ? (
        <>
          <strong>{outcome.bakedFinanciersG.toFixed(1)} g</strong> (
          {outcome.acceptedPieces} financiers @ {outcome.pieceMassG.toFixed(1)}{" "}
          g · {outcome.evaporatedWaterG.toFixed(1)} g steam loss)
        </>
      ) : null,
    scenario: (
      <FinancierBakeScenarioForm
        recipe={recipe}
        notice={run.notice}
        apply={(next) =>
          run.apply(next, "Updated Financier bake scenario applied.")
        }
      />
    ),
    results: (
      <>
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
      </>
    ),
    graph: { kind: "financier", part: "bake" },
    actions: (
      <>
        {run.status === "blocked" && (
          <button
            type="button"
            className="factory-primary"
            onClick={runFaultRecoveryCalibration}
          >
            Calibrate fault-recovery handoff
          </button>
        )}
        {outcome?.kind === "completed" && applyToSchedule !== undefined && (
          <button
            type="button"
            className="factory-primary"
            data-handoff-recovery-preset={outcome.handoffRecovery.preset}
            onClick={() => applyToSchedule(outcome)}
          >
            Apply to Tier 3 schedule
          </button>
        )}
      </>
    ),
  };
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
    <RecipeScenarioForm
      notice={props.notice}
      apply={() =>
        props.apply({
          ...props.recipe,
          mode,
          mouldCount,
          rackSlot,
          targetOvenTempC: mode === "convection" ? 170 : 180,
          check,
        })
      }
    >
      <p>
        FAIRINO FR10 Cobot dosing 25 g financier batter portions into Matsunaga
        8P silicone-coated moulds on the Ohaus Ranger 3000 scale and baking on a
        600 × 400 mm carrier in the Maruzen MBCO-5E 5-tray oven.
      </p>
      <RecipeChoice
        label="Maruzen MBCO-5E oven mode"
        items={MODE_ITEMS}
        value={mode}
        choose={(value) =>
          setMode(value === "conventional" ? "conventional" : "convection")
        }
      />
      <RecipeChoice
        label="Matsunaga 8P mould load"
        items={MOULD_COUNT_ITEMS}
        value={String(mouldCount)}
        choose={(value) => {
          const v = Number(value);
          setMouldCount(v === 2 ? 2 : v === 3 ? 3 : 1);
        }}
      />
      <RecipeChoice
        label="Maruzen MBCO-5E rack rail slot"
        items={RACK_SLOT_ITEMS}
        value={String(rackSlot)}
        choose={(value) => {
          const v = Number(value);
          setRackSlot(v === 2 ? 2 : v === 4 ? 4 : 3);
        }}
      />
      <RecipeChoice
        label="Process check"
        items={CHECK_ITEMS}
        value={check}
        choose={(value) =>
          setCheck(
            value === "carrier-handoff-recovery" ||
              value === "cell-2-restage-recovery" ||
              value === "under-preheated" ||
              value === "over-baked"
              ? value
              : "none",
          )
        }
      />
    </RecipeScenarioForm>
  );
}
