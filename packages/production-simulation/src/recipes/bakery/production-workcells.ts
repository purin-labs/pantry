import {
  ROBOTS,
  type RobotModel,
} from "@purin-labs/bakery-model/bakery-robots";
import {
  HUMAN_CELL_TRANSFER,
  parseHumanCellTransfer,
  humanCellTransferInput,
  supportsHumanCellTransfer,
} from "./human-cell-transfer.ts";
import type { CellId } from "./workcell-instances.ts";
import {
  productionMaterialBinding,
  validateProductionMaterial,
  type ProductionMaterialBinding,
} from "./production-material.ts";
import {
  bakeryFingerprint,
  fields,
  parseSettings,
  type Settings,
} from "@purin-labs/bakery-model/bakery";
import {
  parsePhysicsReplay,
  sameIngredientLoad,
  parsePhysicsRequest,
  type PhysicsReplay,
  type IngredientLoad,
} from "@purin-labs/bakery-model/bakery-physics";
import {
  reserveWorkcell,
  settleWorkcell,
  type ActiveAttempt,
} from "./workcell-attempt.ts";
import {
  compileWorkcellInput,
  compileNativeCycleInput,
  type TransferInput,
  type WorkcellInput,
} from "./workcell-input.ts";
import {
  continuationInput,
  continuationState,
  parseNativeContinuation,
  type ContinuationState,
  type NativeContinuation,
} from "./native-continuation.ts";
import { physicsDuration } from "./physics-playback.ts";
import {
  COLD_TRAY_HANDLING,
  NO_FAULTS,
  faultProblem,
  handlingTaskId,
  hasFaults,
  parseRunFaults,
  type HandlingTaskId,
  type RunFaults,
} from "./run-faults.ts";
import {
  productionAssignmentId,
  parseProductionScenario,
  productionDefinitionFingerprint,
  validProductionWorkflow,
  parseProductionManualTasks,
  type ProductionManualTask,
  type ProductionAssignment,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import {
  exportWorkcellExperiment,
  parseWorkcellExperiment,
  MAX_EXPERIMENT_BYTES,
} from "./workcell-experiment.ts";
import type { Variant } from "@purin-labs/type-utils";
import {
  compareCodePoints,
  hasExactKeys,
  isString,
  isRecord,
} from "@purin-labs/std";

const validated: unique symbol = Symbol("compiled production workcells");
export type ProductionSource =
  | Readonly<{ kind: "local"; definition?: never }>
  | Readonly<{ kind: "shared"; definition: ProductionScenario }>;
// Financier production runs one table-to-rack transfer per tray after cooling.
// A rehearsal tray runs a chain of cold-proxy skills in the workcell.
export type ProductionProcedure = "financier" | "rehearsal";
export type ContinuationSkill =
  | Readonly<{
      kind: "restage";
      route: typeof HUMAN_CELL_TRANSFER;
      rackCase?: never;
    }>
  | Readonly<{ kind: "unload"; rackCase?: never }>
  | Readonly<{ kind: "rack"; rackCase: "nominal" | "slip" }>;
// A continuation resumes its predecessor's handoff. Once its own result is
// settled, a saved run keeps only the handoff digest and the recorded prefix.
export type ProductionStart =
  | Readonly<{
      kind: "restaged";
      predecessorId: string;
      digest: string;
      handoff?: never;
      prefixSeconds?: never;
    }>
  | Readonly<{
      kind: "reset";
      predecessorId?: never;
      handoff?: never;
      digest?: never;
      prefixSeconds?: never;
    }>
  | Readonly<{
      kind: "continuation";
      predecessorId: string;
      handoff: NativeContinuation;
      digest?: never;
      prefixSeconds?: never;
    }>
  | Readonly<{
      kind: "continued";
      predecessorId: string;
      digest: string;
      prefixSeconds: number;
      handoff?: never;
    }>;
type OperationIdentity = Readonly<{
  id: string;
  batchId: string;
  tray: number;
  step: number;
  workerId: ProductionAssignment["workerId"];
  dependsOn: ProductionAssignment["dependsOn"];
  earliestStartSeconds: number;
  material: ProductionMaterialBinding;
}>;
// A bound operation owns the continuation state its completed result produced.
export type ProductionWorkcell = OperationIdentity &
  Readonly<{
    start: ProductionStart;
    attempt: ActiveAttempt;
    handoff: NativeContinuation | null;
  }>;
// A planned successor has no request until its predecessor's state is accepted.
export type PlannedProductionWorkcell = OperationIdentity &
  Readonly<{
    predecessorId: string;
    skill: ContinuationSkill;
    attempt?: never;
    start?: never;
  }>;
export type CellRobot =
  | Readonly<{ kind: "unused"; robot?: never }>
  | Readonly<{ kind: "assigned"; robot: RobotModel }>;
export type CellRobots = Readonly<Record<CellId, CellRobot>>;

// Derive the saved cell configuration from roots and reserved human transfers.
// A cell has one physical arm for the entire run.
function bindCellRobots(
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
):
  | Readonly<{ kind: "ready"; cells: CellRobots }>
  | Readonly<{ kind: "rejected"; message: string }> {
  const cells: Record<CellId, CellRobot> = {
    "cold-cell-1": { kind: "unused" },
    "cold-cell-2": { kind: "unused" },
  };
  for (const operation of operations) {
    const input = operation.attempt.input;
    const destinations: CellId[] = [input.bindings.cell];
    if (planned.some(isHumanPredecessor.bind(null, operation.id)))
      destinations.push("cold-cell-2");
    for (const cell of destinations) {
      const selected = cells[cell];
      if (
        selected.kind === "assigned" &&
        selected.robot !== input.request.robot
      )
        return rejected(
          `${cell} already uses ${ROBOTS[selected.robot].label}. Use that arm for every operation in this cell, or select another cell.`,
        );
      cells[cell] = Object.freeze({
        kind: "assigned",
        robot: input.request.robot,
      });
    }
  }
  return { kind: "ready", cells: Object.freeze(cells) };
}

function sameCellRobots(raw: unknown, cells: CellRobots): boolean {
  const saved = object(raw);
  if (!hasExactKeys(saved, ["cold-cell-1", "cold-cell-2"])) return false;
  for (const cell of ["cold-cell-1", "cold-cell-2"] as const) {
    const expected = cells[cell];
    const actual = object(saved[cell]);
    if (expected.kind === "unused") {
      if (!hasExactKeys(actual, ["kind"]) || actual.kind !== "unused")
        return false;
    } else if (
      !hasExactKeys(actual, ["kind", "robot"]) ||
      actual.kind !== "assigned" ||
      actual.robot !== expected.robot
    )
      return false;
  }
  return true;
}

export type ProductionWorkcells = Readonly<{
  [validated]: true;
  cellRobots: CellRobots;
  procedure: ProductionProcedure;
  fingerprint: string;
  manualTasks: readonly ProductionManualTask[];
  procedureFingerprint: string | null;
  settings: Settings;
  variant: "normal" | "outage";
  // Rehearsal assumptions. Production scenarios keep the oven outage variant.
  faults: RunFaults;
  source: ProductionSource;
  operations: readonly ProductionWorkcell[];
  planned: readonly PlannedProductionWorkcell[];
}>;
const RESET: ProductionStart = Object.freeze({ kind: "reset" });
export type ProductionWorkcellsResult =
  | Readonly<{ kind: "ready"; plan: ProductionWorkcells; message?: never }>
  | Readonly<{ kind: "rejected"; message: string; plan?: never }>;

export async function compileProductionWorkcells(
  settings: Settings,
  variant: ProductionWorkcells["variant"],
  assignments: readonly Readonly<{
    batchId: string;
    tray: number;
    workerId: ProductionAssignment["workerId"];
    dependsOn: ProductionAssignment["dependsOn"];
    earliestStartSeconds: number;
    input: TransferInput;
  }>[],
  workflow: Readonly<{
    manualTasks: readonly ProductionManualTask[];
    procedureFingerprint: string | null;
  }>,
): Promise<ProductionWorkcellsResult> {
  if (assignments.length === 0 || assignments.length > 16)
    return rejected("Assign between one and sixteen cold-tray operations.");
  const manualTasks = parseProductionManualTasks(
    workflow.manualTasks,
    settings,
    assignments,
    "cold-racking",
  );
  if (manualTasks === null)
    return rejected("Review the manual task assignments and start times.");
  const operations: ProductionWorkcell[] = [];
  const slots = new Set<string>();
  const requests = new Set<string>();
  for (const assignment of assignments) {
    const batch = assignment.batchId.charCodeAt(0) - 65;
    const input = assignment.input;
    if (
      assignment.batchId.length !== 1 ||
      batch < 0 ||
      batch >= settings.batchCount ||
      !Number.isInteger(assignment.tray) ||
      assignment.tray < 1 ||
      assignment.tray > settings.traysPerBatch
    )
      return rejected("Choose an existing production batch and tray.");
    const workerNumber = Number(assignment.workerId.slice(6));
    if (
      assignment.workerId !== `human-${workerNumber}` ||
      !Number.isInteger(workerNumber) ||
      workerNumber < 1 ||
      workerNumber > settings.workerCount
    )
      return rejected(
        "Choose an available baker for native staging and clearance.",
      );
    if (
      !Number.isInteger(assignment.earliestStartSeconds) ||
      assignment.earliestStartSeconds < 0 ||
      assignment.earliestStartSeconds >= settings.horizonMinutes * 60
    )
      return rejected("Choose an earliest staging time within this shift.");
    if (!productionTransfer(input))
      return rejected(
        "Production owns dispatch. Use an individual cold table-to-rack request with no local workflow edits.",
      );
    const id = productionAssignmentId(assignment);
    const identity = JSON.stringify([
      input.request.runId,
      input.request.attemptId,
    ]);
    if (slots.has(id) || requests.has(identity))
      return rejected(
        "Each production tray and native attempt may be assigned only once.",
      );
    slots.add(id);
    requests.add(identity);
    const reserved = reserveWorkcell({ kind: "empty" }, input);
    if (reserved.kind === "rejected") return reserved;
    operations.push(
      Object.freeze({
        id,
        batchId: assignment.batchId,
        tray: assignment.tray,
        workerId: assignment.workerId,
        dependsOn: Object.freeze([...assignment.dependsOn].sort()),
        earliestStartSeconds: assignment.earliestStartSeconds,
        step: 1,
        material: productionMaterialBinding(
          assignment.batchId,
          assignment.tray,
          assignment.input.bindings,
        ),
        start: RESET,
        attempt: reserved.attempt,
        handoff: null,
      }),
    );
  }
  const robots = bindCellRobots(operations, []);
  if (robots.kind === "rejected") return robots;
  operations.sort(compareOperation);
  if (
    !validProductionWorkflow(settings, operations, manualTasks, "cold-racking")
  )
    return rejected(
      "Choose existing task predecessors without a material-order cycle.",
    );
  const workflowFingerprint = await bakeryFingerprint(
    JSON.stringify({
      settings,
      variant,
      operations: operations.map(executionIdentity),
      manualTasks,
      procedureFingerprint: workflow.procedureFingerprint,
      handling: COLD_TRAY_HANDLING,
    }),
  );
  const bound: ProductionWorkcell[] = [];
  for (const operation of operations) {
    const attemptId = `production-${await bakeryFingerprint(JSON.stringify([workflowFingerprint, operation.id]))}`;
    const request = parsePhysicsRequest(
      JSON.stringify({ ...operation.attempt.input.request, attemptId }),
    );
    if (request.kind === "rejected") return rejected(request.message);
    const input = compileWorkcellInput(
      request.request,
      "0",
      operation.attempt.input.bindings.cell,
    );
    if (input.kind === "invalid") return rejected(input.message);
    const reserved = reserveWorkcell({ kind: "empty" }, input.input);
    if (reserved.kind === "rejected") return reserved;
    bound.push(Object.freeze({ ...operation, attempt: reserved.attempt }));
  }
  const fingerprint = await productionRunFingerprint(
    settings,
    variant,
    bound,
    manualTasks,
    workflow.procedureFingerprint,
  );
  return {
    kind: "ready",
    plan: Object.freeze<ProductionWorkcells>({
      [validated]: true,
      cellRobots: robots.cells,
      procedure: "financier",
      fingerprint,
      manualTasks,
      procedureFingerprint: workflow.procedureFingerprint,
      settings,
      variant,
      faults: NO_FAULTS,
      source: { kind: "local" },
      operations: Object.freeze(bound),
      planned: Object.freeze([]),
    }),
  };
}

export type RehearsalTray = Readonly<{
  batchId: string;
  workerId: ProductionAssignment["workerId"];
  dependsOn: readonly string[];
  earliestStartSeconds: number;
  input: WorkcellInput;
  successors: readonly Readonly<{
    skill: ContinuationSkill;
    earliestStartSeconds: number;
  }>[];
}>;

// Rehearsal trays run robot-only chains in the cold workcell: staging, the
// authored skills, then clearance. Prerequisites gate a tray before it takes
// the cell, so a held cell never waits for work that needs it.
export async function compileRehearsalWorkcells(
  settings: Settings,
  trays: readonly RehearsalTray[],
  faults: RunFaults = NO_FAULTS,
): Promise<ProductionWorkcellsResult> {
  if (settings.traysPerBatch !== 1)
    return rejected("A rehearsal tray is its own batch of one tray.");
  const count = trays.reduce(countOperations, 0);
  if (trays.length === 0 || count > 16)
    return rejected("Author between one and sixteen native operations.");
  const operations: ProductionWorkcell[] = [];
  const planned: PlannedProductionWorkcell[] = [];
  const owners = new Map<string, string>();
  const requests = new Set<string>();
  for (const tray of trays) {
    if (
      !/^[A-P]$/.test(tray.batchId) ||
      trays.filter(sameBatch.bind(null, tray.batchId)).length !== 1
    )
      return rejected("Name each rehearsal tray with a unique letter A–P.");
    const workerNumber = Number(tray.workerId.slice(6));
    if (
      tray.workerId !== `human-${workerNumber}` ||
      !Number.isInteger(workerNumber) ||
      workerNumber < 1 ||
      workerNumber > settings.workerCount
    )
      return rejected("Choose an available baker for staging and clearance.");
    const input = tray.input;
    const identity = JSON.stringify([
      input.request.runId,
      input.request.attemptId,
    ]);
    if (!rehearsalRoot(input) || requests.has(identity))
      return rejected(
        "Start each tray from its own native request with no local workflow edits.",
      );
    requests.add(identity);
    const allowed = supportsHumanCellTransfer(input)
      ? (["restage"] as const)
      : successorSkills(input);
    if (
      tray.successors.length > allowed.length ||
      !tray.successors.every(followsSkill.bind(null, allowed))
    )
      return rejected(
        "Choose supported successors: loading → retrieval → racking.",
      );
    for (const start of [
      tray.earliestStartSeconds,
      ...tray.successors.map(successorStart),
    ])
      if (
        !Number.isInteger(start) ||
        start < 0 ||
        start >= settings.horizonMinutes * 60
      )
        return rejected("Choose start constraints within this shift.");
    const reserved = reserveWorkcell({ kind: "empty" }, input);
    if (reserved.kind === "rejected") return reserved;
    const material = productionMaterialBinding(tray.batchId, 1, input.bindings);
    const root = `batch:${tray.batchId}:native:1`;
    owners.set(root, tray.batchId);
    operations.push(
      Object.freeze({
        id: root,
        batchId: tray.batchId,
        tray: 1,
        step: 1,
        workerId: tray.workerId,
        dependsOn: Object.freeze([...tray.dependsOn].sort()),
        earliestStartSeconds: tray.earliestStartSeconds,
        material,
        start: RESET,
        attempt: reserved.attempt,
        handoff: null,
      }),
    );
    let predecessorId = root;
    for (const [index, successor] of tray.successors.entries()) {
      const id = `${root}:${index + 2}`;
      owners.set(id, tray.batchId);
      planned.push(
        Object.freeze({
          id,
          batchId: tray.batchId,
          tray: 1,
          step: index + 2,
          workerId: tray.workerId,
          dependsOn: Object.freeze([]),
          earliestStartSeconds: successor.earliestStartSeconds,
          material,
          predecessorId,
          skill: Object.freeze({ ...successor.skill }),
        }),
      );
      predecessorId = id;
    }
  }
  const graph = new Map<string, Set<string>>();
  for (const tray of trays) {
    const edges = new Set<string>();
    for (const id of tray.dependsOn) {
      const owner = owners.get(id);
      if (owner === undefined || owner === tray.batchId)
        return rejected(
          "A tray can wait only for native operations on another tray.",
        );
      edges.add(owner);
    }
    graph.set(tray.batchId, edges);
  }
  if (hasCycle(graph))
    return rejected("Choose prerequisites without a cycle between trays.");
  const handling = trays.flatMap(trayHandling);
  const problem = faultProblem(faults, {
    settings,
    handlingTasks: handling,
    recoverableTasks: [...handling, ...owners.keys()],
  });
  if (problem !== null) return rejected(problem);
  const robots = bindCellRobots(operations, planned);
  if (robots.kind === "rejected") return robots;
  operations.sort(compareOperation);
  planned.sort(compareOperation);
  return {
    kind: "ready",
    plan: Object.freeze<ProductionWorkcells>({
      [validated]: true,
      cellRobots: robots.cells,
      procedure: "rehearsal",
      fingerprint: await rehearsalFingerprint(
        settings,
        operations,
        planned,
        faults,
      ),
      manualTasks: Object.freeze([]),
      procedureFingerprint: null,
      settings,
      variant: "normal",
      faults,
      source: { kind: "local" },
      operations: Object.freeze(operations),
      planned: Object.freeze(planned),
    }),
  };
}

// The skills that may follow a prepared first skill, in order.
export function successorSkills(
  input: WorkcellInput,
): readonly ContinuationSkill["kind"][] {
  if (
    input.kind === "transfer" &&
    input.request.bakeryTaskId === "table-to-oven" &&
    input.request.case === "nominal"
  )
    return ["unload", "rack"];
  if (input.kind === "native-cycle") return ["rack"];
  return [];
}

function trayHandling(tray: RehearsalTray): readonly HandlingTaskId[] {
  return [
    handlingTaskId(tray.batchId, 1, "stage"),
    handlingTaskId(tray.batchId, 1, "clear"),
    ...(tray.successors.some(isHumanTransfer)
      ? [handlingTaskId(tray.batchId, 1, "transfer")]
      : []),
  ];
}
function isHumanTransfer(
  successor: RehearsalTray["successors"][number],
): boolean {
  return successor.skill.kind === "restage";
}
function countOperations(total: number, tray: RehearsalTray): number {
  return total + 1 + tray.successors.length;
}
function sameBatch(batchId: string, tray: RehearsalTray): boolean {
  return tray.batchId === batchId;
}
function successorStart(
  successor: RehearsalTray["successors"][number],
): number {
  return successor.earliestStartSeconds;
}
function followsSkill(
  allowed: readonly ContinuationSkill["kind"][],
  successor: RehearsalTray["successors"][number],
  index: number,
): boolean {
  return successor.skill.kind === allowed[index];
}
function hasCycle(graph: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string): boolean => {
    const current = state.get(node);
    if (current === "visiting") return true;
    if (current === "done") return false;
    state.set(node, "visiting");
    for (const next of graph.get(node) ?? []) if (visit(next)) return true;
    state.set(node, "done");
    return false;
  };
  for (const node of graph.keys()) if (visit(node)) return true;
  return false;
}
function rehearsalFingerprint(
  settings: Settings,
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
  faults: RunFaults,
): Promise<string> {
  return bakeryFingerprint(
    JSON.stringify(
      rehearsalFingerprintSource(settings, operations, planned, faults),
    ),
  );
}
function rehearsalFingerprintSource(
  settings: Settings,
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
  faults: RunFaults,
) {
  return {
    procedure: "rehearsal",
    settings,
    operations: operations.map(rehearsalOperationIdentity),
    planned: planned.map(plannedOperationIdentity),
    ...(hasFaults(faults) ? { faults } : {}),
    handling: COLD_TRAY_HANDLING,
  };
}
function rehearsalOperationIdentity(operation: ProductionWorkcell) {
  return {
    id: operation.id,
    batchId: operation.batchId,
    tray: operation.tray,
    step: operation.step,
    workerId: operation.workerId,
    dependsOn: operation.dependsOn,
    earliestStartSeconds: operation.earliestStartSeconds,
    material: operation.material,
    start:
      operation.start.kind === "reset"
        ? "reset"
        : {
            predecessorId: operation.start.predecessorId,
            handoff:
              operation.start.kind === "continued" ||
              operation.start.kind === "restaged"
                ? operation.start.digest
                : operation.start.handoff.digest,
          },
    input: operation.attempt.input,
  };
}
function plannedOperationIdentity(operation: PlannedProductionWorkcell) {
  return {
    id: operation.id,
    batchId: operation.batchId,
    tray: operation.tray,
    step: operation.step,
    earliestStartSeconds: operation.earliestStartSeconds,
    predecessorId: operation.predecessorId,
    skill: operation.skill,
  };
}

