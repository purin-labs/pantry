/** Assumed bakery context, centered on the scene origin in the X/Z floor plane. */
export const bakeryRoom = {
  width: 11,
  depth: 7,
  rearWallHeight: 1.1,
  rearWallThickness: 0.12,
} as const;

/** Shared metre spacing, aligned to the world origin in every spatial view. */
export const bakeryGrid = { primary: 1, secondary: 0.5 } as const;

export type BakeryFloorPlanId =
  | "reference"
  | "kinshicho-61146"
  | "asakusabashi-t101940"
  | "machiya-sun-reve"
  | "hongo-8257562";

export type FloorZoneKind = "main" | "wet" | "toilet" | "corridor" | "closet";

export type FloorPlanZone = Readonly<{
  id: string;
  label: string;
  kind: FloorZoneKind;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}>;

export type FloorPlanWall = Readonly<{
  id: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  thickness: number;
  height: number;
  exterior: boolean;
}>;

export type FloorPlanColumn = Readonly<{
  id: string;
  label: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  height: number;
}>;

export type FloorPlanDoor = Readonly<{
  id: string;
  label: string;
  hingeX: number;
  hingeZ: number;
  leafX: number;
  leafZ: number;
  width: number;
  height: number;
  swingRad: number;
}>;

export type FloorPlanWindow = Readonly<{
  id: string;
  label: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  sillHeight: number;
  headHeight: number;
  panels: number;
  storefront: boolean;
}>;

export type FloorPlanFixture = Readonly<{
  id: string;
  label: string;
  kind: "sink-counter" | "toilet" | "pipe-shaft";
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  height: number;
  facing: "north" | "south" | "east" | "west";
}>;

export type FloorPlanStaircase = Readonly<{
  id: string;
  label: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  turnSplitX: number;
  lowerTopZ: number;
  riseHeight: number;
}>;

export type BakeryFloorPlanSpec = Readonly<{
  id: BakeryFloorPlanId;
  label: string;
  shortLabel: string;
  location: string;
  sourceUrl: string;
  areaSqm: number;
  areaTsubo: number;
  width: number;
  depth: number;
  ceilingHeight: number;
  cutawayWallHeight: number;
  clearMainSpan: Readonly<{ width: number; depth: number; areaSqm: number }>;
  zones: readonly FloorPlanZone[];
  voids?: readonly Readonly<{ x0: number; z0: number; x1: number; z1: number }>[];
  walls: readonly FloorPlanWall[];
  columns: readonly FloorPlanColumn[];
  doors: readonly FloorPlanDoor[];
  windows: readonly FloorPlanWindow[];
  fixtures: readonly FloorPlanFixture[];
  stairs?: readonly FloorPlanStaircase[];
}>;

export const BAKERY_FLOOR_PLANS: Readonly<
  Record<BakeryFloorPlanId, BakeryFloorPlanSpec>
