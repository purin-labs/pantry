import type {
  BakeryProductionReplacement,
  BakeryProductionReplacementSource,
} from "@seams/bakery-model/bakery-surface";
import type { ScheduleSpatialLayout } from "@seams/production-simulation/recipes/bakery/schedule";
import {
  bakeryFingerprint,
  parseSettings,
  fields,
  type Settings,
} from "@seams/bakery-model/bakery";
import type { CompiledProcedure } from "@seams/bakery-model/bakery-procedure";
import {
  parsePhysicsRequest,
  workcellModelHash,
  type PhysicsReplay,
} from "@seams/bakery-model/bakery-physics";
import {
  productionAssignmentId,
  productionInitialPresentation,
  productionTaskChoices,
  validProductionWorkflow,
  type ProductionAssignment,
  type ProductionManualTask,
  type ProductionPresentation,
  type ProductionScenario,
  type ProductionTaskChoice,
} from "@seams/bakery-model/bakery-production-scenario";
import { readBundledExample } from "./bundled-example.ts";
import type {
  ProductionDraftIdentity,
  ProductionReady,
  ProductionSession,
} from "./production-session.ts";
import {
  attachProductionScenario,
  compileProductionWorkcells,
  type ProductionWorkcell,
  type ProductionWorkcells,
} from "@seams/production-simulation/recipes/bakery/production-workcells";
import type { ReadExample } from "@seams/production-simulation/simulator/rehearsal-presets";
import { readyProduction } from "./scheduled-rehearsal.ts";
import {
  compileWorkcellInput,
  type TransferInput,
} from "@seams/production-simulation/recipes/bakery/workcell-input";

// Financier production authoring. Edit production and chat both change the
// draft through editProductionDraft and compile it with
// prepareProductionPreview; the workspace commits a preview only to the draft
// it was compiled from.

export type ProductionDraftEdit =
  | Readonly<{ kind: "assign" | "unassign"; batchId: string; tray: number }>
  | Readonly<{
      kind: "worker";
      id: string;
      workerId: ProductionAssignment["workerId"];
    }>
  | Readonly<{
      kind: "prerequisites";
      id: string;
      dependsOn: readonly string[];
    }>
  | Readonly<{ kind: "start"; id: string; earliestStartSeconds: number }>
  | Readonly<{ kind: "manual"; task: ProductionManualTask }>
  | Readonly<{
      kind: "variant";
      variant: ProductionSession["draftVariant"];
    }>
  | Readonly<{ kind: "name"; name: string }>
  | Readonly<{ kind: "note"; note: string }>
  | Readonly<{ kind: "position"; id: string; x: number; y: number }>
  // Returns the draft to the applied run.
  | Readonly<{ kind: "discard" }>;

export type ProductionDraftResult =
  | Readonly<{ kind: "ready"; patch: Partial<ProductionSession> }>
  | Readonly<{ kind: "rejected"; message: string }>;

// What a preview compiles from.
export type ProductionDraftSource = Readonly<{
  draft: ProductionSession["draft"];
  manualTasks: ProductionSession["manualTasks"];
  variant: ProductionSession["draftVariant"];
  identity: ProductionDraftIdentity;
  sourceProcedure: CompiledProcedure | null;
  settings: Settings;
}>;

export type PreparedProductionPreview = Readonly<{
  from: ProductionDraftSource;
  result:
    | Readonly<{ kind: "ready"; preview: ProductionReady }>
    | Readonly<{ kind: "rejected"; message: string }>;
}>;

const DRAFT_CHANGED =
  "Scenario draft changed. Preview it before applying or saving.";

export function productionDraftSource(
  session: ProductionSession,
): ProductionDraftSource | null {
  if (session.procedure !== "financier" || session.data.kind !== "ready")
    return null;
  return {
    draft: session.draft,
    manualTasks: session.manualTasks,
    variant: session.draftVariant,
    identity: session.identity,
    sourceProcedure: session.sourceProcedure,
    settings: session.sourceProcedure?.settings ?? session.data.plan.settings,
  };
}

