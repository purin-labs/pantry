import { hasExactKeys, isRecord } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import { identifier, label } from "./bakery-surface-text.ts";

// The floor plan of the Kitchen surface: the equipment and the openings of
// the shift layout, the store interior, the floor plan history, and the
// parsers of their wire values. Moved from bakery-surface.ts (file-size
// ratchet).

const MAX_EQUIPMENT = 40;

// An appliance on the open floor plan, with its yaw in whole degrees and optional mm coordinates.
export type BakerySurfaceEquipment = Readonly<{
  id: string;
  label: string;
  rotationDegrees: number;
  xMm?: number;
  zMm?: number;
}>;

export type BakerySurfaceOpening = Readonly<{
  id: string;
  label: string;
  kind: "door" | "window";
  open: boolean;
  progress: number;
}>;

type BakeryStoreInteriorPresetId =
  "kuramae-artisan" | "noix-parisien" | "kiyosumi-minimal" | "kyoto-machiya";

type BakeryFloorMaterialId =
  | "herringbone-oak"
  | "terrazzo-stone"
  | "limestone-checker"
  | "quarry-terracotta"
  | "smoked-cedar";

type BakeryWallMaterialId =
  "limewash-hinoki" | "parisian-boiserie" | "board-concrete" | "juraku-lattice";

type BakeryFixtureFinishId = "blackened-steel" | "aged-brass" | "natural-oak";

type BakeryLightingStyleId =
  "brass-pendants" | "atelier-track" | "washi-lanterns";

type BakeryWallHeightMode = "cutaway" | "smart-cutaway" | "full";

export type BakerySurfaceStoreInterior = Readonly<{
  preset: BakeryStoreInteriorPresetId | "custom";
  floorMaterial: BakeryFloorMaterialId;
  wallMaterial: BakeryWallMaterialId;
  fixtureFinish: BakeryFixtureFinishId;
  lightingStyle: BakeryLightingStyleId;
  wallHeightMode: BakeryWallHeightMode;
  showFurnishings: boolean;
}>;

export type BakeryStoreInteriorAction = StrictUnion<
  | Readonly<{ kind: "apply_preset"; preset: BakeryStoreInteriorPresetId }>
  | Readonly<{
      kind: "set_floor_material";
      floorMaterial: BakeryFloorMaterialId;
    }>
  | Readonly<{ kind: "set_wall_material"; wallMaterial: BakeryWallMaterialId }>
  | Readonly<{
      kind: "set_fixture_finish";
      fixtureFinish: BakeryFixtureFinishId;
    }>
  | Readonly<{
      kind: "set_lighting_style";
      lightingStyle: BakeryLightingStyleId;
    }>
  | Readonly<{ kind: "set_wall_height"; wallHeightMode: BakeryWallHeightMode }>
  | Readonly<{ kind: "set_furnishings"; showFurnishings: boolean }>
>;

export type BakeryFloorPlanResetAction =
  "undo" | "redo" | "reset_appliances" | "reset_initial";

type BakerySurfaceFloorPlanHistory = Readonly<{
  canUndo: boolean;
  canRedo: boolean;
  hasCustomLayout: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}>;

export type BakerySurfaceShiftLayout = Readonly<{
  floorPlan: string;
  equipment: readonly BakerySurfaceEquipment[];
  openings?: readonly BakerySurfaceOpening[];
  interior?: BakerySurfaceStoreInterior;
  history?: BakerySurfaceFloorPlanHistory;
}>;

