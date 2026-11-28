import {
  compileCafeShift,
  parseCafeShiftRecipe,
} from "@purin-labs/production-simulation/recipes/bakery/cafe-shift";
import {
  compileEspresso,
  parseEspressoRecipe,
} from "@purin-labs/production-simulation/recipes/bakery/espresso";
import {
  compilePourOver,
  parsePourOverRecipe,
} from "@purin-labs/production-simulation/recipes/bakery/pour-over";
import { parseNativeCell } from "@purin-labs/production-simulation/native/cell-adapter";
import {
  MAX_DOCUMENT_BYTES,
  MAX_REFERENCED_BYTES,
  err,
  ok,
  type Result,
  type CompiledScenario,
} from "@purin-labs/production-simulation";
import { assertNever, isRecord, parseJsonOrNull } from "@purin-labs/std";
import {
  parsePersistentCell,
  type PersistentPanCell,
} from "@purin-labs/bakery-model/bakery-physics";
import { parseProductionScenario } from "@purin-labs/bakery-model/bakery-production-scenario";
import { compileGingerBlackTeaRecipe } from "@purin-labs/production-simulation/recipes/bakery/ginger-black-tea";
import { compileGingerMilkTeaRecipe } from "@purin-labs/production-simulation/recipes/bakery/ginger-milk-tea";
import { compileMixedTeaRecipe } from "@purin-labs/production-simulation/recipes/bakery/mixed-tea";
import { compileBakeryShift } from "@purin-labs/production-simulation/recipes/bakery/bakery-shift";
import { compileFinancierRecipe } from "@purin-labs/production-simulation/recipes/bakery/financier";
import { compileBlackSesameRecipe } from "@purin-labs/production-simulation/recipes/bakery/black-sesame";
import { openExecutionWorker } from "./execution-client";
import { readSavedRunFile } from "@purin-labs/production-simulation/runs/run-file-reader";
import {
  readOvenSave,
  prepareOvenDefinition,
  prepareFinancierRecipe,
  prepareBlackSesameRecipe,
  prepareGingerBlackTeaRecipe,
  type OvenRunSource,
} from "@purin-labs/production-simulation/runs/oven-run-file";
import type { Variant } from "@purin-labs/type-utils";

/** A file contains either the shared definition or the host's saved reply. */
export async function readOvenRunFile(
  file: File,
): Promise<Result<OvenRunSource, string>> {
  if (file.size > MAX_DOCUMENT_BYTES + MAX_REFERENCED_BYTES * 2)
    return err("This run file exceeds the import size limit.");
  if (file.size > MAX_DOCUMENT_BYTES) {
    try {
      const saved = await readSavedRunFile(file);
      return readOvenSave(saved.raw, saved.artifacts);
    } catch (error) {
      return err(
        error instanceof Error ? error.message : "The run file cannot be read.",
      );
    }
  }
  const raw = parseJsonOrNull(await file.text());
  if (isRecord(raw) && raw.kind === "cafe-shift-recipe")
    return prepareNativeRecipe({ kind: "cafe-shift", input: raw.recipe });
  if (isRecord(raw) && raw.kind === "espresso-recipe")
    return prepareNativeRecipe({ kind: "espresso", input: raw.recipe });
  if (isRecord(raw) && raw.kind === "pour-over-recipe")
    return preparePourOverRecipe(raw.recipe);
  if (isRecord(raw) && raw.kind === "financier-native-recipe")
    return prepareNativeRecipe({ kind: "financier", input: raw.recipe });
  if (isRecord(raw) && raw.kind === "financier-recipe")
    return raw.coldHandling === "fairino-fr10"
      ? prepareNativeRecipe({ kind: "financier", input: raw.recipe })
      : prepareFinancierRecipe(raw.recipe);
  if (isRecord(raw) && raw.kind === "black-sesame-native-recipe")
    return prepareNativeRecipe({ kind: "black-sesame", input: raw.recipe });
  if (isRecord(raw) && raw.kind === "black-sesame-recipe")
    return raw.coldHandling === "fairino-fr10"
      ? prepareNativeRecipe({ kind: "black-sesame", input: raw.recipe })
      : prepareBlackSesameRecipe(raw.recipe);
  if (isRecord(raw) && raw.kind === "ginger-black-tea-native-recipe")
    return prepareNativeRecipe({ kind: "ginger-black-tea", input: raw.recipe });
  if (isRecord(raw) && raw.kind === "ginger-black-tea-recipe")
    return raw.panStaging === "fairino-fr10"
      ? prepareNativeRecipe({ kind: "ginger-black-tea", input: raw.recipe })
      : prepareGingerBlackTeaRecipe(raw.recipe);
  if (isRecord(raw) && raw.kind === "ginger-milk-tea-recipe")
    return prepareNativeRecipe({
      kind: "ginger-milk-tea",
      input: raw.recipe,
    });
  if (isRecord(raw) && raw.kind === "mixed-tea-recipe")
    return prepareNativeRecipe({ kind: "mixed-tea", input: raw.recipe });
  if (isRecord(raw) && raw.kind === "bakery-shift-recipe")
    return prepareNativeRecipe({ kind: "bakery-shift", input: raw.recipe });
  const definition = parseProductionScenario(raw);
  if (definition?.route === "oven-rack")
    return prepareOvenDefinition(definition);
  return readOvenSave(raw, new Map());
}

