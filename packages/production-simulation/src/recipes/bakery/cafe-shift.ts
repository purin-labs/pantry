import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import type { NativeCell } from "../../native/cell-adapter.ts";
import type { CompiledScenario } from "../../scenario.ts";
import {
  compileEspresso,
  parseEspressoRecipe,
  type EspressoRecipe,
} from "./espresso.ts";
import {
  compileFinancierRecipe,
  financierRecipeInput,
} from "./financier-production.ts";
import { sharedRecipeRecords } from "./shared-records.ts";

type CafeShiftRecipe = Readonly<{
  espresso: EspressoRecipe;
  financierLoads: number;
}>;

export function parseCafeShiftRecipe(raw: unknown): CafeShiftRecipe {
  const input = d.record(raw, ["espresso", "financierLoads"]);
  const financierLoads = d.positive(input.financierLoads);
  d.requireValue(financierLoads <= 3);
  return { espresso: parseEspressoRecipe(input.espresso), financierLoads };
}

/** A bakery worker and a dedicated barista share one persistent logical clock. */
export async function compileCafeShift(
  input: CafeShiftRecipe,
  cell: NativeCell,
): Promise<CompiledScenario> {
  const financier = d.value(
    await compileFinancierRecipe(
      financierRecipeInput(input.financierLoads, 2, 900),
    ),
  );
  const espresso = await compileEspresso(input.espresso, cell);
  return {
    schemaVersion: financier.schemaVersion,
    id: authoredId("scenario", "cafe-shift"),
    policy: financier.policy,
    sources: [...financier.sources, ...espresso.sources],
    limits: financier.limits,
    products: sharedRecipeRecords(financier.products, espresso.products),
    destinations: sharedRecipeRecords(
      financier.destinations,
      espresso.destinations,
    ),
    resources: sharedRecipeRecords(financier.resources, espresso.resources),
    storages: sharedRecipeRecords(financier.storages, espresso.storages),
    carriers: financier.carriers,
    stock: [...financier.stock, ...espresso.stock],
    cells: espresso.cells,
    workflows: [...financier.workflows, ...espresso.workflows],
    arrivals: [...financier.arrivals, ...espresso.arrivals],
    dependencies: financier.dependencies,
    availability: financier.availability,
  };
}