export function editProductionDraft(
  session: ProductionSession,
  edit: ProductionDraftEdit,
): ProductionDraftResult {
  const source = productionDraftSource(session);
  if (source === null || session.data.kind !== "ready")
    return rejected("Prepare a financier production run before editing it.");
  const settings = source.settings;
  switch (edit.kind) {
    case "assign": {
      if (!traySlot(settings, edit.batchId, edit.tray))
        return rejected("Choose a batch and tray within this shift.");
      if (session.draft.some(hasId.bind(null, productionAssignmentId(edit))))
        return rejected("That tray already uses the Robot cold transfer.");
      if (session.draft.length >= 16)
        return rejected("Assign at most sixteen cold-tray operations.");
      return assignmentsChanged(
        session,
        [
          ...session.draft,
          {
            batchId: edit.batchId,
            tray: edit.tray,
            workerId: "human-1" as const,
            dependsOn: [],
            earliestStartSeconds: 0,
          },
        ].sort(compareAssignments),
        true,
      );
    }
    case "unassign": {
      const id = productionAssignmentId(edit);
      if (!session.draft.some(hasId.bind(null, id)))
        return rejected("That tray does not use the Robot cold transfer.");
      const tasks = trayTaskIds(edit.batchId, edit.tray);
      if (
        session.draft.some(dependsOnAny.bind(null, tasks)) ||
        session.manualTasks.some(dependsOnAny.bind(null, tasks))
      )
        return rejected(
          "Remove dependent task links before clearing this tray.",
        );
      return assignmentsChanged(
        session,
        session.draft.filter(otherAssignment.bind(null, id)),
        true,
      );
    }
    case "worker":
    case "prerequisites":
    case "start": {
      const assignment = session.draft.find(hasId.bind(null, edit.id));
      if (assignment === undefined)
        return rejected("That tray does not use the Robot cold transfer.");
      let changed: ProductionAssignment;
      if (edit.kind === "worker") {
        if (!bakerInShift(settings, edit.workerId))
          return rejected(`Choose a baker from 1 to ${settings.workerCount}.`);
        changed = { ...assignment, workerId: edit.workerId };
      } else if (edit.kind === "start") {
        if (!withinShift(settings, edit.earliestStartSeconds))
          return rejected("Enter an earliest staging time within this shift.");
        changed = {
          ...assignment,
          earliestStartSeconds: edit.earliestStartSeconds,
        };
      } else {
        if (new Set(edit.dependsOn).size !== edit.dependsOn.length)
          return rejected("List each prerequisite once.");
        changed = { ...assignment, dependsOn: [...edit.dependsOn].sort() };
      }
      const draft = session.draft.map(
        replaceAssignment.bind(null, edit.id, changed),
      );
      if (
        edit.kind === "prerequisites" &&
        !validProductionWorkflow(
          settings,
          draft,
          session.manualTasks,
          "cold-racking",
        )
      )
        return rejected(
          "Choose prerequisites among this shift's other tasks, without a cycle.",
        );
      return assignmentsChanged(session, draft, false);
    }
    case "manual": {
      const task = edit.task;
      if (
        !productionTaskChoices(settings, session.draft, "cold-racking").some(
          isManualChoice.bind(null, task.bakeryTaskId),
        )
      )
        return rejected("Choose a manual operation or transfer of this shift.");
      if (task.workerId !== null && !bakerInShift(settings, task.workerId))
        return rejected(
          `Choose a baker from 1 to ${settings.workerCount}, or any available baker.`,
        );
      if (!withinShift(settings, task.earliestStartSeconds))
        return rejected("Enter an earliest task start within this shift.");
      if (new Set(task.dependsOn).size !== task.dependsOn.length)
        return rejected("List each prerequisite once.");
      const manualTasks = replaceManualTask(session.manualTasks, {
        ...task,
        dependsOn: [...task.dependsOn].sort(),
      });
      if (
        !validProductionWorkflow(
          settings,
          session.draft,
          manualTasks,
          "cold-racking",
        )
      )
        return rejected(
          "Choose prerequisites among this shift's other tasks, without a cycle.",
        );
      return changed({
        manualTasks,
        preview: null,
        identity: editedIdentity(session.identity),
        notice: "Task draft changed. Preview before applying.",
      });
    }
    case "variant":
      return changed({
        draftVariant: edit.variant,
        preview: null,
        identity: editedIdentity(session.identity),
        notice: DRAFT_CHANGED,
      });
    case "name":
      return changed({
        draftName: edit.name,
        preview: null,
        identity: editedIdentity(session.identity),
      });
    case "note":
      return changed({
        draftNote: edit.note,
        preview: null,
        identity: editedIdentity(session.identity),
      });
    case "position": {
      if (session.presentation[edit.id] === undefined)
        return rejected("That task is not on the canvas.");
      return changed({
        presentation: {
          ...session.presentation,
          [edit.id]: {
            x: Math.max(0, Math.min(600, edit.x)),
            y: Math.max(0, Math.min(500, edit.y)),
          },
        },
        identity: editedIdentity(session.identity),
        notice: "Canvas arrangement changed. Execution timing is unchanged.",
      });
    }
    case "discard":
      return changed({
        ...appliedDraft(session, session.data.plan),
        preview: session.data,
        notice: "Draft changes discarded. The applied run is unchanged.",
      });
  }
}

