import type {
  CompiledProcedure,
  ProcedureOperation,
} from "@purin-labs/bakery-model/bakery-procedure";
import type { Operation } from "@purin-labs/bakery-model/bakery";
import {
  simulate,
  type Run,
  type ScheduleSpatialLayout,
  type ScheduleVariant,
} from "../recipes/bakery/schedule.ts";
export type ProcedureRun = Readonly<{
  source: CompiledProcedure;
  schedule: Run;
}>;

export function runProcedure(
  source: CompiledProcedure,
  variant: ScheduleVariant,
  layout: ScheduleSpatialLayout | null,
): ProcedureRun {
  return Object.freeze({
    source,
    schedule: simulate(source.settings, variant, layout),
  });
}
export function operationForRun(
  run: ProcedureRun,
  operation: Operation,
): ProcedureOperation {
  for (const item of run.source.operations)
    if (item.operation === operation) return item;
  throw new Error(`Compiled procedure is missing ${operation}`);
}
