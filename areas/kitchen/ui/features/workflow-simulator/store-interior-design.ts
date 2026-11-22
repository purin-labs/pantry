import { isRecord } from "@purin-labs/std";

export type FloorMaterialId =
  | "herringbone-oak"
  | "terrazzo-stone"
  | "limestone-checker"
  | "quarry-terracotta"
  | "smoked-cedar";

export type WallMaterialId =
  "limewash-hinoki" | "parisian-boiserie" | "board-concrete" | "juraku-lattice";

export type FixtureFinishId = "blackened-steel" | "aged-brass" | "natural-oak";

export type LightingStyleId =
  "brass-pendants" | "atelier-track" | "washi-lanterns";

export type WallHeightMode = "cutaway" | "smart-cutaway" | "full";

export type StoreInteriorPresetId =
  "kuramae-artisan" | "noix-parisien" | "kiyosumi-minimal" | "kyoto-machiya";

export type StoreInteriorDesign = Readonly<{
  preset: StoreInteriorPresetId | "custom";
  floorMaterial: FloorMaterialId;
  wallMaterial: WallMaterialId;
  fixtureFinish: FixtureFinishId;
  lightingStyle: LightingStyleId;
  wallHeightMode: WallHeightMode;
  showFurnishings: boolean;
}>;

export type InteriorChoice<T extends string> = Readonly<{
  id: T;
  label: string;
  detail: string;
  swatchHex: string;
}>;

export const FLOOR_MATERIAL_CHOICES: readonly InteriorChoice<FloorMaterialId>[] =
  [
    {
      id: "herringbone-oak",
      label: "Herringbone white oak",
      detail: "Warm chevron parquet in the main hall, ceramic tile in wet bay",
      swatchHex: "#c8a97e",
    },
    {
      id: "terrazzo-stone",
      label: "Tokyo artisan terrazzo",
      detail: "Honed warm alabaster concrete with marble aggregate chips",
      swatchHex: "#d8d2c5",
    },
    {
      id: "limestone-checker",
      label: "Parisian limestone & cabochon",
      detail: "Honed cream stone tiles with charcoal corner cabochons",
      swatchHex: "#e2dccd",
    },
    {
      id: "quarry-terracotta",
      label: "Boulangerie quarry terracotta",
      detail: "Warm clay bakery pavers with slip-resistant grout joints",
      swatchHex: "#b97352",
    },
    {
      id: "smoked-cedar",
      label: "Smoked cedar wide plank",
      detail: "Deep roasted Japanese sugi timber boards",
      swatchHex: "#6f533d",
    },
  ];

export const WALL_MATERIAL_CHOICES: readonly InteriorChoice<WallMaterialId>[] =
  [
    {
      id: "limewash-hinoki",
      label: "Limewash & fluted hinoki",
      detail: "Warm mineral plaster with vertical hinoki timber wainscot",
      swatchHex: "#eee6d5",
    },
    {
      id: "parisian-boiserie",
      label: "Parisian ivory boiserie",
      detail: "Molded pâtisserie wall panels with warm brass chair rail",
      swatchHex: "#f4efe4",
    },
    {
      id: "board-concrete",
      label: "Architectural concrete & oak",
      detail: "Cast concrete walls and pilasters with warm oak acoustic slats",
      swatchHex: "#c2c5be",
    },
    {
      id: "juraku-lattice",
      label: "Kyoto juraku & cedar koushi",
      detail: "Warm sand-textured earth plaster with vertical cedar lattice",
      swatchHex: "#dfd3be",
    },
  ];

export const FIXTURE_FINISH_CHOICES: readonly InteriorChoice<FixtureFinishId>[] =
  [
    {
      id: "blackened-steel",
      label: "Blackened steel & brass",
      detail:
        "Anodized dark bronze storefront mullions with brushed brass pulls",
      swatchHex: "#2e3330",
    },
    {
      id: "aged-brass",
      label: "Aged pâtisserie brass",
      detail: "Warm burnished brass frames, vitrine trim, and hardware",
      swatchHex: "#b58e4c",
    },
    {
      id: "natural-oak",
      label: "Natural hinoki & stainless",
      detail: "Timber storefront frames with satin stainless hardware",
      swatchHex: "#ba9466",
    },
  ];

export const LIGHTING_STYLE_CHOICES: readonly InteriorChoice<LightingStyleId>[] =
  [
    {
      id: "brass-pendants",
      label: "Holophane glass & brass pendants",
      detail: "Warm ribbed glass café pendants over counter and prep line",
      swatchHex: "#e3b868",
    },
    {
      id: "atelier-track",
      label: "Architectural linear & track spots",
      detail: "Suspended gallery task rails with warm 3000K spots",
      swatchHex: "#3a3f3d",
    },
    {
      id: "washi-lanterns",
      label: "Sculptural washi lanterns",
      detail: "Soft diffused Japanese paper globes with timber rings",
      swatchHex: "#f7eed6",
    },
  ];

export const WALL_HEIGHT_CHOICES: readonly InteriorChoice<WallHeightMode>[] = [
  {
    id: "smart-cutaway",
    label: "Smart doll-house cutaway",
    detail:
      "Taller rear & partition walls, low front storefront for clear orbit",
    swatchHex: "#8d9289",
  },
  {
    id: "cutaway",
    label: "Low 1.15 m cutaway",
    detail: "Uniform waist-high walls for 360° unobstructed sightlines",
    swatchHex: "#b7bdb0",
  },
  {
    id: "full",
    label: "Full 2.7 m ceiling height",
    detail: "Full architectural enclosure with suspended ceiling lights",
    swatchHex: "#5c685e",
  },
];

