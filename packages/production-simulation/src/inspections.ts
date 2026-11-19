import { sameJson } from "@purin-labs/std";
import type { Variant } from "@purin-labs/type-utils";
import type {
  CommandRejection,
  ControlCommand,
  InspectionRequest,
} from "./commands.ts";
import {
  instanceLotId,
  type TaskId,
  type WorkflowInstanceId,
} from "./identity.ts";
import type { DecisionOutcome, DecisionRule } from "./scenario.ts";
import type { RunState } from "./state.ts";

export function inspectionDecision(
  commands: RunState["commands"],
  task: TaskId,
): Variant<ControlCommand, "inspect"> | null {
  for (const entry of commands)
    if (entry.command.kind === "inspect" && entry.command.task === task)
      return entry.command;
  return null;
}

/**
 * What a decision's rule gives. It reads only the definition, the arrival and
 * accepted events, so a replay and a restore check reach the same outcome.
 */
export function ruleOutcome(
  rule: DecisionRule,
  instance: Readonly<{ id: WorkflowInstanceId; sequence: number }>,
  events: RunState["events"],
): DecisionOutcome | null {
  if (rule.kind === "scripted")
    return (
      rule.outcomes[Math.min(instance.sequence, rule.outcomes.length - 1)] ??
      rule.outcomes[0]
    );
  const lot = instanceLotId(instance.id, rule.lot);
  for (const event of events)
    if (event.kind === "lot-produced" && event.lot === lot)
      return event.quantity.amount >= rule.minimum &&
        event.quantity.amount <= rule.maximum
        ? "accept"
        : "reject";
  return null;
}

/** Bind the operator decision to the exact held lots released by this task. */
export function inspectionLots(run: RunState, taskId: TaskId) {
  for (const task of run.tasks) {
    if (task.id !== taskId || task.subject.kind !== "workflow") continue;
    for (const instance of run.instances) {
      if (instance.id !== task.subject.instance) continue;
      for (const workflow of run.definition.scenario.workflows) {
        if (workflow.id !== instance.workflow) continue;
        for (const step of workflow.tasks) {
          if (
            step.key !== task.subject.key ||
            step.executor.kind !== "inspection"
          )
            continue;
          return step.releases.map(instanceLotId.bind(null, instance.id));
        }
      }
    }
  }
  return null;
}

export function inspectionRefusal(
  run: RunState,
  request: InspectionRequest,
): CommandRejection | null {
  if (inspectionDecision(run.commands, request.task) !== null)
    return "inspection_already_recorded";
  const lots = inspectionLots(run, request.task);
  if (
    lots === null ||
    request.definition !== run.definition.digest ||
    !sameJson(lots, request.lots)
  )
    return "inspection_binding_mismatch";
  for (const task of run.tasks) {
    if (task.id !== request.task) continue;
    if (
      task.kind !== "waiting" ||
      task.blockers.length !== 1 ||
      task.blockers[0]?.kind !== "inspection"
    )
      return "inspection_unavailable";
    for (const id of lots) {
      let held = false;
      for (const lot of run.lots)
        if (
          lot.id === id &&
          lot.disposition === "held" &&
          lot.remaining.amount > 0 &&
          lot.claims.length === 0
        )
          held = true;
      if (!held) return "inspection_unavailable";
    }
    return null;
  }
  return "inspection_unavailable";
}
