import type { CompiledScenario, HostView } from "@purin-labs/production-simulation";
import { hasExactKeys, isRecord } from "@purin-labs/std";

/**
 * Plan 84: what went wrong in one accepted run, from the engine's own view. A
 * finding names the task or the order and holds numbers only. No model writes one,
 * and a page sends it to the Worker for the agent to read.
 */
export type RunFinding = Readonly<{
  id: string;
  kind:
    | "run_blocked"
    | "task_failed"
    | "recovery_failed"
    | "decision_rejected"
    | "late_order";
  /** The task or order that the finding names. */
  subject: string;
  /** Seconds from the run's start, and how long the order waited. */
  atSeconds: number;
  waitSeconds: number | null;
}>;

export const FINDINGS_LIMIT = 64;
/** A customer waits at most this long for an order. It matches the shift's target. */
export const ORDER_TARGET_SECONDS = 900;
const SERVED_DESTINATION = /(servings|served)$/u;
/** A finding reaches the model, so it holds identifiers and no free words. */
const IDENTIFIER = /^[A-Za-z0-9#/_.:-]{1,300}$/u;

function identifier(raw: string): string {
  return raw.replace(/[^A-Za-z0-9#/_.:-]+/gu, "-").slice(0, 256) || "run";
}

function seconds(ticks: number): number {
  return ticks / 1_000_000;
}

/** For each arrival that serves a customer, the steps that hand over a serving. */
function servingTasks(
  scenario: CompiledScenario,
): ReadonlyMap<string, readonly string[]> {
  const byWorkflow = new Map<string, string[]>();
  for (const workflow of scenario.workflows)
    for (const task of workflow.tasks)
      for (const output of task.outputs)
        if (
          "destination" in output &&
          SERVED_DESTINATION.test(String(output.destination))
        )
          byWorkflow.set(String(workflow.id), [
            ...(byWorkflow.get(String(workflow.id)) ?? []),
            String(task.key),
          ]);
  const arrivals = new Map<string, readonly string[]>();
  for (const arrival of scenario.arrivals) {
    const keys = byWorkflow.get(String(arrival.workflow));
    if (keys !== undefined) arrivals.set(String(arrival.id), keys);
  }
  return arrivals;
}

/** Customer orders whose last serving came too late or did not come. */
export function lateOrders(
  view: HostView,
  scenario: CompiledScenario,
): readonly RunFinding[] {
  if (view.production.kind !== "available") return [];
  const serving = servingTasks(scenario);
  const finished = new Map<string, number>();
  if (view.logistics.kind === "available")
    for (const task of view.logistics.tasks)
      if (task.kind === "completed") finished.set(task.id, task.completedAt);
  const late: RunFinding[] = [];
  for (const order of view.production.orders) {
    const instance = String(order.instance);
    const keys = serving.get(instance.split("#")[0] ?? "");
    if (keys === undefined) continue;
    let served: number | null = null;
    for (const key of keys) {
      const at = finished.get(`${instance}/${key}`);
      if (at !== undefined)
        served = served === null ? at : Math.max(served, at);
    }
    const arrived = order.arrivedAt as number;
    const wait = served === null ? null : seconds(served - arrived);
    if (wait !== null && wait <= ORDER_TARGET_SECONDS) continue;
    late.push({
      id: `late_order/${instance}`,
      kind: "late_order",
      subject: instance,
      atSeconds: seconds(served ?? arrived),
      waitSeconds: wait,
    });
  }
  return late;
}

export function runFindings(
  view: HostView,
  scenario: CompiledScenario,
): readonly RunFinding[] {
  const findings: RunFinding[] = [];
  if (view.status.kind === "blocked")
    findings.push({
      id: `run_blocked/${view.time}`,
      kind: "run_blocked",
      subject: identifier(view.status.need ?? "run"),
      atSeconds: seconds(view.time),
      waitSeconds: null,
    });
  for (const recovery of view.recoveries)
    if (recovery.kind === "recovery-failed")
      findings.push({
        id: `recovery_failed/${recovery.task}`,
        kind: "recovery_failed",
        subject: recovery.task,
        atSeconds: seconds(recovery.failedAt),
        waitSeconds: null,
      });
  if (view.logistics.kind === "available")
    for (const task of view.logistics.tasks)
      if (task.kind === "failed")
        findings.push({
          id: `task_failed/${task.id}`,
          kind: "task_failed",
          subject: task.id,
          atSeconds: seconds(task.failedAt),
          waitSeconds: null,
        });
  for (const inspection of view.inspections)
    if (inspection.kind === "recorded" && inspection.outcome === "reject")
      findings.push({
        id: `decision_rejected/${inspection.task}`,
        kind: "decision_rejected",
        subject: inspection.task,
        atSeconds: seconds(view.time),
        waitSeconds: null,
      });
  findings.push(...lateOrders(view, scenario));
  return findings.slice(0, FINDINGS_LIMIT);
}

const KINDS: ReadonlySet<unknown> = new Set([
  "run_blocked",
  "task_failed",
  "recovery_failed",
  "decision_rejected",
  "late_order",
]);

function parseFinding(raw: unknown): RunFinding | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["id", "kind", "subject", "atSeconds", "waitSeconds"]) ||
    typeof raw.id !== "string" ||
    !IDENTIFIER.test(raw.id) ||
    !KINDS.has(raw.kind) ||
    typeof raw.subject !== "string" ||
    !IDENTIFIER.test(raw.subject) ||
    typeof raw.atSeconds !== "number" ||
    !Number.isFinite(raw.atSeconds) ||
    (raw.waitSeconds !== null &&
      (typeof raw.waitSeconds !== "number" ||
        !Number.isFinite(raw.waitSeconds)))
  )
    return null;
  return raw as unknown as RunFinding;
}

/** A page sends these, so the Worker reads each one as it reads any request. */
export function parseRunFindings(raw: unknown): readonly RunFinding[] | null {
  if (!Array.isArray(raw) || raw.length > FINDINGS_LIMIT) return null;
  const findings: RunFinding[] = [];
  for (const item of raw) {
    const finding = parseFinding(item);
    if (finding === null) return null;
    findings.push(finding);
  }
  return findings;
}