export const STORE_INTERIOR_PRESETS: Readonly<
  Record<
    StoreInteriorPresetId,
    Readonly<{
      id: StoreInteriorPresetId;
      label: string;
      detail: string;
      design: StoreInteriorDesign;
    }>
  >
> = {
  "kuramae-artisan": {
    id: "kuramae-artisan",
    label: "Kuramae Artisan Pâtisserie",
    detail: "Herringbone oak, limewash & hinoki wainscot, blackened steel",
    design: {
      preset: "kuramae-artisan",
      floorMaterial: "herringbone-oak",
      wallMaterial: "limewash-hinoki",
      fixtureFinish: "blackened-steel",
      lightingStyle: "brass-pendants",
      wallHeightMode: "smart-cutaway",
      showFurnishings: true,
    },
  },
  "noix-parisien": {
    id: "noix-parisien",
    label: "Parisian Pâtisserie · Noix",
    detail: "Limestone cabochon tile, ivory boiserie, aged brass & marble",
    design: {
      preset: "noix-parisien",
      floorMaterial: "limestone-checker",
      wallMaterial: "parisian-boiserie",
      fixtureFinish: "aged-brass",
      lightingStyle: "brass-pendants",
      wallHeightMode: "smart-cutaway",
      showFurnishings: true,
    },
  },
  "kiyosumi-minimal": {
    id: "kiyosumi-minimal",
    label: "Kiyosumi Roastery & Concrete",
    detail: "Artisan terrazzo, board-formed concrete, linear gallery lighting",
    design: {
      preset: "kiyosumi-minimal",
      floorMaterial: "terrazzo-stone",
      wallMaterial: "board-concrete",
      fixtureFinish: "blackened-steel",
      lightingStyle: "atelier-track",
      wallHeightMode: "smart-cutaway",
      showFurnishings: true,
    },
  },
  "kyoto-machiya": {
    id: "kyoto-machiya",
    label: "Kyoto Machiya Timber & Plaster",
    detail: "Smoked cedar planks, juraku plaster, cedar lattice & washi lamps",
    design: {
      preset: "kyoto-machiya",
      floorMaterial: "smoked-cedar",
      wallMaterial: "juraku-lattice",
      fixtureFinish: "natural-oak",
      lightingStyle: "washi-lanterns",
      wallHeightMode: "smart-cutaway",
      showFurnishings: true,
    },
  },
};

export const STORE_INTERIOR_PRESET_ORDER: readonly StoreInteriorPresetId[] = [
  "kuramae-artisan",
  "noix-parisien",
  "kiyosumi-minimal",
  "kyoto-machiya",
];

const STORAGE_KEY = "pantry:bakery-interior-design:v1";

function loadInitialInteriorDesign(): StoreInteriorDesign {
  const fallback = STORE_INTERIOR_PRESETS["kuramae-artisan"].design;
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      isChoice(FLOOR_MATERIAL_CHOICES, parsed.floorMaterial) &&
      isChoice(WALL_MATERIAL_CHOICES, parsed.wallMaterial) &&
      isChoice(FIXTURE_FINISH_CHOICES, parsed.fixtureFinish) &&
      isChoice(LIGHTING_STYLE_CHOICES, parsed.lightingStyle) &&
      isChoice(WALL_HEIGHT_CHOICES, parsed.wallHeightMode) &&
      typeof parsed.showFurnishings === "boolean"
    ) {
      return {
        preset: storedPreset(parsed),
        floorMaterial: parsed.floorMaterial,
        wallMaterial: parsed.wallMaterial,
        fixtureFinish: parsed.fixtureFinish,
        lightingStyle: parsed.lightingStyle,
        wallHeightMode: parsed.wallHeightMode,
        showFurnishings: parsed.showFurnishings,
      };
    }
  } catch {
    // Ignore storage read errors in restricted contexts.
  }
  return fallback;
}

function storedPreset(
  value: Record<string, unknown>,
): StoreInteriorPresetId | "custom" {
  for (const id of STORE_INTERIOR_PRESET_ORDER) {
    if (value.preset !== id) continue;
    const design = STORE_INTERIOR_PRESETS[id].design;
    if (
      value.floorMaterial === design.floorMaterial &&
      value.wallMaterial === design.wallMaterial &&
      value.fixtureFinish === design.fixtureFinish &&
      value.lightingStyle === design.lightingStyle &&
      value.wallHeightMode === design.wallHeightMode &&
      value.showFurnishings === design.showFurnishings
    )
      return id;
  }
  return "custom";
}

function isChoice<T extends string>(
  choices: readonly Readonly<{ id: T }>[],
  value: unknown,
): value is T {
  for (const choice of choices) {
    if (choice.id === value) return true;
  }
  return false;
}

let activeInteriorDesign: StoreInteriorDesign = loadInitialInteriorDesign();
const listeners = new Set<() => void>();

function saveAndNotify(next: StoreInteriorDesign): void {
  activeInteriorDesign = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage write errors.
    }
  }
  for (const listener of listeners) listener();
}

export function getStoreInteriorDesign(): StoreInteriorDesign {
  return activeInteriorDesign;
}

export function applyStoreInteriorPreset(
  presetId: StoreInteriorPresetId,
): void {
  const preset = STORE_INTERIOR_PRESETS[presetId];
  saveAndNotify(preset.design);
}

export function updateStoreInteriorDesign(
  patch: Partial<Omit<StoreInteriorDesign, "preset">>,
): void {
  const next: StoreInteriorDesign = {
    ...activeInteriorDesign,
    ...patch,
    preset: "custom",
  };
  saveAndNotify(next);
}

export function subscribeStoreInteriorDesign(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