export function acceptProductionRecording(
  plan: ProductionWorkcells,
  fingerprint: string,
  operationId: string,
  recording: PhysicsReplay,
  handoff: NativeContinuation | null = null,
): ProductionWorkcellsResult {
  if (fingerprint !== plan.fingerprint)
    return rejected(
      "The production workflow changed. Review the current plan before accepting evidence.",
    );
  const operation = plan.operations.find(
    matchesOperation.bind(null, operationId),
  );
  if (operation === undefined)
    return rejected("Choose a native operation in this production run.");
  if (
    plan.procedure === "financier" ||
    operation.start.kind === "restaged" ||
    plan.planned.some(isHumanPredecessor.bind(null, operation.id))
  ) {
    const compatibility = validateProductionMaterial(recording);
    if (compatibility.kind === "incompatible")
      return rejected(compatibility.message);
  }
  if (!retainsPredecessor(operation.start, recording))
    return rejected(
      "The result must retain the exact accepted predecessor evidence.",
    );
  const settled = settleWorkcell(operation.attempt, recording);
  if (settled.kind === "rejected") return settled;
  if (settled.attempt.kind === "awaiting-return")
    return rejected(
      "Accept the complete loading and unloading cycle for this operation.",
    );
  if (
    handoff !== null &&
    (settled.attempt.kind !== "completed" ||
      JSON.stringify(handoff.predecessor) !== JSON.stringify(recording))
  )
    return rejected(
      "Continuation state must come from this operation's completed result.",
    );
  const operations: ProductionWorkcell[] = [];
  for (const current of plan.operations)
    operations.push(
      current === operation
        ? Object.freeze({ ...current, attempt: settled.attempt, handoff })
        : current,
    );
  return { kind: "ready", plan: planWith(plan, operations, plan.planned) };
}