export async function prepareProductionPreview(
  session: ProductionSession,
  procedure: CompiledProcedure | null,
  layout: ScheduleSpatialLayout | null,
  read: ReadExample = readBundledExample,
): Promise<PreparedProductionPreview | null> {
  const from = productionDraftSource(session);
  if (from === null) return null;
  const source =
    from.identity.kind === "saved" ? from.identity.definition : null;
  try {
    const shiftProcedure = from.sourceProcedure ?? procedure;
    const plan = await compileProductionDraft(
      from.settings,
      from.draft,
      from.variant,
      source,
      from.manualTasks,
      source?.sourceFingerprint ??
        (shiftProcedure === null
          ? null
          : await bakeryFingerprint(shiftProcedure.revisionKey)),
      read,
    );
    return {
      from,
      result: { kind: "ready", preview: readyProduction(plan, layout) },
    };
  } catch (error) {
    return {
      from,
      result: {
        kind: "rejected",
        message:
          error instanceof Error
            ? error.message
            : "Unable to prepare production workcells.",
      },
    };
  }
}

// A preview commits only while its draft is the one in view.
export function previewPatch(
  session: ProductionSession,
  prepared: PreparedProductionPreview,
): Partial<ProductionSession> | null {
  const current = productionDraftSource(session);
  const from = prepared.from;
  if (
    current === null ||
    current.draft !== from.draft ||
    current.manualTasks !== from.manualTasks ||
    current.variant !== from.variant ||
    current.identity !== from.identity ||
    current.sourceProcedure !== from.sourceProcedure ||
    !fields.every(
      (field) => current.settings[field.key] === from.settings[field.key],
    )
  )
    return null;
  return prepared.result.kind === "ready"
    ? {
        preview: prepared.result.preview,
        notice:
          "Draft compiled. Review its task count and assumptions, then apply or save this definition.",
      }
    : { preview: null, notice: prepared.result.message };
}

