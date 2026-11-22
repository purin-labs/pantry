import React from "react";
import {
  LatteSimulationEngine,
  latteTimelineStages,
  type LattePhase,
  type LatteRecipeConfig,
  type LatteSample,
} from "@purin-labs/production-simulation/recipes/latte/model";
import { LatteScene, type LatteCameraPreset } from "./latte-scene";
import { physicsEvidenceVisible } from "@purin-labs/production-simulation/runs/physics-evidence";
import "../oven-workspace.css";
// The station readout uses the pour-over styles, so this view loads them itself.
import "../pour-over/pour-over.css";
import type { RecipeFrames } from "../shared/playback-controller";
import { LiveText } from "../shared/live";
import type { LiveSource } from "../shared/live-value";
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

const LATTE_STEPS: readonly RecipeStep[] = [
  {
    id: "espresso",
    label: "1 · Espresso",
    detail: "9 bar · 36 g",
  },
  {
    id: "stretch",
    label: "2 · Stretch",
    detail: "1.4 bar · 37 °C",
  },
  {
    id: "whirlpool",
    label: "3 · Whirlpool",
    detail: "Roll · 63 °C",
  },
  {
    id: "pour",
    label: "4 · Rosetta",
    detail: "Free-pour art",
  },
];

const PHASE_INDEX: Readonly<Record<LattePhase, number>> = {
  "place-cup": 0,
  "espresso-shot": 0,
  "transfer-cup": 0,
  "grasp-pitcher": 1,
  "steam-stretch": 1,
  "steam-whirlpool": 2,
  "pour-latte": 3,
  "return-pitcher": 3,
  completed: 4,
  failed: -1,
};

const CAMERAS: readonly (readonly [LatteCameraPreset, string])[] = [
  ["station", "Station view"],
  ["steam", "Steam wand close-up"],
  ["pour", "Latte pour close-up"],
  ["overhead", "Overhead latte art"],
];

function LattePhysicsView(
  props: Readonly<{
    appliance: "linea" | "eagle-one";
    frames: LiveSource<RecipeFrames<LatteSample>>;
  }>,
): React.ReactNode {
  const { appliance, frames } = props;
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new LatteScene(element, appliance)}
      sceneKey={appliance}
      unavailable="The latte station visual is unavailable."
      attributes={(sample) => ({
        "data-latte-phase": sample.phase,
        "data-latte-step": String(sample.step),
      })}
      label="Accepted caffe latte station state"
      canvasLabel="3D FAIRINO FR10 Cobot and La Marzocco Linea Classic S milk steaming and Rosetta latte art station"
      camera="station"
      cameras={CAMERAS}
    >
      <RecipeStepPills
        frames={frames}
        label="Latte cycle progress"
        steps={() => LATTE_STEPS}
        index={(sample) => PHASE_INDEX[sample.phase]}
      />
      <dl className="pour-over-kpi-strip">
        <RecipeStageReadout frames={frames} attribute="data-latte-stage" />
        <dt>Pitcher milk</dt>
        <LiveText as="dd" source={frames} text={pitcherText} />
        <dt>Latte bowl</dt>
        <LiveText as="dd" source={frames} text={bowlText} />
        <dt>Rosetta art</dt>
        <LiveText as="dd" source={frames} text={artText} />
      </dl>
      {physicsEvidenceVisible() && (
        <details>
          <summary>Equipment &amp; thermal details</summary>
          <dl>
            <dt>Machine</dt>
            <dd>
              {appliance === "linea"
                ? "La Marzocco Linea Classic S"
                : "Victoria Arduino Eagle One"}
            </dd>
            <dt>Steam boiler</dt>
            <LiveText as="dd" source={frames} text={boilerText} />
          </dl>
        </details>
      )}
    </RecipeStation>
  );
}