export function parseShiftLayout(
  raw: unknown,
): BakerySurfaceShiftLayout | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "floorPlan",
      "equipment",
      ...(raw.openings === undefined ? [] : ["openings"]),
      ...(raw.interior === undefined ? [] : ["interior"]),
      ...(raw.history === undefined ? [] : ["history"]),
    ]) ||
    !identifier(raw.floorPlan) ||
    !Array.isArray(raw.equipment) ||
    raw.equipment.length > MAX_EQUIPMENT
  )
    return null;
  const equipment: BakerySurfaceEquipment[] = [];
  for (const item of raw.equipment) {
    const hasCoords =
      isRecord(item) && item.xMm !== undefined && item.zMm !== undefined;
    if (
      !isRecord(item) ||
      !hasExactKeys(
        item,
        hasCoords
          ? ["id", "label", "rotationDegrees", "xMm", "zMm"]
          : ["id", "label", "rotationDegrees"],
      ) ||
      !identifier(item.id) ||
      !label(item.label) ||
      !rotationDegrees(item.rotationDegrees) ||
      (hasCoords &&
        (!floorPlanCoordinateMm(item.xMm) ||
          !floorPlanCoordinateMm(item.zMm))) ||
      equipment.some(sameEquipmentId.bind(null, item.id))
    )
      return null;
    equipment.push({
      id: item.id,
      label: item.label,
      rotationDegrees: item.rotationDegrees,
      ...(hasCoords
        ? { xMm: item.xMm as number, zMm: item.zMm as number }
        : {}),
    });
  }
  const interior =
    raw.interior === undefined ? undefined : parseStoreInterior(raw.interior);
  if (raw.interior !== undefined && interior === null) return null;
  const history =
    raw.history === undefined ? undefined : parseFloorPlanHistory(raw.history);
  if (raw.history !== undefined && history === null) return null;
  let openings: BakerySurfaceOpening[] | undefined;
  if (raw.openings !== undefined) {
    if (!Array.isArray(raw.openings) || raw.openings.length > 24) {
      return null;
    }
    openings = [];
    for (const entry of raw.openings) {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ["id", "label", "kind", "open", "progress"]) ||
        !identifier(entry.id) ||
        !label(entry.label) ||
        (entry.kind !== "door" && entry.kind !== "window") ||
        typeof entry.open !== "boolean" ||
        typeof entry.progress !== "number" ||
        !Number.isFinite(entry.progress) ||
        entry.progress < 0 ||
        entry.progress > 1 ||
        openings.some((existing) => existing.id === entry.id)
      )
        return null;
      openings.push({
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        open: entry.open,
        progress: entry.progress,
      });
    }
  }
  return {
    floorPlan: raw.floorPlan,
    equipment,
    ...(openings === undefined ? {} : { openings }),
    ...(interior === undefined || interior === null ? {} : { interior }),
    ...(history === undefined || history === null ? {} : { history }),
  };
}

function storeInteriorPresetId(
  value: unknown,
): value is BakeryStoreInteriorPresetId {
  return (
    value === "kuramae-artisan" ||
    value === "noix-parisien" ||
    value === "kiyosumi-minimal" ||
    value === "kyoto-machiya"
  );
}

function floorMaterialId(value: unknown): value is BakeryFloorMaterialId {
  return (
    value === "herringbone-oak" ||
    value === "terrazzo-stone" ||
    value === "limestone-checker" ||
    value === "quarry-terracotta" ||
    value === "smoked-cedar"
  );
}

function wallMaterialId(value: unknown): value is BakeryWallMaterialId {
  return (
    value === "limewash-hinoki" ||
    value === "parisian-boiserie" ||
    value === "board-concrete" ||
    value === "juraku-lattice"
  );
}

function fixtureFinishId(value: unknown): value is BakeryFixtureFinishId {
  return (
    value === "blackened-steel" ||
    value === "aged-brass" ||
    value === "natural-oak"
  );
}

function lightingStyleId(value: unknown): value is BakeryLightingStyleId {
  return (
    value === "brass-pendants" ||
    value === "atelier-track" ||
    value === "washi-lanterns"
  );
}

function wallHeightMode(value: unknown): value is BakeryWallHeightMode {
  return value === "cutaway" || value === "smart-cutaway" || value === "full";
}

function parseStoreInterior(raw: unknown): BakerySurfaceStoreInterior | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "preset",
      "floorMaterial",
      "wallMaterial",
      "fixtureFinish",
      "lightingStyle",
      "wallHeightMode",
      "showFurnishings",
    ]) ||
    (raw.preset !== "custom" && !storeInteriorPresetId(raw.preset)) ||
    !floorMaterialId(raw.floorMaterial) ||
    !wallMaterialId(raw.wallMaterial) ||
    !fixtureFinishId(raw.fixtureFinish) ||
    !lightingStyleId(raw.lightingStyle) ||
    !wallHeightMode(raw.wallHeightMode) ||
    typeof raw.showFurnishings !== "boolean"
  )
    return null;
  return {
    preset: raw.preset,
    floorMaterial: raw.floorMaterial,
    wallMaterial: raw.wallMaterial,
    fixtureFinish: raw.fixtureFinish,
    lightingStyle: raw.lightingStyle,
    wallHeightMode: raw.wallHeightMode,
    showFurnishings: raw.showFurnishings,
  };
}

