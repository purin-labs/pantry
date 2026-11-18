import React from "react";
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
import type { RecipeFrames } from "../shared/playback-controller";
import { LiveText } from "../shared/live";
import type { LiveSource } from "../shared/live-value";
import {
  INDUCTION_HOB_ITEMS,
  inductionHob,
  inductionHobTitle,
} from "../shared/induction-hob";
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

const BATTER_STEPS: readonly RecipeStep[] = [
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
];

const PHASE_INDEX: Readonly<Record<FinancierBatterPhase, number>> = {
  "brown-butter": 0,
  "charge-dry-whites": 1,
  "mix-paste": 2,
  "temper-butter": 3,
  homogenize: 3,
  completed: 4,
  failed: -1,
};

const CAMERAS: readonly (readonly [FinancierBatterCameraPreset, string])[] = [
  ["station", "Station view"],
  ["hob", "Beurre noisette hob"],
  ["mixer", "Hobart HL200 bowl"],
  ["overhead", "Overhead workcell"],
];

function FinancierBatterPhysicsView(
  props: Readonly<{
    hob: FinancierHobModel;
    tool: FinancierMixerTool;
    frames: LiveSource<RecipeFrames<FinancierBatterSample>>;
  }>,
): React.ReactNode {
  const { hob, tool, frames } = props;
  const hobTitle = inductionHobTitle(hob);
  const toolTitle =
    tool === "beater"
      ? "Hobart BBEATER-HL20 Flat Beater"
      : "Hobart DWHIP-HL20 Wire Whip";
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new FinancierBatterScene(element, hob, tool)}
      sceneKey={`${hob}:${tool}`}
      unavailable="The Financier batter workcell visual is unavailable."
      attributes={(sample) => ({
        "data-financier-batter-phase": sample.phase,
        "data-financier-batter-step": String(sample.step),
      })}
      showOnEachUpdate
      label="Accepted financier batter station state"
      canvasLabel="3D Financier batter workcell with FAIRINO FR10 Cobot, Ohaus Ranger 3000 scale, Maruzen MIH-02C induction hob, and Hobart HL200 20 qt planetary mixer"
      camera="station"
      cameras={CAMERAS}
    >
      <RecipeStepPills
        frames={frames}
        label="Financier batter cycle progress"
        steps={() => BATTER_STEPS}
        index={(sample) => PHASE_INDEX[sample.phase]}
      />
      <dl className="pour-over-kpi-strip">
        <RecipeStageReadout
          frames={frames}
          attribute="data-financier-batter-stage"
        />
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
    </RecipeStation>
  );
}

const FINANCIER_BATTER_RUN: RecipeRun<
  FinancierBatterSample,
  FinancierBatterRecipeConfig
> = {
  model: (recipe) => new FinancierBatterSimulationEngine(recipe),
  stages: () => financierBatterTimelineStages(),
  outcomeNotice: (outcome) =>
    outcome.kind === "failed"
      ? outcome.reason
      : "Financier batter homogenized and ready for mould depositing.",
  resetNotice: "Workcell reset to t = 0.00 s.",
  notice: "Workcell prepared at t = 0.00 s. Press Start production to run.",
  endS: 60,
};

export function FinancierBatterWorkspace(
  props: Readonly<{
    recipe: FinancierBatterRecipeConfig;
    close(): void;
    applyToSchedule?: (
      outcome: Extract<FinancierBatterOutcome, { kind: "completed" }>,
    ) => void;
  }>,
): React.ReactNode {
  return (
    <RecipePlaybackWorkspace
      recipe={props.recipe}
      close={props.close}
      run={FINANCIER_BATTER_RUN}
      content={(run) => financierBatterContent(run, props.applyToSchedule)}
    />
  );
}

function financierBatterContent(
  run: RecipeRunView<FinancierBatterSample, FinancierBatterRecipeConfig>,
  applyToSchedule:
    | ((
        outcome: Extract<FinancierBatterOutcome, { kind: "completed" }>,
      ) => void)
    | undefined,
): RecipeContent {
  const { recipe, frames, outcome } = run;
  return {
    title: "Financier Batter · Beurre Noisette & Hobart HL200",
    scene: (
      <FinancierBatterPhysicsView
        hob={recipe.hob}
        tool={recipe.tool}
        frames={frames}
      />
    ),
    summary:
      outcome?.kind === "completed" ? (
        <>
          <strong>{outcome.totalBatterG.toFixed(1)} g</strong> Financier batter
          · {outcome.mouldCavitiesYield} cavities @ 25 g
        </>
      ) : null,
    scenario: (
      <FinancierBatterScenarioForm
        recipe={recipe}
        notice={run.notice}
        apply={(next) =>
          run.apply(next, "Updated Financier batter scenario applied.")
        }
      />
    ),
    results: (
      <>
        <h4>Measured Financier batter mass &amp; thermal balance</h4>
        <dl>
          <dt>Tant-pour-tant dry blend</dt>
          <LiveText
            as="dd"
            source={frames}
            text={({ sample }) => `${sample.mixer.dryChargedG.toFixed(1)} g`}
          />
          <dt>Tempered egg whites &amp; vanilla</dt>
          <LiveText
            as="dd"
            source={frames}
            text={({ sample }) => `${sample.mixer.whitesChargedG.toFixed(1)} g`}
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
      </>
    ),
    graph: { kind: "financier", part: "batter" },
    actions: outcome?.kind === "completed" && applyToSchedule !== undefined && (
      <button
        type="button"
        className="factory-primary"
        onClick={() => applyToSchedule(outcome)}
      >
        Apply to Tier 3 schedule
      </button>
    ),
  };
}

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
    <RecipeScenarioForm
      notice={props.notice}
      apply={() => props.apply({ ...props.recipe, hob, tool, check })}
    >
      <p>
        FAIRINO FR10 Cobot operating the patisserie prep bench: Ohaus Ranger
        3000 weighing pan, 152 °C induction beurre noisette pan, and Hobart
        HL200 20 qt planetary mixer.
      </p>
      <RecipeChoice
        label="Induction hob"
        items={INDUCTION_HOB_ITEMS}
        value={hob}
        choose={(value) => setHob(inductionHob(value))}
      />
      <RecipeChoice
        label="Hobart HL200 agitator"
        items={TOOL_ITEMS}
        value={tool}
        choose={(value) => setTool(value === "whip" ? "whip" : "beater")}
      />
      <RecipeChoice
        label="Process check"
        items={CHECK_ITEMS}
        value={check}
        choose={(value) =>
          setCheck(
            value === "burnt-butter" || value === "guard-interlock"
              ? value
              : "none",
          )
        }
      />
    </RecipeScenarioForm>
  );
}
