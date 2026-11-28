import type { Operation } from "@purin-labs/bakery-model/bakery";
import type { Process } from "./schedule-types.ts";

type Plan61ASubstepId =
  | "pull-cold-ingredients"
  | "weigh-ingredients"
  | "cook-brown-butter"
  | "mix-batter"
  | "butter-moulds"
  | "deposit-batter"
  | "convection-bake"
  | "mould-set-cool"
  | "release-financiers"
  | "wash-moulds"
  | "return-clean-moulds"
  | "wire-grid-cool"
  | "crumb-check-qa"
  | "pack-ballotins"
  | "refill-vitrine";

type Plan61ASubstep = Readonly<{
  id: Plan61ASubstepId;
  operation: Operation;
  startFraction: number;
  endFraction: number;
  label: string;
  shortLabel: string;
  equipment: string;
  massNote: string;
}>;

export const PLAN_61A_MASS_BALANCE = {
  inputGrams: 756,
  brownButterInputGrams: 180,
  brownButterOutputGrams: 158,
  brownButterEvaporationGrams: 22,
  batterCombinedGrams: 734,
  bowlResidueGrams: 8,
  transferableBatterGrams: 726,
  trayDepositedGrams: 600,
  retainedBatterGrams: 126,
  mouldCount: 3,
  cavitiesPerMould: 8,
  totalCavities: 24,
  gramsPerCavity: 25,
  bakeEvaporationGrams: 36,
  bakedPiecesGrams: 564,
  sampledPieceGrams: 23.5,
  rejectedPiecesGrams: 188,
  acceptedPackedGrams: 352.5,
  acceptedPieceCount: 15,
  rejectedPieceCount: 8,
  sampledPieceCount: 1,
} as const;

const PLAN_61A_SUBSTEPS_BY_OPERATION: Readonly<
  Record<Operation, readonly Plan61ASubstep[]>