// Starts a fresh run from a compiled plan; its draft follows the plan.
export function appliedRunPatch(
  session: ProductionSession,
  applied: ProductionReady,
  notice: string,
): Partial<ProductionSession> {
  const plan = applied.plan;
  const operation =
    plan.operations.find(hasOperationId.bind(null, session.operationId)) ??
    plan.operations[0];
  return {
    data: applied,
    cursor: { time: 0, playback: "paused" },
    pending: { kind: "none" },
    operationId: operation?.id ?? null,
    selection:
      operation === undefined
        ? session.selection
        : { kind: "batch", id: operation.batchId },
    notice,
    ...appliedDraft(session, plan),
    preview: applied,
  };
}

export function newDraftIdentity(): ProductionDraftIdentity {
  return { kind: "new", id: `production-${crypto.randomUUID()}` };
}

export async function compileProductionDraft(
  settings: Settings,
  draft: readonly ProductionAssignment[],
  variant: "normal" | "outage",
  source: ProductionScenario | null,
  manualTasks: readonly ProductionManualTask[],
  procedureFingerprint: string | null,
  read: ReadExample = readBundledExample,
): Promise<ProductionWorkcells> {
  if (source !== null && source.route !== "cold-racking")
    throw new Error(
      "This saved oven route requires the persistent production host.",
    );
  let template: PhysicsReplay;
  try {
    template = await read("table-to-rack");
  } catch {
    throw new Error("Unable to load the native request template.");
  }
  if (template.kind !== "bakery-physics-recording")
    throw new Error("Choose a single cold-transfer template.");
  // A recording keeps the model it ran on. A new request names the pinned one.
  const modelHash = await workcellModelHash(template.request.robot, "separate");
  const assignments: {
    batchId: string;
    tray: number;
    workerId: `human-${number}`;
    dependsOn: readonly string[];
    earliestStartSeconds: number;
    input: TransferInput;
  }[] = [];
  for (const assignment of draft) {
    const identity = crypto.randomUUID();
    const request = parsePhysicsRequest(
      JSON.stringify({
        ...template.request,
        runId: identity,
        attemptId: `attempt-${identity}`,
        modelHash,
      }),
    );
    if (request.kind === "rejected") throw new Error(request.message);
    const input = compileWorkcellInput(request.request, "0", "cold-cell-1");
    if (input.kind === "invalid") throw new Error(input.message);
    assignments.push({
      batchId: assignment.batchId,
      tray: assignment.tray,
      workerId: assignment.workerId,
      dependsOn: assignment.dependsOn,
      earliestStartSeconds: assignment.earliestStartSeconds,
      input: input.input,
    });
  }
  const compiled = await compileProductionWorkcells(
    settings,
    variant,
    assignments,
    { manualTasks, procedureFingerprint },
  );
  if (compiled.kind === "rejected") throw new Error(compiled.message);
  if (source === null) return compiled.plan;
  const attached = await attachProductionScenario(compiled.plan, source);
  if (attached.kind === "rejected") throw new Error(attached.message);
  return attached.plan;
}

// The applied run's draft; a shared scenario also brings its identity, name,
// note and canvas.
function appliedDraft(
  session: ProductionSession,
  plan: ProductionWorkcells,
): Partial<ProductionSession> {
  const shared = plan.source.kind === "shared" ? plan.source.definition : null;
  const draft = plan.operations.map(assignmentForOperation);
  return {
    draft,
    manualTasks: plan.manualTasks,
    presentation:
      shared === null
        ? positionsForAssignments(draft, session.presentation)
        : shared.presentation,
    draftVariant: plan.variant,
    identity:
      shared === null
        ? session.identity
        : { kind: "saved", definition: shared },
    draftName: shared === null ? session.draftName : shared.name,
    draftNote: shared === null ? session.draftNote : shared.note,
  };
}

function assignmentsChanged(
  session: ProductionSession,
  draft: readonly ProductionAssignment[],
  arrange: boolean,
): ProductionDraftResult {
  return changed({
    draft,
    ...(arrange
      ? {
          presentation: positionsForAssignments(draft, session.presentation),
        }
      : {}),
    preview: null,
    identity: editedIdentity(session.identity),
    notice: DRAFT_CHANGED,
  });
}

