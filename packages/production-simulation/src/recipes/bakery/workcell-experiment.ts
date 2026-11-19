import { parseCellId } from "./workcell-instances.ts";
import {
  parsePhysicsReplay,
  parsePhysicsRequest,
  parsePhysicsCyclePlan,
  parsePhysicsRackPlan,
} from "@purin-labs/bakery-model/bakery-physics";
import { MAX_RUN_FILE_BYTES } from "@purin-labs/bakery-model/bakery-run-snapshot";
import {
  compileWorkcellInput,
  compileCycleInput,
  compileNativeCycleInput,
  compileRackCycleInput,
  NATIVE_CHAIN,
  type WorkcellInput,
  type WorkcellInputResult,
} from "./workcell-input.ts";
import {
  reserveWorkcell,
  attemptRecording,
  settleWorkcell,
  type ActiveAttempt,
  type WorkcellEvidence,
  type LoadingEvidence,
} from "./workcell-attempt.ts";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

const validated: unique symbol = Symbol("validated workcell experiment");
export const MAX_EXPERIMENT_BYTES = MAX_RUN_FILE_BYTES;

// One native request and its evidence. Saved rehearsal and production runs
// embed this format for each operation. Earlier files with workflow tasks,
// faults or a financier batch are converted by rehearsal-conversion.ts.
export type WorkcellExperiment = Readonly<{ [validated]: true }> &
  (
    | Readonly<{
        kind: "pending";
        input: WorkcellInput;
        recording?: never;
        mode?: never;
      }>
    | (Readonly<{ kind: "recorded" }> & (WorkcellEvidence | LoadingEvidence))
  );

export type ExperimentImport =
  | Readonly<{
      kind: "accepted";
      experiment: WorkcellExperiment;
      message?: never;
    }>
  | Readonly<{
      kind: "rejected";
      message: string;
      experiment?: never;
    }>;

// The canvas position of the robot task, kept so saved bytes are unchanged.
const PRESENTATION = { workcell: { x: 24, y: 24 } };

export function exportWorkcellExperiment(attempt: ActiveAttempt): string {
  return JSON.stringify({
    schemaVersion: 3,
    kind: "bakery-workcell-experiment",
    input: { ...savedInput(attempt.input), chain: NATIVE_CHAIN },
    evidence: attemptRecording(attempt),
    presentation: PRESENTATION,
  });
}

function savedInput(input: WorkcellInput) {
  if (input.kind === "rack-cycle")
    return {
      kind: "rack-cycle",
      plan: input.rackPlan,
      dispatchTime: input.requestedDispatchTime,
      bindings: input.bindings,
    };
  if (input.kind === "native-cycle")
    return {
      kind: "native-cycle",
      request: input.request,
      dispatchTime: input.requestedDispatchTime,
      bindings: input.bindings,
    };
  if (input.kind === "oven-cycle")
    return {
      kind: "oven-cycle",
      request: input.request,
      returnRequest: input.returnRequest,
      handoffDigest: input.handoffDigest,
      dispatchTime: input.requestedDispatchTime,
      bindings: input.bindings,
    };
  return {
    request: input.request,
    dispatchTime: input.requestedDispatchTime,
    bindings: input.bindings,
  };
}

export function parseWorkcellExperiment(text: string): ExperimentImport {
  try {
    if (
      text.length > MAX_EXPERIMENT_BYTES ||
      new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES
    ) {
      throw new Error("Choose an experiment smaller than 16 MiB plus 64 KiB.");
    }
    const document = object(JSON.parse(text));
    const raw = fields(document, [
      "schemaVersion",
      "kind",
      "input",
      "evidence",
      ...(document.schemaVersion === 3 ? ["presentation"] : []),
    ]);
    if (
      (raw.schemaVersion !== 1 &&
        raw.schemaVersion !== 2 &&
        raw.schemaVersion !== 3) ||
      raw.kind !== "bakery-workcell-experiment"
    ) {
      throw new Error("Choose a supported local workcell run file.");
    }
    const input = parseSavedInput(raw.input, raw.schemaVersion);
    if (raw.schemaVersion === 3) checkPresentation(raw.presentation);
    if (raw.evidence === null) {
      return {
        kind: "accepted",
        experiment: { [validated]: true, kind: "pending", input },
      };
    }
    const evidence = parsePhysicsReplay(JSON.stringify(raw.evidence));
    if (evidence.kind === "rejected") throw new Error(evidence.message);
    // Exercise the same settlement boundary without restoring serialized lifecycle state.
    const reservation = reserveWorkcell({ kind: "empty" }, input);
    if (reservation.kind === "rejected") throw new Error(reservation.message);
    const settlement = settleWorkcell(reservation.attempt, evidence.recording);
    if (settlement.kind === "rejected") throw new Error(settlement.message);
    return {
      kind: "accepted",
      experiment: recordedExperiment(settlement.attempt),
    };
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof SyntaxError
          ? "Choose an exported local experiment JSON file."
          : error instanceof Error
            ? error.message
            : "Unable to read this experiment. Choose the exported file again.",
    };
  }
}

