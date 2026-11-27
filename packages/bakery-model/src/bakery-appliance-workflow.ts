import { CanvasLayout } from "@purin-labs/workflow-canvas-crdt";
import { assertNever, isRecord, hasExactKeys } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";
import {
  freshApplianceRequest,
  parseApplianceResult,
  parseContents,
  type ApplianceAction,
  type ApplianceBatch,
  type ApplianceContinuation,
  type ApplianceName,
  type ApplianceRequest,
  type ApplianceResult,
} from "./bakery-appliance-protocol.ts";

type ApplianceRecipe =
  "financier" | "sesame-milk" | "ginger-milk-tea" | "ginger-black-tea";
export type ApplianceOperation = Readonly<{
  id: string;
  label: string;
  appliance: ApplianceName;
  predecessor: string | null;
  actions: readonly ApplianceAction[];
}>;
export type ApplianceOperationState = StrictUnion<
  | Readonly<{ kind: "pending"; operation: ApplianceOperation }>
  | Readonly<{
      kind: "running";
      operation: ApplianceOperation;
      request: ApplianceRequest;
      start: number;
    }>
  | Readonly<{
      kind: "interrupted";
      operation: ApplianceOperation;
      start: number;
      message: string;
    }>
  | Readonly<{
      kind: "accepted";
      operation: ApplianceOperation;
      result: ApplianceResult;
      start: number;
      end: number;
    }>
  | Readonly<{
      kind: "held";
      operation: ApplianceOperation;
      result: ApplianceResult;
      start: number;
      end: number;
      message: string;
    }>
>;
type ApplianceWorkflow = Readonly<{
  layout: CanvasLayout;
  runId: string;
  recipe: ApplianceRecipe;
  initialBatch: ApplianceBatch;
  operations: readonly ApplianceOperationState[];
  continuations: ReadonlyMap<ApplianceName, ApplianceContinuation>;
  interruptions: readonly Readonly<{
    operationId: string;
    attemptId: string;
    message: string;
  }>[];
}>;
type ApplianceDispatch =
  | Readonly<{
      kind: "execute";
      plan: ApplianceWorkflow;
      request: ApplianceRequest;
      operationId: string;
    }>
  | Readonly<{ kind: "complete" | "held"; message: string }>;

function buildWorkflow(
  recipe: ApplianceRecipe,
  runId: string,
  initialBatch: ApplianceBatch,
): ApplianceWorkflow {
  const operations: ApplianceOperationState[] = [];
  let predecessor: string | null = null;
  for (const step of recipeSteps(recipe)) {
    const id = `${runId}-${operations.length}`;
    operations.push({
      kind: "pending",
      operation: {
        id,
        label: step.label,
        appliance: step.appliance,
        predecessor,
        actions: step.actions,
      },
    });
    predecessor = id;
  }
  return {
    layout: initialLayout(operations),
    runId,
    recipe,
    initialBatch,
    operations,
    continuations: new Map(),
    interruptions: [],
  };
}

