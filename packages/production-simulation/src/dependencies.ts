import { isNonNegativeInteger } from "@purin-labs/std";
import type { AdmissionProblem } from "./admission.ts";
import { taskId, workflowInstanceId, type TaskId } from "./identity.ts";
import type {
  ArrivalSource,
  CompiledScenario,
  InstanceDependency,
  InstanceTaskReference,
  WorkflowDefinition,
} from "./scenario.ts";

export function referencedTask(reference: InstanceTaskReference): TaskId {
  return taskId(
    workflowInstanceId(reference.source, reference.sequence),
    reference.key,
  );
}

export function indexDependencies(
  dependencies: readonly InstanceDependency[],
): ReadonlyMap<TaskId, readonly TaskId[]> {
  const index = new Map<TaskId, TaskId[]>();
  for (const dependency of dependencies) {
    const task = referencedTask(dependency.task);
    const prerequisites = index.get(task) ?? [];
    prerequisites.push(referencedTask(dependency.prerequisite));
    index.set(task, prerequisites);
  }
  return index;
}

function hasOccurrence(source: ArrivalSource, sequence: number): boolean {
  if (!isNonNegativeInteger(sequence)) return false;
  if (source.kind === "periodic") {
    if (source.limit.kind === "count") return sequence < source.limit.count;
    return (
      source.interval > 0 &&
      sequence <=
        Math.floor((source.limit.end - source.first) / source.interval)
    );
  }
  let count = 0;
  for (const arrival of source.arrivals) count += arrival.quantity;
  return sequence < count;
}

function referenceWorkflow(
  scenario: CompiledScenario,
  reference: InstanceTaskReference,
): WorkflowDefinition | null {
  for (const source of scenario.arrivals) {
    if (source.id !== reference.source) continue;
    if (!hasOccurrence(source, reference.sequence)) return null;
    for (const workflow of scenario.workflows) {
      if (workflow.id !== source.workflow) continue;
      for (const task of workflow.tasks)
        if (task.key === reference.key) return workflow;
    }
  }
  return null;
}

function addInstance(
  graph: Map<TaskId, Set<TaskId>>,
  reference: InstanceTaskReference,
  workflow: WorkflowDefinition,
): void {
  const instance = workflowInstanceId(reference.source, reference.sequence);
  for (const task of workflow.tasks) {
    const id = taskId(instance, task.key);
    if (graph.has(id)) continue;
    const prerequisites = new Set<TaskId>();
    for (const key of task.prerequisites)
      prerequisites.add(taskId(instance, key));
    graph.set(id, prerequisites);
  }
}

/** Check the combined graph without expanding unrelated periodic arrivals. */
export function checkDependencies(
  scenario: CompiledScenario,
  problems: AdmissionProblem[],
): void {
  const graph = new Map<TaskId, Set<TaskId>>();
  for (const [position, dependency] of scenario.dependencies.entries()) {
    const where = `dependency ${position}`;
    const workflow = referenceWorkflow(scenario, dependency.task);
    const upstream = referenceWorkflow(scenario, dependency.prerequisite);
    if (workflow === null || upstream === null) {
      problems.push({ code: "invalid_dependency", reason: "reference", where });
      continue;
    }
    addInstance(graph, dependency.task, workflow);
    addInstance(graph, dependency.prerequisite, upstream);
    const prerequisites = graph.get(referencedTask(dependency.task));
    if (prerequisites === undefined)
      throw new Error("Dependency task is absent");
    const prerequisite = referencedTask(dependency.prerequisite);
    if (prerequisites.has(prerequisite))
      problems.push({ code: "invalid_dependency", reason: "duplicate", where });
    prerequisites.add(prerequisite);
  }
  const pending = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  const ready: TaskId[] = [];
  for (const [task, prerequisites] of graph) {
    pending.set(task, prerequisites.size);
    if (prerequisites.size === 0) ready.push(task);
    for (const prerequisite of prerequisites) {
      const targets = dependents.get(prerequisite) ?? [];
      targets.push(task);
      dependents.set(prerequisite, targets);
    }
  }
  for (let position = 0; position < ready.length; position++) {
    const task = ready[position];
    if (task === undefined) throw new Error("Dependency queue is incomplete");
    for (const dependent of dependents.get(task) ?? []) {
      const count = pending.get(dependent);
      if (count === undefined) throw new Error("Dependent task is absent");
      pending.set(dependent, count - 1);
      if (count === 1) ready.push(dependent);
    }
  }
  if (ready.length !== graph.size)
    problems.push({
      code: "invalid_dependency",
      reason: "cycle",
      where: "dependencies",
    });
}
