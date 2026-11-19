import {
  type CompiledProcedure,
  type ProcedureAssumptionsResult,
  type ProcedureOperation,
  type ProcedureResult,
  type ProcedureSnapshot,
} from "@purin-labs/bakery-model/bakery-procedure";
import {
  type Settings,
  type SettingsResult,
} from "@purin-labs/bakery-model/bakery";
import type { Process, Run, TaskSnapshot, TaskEvent } from "./schedule.ts";
import type { ScenarioCopy } from "@purin-labs/bakery-model/bakery-scenario";
import type { Variant } from "@purin-labs/type-utils";
import type { FinancierRunInput, ResolvedRunInput } from "./schedule.ts";
import { compileFinancier, compileProductionFinancier } from "./financier.ts";
import type { ProductionWorkcells } from "./production-workcells.ts";

declare const rawProduction: Omit<ProductionWorkcells, symbol>;
// @ts-expect-error Native authoring must pass the production-workcell boundary.
void compileProductionFinancier({ ...rawProduction }, []);

declare const nativeInput: ResolvedRunInput & { source: "production" };
declare const rawFinancier: Omit<FinancierRunInput, symbol>;
// @ts-expect-error Authored rules must cross the resolver boundary.
const uncheckedFinancier: FinancierRunInput = { ...rawFinancier };
// @ts-expect-error The declared compiler cannot silently omit native operations.
void compileFinancier(nativeInput);
// @ts-expect-error A broad native input spread does not become a declared recipe.
void compileFinancier({ ...nativeInput });
void uncheckedFinancier;

declare const process: Process;
declare const run: Run;
declare const raw: Readonly<Record<string, number>>;
// @ts-expect-error Attended steps require an allocated worker and travel route.
const missingWorker: Process = {
  kind: "process",
  id: "batch:A:process:stage",
  batch: "A",
  station: "stage",
  operation: "stage",
  start: 0,
  arrival: 0,
  end: 60,
  attended: true,
};
const invalidLabor: Process = {
  ...process,
  attended: false,
  // @ts-expect-error Unattended processing cannot acquire a worker through a spread.
  executor: "human-1",
};
// @ts-expect-error A completed run cannot contain unfinished work.
const invalidRun: Run = { ...run, kind: "complete", unfinished: ["A"] };
// @ts-expect-error Raw fields must cross the validated settings boundary.
const unvalidated: Settings = raw;
// @ts-expect-error A failed parse cannot carry successful settings.
const invalidResult: SettingsResult = {
  kind: "invalid",
  field: "stage",
  message: "Invalid",
  settings: run.settings,
};
void [missingWorker, invalidLabor, invalidRun, unvalidated, invalidResult];

// @ts-expect-error A completion requires simulation evidence.
const unevidencedTask: TaskSnapshot = { kind: "completed", task: process };
declare const completedTask: Variant<TaskSnapshot, "completed">;
// @ts-expect-error A running task cannot retain terminal evidence through a spread.
const prematureCompletion: TaskSnapshot = { ...completedTask, kind: "running" };
// @ts-expect-error Processing cannot emit a tray-pickup observation.
const falsePickup: TaskEvent = { kind: "picked-up", time: 0, task: process };
const numericExecutor: Process = {
  ...process,
  attended: true,
  // @ts-expect-error Executor identity cannot revert to an array index.
  executor: 0,
  emptyRoute: [],
};
void [unevidencedTask, prematureCompletion, falsePickup, numericExecutor];

const wrongTaskIdentity: Process = {
  ...process,
  // @ts-expect-error Process tasks cannot carry a transfer identity.
  id: "batch:A:transfer:stage:portion",
};
void wrongTaskIdentity;

declare const snapshot: ProcedureSnapshot;
declare const procedure: CompiledProcedure;
// @ts-expect-error Entity records must pass cross-record procedure compilation.
const uncompiled: CompiledProcedure = snapshot;
// @ts-expect-error A rejected procedure cannot also carry a runnable definition.
const failedProcedure: ProcedureResult = {
  kind: "invalid",
  message: "Missing connection",
  procedure,
};
void [uncompiled, failedProcedure];

declare const operationWithoutRevision: Omit<ProcedureOperation, "revision">;
// @ts-expect-error Saved operation edits require the loaded entity revision.
const unversionedOperation: ProcedureOperation = {
  ...operationWithoutRevision,
};
void unversionedOperation;

declare const rawScenario: Omit<ScenarioCopy, symbol>;
// @ts-expect-error Scenario copies must pass the shared input boundary.
const unvalidatedScenario: ScenarioCopy = { ...rawScenario };
void unvalidatedScenario;

// @ts-expect-error Invalid assumptions cannot expose a runnable procedure.
const invalidAssumptions: ProcedureAssumptionsResult = {
  kind: "invalid",
  field: "workerCount",
  message: "Invalid",
  procedure,
};
// @ts-expect-error A valid result cannot carry an error through a broad spread.
const ambiguousAssumptions: ProcedureAssumptionsResult = {
  ...invalidAssumptions,
  kind: "valid",
  procedure,
};
void [invalidAssumptions, ambiguousAssumptions];