export async function prepareNativeRecipe(
  recipe: NativeRecipeInput,
): Promise<Result<Variant<OvenRunSource, "native-recipe">, string>> {
  const opened = await openExecutionWorker();
  if (!opened.ok)
    return err(`Cannot prepare this recipe: ${opened.error.code}.`);
  const worker = opened.value;
  try {
    if (recipe.kind === "financier" || recipe.kind === "black-sesame") {
      const reply = await worker.request({
        kind: "define",
        cell:
          recipe.kind === "financier"
            ? "financier-cold-cell"
            : "sesame-cold-cell",
        fixture: "rack",
        robot: "fairino-fr10",
      });
      const cell =
        isRecord(reply) && reply.kind === "defined"
          ? parsePersistentCell(reply.definition)
          : null;
      if (cell === null || cell.fixture !== "persistent-rack/1")
        return err("The prepared cold rack cell is invalid.");
      const compiled =
        recipe.kind === "financier"
          ? await compileFinancierRecipe(recipe.input, cell)
          : await compileBlackSesameRecipe(recipe.input, cell);
      if (!compiled.ok)
        return err(`Cannot prepare this recipe: ${compiled.error.code}.`);
      return ok({
        kind: "native-recipe",
        name:
          recipe.kind === "financier"
            ? "Hazelnut financiers: preparation to packing · FR10 cold cell"
            : "Black sesame milk: concentrate to service · FR10 cold cell",
        scenario: compiled.value,
        cell,
      });
    }
    const cafe =
      recipe.kind === "cafe-shift" ? parseCafeShiftRecipe(recipe.input) : null;
    const espresso =
      cafe?.espresso ??
      (recipe.kind === "espresso" ? parseEspressoRecipe(recipe.input) : null);
    const reply = await worker.request({
      kind: "define",
      cell: espresso !== null ? "espresso-cell" : "tea-pan-cell",
      fixture: espresso !== null ? "espresso" : "pan-staging",
      ...(espresso === null
        ? { robot: "fairino-fr10" }
        : { appliance: espresso.appliance }),
    });
    const cell =
      isRecord(reply) && reply.kind === "defined"
        ? parsePersistentCell(reply.definition)
        : null;
    if (recipe.kind === "espresso" || recipe.kind === "cafe-shift") {
      if (
        espresso === null ||
        cell === null ||
        cell.fixture !== "persistent-espresso/1" ||
        cell.appliance !== espresso.appliance
      )
        return err("The espresso cell is invalid.");
      const native = parseNativeCell(cell);
      if (!native.ok) return err(native.error);
      try {
        return ok({
          kind: "native-recipe",
          name: `${cafe === null ? "Espresso service" : "Café shift: hazelnut financiers and espresso"} · ${cell.appliance === "linea" ? "Linea Classic S" : "Eagle One"}`,
          scenario:
            cafe === null
              ? await compileEspresso(espresso, native.value)
              : await compileCafeShift(cafe, native.value),
          cell,
        });
      } catch (error) {
        return err(
          error instanceof Error ? error.message : "Invalid espresso recipe.",
        );
      }
    }
    if (cell === null || cell.fixture !== "persistent-pan-staging/1")
      return err("The prepared pan cell is invalid.");
    const prepared = await compileNativeRecipe(recipe, cell);
    if (!prepared.ok) return prepared;
    return ok({
      kind: "native-recipe",
      name: prepared.value.name,
      scenario: prepared.value.scenario,
      cell,
    });
  } finally {
    worker.terminate();
  }
}