function pitcherText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.pitcher.milkMassG.toFixed(1)} g at ${sample.pitcher.temperatureC.toFixed(1)} °C · ${Math.round((sample.pitcher.foamExpansion - 1) * 100)}% microfoam`;
}

function bowlText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.totalMassG.toFixed(1)} g (${sample.cup.espressoMassG.toFixed(0)} g espresso + ${sample.cup.milkMassG.toFixed(0)} g milk) at ${sample.cup.temperatureC.toFixed(1)} °C`;
}

function artText({ sample }: RecipeFrames<LatteSample>): string {
  return `${Math.round(sample.cup.latteArtProgress * 100)}% pattern`;
}

function boilerText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.espresso.steamPressureBar.toFixed(2)} bar · ${sample.espresso.steamBoilerC.toFixed(1)} °C ${sample.espresso.steamValveOpen ? "(open)" : "(closed)"}`;
}

function espressoText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.espressoMassG.toFixed(1)} g`;
}

function milkText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.milkMassG.toFixed(1)} g`;
}

function yieldText({ sample }: RecipeFrames<LatteSample>): string {
  return `${sample.cup.totalMassG.toFixed(1)} g at ${sample.cup.temperatureC.toFixed(1)} °C`;
}

function foamText({ sample }: RecipeFrames<LatteSample>): string {
  return `${Math.round((sample.pitcher.foamExpansion - 1) * 100)}% volume expansion`;
}

const LATTE_RUN: RecipeRun<LatteSample, LatteRecipeConfig> = {
  model: (recipe) => new LatteSimulationEngine(recipe),
  stages: () => latteTimelineStages(),
  outcomeNotice: (outcome) =>
    outcome.kind === "failed"
      ? outcome.reason
      : "Caffe Latte completed with Rosetta microfoam art.",
  resetNotice: "Station reset to t = 0.00 s.",
  notice: "Station prepared at t = 0.00 s. Press Start production to run.",
  endS: 56,
};

/** The latte recipe has no scenario form: the recipe author sets it. */
export function LatteWorkspace(
  props: Readonly<{ recipe: LatteRecipeConfig; close(): void }>,
): React.ReactNode {
  return (
    <RecipePlaybackWorkspace
      recipe={props.recipe}
      close={props.close}
      run={LATTE_RUN}
      content={latteContent}
    />
  );
}

function latteContent(
  run: RecipeRunView<LatteSample, LatteRecipeConfig>,
): RecipeContent {
  const { recipe, frames, outcome } = run;
  return {
    title: (
      <>
        Caffe Latte ·{" "}
        {recipe.appliance === "linea" ? "Linea Classic S" : "Eagle One"} &amp;
        FAIRINO FR10
      </>
    ),
    scene: <LattePhysicsView appliance={recipe.appliance} frames={frames} />,
    summary:
      outcome?.kind === "completed" ? (
        <>
          <strong>1</strong> Caffe Latte served ·{" "}
          {outcome.totalBeverageG.toFixed(1)} g at{" "}
          {outcome.finalCupTempC.toFixed(1)} °C
        </>
      ) : null,
    scenario: (
      <>
        <p>
          FAIRINO FR10 Cobot operating the dual-boiler espresso and steam
          station: 36 g 9-bar double espresso base, {recipe.milkG} g chilled
          milk steamed to {recipe.targetMilkC} °C with whirlpool microfoam
          texturing, and a free-pour Rosetta latte art finish.
        </p>
        <p role="status">{run.notice}</p>
      </>
    ),
    results: (
      <>
        <h4>Measured latte mass &amp; thermal balance</h4>
        <dl>
          <dt>Espresso base (9 bar)</dt>
          <LiveText as="dd" source={frames} text={espressoText} />
          <dt>Steamed microfoam milk</dt>
          <LiveText as="dd" source={frames} text={milkText} />
          <dt>Total Caffe Latte yield</dt>
          <LiveText as="dd" source={frames} text={yieldText} />
          <dt>Microfoam expansion</dt>
          <LiveText as="dd" source={frames} text={foamText} />
        </dl>
      </>
    ),
    graph: { kind: "latte", milkG: recipe.milkG },
  };
}