// Binding follows acceptance: the successor's request derives from the exact
// handoff, so its attempt identity includes the predecessor evidence digest.
export async function bindProductionSuccessor(
  plan: ProductionWorkcells,
  predecessorId: string,
): Promise<ProductionWorkcellsResult> {
  const next = plan.planned.find(followsOperation.bind(null, predecessorId));
  if (next?.skill.kind === "restage") return bindHumanSuccessor(plan, next);
  const predecessor = plan.operations.find(
    matchesOperation.bind(null, predecessorId),
  );
  if (predecessor === undefined || predecessor.handoff === null) {
    if (!plan.planned.some(followsOperation.bind(null, predecessorId)))
      return { kind: "ready", plan };
    return rejected(
      "Accept the exact successful predecessor before preparing its successor.",
    );
  }
  const handoff = predecessor.handoff;
  return bindSuccessor(plan, predecessorId, handoff, {
    kind: "continuation",
    predecessorId,
    handoff,
  });
}

// A saved run restores a settled successor from its predecessor's accepted
// result and the handoff digest; the resumable handoff file is not retained.
export async function restoreProductionSuccessor(
  plan: ProductionWorkcells,
  predecessorId: string,
  digest: string,
): Promise<ProductionWorkcellsResult> {
  const predecessor = plan.operations.find(
    matchesOperation.bind(null, predecessorId),
  );
  const planned = plan.planned.find(followsOperation.bind(null, predecessorId));
  if (
    predecessor === undefined ||
    planned === undefined ||
    predecessor.attempt.kind !== "completed"
  )
    return rejected("The saved continuation has no accepted predecessor.");
  if (planned.skill.kind === "restage")
    return bindHumanSuccessor(plan, planned);
  try {
    const recording = predecessor.attempt.recording;
    const state = continuationState(planned.skill.kind, recording, digest);
    return bindSuccessor(plan, predecessorId, state, {
      kind: "continued",
      predecessorId,
      digest,
      prefixSeconds: physicsDuration(recording),
    });
  } catch (error) {
    return rejected(
      error instanceof Error
        ? error.message
        : "Unable to restore continuation.",
    );
  }
}

async function bindSuccessor(
  plan: ProductionWorkcells,
  predecessorId: string,
  state: ContinuationState,
  start: Exclude<ProductionStart, { kind: "reset" | "restaged" }>,
): Promise<ProductionWorkcellsResult> {
  const planned = plan.planned.find(followsOperation.bind(null, predecessorId));
  if (planned === undefined) return { kind: "ready", plan };
  const predecessor = plan.operations.find(
    matchesOperation.bind(null, predecessorId),
  );
  if (
    predecessor === undefined ||
    predecessor.attempt.kind !== "completed" ||
    state.kind !== planned.skill.kind
  )
    return rejected(
      "Accept the exact successful predecessor before preparing its successor.",
    );
  try {
    const input = await continuationInput(
      state,
      planned.skill.kind === "rack" ? planned.skill.rackCase : "nominal",
      predecessor.attempt.input.bindings.cell,
    );
    const reserved = reserveWorkcell({ kind: "empty" }, input);
    if (reserved.kind === "rejected") return reserved;
    const bound = Object.freeze<ProductionWorkcell>({
      id: planned.id,
      batchId: planned.batchId,
      tray: planned.tray,
      step: planned.step,
      workerId: planned.workerId,
      dependsOn: planned.dependsOn,
      earliestStartSeconds: planned.earliestStartSeconds,
      material: planned.material,
      start: Object.freeze(start),
      attempt: reserved.attempt,
      handoff: null,
    });
    const operations = [...plan.operations, bound].sort(compareOperation);
    const remaining = plan.planned.filter(isOtherOperation.bind(null, planned));
    return {
      kind: "ready",
      plan: planWith(
        plan,
        operations,
        remaining,
        await runFingerprint(plan, operations, remaining),
      ),
    };
  } catch (error) {
    return rejected(
      error instanceof Error
        ? error.message
        : "Unable to prepare continuation.",
    );
  }
}

