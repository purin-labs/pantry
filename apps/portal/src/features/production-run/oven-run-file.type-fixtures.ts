import type { CompiledScenario } from "@seams/production-simulation";
import type { OvenDefinition, OvenRunSource, OvenSave } from "@seams/production-simulation/runs/oven-run-file";
import type { PersistentOvenCell } from "@seams/bakery-model/bakery-physics";
import type { PersistentPanCell } from "@seams/bakery-model/bakery-physics";
import type { PersistentRackCell } from "@seams/bakery-model/bakery-physics";
import type { ExecutionBundle } from "@seams/production-simulation";

declare const definition: OvenDefinition;
declare const scenario: CompiledScenario;
declare const save: OvenSave;
declare const cell: PersistentOvenCell;

// @ts-expect-error A restored run requires its checkpoint's physical cell.
export const missingCell: OvenRunSource = { kind: "snapshot", save };

// @ts-expect-error A fresh route requires compiled, validated input.
export const missingScenario: OvenRunSource = {
  kind: "definition",
  definition,
};

const snapshot = { kind: "snapshot", save, cells: [cell] } as const;

// @ts-expect-error A broad spread cannot mix a saved world with a new recipe.
export const mixedSource: OvenRunSource = { ...snapshot, definition, scenario };

declare const pan: PersistentPanCell;
// @ts-expect-error Native recipe authoring must pin the execution build.
export const unpinnedPanRecipe: OvenRunSource = {
  kind: "native-recipe",
  name: "Tea",
  scenario,
  cell: pan,
};
export const wrongRecipeFixture: OvenRunSource = {
  kind: "native-recipe",
  name: "Tea",
  scenario,
  // @ts-expect-error An oven cell cannot stand in for a pan staging cell.
  cell,
  executionBundleId: "build",
};
export const loadedPan: PersistentPanCell = {
  ...pan,
  // @ts-expect-error A loaded pan is outside this fixture's operating envelope.
  ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
};
// @ts-expect-error Fixture identity cannot be changed by casting another validated cell.
export const castPan = cell as PersistentPanCell;

declare const rack: PersistentRackCell;
declare const bundle: ExecutionBundle;
// @ts-expect-error A two-cell route must retain its exact execution bundle.
export const unpinnedRoute: OvenRunSource = {
  kind: "logistics",
  name: "Route",
  scenario,
  cells: [rack, rack],
};
// @ts-expect-error The recurring route requires both cell definitions.
export const incompleteRoute: OvenRunSource = {
  kind: "logistics",
  name: "Route",
  scenario,
  bundle,
  cells: [rack],
};
// @ts-expect-error Saved and authored state cannot be combined by spreading.
export const mixedRoute: OvenRunSource = { ...snapshot, bundle };
// @ts-expect-error A parsed oven fixture cannot be cast to a rack fixture.
export const castRack = cell as PersistentRackCell;
