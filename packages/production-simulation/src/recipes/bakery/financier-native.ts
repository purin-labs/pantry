import { isRecord, sameJson } from "@purin-labs/std";
import { parseNativeCell, type NativeCell } from "../../native/cell-adapter.ts";
import { err, ok, type Result } from "../../result.ts";
import type { ProductionWorkcells } from "./production-workcells.ts";
import { hasFaults } from "./run-faults.ts";

export type NativeFinancierProblem = Readonly<{
  code:
    | "unsupported_recipe"
    | "unsupported_operation"
    | "incompatible_cell"
    | "invalid_definition";
  subject: string;
}>;

/** Bind authored cold-tray requests to the exact persistent fixture they need. */
export function bindFinancierCells(
  plan: ProductionWorkcells,
  definitions: readonly unknown[],
): Result<ReadonlyMap<string, NativeCell>, NativeFinancierProblem> {
  if (
    plan.procedure !== "financier" ||
    plan.settings.traysPerBatch !== 1 ||
    plan.planned.length !== 0 ||
    hasFaults(plan.faults)
  )
    return err({
      code: "unsupported_recipe",
      subject:
        "Use single-tray financier batches without rehearsal successors or handling faults",
    });
  const cells = new Map<string, NativeCell>();
  for (const definition of definitions) {
    const parsed = parseNativeCell(definition);
    if (!parsed.ok)
      return err({ code: "incompatible_cell", subject: parsed.error });
    if (cells.has(parsed.value.cellId))
      return err({ code: "incompatible_cell", subject: parsed.value.cellId });
    cells.set(parsed.value.cellId, parsed.value);
  }
  const used = new Set<string>();
  for (const operation of plan.operations) {
    const input = operation.attempt.input;
    const request = input.request;
    if (
      operation.start.kind !== "reset" ||
      input.kind !== "transfer" ||
      request.bakeryTaskId !== "table-to-rack" ||
      request.layout.kind !== "fixed" ||
      request.case !== "nominal"
    )
      return err({ code: "unsupported_operation", subject: operation.id });
    const cell = cells.get(input.bindings.cell);
    const definition = cell?.definition;
    if (
      cell === undefined ||
      !isRecord(definition) ||
      definition.schemaVersion !== 1 ||
      definition.fixture !== "persistent-rack/1" ||
      definition.robot !== request.robot ||
      definition.timestep !== request.timestep ||
      definition.modelHash !== request.modelHash ||
      definition.clampForceN !== request.clampForceN ||
      !sameJson(definition.ingredients, request.ingredients) ||
      request.execution.controller !== "bakery-native" ||
      !isRecord(definition.execution) ||
      definition.execution.backend !== request.execution.backend ||
      cell.controllerSourceHash !== request.execution.controllerSourceHash ||
      cell.controllerHash !== request.execution.controllerHash ||
      cell.runtimeHash !== request.execution.runtimeHash
    )
      return err({ code: "incompatible_cell", subject: input.bindings.cell });
    used.add(cell.cellId);
  }
  if (used.size !== cells.size)
    return err({
      code: "incompatible_cell",
      subject: "Provide exactly the cells used by the recipe",
    });
  return ok(cells);
}