function retainsPredecessor(
  start: ProductionStart,
  recording: PhysicsReplay,
): boolean {
  if (start.kind !== "continuation") return true;
  const prefix = start.handoff.predecessor;
  if (
    recording.kind === "bakery-physics-sequence" &&
    prefix.kind === "bakery-physics-recording"
  )
    return JSON.stringify(recording.loading) === JSON.stringify(prefix);
  if (
    recording.kind === "bakery-physics-rack-sequence" &&
    prefix.kind === "bakery-physics-sequence"
  )
    return (
      JSON.stringify(recording.loading) === JSON.stringify(prefix.loading) &&
      JSON.stringify(recording.unloading) ===
        JSON.stringify(prefix.unloading) &&
      recording.loadingHandoffDigest === prefix.handoffDigest
    );
  return false;
}

// Browser execution prepares a request with the browser build identity. It
// replaces the pending request only when the authored task and fixture match;
// the run fingerprint then covers the request that actually executes.
export async function replaceProductionRequest(
  plan: ProductionWorkcells,
  fingerprint: string,
  operationId: string,
  input: WorkcellInput,
): Promise<ProductionWorkcellsResult> {
  if (fingerprint !== plan.fingerprint)
    return rejected(
      "The production workflow changed. Review the current plan before running it.",
    );
  const operation = plan.operations.find(
    matchesOperation.bind(null, operationId),
  );
  if (operation === undefined)
    return rejected("Choose a native operation in this production run.");
  if (
    operation.start.kind !== "reset" ||
    operation.attempt.kind !== "awaiting-evidence"
  )
    return rejected(
      "Only an unexecuted first task can prepare a browser request.",
    );
  const previous = operation.attempt.input;
  const request = input.request;
  if (
    input.kind !== previous.kind ||
    input.bindings.cell !== previous.bindings.cell ||
    !(plan.procedure === "financier"
      ? input.kind === "transfer" && productionTransfer(input)
      : rehearsalRoot(input)) ||
    request.execution.backend !== "browser" ||
    request.runId !== previous.request.runId ||
    request.bakeryTaskId !== previous.request.bakeryTaskId ||
    request.modelHash !== previous.request.modelHash ||
    request.robot !== previous.request.robot ||
    !sameIngredientLoad(request.ingredients, previous.request.ingredients) ||
    request.clampForceN !== previous.request.clampForceN ||
    request.case !== previous.request.case ||
    request.timestep !== previous.request.timestep ||
    JSON.stringify(request.layout) !== JSON.stringify(previous.request.layout)
  )
    return rejected(
      "Browser preparation must preserve the production task and fixture.",
    );
  const reserved = reserveWorkcell({ kind: "empty" }, input);
  if (reserved.kind === "rejected") return reserved;
  const operations: ProductionWorkcell[] = [];
  for (const current of plan.operations)
    operations.push(
      current === operation
        ? Object.freeze({ ...current, attempt: reserved.attempt })
        : current,
    );
  return {
    kind: "ready",
    plan: planWith(
      plan,
      operations,
      plan.planned,
      await runFingerprint(plan, operations, plan.planned),
    ),
  };
}

export async function attachProductionScenario(
  plan: ProductionWorkcells,
  definition: ProductionScenario,
): Promise<ProductionWorkcellsResult> {
  if (
    definition.route !== "cold-racking" ||
    JSON.stringify(plan.manualTasks) !==
      JSON.stringify(definition.manualTasks) ||
    plan.procedureFingerprint !== definition.sourceFingerprint ||
    plan.variant !== definition.variant ||
    plan.operations.length !== definition.assignments.length
  )
    return rejected("The saved scenario differs from the production run.");
  for (const field of fields)
    if (plan.settings[field.key] !== definition.settings[field.key])
      return rejected(
        "The saved scenario inputs differ from the production run.",
      );
  for (let index = 0; index < plan.operations.length; index++) {
    const operation = plan.operations[index];
    const assignment = definition.assignments[index];
    if (
      operation === undefined ||
      assignment === undefined ||
      operation.id !== productionAssignmentId(assignment) ||
      operation.workerId !== assignment.workerId ||
      operation.dependsOn.join("\u0000") !==
        assignment.dependsOn.join("\u0000") ||
      operation.earliestStartSeconds !== assignment.earliestStartSeconds
    )
      return rejected(
        "The saved scenario assignments differ from the production run.",
      );
  }
  if (
    (await productionDefinitionFingerprint(
      definition.sourceFingerprint,
      definition.settings,
      definition.variant,
      definition.assignments,
      definition.manualTasks,
      definition,
    )) !== definition.definitionFingerprint
  )
    return rejected("The saved scenario fingerprint is invalid.");
  return {
    kind: "ready",
    plan: Object.freeze<ProductionWorkcells>({
      ...planWith(plan, plan.operations, plan.planned),
      source: { kind: "shared", definition },
    }),
  };
}

function planWith(
  plan: ProductionWorkcells,
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
  fingerprint: string = plan.fingerprint,
): ProductionWorkcells {
  return Object.freeze<ProductionWorkcells>({
    [validated]: true,
    cellRobots: plan.cellRobots,
    procedure: plan.procedure,
    fingerprint,
    manualTasks: plan.manualTasks,
    procedureFingerprint: plan.procedureFingerprint,
    settings: plan.settings,
    variant: plan.variant,
    faults: plan.faults,
    source: plan.source,
    operations: Object.freeze([...operations]),
    planned: Object.freeze([...planned]),
  });
}
function runFingerprint(
  plan: ProductionWorkcells,
  operations: readonly ProductionWorkcell[],
  planned: readonly PlannedProductionWorkcell[],
): Promise<string> {
  return plan.procedure === "financier"
    ? productionRunFingerprint(
        plan.settings,
        plan.variant,
        operations,
        plan.manualTasks,
        plan.procedureFingerprint,
      )
    : rehearsalFingerprint(plan.settings, operations, planned, plan.faults);
}
// Rehearsal roots start from a prepared fixture: a transfer, or loading with
// its unloading in one continuous cycle. Recorded rack cycles replay only.
function rehearsalRoot(input: WorkcellInput): boolean {
  return input.requestedDispatchTime === 0;
}
function followsOperation(
  predecessorId: string,
  operation: PlannedProductionWorkcell,
): boolean {
  return operation.predecessorId === predecessorId;
}
function isOtherOperation(
  excluded: PlannedProductionWorkcell,
  operation: PlannedProductionWorkcell,
): boolean {
  return operation !== excluded;
}

function productionTransfer(input: TransferInput): boolean {
  return (
    input.request.bakeryTaskId === "table-to-rack" &&
    input.requestedDispatchTime === 0
  );
}
function compareOperation(
  left: OperationIdentity,
  right: OperationIdentity,
): number {
  return (
    compareCodePoints(left.batchId, right.batchId) ||
    left.tray - right.tray ||
    left.step - right.step
  );
}
function operationIdentity(operation: ProductionWorkcell) {
  return {
    id: operation.id,
    batchId: operation.batchId,
    tray: operation.tray,
    workerId: operation.workerId,
    dependsOn: operation.dependsOn,
    ...(operation.earliestStartSeconds === 0
      ? {}
      : { earliestStartSeconds: operation.earliestStartSeconds }),
    input: operation.attempt.input,
  };
}
function boundOperationIdentity(operation: ProductionWorkcell) {
  return { ...operationIdentity(operation), material: operation.material };
}
function executionIdentity(operation: ProductionWorkcell): unknown {
  const identity = boundOperationIdentity(operation);
  const { attemptId: _attemptId, ...request } = identity.input.request;
  return { ...identity, input: { ...identity.input, request } };
}
function matchesOperation(id: string, operation: ProductionWorkcell): boolean {
  return operation.id === id;
}
function rejected(
  message: string,
): Variant<ProductionWorkcellsResult, "rejected"> {
  return { kind: "rejected", message };
}

