import * as d from "../../document-values.ts";
import { authoredId } from "../../identity.ts";
import { normalizeQuantity, type MaterialQuantity } from "../../quantity.ts";
import type { ResourceHistoryView } from "../../resource-history-view.ts";
import type {
  CompiledScenario,
  CarrierStep,
  MaterialInput,
  MaterialOutput,
  TaskDefinition,
} from "../../scenario.ts";
import { durationFromSeconds, ZERO_DURATION } from "../../time.ts";

export function mass(amount: number): MaterialQuantity {
  return d.value(normalizeQuantity({ amount, scale: 3, unit: "gram" }));
}
export function count(amount: number): MaterialQuantity {
  return d.value(normalizeQuantity({ amount, scale: 0, unit: "each" }));
}
export function seconds(value: number) {
  return d.value(durationFromSeconds(value));
}

export function pool(product: string, amount: number): MaterialInput {
  return {
    kind: "pool",
    product: authoredId("product", product),
    quantity: mass(amount),
  };
}
export function input(lot: string, amount: number): MaterialInput {
  return {
    kind: "lot",
    lot: authoredId("lot-key", lot),
    quantity: mass(amount),
  };
}
export function lot(
  key: string,
  role: string,
  amount: number,
  disposition: "released" | "held",
): MaterialOutput {
  return {
    kind: "lot",
    lot: authoredId("lot-key", key),
    product: authoredId("product", key),
    quantity: mass(amount),
    holder: { kind: "carrier", carrier: authoredId("carrier-role", role) },
    disposition,
    report: null,
  };
}
export function loss(product: string, amount: number): MaterialOutput {
  return {
    kind: "exit",
    product: authoredId("product", product),
    quantity: mass(amount),
    destination: authoredId("destination", product),
  };
}

export function acquire(role: string, from: string): CarrierStep {
  return {
    kind: "acquire",
    role: authoredId("carrier-role", role),
    from: authoredId("storage", from),
  };
}
export function release(role: string): CarrierStep {
  return { kind: "release", role: authoredId("carrier-role", role) };
}
export function move(
  role: string,
  from: string,
  to: string,
  duration: number,
): CarrierStep {
  return {
    kind: "move",
    role: authoredId("carrier-role", role),
    from: authoredId("storage", from),
    to: authoredId("storage", to),
    timing: {
      kind: "declared",
      pickupAfter: ZERO_DURATION,
      placementAfter: seconds(duration),
    },
  };
}
export function taskKey(key: string) {
  return authoredId("task-key", key);
}
export function claim(id: string) {
  return {
    resource: authoredId("resource", id),
    units: 1,
    configuration: null,
  };
}
export function task(
  key: string,
  previous: readonly string[],
  duration: number,
  work: "attended" | "declared",
  resources: readonly string[],
  inputs: readonly MaterialInput[],
  outputs: readonly MaterialOutput[],
  carriers: readonly CarrierStep[],
): TaskDefinition {
  return {
    key: taskKey(key),
    priority: 0,
    releaseAfter: ZERO_DURATION,
    prerequisites: previous.map(taskKey),
    claims: resources.map(claim),
    executor:
      work === "declared"
        ? { kind: "declared", duration: seconds(duration), evidence: "assumed" }
        : {
            kind: "attended",
            duration: seconds(duration),
            evidence: "assumed",
            workers: [authoredId("resource", "tea-worker")],
            start: authoredId("location", "tea-station"),
            finish: authoredId("location", "tea-station"),
          },
    inputs,
    outputs,
    carriers,
    releases: [],
  };
}

export type TeaStrainTiming =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "on-time";
      dueAt: number;
      startedAt: number;
      lateSeconds: 0;
    }>
  | Readonly<{
      kind: "late";
      dueAt: number;
      startedAt: number;
      lateSeconds: number;
    }>;

/** Review evidence only. The engine's held-lot inspection controls all release. */
export function teaStrainTiming(
  scenario: CompiledScenario,
  history: ResourceHistoryView,
  inspection: string,
): TeaStrainTiming {
  const suffix = "/inspect-strained-tea";
  if (
    (scenario.id !== "ginger-black-tea" &&
      scenario.id !== "ginger-milk-tea" &&
      scenario.id !== "mixed-tea" &&
      scenario.id !== "bakery-shift") ||
    history.kind !== "available" ||
    !inspection.endsWith(suffix)
  )
    return { kind: "unavailable" };
  const instance = inspection.slice(0, -suffix.length);
  const arrivalId = instance.slice(0, instance.lastIndexOf("#"));
  let workflowId: string | null = null;
  for (const arrival of scenario.arrivals)
    if (arrival.id === arrivalId) workflowId = arrival.workflow;
  const milk = workflowId === "ginger-milk-tea-batch";
  if (!milk && workflowId !== "ginger-tea-batch")
    return { kind: "unavailable" };
  const extractionKey = milk ? "simmer-tea" : "steep";
  const addKey = milk ? "add-tea" : "add-tea-and-cover";
  const strainKey = milk ? "strain-into-pan-b" : "strain-and-sweeten";
  let duration: number | null = null;
  for (const workflow of scenario.workflows)
    if (workflow.id === workflowId)
      for (const step of workflow.tasks)
        if (step.key === extractionKey && step.executor.kind === "declared")
          duration = step.executor.duration;
  let addedAt: number | null = null;
  let startedAt: number | null = null;
  for (const resource of history.resources) {
    // Any worker may add or strain: a tea worker, the shift's barista or baker.
    if (
      !resource.resource.startsWith("tea-worker") &&
      resource.resource !== "barista" &&
      resource.resource !== "baker"
    )
      continue;
    for (const span of resource.intervals) {
      if (span.kind !== "handling") continue;
      if (span.task === `${instance}/${addKey}` && !span.ongoing)
        addedAt = span.end;
      if (span.task === `${instance}/${strainKey}`) startedAt = span.start;
    }
  }
  if (duration === null || addedAt === null || startedAt === null)
    return { kind: "unavailable" };
  const dueAt = addedAt + duration;
  if (startedAt <= dueAt)
    return { kind: "on-time", dueAt, startedAt, lateSeconds: 0 };
  return {
    kind: "late",
    dueAt,
    startedAt,
    lateSeconds: (startedAt - dueAt) / 1_000_000,
  };
}
