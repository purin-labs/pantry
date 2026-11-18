import type {
  PhysicsRequest,
  PhysicsCyclePlan,
  PhysicsRackPlan,
} from "@seams/bakery-model/bakery-physics";

import {
  COLD_CELL,
  coldCell,
  type CellId,
  type CellInstance,
  RESOURCE_INSTANCES,
  type ResourceInstance,
  type ResourceInstanceId,
} from "./workcell-instances.ts";
import type { VariantBy } from "@seams/type-utils";
import { assertNever } from "@seams/std";

const compiled: unique symbol = Symbol("compiled cold-tray input");

export const MAX_WORKCELL_DISPATCH_SECONDS = 720 * 60;

// Requests bind the cell's explicit instances; see workcell-instances.ts.
const resources = RESOURCE_INSTANCES;

export type WorkcellResource = ResourceInstance;
export type WorkcellResourceId = ResourceInstanceId;

export const rackBindings = COLD_CELL.skills["table-to-rack"];

// Every request dispatches as one robot task at its requested time; the
// scheduler orders tasks, bakers and the cell around it. Saved runs and their
// fingerprints serialize this chain and dispatch with each input, so both keep
// the shape the retired chain scheduler gave them.
const ROBOT_TASK = Object.freeze({
  id: "workcell",
  name: "Robot transfer",
  earliestStart: 0,
  dependencies: Object.freeze([]),
  kind: "native",
  resource: rackBindings.arm,
} as const);
export const NATIVE_CHAIN = Object.freeze({
  production: null,
  tasks: Object.freeze([ROBOT_TASK] as const),
  unavailable: Object.freeze([]),
  failures: Object.freeze([]),
  recoveries: Object.freeze([]),
});
export type NativeChain = typeof NATIVE_CHAIN;
export type NativeDispatch = Readonly<{ kind: "scheduled"; time: number }>;

type InputIdentity = Readonly<{
  [compiled]: true;
  source: "local-simulation";
  taskInstanceId: `cold-tray:${string}:transfer-1`;
  dispatch: NativeDispatch;
  requestedDispatchTime: number;
  chain: NativeChain;
}>;
export type TransferInput = InputIdentity &
  Readonly<{
    kind: "transfer";
    returnTaskInstanceId?: never;
    returnRequest?: never;
    handoffDigest?: never;
  }> &
  (
    | Readonly<{
        request: VariantBy<PhysicsRequest, "bakeryTaskId", "table-to-rack">;
        bindings: CellInstance["skills"]["table-to-rack"];
      }>
    | Readonly<{
        request: VariantBy<PhysicsRequest, "bakeryTaskId", "table-to-oven">;
        bindings: CellInstance["skills"]["table-to-oven"];
      }>
  );
export type CycleInput = InputIdentity &
  Readonly<{
    kind: "oven-cycle";
    request: PhysicsCyclePlan["request"];
    returnTaskInstanceId: `cold-tray:${string}:transfer-2`;
    returnRequest: PhysicsCyclePlan["returnRequest"];
    handoffDigest: string;
    bindings: CellInstance["skills"]["table-to-oven"];
  }>;
export type NativeCycleInput = InputIdentity &
  Readonly<{
    kind: "native-cycle";
    request: PhysicsCyclePlan["request"];
    returnTaskInstanceId: `cold-tray:${string}:transfer-2`;
    returnRequest?: never;
    handoffDigest?: never;
    bindings: CellInstance["skills"]["table-to-oven"];
  }>;
export type RackCycleInput = InputIdentity &
  Readonly<{
    kind: "rack-cycle";
    request: PhysicsRackPlan["cycle"]["request"];
    returnTaskInstanceId: `cold-tray:${string}:transfer-2`;
    returnRequest: PhysicsRackPlan["cycle"]["returnRequest"];
    handoffDigest: string;
    rackTaskInstanceId: `cold-tray:${string}:transfer-3`;
    rackPlan: PhysicsRackPlan;
    bindings: CellInstance["skills"]["table-to-rack"];
  }>;
export type AnyCycleInput = CycleInput | NativeCycleInput | RackCycleInput;
export type WorkcellInput = TransferInput | AnyCycleInput;
export type WorkcellTaskId =
  | WorkcellInput["taskInstanceId"]
  | CycleInput["returnTaskInstanceId"]
  | RackCycleInput["rackTaskInstanceId"];

export type WorkcellInputResult<Input extends WorkcellInput = WorkcellInput> =
  | Readonly<{ kind: "ready"; input: Input; message?: never }>
  | Readonly<{
      kind: "invalid";
      field: "dispatchTime" | "request";
      message: string;
      input?: never;
    }>;