export function exportProductionWorkcells(plan: ProductionWorkcells): string {
  const text = JSON.stringify({
    kind: "bakery-production-workcells",
    schemaVersion: 9,
    cellRobots: plan.cellRobots,
    fingerprint: plan.fingerprint,
    manualTasks: plan.manualTasks,
    procedureFingerprint: plan.procedureFingerprint,
    settings: plan.settings,
    variant: plan.variant,
    source: plan.source,
    operations: plan.operations.map(savedOperation),
  });
  if (new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES)
    throw new Error("This production file exceeds the recording size limit.");
  return text;
}
function savedOperation(operation: ProductionWorkcell) {
  return {
    batchId: operation.batchId,
    tray: operation.tray,
    workerId: operation.workerId,
    dependsOn: operation.dependsOn,
    earliestStartSeconds: operation.earliestStartSeconds,
    experiment: JSON.parse(exportWorkcellExperiment(operation.attempt)),
  };
}

function workerId(value: unknown): ProductionAssignment["workerId"] {
  if (typeof value !== "string" || !/^human-[1-9][0-9]*$/.test(value))
    throw new Error("Saved native operation has no valid baker assignment.");
  return `human-${Number(value.slice(6))}`;
}

function dependencies(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every(isString))
    throw new Error("Saved native operation has invalid predecessors.");
  return value;
}

function startTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(
      "Saved native operation has an invalid earliest staging time.",
    );
  return value;
}

// Verify historical fingerprints at the persistence boundary before normalizing loads.
function previousRequestFingerprint(
  version: 5 | 6,
  _key: string,
  value: unknown,
): unknown {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 7 ||
    value.source !== "local-simulation" ||
    !isRecord(value.ingredients)
  )
    return value;
  const load = value.ingredients;
  if (
    typeof load.massKg !== "number" ||
    load.massKg < 1 ||
    load.forwardMm !== 0 ||
    load.lateralMm !== 0
  )
    return value;
  if (version === 5 && (load.massKg !== 1 || value.clampForceN !== 100))
    return value;
  const previous: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "schemaVersion") previous[key] = version;
    else if (key === "ingredients") {
      if (version === 6) previous.payloadKg = load.massKg - 1;
    } else if (key !== "clampForceN" || version === 6) previous[key] = field;
  }
  return previous;
}

export async function parseProductionWorkcells(
  text: string,
): Promise<ProductionWorkcellsResult> {
  try {
    if (new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES)
      return rejected(
        "Choose a production file within the recording size limit.",
      );
    const raw = object(JSON.parse(text));
    if (
      raw.kind !== "bakery-production-workcells" ||
      (raw.schemaVersion !== 7 &&
        raw.schemaVersion !== 8 &&
        raw.schemaVersion !== 9) ||
      (raw.variant !== "normal" && raw.variant !== "outage") ||
      !Array.isArray(raw.operations) ||
      raw.operations.length > 16
    )
      return rejected(
        "Choose a version 7, 8 or 9 production file with separate post-demould cooling. Older files retain their original evidence; create a new run with reviewed timings and fresh native evidence.",
      );
    const settings = parseSettings(object(raw.settings));
    if (settings.kind === "invalid")
      return rejected(`${settings.field}: ${settings.message}`);
    const assignments: {
      batchId: string;
      tray: number;
      workerId: ProductionAssignment["workerId"];
      dependsOn: ProductionAssignment["dependsOn"];
      earliestStartSeconds: number;
      input: TransferInput;
    }[] = [];
    const recordings: (PhysicsReplay | null)[] = [];
    for (const value of raw.operations) {
      const operation = object(value);
      const parsed = parseWorkcellExperiment(
        JSON.stringify(operation.experiment),
      );
      if (parsed.kind === "rejected") return parsed;
      if (
        typeof operation.batchId !== "string" ||
        typeof operation.tray !== "number" ||
        parsed.experiment.input.kind !== "transfer"
      )
        return rejected(
          "Each native operation needs a batch, tray and cold-transfer request.",
        );
      assignments.push({
        batchId: operation.batchId,
        tray: operation.tray,
        workerId: workerId(operation.workerId),
        dependsOn: dependencies(operation.dependsOn),
        earliestStartSeconds: startTime(operation.earliestStartSeconds),
        input: parsed.experiment.input,
      });
      recordings.push(
        parsed.experiment.kind === "recorded"
          ? parsed.experiment.recording
          : null,
      );
    }
    const manualTasks = parseProductionManualTasks(
      raw.manualTasks,
      settings.settings,
      assignments,
      "cold-racking",
    );
    if (manualTasks === null)
      return rejected("Invalid production manual task assignments.");
    const source = productionSource(raw.source);
    const procedureFingerprint = raw.procedureFingerprint;
    if (
      procedureFingerprint !== null &&
      (typeof procedureFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(procedureFingerprint))
    )
      return rejected("Invalid procedure fingerprint.");
    const compiled = await compileProductionWorkcells(
      settings.settings,
      raw.variant,
      assignments,
      { manualTasks, procedureFingerprint },
    );
    if (compiled.kind === "rejected") return compiled;
    if (
      (raw.schemaVersion === 8 || raw.schemaVersion === 9) &&
      !sameCellRobots(raw.cellRobots, compiled.plan.cellRobots)
    )
      return rejected(
        "The saved cell robots differ from their operation requests.",
      );
    // Stored snapshots preserve their original request/evidence identities. Editing
    // always recompiles and binds new requests to the new executable workflow.
    const original: ProductionWorkcell[] = [];
    for (const assignment of assignments) {
      const reserved = reserveWorkcell({ kind: "empty" }, assignment.input);
      if (reserved.kind === "rejected") return reserved;
      original.push({
        id: productionAssignmentId(assignment),
        batchId: assignment.batchId,
        tray: assignment.tray,
        step: 1,
        workerId: assignment.workerId,
        dependsOn: assignment.dependsOn,
        earliestStartSeconds: assignment.earliestStartSeconds,
        material: productionMaterialBinding(
          assignment.batchId,
          assignment.tray,
          assignment.input.bindings,
        ),
        start: RESET,
        attempt: reserved.attempt,
        handoff: null,
      });
    }
    original.sort(compareOperation);
    const fingerprint = await productionRunFingerprint(
      settings.settings,
      raw.variant,
      original,
      manualTasks,
      procedureFingerprint,
    );
    const previousFingerprint =
      raw.schemaVersion === 7 || raw.schemaVersion === 8
        ? await bakeryFingerprint(
            JSON.stringify(
              productionRunFingerprintSource(
                settings.settings,
                raw.variant,
                original,
                manualTasks,
                procedureFingerprint,
              ),
              previousRequestFingerprint.bind(
                null,
                raw.schemaVersion === 7 ? 5 : 6,
              ),
            ),
          )
        : null;
    if (
      fingerprint !== raw.fingerprint &&
      previousFingerprint !== raw.fingerprint
    )
      return rejected(
        "The saved workflow fingerprint does not match its production settings and requests.",
      );
    let plan: ProductionWorkcells = Object.freeze<ProductionWorkcells>({
      [validated]: true,
      cellRobots: compiled.plan.cellRobots,
      procedure: "financier",
      fingerprint,
      manualTasks,
      procedureFingerprint,
      settings: compiled.plan.settings,
      variant: compiled.plan.variant,
      faults: NO_FAULTS,
      source: compiled.plan.source,
      operations: Object.freeze(original),
      planned: Object.freeze([]),
    });
    if (source.kind === "shared") {
      const attached = await attachProductionScenario(plan, source.definition);
      if (attached.kind === "rejected") return attached;
      plan = attached.plan;
    }
    for (const [index, assignment] of assignments.entries()) {
      const recording = recordings[index];
      if (recording === undefined)
        return rejected("The saved workflow is missing a recording slot.");
      if (recording === null) continue;
      const accepted = acceptProductionRecording(
        plan,
        plan.fingerprint,
        `batch:${assignment.batchId}:native:${assignment.tray}`,
        recording,
      );
      if (accepted.kind === "rejected") return accepted;
      plan = accepted.plan;
    }
    return { kind: "ready", plan };
  } catch (error) {
    return rejected(
      error instanceof Error
        ? error.message
        : "Unable to open production workcells.",
    );
  }
}

function productionSource(value: unknown): ProductionSource {
  const raw = object(value);
  if (raw.kind === "local" && Object.keys(raw).length === 1)
    return { kind: "local" };
  if (raw.kind === "shared" && Object.keys(raw).length === 2) {
    const definition = parseProductionScenario(raw.definition);
    if (definition !== null) return { kind: "shared", definition };
  }
  throw new Error("The saved production scenario reference is invalid.");
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a production object.");
  return Object.fromEntries(Object.entries(value));
}