function changed(patch: Partial<ProductionSession>): ProductionDraftResult {
  return { kind: "ready", patch };
}

function rejected(message: string): ProductionDraftResult {
  return { kind: "rejected", message };
}

function editedIdentity(
  identity: ProductionDraftIdentity,
): ProductionDraftIdentity {
  return identity.kind === "new" ? identity : newDraftIdentity();
}

function traySlot(settings: Settings, batchId: string, tray: number): boolean {
  const batch = batchId.charCodeAt(0) - 65;
  return (
    batchId.length === 1 &&
    batch >= 0 &&
    batch < settings.batchCount &&
    Number.isInteger(tray) &&
    tray >= 1 &&
    tray <= settings.traysPerBatch
  );
}

function bakerInShift(settings: Settings, workerId: string): boolean {
  return (
    /^human-[1-9][0-9]*$/.test(workerId) &&
    Number(workerId.slice("human-".length)) <= settings.workerCount
  );
}

function withinShift(settings: Settings, seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= 0 &&
    seconds < settings.horizonMinutes * 60
  );
}

// A tray's staging, native transfer and clearance.
function trayTaskIds(batchId: string, tray: number): readonly string[] {
  return [
    `batch:${batchId}:handoff:${tray}-stage`,
    productionAssignmentId({ batchId, tray }),
    `batch:${batchId}:handoff:${tray}-clear`,
  ];
}

function dependsOnAny(
  ids: readonly string[],
  task: Readonly<{ dependsOn: readonly string[] }>,
): boolean {
  return task.dependsOn.some((id) => ids.includes(id));
}

function hasId(id: string, assignment: ProductionAssignment): boolean {
  return productionAssignmentId(assignment) === id;
}

function otherAssignment(
  id: string,
  assignment: ProductionAssignment,
): boolean {
  return productionAssignmentId(assignment) !== id;
}

function replaceAssignment(
  id: string,
  replacement: ProductionAssignment,
  assignment: ProductionAssignment,
): ProductionAssignment {
  return hasId(id, assignment) ? replacement : assignment;
}

function compareAssignments(
  left: ProductionAssignment,
  right: ProductionAssignment,
): number {
  return left.batchId.localeCompare(right.batchId) || left.tray - right.tray;
}

function positionsForAssignments(
  assignments: readonly ProductionAssignment[],
  current: ProductionPresentation,
): ProductionPresentation {
  const defaults = productionInitialPresentation(assignments);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const assignment of assignments) {
    const id = productionAssignmentId(assignment);
    const position = current[id] ?? defaults[id];
    if (position !== undefined) positions[id] = position;
  }
  return positions;
}

function assignmentForOperation(
  operation: ProductionWorkcell,
): ProductionAssignment {
  return {
    batchId: operation.batchId,
    tray: operation.tray,
    workerId: operation.workerId,
    dependsOn: operation.dependsOn,
    earliestStartSeconds: operation.earliestStartSeconds,
  };
}

function hasOperationId(
  id: string | null,
  operation: ProductionWorkcell,
): boolean {
  return operation.id === id;
}

function isManualChoice(id: string, task: ProductionTaskChoice): boolean {
  return task.id === id && task.kind === "manual";
}

// A manual task at its defaults is not stored.
function replaceManualTask(
  tasks: readonly ProductionManualTask[],
  task: ProductionManualTask,
): readonly ProductionManualTask[] {
  const result: ProductionManualTask[] = [];
  for (const current of tasks)
    if (current.bakeryTaskId !== task.bakeryTaskId) result.push(current);
  if (
    task.workerId !== null ||
    task.dependsOn.length > 0 ||
    task.earliestStartSeconds !== 0
  )
    result.push(task);
  return result.sort(compareManualTasks);
}

function compareManualTasks(
  left: ProductionManualTask,
  right: ProductionManualTask,
): number {
  return left.bakeryTaskId.localeCompare(right.bakeryTaskId);
}

