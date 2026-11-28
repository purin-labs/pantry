import type { CompiledScenario } from "@purin-labs/production-simulation";
import type { OvenDefinition, OvenRunSource, OvenSave } from "@purin-labs/production-simulation/runs/oven-run-file";
import type { PersistentOvenCell } from "@purin-labs/bakery-model/bakery-physics";
import type { PersistentPanCell } from "@purin-labs/bakery-model/bakery-physics";
import type { PersistentRackCell } from "@purin-labs/bakery-model/bakery-physics";

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
export const wrongRecipeFixture: OvenRunSource = {
  kind: "native-recipe",
  name: "Tea",
  scenario,
  // @ts-expect-error An oven cell cannot stand in for a pan staging cell.
  cell,
};
export const loadedPan: PersistentPanCell = {
  ...pan,
  // @ts-expect-error A loaded pan is outside this fixture's operating envelope.
  ingredients: { massKg: 1, forwardMm: 0, lateralMm: 0 },
};
// @ts-expect-error Fixture identity cannot be changed by casting another validated cell.
export const castPan = cell as PersistentPanCell;

declare const rack: PersistentRackCell;
// @ts-expect-error The recurring route requires both cell definitions.
export const incompleteRoute: OvenRunSource = {
  kind: "logistics",
  name: "Route",
  scenario,
  cells: [rack],
};
export const pinnedRoute: OvenRunSource = {
  kind: "logistics",
  name: "Route",
  scenario,
  cells: [rack, rack],
  // @ts-expect-error A run source of one engine names no other build.
  bundle: "build",
};
// @ts-expect-error A parsed oven fixture cannot be cast to a rack fixture.
export const castRack = cell as PersistentRackCell;