async function productionRunFingerprint(
  settings: Settings,
  variant: ProductionWorkcells["variant"],
  operations: readonly ProductionWorkcell[],
  manualTasks: readonly ProductionManualTask[],
  procedureFingerprint: string | null,
): Promise<string> {
  return bakeryFingerprint(
    JSON.stringify(
      productionRunFingerprintSource(
        settings,
        variant,
        operations,
        manualTasks,
        procedureFingerprint,
      ),
    ),
  );
}
function productionRunFingerprintSource(
  settings: Settings,
  variant: ProductionWorkcells["variant"],
  operations: readonly ProductionWorkcell[],
  manualTasks: readonly ProductionManualTask[],
  procedureFingerprint: string | null,
) {
  return {
    settings,
    variant,
    operations: operations.map(boundOperationIdentity),
    manualTasks,
    procedureFingerprint,
    handling: COLD_TRAY_HANDLING,
  };
}

// Rehearsal files store each continuation without its predecessor's motion and
// keep a handoff only while its successor still needs to resume from it.
export function exportRehearsalWorkcells(plan: ProductionWorkcells): string {
  const text = JSON.stringify(rehearsalDocument(plan));
  if (new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES)
    throw new Error(
      "This rehearsal exceeds the run file size limit. Save it with fewer completed trays.",
    );
  return text;
}

export async function parseRehearsalWorkcells(
  text: string,
): Promise<ProductionWorkcellsResult> {
  try {
    if (new TextEncoder().encode(text).length > MAX_EXPERIMENT_BYTES)
      return rejected(
        "Choose a rehearsal file within the run file size limit.",
      );
    const raw = object(JSON.parse(text));
    if (typeof raw.fingerprint !== "string")
      return rejected(
        "Choose a version 1, 2 or 3 Kitchen rehearsal file.",
      );
    return await restoreRehearsal(raw, raw.fingerprint);
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : "Unable to open the rehearsal.",
    );
  }
}

export type RehearsalEdit =
  | Readonly<{ kind: "human-transfer"; batchId: string }>
  | Readonly<{
      kind: "add";
      workerId: ProductionAssignment["workerId"];
      input: WorkcellInput;
      successors: RehearsalTray["successors"];
    }>
  | Readonly<{ kind: "cell"; batchId: string; cellId: CellId }>
  | Readonly<{
      kind: "ingredients";
      batchId: string;
      ingredients: IngredientLoad;
    }>
  | Readonly<{ kind: "remove"; batchId: string }>
  | Readonly<{
      kind: "worker";
      batchId: string;
      workerId: ProductionAssignment["workerId"];
    }>
  | Readonly<{
      kind: "start";
      operationId: string;
      earliestStartSeconds: number;
    }>
  | Readonly<{
      kind: "prerequisites";
      batchId: string;
      dependsOn: readonly string[];
    }>
  | Readonly<{ kind: "faults"; faults: RunFaults }>
  | Readonly<{ kind: "reset"; batchId: string }>
  // A reviewed rack translation replaces the tray's first request.
  | Readonly<{ kind: "layout"; batchId: string; input: WorkcellInput }>;

// Edits pass through the saved form, so accepted evidence carries over exactly
// as it does when a saved rehearsal reopens. A new tray takes the next letter.
export async function editRehearsalWorkcells(
  plan: ProductionWorkcells,
  edit: RehearsalEdit,
): Promise<ProductionWorkcellsResult> {
  try {
    const document = rehearsalDocument(plan);
    const trays = document.trays.map(editableTray);
    let faults = document.faults;
    switch (edit.kind) {
      case "add": {
        const used = new Set(trays.map(trayBatchId));
        const batchId = [..."ABCDEFGHIJKLMNOP"].find(
          unusedBatch.bind(null, used),
        );
        if (batchId === undefined)
          return rejected("A rehearsal supports up to sixteen trays.");
        trays.push({
          batchId,
          workerId: edit.workerId,
          dependsOn: [],
          earliestStartSeconds: 0,
          root: JSON.parse(
            exportWorkcellExperiment(pendingAttempt(edit.input)),
          ),
          steps: [
            {
              step: 1,
              earliestStartSeconds: 0,
              skill: null,
              digest: null,
              evidence: null,
              handoff: null,
            },
            ...edit.successors.map(newStep),
          ],
        });
        break;
      }
      case "human-transfer": {
        const tray = trays.find(trayWithBatch.bind(null, edit.batchId));
        const root = plan.operations.find(
          rootForBatch.bind(null, edit.batchId),
        );
        if (
          tray === undefined ||
          root === undefined ||
          tray.steps.length !== 1 ||
          !supportsHumanCellTransfer(root.attempt.input)
        )
          return rejected(
            "Choose a single nominal table-to-rack tray in cell 1.",
          );
        tray.steps.push(
          newStep(
            {
              skill: { kind: "restage", route: HUMAN_CELL_TRANSFER },
              earliestStartSeconds: 0,
            },
            0,
          ),
        );
        break;
      }
      case "remove": {
        const index = trays.findIndex(trayWithBatch.bind(null, edit.batchId));
        if (index < 0) return rejected("Choose a tray in this rehearsal.");
        trays.splice(index, 1);
        const prefix = `batch:${edit.batchId}:native:`;
        for (const tray of trays)
          tray.dependsOn = tray.dependsOn.filter(
            outsideTray.bind(null, prefix),
          );
        faults = withoutTray(faults, edit.batchId);
        break;
      }
      case "faults":
        faults = edit.faults;
        break;
      case "ingredients":
      case "cell": {
        const tray = trays.find(trayWithBatch.bind(null, edit.batchId));
        const root = plan.operations.find(
          rootForBatch.bind(null, edit.batchId),
        );
        if (tray === undefined || root === undefined)
          return rejected("Choose a tray in this rehearsal.");
        const source = root.attempt.input;
        if (source.kind !== "transfer" && source.kind !== "native-cycle")
          return rejected(
            "This edit requires a browser-executable root request.",
          );
        if (
          edit.kind === "ingredients" &&
          sameIngredientLoad(source.request.ingredients, edit.ingredients)
        )
          return { kind: "ready", plan };
        const cellId =
          edit.kind === "cell" ? edit.cellId : source.bindings.cell;
        const ingredients =
          edit.kind === "ingredients"
            ? edit.ingredients
            : source.request.ingredients;
        const identity = crypto.randomUUID();
        const parsed = parsePhysicsRequest(
          JSON.stringify({
            ...source.request,
            ingredients,
            runId: `rehearsal-${identity}`,
            attemptId: `attempt-${identity}`,
          }),
        );
        if (parsed.kind === "rejected") return rejected(parsed.message);
        const input =
          source.kind === "transfer"
            ? compileWorkcellInput(parsed.request, "0", cellId)
            : compileNativeCycleInput(parsed.request, "0", cellId);
        if (input.kind === "invalid") return rejected(input.message);
        tray.root = JSON.parse(
          exportWorkcellExperiment(pendingAttempt(input.input)),
        );
        tray.steps = tray.steps.map(clearedStep);
        break;
      }
      case "reset":
      case "layout": {
        const tray = trays.find(trayWithBatch.bind(null, edit.batchId));
        if (tray === undefined)
          return rejected("Choose a tray in this rehearsal.");
        if (edit.kind === "layout")
          tray.root = JSON.parse(
            exportWorkcellExperiment(pendingAttempt(edit.input)),
          );
        tray.steps = tray.steps.map(clearedStep);
        break;
      }
      case "worker":
      case "prerequisites": {
        const tray = trays.find(trayWithBatch.bind(null, edit.batchId));
        if (tray === undefined)
          return rejected("Choose a tray in this rehearsal.");
        if (edit.kind === "worker") tray.workerId = edit.workerId;
        else tray.dependsOn = [...edit.dependsOn].sort();
        break;
      }
      case "start": {
        const match = /^batch:([A-P]):native:1(?::([0-9]+))?$/.exec(
          edit.operationId,
        );
        const tray =
          match === null
            ? undefined
            : trays.find(trayWithBatch.bind(null, match[1] ?? ""));
        const step = Number(match?.[2] ?? "1");
        const saved = tray?.steps[step - 1];
        if (tray === undefined || saved === undefined)
          return rejected("Choose a step in this rehearsal.");
        tray.steps[step - 1] = {
          ...saved,
          earliestStartSeconds: edit.earliestStartSeconds,
        };
        if (step === 1) tray.earliestStartSeconds = edit.earliestStartSeconds;
        break;
      }
    }
    if (trays.length === 0)
      return rejected("Keep at least one tray in the rehearsal.");
    return await restoreRehearsal({ ...document, trays, faults }, null);
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : "Unable to edit the rehearsal.",
    );
  }
}

// Version 4 fingerprints explicit ingredient loads. Older files normalize at import.
type RehearsalDocument = Readonly<{
  kind: "bakery-rehearsal-run";
  schemaVersion: 4;
  cellRobots: CellRobots;
  fingerprint: string;
  settings: Settings;
  faults: RunFaults;
  trays: readonly SavedTray[];
}>;
type SavedTray = {
  batchId: string;
  workerId: ProductionAssignment["workerId"];
  dependsOn: readonly string[];
  earliestStartSeconds: number;
  root: unknown;
  steps: SavedStep[];
};

