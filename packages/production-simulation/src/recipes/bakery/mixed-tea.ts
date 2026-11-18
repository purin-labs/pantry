import { sharedRecipeRecords } from "./shared-records.ts";
import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import { addQuantity } from "../../quantity.ts";
import { err, ok, type Result } from "../../result.ts";
import type { CompiledScenario } from "../../scenario.ts";
import {
  compileGingerBlackTeaRecipe,
  gingerBlackTeaRecipeInput,
} from "./ginger-black-tea.ts";
import {
  compileGingerMilkTeaRecipe,
  gingerMilkTeaRecipeInput,
} from "./ginger-milk-tea.ts";

function combine(
  black: CompiledScenario,
  milk: CompiledScenario,
): CompiledScenario {
  const stock = new Map<string, CompiledScenario["stock"][number]>();
  for (const entry of milk.stock) stock.set(entry.id, entry);
  for (const entry of black.stock) {
    const previous = stock.get(entry.id);
    stock.set(entry.id, {
      id: entry.id,
      product: entry.product,
      storage: entry.storage,
      quantity:
        previous === undefined
          ? entry.quantity
          : d.value(addQuantity(previous.quantity, entry.quantity)),
    });
  }
  // Milk tea owns the two pans and their initial cleanliness. Black tea adds
  // serving receivers. Its standalone two-position bench becomes one shared bench.
  const storages = new Map<string, CompiledScenario["storages"][number]>();
  for (const entry of black.storages) storages.set(entry.id, entry);
  for (const entry of milk.storages) storages.set(entry.id, entry);
  for (const entry of stock.values())
    storages.set(entry.storage, {
      id: entry.storage,
      capacity: {
        kind: "material",
        product: entry.product,
        quantity: entry.quantity,
      },
      cell: null,
    });
  const carriers = new Map<string, CompiledScenario["carriers"][number]>();
  for (const entry of black.carriers) carriers.set(entry.id, entry);
  for (const entry of milk.carriers) carriers.set(entry.id, entry);
  return {
    schemaVersion: milk.schemaVersion,
    id: authoredId("scenario", "mixed-tea"),
    policy: milk.policy,
    sources: [...black.sources, ...milk.sources],
    limits: milk.limits,
    products: sharedRecipeRecords(black.products, milk.products),
    destinations: sharedRecipeRecords(black.destinations, milk.destinations),
    resources: sharedRecipeRecords(black.resources, milk.resources),
    storages: [...storages.values()],
    carriers: [...carriers.values()],
    stock: [...stock.values()],
    cells: milk.cells,
    workflows: [...black.workflows, ...milk.workflows],
    arrivals: [...black.arrivals, ...milk.arrivals],
    dependencies: [],
    availability: [],
  };
}

export async function compileMixedTeaRecipe(
  raw: unknown,
  rawCell: unknown,
): Promise<
  Result<CompiledScenario, Readonly<{ code: "invalid_mixed_tea_recipe" }>>
> {
  try {
    const input = d.record(raw, ["blackTea", "milkTea"]);
    const black = await compileGingerBlackTeaRecipe(input.blackTea);
    const milk = await compileGingerMilkTeaRecipe(input.milkTea, rawCell);
    if (!black.ok || !milk.ok) return err({ code: "invalid_mixed_tea_recipe" });
    return ok(combine(black.value, milk.value));
  } catch (error) {
    if (error instanceof d.InvalidDocument)
      return err({ code: "invalid_mixed_tea_recipe" });
    throw error;
  }
}

export function mixedTeaRecipeInput() {
  const blackTea = gingerBlackTeaRecipeInput();
  blackTea.batchArrivalsSeconds = [0];
  const milkTea = gingerMilkTeaRecipeInput();
  milkTea.batchArrivalsSeconds = [60, 120];
  return { blackTea, milkTea };
}