function parseSavedInput(value: unknown, version: 1 | 2 | 3): WorkcellInput {
  const saved = object(value);
  if (version !== 1 && !isNativeChain(saved.chain))
    throw new Error(
      "This run has workflow tasks, faults or a financier batch. Open it from Multi-tray rehearsal → Files, which converts it.",
    );
  const raw = version === 1 ? saved : withoutChain(saved);
  let compiled: WorkcellInputResult;
  if (typeof raw.dispatchTime !== "number")
    throw new Error("The experiment must contain a numeric dispatch time.");
  const dispatch = String(raw.dispatchTime);
  const cell = parseCellId(object(raw.bindings).cell);
  if (cell === null) throw new Error("Choose a supported cold cell.");
  if (raw.kind === "rack-cycle") {
    fields(raw, ["kind", "plan", "dispatchTime", "bindings"]);
    const plan = parsePhysicsRackPlan(JSON.stringify(raw.plan));
    if (plan.kind === "rejected") throw new Error(plan.message);
    compiled = compileRackCycleInput(plan.plan, dispatch, cell);
  } else if (raw.kind === "oven-cycle") {
    fields(raw, [
      "kind",
      "request",
      "returnRequest",
      "handoffDigest",
      "dispatchTime",
      "bindings",
    ]);
    const plan = parsePhysicsCyclePlan(
      JSON.stringify({
        request: raw.request,
        returnRequest: raw.returnRequest,
        handoffDigest: raw.handoffDigest,
      }),
    );
    if (plan.kind === "rejected") throw new Error(plan.message);
    compiled = compileCycleInput(plan.plan, dispatch, cell);
  } else if (raw.kind === "native-cycle") {
    fields(raw, ["kind", "request", "dispatchTime", "bindings"]);
    const request = parsePhysicsRequest(JSON.stringify(raw.request));
    if (request.kind === "rejected") throw new Error(request.message);
    compiled = compileNativeCycleInput(request.request, dispatch, cell);
  } else {
    fields(raw, ["request", "dispatchTime", "bindings"]);
    const request = parsePhysicsRequest(JSON.stringify(raw.request));
    if (request.kind === "rejected") throw new Error(request.message);
    compiled = compileWorkcellInput(request.request, dispatch, cell);
  }
  if (compiled.kind === "invalid") throw new Error(compiled.message);
  const input = compiled.input;
  const bindings = fields(raw.bindings, Object.keys(input.bindings));
  for (const [role, resource] of Object.entries(input.bindings)) {
    if (bindings[role] !== resource)
      throw new Error(
        "Experiment resources differ from the supported workcell. Export a new experiment.",
      );
  }
  return input;
}

function withoutChain(value: Record<string, unknown>): Record<string, unknown> {
  const { chain, ...input } = value;
  return input;
}

// Earlier versions saved each request's workflow; a current request is its
// single robot task.
function isNativeChain(value: unknown): boolean {
  try {
    const chain = fields(value, [
      "production",
      "tasks",
      "unavailable",
      "failures",
      "recoveries",
    ]);
    if (
      chain.production !== null ||
      !isEmptyList(chain.unavailable) ||
      !isEmptyList(chain.failures) ||
      !isEmptyList(chain.recoveries) ||
      !Array.isArray(chain.tasks) ||
      chain.tasks.length !== 1
    )
      return false;
    const task = fields(chain.tasks[0], [
      "id",
      "name",
      "earliestStart",
      "dependencies",
      "kind",
      "resource",
    ]);
    const native = NATIVE_CHAIN.tasks[0];
    return (
      task.id === native.id &&
      task.name === native.name &&
      task.earliestStart === native.earliestStart &&
      isEmptyList(task.dependencies) &&
      task.kind === native.kind &&
      task.resource === native.resource
    );
  } catch {
    return false;
  }
}
function isEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

// Version 3 saved the robot task's canvas position.
function checkPresentation(value: unknown): void {
  for (const [id, position] of Object.entries(object(value))) {
    const point = id === "workcell" ? fields(position, ["x", "y"]) : null;
    if (
      point === null ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !(point.x >= 0 && point.x <= 780 && point.y >= 0 && point.y <= 2200)
    )
      throw new Error("Canvas position is outside the supported workspace.");
  }
}

function recordedExperiment(
  evidence: WorkcellEvidence | LoadingEvidence,
): Variant<WorkcellExperiment, "recorded"> {
  switch (evidence.mode) {
    case "rack-cycle":
      return {
        [validated]: true,
        kind: "recorded",
        mode: "rack-cycle",
        input: evidence.input,
        recording: evidence.recording,
      };
    case "cycle-loading":
      return {
        [validated]: true,
        kind: "recorded",
        mode: "cycle-loading",
        input: evidence.input,
        recording: evidence.recording,
      };
    case "transfer":
      return {
        [validated]: true,
        kind: "recorded",
        mode: "transfer",
        input: evidence.input,
        recording: evidence.recording,
      };
    case "oven-cycle":
      return {
        [validated]: true,
        kind: "recorded",
        mode: "oven-cycle",
        input: evidence.input,
        recording: evidence.recording,
      };
    case "cycle-loading-failed":
      return {
        [validated]: true,
        kind: "recorded",
        mode: "cycle-loading-failed",
        input: evidence.input,
        recording: evidence.recording,
      };
    default:
      return assertNever(evidence, "Unexpected workcell evidence");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Experiment data is incomplete. Choose the exported file again.",
    );
  return Object.fromEntries(Object.entries(value));
}

function fields(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> {
  const entries = Object.entries(object(value));
  if (entries.length !== expected.length) {
    throw new Error("Experiment fields differ from the supported format.");
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (!expected.includes(key)) {
      throw new Error("Experiment fields differ from the supported format.");
    }
    result[key] = entry;
  }
  return result;
}