/** One brew on a prepared FR10 pour-over station, defined by this runtime. */
export async function preparePourOverRecipe(
  input: unknown,
): Promise<Result<Variant<OvenRunSource, "native-recipe">, string>> {
  let recipe;
  try {
    recipe = parsePourOverRecipe(input);
  } catch (error) {
    return err(
      error instanceof Error ? error.message : "Invalid pour-over recipe.",
    );
  }
  const opened = await openExecutionWorker();
  if (!opened.ok)
    return err(`Cannot prepare this recipe: ${opened.error.code}.`);
  const worker = opened.value;
  try {
    const reply = await worker.request({
      kind: "define",
      cell: "pour-over-cell",
      fixture: "pour-over",
      station: {
        kettleWaterG: recipe.kettleWaterG,
        drainage: recipe.drainage,
        fault: recipe.fault,
      },
    });
    const cell =
      isRecord(reply) && reply.kind === "defined"
        ? parsePersistentCell(reply.definition)
        : null;
    if (cell === null || cell.fixture !== "persistent-pour-over/1")
      return err("The pour-over station is invalid.");
    const native = parseNativeCell(cell);
    if (!native.ok) return err(native.error);
    return ok({
      kind: "native-recipe",
      name: `Pour-over · ${recipe.kettleWaterG} g kettle${recipe.drainage === "reduced" ? " · reduced drainage" : ""}${recipe.fault === "lost-grip" ? " · grip fault" : ""}`,
      scenario: await compilePourOver(recipe, native.value),
      cell,
    });
  } catch (error) {
    return err(
      error instanceof Error ? error.message : "Invalid pour-over recipe.",
    );
  } finally {
    worker.terminate();
  }
}

type NativeRecipeInput =
  | Readonly<{ kind: "financier"; input: unknown }>
  | Readonly<{ kind: "black-sesame"; input: unknown }>
  | Readonly<{ kind: "espresso"; input: unknown }>
  | Readonly<{ kind: "cafe-shift"; input: unknown }>
  | Readonly<{
      kind:
        | "ginger-black-tea"
        | "ginger-milk-tea"
        | "mixed-tea"
        | "bakery-shift";
      input: unknown;
    }>;
async function compileNativeRecipe(
  recipe: Exclude<
    NativeRecipeInput,
    { kind: "financier" | "black-sesame" | "espresso" | "cafe-shift" }
  >,
  cell: PersistentPanCell,
): Promise<
  Result<Readonly<{ name: string; scenario: CompiledScenario }>, string>
> {
  let name: string;
  let compiled: Result<CompiledScenario, Readonly<{ code: string }>>;
  switch (recipe.kind) {
    case "bakery-shift":
      name =
        isRecord(recipe.input) &&
        recipe.input.kind === "six-hour-shift"
          ? "6-hour shift: multi-wave financiers, pies, tea waves, coffee and relief breaks"
          : isRecord(recipe.input) && "sesameBatches" in recipe.input
            ? "Morning shift: financiers, sesame milk, tea, espresso and pour-over"
            : "Bakery shift: financiers and milk tea";
      compiled = await compileBakeryShift(recipe.input, cell);
      break;
    case "mixed-tea":
      name = "Black tea and milk tea: shared station";
      compiled = await compileMixedTeaRecipe(recipe.input, cell);
      break;
    case "ginger-black-tea":
      name = "Ginger black tea: pan staging to service";
      compiled = await compileGingerBlackTeaRecipe(recipe.input, cell);
      break;
    case "ginger-milk-tea":
      name = "Ginger milk tea: pan staging to service";
      compiled = await compileGingerMilkTeaRecipe(recipe.input, cell);
      break;
    default:
      return assertNever(recipe.kind);
  }
  if (!compiled.ok)
    return err(`Cannot prepare this recipe: ${compiled.error.code}.`);
  return ok({ name, scenario: compiled.value });
}
