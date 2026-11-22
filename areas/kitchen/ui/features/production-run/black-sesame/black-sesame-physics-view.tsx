import React from "react";
import {
  BlackSesameCobotSimulationEngine,
  blackSesameTimelineStages,
  type BlackSesameCheck,
  type BlackSesameCobotPhase,
  type BlackSesameCobotRecipeConfig,
  type BlackSesameCobotSample,
  type BlackSesameHobModel,
  type BlackSesameRoastMode,
} from "@purin-labs/production-simulation/recipes/black-sesame/model";
import {
  BlackSesameScene,
  type BlackSesameCameraPreset,
} from "./black-sesame-scene";
import { physicsEvidenceVisible } from "@purin-labs/production-simulation/runs/physics-evidence";
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

const SESAME_STEPS: readonly RecipeStep[] = [
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
];

const PHASE_INDEX: Readonly<Record<BlackSesameCobotPhase, number>> = {
  "grind-sesame": 0,
  "cook-slurry": 1,
  "blend-standardize": 2,
  "cold-carrier-transfer": 3,
  "heated-mixer-service": 4,
  completed: 5,
  failed: -1,
};

const CAMERAS: readonly (readonly [BlackSesameCameraPreset, string])[] = [
  ["station", "Station view"],
  ["grinder-blender", "WSG60 & Vitamix"],
  ["refrigerator", "Hoshizaki cold carrier"],
  ["service", "Severin SM 3587 service"],
];

function BlackSesamePhysicsView(
  props: Readonly<{
    hob: BlackSesameHobModel;
    frames: LiveSource<RecipeFrames<BlackSesameCobotSample>>;
  }>,
): React.ReactNode {
  const { hob, frames } = props;
  const hobTitle = inductionHobTitle(hob);
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new BlackSesameScene(element, hob)}
      sceneKey={hob}
      unavailable="The Black Sesame Milk workcell visual is unavailable."
      attributes={(sample) => ({
        "data-black-sesame-phase": sample.phase,
        "data-black-sesame-step": String(sample.step),
      })}
      label="Accepted black sesame milk station state"
      canvasLabel="3D Black Sesame Milk workcell with FAIRINO FR10 Cobot, Waring WSG60 spice grinder, Maruzen MIH-02C induction hob, Vitamix The Quiet One blender, Ohaus Ranger 3000 scale, Hoshizaki RT-120SNJ refrigerator, and Severin SM 3587 milk mixer"
      camera="station"
      cameras={CAMERAS}
    >
      <RecipeStepPills
        frames={frames}
        label="Black sesame milk cycle progress"
        steps={() => SESAME_STEPS}
        index={(sample) => PHASE_INDEX[sample.phase]}
      />
      <dl className="pour-over-kpi-strip">
        <RecipeStageReadout
          frames={frames}
          attribute="data-black-sesame-stage"
        />
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
    </RecipeStation>
  );
}

const BLACK_SESAME_RUN: RecipeRun<
  BlackSesameCobotSample,
  BlackSesameCobotRecipeConfig
> = {
  model: (recipe) => new BlackSesameCobotSimulationEngine(recipe),
  stages: () => blackSesameTimelineStages(),
  outcomeNotice: (outcome) =>
    outcome.kind === "failed"
      ? outcome.reason
      : "Black Sesame Milk concentrate refrigerated in Hoshizaki RT-120SNJ and 286 g heated drink served.",
  resetNotice: "Workcell reset to t = 0.00 s.",
  notice:
    "Black Sesame Milk workcell prepared at t = 0.00 s. Press Start production to run.",
  endS: 60,
};

export function BlackSesameWorkspace(
  props: Readonly<{ recipe: BlackSesameCobotRecipeConfig; close(): void }>,
): React.ReactNode {
  return (
    <RecipePlaybackWorkspace
      recipe={props.recipe}
      close={props.close}
      run={BLACK_SESAME_RUN}
      content={blackSesameContent}
    />
  );
}

function blackSesameContent(
  run: RecipeRunView<BlackSesameCobotSample, BlackSesameCobotRecipeConfig>,
): RecipeContent {
  const { recipe, frames, outcome } = run;
  return {
    title: "Black Sesame Milk · WSG60, Vitamix Quiet One & Severin SM 3587",
    scene: <BlackSesamePhysicsView hob={recipe.hob} frames={frames} />,
    summary:
      outcome?.kind === "completed" ? (
        <>
          <strong>{outcome.standardizedConcentrateG.toFixed(0)} g</strong>{" "}
          concentrate · <strong>{outcome.servedDrinkG.toFixed(0)} g</strong>{" "}
          served at {outcome.servedDrinkTempC.toFixed(0)} °C
        </>
      ) : null,
    scenario: (
      <BlackSesameScenarioForm
        recipe={recipe}
        notice={run.notice}
        apply={(next) =>
          run.apply(next, "Updated Black Sesame Milk scenario applied.")
        }
      />
    ),
    results: (
      <>
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
      </>
    ),
    graph: { kind: "black-sesame" },
  };
}

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
    <RecipeScenarioForm
      notice={props.notice}
      apply={() => props.apply({ ...props.recipe, hob, roast, check })}
    >
      <p>
        FAIRINO FR10 Cobot operating the Black Sesame Milk bench: Waring WSG60
        spice grinder, induction slurry cooker, Vitamix The Quiet One blender,
        Ohaus Ranger 3000 scale, Hoshizaki RT-120SNJ cold-carrier transfer, and
        Severin SM 3587 heated drink service.
      </p>
      <RecipeChoice
        label="Induction hob"
        items={INDUCTION_HOB_ITEMS}
        value={hob}
        choose={(value) => setHob(inductionHob(value))}
      />
      <RecipeChoice
        label="Sesame roast mode"
        items={ROAST_ITEMS}
        value={roast}
        choose={(value) => setRoast(value === "refresh" ? "refresh" : "skip")}
      />
      <RecipeChoice
        label="Process check"
        items={CHECK_ITEMS}
        value={check}
        choose={(value) =>
          setCheck(
            value === "overweight-unreconciled" ||
              value === "enclosure-interlock"
              ? value
              : "none",
          )
        }
      />
    </RecipeScenarioForm>
  );
}