export function defaultAssignments(
  settings: Settings,
): readonly ProductionAssignment[] {
  const assignments: ProductionAssignment[] = [];
  for (let batch = 0; batch < settings.batchCount; batch++) {
    for (let tray = 1; tray <= settings.traysPerBatch; tray++) {
      if (assignments.length === 16) return assignments;
      assignments.push({
        batchId: String.fromCharCode(65 + batch),
        tray,
        workerId: "human-1",
        dependsOn: [],
        earliestStartSeconds: 0,
      });
    }
  }
  return assignments;
}

export function financierSettings(
  settings: Settings,
  preset: "procedure" | "one-batch",
): Settings {
  if (preset === "procedure") return settings;
  const parsed = parseSettings({
    ...settings,
    batchCount: 1,
    traysPerBatch: 1,
  });
  if (parsed.kind === "invalid")
    throw new Error(`${parsed.field}: ${parsed.message}`);
  return parsed.settings;
}

export type PreparedProductionReplacement = Readonly<{
  from: ProductionReady;
  draft: ProductionDraftSource;
  preview: ProductionReady | null;
  proposed: ProductionReady;
  summary: BakeryProductionReplacement;
}>;

export function acceptedProductionResults(plan: ProductionWorkcells): number {
  return plan.operations.filter(hasAcceptedProductionResult).length;
}
function hasAcceptedProductionResult(operation: ProductionWorkcell): boolean {
  return operation.attempt.kind !== "awaiting-evidence";
}

export async function prepareProductionReplacement(
  session: ProductionSession,
  source: BakeryProductionReplacementSource,
  settings: Settings,
  procedure: CompiledProcedure | null,
  layout: ScheduleSpatialLayout | null,
): Promise<
  | Readonly<{ kind: "ready"; review: PreparedProductionReplacement }>
  | Readonly<{ kind: "rejected"; message: string }>
> {
  const draft = productionDraftSource(session);
  if (draft === null || session.data.kind !== "ready")
    return {
      kind: "rejected",
      message: "Prepare and preview the production draft first.",
    };
  try {
    let proposed: ProductionReady;
    if (source === "preview") {
      if (session.preview === null)
        return {
          kind: "rejected",
          message: "Compile a preview before requesting replacement.",
        };
      proposed = session.preview;
    } else {
      const presetSettings = financierSettings(settings, source);
      proposed = readyProduction(
        await compileProductionDraft(
          presetSettings,
          defaultAssignments(presetSettings),
          "normal",
          null,
          [],
          procedure === null
            ? null
            : await bakeryFingerprint(procedure.revisionKey),
        ),
        layout,
      );
    }
    if (proposed.plan === session.data.plan)
      return {
        kind: "rejected",
        message: "The preview is already the applied run.",
      };
    return {
      kind: "ready",
      review: {
        from: session.data,
        draft,
        preview: session.preview,
        proposed,
        summary: {
          source,
          sourceFingerprint: session.data.plan.fingerprint,
          proposedFingerprint: proposed.plan.fingerprint,
          currentResults: acceptedProductionResults(session.data.plan),
          proposedOperations: proposed.plan.operations.length,
        },
      },
    };
  } catch (error) {
    return {
      kind: "rejected",
      message:
        error instanceof Error
          ? error.message
          : "Unable to prepare the replacement.",
    };
  }
}

export function productionReplacementCurrent(
  session: ProductionSession,
  review: PreparedProductionReplacement,
): boolean {
  const source = productionDraftSource(session);
  return (
    session.data === review.from &&
    session.preview === review.preview &&
    source !== null &&
    source.draft === review.draft.draft &&
    source.manualTasks === review.draft.manualTasks &&
    source.variant === review.draft.variant &&
    source.identity === review.draft.identity &&
    source.sourceProcedure === review.draft.sourceProcedure
  );
}
