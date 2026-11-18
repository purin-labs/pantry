import type { BakeryFloorPlanId } from "./bakery-room";

export type ApplianceFootprint = Readonly<{
  id: string;
  label: string;
  halfWidth: number;
  halfDepth: number;
  handoffOffset: readonly [number, number];
}>;

export type AppliancePose = Readonly<{
  id: ApplianceId;
  x: number;
  z: number;
  rotY: number;
}>;

export const APPLIANCE_FOOTPRINTS = {
  // Rehearsal / Workflow Simulator 5 stations + robot workcell (1.20 × 0.65 m JIS tables)
  stage: {
    id: "stage",
    label: "Batter staging",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  portion: {
    id: "portion",
    label: "Portioning",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  bake: {
    id: "bake",
    label: "Baking",
    halfWidth: 0.55,
    halfDepth: 0.425,
    handoffOffset: [0, 0.84],
  },
  cool: {
    id: "cool",
    label: "Cooling",
    halfWidth: 0.263,
    halfDepth: 0.366,
    handoffOffset: [0, 0.78],
  },
  pack: {
    id: "pack",
    label: "Packing",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, -0.76],
  },
  "robot-cell": {
    id: "robot-cell",
    label: "Robot cold cell",
    halfWidth: 0.55,
    halfDepth: 0.48,
    handoffOffset: [0, 0.8],
  },

  // Morning Shift stations & cobot cells
  "station-scale": {
    id: "station-scale",
    label: "Scale · Ohaus",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  "station-mixer": {
    id: "station-mixer",
    label: "Mixer · KPL9000S",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  "station-sesame-prep": {
    id: "station-sesame-prep",
    label: "Grinder & Blender",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  "station-hob": {
    id: "station-hob",
    label: "Induction Hobs",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  "station-oven": {
    id: "station-oven",
    label: "Oven · MBCO-4ME",
    halfWidth: 0.55,
    halfDepth: 0.425,
    handoffOffset: [0, 0.84],
  },
  "station-chiller": {
    id: "station-chiller",
    label: "Chiller & Rack",
    halfWidth: 0.78,
    halfDepth: 0.36,
    handoffOffset: [0, 0.78],
  },
  "station-wash": {
    id: "station-wash",
    label: "Wash · UC-L",
    halfWidth: 0.64,
    halfDepth: 0.33,
    handoffOffset: [0, 0.76],
  },
  "station-beverage-bar": {
    id: "station-beverage-bar",
    label: "Coffee, Tea & Frother",
    halfWidth: 0.78,
    halfDepth: 0.34,
    handoffOffset: [0, -0.76],
  },
  "espresso-cell": {
    id: "espresso-cell",
    label: "Cobot · espresso-cell",
    halfWidth: 0.26,
    halfDepth: 0.26,
    handoffOffset: [0, 0.58],
  },
  "pour-over-cell": {
    id: "pour-over-cell",
    label: "Cobot · pour-over-cell",
    halfWidth: 0.54,
    halfDepth: 0.34,
    handoffOffset: [0, -0.72],
  },
  "tea-pan-cell": {
    id: "tea-pan-cell",
    label: "Cobot · tea-pan-cell",
    halfWidth: 0.55,
    halfDepth: 0.46,
    handoffOffset: [0, 0.78],
  },
  "cell-1": {
    id: "cell-1",
    label: "Cold cell 1",
    halfWidth: 0.55,
    halfDepth: 0.46,
    handoffOffset: [0, 0.78],
  },
  "cell-2": {
    id: "cell-2",
    label: "Cold cell 2",
    halfWidth: 0.55,
    halfDepth: 0.46,
    handoffOffset: [0, 0.78],
  },

  // Financier Factory stations
  "station-preparation": {
    id: "station-preparation",
    label: "Preparation",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  "station-mould-cooling": {
    id: "station-mould-cooling",
    label: "Mould cooling",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, 0.76],
  },
  "station-cooling-rack": {
    id: "station-cooling-rack",
    label: "Cooling rack",
    halfWidth: 0.263,
    halfDepth: 0.366,
    handoffOffset: [0, 0.78],
  },
  "station-packing": {
    id: "station-packing",
    label: "Packing",
    halfWidth: 0.6,
    halfDepth: 0.325,
    handoffOffset: [0, -0.76],
  },

  // Store interior furnishings & decor
  "decor-bench": {
    id: "decor-bench",
    label: "Customer Café Bench",
    halfWidth: 0.56,
    halfDepth: 0.21,
    handoffOffset: [0, -0.5],
  },
  "decor-vitrine": {
    id: "decor-vitrine",
    label: "Pastry Vitrine Showcase",
    halfWidth: 0.56,
    halfDepth: 0.25,
    handoffOffset: [0, -0.55],
  },
  "decor-planter": {
    id: "decor-planter",
    label: "Olive Tree Planter",
    halfWidth: 0.2,
    halfDepth: 0.2,
    handoffOffset: [0, -0.35],
  },
} as const satisfies Readonly<Record<string, ApplianceFootprint>>;

export type ApplianceId = keyof typeof APPLIANCE_FOOTPRINTS;

export function isApplianceId(value: string): value is ApplianceId {
  return Object.hasOwn(APPLIANCE_FOOTPRINTS, value);
}

export const STORE_DECOR_IDS = [
  "decor-bench",
  "decor-vitrine",
  "decor-planter",
] as const;

const HALF_PI = Math.PI / 2;

export const DEFAULT_ROOM_APPLIANCE_LAYOUTS: Readonly<
  Record<BakeryFloorPlanId, Readonly<Record<ApplianceId, AppliancePose>>>
> = {
  "asakusabashi-t101940": {
    // Rehearsal / Workflow Simulator — perimeter wall stations around a clear central kitchen aisle
    stage: { id: "stage", x: -2.02, z: -0.35, rotY: HALF_PI },
    portion: { id: "portion", x: -2.02, z: 1.08, rotY: HALF_PI },
    bake: { id: "bake", x: 0.68, z: -1.08, rotY: 0 },
    cool: { id: "cool", x: 2.02, z: 0.45, rotY: -HALF_PI },
    pack: { id: "pack", x: 1.15, z: 2.02, rotY: 0 },
    "robot-cell": { id: "robot-cell", x: -0.35, z: 1.55, rotY: 0 },

    // Morning Shift
    "station-wash": { id: "station-wash", x: -1.15, z: -2.35, rotY: 0 },
    "station-scale": { id: "station-scale", x: -2.02, z: -0.42, rotY: HALF_PI },
    "station-mixer": { id: "station-mixer", x: -2.02, z: 0.92, rotY: HALF_PI },
    "station-sesame-prep": {
      id: "station-sesame-prep",
      x: 0.22,
      z: -1.12,
      rotY: 0,
    },
    "station-hob": { id: "station-hob", x: 1.25, z: -1.12, rotY: 0 },
    "station-oven": { id: "station-oven", x: 1.98, z: 0.52, rotY: -HALF_PI },
    "station-chiller": {
      id: "station-chiller",
      x: 2.02,
      z: 1.72,
      rotY: -HALF_PI,
    },
    "station-beverage-bar": {
      id: "station-beverage-bar",
      x: 0.85,
      z: 2.32,
      rotY: 0,
    },
    "espresso-cell": { id: "espresso-cell", x: 0.59, z: 2.36, rotY: 0 },
    "pour-over-cell": {
      id: "pour-over-cell",
      x: -1.92,
      z: 2.18,
      rotY: HALF_PI,
    },
    "tea-pan-cell": { id: "tea-pan-cell", x: 0.0, z: 0.15, rotY: 0 },
    "cell-1": { id: "cell-1", x: -0.75, z: 1.35, rotY: 0 },
    "cell-2": { id: "cell-2", x: 0.75, z: 1.35, rotY: 0 },

    // Financier Factory
    "station-preparation": {
      id: "station-preparation",
      x: -2.02,
      z: -0.35,
      rotY: HALF_PI,
    },
    "station-mould-cooling": {
      id: "station-mould-cooling",
      x: -2.02,
      z: 1.08,
      rotY: HALF_PI,
    },
    "station-cooling-rack": {
      id: "station-cooling-rack",
      x: 2.02,
      z: 0.45,
      rotY: -HALF_PI,
    },
    "station-packing": { id: "station-packing", x: 1.15, z: 2.02, rotY: 0 },

    // Interior furnishings
    "decor-bench": { id: "decor-bench", x: 1.48, z: 2.98, rotY: 0 },
    "decor-vitrine": { id: "decor-vitrine", x: -0.22, z: 2.94, rotY: 0 },
    "decor-planter": { id: "decor-planter", x: -1.68, z: 2.98, rotY: 0 },
  },

  "kinshicho-61146": {
    // Rehearsal / Workflow Simulator
    stage: { id: "stage", x: -1.52, z: -0.05, rotY: HALF_PI },
    portion: { id: "portion", x: -1.52, z: 1.58, rotY: HALF_PI },
    bake: { id: "bake", x: 1.46, z: -0.55, rotY: -HALF_PI },
    cool: { id: "cool", x: 1.55, z: 0.65, rotY: 0 },
    pack: { id: "pack", x: 0.85, z: 2.65, rotY: 0 },
    "robot-cell": { id: "robot-cell", x: 0.05, z: 1.25, rotY: 0 },

    // Morning Shift
    "station-wash": { id: "station-wash", x: -0.85, z: -1.55, rotY: 0 },
    "station-scale": { id: "station-scale", x: -1.52, z: -0.05, rotY: HALF_PI },
    "station-mixer": { id: "station-mixer", x: -1.52, z: 1.58, rotY: HALF_PI },
    "station-sesame-prep": {
      id: "station-sesame-prep",
      x: 0.25,
      z: -0.82,
      rotY: 0,
    },
    "station-hob": { id: "station-hob", x: 1.55, z: -0.62, rotY: -HALF_PI },
    "station-oven": { id: "station-oven", x: 1.46, z: 1.02, rotY: -HALF_PI },
    "station-chiller": { id: "station-chiller", x: 0.05, z: 0.22, rotY: 0 },
    "station-beverage-bar": {
      id: "station-beverage-bar",
      x: 0.85,
      z: 2.65,
      rotY: 0,
    },
    "espresso-cell": { id: "espresso-cell", x: 0.59, z: 2.69, rotY: 0 },
    "pour-over-cell": {
      id: "pour-over-cell",
      x: -1.52,
      z: 2.82,
      rotY: HALF_PI,
    },
    "tea-pan-cell": { id: "tea-pan-cell", x: 0.05, z: 1.35, rotY: 0 },
    "cell-1": { id: "cell-1", x: -0.55, z: 1.35, rotY: 0 },
    "cell-2": { id: "cell-2", x: 0.65, z: 1.35, rotY: 0 },

    // Financier Factory
    "station-preparation": {
      id: "station-preparation",
      x: -1.52,
      z: -0.05,
      rotY: HALF_PI,
    },
    "station-mould-cooling": {
      id: "station-mould-cooling",
      x: 0.15,
      z: 0.22,
      rotY: 0,
    },
    "station-cooling-rack": {
      id: "station-cooling-rack",
      x: 1.55,
      z: 2.0,
      rotY: 0,
    },
    "station-packing": { id: "station-packing", x: 0.85, z: 2.65, rotY: 0 },

    // Interior furnishings
    "decor-bench": { id: "decor-bench", x: -0.41, z: 3.16, rotY: 0 },
    "decor-vitrine": { id: "decor-vitrine", x: 0.15, z: 1.85, rotY: 0 },
    "decor-planter": { id: "decor-planter", x: 1.72, z: 3.18, rotY: 0 },
  },

  "machiya-sun-reve": {
    // Rehearsal / Workflow Simulator
    stage: { id: "stage", x: -1.58, z: -1.3, rotY: HALF_PI },
    portion: { id: "portion", x: -1.58, z: -0.08, rotY: HALF_PI },
    bake: { id: "bake", x: 0.5, z: -0.98, rotY: -HALF_PI },
    cool: { id: "cool", x: 0.56, z: 0.08, rotY: -HALF_PI },
    "robot-cell": { id: "robot-cell", x: -1.05, z: 1.04, rotY: Math.PI },
    pack: { id: "pack", x: -1.12, z: 2.66, rotY: 0 },

    // Morning Shift
    "station-wash": { id: "station-wash", x: -1.56, z: -1.78, rotY: HALF_PI },
    "station-scale": { id: "station-scale", x: -1.55, z: -0.26, rotY: HALF_PI },
    "station-mixer": {
      id: "station-mixer",
      x: -1.16,
      z: 1.12,
      rotY: Math.PI,
    },
    "station-chiller": {
      id: "station-chiller",
      x: 1.54,
      z: -2.97,
      rotY: -HALF_PI,
    },
    "station-oven": { id: "station-oven", x: 0.46, z: -0.96, rotY: -HALF_PI },
    "station-hob": { id: "station-hob", x: 0.52, z: 0.68, rotY: -HALF_PI },
    "station-sesame-prep": {
      id: "station-sesame-prep",
      x: 0.62,
      z: 2.54,
      rotY: -HALF_PI,
    },
    "station-beverage-bar": {
      id: "station-beverage-bar",
      x: -1.12,
      z: 2.86,
      rotY: Math.PI,
    },
    "espresso-cell": { id: "espresso-cell", x: -1.34, z: 2.86, rotY: 0 },
    "pour-over-cell": {
      id: "pour-over-cell",
      x: -1.34,
      z: 2.04,
      rotY: 0,
    },
    "tea-pan-cell": { id: "tea-pan-cell", x: -0.45, z: -1.1, rotY: 0 },
    "cell-1": { id: "cell-1", x: -0.45, z: -1.1, rotY: 0 },
    "cell-2": { id: "cell-2", x: -0.45, z: 0.14, rotY: 0 },

    // Financier Factory
    "station-preparation": {
      id: "station-preparation",
      x: -1.55,
      z: -0.26,
      rotY: HALF_PI,
    },
    "station-mould-cooling": {
      id: "station-mould-cooling",
      x: -1.16,
      z: 1.12,
      rotY: Math.PI,
    },
    "station-cooling-rack": {
      id: "station-cooling-rack",
      x: -0.18,
      z: 1.12,
      rotY: Math.PI,
    },
    "station-packing": { id: "station-packing", x: -1.12, z: 2.66, rotY: 0 },

    // Interior furnishings
    "decor-vitrine": { id: "decor-vitrine", x: -0.8, z: 3.56, rotY: 0 },
    "decor-bench": { id: "decor-bench", x: 0.38, z: 3.6, rotY: 0 },
    "decor-planter": { id: "decor-planter", x: -1.68, z: 3.6, rotY: 0 },
  },

  "hongo-8257562": {
    // Rehearsal / Workflow Simulator — B1F heavy-F&B column-free hall (4.05 × 5.48 m)
    stage: { id: "stage", x: -1.5, z: 0.48, rotY: HALF_PI },
    portion: { id: "portion", x: 1.48, z: 1.18, rotY: -HALF_PI },
    bake: { id: "bake", x: -1.4, z: 1.74, rotY: HALF_PI },
    cool: { id: "cool", x: -1.46, z: 2.78, rotY: HALF_PI },
    pack: { id: "pack", x: 0.1, z: -0.22, rotY: Math.PI },
    "robot-cell": { id: "robot-cell", x: 0.48, z: 3.34, rotY: Math.PI },

    // Morning Shift
    "station-wash": { id: "station-wash", x: -1.48, z: -0.04, rotY: HALF_PI },
    "station-oven": { id: "station-oven", x: -1.4, z: 1.24, rotY: HALF_PI },
    "station-hob": { id: "station-hob", x: -1.5, z: 2.48, rotY: HALF_PI },
    "station-scale": { id: "station-scale", x: 1.48, z: 1.18, rotY: -HALF_PI },
    "station-mixer": { id: "station-mixer", x: 1.48, z: 2.44, rotY: -HALF_PI },
    "station-sesame-prep": {
      id: "station-sesame-prep",
      x: -1.18,
      z: 3.52,
      rotY: Math.PI,
    },
    "station-chiller": {
      id: "station-chiller",
      x: 0.82,
      z: 3.5,
      rotY: Math.PI,
    },
    "station-beverage-bar": {
      id: "station-beverage-bar",
      x: -0.14,
      z: 0.02,
      rotY: Math.PI,
    },
    "espresso-cell": { id: "espresso-cell", x: 0.12, z: -0.02, rotY: Math.PI },
    "pour-over-cell": { id: "pour-over-cell", x: 0.02, z: 1.38, rotY: 0 },
    "tea-pan-cell": { id: "tea-pan-cell", x: 0.02, z: 1.24, rotY: Math.PI },
    "cell-1": { id: "cell-1", x: 0.02, z: 1.24, rotY: Math.PI },
    "cell-2": { id: "cell-2", x: 0.02, z: 2.42, rotY: Math.PI },

    // Financier Factory
    "station-preparation": {
      id: "station-preparation",
      x: 1.48,
      z: 1.18,
      rotY: -HALF_PI,
    },
    "station-mould-cooling": {
      id: "station-mould-cooling",
      x: 1.48,
      z: 2.44,
      rotY: -HALF_PI,
    },
    "station-cooling-rack": {
      id: "station-cooling-rack",
      x: -0.2,
      z: 3.5,
      rotY: Math.PI,
    },
    "station-packing": { id: "station-packing", x: 0.1, z: -0.22, rotY: Math.PI },

    // Interior furnishings (north customer entry vestibule & east showcase)
    "decor-bench": { id: "decor-bench", x: -0.26, z: -1.1, rotY: Math.PI },
    "decor-vitrine": { id: "decor-vitrine", x: 1.58, z: -0.24, rotY: HALF_PI },
    "decor-planter": { id: "decor-planter", x: 1.66, z: -1.1, rotY: 0 },
  },

  reference: {
    // Rehearsal / Workflow Simulator
    stage: { id: "stage", x: -3.5, z: -2.0, rotY: 0 },
    portion: { id: "portion", x: -1.5, z: -2.0, rotY: 0 },
    bake: { id: "bake", x: 0.7, z: -2.0, rotY: 0 },
    cool: { id: "cool", x: 3.0, z: -2.0, rotY: 0 },
    pack: { id: "pack", x: 3.0, z: 1.5, rotY: 0 },
    "robot-cell": { id: "robot-cell", x: -2.0, z: 1.3, rotY: 0 },

    // Morning Shift
    "station-scale": { id: "station-scale", x: -4.6, z: -2.2, rotY: 0 },
    "station-mixer": { id: "station-mixer", x: -2.8, z: -2.2, rotY: 0 },
    "station-sesame-prep": {
      id: "station-sesame-prep",
      x: -1.0,
      z: -2.2,
      rotY: 0,
    },
    "station-hob": { id: "station-hob", x: 1.0, z: -2.2, rotY: 0 },
    "station-oven": { id: "station-oven", x: 3.0, z: -2.2, rotY: 0 },
    "station-chiller": { id: "station-chiller", x: 4.8, z: -2.2, rotY: 0 },
    "station-wash": { id: "station-wash", x: -3.6, z: 2.0, rotY: 0 },
    "station-beverage-bar": {
      id: "station-beverage-bar",
      x: 1.35,
      z: 2.0,
      rotY: 0,
    },
    "espresso-cell": { id: "espresso-cell", x: 1.09, z: 2.04, rotY: 0 },
    "pour-over-cell": { id: "pour-over-cell", x: -1.85, z: 2.0, rotY: 0 },
    "tea-pan-cell": { id: "tea-pan-cell", x: -0.6, z: 0.5, rotY: 0 },
    "cell-1": { id: "cell-1", x: -2.0, z: 0.0, rotY: 0 },
    "cell-2": { id: "cell-2", x: 2.0, z: 0.0, rotY: 0 },

    // Financier Factory
    "station-preparation": {
      id: "station-preparation",
      x: -4.2,
      z: -1.8,
      rotY: 0,
    },
    "station-mould-cooling": {
      id: "station-mould-cooling",
      x: 1.6,
      z: -1.8,
      rotY: 0,
    },
    "station-cooling-rack": {
      id: "station-cooling-rack",
      x: 3.6,
      z: -1.8,
      rotY: 0,
    },
    "station-packing": { id: "station-packing", x: 2.6, z: 1.8, rotY: 0 },

    // Interior furnishings
    "decor-bench": { id: "decor-bench", x: 0.0, z: 3.3, rotY: 0 },
    "decor-vitrine": { id: "decor-vitrine", x: 2.2, z: 3.2, rotY: 0 },
    "decor-planter": { id: "decor-planter", x: -3.8, z: 3.3, rotY: 0 },
  },
};

export const REHEARSAL_APPLIANCE_IDS: readonly ApplianceId[] = [
  "stage",
  "portion",
  "bake",
  "cool",
  "pack",
  "robot-cell",
  "decor-bench",
  "decor-vitrine",
  "decor-planter",
];

export const MORNING_SHIFT_APPLIANCE_IDS: readonly ApplianceId[] = [
  "station-scale",
  "station-mixer",
  "station-sesame-prep",
  "station-hob",
  "station-oven",
  "station-chiller",
  "station-wash",
  "station-beverage-bar",
  "pour-over-cell",
];

export const FINANCIER_FACTORY_APPLIANCE_IDS: readonly ApplianceId[] = [
  "station-preparation",
  "station-hob",
  "station-oven",
  "station-mould-cooling",
  "station-cooling-rack",
  "station-wash",
  "station-packing",
];
