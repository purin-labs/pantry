import type { AdmissionProblem } from "./admission.ts";
import type {
  BatchProgramId,
  ResourceId,
  StorageId,
  TaskKey,
} from "./identity.ts";
import type {
  CompiledScenario,
  ResourceDefinition,
  TaskDefinition,
} from "./scenario.ts";

/** Each batch storage has one owner and only its declared handling tasks. */
export function checkBatches(
  scenario: CompiledScenario,
  problems: AdmissionProblem[],
): void {
  const resources = new Map<ResourceId, ResourceDefinition>();
  const storages = new Set<StorageId>();
  for (const resource of scenario.resources) {
    resources.set(resource.id, resource);
    if (resource.kind !== "batch") continue;
    const where = `batch resource ${resource.id}`;
    let validStorage = false;
    for (const storage of scenario.storages)
      if (
        storage.id === resource.storage &&
        storage.capacity.kind === "carriers" &&
        storage.capacity.slots === resource.capacity
      )
        validStorage = true;
    if (storages.has(resource.storage)) validStorage = false;
    storages.add(resource.storage);
    for (const carrier of scenario.carriers)
      if (carrier.storage === resource.storage) validStorage = false;
    if (!validStorage)
      problems.push({ code: "invalid_batch", reason: "storage", where });
    const programs = new Set<BatchProgramId>();
    if (resource.programs.length === 0)
      problems.push({ code: "invalid_batch", reason: "program", where });
    for (const program of resource.programs) {
      if (programs.has(program.id) || program.duration <= 0)
        problems.push({ code: "invalid_batch", reason: "program", where });
      programs.add(program.id);
    }
  }
  for (const workflow of scenario.workflows) {
    const tasks = new Map<TaskKey, TaskDefinition>();
    const loads = new Set<TaskKey>();
    const unloads = new Set<TaskKey>();
    for (const task of workflow.tasks) tasks.set(task.key, task);
    for (const task of workflow.tasks) {
      const executor = task.executor;
      if (executor.kind !== "batch") continue;
      const where = `workflow ${workflow.id} task ${task.key}`;
      const resource = resources.get(executor.resource);
      if (resource?.kind !== "batch") {
        problems.push({ code: "invalid_batch", reason: "task", where });
        continue;
      }
      let programKnown = false;
      for (const program of resource.programs)
        if (program.id === executor.program) programKnown = true;
      if (!programKnown)
        problems.push({ code: "invalid_batch", reason: "program", where });
      let valid = task.claims.length === 0 && task.carriers.length === 0;
      for (const input of task.inputs) if (input.kind === "pool") valid = false;
      for (const output of task.outputs)
        if (
          output.kind === "lot" &&
          (output.holder.kind !== "carrier" ||
            output.holder.carrier !== executor.carrier)
        )
          valid = false;
      const load = tasks.get(executor.load);
      const unload = tasks.get(executor.unload);
      if (
        load === undefined ||
        unload === undefined ||
        !handling(load) ||
        !handling(unload) ||
        !task.prerequisites.includes(executor.load) ||
        !unload.prerequisites.includes(task.key) ||
        loads.has(executor.load) ||
        unloads.has(executor.unload)
      )
        valid = false;
      loads.add(executor.load);
      unloads.add(executor.unload);
      if (!valid)
        problems.push({ code: "invalid_batch", reason: "task", where });
      if (load === undefined || unload === undefined) continue;
      let enters = 0;
      let leaves = 0;
      for (const step of load.carriers)
        if (
          step.kind === "move" &&
          step.role === executor.carrier &&
          step.to === resource.storage &&
          step.from !== resource.storage
        )
          enters += 1;
      for (const step of unload.carriers)
        if (
          step.kind === "move" &&
          step.role === executor.carrier &&
          step.from === resource.storage &&
          step.to !== resource.storage
        )
          leaves += 1;
      if (enters !== 1 || leaves !== 1)
        problems.push({ code: "invalid_batch", reason: "route", where });
    }
    for (const task of workflow.tasks) {
      for (const step of task.carriers) {
        if (step.kind === "acquire" && storages.has(step.from))
          problems.push({
            code: "invalid_batch",
            reason: "route",
            where: `task ${task.key}`,
          });
        if (step.kind !== "move") continue;
        for (const resource of scenario.resources) {
          if (resource.kind !== "batch") continue;
          const entering = step.to === resource.storage;
          const leaving = step.from === resource.storage;
          if (!entering && !leaving) continue;
          let linked = false;
          for (const process of workflow.tasks) {
            const executor = process.executor;
            if (
              executor.kind !== "batch" ||
              executor.resource !== resource.id ||
              executor.carrier !== step.role
            )
              continue;
            if (
              (entering && executor.load === task.key) ||
              (leaving && executor.unload === task.key)
            )
              linked = true;
          }
          if (!linked)
            problems.push({
              code: "invalid_batch",
              reason: "route",
              where: `task ${task.key}`,
            });
        }
      }
    }
  }
}

function handling(task: TaskDefinition): boolean {
  return task.executor.kind !== "batch";
}
