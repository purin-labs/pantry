import React from "react";
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

type Frames = LiveSource<RecipeFrames<GingerTeaCobotSample>>;

const PHASE_INDEX: Readonly<Record<GingerTeaCobotPhase, number>> = {
  "stage-clean-pans": 0,
  "weigh-and-simmer-ginger": 1,
  "extract-tea": 2,
  "strain-and-inspect": 3,
  "finish-and-serve": 4,
  completed: 5,
  failed: -1,
};

const BLACK_TEA_STEPS: readonly RecipeStep[] = [
  { id: "stage", label: "1 · FR10 Pan Stage", detail: "Clean pan & pot" },
  { id: "simmer", label: "2 · Ginger Simmer", detail: "450 g + 15 g" },
  { id: "steep", label: "3 · Heat-Off Steep", detail: "8 g off-hob rest" },
  { id: "strain", label: "4 · Strain & Review", detail: "415 g extract" },
  { id: "serve", label: "5 · Sugar & Serve", detail: "435 g · 2 cups" },
];

const MILK_TEA_STEPS: readonly RecipeStep[] = [
  { id: "stage", label: "1 · Wash & FR10 Stage", detail: "Pan-b in insert" },
  { id: "simmer", label: "2 · Ginger Simmer", detail: "400 g + 15 g" },
  { id: "extract", label: "3 · Assam Simmer", detail: "9 g · 3 min" },
  { id: "strain", label: "4 · Strain to Pan-B", detail: "365 g extract" },
  { id: "finish", label: "5 · Milk 78 °C & Serve", detail: "570 g · 2 cups" },
];

const CAMERAS: readonly (readonly [GingerTeaCameraPreset, string])[] = [
  ["station", "Station view"],
  ["pan-staging", "FR10 pan-staging insert"],
  ["hob-straining", "Hob & strainer"],
  ["sink-service", "Wash sink & service"],
];

function GingerTeaPhysicsView(
  props: Readonly<{ hob: GingerTeaHobModel; frames: Frames }>,
): React.ReactNode {
  const { hob, frames } = props;
  const hobTitle = inductionHobTitle(hob);
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new GingerTeaScene(element, hob)}
      sceneKey={hob}
      unavailable="The Ginger Tea workcell visual is unavailable."
      attributes={(sample) => ({
        "data-ginger-tea-phase": sample.phase,
        "data-ginger-tea-step": String(sample.step),
      })}
      label="Accepted ginger tea station state"
      canvasLabel="3D Ginger Tea and Two-Pan Ginger Milk Tea workcell with FAIRINO FR10 Cobot, rigid pan-staging insert, wash sink, Ohaus Ranger 3000 scale, Maruzen MIH-02C induction hob, heatproof rest, and fine mesh strainer"
      camera="station"
      cameras={CAMERAS}
    >
      <RecipeStepPills
        frames={frames}
        label="Ginger tea cycle progress"
        steps={(sample) =>
          sample.mode === "black-tea" ? BLACK_TEA_STEPS : MILK_TEA_STEPS
        }
        index={(sample) => PHASE_INDEX[sample.phase]}
      />
      <dl className="pour-over-kpi-strip">
        <RecipeStageReadout frames={frames} attribute="data-ginger-tea-stage" />
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
    </RecipeStation>
  );
}

const GINGER_TEA_RUN: RecipeRun<
  GingerTeaCobotSample,
  GingerTeaCobotRecipeConfig
> = {
  model: (recipe) => new GingerTeaSimulationEngine(recipe),
  stages: (recipe) => gingerTeaTimelineStages(recipe.mode),
  outcomeNotice: (outcome) =>
    outcome.kind === "failed"
      ? outcome.reason
      : `Served ${outcome.servings} cups (${outcome.servedMassG} g at ${outcome.finalTempC.toFixed(1)} °C).`,
  resetNotice: "Workcell reset to t = 0.00 s.",
  notice:
    "Ginger Tea MuJoCo pan-staging workcell prepared at t = 0.00 s. Press Start production to run.",
  endS: 60,
};

export function GingerTeaWorkspace(
  props: Readonly<{ recipe: GingerTeaCobotRecipeConfig; close(): void }>,
): React.ReactNode {
  return (
    <RecipePlaybackWorkspace
      recipe={props.recipe}
      close={props.close}
      run={GINGER_TEA_RUN}
      content={gingerTeaContent}
    />
  );
}

function gingerTeaContent(
  run: RecipeRunView<GingerTeaCobotSample, GingerTeaCobotRecipeConfig>,
): RecipeContent {
  const { recipe, frames, outcome } = run;
  return {
    title:
      recipe.mode === "two-pan-milk-tea"
        ? "Plan 61D Two-Pan Ginger Milk Tea · FR10 Pan-B Staging & 78 °C Milk Finishing"
        : "Plan 61C Ginger Black Tea · FR10 Clean-Pan Staging & Heat-Off Extraction",
    scene: <GingerTeaPhysicsView hob={recipe.hob} frames={frames} />,
    summary:
      outcome?.kind === "completed" ? (
        <>
          <strong>{outcome.servings} cups</strong> (
          <strong>{outcome.servedMassG.toFixed(0)} g</strong>) served at{" "}
          {outcome.finalTempC.toFixed(0)} °C
        </>
      ) : null,
    scenario: (
      <GingerTeaScenarioForm
        recipe={recipe}
        notice={run.notice}
        apply={(next) =>
          run.apply(next, "Updated Ginger Tea scenario applied.")
        }
      />
    ),
    results: (
      <>
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
      </>
    ),
    graph: { kind: "ginger-tea", mode: recipe.mode },
  };
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
    <RecipeScenarioForm
      notice={props.notice}
      apply={() => props.apply({ ...props.recipe, mode, hob, tea, check })}
    >
      <p>
        FAIRINO FR10 Cobot operating the Plan 61C Ginger Black Tea and Plan 61D
        Two-Pan Ginger Milk Tea bench: wash sink, rigid pan-staging insert,
        Ohaus Ranger 3000 scale, Maruzen / Vollrath induction hob, heatproof
        rest, and fine mesh strainer.
      </p>
      <RecipeChoice
        label="Tea workflow mode"
        items={MODES}
        value={mode}
        choose={(value) =>
          setMode(value === "black-tea" ? "black-tea" : "two-pan-milk-tea")
        }
      />
      <RecipeChoice
        label="Induction hob model"
        items={INDUCTION_HOB_ITEMS}
        value={hob}
        choose={(value) => setHob(inductionHob(value))}
      />
      <RecipeChoice
        label="Tea leaf selection"
        items={TEAS}
        value={tea}
        choose={(value) => setTea(value === "ctc" ? "ctc" : "assam")}
      />
      <RecipeChoice
        label="Process & pan-staging check"
        items={CHECKS}
        value={check}
        choose={(value) =>
          setCheck(
            value === "late-straining-hold" || value === "dropped-pan-recovery"
              ? value
              : "none",
          )
        }
      />
    </RecipeScenarioForm>
  );
}