> = {
  stage: [
    {
      id: "pull-cold-ingredients",
      operation: "stage",
      startFraction: 0,
      endFraction: 0.18,
      label:
        "Pull 4 °C cultured butter (180 g) & aged egg whites (180 g) from cold chiller to scale",
      shortLabel: "Pull butter & whites · 4 °C chiller",
      equipment: "4 °C patisserie chiller → Ohaus scale",
      massNote:
        "360 g chilled dairy & albumen carried from cold storage to prep table",
    },
    {
      id: "weigh-ingredients",
      operation: "stage",
      startFraction: 0.18,
      endFraction: 0.42,
      label: "Weigh 756 g dry powders, egg whites, honey & butter",
      shortLabel: "Weigh 756 g · Ohaus scale",
      equipment: "Ohaus Ranger 3000 (30 kg × 0.5 g)",
      massNote:
        "180 g butter, 76 g almond, 76 g hazelnut, 165 g icing sugar, 55 g T45 flour, 180 g whites, 20 g honey",
    },
    {
      id: "cook-brown-butter",
      operation: "stage",
      startFraction: 0.42,
      endFraction: 0.72,
      label: "Cook beurre noisette at 148 °C and strain to 55 °C",
      shortLabel: "Brown butter 158 g · Maruzen hob",
      equipment: "Maruzen TIH-3NN 3 kW induction hob",
      massNote: "180 g butter → 158 g nutty brown butter (22 g water evaporated)",
    },
    {
      id: "mix-batter",
      operation: "stage",
      startFraction: 0.72,
      endFraction: 1,
      label: "Fold dry powders, whites, honey & warm brown butter",
      shortLabel: "Mix 726 g batter · Hobart HL200",
      equipment: "Hobart HL200 20 qt planetary mixer",
      massNote: "734 g combined − 8 g bowl/whisk residue = 726 g batter",
    },
  ],
  portion: [
    {
      id: "butter-moulds",
      operation: "portion",
      startFraction: 0,
      endFraction: 0.3,
      label: "Brush & tare 3 Matsunaga 8-cavity Silver Stone moulds",
      shortLabel: "Prep 3 × 8P Matsunaga moulds",
      equipment: "3 × Matsunaga 8-cavity moulds on Ohaus scale",
      massNote: "24 cavities total (3 moulds × 8 cavities)",
    },
    {
      id: "deposit-batter",
      operation: "portion",
      startFraction: 0.3,
      endFraction: 1,
      label: "Deposit 25 g batter into 24 cavities (200 g per mould)",
      shortLabel: "Deposit 24 × 25 g (600 g tray)",
      equipment: "Stainless piston funnel depositor + Ohaus scale",
      massNote: "600 g deposited across 3 moulds; 126 g retained for next tray",
    },
  ],
  bake: [
    {
      id: "convection-bake",
      operation: "bake",
      startFraction: 0,
      endFraction: 1,
      label: "Bake at 170 °C convection until golden bosse forms",
      shortLabel: "Bake 170 °C · 24 cavities",
      equipment: "UNOX Bakerlux SHOP.Pro LED 4-tray convection oven",
      massNote: "600 g batter → 564 g baked financiers (36 g bake evaporation)",
    },
  ],
  cool: [
    {
      id: "mould-set-cool",
      operation: "cool",
      startFraction: 0,
      endFraction: 1,
      label: "Cool in Matsunaga moulds 2–3 min for crust set",
      shortLabel: "Cool in 3 Matsunaga moulds",
      equipment: "600 × 400 mm patisserie cooling rack",
      massNote: "564 g across 24 cavities (23.5 g per baked piece)",
    },
  ],
  demould: [
    {
      id: "release-financiers",
      operation: "demould",
      startFraction: 0,
      endFraction: 0.45,
      label: "Invert 3 Matsunaga moulds to release 24 financiers onto wire grid",
      shortLabel: "Demould 24 pcs to wire grid",
      equipment: "Wire cooling grid at cooling rack",
      massNote: "24 pieces (564 g) transferred to wire grid; 3 moulds freed",
    },
    {
      id: "wash-moulds",
      operation: "demould",
      startFraction: 0.45,
      endFraction: 0.85,
      label: "Wash & sanitize 3 Matsunaga 8-cavity moulds at kitchen sink",
      shortLabel: "Wash 3 Matsunaga moulds · Sink",
      equipment: "2-bay stainless kitchen wash sink (65 °C rinse)",
      massNote: "Removes butter film & crumb residue for hygienic mould reuse",
    },
    {
      id: "return-clean-moulds",
      operation: "demould",
      startFraction: 0.85,
      endFraction: 1,
      label: "Dry & return 3 clean Matsunaga moulds to portioning station",
      shortLabel: "Return 3 clean moulds",
      equipment: "Mould drying rack → portioning table",
      massNote: "3 × Matsunaga 8P moulds ready for next cycle",
    },
  ],
  finishCooling: [
    {
      id: "wire-grid-cool",
      operation: "finishCooling",
      startFraction: 0,
      endFraction: 0.75,
      label: "Cool demoulded financiers on wire grid (10 min before QA)",
      shortLabel: "Wire-grid cool (564 g)",
      equipment: "600 × 400 mm wire cooling grid",
      massNote: "Core cools to ambient before internal crumb inspection",
    },
    {
      id: "crumb-check-qa",
      operation: "finishCooling",
      startFraction: 0.75,
      endFraction: 1,
      label: "Halve 1 sample piece (23.5 g) for crumb & moisture QA check",
      shortLabel: "Crumb QA check (23.5 g sample)",
      equipment: "QA inspection station",
      massNote: "15 pieces accepted (352.5 g), 1 sampled (23.5 g), 8 rejected (188 g)",
    },
  ],
  pack: [
    {
      id: "pack-ballotins",
      operation: "pack",
      startFraction: 0,
      endFraction: 0.68,
      label: "Pack accepted financiers (352.5 g / 15 pcs) into gift ballotins",
      shortLabel: "Pack ballotin boxes (352.5 g)",
      equipment: "Packing table + Ohaus check-weigher",
      massNote: "352.5 g net packed weight across sealed gold-ribbon ballotins",
    },
    {
      id: "refill-vitrine",
      operation: "pack",
      startFraction: 0.68,
      endFraction: 1,
      label: "Carry fresh financiers to restock front pastry vitrine showcase",
      shortLabel: "Restock front pastry vitrine",
      equipment: "Refrigerated patisserie vitrine showcase",
      massNote: "Display trays replenished at storefront counter",
    },
  ],
};

export function plan61AOperationSubsteps(
  operation: Operation,
): readonly Plan61ASubstep[] {
  return PLAN_61A_SUBSTEPS_BY_OPERATION[operation];
}

export function plan61ASubstepAt(
  task: Pick<Process, "operation" | "start" | "arrival" | "end">,
  time: number,
): Plan61ASubstep & Readonly<{ progress: number; overallProgress: number }> {
  const steps = PLAN_61A_SUBSTEPS_BY_OPERATION[task.operation];
  const activeStart = task.start === 0 ? 0 : task.arrival;
  const duration = Math.max(1, task.end - activeStart);
  const overallProgress = Math.max(
    0,
    Math.min(1, (time - activeStart) / duration),
  );
  const matched =
    steps.find(
      (s) =>
        overallProgress >= s.startFraction && overallProgress <= s.endFraction,
    ) ?? steps[steps.length - 1]!;
  const span = Math.max(1e-4, matched.endFraction - matched.startFraction);
  const progress = Math.max(
    0,
    Math.min(1, (overallProgress - matched.startFraction) / span),
  );
  return {
    ...matched,
    progress,
    overallProgress,
  };
}
