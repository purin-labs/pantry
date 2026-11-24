import React from "react";
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
} from "@purin-labs/production-simulation/recipes/financier-pack/model";
import {
  FinancierPackScene,
  type FinancierPackCameraPreset,
} from "./financier-pack-scene";
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
import type { Variant } from "@purin-labs/type-utils";

const PACK_STEPS: readonly RecipeStep[] = [
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
];

const PHASE_INDEX: Readonly<Record<FinancierPackPhase, number>> = {
  "cool-demould": 0,
  "crumb-check": 1,
  "pack-giftbox": 2,
  "seal-release": 3,
  completed: 4,
  failed: -1,
};

const CAMERAS: readonly (readonly [FinancierPackCameraPreset, string])[] = [
  ["station", "Station view"],
  ["demould", "Wire grid & 8P demould"],
  ["crumb", "Ohaus & 23.5 g crumb check"],
  ["giftbox", "Patisserie gift box & ribbon"],
];

function FinancierPackPhysicsView(
  props: Readonly<{ frames: LiveSource<RecipeFrames<FinancierPackSample>> }>,
): React.ReactNode {
  const { frames } = props;
  return (
    <RecipeStation
      frames={frames}
      scene={(element) => new FinancierPackScene(element)}
      unavailable="The Financier pack workcell visual is unavailable."
      attributes={(sample) => ({
        "data-financier-pack-phase": sample.phase,
        "data-financier-pack-step": String(sample.step),
      })}
      label="Accepted financier pack station state"
      canvasLabel="3D Financier cooling, demoulding and gift-box packing workcell with FAIRINO FR10 Cobot, 16-level cooling rack, wire cooling grid, Matsunaga 8P mould, porcelain crumb-check plate, and Ohaus Ranger 3000 scale"
      camera="station"
      cameras={CAMERAS}
    >
      <RecipeStepPills
        frames={frames}
        label="Financier pack cycle progress"
        steps={() => PACK_STEPS}
        index={(sample) => PHASE_INDEX[sample.phase]}
      />
      <dl className="pour-over-kpi-strip">
        <RecipeStageReadout
          frames={frames}
          attribute="data-financier-pack-stage"
        />
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
    </RecipeStation>
  );
}

const FINANCIER_PACK_RUN: RecipeRun<
  FinancierPackSample,
  FinancierPackRecipeConfig
> = {
  model: (recipe) => new FinancierPackSimulationEngine(recipe),
  stages: () => financierPackTimelineStages(),
  outcomeNotice: (outcome) =>
    outcome.kind === "failed"
      ? outcome.reason
      : "Financiers demoulded, crumb-checked, and sealed in gold-ribbon patisserie gift box.",
  resetNotice: "Workcell reset to t = 0.00 s.",
  notice: "Workcell prepared at t = 0.00 s.",
  endS: 56,
};

type CompletedPack = Variant<FinancierPackOutcome, "completed">;

export function FinancierPackWorkspace(
  props: Readonly<{
    recipe: FinancierPackRecipeConfig;
    close(): void;
    applyToSchedule?: (outcome: CompletedPack) => void;
  }>,
): React.ReactNode {
  return (
    <RecipePlaybackWorkspace
      recipe={props.recipe}
      close={props.close}
      run={FINANCIER_PACK_RUN}
      content={(run) => financierPackContent(run, props.applyToSchedule)}
    />
  );
}

function financierPackContent(
  run: RecipeRunView<FinancierPackSample, FinancierPackRecipeConfig>,
  applyToSchedule: ((outcome: CompletedPack) => void) | undefined,
): RecipeContent {
  const { recipe, frames, outcome } = run;
  return {
    title: "Financier Pack · Wire-Grid Demoulding & Gift Box",
    scene: <FinancierPackPhysicsView frames={frames} />,
    summary:
      outcome?.kind === "completed" ? (
        <>
          <strong>{outcome.packedNetMassG.toFixed(1)} g</strong> (
          {outcome.packedPieces} packed @ {outcome.pieceMassG.toFixed(1)} g ·{" "}
          {outcome.crumbSampleG.toFixed(1)} g crumb sample)
        </>
      ) : null,
    scenario: (
      <FinancierPackScenarioForm
        recipe={recipe}
        notice={run.notice}
        apply={(next) =>
          run.apply(next, "Updated Financier pack scenario applied.")
        }
      />
    ),
    results: (
      <>
        <h4>Financier Demoulding, Crumb Check &amp; Pack Ledger</h4>
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
      </>
    ),
    graph: { kind: "financier", part: "pack" },
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

const LOAD_PRESET_ITEMS = [
  {
    value: "two-accepted-16",
    label: "3-load campaign (16 accepted · 376.0 g → 15 packed · 352.5 g)",
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
    <RecipeScenarioForm
      notice={props.notice}
      apply={() =>
        props.apply({
          ...props.recipe,
          loadPreset,
          boxStyle,
          crumbSamplePieces,
          check,
        })
      }
    >
      <RecipeChoice
        label="Accepted baked load"
        items={LOAD_PRESET_ITEMS}
        value={loadPreset}
        choose={(value) => {
          const next =
            value === "single-load-8" ? "single-load-8" : "two-accepted-16";
          setLoadPreset(next);
          setBoxStyle(
            next === "two-accepted-16" ? "atelier-15" : "patisserie-8",
          );
        }}
      />
      <RecipeChoice
        label="Crumb check sample"
        items={CRUMB_SAMPLE_PIECES_ITEMS}
        value={String(crumbSamplePieces)}
        choose={(value) => setCrumbSamplePieces(value === "0" ? 0 : 1)}
      />
      <RecipeChoice
        label="Process check"
        items={CHECK_ITEMS}
        value={check}
        choose={(value) =>
          setCheck(
            value === "warm-demould" || value === "underweight-box"
              ? value
              : "none",
          )
        }
      />
    </RecipeScenarioForm>
  );
}