> = {
  reference: {
    id: "reference",
    label: "Reference simulation room (11.0 × 7.0 m)",
    shortLabel: "Reference (77 m²)",
    location: "Assumed simulation workcell floor",
    sourceUrl: "",
    areaSqm: 77.0,
    areaTsubo: 23.29,
    width: bakeryRoom.width,
    depth: bakeryRoom.depth,
    ceilingHeight: 2.7,
    cutawayWallHeight: bakeryRoom.rearWallHeight,
    clearMainSpan: { width: 11.0, depth: 7.0, areaSqm: 77.0 },
    zones: [
      {
        id: "main-floor",
        label: "Main production floor",
        kind: "main",
        x0: -5.5,
        z0: -3.5,
        x1: 5.5,
        z1: 3.5,
      },
    ],
    walls: [
      {
        id: "rear-wall",
        x0: -5.5,
        z0: -3.5,
        x1: 5.5,
        z1: -3.5,
        thickness: bakeryRoom.rearWallThickness,
        height: bakeryRoom.rearWallHeight,
        exterior: true,
      },
    ],
    columns: [],
    doors: [],
    windows: [],
    fixtures: [],
  },
  "kinshicho-61146": {
    id: "kinshicho-61146",
    label: "Kinshicho 61146 · Taihei 4-chome 1F (29.71 m²)",
    shortLabel: "Kinshicho 61146 (29.7 m²)",
    location: "Sumida-ku Taihei 4-chome · 5 min from Kinshicho Sta.",
    sourceUrl: "https://inuki-tenpo-r.jp/buy_shop/61146",
    areaSqm: 29.71,
    areaTsubo: 8.98,
    width: 4.2,
    depth: 7.08,
    ceilingHeight: 2.65,
    cutawayWallHeight: 1.15,
    clearMainSpan: { width: 4.2, depth: 5.1, areaSqm: 21.42 },
    zones: [
      {
        id: "rear-corridor",
        label: "Rear service corridor",
        kind: "corridor",
        x0: -2.1,
        z0: -3.54,
        x1: 2.1,
        z1: -2.65,
      },
      {
        id: "wet-kitchen",
        label: "Rear sink & utility bay",
        kind: "wet",
        x0: -2.1,
        z0: -2.65,
        x1: 1.18,
        z1: -1.48,
      },
      {
        id: "toilet-room",
        label: "Toilet enclosure",
        kind: "toilet",
        x0: 1.18,
        z0: -2.65,
        x1: 2.1,
        z1: -1.48,
      },
      {
        id: "main-floor",
        label: "Main bakery & café floor",
        kind: "main",
        x0: -2.1,
        z0: -1.48,
        x1: 2.1,
        z1: 3.54,
      },
    ],
    walls: [
      // Outer North (rear corridor back) wall
      {
        id: "wall-north",
        x0: -2.1,
        z0: -3.54,
        x1: 2.1,
        z1: -3.54,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // Inner partition between rear corridor and shop (with door gap x=-1.80..-1.02)
      {
        id: "wall-corridor-left",
        x0: -2.1,
        z0: -2.65,
        x1: -1.8,
        z1: -2.65,
        thickness: 0.12,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-corridor-right",
        x0: -1.02,
        z0: -2.65,
        x1: 2.1,
        z1: -2.65,
        thickness: 0.12,
        height: 1.15,
        exterior: false,
      },
      // West (left) exterior wall (with rear corridor door gap z=-3.48..-2.72)
      {
        id: "wall-west-main",
        x0: -2.1,
        z0: -2.65,
        x1: -2.1,
        z1: 3.54,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // East (right) exterior wall (with rear corridor door gap z=-3.48..-2.72)
      {
        id: "wall-east-main",
        x0: 2.1,
        z0: -2.65,
        x1: 2.1,
        z1: 3.54,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // Toilet enclosure west & south walls
      {
        id: "wall-toilet-west-top",
        x0: 1.18,
        z0: -2.65,
        x1: 1.18,
        z1: -2.15,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-south",
        x0: 1.18,
        z0: -1.48,
        x1: 2.1,
        z1: -1.48,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      // South (street front) wall segments around entrance door (x=-2.02..-1.22) and window (x=-1.00..0.18)
      {
        id: "wall-south-post",
        x0: -1.22,
        z0: 3.54,
        x1: -1.0,
        z1: 3.54,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-south-window-sill",
        x0: -1.0,
        z0: 3.54,
        x1: 0.18,
        z1: 3.54,
        thickness: 0.15,
        height: 0.85,
        exterior: true,
      },
      {
        id: "wall-south-east",
        x0: 0.18,
        z0: 3.54,
        x1: 2.1,
        z1: 3.54,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
    ],
    columns: [
      {
        id: "pilaster-west",
        label: "West wall pilaster",
        x0: -2.1,
        z0: -1.63,
        x1: -1.85,
        z1: -0.91,
        height: 1.15,
      },
      {
        id: "pipe-shaft-toilet",
        label: "Toilet pipe shaft",
        x0: 1.9,
        z0: -1.95,
        x1: 2.1,
        z1: -1.48,
        height: 1.15,
      },
    ],
    doors: [
      {
        id: "door-front-entry",
        label: "Street entrance door",
        hingeX: -2.02,
        hingeZ: 3.54,
        leafX: -2.02,
        leafZ: 4.34,
        width: 0.8,
        height: 2.1,
        swingRad: -1.5708,
      },
      {
        id: "door-corridor-access",
        label: "Rear corridor door",
        hingeX: -1.8,
        hingeZ: -2.65,
        leafX: -1.8,
        leafZ: -1.87,
        width: 0.78,
        height: 2.0,
        swingRad: -1.5708,
      },
      {
        id: "door-toilet",
        label: "Toilet door",
        hingeX: 1.18,
        hingeZ: -2.15,
        leafX: 0.53,
        leafZ: -2.15,
        width: 0.65,
        height: 2.0,
        swingRad: -1.5708,
      },
      {
        id: "door-rear-west",
        label: "Rear corridor west exit",
        hingeX: -2.1,
        hingeZ: -3.48,
        leafX: -1.36,
        leafZ: -3.48,
        width: 0.74,
        height: 2.0,
        swingRad: 1.5708,
      },
      {
        id: "door-rear-east",
        label: "Rear corridor east exit",
        hingeX: 2.1,
        hingeZ: -2.72,
        leafX: 1.36,
        leafZ: -2.72,
        width: 0.74,
        height: 2.0,
        swingRad: 1.5708,
      },
    ],
    windows: [
      {
        id: "window-street-front",
        label: "Street takeaway / display window",
        x0: -1.0,
        z0: 3.54,
        x1: 0.18,
        z1: 3.54,
        sillHeight: 0.85,
        headHeight: 2.1,
        panels: 2,
        storefront: true,
      },
    ],
    fixtures: [
      {
        id: "fixture-rear-sink",
        label: "Existing 2-bay kitchen sink counter",
        kind: "sink-counter",
        x0: -0.95,
        z0: -2.6,
        x1: 0.25,
        z1: -2.0,
        height: 0.85,
        facing: "south",
      },
      {
        id: "fixture-toilet",
        label: "Existing toilet",
        kind: "toilet",
        x0: 1.44,
        z0: -2.55,
        x1: 1.84,
        z1: -1.9,
        height: 0.78,
        facing: "south",
      },
    ],
  },
  "asakusabashi-t101940": {
    id: "asakusabashi-t101940",
    label: "Asakusabashi t101940 · Higashi-Kanda Naito Bldg 1F (34.71 m²)",
    shortLabel: "Asakusabashi t101940 (34.7 m²)",
    location: "Chiyoda-ku Higashi-Kanda 3-4-11 · 4 min from Asakusabashi Sta.",
    sourceUrl: "https://www.i-tenpo.com/t101940",
    areaSqm: 34.71,
    areaTsubo: 10.5,
    width: 5.11,
    depth: 6.8,
    ceilingHeight: 2.7,
    cutawayWallHeight: 1.15,
    clearMainSpan: { width: 5.11, depth: 5.3, areaSqm: 27.08 },
    zones: [
      {
        id: "wet-kitchen",
        label: "Rear pantry & sink room",
        kind: "wet",
        x0: -2.555,
        z0: -3.4,
        x1: 1.245,
        z1: -1.68,
      },
      {
        id: "toilet-room",
        label: "Rear toilet room",
        kind: "toilet",
        x0: 1.245,
        z0: -3.4,
        x1: 2.555,
        z1: -1.68,
      },
      {
        id: "main-floor",
        label: "Main café & production hall",
        kind: "main",
        x0: -2.555,
        z0: -1.68,
        x1: 2.555,
        z1: 3.4,
      },
    ],
    walls: [
      // North (rear) exterior wall
      {
        id: "wall-north",
        x0: -2.555,
        z0: -3.4,
        x1: 2.555,
        z1: -3.4,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      // West (left) exterior wall
      {
        id: "wall-west",
        x0: -2.555,
        z0: -3.4,
        x1: -2.555,
        z1: 3.4,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      // East (right) exterior wall above & below side entrance door (z=-1.11..-0.12)
      {
        id: "wall-east-north",
        x0: 2.555,
        z0: -3.4,
        x1: 2.555,
        z1: -1.11,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-east-south",
        x0: 2.555,
        z0: -0.12,
        x1: 2.555,
        z1: 3.4,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      // Interior partition separating rear pantry/toilet from main hall (x=-0.42..2.555 at z=-1.68)
      {
        id: "wall-pantry-partition",
        x0: -0.42,
        z0: -1.68,
        x1: 2.555,
        z1: -1.68,
        thickness: 0.15,
        height: 1.15,
        exterior: false,
      },
      // Toilet divider wall (x=1.245, with door gap z=-2.35..-1.70)
      {
        id: "wall-toilet-divider",
        x0: 1.245,
        z0: -3.4,
        x1: 1.245,
        z1: -2.35,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      // South (front) storefront mullion base
      {
        id: "wall-south-sill",
        x0: -2.08,
        z0: 3.4,
        x1: 2.555,
        z1: 3.4,
        thickness: 0.14,
        height: 0.12,
        exterior: true,
      },
    ],
    columns: [
      {
        id: "column-west-mid",
        label: "West structural column",
        x0: -2.555,
        z0: -1.68,
        x1: -1.84,
        z1: -1.16,
        height: 1.15,
      },
      {
        id: "column-east-mid",
        label: "East structural column",
        x0: 1.86,
        z0: -1.68,
        x1: 2.555,
        z1: -1.16,
        height: 1.15,
      },
      {
        id: "column-southwest-front",
        label: "Southwest storefront pier",
        x0: -2.555,
        z0: 3.1,
        x1: -2.08,
        z1: 3.55,
        height: 1.15,
      },
    ],
    doors: [
      {
        id: "door-east-side",
        label: "Side service / lobby door",
        hingeX: 2.555,
        hingeZ: -1.11,
        leafX: 3.54,
        leafZ: -1.11,
        width: 0.99,
        height: 2.1,
        swingRad: 1.5708,
      },
      {
        id: "door-toilet",
        label: "Toilet door",
        hingeX: 1.245,
        hingeZ: -2.35,
        leafX: 1.88,
        leafZ: -2.35,
        width: 0.65,
        height: 2.0,
        swingRad: 1.5708,
      },
      {
        id: "door-storefront-double",
        label: "Glass storefront entrance",
        hingeX: -2.02,
        hingeZ: 3.4,
        leafX: -2.02,
        leafZ: 4.3,
        width: 0.9,
        height: 2.15,
        swingRad: -1.5708,
      },
    ],
    windows: [
      {
        id: "window-south-storefront",
        label: "4-bay full-height glass storefront",
        x0: -2.08,
        z0: 3.4,
        x1: 2.38,
        z1: 3.4,
        sillHeight: 0.12,
        headHeight: 2.35,
        panels: 4,
        storefront: true,
      },
      {
        id: "window-north-pantry",
        label: "Rear pantry window",
        x0: -2.04,
        z0: -3.4,
        x1: -0.88,
        z1: -3.4,
        sillHeight: 1.0,
        headHeight: 1.9,
        panels: 2,
        storefront: false,
      },
    ],
    fixtures: [
      {
        id: "fixture-pantry-sink",
        label: "Existing rear pantry sink counter",
        kind: "sink-counter",
        x0: 0.38,
        z0: -3.32,
        x1: 1.18,
        z1: -2.72,
        height: 0.85,
        facing: "south",
      },
      {
        id: "fixture-toilet",
        label: "Existing rear toilet",
        kind: "toilet",
        x0: 1.75,
        z0: -2.85,
        x1: 2.45,
        z1: -2.35,
        height: 0.78,
        facing: "west",
      },
    ],
  },

  "machiya-sun-reve": {
    id: "machiya-sun-reve",
    label: "Machiya Sun Reve · Sun Reve 1F (25.74 m²)",
    shortLabel: "Machiya Sun Reve (25.7 m²)",
    location: "Arakawa-ku Machiya 2-17-7 · 6 min from Machiya Sta.",
    sourceUrl: "",
    areaSqm: 25.74,
    areaTsubo: 7.79,
    width: 4.06,
    depth: 7.9,
    ceilingHeight: 2.6,
    cutawayWallHeight: 1.15,
    clearMainSpan: { width: 3.14, depth: 5.94, areaSqm: 18.65 },
    zones: [
      {
        id: "wet-kitchen",
        label: "Rear wet kitchen alcove",
        kind: "wet",
        x0: -2.03,
        z0: -3.15,
        x1: -0.94,
        z1: -1.99,
      },
      {
        id: "toilet-room",
        label: "Independent washroom & toilet (洗面所独立)",
        kind: "toilet",
        x0: -0.94,
        z0: -3.95,
        x1: 0.2,
        z1: -2.53,
      },
      {
        id: "storage-warehouse",
        label: "Rear storage warehouse (倉庫)",
        kind: "closet",
        x0: 0.2,
        z0: -3.95,
        x1: 2.03,
        z1: -1.99,
      },
      {
        id: "rear-vestibule",
        label: "Washroom & storage vestibule",
        kind: "main",
        x0: -0.94,
        z0: -2.53,
        x1: 0.2,
        z1: -1.99,
      },
      {
        id: "main-floor",
        label: "Main production kitchen (店舗)",
        kind: "main",
        x0: -2.03,
        z0: -1.99,
        x1: 1.11,
        z1: 1.6,
      },
      {
        id: "front-counter-hall",
        label: "Customer counter & takeaway room (カウンター)",
        kind: "main",
        x0: -2.03,
        z0: 1.6,
        x1: 1.11,
        z1: 3.95,
      },
    ],
    voids: [
      // Northwest exterior shared passage (共有スペース)
      { x0: -2.03, z0: -3.95, x1: -0.94, z1: -3.15 },
      // Southeast non-rented building setback south of storage warehouse
      { x0: 1.11, z0: -1.99, x1: 2.03, z1: 3.95 },
    ],
    walls: [
      // North rear exterior wall of toilet & warehouse
      {
        id: "wall-north-rear",
        x0: -0.94,
        z0: -3.95,
        x1: 2.03,
        z1: -3.95,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // Rear-left wet alcove north wall bordering shared passage
      {
        id: "wall-alcove-north",
        x0: -2.03,
        z0: -3.15,
        x1: -0.94,
        z1: -3.15,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // West wall north & south of shared-passage service door (z=-2.35..-1.57)
      {
        id: "wall-west-north",
        x0: -2.03,
        z0: -3.15,
        x1: -2.03,
        z1: -2.35,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-west-south",
        x0: -2.03,
        z0: -1.57,
        x1: -2.03,
        z1: 3.95,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // Storage warehouse east & south exterior walls
      {
        id: "wall-warehouse-east",
        x0: 2.03,
        z0: -3.95,
        x1: 2.03,
        z1: -1.99,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-warehouse-south",
        x0: 1.11,
        z0: -1.99,
        x1: 2.03,
        z1: -1.99,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      // Main shop & front counter east exterior wall
      {
        id: "wall-east-main",
        x0: 1.11,
        z0: -1.99,
        x1: 1.11,
        z1: 3.95,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      // Washroom & toilet enclosure walls
      {
        id: "wall-toilet-west",
        x0: -0.94,
        z0: -3.95,
        x1: -0.94,
        z1: -2.53,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-east",
        x0: 0.2,
        z0: -3.95,
        x1: 0.2,
        z1: -2.53,
        thickness: 0.12,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-inner",
        x0: -0.94,
        z0: -3.15,
        x1: -0.38,
        z1: -3.15,
        thickness: 0.09,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-washroom-south",
        x0: -0.94,
        z0: -2.53,
        x1: -0.48,
        z1: -2.53,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      // Angled jamb walls framing the chamfered storage warehouse doorway
      {
        id: "wall-warehouse-diag-nw",
        x0: 0.2,
        z0: -2.53,
        x1: 0.312,
        z1: -2.464,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-warehouse-diag-se",
        x0: 0.974,
        z0: -2.071,
        x1: 1.11,
        z1: -1.99,
        thickness: 0.1,
        height: 1.15,
        exterior: false,
      },
      // Partition wall with pass-through window separating kitchen & counter room
      {
        id: "wall-counter-partition",
        x0: -2.03,
        z0: 1.6,
        x1: 0.02,
        z1: 1.6,
        thickness: 0.12,
        height: 1.15,
        exterior: false,
      },
      // South streetfront piers & glazing sill (2.22 m storefront opening x=-1.57..0.65)
      {
        id: "wall-south-west-pier",
        x0: -2.03,
        z0: 3.95,
        x1: -1.57,
        z1: 3.95,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-south-sill",
        x0: -0.67,
        z0: 3.95,
        x1: 0.65,
        z1: 3.95,
        thickness: 0.14,
        height: 0.12,
        exterior: true,
      },
      {
        id: "wall-south-east-pier",
        x0: 0.65,
        z0: 3.95,
        x1: 1.11,
        z1: 3.95,
        thickness: 0.15,
        height: 1.15,
        exterior: true,
      },
    ],
    columns: [
      {
        id: "pilaster-east-chase",
        label: "East kitchen plumbing & exhaust chase",
        x0: 0.97,
        z0: -1.55,
        x1: 1.11,
        z1: 1.52,
        height: 1.15,
      },
    ],
    doors: [
      {
        id: "door-front-entry",
        label: "Streetfront glass entrance",
        hingeX: -1.57,
        hingeZ: 3.95,
        leafX: -1.57,
        leafZ: 4.85,
        width: 0.9,
        height: 2.15,
        swingRad: -1.5708,
      },
      {
        id: "door-west-shared",
        label: "Shared passage service door",
        hingeX: -2.03,
        hingeZ: -2.35,
        leafX: -2.81,
        leafZ: -2.35,
        width: 0.78,
        height: 2.0,
        swingRad: -1.5708,
      },
      {
        id: "door-toilet",
        label: "Washroom & toilet door",
        hingeX: 0.16,
        hingeZ: -2.53,
        leafX: 0.16,
        leafZ: -1.89,
        width: 0.64,
        height: 2.0,
        swingRad: 1.5708,
      },
      {
        id: "door-warehouse",
        label: "Storage warehouse door (倉庫)",
        hingeX: 0.312,
        hingeZ: -2.464,
        leafX: -0.08,
        leafZ: -1.802,
        width: 0.77,
        height: 2.0,
        swingRad: -1.5708,
      },
    ],
    windows: [
      {
        id: "window-south-storefront",
        label: "2.22 m aluminum-framed streetfront glazing",
        x0: -0.67,
        z0: 3.95,
        x1: 0.65,
        z1: 3.95,
        sillHeight: 0.12,
        headHeight: 2.15,
        panels: 2,
        storefront: true,
      },
      {
        id: "window-counter-pass",
        label: "Kitchen-to-counter pass-through window",
        x0: -0.72,
        z0: 1.6,
        x1: -0.26,
        z1: 1.6,
        sillHeight: 1.05,
        headHeight: 1.65,
        panels: 1,
        storefront: false,
      },
      {
        id: "window-north-toilet",
        label: "North toilet louver window",
        x0: -0.76,
        z0: -3.95,
        x1: -0.34,
        z1: -3.95,
        sillHeight: 1.35,
        headHeight: 1.85,
        panels: 1,
        storefront: false,
      },
    ],
    fixtures: [
      {
        id: "fixture-kitchen-sink",
        label: "Existing kitchen sink & utility hookup",
        kind: "sink-counter",
        x0: -1.94,
        z0: -3.07,
        x1: -1.1,
        z1: -2.52,
        height: 0.85,
        facing: "south",
      },
      {
        id: "fixture-washroom-basin",
        label: "Independent washroom basin (洗面所独立)",
        kind: "sink-counter",
        x0: -0.88,
        z0: -3.08,
        x1: -0.4,
        z1: -2.58,
        height: 0.82,
        facing: "east",
      },
      {
        id: "fixture-toilet",
        label: "Dedicated toilet (専用トイレ)",
        kind: "toilet",
        x0: -0.84,
        z0: -3.78,
        x1: -0.22,
        z1: -3.28,
        height: 0.78,
        facing: "east",
      },
    ],
  },

  "hongo-8257562": {
    id: "hongo-8257562",
    label: "Hongo 8257562 · HP Hongo Bldg B1F (30.10 m²)",
    shortLabel: "Hongo 8257562 (30.1 m²)",
    location: "Bunkyo-ku Hongo 3-24-2 · 7 min from Hongo-sanchome Sta.",
    sourceUrl: "",
    areaSqm: 30.1,
    areaTsubo: 9.11,
    width: 4.05,
    depth: 8.08,
    ceilingHeight: 2.75,
    cutawayWallHeight: 1.15,
    clearMainSpan: { width: 4.05, depth: 5.48, areaSqm: 22.19 },
    zones: [
      {
        id: "ps-closet",
        label: "Pipe shaft enclosure (PS)",
        kind: "closet",
        x0: -2.025,
        z0: -4.04,
        x1: -1.32,
        z1: -3.09,
      },
      {
        id: "toilet-room",
        label: "Dedicated restroom & handwash (トイレ)",
        kind: "toilet",
        x0: -1.32,
        z0: -4.04,
        x1: 0.47,
        z1: -2.95,
      },
      {
        id: "stair-landing-upper",
        label: "B1F winder stair & restroom landing",
        kind: "corridor",
        x0: -2.025,
        z0: -3.09,
        x1: 0.47,
        z1: -2.37,
      },
      {
        id: "entry-foyer",
        label: "Dedicated B1F stair hall & double-door foyer (前室)",
        kind: "corridor",
        x0: -2.025,
        z0: -2.37,
        x1: 2.025,
        z1: -1.44,
      },
      {
        id: "wet-kitchen",
        label: "Northwest sink & dishwash utility bay",
        kind: "wet",
        x0: -2.025,
        z0: -1.44,
        x1: -0.78,
        z1: -0.62,
      },
      {
        id: "main-entry-vestibule",
        label: "North customer entry & vitrine bay",
        kind: "main",
        x0: -0.78,
        z0: -1.44,
        x1: 2.025,
        z1: -0.62,
      },
      {
        id: "main-floor",
        label: "Main heavy-F&B shop & kitchen hall (店舗)",
        kind: "main",
        x0: -2.025,
        z0: -0.62,
        x1: 2.025,
        z1: 4.04,
      },
    ],
    voids: [
      // Northeast non-rented building step-in above east entry foyer
      { x0: 0.47, z0: -4.04, x1: 2.025, z1: -2.37 },
    ],
    walls: [
      // North rear SRC retaining wall behind PS & restroom
      {
        id: "wall-north-rear",
        x0: -2.025,
        z0: -4.04,
        x1: 0.47,
        z1: -4.04,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      // Stepped northeast exterior walls around building cutout
      {
        id: "wall-toilet-east-ext",
        x0: 0.47,
        z0: -4.04,
        x1: 0.47,
        z1: -2.37,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-foyer-north-ext",
        x0: 0.47,
        z0: -2.37,
        x1: 2.025,
        z1: -2.37,
        thickness: 0.16,
        height: 1.15,
        exterior: true,
      },
      // West, east & south buried SRC basement retaining walls
      {
        id: "wall-west-ext",
        x0: -2.025,
        z0: -4.04,
        x1: -2.025,
        z1: 4.04,
        thickness: 0.18,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-east-ext",
        x0: 2.025,
        z0: -2.37,
        x1: 2.025,
        z1: 4.04,
        thickness: 0.18,
        height: 1.15,
        exterior: true,
      },
      {
        id: "wall-south-ext",
        x0: -2.025,
        z0: 4.04,
        x1: 2.025,
        z1: 4.04,
        thickness: 0.18,
        height: 1.15,
        exterior: true,
      },
      // Enclosed northwest pipe shaft (PS) & stepped restroom partition walls
      {
        id: "wall-ps-east",
        x0: -1.32,
        z0: -4.04,
        x1: -1.32,
        z1: -3.09,
        thickness: 0.11,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-south-west",
        x0: -2.025,
        z0: -3.09,
        x1: -0.38,
        z1: -3.09,
        thickness: 0.11,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-jog",
        x0: -0.38,
        z0: -3.09,
        x1: -0.38,
        z1: -2.95,
        thickness: 0.11,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-jamb-west",
        x0: -0.38,
        z0: -2.95,
        x1: -0.24,
        z1: -2.95,
        thickness: 0.11,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-toilet-jamb-east",
        x0: 0.4,
        z0: -2.95,
        x1: 0.47,
        z1: -2.95,
        thickness: 0.11,
        height: 1.15,
        exterior: false,
      },
      // Interior partition between dedicated B1F stair foyer & main shop hall (double door gap x=0.52..1.60)
      {
        id: "wall-foyer-partition-west",
        x0: -2.025,
        z0: -1.44,
        x1: 0.52,
        z1: -1.44,
        thickness: 0.14,
        height: 1.15,
        exterior: false,
      },
      {
        id: "wall-foyer-partition-east",
        x0: 1.6,
        z0: -1.44,
        x1: 2.025,
        z1: -1.44,
        thickness: 0.14,
        height: 1.15,
        exterior: false,
      },
    ],
    columns: [],
    stairs: [
      {
        id: "stair-b1f-winder",
        label: "Dedicated B1F quarter-turn winder staircase to 1F",
        x0: -1.95,
        z0: -3.02,
        x1: -0.37,
        z1: -1.51,
        turnSplitX: -1.13,
        lowerTopZ: -2.26,
        riseHeight: 2.55,
      },
    ],
    doors: [
      {
        id: "door-front-entry",
        label: "Main foyer entrance leaf (親子扉・親扉)",
        hingeX: 1.6,
        hingeZ: -1.44,
        leafX: 1.6,
        leafZ: -2.18,
        width: 0.74,
        height: 2.1,
        swingRad: -1.5708,
      },
      {
        id: "door-foyer-subleaf",
        label: "Side foyer sub-leaf (親子扉・子扉)",
        hingeX: 0.52,
        hingeZ: -1.44,
        leafX: 0.52,
        leafZ: -1.78,
        width: 0.34,
        height: 2.1,
        swingRad: 1.5708,
      },
      {
        id: "door-toilet",
        label: "Restroom door (トイレ扉)",
        hingeX: -0.24,
        hingeZ: -2.95,
        leafX: -0.24,
        leafZ: -2.31,
        width: 0.64,
        height: 2.0,
        swingRad: -1.5708,
      },
    ],
    windows: [],
    fixtures: [
      {
        id: "fixture-kitchen-sink",
        label: "2-bay kitchen sink & grease-trap utility hookup",
        kind: "sink-counter",
        x0: -1.86,
        z0: -1.33,
        x1: -0.92,
        z1: -0.77,
        height: 0.85,
        facing: "south",
      },
      {
        id: "fixture-ps-shaft",
        label: "Northwest vertical plumbing & exhaust shaft (PS)",
        kind: "pipe-shaft",
        x0: -1.98,
        z0: -3.98,
        x1: -1.36,
        z1: -3.14,
        height: 2.35,
        facing: "south",
      },
      {
        id: "fixture-toilet",
        label: "Existing western toilet (洋式トイレ)",
        kind: "toilet",
        x0: -1.24,
        z0: -3.86,
        x1: -0.62,
        z1: -3.34,
        height: 0.78,
        facing: "east",
      },
      {
        id: "fixture-toilet-basin",
        label: "Restroom wall handwash basin (手洗器)",
        kind: "sink-counter",
        x0: 0.02,
        z0: -3.84,
        x1: 0.38,
        z1: -3.26,
        height: 0.82,
        facing: "west",
      },
    ],
  },
};

export const BAKERY_FLOOR_PLAN_ORDER: readonly BakeryFloorPlanId[] = [
  "asakusabashi-t101940",
  "kinshicho-61146",
  "machiya-sun-reve",
  "hongo-8257562",
  "reference",
];