type RecipeStep = Readonly<{
  label: string;
  appliance: ApplianceName;
  actions: readonly ApplianceAction[];
}>;
const WEIGH: RecipeStep = {
  label: "Weigh ingredients",
  appliance: "ohaus-ranger-3000",
  actions: [
    { kind: "advance", seconds: 2 },
    { kind: "require", state: "stable" },
  ],
};
const MOTOR_TAIL: readonly ApplianceAction[] = [
  { kind: "advance", seconds: 13 },
  { kind: "require", state: "complete" },
  { kind: "stop" },
  { kind: "advance", seconds: 15 },
  { kind: "require", state: "stopped" },
];
function recipeSteps(recipe: ApplianceRecipe): readonly RecipeStep[] {
  switch (recipe) {
    case "financier":
      return [
        WEIGH,
        {
          label: "Heat ingredient fixture",
          appliance: "maruzen-mih-02c",
          actions: [
            { kind: "advance", seconds: 1 },
            {
              kind: "start",
              program: { kind: "hob-power", percent: 60, duration_s: 30 },
            },
            { kind: "advance", seconds: 31 },
            { kind: "require", state: "complete" },
          ],
        },
        {
          label: "Mix batter fixture",
          appliance: "hobart-hl200",
          actions: [
            { kind: "advance", seconds: 1 },
            {
              kind: "start",
              program: { kind: "planetary", setting: 1, duration_s: 12 },
            },
            ...MOTOR_TAIL,
          ],
        },
        {
          label: "Preheat and bake fixture",
          appliance: "maruzen-mbco-5e",
          actions: [
            { kind: "start", program: { kind: "preheat", target_c: 180 } },
            { kind: "advance", seconds: 450 },
            { kind: "require", state: "ready" },
            {
              kind: "start",
              program: { kind: "bake", target_c: 180, duration_s: 90 },
            },
            { kind: "advance", seconds: 91 },
            { kind: "require", state: "complete" },
            { kind: "stop" },
          ],
        },
      ];
    case "sesame-milk":
      return [
        WEIGH,
        {
          label: "Grind ingredient fixture",
          appliance: "waring-wsg60",
          actions: [
            { kind: "advance", seconds: 1 },
            { kind: "start", program: { kind: "grind", duration_s: 10 } },
            ...MOTOR_TAIL,
          ],
        },
        {
          label: "Blend ingredient fixture",
          appliance: "vitamix-quiet-one",
          actions: [
            { kind: "advance", seconds: 1 },
            {
              kind: "start",
              program: { kind: "blend", percent: 25, duration_s: 12 },
            },
            ...MOTOR_TAIL,
          ],
        },
        milkStep(),
      ];
    case "ginger-milk-tea":
      return [
        WEIGH,
        teaStep("vollrath-59500p"),
        {
          label: "Mix milk fixture",
          appliance: "severin-sm-3587",
          actions: [
            { kind: "advance", seconds: 1 },
            { kind: "start", program: { kind: "cold-mix", duration_s: 10 } },
            ...MOTOR_TAIL,
          ],
        },
      ];
    case "ginger-black-tea":
      return [WEIGH, teaStep("maruzen-mih-02c")];
    default:
      return assertNever(recipe);
  }
}
function milkStep(): RecipeStep {
  return {
    label: "Heat and mix milk fixture",
    appliance: "severin-sm-3587",
    actions: [
      { kind: "advance", seconds: 1 },
      { kind: "start", program: { kind: "heated-mix", target_c: 55 } },
      { kind: "advance", seconds: 180 },
      { kind: "require", state: "complete" },
      { kind: "stop" },
      { kind: "advance", seconds: 15 },
      { kind: "require", state: "stopped" },
    ],
  };
}
function teaStep(
  appliance:
    | "maruzen-mih-02c"
    | "vollrath-59500p"
    | "panasonic-kz-ck1402"
    | "rinnai-rsb-150pj",
): RecipeStep {
  return {
    label: "Heat tea fixture",
    appliance,
    actions: [
      { kind: "advance", seconds: 1 },
      {
        kind: "start",
        program: { kind: "hob-power", percent: 60, duration_s: 60 },
      },
      { kind: "advance", seconds: 61 },
      { kind: "require", state: "complete" },
    ],
  };
}

function dispatchApplianceOperation(
  plan: ApplianceWorkflow,
  attemptId: string,
): ApplianceDispatch {
  let time = 0;
  for (const state of plan.operations) {
    if (state.kind === "running" || state.kind === "held")
      return {
        kind: "held",
        message:
          "The current operation retains its appliance and ingredients until recovery.",
      };
    if (state.kind === "accepted") {
      time = Math.max(time, state.end);
      continue;
    }
    const operation = state.operation;
    let batch = plan.initialBatch;
    if (operation.predecessor !== null) {
      const previous = plan.operations.find(
        hasOperation.bind(null, operation.predecessor),
      );
      if (previous?.kind !== "accepted")
        return {
          kind: "held",
          message: "The predecessor has no accepted result.",
        };
      const transferred = previous.result.transferred;
      if (transferred.length !== 1 || transferred[0] === undefined)
        return {
          kind: "held",
          message: "The predecessor did not release one ingredient batch.",
        };
      batch = transferred[0];
    }
    const actions: readonly ApplianceAction[] = [
      ...operation.actions,
      { kind: "remove-contents" },
    ];
    const continuation = plan.continuations.get(operation.appliance);
    const request =
      continuation === undefined
        ? freshApplianceRequest(
            operation.appliance,
            plan.runId,
            attemptId,
            { kind: "loaded", batch },
            actions,
          )
        : continuation.request(plan.runId, attemptId, [
            { kind: "set-contents", contents: { kind: "loaded", batch } },
            ...actions,
          ]);
    const running: ApplianceOperationState = {
      kind: "running",
      operation,
      request,
      start: time,
    };
    return {
      kind: "execute",
      request,
      operationId: operation.id,
      plan: {
        layout: plan.layout,
        runId: plan.runId,
        recipe: plan.recipe,
        initialBatch: plan.initialBatch,
        operations: replaceOperation(plan.operations, running),
        continuations: plan.continuations,
        interruptions: plan.interruptions,
      },
    };
  }
  return {
    kind: "complete",
    message: "Every appliance checkpoint has accepted evidence.",
  };
}
function acceptApplianceResult(
  plan: ApplianceWorkflow,
  operationId: string,
  result: ApplianceResult,
): ApplianceWorkflow {
  const current = plan.operations.find(hasOperation.bind(null, operationId));
  if (
    current?.kind !== "running" ||
    current.request.attemptId !== result.attemptId ||
    plan.runId !== result.runId ||
    current.operation.appliance !== result.appliance
  )
    throw new Error("The appliance result belongs to another operation.");
  const first = result.samples[0];
  const last = result.samples.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("The appliance result contains no motion samples.");
  const end = current.start + last.timeSeconds - first.timeSeconds;
  const state: ApplianceOperationState =
    result.outcome.kind === "completed"
      ? {
          kind: "accepted",
          operation: current.operation,
          result,
          start: current.start,
          end,
        }
      : {
          kind: "held",
          operation: current.operation,
          result,
          start: current.start,
          end,
          message: result.outcome.message,
        };
  const continuations = new Map(plan.continuations);
  continuations.set(result.appliance, result.continuation);
  return {
    layout: plan.layout,
    runId: plan.runId,
    recipe: plan.recipe,
    initialBatch: plan.initialBatch,
    operations: replaceOperation(plan.operations, state),
    continuations,
    interruptions: plan.interruptions,
  };
}
function interruptApplianceWorkflow(
  plan: ApplianceWorkflow,
  message: string,
): ApplianceWorkflow {
  const operations: ApplianceOperationState[] = [];
  const interruptions = [...plan.interruptions];
  for (const state of plan.operations) {
    if (state.kind === "running") {
      operations.push({
        kind: "interrupted",
        operation: state.operation,
        start: state.start,
        message,
      });
      interruptions.push({
        operationId: state.operation.id,
        attemptId: state.request.attemptId,
        message,
      });
    } else {
      operations.push(state);
    }
  }
  return {
    layout: plan.layout,
    runId: plan.runId,
    recipe: plan.recipe,
    initialBatch: plan.initialBatch,
    operations,
    continuations: plan.continuations,
    interruptions,
  };
}
function hasOperation(id: string, state: ApplianceOperationState): boolean {
  return state.operation.id === id;
}
function replaceOperation(
  states: readonly ApplianceOperationState[],
  replacement: ApplianceOperationState,
): readonly ApplianceOperationState[] {
  return states.map(replaceOne.bind(null, replacement));
}
function replaceOne(
  replacement: ApplianceOperationState,
  state: ApplianceOperationState,
): ApplianceOperationState {
  return state.operation.id === replacement.operation.id ? replacement : state;
}