function rehearsalDocument(plan: ProductionWorkcells): RehearsalDocument {
  if (plan.procedure !== "rehearsal")
    throw new Error("Only a rehearsal run uses the rehearsal file.");
  return {
    kind: "bakery-rehearsal-run",
    schemaVersion: 4,
    cellRobots: plan.cellRobots,
    fingerprint: plan.fingerprint,
    settings: plan.settings,
    faults: plan.faults,
    trays: plan.operations.filter(isChainRoot).map(savedTray.bind(null, plan)),
  };
}
// Removing a tray drops the faults injected into or recovering its tasks.
function withoutTray(faults: RunFaults, batchId: string): RunFaults {
  const prefix = `batch:${batchId}:`;
  return {
    outage: faults.outage,
    failure: faults.failure?.bakeryTaskId.startsWith(prefix)
      ? null
      : faults.failure,
    recovery: faults.recovery?.bakeryTaskId.startsWith(prefix)
      ? null
      : faults.recovery,
  };
}
// Clearing a tray's results keeps its requests, so it runs again from its
// first skill.
function clearedStep(step: SavedStep): SavedStep {
  return { ...step, digest: null, evidence: null, handoff: null };
}
function editableTray(tray: SavedTray): SavedTray {
  return { ...tray, steps: [...tray.steps] };
}
function trayBatchId(tray: SavedTray): string {
  return tray.batchId;
}
function unusedBatch(used: ReadonlySet<string>, batchId: string): boolean {
  return !used.has(batchId);
}
function trayWithBatch(batchId: string, tray: SavedTray): boolean {
  return tray.batchId === batchId;
}
function outsideTray(prefix: string, id: string): boolean {
  return !id.startsWith(prefix);
}
function newStep(
  successor: RehearsalTray["successors"][number],
  index: number,
): SavedStep {
  return {
    step: index + 2,
    earliestStartSeconds: successor.earliestStartSeconds,
    skill: successor.skill,
    digest: null,
    evidence: null,
    handoff: null,
  };
}

// Rebuild a rehearsal from its saved form. A file must match its recorded
// fingerprint; an in-memory edit has no prior fingerprint to match.
async function restoreRehearsal(
  value: unknown,
  expectedFingerprint: string | null,
): Promise<ProductionWorkcellsResult> {
  try {
    const raw = object(JSON.parse(JSON.stringify(value)));
    const keys = ["kind", "schemaVersion", "fingerprint", "settings", "trays"];
    if (
      raw.kind !== "bakery-rehearsal-run" ||
      !(
        (raw.schemaVersion === 1 && hasExactKeys(raw, keys)) ||
        (raw.schemaVersion === 2 && hasExactKeys(raw, [...keys, "faults"])) ||
        ((raw.schemaVersion === 3 || raw.schemaVersion === 4) &&
          hasExactKeys(raw, [...keys, "faults", "cellRobots"]))
      ) ||
      typeof raw.fingerprint !== "string" ||
      !Array.isArray(raw.trays) ||
      raw.trays.length < 1 ||
      raw.trays.length > 16
    )
      return rejected(
        "Choose a version 1, 2 or 3 Kitchen rehearsal file.",
      );
    const faults =
      raw.schemaVersion === 1 ? NO_FAULTS : parseRunFaults(raw.faults);
    const settings = parseSettings(object(raw.settings));
    if (settings.kind === "invalid")
      return rejected(`${settings.field}: ${settings.message}`);
    const trays: RehearsalTray[] = [];
    const saved: SavedStep[][] = [];
    for (const value of raw.trays) {
      const tray = object(value);
      if (
        !hasExactKeys(tray, [
          "batchId",
          "workerId",
          "dependsOn",
          "earliestStartSeconds",
          "root",
          "steps",
        ]) ||
        typeof tray.batchId !== "string" ||
        !Array.isArray(tray.steps) ||
        tray.steps.length < 1
      )
        return rejected(
          "Each rehearsal tray needs its first request and steps.",
        );
      const experiment = parseWorkcellExperiment(JSON.stringify(tray.root));
      if (experiment.kind === "rejected") return experiment;
      if (experiment.experiment.kind === "recorded")
        return rejected("A saved tray keeps its evidence with its steps.");
      const steps = tray.steps.map(savedStep);
      if (!steps.every(isStepAt))
        return rejected("Save rehearsal steps in chain order.");
      trays.push({
        batchId: tray.batchId,
        workerId: workerId(tray.workerId),
        dependsOn: dependencies(tray.dependsOn),
        earliestStartSeconds: startTime(tray.earliestStartSeconds),
        input: experiment.experiment.input,
        successors: steps.slice(1).map(successorOf),
      });
      saved.push(steps);
    }
    const compiled = await compileRehearsalWorkcells(
      settings.settings,
      trays,
      faults,
    );
    if (compiled.kind === "rejected") return compiled;
    if (
      expectedFingerprint !== null &&
      (raw.schemaVersion === 3 || raw.schemaVersion === 4) &&
      !sameCellRobots(raw.cellRobots, compiled.plan.cellRobots)
    )
      return rejected(
        "The saved cell robots differ from their operation requests.",
      );
    let plan = compiled.plan;
    for (const [index, tray] of trays.entries()) {
      const root = `batch:${tray.batchId}:native:1`;
      for (const step of saved[index] ?? []) {
        const id = step.step === 1 ? root : `${root}:${step.step}`;
        const predecessorId =
          step.step === 2 ? root : `${root}:${step.step - 1}`;
        const predecessor =
          step.step === 1
            ? null
            : (plan.operations.find(
                matchesOperation.bind(null, predecessorId),
              ) ?? null);
        if (step.step > 1) {
          const ready = predecessor?.attempt.kind === "completed";
          if (!ready && (step.digest !== null || step.evidence !== null))
            return rejected(
              "A saved continuation needs its accepted predecessor.",
            );
          if (ready) {
            const bound =
              step.skill?.kind === "restage" || predecessor.handoff !== null
                ? await bindProductionSuccessor(plan, predecessorId)
                : step.digest !== null
                  ? await restoreProductionSuccessor(
                      plan,
                      predecessorId,
                      step.digest,
                    )
                  : rejected(
                      "The saved run lost the state its next step resumes from.",
                    );
            if (bound.kind === "rejected") return bound;
            plan = bound.plan;
            const operation = plan.operations.find(
              matchesOperation.bind(null, id),
            );
            if (
              step.digest !== null &&
              (operation === undefined ||
                startDigest(operation.start) !== step.digest)
            )
              return rejected("The saved continuation digest does not match.");
          }
        }
        if (step.evidence === null) {
          if (step.handoff !== null)
            return rejected("A saved handoff needs its accepted result.");
          continue;
        }
        const recording = expandRecording(
          step.evidence,
          step.skill?.kind !== "restage" &&
            predecessor?.attempt.kind === "completed"
            ? predecessor.attempt.recording
            : null,
        );
        const accepted = acceptProductionRecording(
          plan,
          plan.fingerprint,
          id,
          recording,
          step.handoff === null ? null : parseNativeContinuation(step.handoff),
        );
        if (accepted.kind === "rejected") return accepted;
        plan = accepted.plan;
      }
    }
    const previousFingerprint =
      raw.schemaVersion === 1 ||
      raw.schemaVersion === 2 ||
      raw.schemaVersion === 3
        ? await bakeryFingerprint(
            JSON.stringify(
              rehearsalFingerprintSource(
                plan.settings,
                plan.operations,
                plan.planned,
                plan.faults,
              ),
              previousRequestFingerprint.bind(
                null,
                raw.schemaVersion === 3 ? 6 : 5,
              ),
            ),
          )
        : null;
    if (
      expectedFingerprint !== null &&
      plan.fingerprint !== expectedFingerprint &&
      previousFingerprint !== expectedFingerprint
    )
      return rejected(
        "The saved rehearsal fingerprint does not match its trays and evidence.",
      );
    return { kind: "ready", plan };
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : "Unable to open the rehearsal.",
    );
  }
}

type SavedStep = Readonly<{
  step: number;
  earliestStartSeconds: number;
  skill: ContinuationSkill | null;
  digest: string | null;
  evidence: unknown;
  handoff: string | null;
}>;