function parseFloorPlanHistory(
  raw: unknown,
): BakerySurfaceFloorPlanHistory | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "canUndo",
      "canRedo",
      "hasCustomLayout",
      "undoLabel",
      "redoLabel",
    ]) ||
    typeof raw.canUndo !== "boolean" ||
    typeof raw.canRedo !== "boolean" ||
    typeof raw.hasCustomLayout !== "boolean" ||
    (raw.undoLabel !== null && !label(raw.undoLabel)) ||
    (raw.redoLabel !== null && !label(raw.redoLabel))
  )
    return null;
  return {
    canUndo: raw.canUndo,
    canRedo: raw.canRedo,
    hasCustomLayout: raw.hasCustomLayout,
    undoLabel: raw.undoLabel,
    redoLabel: raw.redoLabel,
  };
}

export function parseBakeryStoreInteriorAction(
  raw: unknown,
): BakeryStoreInteriorAction | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null;
  switch (raw.kind) {
    case "apply_preset":
      return hasExactKeys(raw, ["kind", "preset"]) &&
        storeInteriorPresetId(raw.preset)
        ? { kind: "apply_preset", preset: raw.preset }
        : null;
    case "set_floor_material":
      return hasExactKeys(raw, ["kind", "floorMaterial"]) &&
        floorMaterialId(raw.floorMaterial)
        ? { kind: "set_floor_material", floorMaterial: raw.floorMaterial }
        : null;
    case "set_wall_material":
      return hasExactKeys(raw, ["kind", "wallMaterial"]) &&
        wallMaterialId(raw.wallMaterial)
        ? { kind: "set_wall_material", wallMaterial: raw.wallMaterial }
        : null;
    case "set_fixture_finish":
      return hasExactKeys(raw, ["kind", "fixtureFinish"]) &&
        fixtureFinishId(raw.fixtureFinish)
        ? { kind: "set_fixture_finish", fixtureFinish: raw.fixtureFinish }
        : null;
    case "set_lighting_style":
      return hasExactKeys(raw, ["kind", "lightingStyle"]) &&
        lightingStyleId(raw.lightingStyle)
        ? { kind: "set_lighting_style", lightingStyle: raw.lightingStyle }
        : null;
    case "set_wall_height":
      return hasExactKeys(raw, ["kind", "wallHeightMode"]) &&
        wallHeightMode(raw.wallHeightMode)
        ? { kind: "set_wall_height", wallHeightMode: raw.wallHeightMode }
        : null;
    case "set_furnishings":
      return hasExactKeys(raw, ["kind", "showFurnishings"]) &&
        typeof raw.showFurnishings === "boolean"
        ? { kind: "set_furnishings", showFurnishings: raw.showFurnishings }
        : null;
    default:
      return null;
  }
}

export function isBakeryFloorPlanResetAction(
  value: unknown,
): value is BakeryFloorPlanResetAction {
  return (
    value === "undo" ||
    value === "redo" ||
    value === "reset_appliances" ||
    value === "reset_initial"
  );
}

export function normalizeYawDegrees(degrees: number): number {
  const normalized = ((((Math.round(degrees) + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}

export function floorPlanCoordinateMm(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -20_000 &&
    value <= 20_000
  );
}

const FLOOR_PLAN_IDS: ReadonlySet<unknown> = new Set([
  "asakusabashi-t101940",
  "kinshicho-6992842011",
  "machiya-sun-reve",
  "hongo-8257562",
  "reference",
]);

export const floorPlanId = (v: unknown): v is string => FLOOR_PLAN_IDS.has(v);

function sameEquipmentId(id: string, item: BakerySurfaceEquipment): boolean {
  return item.id === id;
}

// A yaw in whole degrees, from -180 (exclusive) to 180.
export function rotationDegrees(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > -180 &&
    value <= 180
  );
}

// The yaw after Rotate 90°: snapped to a quarter turn, then turned once more.
export function quarterTurnDegrees(rotationDegrees: number): number {
  const turned = Math.round(rotationDegrees / 90) * 90 + 90;
  const normalized = ((((turned + 180) % 360) + 360) % 360) - 180;
  return normalized === -180 ? 180 : normalized;
}