export function parseApplianceWorkflow(file: string): ApplianceWorkflow {
  if (new TextEncoder().encode(file).length > 32 * 1024 * 1024)
    throw new Error("The appliance run exceeds 32 MiB.");
  const raw: unknown = JSON.parse(file);
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "schemaVersion",
      "kind",
      "runId",
      "recipe",
      "layout",
      "initialBatch",
      "operations",
      "interruptions",
    ]) ||
    raw.schemaVersion !== 1 ||
    raw.kind !== "bakery-appliance-run" ||
    typeof raw.runId !== "string" ||
    !/^[a-zA-Z0-9-]{1,96}$/u.test(raw.runId)
  )
    throw new Error("Invalid appliance run document.");
  const recipe = parseApplianceRecipe(raw.recipe);
  const contents = parseContents({ kind: "loaded", batch: raw.initialBatch });
  if (contents.kind !== "loaded")
    throw new Error("Missing initial ingredient batch.");
  let plan = buildWorkflow(recipe, raw.runId, contents.batch);
  const layout = CanvasLayout.parse(raw.layout);
  if (!layout.ok) throw new Error("Invalid saved canvas layout.");
  plan = withApplianceLayout(plan, layout.value);
  if (
    !Array.isArray(raw.operations) ||
    raw.operations.length !== plan.operations.length ||
    !Array.isArray(raw.interruptions) ||
    raw.interruptions.length > 256
  )
    throw new Error("Invalid appliance operation history.");
  for (let index = 0; index < raw.operations.length; index++) {
    const item: unknown = raw.operations[index];
    const expected = plan.operations[index];
    if (
      !isRecord(item) ||
      expected === undefined ||
      item.id !== expected.operation.id
    )
      throw new Error("The saved operation does not belong to this recipe.");
    if (item.kind === "pending" && hasExactKeys(item, ["id", "kind"])) continue;
    const next = dispatchApplianceOperation(plan, recordingAttemptId(item));
    if (next.kind !== "execute" || next.operationId !== item.id)
      throw new Error("The saved run bypasses an unaccepted predecessor.");
    if (
      item.kind === "interrupted" &&
      hasExactKeys(item, ["id", "kind", "message"]) &&
      typeof item.message === "string" &&
      item.message.length <= 2048
    ) {
      plan = interruptApplianceWorkflow(next.plan, item.message);
    } else if (
      (item.kind === "accepted" || item.kind === "held") &&
      hasExactKeys(item, ["id", "kind", "file"]) &&
      typeof item.file === "string"
    ) {
      const result = parseApplianceResult(item.file, next.request);
      if ((item.kind === "accepted") !== (result.outcome.kind === "completed"))
        throw new Error(
          "The saved acceptance does not match the recording outcome.",
        );
      validateTransferInput(plan, result);
      plan = acceptApplianceResult(next.plan, next.operationId, result);
    } else throw new Error("Invalid saved appliance state.");
  }
  const interruptions: ApplianceWorkflow["interruptions"][number][] = [];
  for (const item of raw.interruptions) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["operationId", "attemptId", "message"]) ||
      typeof item.operationId !== "string" ||
      !plan.operations.some(hasOperation.bind(null, item.operationId)) ||
      typeof item.attemptId !== "string" ||
      !/^[a-zA-Z0-9-]{1,128}$/u.test(item.attemptId) ||
      typeof item.message !== "string" ||
      item.message.length > 2048
    )
      throw new Error("Invalid interruption receipt.");
    interruptions.push({
      operationId: item.operationId,
      attemptId: item.attemptId,
      message: item.message,
    });
  }
  return {
    layout: plan.layout,
    runId: plan.runId,
    recipe: plan.recipe,
    initialBatch: plan.initialBatch,
    operations: plan.operations,
    continuations: plan.continuations,
    interruptions,
  };
}
function recordingAttemptId(item: Record<string, unknown>): string {
  if (item.kind === "interrupted") return "saved-interruption";
  if (typeof item.file !== "string")
    throw new Error("Missing appliance recording.");
  const recording: unknown = JSON.parse(item.file);
  if (
    !isRecord(recording) ||
    typeof recording.attempt_id !== "string" ||
    !/^[a-zA-Z0-9-]{1,128}$/u.test(recording.attempt_id)
  )
    throw new Error("Invalid recorded attempt identity.");
  return recording.attempt_id;
}
function validateTransferInput(
  plan: ApplianceWorkflow,
  result: ApplianceResult,
): void {
  let batch = plan.initialBatch;
  for (const state of plan.operations) {
    if (state.kind !== "accepted") break;
    const outgoing = state.result.transferred[0];
    if (outgoing === undefined) throw new Error("Missing accepted transfer.");
    batch = outgoing;
  }
  const input = result.samples[0]?.contents;
  if (
    input?.kind !== "loaded" ||
    JSON.stringify(input.batch) !== JSON.stringify(batch)
  )
    throw new Error("The recording uses different ingredient state.");
  if (
    result.outcome.kind === "completed" &&
    (result.transferred.length !== 1 ||
      result.transferred[0]?.identity !== batch.identity ||
      result.transferred[0]?.mass_kg !== batch.mass_kg)
  )
    throw new Error("The recording loses or duplicates ingredient custody.");
}
function parseApplianceRecipe(raw: unknown): ApplianceRecipe {
  switch (raw) {
    case "financier":
    case "sesame-milk":
    case "ginger-milk-tea":
    case "ginger-black-tea":
      return raw;
    default:
      throw new Error("Unknown appliance recipe.");
  }
}
export function applianceCanvasObjects(
  plan: ApplianceWorkflow,
): readonly Readonly<{ objectId: string; x: number; y: number }>[] {
  return plan.layout.objects.map(canvasPoint);
}
function canvasPoint(
  point: CanvasLayout["objects"][number],
): Readonly<{ objectId: string; x: number; y: number }> {
  return point.toJSON();
}
function initialLayout(
  operations: readonly ApplianceOperationState[],
): CanvasLayout {
  const objects = [];
  for (let index = 0; index < operations.length; index++) {
    const state = operations[index];
    if (state !== undefined)
      objects.push({
        objectId: state.operation.id,
        x: 20 + (index % 3) * 240,
        y: 30 + Math.floor(index / 3) * 180,
      });
  }
  const layout = CanvasLayout.parse(objects);
  if (!layout.ok) throw new Error("Invalid recipe canvas membership.");
  return layout.value;
}
function withApplianceLayout(
  plan: ApplianceWorkflow,
  layout: CanvasLayout,
): ApplianceWorkflow {
  if (
    layout.objects.length !== plan.operations.length ||
    !layout.objects.every(belongsToPlan.bind(null, plan))
  )
    throw new Error("The canvas layout changes recipe membership.");
  return {
    layout,
    runId: plan.runId,
    recipe: plan.recipe,
    initialBatch: plan.initialBatch,
    operations: plan.operations,
    continuations: plan.continuations,
    interruptions: plan.interruptions,
  };
}
function belongsToPlan(
  plan: ApplianceWorkflow,
  point: CanvasLayout["objects"][number],
): boolean {
  return plan.operations.some(hasOperation.bind(null, point.objectId));
}
