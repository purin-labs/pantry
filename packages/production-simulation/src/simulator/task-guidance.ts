import type { ActiveWorkcellView } from "./workcell-view.ts";
import type { WorkcellTask } from "../recipes/bakery/workcell-attempt.ts";
import type { WorkcellResourceId } from "../recipes/bakery/workcell-input.ts";
import { COLD_CELL } from "../recipes/bakery/workcell-instances.ts";
import { assertNever } from "@seams/std";

// A rack cycle loads and unloads Maruzen shelf 3 before racking.
const SHELF = COLD_CELL.skills["table-to-oven"].destination;

// Why a native task of the attempt has not started at the view's cursor.
export type TaskWait =
  | Readonly<{
      kind: "dependencies";
      tasks: readonly [WorkcellTask, ...WorkcellTask[]];
    }>
  | Readonly<{ kind: "start"; at: number }>
  | Readonly<{ kind: "evidence" | "failure" | "blocked" }>;

// Retrieval continues loading and racking continues retrieval.
export function taskDependencies(
  view: ActiveWorkcellView,
  task: WorkcellTask,
): readonly WorkcellTask[] {
  const input = view.attempt.input;
  if (input.kind === "rack-cycle" && task.id === input.rackTaskInstanceId) {
    for (const candidate of view.tasks)
      if (candidate.id === input.returnTaskInstanceId) return [candidate];
    throw new Error("A rack transfer requires retrieval.");
  }
  if (input.kind !== "transfer" && task.id === input.returnTaskInstanceId) {
    for (const candidate of view.tasks) {
      if (candidate.id === input.taskInstanceId) return [candidate];
    }
    throw new Error("An unloading task requires its loading task.");
  }
  return [];
}

export function taskWait(
  view: ActiveWorkcellView,
  task: WorkcellTask,
): TaskWait | null {
  if (task.status === "recovery-required") return { kind: "failure" };
  if (task.status === "running" || task.status === "completed") return null;
  const pending = taskDependencies(view, task).filter(incomplete);
  const first = pending[0];
  if (first !== undefined)
    return { kind: "dependencies", tasks: [first, ...pending.slice(1)] };
  if (task.status === "awaiting-evidence") return { kind: "evidence" };
  const start = view.attempt.input.dispatch.time;
  if (view.cursor.time < start) return { kind: "start", at: start };
  return { kind: "blocked" };
}

function incomplete(task: WorkcellTask): boolean {
  return task.status !== "completed";
}

export function waitLabel(wait: TaskWait): string {
  switch (wait.kind) {
    case "dependencies":
      return `Waiting for ${wait.tasks.map(taskName).join(" and ")}.`;
    case "start":
      return `Starts at ${wait.at.toFixed(2)} s.`;
    case "evidence":
      return "Waiting for a matching simulation result.";
    case "failure":
      return "This task failed. Dependent tasks cannot continue.";
    case "blocked":
      return "Waiting for resources to be released.";
    default:
      return assertNever(wait, "Unexpected task guidance");
  }
}
function taskName(task: WorkcellTask): string {
  return task.name;
}

export function trayHandoff(
  view: ActiveWorkcellView,
  task: WorkcellTask,
): Readonly<{ from: WorkcellResourceId; to: WorkcellResourceId }> | null {
  if (task.execution !== "native") return null;
  const input = view.attempt.input;
  if (input.kind === "rack-cycle") {
    if (task.id === input.taskInstanceId)
      return { from: input.bindings.source, to: SHELF };
    if (task.id === input.returnTaskInstanceId)
      return { from: SHELF, to: input.bindings.source };
    return { from: input.bindings.source, to: input.bindings.destination };
  }
  const returning =
    input.kind !== "transfer" && task.id === input.returnTaskInstanceId;
  return returning
    ? { from: input.bindings.destination, to: input.bindings.source }
    : { from: input.bindings.source, to: input.bindings.destination };
}