function savedTray(
  plan: ProductionWorkcells,
  root: ProductionWorkcell,
): SavedTray {
  const chain: (ProductionWorkcell | PlannedProductionWorkcell)[] = [
    ...plan.operations.filter(sameChain.bind(null, root)),
    ...plan.planned.filter(sameChain.bind(null, root)),
  ].sort(compareOperation);
  return {
    batchId: root.batchId,
    workerId: root.workerId,
    dependsOn: root.dependsOn,
    earliestStartSeconds: root.earliestStartSeconds,
    root: JSON.parse(
      exportWorkcellExperiment(pendingAttempt(root.attempt.input)),
    ),
    steps: chain.map(stepRecord.bind(null, chain)),
  };
}
function stepRecord(
  chain: readonly (ProductionWorkcell | PlannedProductionWorkcell)[],
  operation: ProductionWorkcell | PlannedProductionWorkcell,
  index: number,
): SavedStep {
  if (operation.attempt === undefined)
    return {
      step: operation.step,
      earliestStartSeconds: operation.earliestStartSeconds,
      skill: operation.skill,
      digest: null,
      evidence: null,
      handoff: null,
    };
  const attempt = operation.attempt;
  const settled =
    attempt.kind === "completed" || attempt.kind === "recovery-required"
      ? attempt.recording
      : null;
  const next = chain[index + 1];
  const successorWaits =
    next !== undefined &&
    (next.attempt === undefined || next.attempt.kind === "awaiting-evidence");
  return {
    step: operation.step,
    earliestStartSeconds: operation.earliestStartSeconds,
    skill:
      operation.step === 1
        ? null
        : operation.start.kind === "restaged"
          ? { kind: "restage", route: HUMAN_CELL_TRANSFER }
          : boundSkill(attempt.input),
    digest: startDigest(operation.start),
    evidence:
      settled === null ? null : compactRecording(settled, operation.start),
    handoff:
      operation.handoff !== null && successorWaits
        ? operation.handoff.file
        : null,
  };
}
function savedStep(value: unknown): SavedStep {
  const raw = object(value);
  if (
    !hasExactKeys(raw, [
      "step",
      "earliestStartSeconds",
      "skill",
      "digest",
      "evidence",
      "handoff",
    ]) ||
    typeof raw.step !== "number" ||
    !Number.isInteger(raw.step) ||
    (raw.digest !== null && typeof raw.digest !== "string") ||
    (raw.handoff !== null && typeof raw.handoff !== "string")
  )
    throw new Error("A saved rehearsal step is invalid.");
  return {
    step: raw.step,
    earliestStartSeconds: startTime(raw.earliestStartSeconds),
    skill: raw.skill === null ? null : continuationSkill(raw.skill),
    digest: raw.digest,
    evidence: raw.evidence,
    handoff: raw.handoff,
  };
}
function isStepAt(step: SavedStep, index: number): boolean {
  return step.step === index + 1 && (index === 0) === (step.skill === null);
}
function successorOf(step: SavedStep): RehearsalTray["successors"][number] {
  if (step.skill === null) throw new Error("A successor needs its skill.");
  return {
    skill: step.skill,
    earliestStartSeconds: step.earliestStartSeconds,
  };
}
function continuationSkill(value: unknown): ContinuationSkill {
  const raw = object(value);
  if (raw.kind === "restage" && hasExactKeys(raw, ["kind", "route"]))
    return { kind: "restage", route: parseHumanCellTransfer(raw.route) };
  if (raw.kind === "unload" && hasExactKeys(raw, ["kind"]))
    return { kind: "unload" };
  if (
    raw.kind === "rack" &&
    hasExactKeys(raw, ["kind", "rackCase"]) &&
    (raw.rackCase === "nominal" || raw.rackCase === "slip")
  )
    return { kind: "rack", rackCase: raw.rackCase };
  throw new Error("A saved continuation skill is unsupported.");
}
function boundSkill(input: WorkcellInput): ContinuationSkill {
  if (input.kind === "oven-cycle") return { kind: "unload" };
  if (input.kind === "rack-cycle")
    return {
      kind: "rack",
      rackCase: input.rackPlan.rackRequest.case === "slip" ? "slip" : "nominal",
    };
  throw new Error("A continuation must resume retrieval or racking.");
}
function startDigest(start: ProductionStart): string | null {
  switch (start.kind) {
    case "reset":
      return null;
    case "continuation":
      return start.handoff.digest;
    case "continued":
    case "restaged":
      return start.digest;
  }
}
function compactRecording(
  recording: PhysicsReplay,
  start: ProductionStart,
): unknown {
  if (start.kind === "reset" || start.kind === "restaged") return recording;
  if (recording.kind === "bakery-physics-sequence")
    return {
      kind: "sequence-unloading",
      schemaVersion: recording.schemaVersion,
      handoffDigest: recording.handoffDigest,
      unloading: recording.unloading,
    };
  if (recording.kind === "bakery-physics-rack-sequence")
    return {
      kind: "rack-sequence-racking",
      schemaVersion: recording.schemaVersion,
      loadingHandoffDigest: recording.loadingHandoffDigest,
      handoffDigest: recording.handoffDigest,
      racking: recording.racking,
    };
  throw new Error("A continuation result must extend its predecessor.");
}
// Rebuild the cumulative recording the runner produced from the accepted
// predecessor and the saved new motion.
function expandRecording(
  value: unknown,
  predecessor: PhysicsReplay | null,
): PhysicsReplay {
  const raw = object(value);
  let replay: unknown = raw;
  if (raw.kind === "sequence-unloading") {
    if (predecessor?.kind !== "bakery-physics-recording")
      throw new Error("Retrieval evidence needs its accepted loading.");
    replay = {
      kind: "bakery-physics-sequence",
      schemaVersion: raw.schemaVersion,
      handoffDigest: raw.handoffDigest,
      loading: predecessor,
      unloading: raw.unloading,
    };
  } else if (raw.kind === "rack-sequence-racking") {
    if (
      predecessor?.kind !== "bakery-physics-sequence" ||
      raw.loadingHandoffDigest !== predecessor.handoffDigest
    )
      throw new Error("Racking evidence needs its accepted retrieval.");
    replay = {
      kind: "bakery-physics-rack-sequence",
      schemaVersion: raw.schemaVersion,
      loadingHandoffDigest: raw.loadingHandoffDigest,
      loading: predecessor.loading,
      unloading: predecessor.unloading,
      handoffDigest: raw.handoffDigest,
      racking: raw.racking,
    };
  } else if (predecessor !== null) {
    throw new Error(
      "A continuation must be saved without its predecessor's motion.",
    );
  }
  const parsed = parsePhysicsReplay(JSON.stringify(replay));
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}
function pendingAttempt(input: WorkcellInput): ActiveAttempt {
  const reserved = reserveWorkcell({ kind: "empty" }, input);
  if (reserved.kind === "rejected") throw new Error(reserved.message);
  return reserved.attempt;
}
function isChainRoot(operation: ProductionWorkcell): boolean {
  return operation.step === 1;
}
function sameChain(
  root: ProductionWorkcell,
  operation: ProductionWorkcell | PlannedProductionWorkcell,
): boolean {
  return operation.batchId === root.batchId && operation.tray === root.tray;
}

function rootForBatch(batchId: string, operation: ProductionWorkcell): boolean {
  return operation.batchId === batchId && operation.step === 1;
}

async function bindHumanSuccessor(
  plan: ProductionWorkcells,
  planned: PlannedProductionWorkcell,
): Promise<ProductionWorkcellsResult> {
  const predecessor = plan.operations.find(
    matchesOperation.bind(null, planned.predecessorId),
  );
  if (predecessor === undefined || predecessor.attempt.kind !== "completed")
    return rejected(
      "Accept the completed source transfer before preparing human restaging.",
    );
  try {
    const prepared = await humanCellTransferInput(predecessor.attempt);
    const reserved = reserveWorkcell({ kind: "empty" }, prepared.input);
    if (reserved.kind === "rejected") return reserved;
    const bound = Object.freeze<ProductionWorkcell>({
      id: planned.id,
      batchId: planned.batchId,
      tray: planned.tray,
      step: planned.step,
      workerId: planned.workerId,
      dependsOn: planned.dependsOn,
      earliestStartSeconds: planned.earliestStartSeconds,
      material: productionMaterialBinding(
        planned.batchId,
        planned.tray,
        prepared.input.bindings,
      ),
      start: {
        kind: "restaged",
        predecessorId: predecessor.id,
        digest: prepared.digest,
      },
      attempt: reserved.attempt,
      handoff: null,
    });
    const operations = [...plan.operations, bound].sort(compareOperation);
    const remaining = plan.planned.filter(isOtherOperation.bind(null, planned));
    return {
      kind: "ready",
      plan: planWith(
        plan,
        operations,
        remaining,
        await runFingerprint(plan, operations, remaining),
      ),
    };
  } catch (error) {
    return rejected(
      error instanceof Error
        ? error.message
        : "Unable to prepare human restaging.",
    );
  }
}

function isHumanPredecessor(
  id: string,
  next: PlannedProductionWorkcell,
): boolean {
  return next.predecessorId === id && next.skill.kind === "restage";
}