export function compileWorkcellInput(
  request: PhysicsRequest,
  dispatchSeconds: string,
  cellId: CellId,
): WorkcellInputResult<TransferInput> {
  const dispatchTime =
    dispatchSeconds.trim() === "" ? NaN : Number(dispatchSeconds);
  if (
    !Number.isInteger(dispatchTime) ||
    dispatchTime < 0 ||
    dispatchTime > MAX_WORKCELL_DISPATCH_SECONDS
  ) {
    return {
      kind: "invalid",
      field: "dispatchTime",
      message: `Enter a whole dispatch time from 0 to ${MAX_WORKCELL_DISPATCH_SECONDS} seconds.`,
    };
  }
  // The supported native skill fixes material, tooling, poses and resource bindings.
  const dispatch: NativeDispatch = Object.freeze({
    kind: "scheduled",
    time: dispatchTime,
  });
  let input: TransferInput;
  switch (request.bakeryTaskId) {
    case "table-to-rack":
      input = {
        [compiled]: true,
        kind: "transfer",
        source: "local-simulation",
        taskInstanceId: `cold-tray:${request.runId}:transfer-1`,
        request: Object.freeze(request),
        requestedDispatchTime: dispatchTime,
        dispatch,
        chain: NATIVE_CHAIN,
        bindings: coldCell(cellId).skills["table-to-rack"],
      };
      break;
    case "table-to-oven":
      input = {
        [compiled]: true,
        kind: "transfer",
        source: "local-simulation",
        taskInstanceId: `cold-tray:${request.runId}:transfer-1`,
        request: Object.freeze(request),
        requestedDispatchTime: dispatchTime,
        dispatch,
        chain: NATIVE_CHAIN,
        bindings: coldCell(cellId).skills["table-to-oven"],
      };
      break;
    default:
      return assertNever(request, "Unsupported workcell request");
  }
  return { kind: "ready", input: Object.freeze(input) };
}

export function compileCycleInput(
  plan: PhysicsCyclePlan,
  dispatchSeconds: string,
  cellId: CellId,
): WorkcellInputResult<CycleInput> {
  const loading = compileWorkcellInput(plan.request, dispatchSeconds, cellId);
  if (loading.kind === "invalid") return loading;
  return {
    kind: "ready",
    input: Object.freeze<CycleInput>({
      [compiled]: true,
      kind: "oven-cycle",
      source: "local-simulation",
      taskInstanceId: loading.input.taskInstanceId,
      dispatch: loading.input.dispatch,
      requestedDispatchTime: loading.input.requestedDispatchTime,
      chain: NATIVE_CHAIN,
      request: plan.request,
      returnTaskInstanceId: `cold-tray:${plan.request.runId}:transfer-2`,
      returnRequest: Object.freeze(plan.returnRequest),
      handoffDigest: plan.handoffDigest,
      bindings: coldCell(cellId).skills["table-to-oven"],
    }),
  };
}

export function compileNativeCycleInput(
  request: PhysicsRequest,
  dispatchSeconds: string,
  cellId: CellId,
): WorkcellInputResult<NativeCycleInput> {
  if (!isNominalOvenRequest(request)) {
    return {
      kind: "invalid",
      field: "request",
      message: "A native cycle requires a nominal table-to-oven request.",
    };
  }
  const loading = compileWorkcellInput(request, dispatchSeconds, cellId);
  if (loading.kind === "invalid") return loading;
  return {
    kind: "ready",
    input: Object.freeze<NativeCycleInput>({
      [compiled]: true,
      kind: "native-cycle",
      source: "local-simulation",
      taskInstanceId: loading.input.taskInstanceId,
      dispatch: loading.input.dispatch,
      requestedDispatchTime: loading.input.requestedDispatchTime,
      chain: NATIVE_CHAIN,
      request: Object.freeze(request),
      returnTaskInstanceId: `cold-tray:${request.runId}:transfer-2`,
      bindings: coldCell(cellId).skills["table-to-oven"],
    }),
  };
}

function isNominalOvenRequest(
  request: PhysicsRequest,
): request is PhysicsCyclePlan["request"] {
  return request.bakeryTaskId === "table-to-oven" && request.case === "nominal";
}

export function compileRackCycleInput(
  plan: PhysicsRackPlan,
  dispatchSeconds: string,
  cellId: CellId,
): WorkcellInputResult<RackCycleInput> {
  const loading = compileWorkcellInput(
    plan.cycle.request,
    dispatchSeconds,
    cellId,
  );
  if (loading.kind === "invalid") return loading;
  return {
    kind: "ready",
    input: Object.freeze<RackCycleInput>({
      [compiled]: true,
      kind: "rack-cycle",
      source: "local-simulation",
      taskInstanceId: loading.input.taskInstanceId,
      dispatch: loading.input.dispatch,
      requestedDispatchTime: loading.input.requestedDispatchTime,
      chain: NATIVE_CHAIN,
      request: plan.cycle.request,
      returnTaskInstanceId: `cold-tray:${plan.cycle.request.runId}:transfer-2`,
      returnRequest: plan.cycle.returnRequest,
      handoffDigest: plan.cycle.handoffDigest,
      rackTaskInstanceId: `cold-tray:${plan.cycle.request.runId}:transfer-3`,
      rackPlan: plan,
      bindings: coldCell(cellId).skills["table-to-rack"],
    }),
  };
}

export function workcellResources(
  input: WorkcellInput,
): readonly WorkcellResource[] {
  const bound = Object.values(input.bindings).map(workcellResource);
  if (input.kind === "rack-cycle")
    bound.push(
      workcellResource(
        coldCell(input.bindings.cell).skills["table-to-oven"].destination,
      ),
    );
  return bound;
}

export function workcellResource(id: WorkcellResourceId): WorkcellResource {
  for (const resource of resources) {
    if (resource.id === id) return resource;
  }
  throw new Error(`Unknown workcell resource: ${id}`);
}
